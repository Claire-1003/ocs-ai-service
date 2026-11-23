// tools/accuracy.js — AI 准确率评测（Owner: T5，零第三方依赖，ESM）
//
// 用法：
//   node tools/accuracy.js --file test/fixtures/accuracy_set.json [--provider bailian]
//                          [--concurrency 3] [--timeout 20000] [--json] [--out <path>]
//                          [--mock] [--mock-accuracy 1] [--limit 0]
//
// 达标判定（HANDOFF §12.7）：总准确率 >= 85% -> PASS
// 退出码：0 = PASS，1 = FAIL（准确率不达标），2 = 无法执行（缺 Key / 缺文件 / 依赖未就绪 / 参数错误）
//
// 隐私纪律（CONTRACT §11.5 + §9）：
//   逐题输出只打印「题干前 8 个字 + key 前 12 位」，绝不打印完整题干；
//   期望答案 / 实际答案是评测结论本身（§9 明确要求），只进 stdout 与 --out 指定的报表文件，
//   绝不写进 logs/。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** HANDOFF §12.7 的准确率红线。 */
export const THRESHOLD = 0.85;

/** 退出码约定。 */
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, UNUSABLE: 2 });

/** 只用于报表分组的失败标签（不是 CONTRACT §0 的错误码，见交付报告「契约歧义」）。 */
export const REPORT_REASONS = Object.freeze({
  WRONG_ANSWER: 'wrong_answer',
  INVALID_ITEM: 'invalid_item',
});

export const USAGE = [
  'tools/accuracy.js — qbank AI 准确率评测（走真实 AI 链路：lib/ai/index.js + lib/queue.js）',
  '',
  '用法：',
  '  node tools/accuracy.js --file test/fixtures/accuracy_set.json [选项]',
  '',
  '参数：',
  '  --file, -f <p>        测试集 JSON，必填。结构见 CONTRACT §9：',
  '                        [{"key":"可选","type":"单选题","title":"...","options":"A.xx#B.xx","answer":"A"}]',
  '  --provider <name>     只用指定 provider（bailian / ollama / openai）；默认用 config.ai.fallback 整条链',
  '  --concurrency <n>     并发上限，默认 3（与 config.ai.concurrency 一致）',
  '  --timeout <ms>        单题超时，默认 20000',
  '  --limit <n>           只跑前 n 题（0 = 全部），用于省额度的冒烟测试',
  '  --out <p>             把机器可读报表写到指定文件（不传则不写盘；本工具没有默认输出路径）',
  '  --json                stdout 只输出机器可读 JSON',
  '  --mock                用内置桩 provider 离线跑通报表逻辑（不联网、不消耗额度，CI 自测用）',
  '  --mock-accuracy <0~1> 桩 provider 的模拟准确率，默认 1（全部答对）；0.9 表示每 10 题错 1 题',
  '  --verbose             内部错误时打印堆栈',
  '  --help, -h            显示本帮助',
  '',
  '达标判定（HANDOFF §12.7）：总准确率 >= 85% -> PASS',
  '退出码：0 = PASS，1 = FAIL，2 = 无法执行（缺 API Key / 缺文件 / 依赖未就绪 / 参数错误）',
  '',
  '示例：',
  '  node tools/accuracy.js --file test/fixtures/accuracy_set.json',
  '  node tools/accuracy.js --file test/fixtures/accuracy_set.json --mock --json',
  '  node tools/accuracy.js --file test/fixtures/accuracy_set.json --provider bailian --out docs/accuracy-report.json',
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

function toFloat(v, fallback, min, max) {
  const n = Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function round(v, digits = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** digits;
  return Math.round((n + Number.EPSILON) * m) / m;
}

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

/** 题干截断：只取前 n 个字符，超出补省略号（隐私纪律）。 */
export function titlePrefix(title, n = 8) {
  const chars = [...String(title === null || title === undefined ? '' : title)];
  if (chars.length <= n) return chars.join('');
  return chars.slice(0, n).join('') + '…';
}

export function shortKey(key, n = 12) {
  return String(key === null || key === undefined ? '' : key).slice(0, n);
}

/** 按显示宽度截断（CJK 计 2 列），保证不会挤到下一列。 */
function truncField(s, w) {
  const chars = [...String(s === null || s === undefined ? '' : s)];
  if (displayWidth(chars.join('')) <= w) return chars.join('');
  const budget = Math.max(1, w - 1); // 末位留给省略号
  let used = 0;
  const out = [];
  for (const ch of chars) {
    const cw = displayWidth(ch);
    if (used + cw > budget) break;
    used += cw;
    out.push(ch);
  }
  return out.join('') + '…';
}

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

export const ARG_DEFAULTS = Object.freeze({
  file: '',
  provider: '',
  concurrency: 3,
  timeout: 20000,
  limit: 0,
  out: '',
  json: false,
  mock: false,
  mockAccuracy: 1,
  verbose: false,
  help: false,
});

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
      case '--provider':
        out.provider = take().trim();
        break;
      case '--concurrency':
        out.concurrency = toInt(take(), ARG_DEFAULTS.concurrency, 1, 64);
        break;
      case '--timeout':
        out.timeout = toInt(take(), ARG_DEFAULTS.timeout, 100, 600000);
        break;
      case '--limit':
        out.limit = toInt(take(), 0, 0, 1000000);
        break;
      case '--out':
        out.out = take().trim();
        break;
      case '--mock-accuracy':
        out.mockAccuracy = toFloat(take(), 1, 0, 1);
        out.mock = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--mock':
        out.mock = true;
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
  if (!out.help && !out.file) throw makeError('bad_request', '缺少 --file 参数（测试集路径）');
  return out;
}

/* ------------------------------------------------------------------ *
 * 测试集载入
 * ------------------------------------------------------------------ */

const TYPE_LABELS = Object.freeze({ 单选: '单选题', 多选: '多选题', 判断: '判断题', 填空: '填空题', 问答: '问答题' });

/** lib/normalize.js 不可用时的兜底题型标签（只用于 --mock 自测）。 */
function fallbackLabel(rawType, optionCount) {
  const s = String(rawType || '').trim();
  for (const k of Object.keys(TYPE_LABELS)) if (s.includes(k)) return TYPE_LABELS[k];
  if (/multi|checkbox/i.test(s)) return '多选题';
  if (/true|false|judge/i.test(s)) return '判断题';
  if (/fill|completion/i.test(s)) return '填空题';
  if (/essay|qa|short/i.test(s)) return '问答题';
  if (/single|radio/i.test(s)) return '单选题';
  if (optionCount === 0) return '问答题';
  return '单选题';
}

/** lib/normalize.js 不可用时的兜底 key（只用于报表对齐，不参与检索）。 */
function localKey(title, options) {
  const o = String(options || '')
    .split('#')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join('#');
  return crypto.createHash('sha256').update(String(title) + '||' + o, 'utf8').digest('hex');
}

/**
 * 载入测试集。兼容裸数组、{"items":[...]}、{"questions":[...]}。
 * 非法条目不会被丢弃，而是标记 valid=false 并计入失败（避免坏测试集假装通过）。
 * @returns {{items:object[], total:number, invalid:number}}
 */
export function loadFixture(file, deps = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw makeError('bad_request', `测试集读取失败：${file}（${(err && err.code) || 'unknown'}）`);
  }
  let data;
  try {
    data = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  } catch {
    throw makeError('bad_request', `测试集不是合法 JSON：${file}`);
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray(data.items)
      ? data.items
      : data && typeof data === 'object' && Array.isArray(data.questions)
        ? data.questions
        : null;
  if (!list) throw makeError('bad_request', '测试集结构不合法：需要 [{...}] 或 {"items":[{...}]}');

  const d = deps || {};
  const normalizeType = typeof d.normalizeType === 'function' ? d.normalizeType : null;
  const toLabel = typeof d.toLabel === 'function' ? d.toLabel : null;
  const makeKey = typeof d.makeKey === 'function' ? d.makeKey : null;
  const splitOptions = typeof d.splitOptions === 'function' ? d.splitOptions : (s) => String(s || '').split('#');

  const items = [];
  let invalid = 0;
  list.forEach((rawItem, i) => {
    const base = {
      index: i + 1,
      valid: false,
      invalidReason: REPORT_REASONS.INVALID_ITEM,
      title: '',
      options: '',
      expected: '',
      type: '',
      key: '',
      raw: null,
    };
    if (!rawItem || typeof rawItem !== 'object') {
      invalid += 1;
      items.push(base);
      return;
    }
    const title = typeof rawItem.title === 'string' ? rawItem.title.trim() : '';
    const expected = typeof rawItem.answer === 'string' ? rawItem.answer.trim() : '';
    const options = Array.isArray(rawItem.options)
      ? rawItem.options.map((x) => String(x)).join('#')
      : typeof rawItem.options === 'string'
        ? rawItem.options
        : '';
    if (!title || !expected) {
      invalid += 1;
      items.push({ ...base, title, options, expected });
      return;
    }
    let optionList = [];
    try {
      optionList = splitOptions(options).filter(Boolean);
    } catch {
      optionList = String(options || '').split('#').filter(Boolean);
    }
    let type = '';
    try {
      type = normalizeType ? normalizeType(rawItem.type, { optionCount: optionList.length, title, options: optionList }) : '';
      type = toLabel ? toLabel(type) : type;
    } catch {
      type = '';
    }
    if (!type) type = fallbackLabel(rawItem.type, optionList.length);
    let key = typeof rawItem.key === 'string' && rawItem.key.trim() ? rawItem.key.trim() : '';
    if (!key) {
      try {
        key = makeKey ? makeKey(title, options) : localKey(title, options);
      } catch {
        key = localKey(title, options);
      }
    }
    items.push({ ...base, valid: true, invalidReason: '', title, options, expected, type, key, raw: rawItem });
  });
  return { items, total: list.length, invalid };
}

/* ------------------------------------------------------------------ *
 * 答案比对（评测专用；不复用 lib/answer.js，评测侧要比服务侧更宽容地识别同义写法）
 * ------------------------------------------------------------------ */

const JUDGE_TRUE = ['正确', '对', '√', 't', 'true', '是', 'y', 'yes'];
const JUDGE_FALSE = ['错误', '错', '×', 'x', 'f', 'false', '否', 'n', 'no'];

function stripNoise(s) {
  return String(s === null || s === undefined ? '' : s)
    .toLowerCase()
    .replace(/[\s\u3000\u00a0\u200b\ufeff]/g, '')
    .replace(/[，。、；：？！“”‘’（）《》【】…—·,.!?;:'"()<>\[\]{}]/g, '');
}

export function normalizeJudgeText(s) {
  const t = stripNoise(s);
  if (!t) return '';
  if (JUDGE_TRUE.includes(t)) return '正确';
  if (JUDGE_FALSE.includes(t)) return '错误';
  return t;
}

function letters(s) {
  const m = String(s === null || s === undefined ? '' : s).toUpperCase().match(/[A-Z]/g) || [];
  return [...new Set(m)].sort();
}

function bigramDice(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const g = a.slice(i, i + 2);
    A.set(g, (A.get(g) || 0) + 1);
  }
  const B = new Map();
  for (let i = 0; i < b.length - 1; i += 1) {
    const g = b.slice(i, i + 2);
    B.set(g, (B.get(g) || 0) + 1);
  }
  let inter = 0;
  for (const [g, c] of A) {
    const w = B.get(g);
    if (w) inter += Math.min(c, w);
  }
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

/**
 * 判定 AI 答案是否与期望一致（HANDOFF §4.3 的格式约定）。
 * @returns {{pass:boolean, method:string, score?:number}}
 *   method ∈ exact|letters|judge|blanks|contains|fuzzy|empty
 */
export function gradeAnswer(expected, actual, type) {
  const e = String(expected === null || expected === undefined ? '' : expected).trim();
  const a = String(actual === null || actual === undefined ? '' : actual).trim();
  if (!a) return { pass: false, method: 'empty' };
  const t = String(type || '');

  if (t.includes('单选')) {
    const el = letters(e);
    const al = letters(a);
    return { pass: el.length === 1 && al.length >= 1 && al[0] === el[0], method: 'letters' };
  }
  if (t.includes('多选') || t.includes('不定项')) {
    const es = letters(e).join('#');
    const as = letters(a).join('#');
    return { pass: Boolean(es) && es === as, method: 'letters' };
  }
  if (t.includes('判断')) {
    const ej = normalizeJudgeText(e);
    const aj = normalizeJudgeText(a);
    return { pass: Boolean(ej) && ej === aj, method: 'judge' };
  }
  if (t.includes('填空')) {
    const eb = e.split('#').map((x) => stripNoise(x));
    const ab = a.split('#').map((x) => stripNoise(x));
    if (eb.length === ab.length && eb.every((x, i) => x === ab[i])) return { pass: true, method: 'blanks' };
    if (eb.length === ab.length && eb.every((x, i) => x.length >= 2 && ab[i].includes(x))) {
      return { pass: true, method: 'contains' };
    }
    return { pass: false, method: 'blanks' };
  }
  if (t.includes('问答') || t.includes('简答') || t.includes('论述')) {
    const en = stripNoise(e);
    const an = stripNoise(a);
    if (!en) return { pass: false, method: 'empty' };
    if (en === an) return { pass: true, method: 'exact' };
    if (an.includes(en) || en.includes(an)) return { pass: true, method: 'contains' };
    const score = bigramDice(en, an);
    return { pass: score >= 0.6, method: 'fuzzy', score: round(score, 3) };
  }
  // 未知题型：最保守，归一化后全等才算对
  return { pass: stripNoise(e) === stripNoise(a), method: 'exact' };
}

/* ------------------------------------------------------------------ *
 * 并发调度：优先用 lib/queue.js 的 gate，缺失时退回内置 worker 池
 * ------------------------------------------------------------------ */

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(makeError('ai_timeout', `${label} 超时（${ms}ms）`)), ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 并发执行，结果严格按输入顺序返回。
 * @param {any[]} items
 * @param {(item:any, index:number)=>Promise<any>} worker
 * @param {{gate?:object|null, concurrency?:number, timeoutMs?:number}} [opts]
 * @returns {Promise<Array<{ok:boolean, value?:any, error?:Error}>>}
 */
export async function schedule(items, worker, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const o = opts || {};
  const gate = o.gate && typeof o.gate.run === 'function' ? o.gate : null;
  const concurrency = Math.max(1, toInt(o.concurrency, 3, 1, 1024));
  const timeoutMs = toInt(o.timeoutMs, 0, 0, 600000);
  const results = new Array(list.length);
  if (!list.length) return results;

  if (gate) {
    const tasks = list.map((it, i) => {
      try {
        return Promise.resolve(gate.run(() => worker(it, i), timeoutMs ? { timeoutMs } : {}));
      } catch (err) {
        return Promise.reject(err);
      }
    });
    const settled = await Promise.allSettled(tasks);
    settled.forEach((s, i) => {
      results[i] = s.status === 'fulfilled' ? { ok: true, value: s.value } : { ok: false, error: s.reason };
    });
    return results;
  }

  const limit = Math.min(concurrency, list.length);
  let next = 0;
  const runner = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      try {
        const value = timeoutMs
          ? await withTimeout(worker(list[i], i), timeoutMs, `item#${i + 1}`)
          : await worker(list[i], i);
        results[i] = { ok: true, value };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => runner()));
  return results;
}

/* ------------------------------------------------------------------ *
 * 桩 provider（--mock）：离线跑通报表逻辑，不联网、不消耗额度
 * ------------------------------------------------------------------ */

/**
 * 按 --mock-accuracy 确定性地挑出「答错」的题目下标。
 * 1 -> 全对；0.9 -> 每 10 题错 1 题（下标 9,19,...）；0.8 -> 每 5 题错 1 题（下标 4,9,14,19）。
 */
export function buildMockPlan(count, accuracy) {
  const acc = Math.min(1, Math.max(0, toFloat(accuracy, 1, 0, 1)));
  const errRate = 1 - acc;
  const step = errRate <= 0 ? 0 : Math.max(1, Math.round(1 / errRate));
  const failIndexes = new Set();
  if (step > 0) {
    for (let i = 0; i < count; i += 1) if (i % step === step - 1) failIndexes.add(i);
  }
  return { accuracy: acc, failIndexes };
}

/**
 * 桩 AI，返回结构与 CONTRACT §7 的 createAI 一致（永不抛）。
 * @param {{plan?:object, items?:object[], latencyMs?:number, sleep?:Function}} [opts]
 */
export function createMockAI(opts = {}) {
  const o = opts || {};
  const items = Array.isArray(o.items) ? o.items : [];
  const plan = o.plan || buildMockPlan(items.length, 1);
  const latencyMs = Math.max(0, toInt(o.latencyMs, 5, 0, 5000));
  const sleep = typeof o.sleep === 'function' ? o.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const byKey = new Map();
  items.forEach((it, i) => {
    if (it && it.key) byKey.set(it.key, { item: it, i });
  });
  const st = {
    calls: 0, success: 0, failed: 0,
    byProvider: { mock: { calls: 0, success: 0, failed: 0, moderation: 0, timeout: 0, ms: 0 } },
    tokensIn: 0, tokensOut: 0, moderation: 0, queueFull: 0, chainExhausted: 0,
  };
  return {
    chain: ['mock'],
    stats: () => JSON.parse(JSON.stringify(st)),
    async answer(req) {
      const key = req && req.key;
      const hit = byKey.get(key);
      st.calls += 1;
      st.byProvider.mock.calls += 1;
      const t0 = Date.now();
      if (latencyMs) await sleep(latencyMs);
      st.byProvider.mock.ms += Date.now() - t0;
      const tokensIn = 24 + (key ? key.length % 17 : 0);
      const tokensOut = 2 + (key ? key.charCodeAt(0) % 5 : 0);
      st.tokensIn += tokensIn;
      st.tokensOut += tokensOut;
      if (!hit || !hit.item.valid) {
        st.failed += 1;
        st.byProvider.mock.failed += 1;
        return { ok: false, reason: 'ai_error' };
      }
      if (plan.failIndexes && plan.failIndexes.has(hit.i)) {
        st.failed += 1;
        st.byProvider.mock.failed += 1;
        st.chainExhausted += 1;
        return { ok: false, reason: 'ai_error' };
      }
      st.success += 1;
      st.byProvider.mock.success += 1;
      return {
        ok: true,
        answer: hit.item.expected,
        provider: 'mock',
        model: 'mock-qwen-flash',
        tokens: { in: tokensIn, out: tokensOut },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 汇总与达标判定
 * ------------------------------------------------------------------ */

function percentileOf(sortedAsc, p) {
  const n = sortedAsc.length;
  if (!n) return 0;
  if (n === 1) return sortedAsc[0];
  const pos = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

export function summarizeResults(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  let passed = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const byType = new Map();
  const byProvider = new Map();
  const reasons = new Map();
  const msList = [];
  for (const r of list) {
    if (r.pass) passed += 1;
    tokensIn += Number(r.tokensIn) || 0;
    tokensOut += Number(r.tokensOut) || 0;
    if (Number.isFinite(Number(r.ms))) msList.push(Number(r.ms));
    const t = r.type || '未知题型';
    const bt = byType.get(t) || { total: 0, passed: 0 };
    bt.total += 1;
    if (r.pass) bt.passed += 1;
    byType.set(t, bt);
    const p = r.provider || (r.pass ? 'unknown' : 'none');
    const bp = byProvider.get(p) || { calls: 0, passed: 0, failed: 0, ms: 0 };
    bp.calls += 1;
    if (r.pass) bp.passed += 1;
    else bp.failed += 1;
    bp.ms += Number(r.ms) || 0;
    byProvider.set(p, bp);
    if (!r.pass) {
      const reason = r.reason || REPORT_REASONS.WRONG_ANSWER;
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
  }
  msList.sort((a, b) => a - b);
  const pct = (n, d) => (d ? round((n / d) * 100, 2) : 0);
  const byTypeOut = {};
  for (const [k, v] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))) {
    byTypeOut[k] = { total: v.total, passed: v.passed, failed: v.total - v.passed, accuracyPct: pct(v.passed, v.total) };
  }
  const byProviderOut = {};
  for (const [k, v] of byProvider.entries()) byProviderOut[k] = { ...v, accuracyPct: pct(v.passed, v.calls) };
  const reasonsOut = {};
  for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) reasonsOut[k] = v;
  return {
    total,
    passed,
    failed: total - passed,
    accuracy: total ? round(passed / total, 4) : 0,
    accuracyPct: pct(passed, total),
    byType: byTypeOut,
    byProvider: byProviderOut,
    reasons: reasonsOut,
    tokensIn,
    tokensOut,
    tokensTotal: tokensIn + tokensOut,
    ms: {
      samples: msList.length,
      avg: msList.length ? round(msList.reduce((a, b) => a + b, 0) / msList.length, 1) : 0,
      p50: msList.length ? round(percentileOf(msList, 0.5), 1) : 0,
      p95: msList.length ? round(percentileOf(msList, 0.95), 1) : 0,
      max: msList.length ? round(msList[msList.length - 1], 1) : 0,
    },
  };
}

export function judge(summary) {
  const s = summary || { total: 0, accuracy: 0, accuracyPct: 0 };
  const pass = s.total > 0 && s.accuracy >= THRESHOLD - 1e-9;
  return {
    pass,
    status: pass ? 'PASS' : 'FAIL',
    metric: 'accuracy',
    threshold: THRESHOLD,
    thresholdPct: THRESHOLD * 100,
    value: s.accuracy,
    valuePct: s.accuracyPct,
    total: s.total,
    note: s.total > 0 ? '' : 'no_samples',
  };
}

/* ------------------------------------------------------------------ *
 * 报表渲染
 * ------------------------------------------------------------------ */

export function renderText(report) {
  const lines = [];
  const head = report.header;
  lines.push(`[qbank][accuracy] 测试集=${head.file} 模式=${head.mode} 题目=${head.total}（非法 ${head.invalid}）`);
  lines.push(
    `[qbank][accuracy] provider 链=${head.chain.join(' -> ') || '（无）'} 并发=${head.concurrency}` +
      ` 单题超时=${head.timeoutMs}ms 判定阈值=${THRESHOLD * 100}%`,
  );
  if (head.limited) lines.push(`[qbank][accuracy] --limit 生效：只评测前 ${head.executed} 题`);
  if (head.mode === 'mock') lines.push('[qbank][accuracy] mock 模式：桩 provider 离线应答，不联网、不消耗真实额度');
  lines.push('');

  const cols = [
    ['#', 4], ['题型', 10], ['结果', 6], ['key(12)', 14], ['题干(前8字)', 20],
    ['期望', 16], ['实际', 16], ['provider', 11], ['ms', 8], ['tokens', 11], ['备注', 14],
  ];
  const header = cols.map(([n, w], i) => (i === 0 ? padStart(n, w) : i === 8 ? padStart(n, w - 1) + ' ' : pad(n, w))).join('');
  lines.push(header);
  lines.push('-'.repeat(displayWidth(header)));
  for (const r of report.rows) {
    lines.push(
      [
        padStart(String(r.index).padStart(2, '0'), cols[0][1]),
        pad(r.type, cols[1][1]),
        pad(r.pass ? 'PASS' : 'FAIL', cols[2][1]),
        pad(r.key12, cols[3][1]),
        pad(r.titlePrefix, cols[4][1]),
        pad(truncField(r.expected, cols[5][1] - 2), cols[5][1]),
        pad(truncField(r.actual, cols[6][1] - 2), cols[6][1]),
        pad(r.provider || '-', cols[7][1]),
        padStart(r.ms === null || r.ms === undefined ? '-' : String(Math.round(r.ms)), cols[8][1] - 1) + ' ',
        padStart(r.tokensIn || r.tokensOut ? `${r.tokensIn}/${r.tokensOut}` : '-', cols[9][1] - 2) + '  ',
        pad(r.pass ? r.method || '-' : r.reason || '-', cols[10][1]),
      ].join(''),
    );
  }
  lines.push('');

  const s = report.summary;
  lines.push('---- 汇总 ----');
  lines.push(`总题数 ${s.total} | 通过 ${s.passed} | 失败 ${s.failed} | 总准确率 ${s.accuracyPct}%`);
  const types = Object.keys(s.byType)
    .map((k) => `${k} ${s.byType[k].passed}/${s.byType[k].total} (${s.byType[k].accuracyPct}%)`)
    .join(' | ');
  lines.push(`分题型准确率：${types || '（无）'}`);
  lines.push(
    `耗时 avg=${s.ms.avg}ms p50=${s.ms.p50}ms p95=${s.ms.p95}ms max=${s.ms.max}ms` +
      ` | tokens in/out=${s.tokensIn}/${s.tokensOut}（合计 ${s.tokensTotal}）`,
  );
  const reasons = Object.keys(s.reasons).map((k) => `${k}=${s.reasons[k]}`).join(' ');
  lines.push(`失败原因分布：${reasons || '（无失败）'}`);
  const providers = Object.keys(s.byProvider)
    .map((k) => `${k} ${s.byProvider[k].passed}/${s.byProvider[k].calls}`)
    .join(' | ');
  lines.push(`provider 命中：${providers || '（无）'}`);
  lines.push('');
  const v = report.verdict;
  lines.push(`[达标判定 HANDOFF §12.7] 总准确率 ${v.valuePct}% >= ${v.thresholdPct}% -> ${v.status}`);
  if (v.note === 'no_samples') lines.push('[qbank][accuracy] 没有可评测的题目，按 FAIL 处理');
  if (report.outFile) lines.push(`[qbank][accuracy] 机器可读报表已写入：${report.outFile}`);
  return lines.join('\n') + '\n';
}

export function renderNoProviderHint(info = {}) {
  const requested = info.requested ? `--provider ${info.requested}：` : '';
  const unreach = Array.isArray(info.unreachable) && info.unreachable.length
    ? `（已探活但连不上：${info.unreachable.join(', ')}）`
    : '';
  return [
    `[qbank][accuracy][ai_disabled] ${requested}没有可用的 AI provider${unreach}，评测无法执行。`,
    '退出码 2（不计为 FAIL）。请任选一种方式配置后重试：',
    '  1) 阿里云百炼（主力）：复制 .env.example 为 .env，填入 DASHSCOPE_API_KEY=sk-xxxxxxxx',
    '     申请入口：https://bailian.console.aliyun.com/ -> 右上角「API-KEY」管理',
    '     PowerShell 临时设置：$env:DASHSCOPE_API_KEY="sk-xxxxxxxx"',
    '     bash/zsh 临时设置：  export DASHSCOPE_API_KEY=sk-xxxxxxxx',
    '  2) Ollama 本地模型（免 Key、免审核）：先 ollama serve，再 ollama pull qwen2.5:7b',
  '     确认 http://127.0.0.1:11434/api/tags 能打开（本工具会先探活，连不上就报本提示）',
    '     然后：node tools/accuracy.js --file <测试集> --provider ollama',
    '  3) 只想验证报表逻辑：加 --mock 离线跑通（不联网、不消耗额度）',
  ].join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * 依赖装载（动态 import：T2 的 lib/ai、lib/queue 未就绪时给出清晰中文提示）
 * ------------------------------------------------------------------ */

function makeLog(stderr) {
  return {
    moderation(key, code, provider) {
      stderr.write(`[qbank][accuracy][ai_moderation] key=${shortKey(key)} code=${code} provider=${provider}\n`);
    },
    error(scope, code) {
      stderr.write(`[qbank][accuracy][${code || 'ai_error'}] scope=${scope}\n`);
    },
    info(scope, obj) {
      stderr.write(`[qbank][accuracy][info] scope=${scope} ${JSON.stringify(obj || {})}\n`);
    },
  };
}

async function importCore(cwd) {
  let cfgMod;
  try {
    cfgMod = await import('../config.js');
  } catch (err) {
    throw makeError('bad_request', `无法加载 config.js（${(err && err.code) || err}）：T0 骨架缺失`);
  }
  let norm = null;
  try {
    norm = await import('../lib/normalize.js');
  } catch {
    norm = null; // 允许在 T1 未就绪时用 --mock 跑报表逻辑
  }
  let queueMod = null;
  try {
    queueMod = await import('../lib/queue.js');
  } catch {
    queueMod = null;
  }
  return {
    cwd,
    loadConfig: typeof cfgMod.loadConfig === 'function' ? cfgMod.loadConfig : null,
    apiKeyFor: typeof cfgMod.apiKeyFor === 'function' ? cfgMod.apiKeyFor : null,
    norm,
    queueMod,
    env: process.env,
    hrtime: () => process.hrtime.bigint(),
  };
}

/** 计算实际生效的 provider 链（缺 Key / 缺 baseUrl 的一律剔除）。 */
export function resolveChain(cfg, env, requested, apiKeyFor) {
  const providers = (cfg && cfg.providers) || {};
  const names = requested
    ? [requested]
    : Array.isArray(cfg && cfg.ai && cfg.ai.fallback)
      ? [...cfg.ai.fallback]
      : [];
  const unknown = names.filter((n) => !providers[n] || typeof providers[n] !== 'object');
  const chain = [];
  for (const n of names) {
    const pc = providers[n];
    if (!pc || typeof pc !== 'object') continue;
    if (!pc.baseUrl) continue;
    if (pc.apiKeyEnv && !apiKeyFor(pc, env)) continue;
    chain.push(n);
  }
  return { chain, unknown, requestedNames: names };
}

/** 探活地址：ollama 用 /api/tags，OpenAI 兼容端点用 /models。 */
function probeUrl(name, baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  try {
    const u = new URL(base);
    u.pathname = name === 'ollama' ? '/api/tags' : (u.pathname.replace(/\/+$/, '') + '/models');
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * provider 可用性预检。带 Key 的 provider 只要 Key 在就算可用（不联网）；
 * 一个带 Key 的都没有时，才对本地 provider 做一次轻量探活（GET，默认 1.5s 超时）。
 * 目的：缺 Key + 本地 Ollama 没起 -> 报「无法评测」（退出码 2），而不是刷出 20 个 FAIL。
 * @returns {Promise<{ready:string[], unreachable:string[], probed:boolean}>}
 */
export async function probeChain(chain, providers, opts = {}) {
  const names = Array.isArray(chain) ? chain.map(String) : [];
  const pc = providers && typeof providers === 'object' ? providers : {};
  const o = opts || {};
  const env = o.env || {};
  const keyFor = typeof o.apiKeyFor === 'function'
    ? o.apiKeyFor
    : (c, e) => (c && c.apiKeyEnv ? (e || {})[c.apiKeyEnv] : undefined);
  const keyed = names.filter((n) => {
    const c = pc[n];
    return Boolean(c && c.apiKeyEnv && keyFor(c, env));
  });
  if (keyed.length) return { ready: [...names], unreachable: [], probed: false };

  const timeoutMs = toInt(o.timeoutMs, 1500, 100, 20000);
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : typeof fetch === 'function' ? fetch : null;
  if (!fetchImpl) return { ready: [...names], unreachable: [], probed: false };

  const ready = [];
  const unreachable = [];
  for (const n of names) {
    const url = probeUrl(n, pc[n] && pc[n].baseUrl);
    if (!url) {
      unreachable.push(n);
      continue;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      await fetchImpl(url, { method: 'GET', signal: ctl.signal });
      ready.push(n); // 任何 HTTP 响应（含 4xx/401）都说明服务活着
    } catch {
      unreachable.push(n);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ready, unreachable, probed: true };
}

function emptyRow(item, i, reason) {
  return {
    index: (item && item.index) || i + 1,
    type: (item && item.type) || '未知题型',
    titlePrefix: titlePrefix(item && item.title, 8),
    key12: shortKey(item && item.key, 12),
    expected: (item && item.expected) || '',
    actual: '',
    provider: '',
    model: '',
    ms: null,
    tokensIn: 0,
    tokensOut: 0,
    pass: false,
    reason: reason || 'ai_error',
    method: '',
  };
}

/**
 * 执行一次完整评测。所有外部依赖都可以通过 opts.deps 注入（自测用桩）。
 * @param {{argv?:string[], deps?:object, out?:object, err?:object, cwd?:string, env?:object}} [opts]
 * @returns {Promise<{report:object|null, exitCode:number, text:string}>}
 */
export async function runAccuracy(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const stdout = o.out || { write: (s) => process.stdout.write(s) };
  const stderr = o.err || { write: (s) => process.stderr.write(s) };

  let args;
  try {
    args = parseArgs(o.argv || []);
  } catch (err) {
    stderr.write(`[qbank][accuracy][${err.code || 'bad_request'}] ${err.message}\n`);
    stdout.write(USAGE + '\n');
    return { report: null, exitCode: EXIT.UNUSABLE, text: USAGE + '\n' };
  }
  if (args.help) {
    stdout.write(USAGE + '\n');
    return { report: null, exitCode: EXIT.PASS, text: USAGE + '\n' };
  }

  const cwd = o.cwd || ROOT;
  const deps = { ...(await importCore(cwd)), ...(o.deps || {}) };
  const env = o.env || deps.env || process.env;
  const hrtime = deps.hrtime || (() => process.hrtime.bigint());

  // 1) 配置
  let cfg = null;
  try {
    cfg = deps.loadConfig ? deps.loadConfig({ cwd, env }) : null;
  } catch (err) {
    report.outFile = ''; // 写盘失败就不能声称有产物
    stderr.write(`[qbank][accuracy][bad_request] 配置加载失败：${(err && err.code) || err}\n`);
    return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
  }
  if (!cfg) {
    stderr.write('[qbank][accuracy][bad_request] loadConfig 不可用（config.js 未导出该函数）\n');
    return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
  }

  // 2) 测试集
  const norm = deps.norm || null;
  let fixture;
  try {
    fixture = loadFixture(args.file, {
      normalizeType: norm && norm.normalizeType,
      toLabel: norm && norm.toLabel,
      makeKey: norm && norm.makeKey,
      splitOptions: norm && norm.splitOptions,
    });
  } catch (err) {
    stderr.write(`[qbank][accuracy][${err.code || 'bad_request'}] ${err.message}\n`);
    return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
  }
  let items = fixture.items;
  const limited = args.limit > 0 && args.limit < items.length;
  if (limited) items = items.slice(0, args.limit);
  if (!items.length) {
    stderr.write('[qbank][accuracy][bad_request] 测试集为空，没有可评测的题目\n');
    return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
  }

  const isUnanswerable = typeof deps.isUnanswerable === 'function'
    ? deps.isUnanswerable
    : norm && typeof norm.isUnanswerable === 'function'
      ? norm.isUnanswerable
      : () => false;

  // 3) AI 运行时（真实链路 or 桩）
  let ai = null;
  let gate = null;
  let chain = [];
  const mode = args.mock ? 'mock' : 'live';
  const createGate = deps.queueMod && typeof deps.queueMod.createGate === 'function' ? deps.queueMod.createGate : null;

  if (!args.mock) {
    if (cfg.ai && cfg.ai.enabled === false) {
      stderr.write('[qbank][accuracy][ai_disabled] config.ai.enabled=false，AI 已被禁用，评测无法执行（退出码 2）\n');
      stderr.write('如需评测请把 ai.enabled 改回 true 或设置 QBANK_AI_ENABLED=1；也可用 --mock 验证报表逻辑。\n');
      return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
    }
    const apiKeyFor = deps.apiKeyFor || ((pc, e) => (pc && pc.apiKeyEnv ? (e || env)[pc.apiKeyEnv] : undefined));
    const resolved = resolveChain(cfg, env, args.provider, apiKeyFor);
    if (resolved.unknown.length) {
      stderr.write(
        `[qbank][accuracy][bad_request] 未知 provider：${resolved.unknown.join(',')}；` +
          `可选值：${Object.keys(cfg.providers || {}).join(', ')}\n`,
      );
      return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
    }
    if (!resolved.chain.length) {
      stderr.write(renderNoProviderHint({ requested: args.provider }));
      return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
    }
    chain = resolved.chain;

    // 预检：链上一个能真正调用的都没有（缺 Key + 本地 provider 连不上）-> 退出码 2，不计为 FAIL
    const probe = typeof deps.probeChain === 'function' ? deps.probeChain : probeChain;
    let readiness = { ready: chain, unreachable: [], probed: false };
    try {
      readiness = await probe(chain, cfg.providers || {}, {
        env,
        apiKeyFor,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.probeTimeoutMs,
      });
    } catch {
      readiness = { ready: chain, unreachable: [], probed: false };
    }
    if (!readiness.ready.length) {
      stderr.write(renderNoProviderHint({ requested: args.provider, unreachable: readiness.unreachable }));
      return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
    }
    chain = readiness.ready;

    let aiMod;
    try {
      // deps.loadAIModule 是自测注入点（T2 未落地时用桩验证真实链路的装配逻辑）
      aiMod = deps.loadAIModule ? await deps.loadAIModule() : await import('../lib/ai/index.js');
    } catch (err) {
      stderr.write(
        `[qbank][accuracy][ai_error] 无法加载 lib/ai/index.js（${(err && err.code) || err}）：AI 链路（T2）尚未就绪。\n` +
          '现在可以先用 --mock 离线验证报表逻辑；等 T2/T6 完成后再跑真实评测。\n',
      );
      return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
    }
    if (typeof aiMod.createAI !== 'function') {
      stderr.write('[qbank][accuracy][ai_error] lib/ai/index.js 未按 CONTRACT §7 导出 createAI\n');
      return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
    }
    if (!createGate) {
      stderr.write('[qbank][accuracy][ai_error] lib/queue.js 不可用，改用内置并发池（并发上限仍受 --concurrency 约束）\n');
    }
    const aiCfg = {
      ...cfg,
      ai: { ...cfg.ai, enabled: true, fallback: chain, concurrency: args.concurrency, timeoutMs: args.timeout },
    };
    const queueLimit = Math.max((cfg.ai && cfg.ai.queueLimit) || 0, items.length + 8);
    // 外层闸由本工具持有；注入给 createAI 的是**另一个**实例，避免同一 gate 嵌套自锁。
    try {
      gate = createGate ? createGate({ concurrency: args.concurrency, queueLimit, timeoutMs: args.timeout }) : null;
    } catch {
      gate = null;
    }
    let innerGate = null;
    try {
      innerGate = createGate ? createGate({ concurrency: args.concurrency, queueLimit, timeoutMs: args.timeout }) : null;
    } catch {
      innerGate = null;
    }
    try {
      ai = aiMod.createAI({ config: aiCfg, env, log: makeLog(stderr), gate: innerGate });
    } catch (err) {
      stderr.write(`[qbank][accuracy][ai_error] createAI 初始化失败：${(err && err.code) || err}\n`);
      return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
    }
    if (!ai || typeof ai.answer !== 'function') {
      stderr.write('[qbank][accuracy][ai_error] createAI 未返回 answer()，无法评测\n');
      return { report: null, exitCode: EXIT.UNUSABLE, text: '' };
    }
    if (Array.isArray(ai.chain) && ai.chain.length) chain = ai.chain;
  } else {
    chain = ['mock'];
    const plan = buildMockPlan(items.length, args.mockAccuracy);
    try {
      gate = createGate ? createGate({ concurrency: args.concurrency, queueLimit: items.length + 8, timeoutMs: args.timeout }) : null;
    } catch {
      gate = null;
    }
    ai = deps.mockAI || createMockAI({
      items,
      plan,
      latencyMs: deps.mockLatencyMs === undefined ? 5 : deps.mockLatencyMs,
      sleep: deps.sleep,
    });
  }

  // 4) 逐题评测
  const worker = async (item) => {
    if (!item || !item.valid) {
      const row = emptyRow(item, 0, REPORT_REASONS.INVALID_ITEM);
      row.type = '非法条目';
      return row;
    }
    const row = emptyRow(item, 0, '');
    let unanswerable = false;
    try {
      unanswerable = Boolean(isUnanswerable(item.title, item.options));
    } catch {
      unanswerable = false;
    }
    if (unanswerable) {
      row.reason = 'image_or_formula';
      return row;
    }
    const t0 = hrtime();
    let res;
    try {
      res = await ai.answer({ key: item.key, type: item.type, title: item.title, options: item.options });
    } catch (err) {
      res = { ok: false, reason: (err && err.code) || 'ai_error' };
    }
    row.ms = round(Number(hrtime() - t0) / 1e6, 1);
    if (!res || res.ok !== true) {
      row.reason = (res && res.reason) || 'ai_error';
      return row;
    }
    row.actual = String(res.answer === null || res.answer === undefined ? '' : res.answer);
    row.provider = res.provider || chain[0] || '';
    row.model = res.model || '';
    row.tokensIn = (res.tokens && Number(res.tokens.in)) || 0;
    row.tokensOut = (res.tokens && Number(res.tokens.out)) || 0;
    const g = gradeAnswer(item.expected, row.actual, item.type);
    row.pass = Boolean(g.pass);
    row.method = g.method;
    row.reason = row.pass ? '' : REPORT_REASONS.WRONG_ANSWER; // T6：pass 行清空 reason（emptyRow 默认 ai_error 不得残留）
    return row;
  };

  let settled = null;
  try {
    settled = await schedule(items, worker, {
      gate,
      concurrency: args.concurrency,
      timeoutMs: gate ? 0 : args.timeout,
    });
  } catch (err) {
    stderr.write(`[qbank][accuracy][${(err && err.code) || 'ai_error'}] 评测执行失败：${err.message}\n`);
  }

  const rows = [];
  if (settled) {
    settled.forEach((s, i) => {
      if (s && s.ok && s.value) rows.push(s.value);
      else rows.push(emptyRow(items[i], i, (s && s.error && s.error.code) || 'ai_error'));
    });
  } else {
    items.forEach((item, i) => rows.push(emptyRow(item, i, 'ai_error')));
  }

  // 5) 收尾：释放 gate，避免 node --test 挂住（CONTRACT §11.1）
  try {
    if (gate && typeof gate.drain === 'function') await gate.drain();
  } catch {
    /* 忽略 */
  }
  try {
    if (gate && typeof gate.close === 'function') gate.close();
    else if (gate && typeof gate.stop === 'function') gate.stop();
  } catch {
    /* 忽略 */
  }

  const summary = summarizeResults(rows);
  const verdict = judge(summary);
  let aiStats = null;
  try {
    aiStats = ai && typeof ai.stats === 'function' ? ai.stats() : null;
  } catch {
    aiStats = null;
  }
  const report = {
    tool: 'accuracy',
    schemaVersion: 1,
    generatedAt: Date.now(),
    node: process.version,
    header: {
      file: args.file,
      mode,
      chain,
      concurrency: args.concurrency,
      timeoutMs: args.timeout,
      total: items.length,
      executed: rows.length,
      invalid: fixture.invalid,
      limited,
      threshold: THRESHOLD,
    },
    rows,
    summary,
    verdict,
    aiStats,
    outFile: '',
  };

  // 6) --out：没有默认路径（docs/ 不属于 T5 写权限，由 T6 集成时显式指定）
  if (args.out) {
    try {
      const target = path.isAbsolute(args.out) ? args.out : path.resolve(cwd, args.out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      report.outFile = target; // 先赋值再写盘，保证 --out 文件与 stdout 报表逐字节一致
      fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', 'utf8');
    } catch (err) {
      stderr.write(`[qbank][accuracy][bad_request] 报表写入失败：${args.out}（${(err && err.code) || err}）\n`);
    }
  }

  const text = args.json ? JSON.stringify(report, null, 2) + '\n' : renderText(report);
  stdout.write(text);
  return { report, exitCode: verdict.pass ? EXIT.PASS : EXIT.FAIL, text };
}

/** CLI 入口。 */
export async function main(argv = process.argv.slice(2)) {
  try {
    const { exitCode } = await runAccuracy({ argv });
    process.exitCode = exitCode;
    return exitCode;
  } catch (err) {
    const verbose = argv.includes('--verbose');
    process.stderr.write(`[qbank][accuracy][${(err && err.code) || 'ai_error'}] ${(err && err.message) || '未知错误'}\n`);
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

export default {
  runAccuracy, main, parseArgs, loadFixture, gradeAnswer, schedule, createMockAI, buildMockPlan,
  summarizeResults, judge, renderText, resolveChain, probeChain, THRESHOLD, EXIT,
};
