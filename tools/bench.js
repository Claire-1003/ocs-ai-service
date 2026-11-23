// tools/bench.js — 性能基准工具（Owner: T5，零第三方依赖，ESM）
//
// 用法：
//   node tools/bench.js --file data/bench.json [--l1 10000] [--l2 2000] [--warmup 200] [--json]
//
// 达标判定（HANDOFF §12.6）：L1 avg < 1ms 且 L2 p95 < 50ms -> PASS
// 退出码：0 = PASS，1 = FAIL（未达标），2 = 无法执行（参数 / 文件 / 依赖错误）
//
// 隔离纪律（CONTRACT §11）：
//   - 只读 --file 指定的题库文件，不写任何文件、不监听任何端口、不发起网络请求；
//   - 输出中不出现题干 / 选项 / 答案原文，只有计数、耗时、内存、索引规模与达标结论；
//   - 模块顶层无 I/O 与副作用，CLI 收尾才设置 process.exitCode。

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** HANDOFF §12.6 的性能红线。 */
export const LIMITS = Object.freeze({ l1AvgMs: 1, l2P95Ms: 50 });

/** 退出码约定。 */
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, UNUSABLE: 2 });

export const USAGE = [
  'tools/bench.js — qbank 性能基准（零依赖 / 只读 / 不监听端口）',
  '',
  '用法：',
  '  node tools/bench.js --file <bank.json> [--l1 10000] [--l2 2000] [--warmup 200] [--json] [--verbose]',
  '',
  '参数：',
  '  --file, -f <p>  题库文件，必填。支持 {"version":1,"records":[...]} 与裸数组两种结构',
  '  --l1 <n>        L1 精确命中路径的采样次数，默认 10000（自动收敛到题库条数）',
  '  --l2 <n>        L2 模糊路径的采样次数，默认 2000（对题干改 1~2 个字，强制走模糊）',
  '  --warmup <n>    每个阶段正式采样前的预热次数，默认 200',
  '  --json          只输出机器可读 JSON（便于 T6 归档到 docs/ACCEPTANCE.md）',
  '  --verbose       内部错误时打印堆栈',
  '  --help, -h      显示本帮助',
  '',
  '达标判定（HANDOFF §12.6）：L1 avg < 1ms 且 L2 p95 < 50ms -> PASS',
  '退出码：0 = PASS，1 = FAIL，2 = 无法执行（参数/文件/依赖错误）',
  '',
  '示例：',
  '  node tools/genbank.js --count 50000 --out data/bench.json',
  '  node tools/bench.js --file data/bench.json --json',
].join('\n');

/* ------------------------------------------------------------------ *
 * 通用小工具（本文件私有，禁止抽公共模块，见 CONTRACT §11.3）
 * ------------------------------------------------------------------ */

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function toInt(v, fallback, min, max) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 保留 digits 位小数（避免 0.0041666666 这种噪声淹没表格）。 */
export function round(v, digits = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** digits;
  return Math.round((n + Number.EPSILON) * m) / m;
}

/**
 * 分位数：线性插值法（R type-7 / numpy 默认）。
 * @param {ArrayLike<number>} sortedAsc 已升序排列的样本
 * @param {number} p 0..1
 */
export function percentile(sortedAsc, p) {
  const n = sortedAsc ? sortedAsc.length : 0;
  if (!n) return 0;
  if (n === 1) return Number(sortedAsc[0]);
  const q = Math.min(1, Math.max(0, Number(p) || 0));
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return Number(sortedAsc[lo]);
  return Number(sortedAsc[lo]) + (Number(sortedAsc[hi]) - Number(sortedAsc[lo])) * (pos - lo);
}

/**
 * 把纳秒样本汇总成毫秒统计量。
 * @param {ArrayLike<number>} samplesNs process.hrtime.bigint() 差值（纳秒）
 */
export function summarize(samplesNs) {
  const arr = [];
  if (samplesNs) {
    for (let i = 0; i < samplesNs.length; i += 1) {
      const v = Number(samplesNs[i]);
      if (Number.isFinite(v) && v >= 0) arr.push(v);
    }
  }
  if (!arr.length) {
    return { samples: 0, avgMs: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, totalMs: 0 };
  }
  const sorted = Float64Array.from(arr);
  sorted.sort();
  let sum = 0;
  for (const v of arr) sum += v;
  const ms = (ns) => ns / 1e6;
  return {
    samples: arr.length,
    avgMs: round(ms(sum / arr.length)),
    minMs: round(ms(sorted[0])),
    p50Ms: round(ms(percentile(sorted, 0.5))),
    p95Ms: round(ms(percentile(sorted, 0.95))),
    p99Ms: round(ms(percentile(sorted, 0.99))),
    maxMs: round(ms(sorted[sorted.length - 1])),
    totalMs: round(ms(sum), 3),
  };
}

/** CJK 显示宽度（终端对齐用，全角按 2 列计）。 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  }
  return w;
}

function pad(s, w) {
  const d = w - displayWidth(s);
  return d > 0 ? String(s) + ' '.repeat(d) : String(s);
}

function padStart(s, w) {
  const d = w - displayWidth(s);
  return d > 0 ? ' '.repeat(d) + String(s) : String(s);
}

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

export const ARG_DEFAULTS = Object.freeze({
  file: '',
  l1: 10000,
  l2: 2000,
  warmup: 200,
  json: false,
  verbose: false,
  help: false,
});

/**
 * @param {string[]} argv 不含 node 与脚本路径
 * @returns {{file:string,l1:number,l2:number,warmup:number,json:boolean,verbose:boolean,help:boolean}}
 */
export function parseArgs(argv = []) {
  const out = { ...ARG_DEFAULTS };
  const list = Array.isArray(argv) ? argv.map((x) => String(x)) : [];
  const need = (i, name) => {
    if (i + 1 >= list.length) throw makeError('bad_request', `参数 ${name} 缺少取值`);
    return list[i + 1];
  };
  for (let i = 0; i < list.length; i += 1) {
    let a = list[i];
    let inline = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const take = () => {
      if (inline !== null) {
        const v = inline;
        inline = null;
        return v;
      }
      const v = need(i, a);
      i += 1;
      return v;
    };
    switch (a) {
      case '--file':
      case '-f':
        out.file = take().trim();
        break;
      case '--l1':
        out.l1 = toInt(take(), ARG_DEFAULTS.l1, 1, 10000000);
        break;
      case '--l2':
        out.l2 = toInt(take(), ARG_DEFAULTS.l2, 1, 10000000);
        break;
      case '--warmup':
        out.warmup = toInt(take(), ARG_DEFAULTS.warmup, 0, 1000000);
        break;
      case '--json':
        out.json = true;
        break;
      case '--verbose':
        out.verbose = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw makeError('bad_request', `未知参数：${a}`);
    }
  }
  if (!out.help && !out.file) throw makeError('bad_request', '缺少 --file 参数（题库文件路径）');
  return out;
}

/* ------------------------------------------------------------------ *
 * 题库载入（不依赖 lib/store.js，T3 未落地时也能跑）
 * ------------------------------------------------------------------ */

/**
 * 读取题库文件。兼容 DECISIONS #13 的两种结构。
 * @returns {{records:object[], total:number, skipped:number}}
 */
export function loadBankFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw makeError('bad_request', `题库文件读取失败：${file}（${(err && err.code) || 'unknown'}）`);
  }
  let data;
  try {
    data = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  } catch {
    throw makeError('bad_request', `题库文件不是合法 JSON：${file}`);
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray(data.records)
      ? data.records
      : null;
  if (!list) {
    throw makeError('bad_request', '题库结构不合法：需要 {"version":1,"records":[...]} 或裸数组');
  }
  const records = [];
  let skipped = 0;
  for (const r of list) {
    if (r && typeof r === 'object' && typeof r.title === 'string' && r.title.trim() !== '') records.push(r);
    else skipped += 1;
  }
  return { records, total: list.length, skipped };
}

/** 等步长取样，保证同一题库多次运行取到同一批样本（结果可复现）。 */
export function pickSamples(records, n) {
  const total = Array.isArray(records) ? records.length : 0;
  if (!total) return [];
  const count = Math.max(1, Math.min(Number(n) || 0, total));
  const stride = total / count;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(records[Math.min(total - 1, Math.floor(i * stride))]);
  return out;
}

const CJK_POOL = '的是了和与或在有为以对错各项其中';
const ASCII_POOL = 'xqzvkjmw';

/**
 * 确定性扰动题干：改 1~2 个字，用于制造「近似查询」强制走 L2。
 * 同 seed 同输入必得同输出，保证 bench 可复现。
 */
export function mutateTitle(title, seed = 0) {
  const src = String(title === null || title === undefined ? '' : title);
  const chars = [...src];
  if (!chars.length) return src;
  const edits = 1 + (Math.abs(seed) % 2);
  const out = chars.slice();
  for (let e = 0; e < edits; e += 1) {
    if (!out.length) break;
    const pos = (Math.abs(seed) * 7 + e * 13 + 3) % out.length;
    const ch = out[pos];
    const pool = /[a-z0-9]/i.test(ch) ? ASCII_POOL : CJK_POOL;
    let repl = pool[(Math.abs(seed) + e * 5) % pool.length];
    if (repl === ch) repl = pool[(Math.abs(seed) + e * 5 + 1) % pool.length];
    out[pos] = repl;
  }
  const s = out.join('');
  return s === src ? s + CJK_POOL[Math.abs(seed) % CJK_POOL.length] : s;
}

/* ------------------------------------------------------------------ *
 * 索引内省（best-effort：Matcher 内部字段缺失时报告 null，不影响主流程）
 * ------------------------------------------------------------------ */

export function inspectIndex(matcher) {
  const out = { size: null, trigramEntries: null, trigramPostings: null };
  try {
    if (matcher && typeof matcher.size === 'number') out.size = matcher.size;
    const tri = matcher && matcher._tri;
    if (tri instanceof Map) {
      let postings = 0;
      for (const set of tri.values()) postings += (set && set.size) || 0;
      out.trigramEntries = tri.size;
      out.trigramPostings = postings;
    }
  } catch {
    /* 内省失败不影响基准结果 */
  }
  return out;
}

/** 平均候选数：复用 Matcher 的候选裁剪逻辑（私有方法，缺失时报 null）。 */
export function measureCandidates(matcher, queries, normalize, limit, cap = 200) {
  try {
    if (!matcher || typeof matcher._candidates !== 'function') return null;
    const n = Math.min(queries.length, cap);
    if (!n) return null;
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const nt = normalize(queries[i].title);
      const c = matcher._candidates(nt, limit);
      sum += (c && c.length) || 0;
    }
    return round(sum / n, 2);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 达标判定
 * ------------------------------------------------------------------ */

/**
 * @param {{l1:{samples:number,avgMs:number}, l2:{samples:number,p95Ms:number}}} result
 */
export function judge(result) {
  const l1 = (result && result.l1) || { samples: 0, avgMs: 0 };
  const l2 = (result && result.l2) || { samples: 0, p95Ms: 0 };
  const l1Pass = l1.samples > 0 && l1.avgMs < LIMITS.l1AvgMs;
  const l2Pass = l2.samples > 0 && l2.p95Ms < LIMITS.l2P95Ms;
  const pass = l1Pass && l2Pass;
  return {
    pass,
    status: pass ? 'PASS' : 'FAIL',
    l1: { metric: 'avg', limitMs: LIMITS.l1AvgMs, valueMs: l1.avgMs, samples: l1.samples, pass: l1Pass },
    l2: { metric: 'p95', limitMs: LIMITS.l2P95Ms, valueMs: l2.p95Ms, samples: l2.samples, pass: l2Pass },
    note: l1.samples > 0 && l2.samples > 0 ? '' : 'no_samples',
  };
}

/* ------------------------------------------------------------------ *
 * 文本报表
 * ------------------------------------------------------------------ */

function fmt(v, digits = 4) {
  return Number(v).toFixed(digits);
}

export function renderText(result) {
  const lines = [];
  const v = result.verdict;
  lines.push(`[qbank][bench] 题库=${result.file}`);
  lines.push(
    `[qbank][bench] 记录数=${result.bank.records}（原始 ${result.bank.total}，跳过非法 ${result.bank.skipped}）` +
      ` 索引条目=${result.index.size === null ? 'n/a' : result.index.size}` +
      ` 构建耗时=${fmt(result.index.buildMs, 3)}ms`,
  );
  lines.push(
    `[qbank][bench] trigram 索引：条目=${result.index.trigramEntries === null ? 'n/a' : result.index.trigramEntries}` +
      ` 倒排总数=${result.index.trigramPostings === null ? 'n/a' : result.index.trigramPostings}` +
      ` L2 平均候选数=${result.l2.avgCandidates === null ? 'n/a' : result.l2.avgCandidates}`,
  );
  lines.push('');

  const cols = [
    ['阶段', 16],
    ['样本数', 8],
    ['avg(ms)', 10],
    ['p50(ms)', 10],
    ['p95(ms)', 10],
    ['p99(ms)', 10],
    ['max(ms)', 10],
    ['命中率', 9],
    ['精确/模糊', 12],
  ];
  const head = cols.map(([name, w], i) => (i === 0 ? pad(name, w) : padStart(name, w))).join('');
  lines.push(head);
  lines.push('-'.repeat(displayWidth(head)));
  const row = (label, s, hitRate) =>
    [
      pad(label, cols[0][1]),
      padStart(s.samples, cols[1][1]),
      padStart(fmt(s.avgMs), cols[2][1]),
      padStart(fmt(s.p50Ms), cols[3][1]),
      padStart(fmt(s.p95Ms), cols[4][1]),
      padStart(fmt(s.p99Ms), cols[5][1]),
      padStart(fmt(s.maxMs), cols[6][1]),
      padStart(`${(hitRate * 100).toFixed(1)}%`, cols[7][1]),
      padStart(`${s.exactHits}/${s.fuzzyFallback}`, cols[8][1]),
    ].join('');
  lines.push(row('L1 精确命中', result.l1, result.l1.hitRate));
  lines.push(row('L2 模糊匹配', result.l2, result.l2.hitRate));
  lines.push('');
  lines.push(
    `[qbank][bench] 内存 rss=${fmt(result.memory.rssMb, 2)}MB heapUsed=${fmt(result.memory.heapUsedMb, 2)}MB` +
      ` heapTotal=${fmt(result.memory.heapTotalMb, 2)}MB`,
  );
  lines.push(
    `[qbank][bench] 采样参数 l1=${result.args.l1} l2=${result.args.l2} warmup=${result.args.warmup}` +
      ` 计时=process.hrtime.bigint()`,
  );
  lines.push(
    `[qbank][bench] 命中层级 L1 阶段：精确=${result.l1.exactHits} 退回模糊=${result.l1.fuzzyFallback} 未命中=${result.l1.misses}` +
      ` | L2 阶段：精确=${result.l2.exactHits} 模糊=${result.l2.fuzzyFallback} 未命中=${result.l2.misses} 疑似=${result.l2.suspicious}`,
  );
  if (result.l1.fuzzyFallback > 0) {
    lines.push(
      `[qbank][bench] 警告：L1 阶段有 ${result.l1.fuzzyFallback} 个样本没走精确路径（bank 里的 key 与 makeKey(title,options) 不一致？），` +
        '此时 L1 耗时数字不代表 O(1) 精确查找，请用 tools/genbank.js 或 tools/import.js 重新生成题库',
    );
  }
  lines.push('');
  const mark = (ok) => (ok ? 'OK' : 'NG');
  lines.push(
    `[达标判定 HANDOFF §12.6] L1 avg ${fmt(v.l1.valueMs)}ms < ${v.l1.limitMs}ms [${mark(v.l1.pass)}]` +
      ` | L2 p95 ${fmt(v.l2.valueMs)}ms < ${v.l2.limitMs}ms [${mark(v.l2.pass)}] -> ${v.status}`,
  );
  if (v.note === 'no_samples') {
    lines.push('[qbank][bench] 样本数为 0，无法证明达标，按 FAIL 处理');
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function importDeps() {
  let matcherMod;
  let normalizeMod;
  try {
    matcherMod = await import('../lib/matcher.js');
  } catch (err) {
    throw makeError('bad_request', `无法加载 lib/matcher.js（${(err && err.code) || err}）：请先完成 T1`);
  }
  try {
    normalizeMod = await import('../lib/normalize.js');
  } catch (err) {
    throw makeError('bad_request', `无法加载 lib/normalize.js（${(err && err.code) || err}）：请先完成 T1`);
  }
  if (typeof matcherMod.Matcher !== 'function') {
    throw makeError('bad_request', 'lib/matcher.js 未按 CONTRACT §2 导出 Matcher 类');
  }
  if (typeof normalizeMod.makeKey !== 'function' || typeof normalizeMod.normalize !== 'function') {
    throw makeError('bad_request', 'lib/normalize.js 未按 CONTRACT §1 导出 makeKey / normalize');
  }
  return {
    Matcher: matcherMod.Matcher,
    makeKey: normalizeMod.makeKey,
    normalize: normalizeMod.normalize,
    hrtime: () => process.hrtime.bigint(),
    memoryUsage: () => process.memoryUsage(),
    loadBankFile,
  };
}

/** 构造 L2 近似查询：确保不会退回 L1 命中路径。 */
function buildL2Queries(records, count, makeKey, matcher) {
  const base = pickSamples(records, count);
  const queries = [];
  let collisions = 0;
  for (let i = 0; i < base.length; i += 1) {
    const r = base[i];
    let title = null;
    for (let seed = i; seed < i + 4; seed += 1) {
      const cand = mutateTitle(r.title, seed);
      let hitL1 = false;
      try {
        hitL1 = Boolean(matcher.lookupExact(makeKey(cand, r.options)));
      } catch {
        hitL1 = false;
      }
      if (!hitL1) {
        title = cand;
        break;
      }
      collisions += 1;
    }
    if (title === null) continue; // 极端情况：4 次扰动都撞上 L1，丢弃该样本
    queries.push({ title, options: r.options });
  }
  return { queries, collisions };
}

function runPhase({ matcher, queries, warmup, hrtime, acceptSuspicious }) {
  if (!queries.length) return { ns: [], hits: 0, suspicious: 0, levels: { L1: 0, L2: 0, miss: 0 } };
  const opts = acceptSuspicious === undefined ? {} : { acceptSuspicious };
  for (let i = 0; i < warmup; i += 1) {
    const q = queries[i % queries.length];
    matcher.lookup(q.title, q.options, opts);
  }
  const ns = new Float64Array(queries.length);
  const levels = { L1: 0, L2: 0, miss: 0 };
  let hits = 0;
  let suspicious = 0;
  for (let i = 0; i < queries.length; i += 1) {
    const q = queries[i];
    const t0 = hrtime();
    const res = matcher.lookup(q.title, q.options, opts);
    ns[i] = Number(hrtime() - t0);
    if (res && res.record) {
      hits += 1;
      if (res.suspicious) suspicious += 1;
      levels[res.level === 'L2' ? 'L2' : 'L1'] += 1;
    } else {
      levels.miss += 1;
    }
  }
  return { ns: Array.from(ns), hits, suspicious, levels };
}

/**
 * 执行一次完整基准。所有外部依赖都可通过 opts.deps 注入（自测用桩）。
 * @param {{argv?:string[], deps?:object, out?:{write:Function}, err?:{write:Function}, cwd?:string}} [opts]
 * @returns {Promise<{result:object, exitCode:number, text:string}>}
 */
export async function runBench(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const stdout = o.out || { write: (s) => process.stdout.write(s) };
  const stderr = o.err || { write: (s) => process.stderr.write(s) };
  let args;
  try {
    args = parseArgs(o.argv || []);
  } catch (err) {
    stderr.write(`[qbank][bench][${err.code || 'bad_request'}] ${err.message}\n`);
    stdout.write(USAGE + '\n');
    return { result: null, exitCode: EXIT.UNUSABLE, text: USAGE + '\n' };
  }
  if (args.help) {
    stdout.write(USAGE + '\n');
    return { result: null, exitCode: EXIT.PASS, text: USAGE + '\n' };
  }

  const deps = { ...(await importDeps()), ...(o.deps || {}) };
  const hrtime = deps.hrtime;

  let loaded;
  try {
    loaded = deps.loadBankFile(args.file);
  } catch (err) {
    stderr.write(`[qbank][bench][${err.code || 'bad_request'}] ${err.message}\n`);
    return { result: null, exitCode: EXIT.UNUSABLE, text: '' };
  }
  const { records, total, skipped } = loaded;
  if (!records.length) {
    stderr.write('[qbank][bench][bad_request] 题库为空，无可采样记录\n');
    return { result: null, exitCode: EXIT.UNUSABLE, text: '' };
  }

  // match 配置：不读 config.json（bench 是离线只读工具），用 Matcher 内置默认值，
  // 与 CONTRACT §2 的 {fuzzyThreshold:0.9, suspiciousThreshold:0.8, acceptSuspicious:false, candidateLimit:200} 一致。
  const matchCfg = (o.matchConfig) || {
    fuzzyThreshold: 0.9,
    suspiciousThreshold: 0.8,
    acceptSuspicious: false,
    candidateLimit: 200,
  };

  const matcher = new deps.Matcher(matchCfg);
  const t0 = hrtime();
  try {
    matcher.build(records);
  } catch (err) {
    stderr.write(`[qbank][bench][ai_error] 索引构建失败：${(err && err.code) || err}\n`);
    return { result: null, exitCode: EXIT.UNUSABLE, text: '' };
  }
  const buildNs = Number(hrtime() - t0);
  const index = inspectIndex(matcher);

  const l1Queries = pickSamples(records, args.l1).map((r) => ({ title: r.title, options: r.options }));
  let l2Queries = [];
  let collisions = 0;
  try {
    const built = buildL2Queries(records, args.l2, deps.makeKey, matcher);
    l2Queries = built.queries;
    collisions = built.collisions;
  } catch (err) {
    stderr.write(`[qbank][bench][bad_request] L2 查询构造失败：${(err && err.code) || err}\n`);
  }

  const avgCandidates = measureCandidates(matcher, l2Queries, deps.normalize, matchCfg.candidateLimit);
  const l1Phase = runPhase({ matcher, queries: l1Queries, warmup: args.warmup, hrtime });
  const l2Phase = runPhase({ matcher, queries: l2Queries, warmup: args.warmup, hrtime });

  const mem = deps.memoryUsage() || {};
  const l1 = {
    ...summarize(l1Phase.ns),
    hitRate: l1Queries.length ? round(l1Phase.hits / l1Queries.length, 4) : 0,
    exactHits: l1Phase.levels.L1,
    fuzzyFallback: l1Phase.levels.L2,
    misses: l1Phase.levels.miss,
  };
  const l2 = {
    ...summarize(l2Phase.ns),
    hitRate: l2Queries.length ? round(l2Phase.hits / l2Queries.length, 4) : 0,
    exactHits: l2Phase.levels.L1,
    fuzzyFallback: l2Phase.levels.L2,
    misses: l2Phase.levels.miss,
    suspicious: l2Phase.suspicious,
    avgCandidates,
    l1Collisions: collisions,
  };

  const result = {
    tool: 'bench',
    schemaVersion: 1,
    generatedAt: Date.now(),
    node: process.version,
    file: args.file,
    args: { l1: l1Queries.length, l2: l2Queries.length, warmup: args.warmup, requestedL1: args.l1, requestedL2: args.l2 },
    bank: { records: records.length, total, skipped },
    index: {
      buildMs: round(buildNs / 1e6, 3),
      size: index.size,
      trigramEntries: index.trigramEntries,
      trigramPostings: index.trigramPostings,
      matchConfig: matchCfg,
    },
    l1,
    l2,
    memory: {
      rssBytes: mem.rss || 0,
      heapUsedBytes: mem.heapUsed || 0,
      heapTotalBytes: mem.heapTotal || 0,
      rssMb: round((mem.rss || 0) / 1048576, 2),
      heapUsedMb: round((mem.heapUsed || 0) / 1048576, 2),
      heapTotalMb: round((mem.heapTotal || 0) / 1048576, 2),
    },
    limits: { ...LIMITS },
  };
  result.verdict = judge(result);

  const text = args.json ? JSON.stringify(result, null, 2) + '\n' : renderText(result);
  stdout.write(text);
  return { result, exitCode: result.verdict.pass ? EXIT.PASS : EXIT.FAIL, text };
}

/** CLI 入口。 */
export async function main(argv = process.argv.slice(2)) {
  try {
    const { exitCode } = await runBench({ argv });
    process.exitCode = exitCode;
    return exitCode;
  } catch (err) {
    const verbose = argv.includes('--verbose');
    process.stderr.write(`[qbank][bench][${(err && err.code) || 'ai_error'}] ${(err && err.message) || '未知错误'}\n`);
    if (verbose && err && err.stack) process.stderr.write(err.stack + '\n');
    process.exitCode = EXIT.UNUSABLE;
    return EXIT.UNUSABLE;
  }
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main();
}

export default { runBench, main, parseArgs, summarize, percentile, judge, renderText, LIMITS, EXIT };