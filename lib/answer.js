// lib/answer.js — AI 输出后处理与题型校验（Owner: T2）
//
// 契约：docs/CONTRACT.md §5；步骤链严格照 HANDOFF.md §7.4。
// 铁律：纯函数，无 I/O、无副作用、永不抛异常；不打印任何内容（日志纪律由调用方负责）。
//
// 导出：
//   export function postProcess(raw, ctx)      // ctx = { type, options }
//   export function validate(answer, type, options)
//   export function normalizeJudge(token, options)

// 失败时统一返回 { ok:false, code:'invalid_output' }（CONTRACT §0 的内部错误码）。

const FENCE_HEAD_NL = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n/;
const FENCE_HEAD_INLINE = /^```/;
const FENCE_TAIL = /\r?\n?[ \t]*```$/;
// CONTRACT §5 指定的前缀集合；额外允许前缀后紧跟「是/为」（如「正确答案是 A」），
// 否则剥离后会残留「是 A」，只能靠兜底提取，属于保守增强（见交付报告·契约歧义）。
// T6/P0-5：交替分支按「最长优先」重排（词集不变），否则「答案应为 B」只剥掉「答案」
// 残留「应为 B」，被迫走 fallback；重排后 strict 直接命中。
const PREFIX_RE = /^(正确答案|参考答案|答案应为|正确选项是|应该选|答案是|应选|答案|选项)\s*(?:是|为)?\s*[:：]?\s*/;
// 首尾需要剥掉的句号/逗号/引号等边缘字符
const EDGE_RE = /^[。．.！!，,、;；:：\s"'“”‘’「」『』()（）]+|[。．.！!，,、;；:：\s"'“”‘’「」『』()（）]+$/g;
const UNKNOWN_RE = /^(unknown|unknow|不知道|不确定|无法确定|无法作答|none|null|n\/a)$/i;

const JUDGE_POS = new Set(['正确', '对', '√', '✔', '✓', 't', 'true', '是', 'y', 'yes']);
const JUDGE_NEG = new Set(['错误', '错', '×', '✗', '✘', 'f', 'false', '否', 'n', 'no']);
// DECISIONS #4：只有 options[0] 含「正确/对/√/是」时，A/B 才映射为 正确/错误
const JUDGE_A_POS_RE = /正确|对|√|✔|✓|是/;

const SINGLE_RE = /^[A-Z]$/;
// P0-2②：不定项选择题可能只有 1 个正确答案，多选校验放宽为允许单字母；仍做去重 + 升序重排。
const MULTI_RE = /^[A-Z](#[A-Z])*$/;

const FILL_MAX_LEN = 100;   // 填空单空最长 100 字
const ESSAY_MAX_LEN = 400;  // 问答最长 400 字

function fail() {
  return { ok: false, code: 'invalid_output' };
}

function ok(answer, via) {
  return { ok: true, answer, via };
}

/** options 入参可为 string[] 或原始 # 拼接串；统一成 string[]（不做 normalize）。 */
function toArray(options) {
  if (Array.isArray(options)) {
    return options.map((o) => String(o == null ? '' : o).trim()).filter(Boolean);
  }
  if (typeof options === 'string') {
    const s = options.trim();
    if (!s) return [];
    return s
      .split(/#|\r?\n|;|；/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * 判断题归一。返回 '正确' | '错误' | null（null = 判失败，宁可不答）。
 * @param {string} token
 * @param {string[]|string} [options]
 */
export function normalizeJudge(token, options) {
  try {
    const raw = String(token == null ? '' : token).trim();
    if (!raw) return null;
    const low = raw.toLowerCase();
    if (JUDGE_POS.has(raw) || JUDGE_POS.has(low)) return '正确';
    if (JUDGE_NEG.has(raw) || JUDGE_NEG.has(low)) return '错误';
    if (raw === 'A' || raw === 'B') {
      const opts = toArray(options);
      if (opts.length && JUDGE_A_POS_RE.test(opts[0])) {
        return raw === 'A' ? '正确' : '错误';
      }
      return null; // DECISIONS #4：无法确定 A 对应哪一边 → 判失败
    }
    return null;
  } catch {
    return null;
  }
}

/** HANDOFF §7.4 的清洗链：trim → 剥代码块 → 循环剥前缀 → 去首尾句号引号。 */
export function cleanRaw(raw) {
  let s = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').trim();
  for (let i = 0; i < 3 && s; i += 1) {
    const before = s;
    s = s.replace(FENCE_HEAD_NL, '').replace(FENCE_HEAD_INLINE, '').replace(FENCE_TAIL, '').trim();
    if (s === before) break;
  }
  for (let i = 0; i < 3 && s; i += 1) {
    const before = s;
    s = s.replace(PREFIX_RE, '').trim();
    if (s === before) break;
  }
  for (let i = 0; i < 3 && s; i += 1) {
    const before = s;
    s = s.replace(EDGE_RE, '').trim();
    if (s === before) break;
  }
  return s;
}

function uniqSorted(letters) {
  return [...new Set(letters)].sort();
}

/** 严格校验（不含兜底提取）。返回归一后的答案字符串或 null。 */
function strictValidate(answer, type, options) {
  const s = String(answer == null ? '' : answer).trim();
  if (!s) return null;
  switch (type) {
    case '单选':
      return SINGLE_RE.test(s) ? s : null;
    case '多选': {
      if (!MULTI_RE.test(s)) return null;
      return uniqSorted(s.split('#')).join('#');
    }
    case '判断':
      return normalizeJudge(s, options);
    case '填空': {
      const parts = s.split('#').map((x) => x.trim());
      if (!parts.length) return null;
      for (const p of parts) {
        if (!p || p.length > FILL_MAX_LEN) return null;
      }
      return parts.join('#');
    }
    case '问答': {
      if (s.length > ESSAY_MAX_LEN) return null;
      if (s.includes('```')) return null;
      if (/(^|\r?\n)[ \t]*#/.test(s)) return null; // markdown 标题
      return s;
    }
    default:
      return null;
  }
}

/**
 * @param {string} answer
 * @param {'单选'|'多选'|'判断'|'填空'|'问答'} type
 * @param {string[]|string} [options]
 * @returns {boolean}
 */
export function validate(answer, type, options) {
  try {
    return strictValidate(answer, type, options) !== null;
  } catch {
    return false;
  }
}

/** 兜底：从文本里抽大写字母（HANDOFF §7.4 最后一步）。仅 单选/多选 接受。 */
function fallbackExtract(s, type) {
  const letters = s.match(/[A-Z]/g);
  if (!letters || !letters.length) return null;
  if (type === '单选') return letters[0];
  if (type === '多选') {
    const uniq = uniqSorted(letters);
    return uniq.length >= 2 ? uniq.join('#') : null;
  }
  return null; // 判断/填空/问答不接受兜底
}

function normalizeTypeAlias(type) {
  const raw = String(type == null ? '' : type).trim();
  if (!raw) return '单选'; // 保守默认：OCS 最常见的题型
  if (raw.includes('多选') || raw.includes('不定项')) return '多选';
  if (raw.includes('判断') || raw.includes('对错')) return '判断';
  if (raw.includes('填空')) return '填空';
  if (raw.includes('问答') || raw.includes('简答') || raw.includes('论述')) return '问答';
  if (raw.includes('单选')) return '单选';
  return raw;
}

/**
 * AI 原始输出后处理。
 * @param {string} raw
 * @param {{type?:string, options?:string[]|string}} [ctx]
 * @returns {{ok:true, answer:string, via:'strict'|'fallback'} | {ok:false, code:'invalid_output'}}
 */
export function postProcess(raw, ctx) {
  try {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const type = normalizeTypeAlias(c.type);
    const options = toArray(c.options);
    const s = cleanRaw(raw);
    if (!s) return fail();
    if (UNKNOWN_RE.test(s)) return fail();

    const strict = strictValidate(s, type, options);
    if (strict !== null && strict !== '') return ok(strict, 'strict');

    const fb = fallbackExtract(s, type);
    if (fb) return ok(fb, 'fallback');

    return fail();
  } catch {
    return fail();
  }
}

export default { postProcess, validate, normalizeJudge, cleanRaw };