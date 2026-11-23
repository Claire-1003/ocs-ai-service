// lib/normalize.js — 归一化与 key 生成（Owner: T1）
// 契约依据：docs/CONTRACT.md §1；docs/DECISIONS.md #2 #3 #4 #5；HANDOFF §5/§7.6
// 纪律：纯函数、无 I/O、无副作用、不打日志、不读 config；只 import node:crypto。

import { createHash } from 'node:crypto';

/**
 * 标点集合（CONTRACT §1.1 步骤 6）。
 * 注意：`#` 不在其中 —— normalize 必须保留 `#` 作为选项分隔符，
 * 选项内不允许的 `#` 由 normalizeOptions/makeKey 负责清除。
 */
export const PUNCT_RE = /[-_*\/\\|~@$%^&+=.,!?;:'"()<>\[\]{}，。、；：？！“”‘’（）《》【】…—·]/g;

const WS_RE = /[\s\u3000\u00a0\u200b\ufeff]+/g;

// 题号前缀（CONTRACT §1.1 步骤 3）
const NUM_PREFIX_RES = [
  /^\d{1,3}[.、)）]/,
  /^[(（]\d{1,3}[)）]/,
  /^[一二三四五六七八九十]{1,3}[、.．]/,
  /^第\s*\d{1,3}\s*题[：:.、]?/,
];

// 题型标记（CONTRACT §1.1 步骤 4）
const TYPE_MARK_RES = [
  /^[【\[(（]\s*(?:单选题?|多选题?|判断题?|填空题?|问答题?|简答题?|不定项选择题?)\s*[】\])）]/,
  /^(?:单选题|多选题|判断题|填空题|问答题|简答题)\s*[：:]/,
];

/** U+FF01..U+FF5E → 半角（减 0xFEE0）；U+3000 → 空格。NFKC 之后再显式做一遍，双保险。 */
function fullWidthToHalf(s) {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

function stripOnce(s, res) {
  for (const re of res) {
    const m = re.exec(s);
    if (m && m[0].length > 0) return s.slice(m[0].length);
  }
  return s;
}

/** 循环剥离题号与题型前缀。做两轮，兼容「【单选题】1.xxx」与「1.【单选题】xxx」两种顺序。 */
function stripPrefixes(s) {
  let out = s;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 3; i++) {
      const next = stripOnce(out, NUM_PREFIX_RES);
      if (next === out) break;
      out = next;
    }
    for (let i = 0; i < 3; i++) {
      const next = stripOnce(out, TYPE_MARK_RES);
      if (next === out) break;
      out = next;
    }
  }
  return out;
}

/**
 * 归一化管线（CONTRACT §1.1，共 7 步，顺序即 DECISIONS #2 的裁决）：
 * 1 NFKC + 全角转半角 → 2 去所有空白 → 3 去题号前缀 → 4 去题型标记
 * → 5 英文小写 → 6 去标点（保留汉字/字母/数字/`#`）→ 7 不 trim（空白已清）
 * @param {unknown} s
 * @returns {string}
 */
export function normalize(s) {
  if (s === null || s === undefined) return '';
  let out;
  try {
    out = String(s);
    out = out.normalize('NFKC');          // 步骤 1
    out = fullWidthToHalf(out);           // 步骤 1
    out = out.replace(WS_RE, '');         // 步骤 2
    out = stripPrefixes(out);             // 步骤 3 + 4
    out = out.toLowerCase();              // 步骤 5
    out = out.replace(PUNCT_RE, '');      // 步骤 6
  } catch {
    return '';                            // 防御：任何异常都归为空串，不向外抛
  }
  return out;                             // 步骤 7
}

const OPTION_TAG_RE = /[A-H][.、)）:：]/;
const OPTION_TAG_SPLIT_RE = /(?=[A-H][.、)）:：])/;

/**
 * 仅切分选项串，不归一化（CONTRACT §1.2，五级优先级，DECISIONS #5）：
 * `#` → 换行 → `;`/`；` → `A.` 标号模式（lookahead 切分，保留字母标号）→ 整体。
 * 每项 trim 并丢弃空串。入参可为 string 或 string[]。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function splitOptions(raw) {
  if (raw === null || raw === undefined) return [];
  let parts;
  try {
    if (Array.isArray(raw)) {
      parts = raw.map((x) => String(x));
    } else {
      const s = String(raw);
      if (!s.trim()) return [];
      if (s.includes('#')) parts = s.split('#');
      else if (/[\r\n]/.test(s)) parts = s.split(/[\r\n]+/);
      else if (/[;；]/.test(s)) parts = s.split(/[;；]/);
      else if (OPTION_TAG_RE.test(s)) parts = s.split(OPTION_TAG_SPLIT_RE);
      else parts = [s];
    }
  } catch {
    return [];
  }
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

// ---- D3/Patch 4（2026-11-22 用户批准）：选项图片占位杂质清洗 ----
// 超星编辑器会把图片占位 URL（如 https://mooc1.chaoxing.com/.../spacer.gif）混进选项文字：
// 不清除会污染 key 并干扰 AI 输出格式（侧边栏实测真实页面 35/42 invalid_output）。
// 保守原则：只剥图片类杂质，非图片 URL 与普通文本不动。
const MD_IMG_RE = /!\[[^\]]*\]\([^)]*\)/g;
const HTML_IMG_RE = /<img\b[^>]*>/gi;
const IMG_URL_RE = /(?:https?:)?\/\/[^\s#"'<>]+?\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s#"'<>]*)?/gi;
const SPACER_NAME_RE = /\b(?:spacer|blank|pixel|transparent|loading|dot|clear)\.(?:gif|png)\b/gi;
const CLEAN_WS_RE = /[\s\u3000\u00a0\u200b\ufeff]+/g;

/**
 * 剥离单段选项/文本中的图片占位杂质（D3/Patch 4）。纯函数、幂等、永不抛：
 * markdown 图片、<img> 标签、图片资源 URL（遇 # 截断以保护选项分隔符）、常见裸占位文件名；
 * 剥离后连续空白折叠为单空格并 trim。异常时返回原串（退化为清洗前行为）。
 * @param {unknown} s
 * @returns {string}
 */
export function stripOptionJunk(s) {
  if (s === null || s === undefined) return '';
  try {
    let out = String(s);
    out = out.replace(MD_IMG_RE, '');
    out = out.replace(HTML_IMG_RE, '');
    out = out.replace(IMG_URL_RE, '');
    out = out.replace(SPACER_NAME_RE, '');
    out = out.replace(CLEAN_WS_RE, ' ').trim();
    return out;
  } catch {
    return String(s);
  }
}

/**
 * 切分 + 每项剥图片占位杂质（D3/Patch 4）+ normalize + 去选项内 `#` + 去空项
 * （CONTRACT §1.1 末尾注意事项 / §1.3，HANDOFF §5 增补）。
 * @param {unknown} raw string 或 string[]
 * @returns {string[]}
 */
export function normalizeOptions(raw) {
  return splitOptions(raw)
    .map((o) => normalize(stripOptionJunk(o)).replace(/#/g, ''))
    .filter((o) => o !== '');
}

/**
 * 索引键（CONTRACT §1.3）：sha256( normalize(title) + '||' + 归一化选项排序后 join('#') )。
 * 选项乱序同题 → 同 key（HANDOFF §5）。
 * D3/Patch 7（2026-11-22 用户批准）：title 先经 stripOptionJunk 剥图片占位杂质再 normalize
 * （与选项同口径；幂等，干净题干零迁移）。
 * @param {unknown} title
 * @param {unknown} options string（原始 `#` 拼接串）或 string[]
 * @returns {string} 64 位 sha256 hex
 */
export function makeKey(title, options) {
  const t = normalize(stripOptionJunk(title)); // D3/Patch 7：题干预清洗
  const o = normalizeOptions(options).map((x) => x.replace(/#/g, '')).sort().join('#');
  return createHash('sha256').update(`${t}||${o}`, 'utf8').digest('hex');
}

// normalizeType 映射表（CONTRACT §1.4，顺序即匹配优先级；P0-2①：「不定项(选择题)」归多选）
const TYPE_RULES = [
  ['多选', ['多选', '不定项', 'multiple', 'multi', 'checkbox']],
  ['判断', ['判断', '对错', 'true', 'false', 'judge']],
  ['填空', ['填空', 'completion', 'fill']],
  ['问答', ['问答', '简答', '论述', 'essay', 'qa']],
  ['单选', ['单选', 'single', 'radio']],
];

// P0-2①：多个选项字母用常见分隔符拼接的答案形态（例如 A#C / A、C / AC）。
// 与 tools/import.js 原兜底正则同源；T6 裁决后此规则唯一实现在这里，import 侧只做透传。
const MULTI_LETTER_ANSWER_RE = /^[A-Ha-h](?:[\s#,，、;；|/.．)）(（]*[A-Ha-h])+$/;

const JUDGE_TOKEN_RE = /^(?:正确|错误|对|错|是|否|√|×|T|F|A|B)$/i;
// D3/Patch 6（2026-11-22 用户批准）：选项性质 override 用语义词集。
// 与 OCS core/worker/resolvers/judgement.ts 的 CORRECT/INCORRECT_WORDS 性质对齐；
// 故意排除裸 A/B，避免误伤选项文字恰为 A/B 的真单选题。
const JUDGE_OVERRIDE_RE = /^(?:正确|错误|对|错|是|否|√|×|T|F|true|false)$/i;
const BLANK_RE = /_{2,}|＿{2,}|[（(][\s\u3000]*[)）]/;
const OPTION_LEAD_RE = /^[A-H][.、)）:：]\s*/;

/**
 * 推断链（CONTRACT §1.4，T6 修订）：答案字母数>1 → 多选（规则 0，仅当 ctx.answer 由导入侧提供）
 * → 判断 → 填空 → 问答 → 单选。server 在线侧无标准答案，不传 ctx.answer，规则 0 自然不生效。
 */
function inferType(ctx) {
  const rawOptions = ctx && ctx.options !== undefined && ctx.options !== null ? ctx.options : [];
  const options = Array.isArray(rawOptions) ? rawOptions : splitOptions(rawOptions);
  const optionCount =
    ctx && Number.isInteger(ctx.optionCount) && ctx.optionCount >= 0 ? ctx.optionCount : options.length;
  const title = ctx && ctx.title !== null && ctx.title !== undefined ? String(ctx.title) : '';
  const answer = ctx && ctx.answer !== undefined && ctx.answer !== null ? String(ctx.answer).trim() : '';

  // 规则 0（P0-2①）：答案是「多字母形态」且有 >=2 个选项 → 多选（不定项可能只有 1 个正确项，不在此判）
  if (optionCount >= 2 && answer && MULTI_LETTER_ANSWER_RE.test(answer)) return '多选';

  if (optionCount === 2 && options.length === 2) {
    const stripped = options.map((o) => String(o).trim().replace(OPTION_LEAD_RE, ''));
    if (stripped.every((t) => JUDGE_TOKEN_RE.test(t))) return '判断';
  }
  if (optionCount >= 2 && BLANK_RE.test(title)) return '填空';
  if (optionCount === 0) return '问答';
  if (optionCount >= 2) return '单选';
  return '问答'; // optionCount === 1：契约未定义，保守归问答（见交付报告·契约歧义）
}

/**
 * 题型归一（CONTRACT §1.4 / DECISIONS #3）。
 * D3/Patch 6（2026-11-22 用户批准）：选项性质 override 优先于标签关键词——
 * 两选项皆判断语义词时强制「判断」，对齐 OCS 单选匹配器的 isJudgementOptions 行为。
 * @param {unknown} raw 原始 type 字符串（可空）
 * @param {{optionCount?:number, title?:string, options?:string[]|string, answer?:string}} [ctx]
 *   ctx.answer：原始答案文本（可空）。仅导入侧（tools/import.js）能提供；提供后启用推断规则 0。
 * @returns {'单选'|'多选'|'判断'|'填空'|'问答'}
 */
export function normalizeType(raw, ctx) {
  try {
    // D3/Patch 6：选项性质 override（优先于标签匹配，CONTRACT §1.4）。
    // 超星把 √/× 判断题标成【单选题】；OCS 单选匹配器见判断性质选项会改走
    // 判断匹配（只认 正确/错误/√/× 等语义词，不认字母），故此处对齐 OCS 行为。
    const c = ctx || {};
    const rawOpts = c.options !== undefined && c.options !== null ? c.options : [];
    const opts = Array.isArray(rawOpts) ? rawOpts : splitOptions(rawOpts);
    const optCount = Number.isInteger(c.optionCount) && c.optionCount >= 0 ? c.optionCount : opts.length;
    if (optCount === 2 && opts.length === 2) {
      const stripped = opts.map((o) => String(o).trim().replace(OPTION_LEAD_RE, ''));
      if (stripped.every((t) => JUDGE_OVERRIDE_RE.test(t))) return '判断';
    }
    const r = normalize(raw); // 已小写、已去标点空白
    if (r) {
      for (const [type, kws] of TYPE_RULES) {
        for (const kw of kws) {
          if (r.includes(kw)) return type;
        }
      }
    }
    return inferType(ctx || {});
  } catch {
    return '问答';
  }
}

const LABELS = { 单选: '单选题', 多选: '多选题', 判断: '判断题', 填空: '填空题', 问答: '问答题' };

// T6/P0-2①：常见别名 → 标签（toLabel 入参理论上已是规范短题型，别名表只是防御性兜底）
const TYPE_ALIASES = {
  不定项: '多选题', 不定项选择题: '多选题', 不定项选择: '多选题',
  多项: '多选题', 多项选择题: '多选题', 单项: '单选题', 单项选择题: '单选题',
};

/** 短题型 → 中文标签。未知输入保守返回「问答题」。 */
export function toLabel(type) {
  if (typeof type !== 'string') return '问答题';
  const t = type.trim();
  if (LABELS[t]) return LABELS[t];
  for (const label of Object.values(LABELS)) {
    if (t === label) return label; // 已经是标签形态，原样返回
  }
  if (TYPE_ALIASES[t]) return TYPE_ALIASES[t];
  return '问答题';
}

// isUnanswerable 特征（CONTRACT §1.5 / HANDOFF §7.6）
const IMAGE_MARKERS = ['![', '.png', '.jpg', '.jpeg', '.gif', '.webp', '<img'];
const LATEX_MARKERS = ['\\frac', '\\begin{', '\\sqrt', '\\sum'];

/**
 * 图片/公式/过短题目短路判定。基于剥图片占位杂质后（D3/Patch 7，未归一化）的 title；
 * 纯图片题干清洗后为空，仍经 normalize 长度 < 4 fail-closed；
 * D3/Patch 4（2026-11-22 用户批准）激活保留入参 options：任一选项为「纯图片占位」
 * （剥除杂质后去掉 A. 标号再 normalize 为空）→ 整题短路；「文字+杂质」混合选项不短路。
 * @param {unknown} title
 * @param {unknown} [options] string（# 拼接串）或 string[]；缺省时只看题干（旧行为）
 * @returns {boolean}
 */
export function isUnanswerable(title, options) {
  try {
    if (title === null || title === undefined) return true;
    const s = stripOptionJunk(String(title)); // D3/Patch 7：题干先剥图片占位杂质再判标记
    const lower = s.toLowerCase();
    for (const m of IMAGE_MARKERS) if (lower.includes(m)) return true;
    for (const m of LATEX_MARKERS) if (s.includes(m)) return true;
    let dollars = 0;
    for (const ch of s) {
      if (ch === '$') dollars += 1;
    }
    if (dollars >= 2) return true;
    if (normalize(s).length < 4) return true;
    // D3/Patch 4：纯图片占位选项 → 必须看图，fail-closed 短路（题干规则不变）
    if (options !== null && options !== undefined) {
      const opts = Array.isArray(options) ? options.map((x) => String(x)) : splitOptions(options);
      for (const opt of opts) {
        const cleaned = stripOptionJunk(opt);
        if (cleaned !== opt && normalize(cleaned.replace(OPTION_LEAD_RE, '')) === '') return true;
      }
    }
    return false;
  } catch {
    return true; // 无法判定时宁可不答，避免浪费 AI 调用
  }
}

export default {
  normalize,
  splitOptions,
  stripOptionJunk,
  normalizeOptions,
  makeKey,
  normalizeType,
  toLabel,
  isUnanswerable,
  PUNCT_RE,
};