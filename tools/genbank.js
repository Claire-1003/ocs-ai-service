// tools/genbank.js — 合成题库生成器（Owner: T4）
// 契约依据：docs/CONTRACT.md §3 §9 §10 §11；HANDOFF §8.3 §12.6；docs/DECISIONS.md #13
// 纪律：零第三方依赖、ESM、确定性 PRNG（mulberry32，禁用 Math.random）、模块顶层无 I/O。
// 说明：updatedAt / createdAt 一律使用固定基准常量而非 Date.now()，
//       否则「同 seed 逐字节可复现」（DoD 要求）无法成立。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeKey, toLabel } from '../lib/normalize.js';

/** 固定时间基准：保证同 seed 输出逐字节相同。 */
export const EPOCH = 1700000000000;

/** 题型配比（任务规格）：单选 50% / 多选 25% / 判断 15% / 填空 5% / 问答 5%。 */
export const TYPE_MIX = Object.freeze([
  ['单选', 0.5],
  ['多选', 0.75],
  ['判断', 0.9],
  ['填空', 0.95],
  ['问答', 1.0],
]);

/** 近似重复题比例（用于验证 L2 模糊匹配与 tie-break）。 */
export const NEAR_DUP_RATE = 0.05;

export const USAGE = [
  '用法：node tools/genbank.js --count 50000 [--out data/bench.json] [--seed 42]',
  '选项：',
  '  --count <n>    生成条数（默认 50000）',
  '  --out <p>      输出文件（默认 data/bench.json）',
  '  --seed <n>     PRNG 种子（默认 42，同 seed 逐字节可复现）',
  '  --verbose      每 10000 条打一次进度到 stderr',
  '  --help, -h     显示本帮助',
  '退出码：0 成功 / 1 失败；stdout 输出 JSON 摘要',
].join('\n');

function badRequest(message) {
  const err = new Error(message);
  err.code = 'bad_request';
  return err;
}

/** mulberry32：32 位种子的确定性 PRNG，返回 [0,1)。 */
export function mulberry32(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  const n = arr.length;
  if (!n) return '';
  const i = Math.floor(rng() * n) % n;
  return arr[i];
}

function randInt(rng, min, max) {
  if (max < min) return min;
  return min + (Math.floor(rng() * (max - min + 1)) % (max - min + 1));
}

const TOPICS = [
  '中国特色社会主义', '宪法', '民法典', '市场经济', '新发展理念', '党史', '公民道德', '网络安全',
  '环境保护', '知识产权', '劳动法', '行政法规', '现代企业管理', '数据结构', '操作系统', '计算机网络',
  '数据库原理', '软件工程', '人工智能', '思想政治理论', '宏观调控', '乡村振兴', '生态文明', '社会保障',
  '国际贸易', '基层群众自治', '依法治国', '数字经济', '公共安全', '教育公平',
];

// 二级主题：与 TOPICS 组合，把标题空间放大到数万级，保证 5 万条 key 天然唯一
const SUBTOPICS = [
  '制度建设', '法律责任', '监督管理', '实施程序', '基本原则', '权利义务', '处罚标准', '许可条件',
  '信息公开', '纠纷解决', '风险防范', '责任追究', '配套措施', '适用范围', '主管部门', '备案要求',
  '执法监督', '救济途径', '合同效力', '证据规则', '时限要求', '经费保障', '人员培训', '考核评价',
  '数据分类分级', '跨境流动管理', '应急处置', '标准制定', '投诉举报', '信用惩戒',
];

const JUDGE_WORDS = ['正确', '错误', '不准确', '最恰当', '不符合规定', '符合现行规定'];

const JUDGE_STMTS = [
  '接受社会监督', '公开公平公正', '依法履行职责', '保障当事人合法权益', '报主管部门备案',
  '听取公众意见', '建立风险台账', '实行分类管理', '留存相关记录不少于三年', '及时向社会公布',
  '接受审计监督', '不得收取任何费用',
];

const TAIL_POOL = ['（结合本地实际）', '（依据最新修订）', '（试点地区适用）', '（2025年版）', '（含配套细则）', '（新修订）', '（施行之日起）', '（经主管部门批准）'];

const TITLE_TPL = [
  (t, x) => '关于' + t + '的下列说法中，' + x + '的一项是（ ）',
  (t, x) => t + '的核心要义与基本要求，下列表述' + x + '的是',
  (t, x) => '下列关于' + t + '的说法，' + x + '的是（ ）',
  (t, x) => '在' + t + '领域中，表述' + x + '的选项是哪一个',
  (t, x) => '根据我国' + t + '的相关规定，下列选项' + x + '的是',
  (t, x) => t + '是我国发展的重要内容，以下说法' + x + '的一项是',
  (t, x) => '某单位在推进' + t + '工作时，下列做法' + x + '的是（ ）',
  (t, x) => '学习' + t + '时同学们提出了以下观点，其中' + x + '的是',
  (t, x) => '结合' + t + '的基本原理判断，下列描述' + x + '的是哪一项',
];

const JUDGE_TPL = [
  (t, st) => '根据现行规定，' + t + '工作中应当' + st + '，这一说法是否正确',
  (t, st) => t + '必须坚持' + st + '，该表述是否成立',
  (t, st) => '在' + t + '领域，任何组织和个人都应当' + st + '，请判断对错',
  (t, st) => '下列关于' + t + '的表述：应当' + st + '。请判断其正误',
];

const FILL_TPL = [
  (t, ph) => '在' + t + '的基本框架中，' + ph + '是必须掌握的核心内容',
  (t, ph) => t + '强调' + ph + '，这是相关制度设计的重要出发点',
  (t, ph) => '根据' + t + '的规定，' + ph + '应当由主管部门统一公布并备案',
  (t, ph) => '学习' + t + '时需要明确，' + ph + '共同构成完整的制度链条',
];

const QA_TPL = [
  (t) => '请简要论述' + t + '在我国现代化建设中的地位与作用',
  (t) => '简述' + t + '的基本原则，并说明其在实践中的具体要求',
  (t) => '结合实际，谈谈如何进一步推进' + t + '相关工作落实落地',
  (t) => '试述' + t + '制度的主要内容及其现实意义',
];

const OPTION_POOL = [
  '坚持党的全面领导', '实现全体人民共同富裕', '推进全面依法治国', '保障人民当家作主', '深化改革开放',
  '促进社会公平正义', '维护国家主权与安全', '推动高质量发展', '完善社会保障体系', '加强生态文明建设',
  '坚持公有制为主体', '发挥市场决定性作用', '强化知识产权保护', '落实安全生产责任', '提高公共服务水平',
  '坚持德才兼备用人导向', '完善数据分类分级保护', '健全社会信用体系', '推动科技自立自强', '促进区域协调发展',
  '坚持以人民为中心', '严格规范公正文明执法', '加强基层组织建设', '推进政务公开透明', '构建新发展格局',
  '落实减负稳岗扩就业', '完善应急管理体系', '加强青少年法治教育', '推动绿色低碳转型', '优化营商环境',
];

const FILL_ANS = [
  '依法治国', '人民主体', '公平正义', '共同富裕', '高质量发展', '制度创新', '公开透明', '权责一致',
  '共建共享', '绿色发展', '安全底线', '统筹协调',
];

const LETTERS = 'ABCDEFGH';

function letter(i) {
  return LETTERS.charAt(i % LETTERS.length);
}

function distinctIndexes(rng, n, k) {
  const pool = [];
  for (let i = 0; i < n; i++) pool.push(i);
  const out = [];
  for (let i = 0; i < k && pool.length; i++) {
    const j = Math.floor(rng() * pool.length) % pool.length;
    out.push(pool.splice(j, 1)[0]);
  }
  return out;
}

function pickType(rng) {
  const r = rng();
  for (const [type, edge] of TYPE_MIX) if (r < edge) return type;
  return '问答';
}

/** 主题短语：一级主题 + 可选二级主题，把 key 空间放大到数万级。 */
function makeTopic(rng) {
  const base = pick(rng, TOPICS);
  return rng() < 0.75 ? base + pick(rng, SUBTOPICS) : base;
}

function withTail(rng, title) {
  if (rng() < 0.45) {
    const t = title + pick(rng, TAIL_POOL);
    if (titleLengthOk(t)) return t;
  }
  return title;
}

function makeOptions(rng, count) {
  const idxs = distinctIndexes(rng, OPTION_POOL.length, count);
  return idxs.map((pi, i) => letter(i) + '.' + OPTION_POOL[pi]);
}

function titleLengthOk(t) {
  const n = [...t].length;
  return n >= 15 && n <= 60;
}

/** 生成一条全新记录 draft（不含 key，key 由 toRecord 统一计算）。 */
function freshRecord(rng, seq) {
  const shortType = pickType(rng);
  let title = '';
  let options = [];
  let answer = '';
  if (shortType === '判断') {
    for (let i = 0; i < 12; i++) {
      const t = pick(rng, JUDGE_TPL)(makeTopic(rng), pick(rng, JUDGE_STMTS));
      if (titleLengthOk(t)) {
        title = t;
        break;
      }
    }
    options = ['A.正确', 'B.错误'];
    answer = rng() < 0.5 ? '正确' : '错误';
  } else if (shortType === '填空') {
    const blanks = randInt(rng, 1, 2);
    const ph = blanks === 1 ? '____' : '____与____';
    for (let i = 0; i < 12; i++) {
      const t = pick(rng, FILL_TPL)(makeTopic(rng), ph);
      if (titleLengthOk(t)) {
        title = t;
        break;
      }
    }
    const idxs = distinctIndexes(rng, FILL_ANS.length, blanks);
    answer = idxs.map((k) => FILL_ANS[k]).join('#');
  } else if (shortType === '问答') {
    for (let i = 0; i < 12; i++) {
      const t = pick(rng, QA_TPL)(makeTopic(rng));
      if (titleLengthOk(t)) {
        title = t;
        break;
      }
    }
    answer =
      '应当坚持' + pick(rng, OPTION_POOL) + '，同时结合' + pick(rng, OPTION_POOL) +
      '，在实践中做到' + pick(rng, OPTION_POOL) + '，并接受社会监督。';
  } else {
    for (let i = 0; i < 12; i++) {
      const t = pick(rng, TITLE_TPL)(makeTopic(rng), pick(rng, JUDGE_WORDS));
      if (titleLengthOk(t)) {
        title = t;
        break;
      }
    }
    // 多选题至少 3 个选项，保证「多选但不全选」更贴近真实题库
    const n = shortType === '多选' ? randInt(rng, 3, 5) : randInt(rng, 2, 5);
    options = makeOptions(rng, n);
    if (shortType === '单选') {
      answer = letter(randInt(rng, 0, n - 1));
    } else {
      const k = n >= 3 ? randInt(rng, 2, n - 1) : 2;
      const chosen = distinctIndexes(rng, n, k).sort((a, b) => a - b);
      answer = chosen.map((i) => letter(i)).join('#');
    }
  }
  title = withTail(rng, title);
  if (!titleLengthOk(title)) title = [...title].slice(0, 60).join('');
  return { seq, shortType, title, options, answer };
}

const OPTION_LEAD = /^[A-H]\s*[.、)）:：]\s*/;
const MUT_CHARS = ['的', '了', '和', '与', '及', '中', '在', '是', '对', '为'];

function stripLetter(option) {
  return String(option).replace(OPTION_LEAD, '');
}

/** 近似重复之一：改一两个字（制造 L2 高分候选，但 key 不同）。 */
function mutateTitle(rng, title) {
  const chars = [...title];
  if (chars.length < 3) return title;
  const op = randInt(rng, 0, 2);
  const i = randInt(rng, 1, chars.length - 2);
  if (op === 0) chars[i] = pick(rng, MUT_CHARS);
  else if (op === 1) chars.splice(i, 0, pick(rng, MUT_CHARS));
  else chars.splice(i, 1);
  const out = chars.join('');
  return titleLengthOk(out) ? out : title;
}

/** 近似重复之二：选项乱序（重新标号 + 答案字母同步重映射，判断题答案不变）。 */
function shuffleOptions(rng, options, answer, shortType) {
  if (!Array.isArray(options) || options.length < 2) return { options, answer };
  const texts = options.map(stripLetter);
  const order = distinctIndexes(rng, texts.length, texts.length);
  const nextOptions = order.map((oldIdx, newIdx) => letter(newIdx) + '.' + texts[oldIdx]);
  if (shortType !== '单选' && shortType !== '多选') return { options: nextOptions, answer };
  const posOf = new Map();
  order.forEach((oldIdx, newIdx) => posOf.set(letter(oldIdx), letter(newIdx)));
  const nextAnswer = String(answer)
    .split('#')
    .map((c) => posOf.get(c.trim().toUpperCase()) || c.trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join('#');
  return { options: nextOptions, answer: nextAnswer };
}

const SHORT_BY_LABEL = Object.freeze({ 单选题: '单选', 多选题: '多选', 判断题: '判断', 填空题: '填空', 问答题: '问答' });

/** 由近似重复派生一条记录：标题改字，50% 概率同时乱序选项（字母答案同步重映射）。 */
function deriveNearDuplicate(rng, base, seq) {
  // base 可能是已生成的 Record（type 为中文 label）或 draft（shortType 为短题型）
  const shortType = base.shortType || SHORT_BY_LABEL[base.type] || '单选';
  const title = mutateTitle(rng, base.title);
  const useShuffle = rng() < 0.5;
  const shuffled = useShuffle ? shuffleOptions(rng, base.options, base.answer, shortType) : { options: base.options.slice(), answer: base.answer };
  return { seq, shortType, title, options: shuffled.options, answer: shuffled.answer };
}

/** 极端兜底：标题追加唯一编号，保证 key 唯一（合成数据专用，长度仍受 15~60 约束）。 */
function withSerial(title, seq) {
  const tag = '（依据第' + seq + '号令修订）';
  const max = 60 - [...tag].length;
  const chars = [...title];
  const base = chars.length > max ? chars.slice(0, max).join('') : title;
  return base + tag;
}

function toRecord(draft) {
  const record = {
    key: makeKey(draft.title, draft.options),
    title: draft.title,
    options: draft.options,
    answer: draft.answer,
    type: toLabel(draft.shortType),
    source: 'import',
    verified: false,
    createdAt: EPOCH + draft.seq,
  };
  return record;
}

/**
 * 生成 count 条合成记录（确定性）。
 * @returns {{records:object[], stats:{count:number,nearDuplicates:number,collisions:number,byType:object}}}
 */
export function generate(count, seed) {
  const total = Math.max(0, Math.trunc(Number(count) || 0));
  const rng = mulberry32(seed);
  const records = [];
  const byType = { 单选题: 0, 多选题: 0, 判断题: 0, 填空题: 0, 问答题: 0 };
  const seen = new Set();
  let nearDuplicates = 0;
  let collisions = 0;
  while (records.length < total) {
    const seq = records.length;
    const wantDup = seq > 0 && rng() < NEAR_DUP_RATE;
    let draft;
    if (wantDup) {
      const baseIdx = randInt(rng, Math.max(0, seq - 200), seq - 1);
      draft = deriveNearDuplicate(rng, records[baseIdx], seq);
      nearDuplicates += 1;
    } else {
      draft = freshRecord(rng, seq);
    }
    let record = toRecord(draft);
    let guard = 0;
    while (seen.has(record.key) && guard < 6) {
      collisions += 1;
      guard += 1;
      draft = { ...draft, seq, title: mutateTitle(rng, draft.title) };
      record = toRecord(draft);
    }
    if (seen.has(record.key)) {
      collisions += 1;
      draft = { ...draft, seq, title: withSerial(draft.title, seq) };
      record = toRecord(draft);
      if (seen.has(record.key)) continue; // 理论上不可达：编号唯一
    }
    seen.add(record.key);
    byType[record.type] = (byType[record.type] || 0) + 1;
    records.push(record);
  }
  return { records, stats: { count: records.length, nearDuplicates, collisions, byType } };
}

/** 流式写盘：临时文件 + rename（DECISIONS #14），避免一次性拼 50MB 字符串。 */
export function writeRecords(outPath, records, opts = {}) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = outPath + '.tmp-' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  let bytes = 0;
  const write = (chunk) => {
    const buf = Buffer.from(chunk, 'utf8');
    bytes += buf.length;
    fs.writeSync(fd, buf);
  };
  try {
    write('{"version":1,"updatedAt":' + EPOCH + ',"records":[');
    let pending = '';
    for (let i = 0; i < records.length; i++) {
      pending += (i ? ',\n' : '\n') + JSON.stringify(records[i]);
      if (pending.length >= 1024 * 1024) {
        write(pending);
        pending = '';
      }
      if (opts.onProgress && (i + 1) % 10000 === 0) opts.onProgress(i + 1, records.length);
    }
    if (pending) write(pending);
    write(records.length ? '\n]}\n' : ']}\n');
  } finally {
    fs.closeSync(fd);
  }
  let existed = false;
  try {
    existed = fs.statSync(outPath).isFile();
  } catch {
    existed = false;
  }
  if (existed) {
    try {
      fs.copyFileSync(outPath, outPath + '.bak');
    } catch {
      /* 备份失败不致命，继续原子替换 */
    }
  }
  fs.renameSync(tmp, outPath);
  return { bytes, backup: existed };
}

export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a)) : [];
  const opts = { count: 50000, out: null, seed: 42, verbose: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) throw badRequest('出现无法识别的位置参数（第 ' + (i + 1) + ' 个）');
    let name = arg.replace(/^-+/, '');
    let inline = null;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const take = () => {
      if (inline !== null) return inline;
      const v = args[i + 1];
      if (v === undefined) throw badRequest('参数 --' + name + ' 缺少取值');
      i += 1;
      return v;
    };
    switch (name.toLowerCase()) {
      case 'help':
      case 'h':
        opts.help = true;
        break;
      case 'count':
      case 'c':
      case 'n': {
        const v = Number(take());
        if (!Number.isFinite(v) || v < 0 || v > 5000000) throw badRequest('--count 取值非法（应为 0~5000000 的数字）');
        opts.count = Math.trunc(v);
        break;
      }
      case 'out':
      case 'o':
        opts.out = take();
        break;
      case 'seed':
      case 's': {
        const v = Number(take());
        if (!Number.isFinite(v)) throw badRequest('--seed 取值非法（应为数字）');
        opts.seed = Math.trunc(v) >>> 0;
        break;
      }
      case 'verbose':
      case 'v':
        opts.verbose = true;
        break;
      default:
        throw badRequest('不支持的参数：--' + name + '（--help 查看用法）');
    }
  }
  if (opts.help) return opts;
  if (!opts.out) opts.out = path.join('data', 'bench.json');
  opts.out = path.resolve(String(opts.out));
  return opts;
}

export async function runGenerate(opts, hooks = {}) {
  const stderr = typeof hooks.stderr === 'function' ? hooks.stderr : (s) => process.stderr.write(s);
  const started = Date.now();
  try {
    if (!opts || typeof opts !== 'object') throw badRequest('缺少参数');
    const count = Math.trunc(Number(opts.count));
    if (!Number.isFinite(count) || count < 0) throw badRequest('--count 取值非法');
    const outPath = path.resolve(String(opts.out || path.join('data', 'bench.json')));
    const { records, stats } = generate(count, opts.seed);
    const genMs = Date.now() - started;
    const written = hooks.noWrite ? { bytes: 0, backup: false } : writeRecords(outPath, records, {
      onProgress: opts.verbose ? (done, total) => stderr('[qbank][genbank][info] ' + done + '/' + total + '\n') : undefined,
    });
    const summary = {
      count: records.length,
      seed: Number(opts.seed) >>> 0,
      out: outPath,
      bytes: written.bytes,
      nearDuplicates: stats.nearDuplicates,
      collisions: stats.collisions,
      byType: stats.byType,
      generateMs: genMs,
      elapsed: Date.now() - started,
    };
    return { summary, exitCode: 0 };
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'bad_request';
    return {
      summary: { count: 0, seed: Number(opts && opts.seed) >>> 0 || 0, out: (opts && opts.out) || '', bytes: 0, nearDuplicates: 0, collisions: 0, byType: {}, generateMs: 0, elapsed: Date.now() - started },
      exitCode: 1,
      error: { code, message: err && err.message ? err.message : '生成失败' },
    };
  }
}

export async function main(argv, io = {}) {
  const stdout = typeof io.stdout === 'function' ? io.stdout : (s) => process.stdout.write(s);
  const stderr = typeof io.stderr === 'function' ? io.stderr : (s) => process.stderr.write(s);
  const exit = typeof io.exit === 'function' ? io.exit : (c) => process.exit(c);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr('[qbank][genbank][' + ((err && err.code) || 'bad_request') + '] ' + ((err && err.message) || '参数非法') + '\n');
    await exit(1);
    return 1;
  }
  if (opts.help) {
    stdout(USAGE + '\n');
    await exit(0);
    return 0;
  }
  const res = await runGenerate(opts, { stderr, noWrite: io.noWrite });
  if (res.exitCode !== 0 && res.error) stderr('[qbank][genbank][' + res.error.code + '] ' + res.error.message + '\n');
  stdout(JSON.stringify(res.summary) + '\n');
  await exit(res.exitCode);
  return res.exitCode;
}

const isDirectRun = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write('[qbank][genbank][' + ((err && err.code) || 'ai_error') + '] 未预期错误\n');
    process.exit(1);
  });
}

export default { mulberry32, generate, writeRecords, parseArgs, runGenerate, main, EPOCH, TYPE_MIX };