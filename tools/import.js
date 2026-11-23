// tools/import.js — CSV/TSV/TXT/JSON 题库导入 CLI（Owner: T4）
// 契约依据：docs/CONTRACT.md §0 §3 §9 §10 §11；HANDOFF §5 §8.3 §11 §12.6；docs/DECISIONS.md #2 #3 #5 #13 #14
// 纪律：零第三方依赖、全程 ESM、模块顶层无 I/O 与副作用、错误一律 Error + err.code（§0 枚举）、
//       stdout 只输出 JSON 摘要，任何输出都不得出现题干/选项/答案原文（§11.5）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeKey, normalize, normalizeType, splitOptions, toLabel } from '../lib/normalize.js';

/** stdout 摘要字段（顺序固定，CONTRACT §9 / 任务规格）。 */
export const SUMMARY_KEYS = Object.freeze(['parsed', 'imported', 'skipped', 'duplicates', 'failed', 'elapsed']);

/** 记录数超过该值时落盘改用紧凑 JSON（体积/速度优先，解析结果完全一致）。 */
export const PRETTY_LIMIT = 5000;

const FORMATS = Object.freeze(['csv', 'tsv', 'txt', 'json']);
const DELIMS = Object.freeze({ csv: ',', tsv: '\t' });
const EXT_FORMAT = Object.freeze({ '.csv': 'csv', '.tsv': 'tsv', '.tab': 'tsv', '.txt': 'txt', '.json': 'json' });

export const USAGE = [
  '用法：node tools/import.js --file <路径> --format csv|tsv|txt|json [选项]',
  '选项：',
  '  --file, -f <p>     待导入文件（必填）',
  '  --format <fmt>     csv | tsv | txt | json（省略时按扩展名推断）',
  '  --merge            与目标库合并，按 key 跳过已存在条目（默认）',
  '  --replace          整库替换（旧记录全部丢弃，仍先生成 .bak）',
  '  --type <题型>      数据行缺少题型时使用的兜底题型，例如 单选题',
  '  --dry-run          只统计不写盘',
  '  --out, -o <p>      目标题库文件，默认 data/bank.json',
  '  --verified         导入条目 verified 置为 true（默认 false）',
  '  --verbose          额外诊断信息打到 stderr（只有行号与错误码，无题目原文）',
  '  --help, -h         显示本帮助',
  '退出码：0 成功 / 1 失败；stdout 输出 {parsed,imported,skipped,duplicates,failed,elapsed}',
].join('\n');

/** 内部错误：只允许 §0 枚举中的 code，导入侧统一 bad_request。 */
function badRequest(message) {
  const err = new Error(message);
  err.code = 'bad_request';
  return err;
}

/** 去 UTF-8 BOM（CONTRACT §11.7：外部输入一律防御）。 */
export function stripBom(s) {
  const str = s === null || s === undefined ? '' : String(s);
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

let tmpSeq = 0;
function tmpName(target) {
  tmpSeq = (tmpSeq + 1) % 100000;
  return target + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' + tmpSeq;
}

/** 命令行解析。任何非法输入都抛 bad_request，不抛堆栈。 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a)) : [];
  const opts = {
    file: null,
    format: null,
    mode: 'merge',
    type: null,
    out: null,
    dryRun: false,
    verbose: false,
    verified: false,
    help: false,
  };
  let sawMerge = false;
  let sawReplace = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) throw badRequest('出现无法识别的位置参数（第 ' + (i + 1) + ' 个），请用 --file 指定输入文件');
    let name = arg.replace(/^-+/, '');
    let inline = null;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const lower = name.toLowerCase();
    const take = () => {
      if (inline !== null) return inline;
      const v = args[i + 1];
      if (v === undefined) throw badRequest('参数 --' + name + ' 缺少取值');
      i += 1;
      return v;
    };
    switch (lower) {
      case 'help':
      case 'h':
        opts.help = true;
        break;
      case 'file':
      case 'f':
      case 'input':
        opts.file = take();
        break;
      case 'format':
        opts.format = take();
        break;
      case 'type':
      case 't':
        opts.type = take();
        break;
      case 'out':
      case 'o':
      case 'output':
        opts.out = take();
        break;
      case 'merge':
        sawMerge = true;
        break;
      case 'replace':
        sawReplace = true;
        break;
      case 'dry-run':
      case 'dryrun':
      case 'dry':
      case 'n':
        opts.dryRun = true;
        break;
      case 'verbose':
      case 'v':
        opts.verbose = true;
        break;
      case 'verified':
        opts.verified = true;
        break;
      default:
        throw badRequest('不支持的参数：--' + name + '（--help 查看用法）');
    }
  }
  if (sawMerge && sawReplace) throw badRequest('--merge 与 --replace 互斥，只能指定一个');
  if (sawReplace) opts.mode = 'replace';
  else if (sawMerge) opts.mode = 'merge';
  if (opts.help) return opts;
  if (!opts.file) throw badRequest('缺少 --file 参数，例如：--file ./data.csv --format csv --merge');
  if (!opts.format) opts.format = EXT_FORMAT[path.extname(opts.file).toLowerCase()] || null;
  if (!opts.format) throw badRequest('无法从扩展名推断格式，请显式指定 --format csv|tsv|txt|json');
  opts.format = String(opts.format).trim().toLowerCase();
  if (!FORMATS.includes(opts.format)) throw badRequest('不支持的格式：' + opts.format + '（仅支持 csv|tsv|txt|json）');
  if (opts.type !== null && String(opts.type).trim() === '') opts.type = null;
  if (!opts.out) opts.out = path.join('data', 'bank.json');
  opts.file = path.resolve(String(opts.file));
  opts.out = path.resolve(String(opts.out));
  return opts;
}
/* ------------------------------------------------------------------ *
 * 分隔文本解析（CSV / TSV）：手写状态机，支持双引号包裹、引号内 "" 转义、
 * 引号内含分隔符与换行、CRLF/LF 混用、BOM、空行自动忽略。
 * ------------------------------------------------------------------ */

/**
 * @param {string} text 原始文件内容
 * @param {string} delim 分隔符
 * @returns {{line:number, fields:string[]}[]} 每个元素带起始行号（用于报错，不含内容）
 */
export function parseDelimited(text, delim) {
  const s = stripBom(text);
  const d = delim && delim.length ? delim[0] : ',';
  const rows = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      continue;
    }
    if (ch === d) {
      fields.push(field);
      field = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      fields.push(field);
      if (fields.some((f) => f.trim() !== '')) rows.push({ line: rowLine, fields });
      fields = [];
      field = '';
      line += 1;
      rowLine = line;
      continue;
    }
    field += ch;
  }
  if (field !== '' || fields.length) {
    fields.push(field);
    if (fields.some((f) => f.trim() !== '')) rows.push({ line: rowLine, fields });
  }
  return rows;
}

/** 表头别名（大小写无关、忽略空白、容忍结尾中英文冒号）。 */
const HEADER_ALIASES = Object.freeze({
  question: ['question', 'title', 'q', 'stem', '题干', '题目', '试题', '问题', '内容'],
  type: ['type', 'qtype', 'questiontype', '题型', '类型', '题目类型'],
  options: ['options', 'option', 'choices', 'choice', '选项', '备选项', '候选项'],
  answer: ['answer', 'ans', 'correctanswer', 'correct', '答案', '参考答案', '正确答案', '标准答案', '本题答案'],
});

function headerKey(cell) {
  return stripBom(cell)
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000\ufeff]/g, '')
    .replace(/[:：]$/, '');
}

/** @returns {{idx:{question:number,type:number,options:number,answer:number}, unknown:string[]}} */
export function mapHeader(fields) {
  const idx = { question: -1, type: -1, options: -1, answer: -1 };
  const unknown = [];
  (Array.isArray(fields) ? fields : []).forEach((cell, i) => {
    const k = headerKey(cell);
    if (!k) return;
    let hit = null;
    for (const canon of Object.keys(HEADER_ALIASES)) {
      if (idx[canon] === -1 && HEADER_ALIASES[canon].includes(k)) {
        hit = canon;
        break;
      }
    }
    if (hit) idx[hit] = i;
    else unknown.push(k);
  });
  return { idx, unknown };
}

/**
 * options 单元格切分：竖线优先（任务规格），其余交给 lib/normalize.js 的 splitOptions
 * （`#` → 换行 → `;/；` → `A.` 标号 → 整体，DECISIONS #5）。
 */
export function splitOptionCell(raw) {
  const s = stripBom(raw).trim();
  if (!s) return [];
  if (s.includes('|')) return s.split('|').map((x) => x.trim()).filter((x) => x !== '');
  return splitOptions(s);
}

/** CSV/TSV → 候选条目。表头无法识别时抛 bad_request（只带行号）。 */
export function parseTable(text, format) {
  const delim = DELIMS[format] || ',';
  const rows = parseDelimited(text, delim);
  if (!rows.length) return { items: [], skipped: 0, unknown: [] };
  const head = mapHeader(rows[0].fields);
  if (head.idx.question === -1 || head.idx.answer === -1) {
    throw badRequest('第 ' + rows[0].line + ' 行表头无法识别：至少需要 question 与 answer 列（可选 type/options，支持中英冒号与大小写）');
  }
  const items = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (k) => {
      const i = head.idx[k];
      return i >= 0 && i < row.fields.length ? stripBom(row.fields[i]).trim() : '';
    };
    items.push({
      line: row.line,
      unit: '行',
      title: get('question'),
      typeRaw: get('type'),
      options: splitOptionCell(get('options')),
      answerRaw: get('answer'),
    });
  }
  return { items, skipped: 0, unknown: head.unknown };
}

/** JSON → 候选条目。兼容三种形态：裸数组、{records:[...]}（含 HANDOFF §8.3 导出体）、单对象。 */
export function parseJsonItems(text) {
  const s = stripBom(text).trim();
  if (!s) throw badRequest('JSON 文件为空');
  let data;
  try {
    data = JSON.parse(s);
  } catch (err) {
    const m = /at position (\d+)/.exec(String((err && err.message) || ''));
    throw badRequest('JSON 解析失败' + (m ? '（位置 ' + m[1] + '）' : '') + '，请检查文件是否为合法 JSON');
  }
  let arr;
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === 'object' && Array.isArray(data.records)) arr = data.records;
  else if (data && typeof data === 'object') arr = [data];
  else throw badRequest('JSON 顶层结构无法识别：需要数组、{records:[...]} 或单个题目对象');
  const items = arr.map((entry, i) => jsonEntryToItem(entry, i));
  return { items, skipped: 0, unknown: [] };
}

function firstStr(obj, names) {
  for (const n of names) {
    const v = obj[n];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
}

function jsonEntryToItem(entry, index) {
  const pos = index + 1;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { line: pos, unit: '条', bad: true, title: '', typeRaw: '', options: [], answerRaw: '' };
  }
  const optionsRaw = entry.options !== undefined ? entry.options : entry.choices !== undefined ? entry.choices : entry['选项'];
  const options = Array.isArray(optionsRaw)
    ? optionsRaw.map((o) => stripBom(o).trim()).filter((o) => o !== '')
    : splitOptionCell(optionsRaw);
  return {
    line: pos,
    unit: '条',
    title: firstStr(entry, ['title', 'question', 'q', '题干', '题目']).trim(),
    typeRaw: firstStr(entry, ['type', '题型', '类型']).trim(),
    options,
    answerRaw: firstStr(entry, ['answer', 'ans', '答案', '参考答案', '正确答案']).trim(),
    verified: entry.verified,
    createdAt: entry.createdAt,
    model: entry.model,
  };
}
/* ------------------------------------------------------------------ *
 * TXT 容错解析：题型关键字 + 空行切块，块内识别题干/选项/答案。
 * 解析不出的块进 skipped 计数，绝不整体失败（任务规格）。
 * ------------------------------------------------------------------ */

const TYPE_WORDS = '单选题?|多选题?|判断题?|填空题?|问答题?|简答题?|论述题?|不定项选择题?';
const TYPE_BRACKET_RE = new RegExp('^\\s*[【\\[(（]\\s*(' + TYPE_WORDS + ')\\s*[】\\])）]\\s*');
const TYPE_COLON_RE = new RegExp('^\\s*(?:' + TYPE_WORDS + ')\\s*[:：]\\s*');
const TYPE_ANYWHERE_RE = new RegExp('[【\\[(（]\\s*(' + TYPE_WORDS + ')\\s*[】\\])）]|(?:' + TYPE_WORDS + ')\\s*[:：]');
const QNUM_RE = /^\s*(?:\d{1,3}\s*[.、)）]|[(（]\s*\d{1,3}\s*[)）]|[一二三四五六七八九十]{1,3}\s*[、.．]|第\s*\d{1,3}\s*题\s*[：:.、]?)\s*/;
const OPTION_LINE_RE = /^\s*([A-H])\s*[.、)）:：]\s*(.*)$/;
const OPTION_TAG_RE = /[A-H]\s*[.、)）:：]/g;
const ANSWER_LINE_RE = /^\s*(?:答案|参考答案|正确答案|标准答案|本题答案)\s*[:：]?\s*(.*)$/;

function isNewBlockStart(line) {
  return TYPE_BRACKET_RE.test(line) || TYPE_COLON_RE.test(line) || QNUM_RE.test(line);
}

function blockHasAnswer(lines) {
  return lines.some((l) => ANSWER_LINE_RE.test(l));
}

/** 按空行切块；无空行时在「上一块已有答案 + 新题号/题型标记」处再切一刀。 */
export function splitTxtBlocks(text) {
  const s = stripBom(text).replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  const blocks = [];
  let cur = [];
  let startLine = 1;
  const flush = () => {
    if (cur.some((l) => l.trim() !== '')) blocks.push({ startLine, lines: cur });
    cur = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw.trim() === '') {
      flush();
      continue;
    }
    if (cur.length && blockHasAnswer(cur) && isNewBlockStart(raw)) flush();
    if (!cur.length) startLine = lineNo;
    cur.push(raw);
  }
  flush();
  return blocks;
}

/** 剥离行首的题号与题型标记，返回识别到的题型。 */
function stripLinePrefix(line) {
  let s = String(line).trim();
  let type = '';
  for (let i = 0; i < 4; i++) {
    const mn = QNUM_RE.exec(s);
    if (mn && mn[0].length) {
      s = s.slice(mn[0].length).trim();
      continue;
    }
    const mb = TYPE_BRACKET_RE.exec(s);
    if (mb && mb[0].length) {
      type = type || mb[1];
      s = s.slice(mb[0].length).trim();
      continue;
    }
    const mc = TYPE_COLON_RE.exec(s);
    if (mc && mc[0].length) {
      type = type || mc[1];
      s = s.slice(mc[0].length).trim();
      continue;
    }
    break;
  }
  return { type, rest: s };
}

/**
 * 解析单个块。无法解析（缺题干或缺答案）返回 null，由调用方计入 skipped。
 * @returns {null|{line:number,unit:string,title:string,typeRaw:string,options:string[],answerRaw:string}}
 */
export function parseTxtBlock(block) {
  const lines = Array.isArray(block.lines) ? block.lines : [];
  let typeRaw = '';
  const titleParts = [];
  const options = [];
  const answerParts = [];
  let mode = 'title';
  let answerPending = false;
  for (let i = 0; i < lines.length; i++) {
    let line = String(lines[i]).replace(/\s+$/, '');
    if (line.trim() === '') continue;
    if (i === 0 || (mode === 'title' && !titleParts.length)) {
      const pre = stripLinePrefix(line);
      if (pre.type && !typeRaw) typeRaw = pre.type;
      line = pre.rest;
      if (!typeRaw) {
        const m = TYPE_ANYWHERE_RE.exec(line);
        if (m && m[1]) typeRaw = m[1];
      }
      if (line.trim() === '') continue;
    }
    const ma = ANSWER_LINE_RE.exec(line);
    if (ma) {
      mode = 'answer';
      const v = ma[1].trim();
      if (v) answerParts.push(v);
      else answerPending = true;
      continue;
    }
    if (mode === 'answer' && answerPending) {
      answerParts.push(line.trim());
      answerPending = false;
      continue;
    }
    if (OPTION_LINE_RE.test(line)) {
      mode = 'options';
      const tags = line.match(OPTION_TAG_RE);
      if (tags && tags.length >= 2) {
        for (const o of splitOptions(line)) options.push(o);
      } else {
        const mo = OPTION_LINE_RE.exec(line);
        options.push(mo[1] + '.' + mo[2].trim());
      }
      continue;
    }
    if (mode === 'answer') {
      answerParts.push(line.trim());
      continue;
    }
    if (mode === 'options') {
      if (options.length) options[options.length - 1] += line.trim();
      continue;
    }
    titleParts.push(line.trim());
  }
  const title = titleParts.join('\n').trim();
  const answerRaw = answerParts.join('\n').trim();
  if (!title || !answerRaw) return null;
  return { line: block.startLine, unit: '块', title, typeRaw, options, answerRaw };
}

/** TXT → 候选条目 + skipped 计数（含无法解析块的行号，仅用于 verbose 诊断）。 */
export function parseTxt(text) {
  const blocks = splitTxtBlocks(text);
  const items = [];
  const skippedLines = [];
  for (const block of blocks) {
    const item = parseTxtBlock(block);
    if (item) items.push(item);
    else skippedLines.push(block.startLine);
  }
  return { items, skipped: skippedLines.length, skippedLines, unknown: [] };
}
/* ------------------------------------------------------------------ *
 * 答案归一（HANDOFF §4.3 硬约定）：单选 A / 多选 A#C / 判断 正确|错误 /
 * 填空 多空用 # / 问答 纯文本。只做保守转换，转不动就原样保留。
 * ------------------------------------------------------------------ */

const ANSWER_PREFIX_RE = /^(?:正确答案|参考答案|标准答案|本题答案|答案应为|答案是|正确选项是|应该选|应选|答案|选项)\s*[:：]?\s*/;
const TRIM_EDGE_RE = /^[。．.！!，,、\s"'“”‘’「」『』]+|[。．.！!，,、\s"'“”‘’「」『』]+$/g;
const JUDGE_TRUE_RE = /^(?:正确|对|√|t|true|是|y|yes|right)$/i;
const JUDGE_FALSE_RE = /^(?:错误|错|×|x|f|false|否|n|no|wrong)$/i;
const OPTION_LEAD_RE = /^[A-H]\s*[.、)）:：]\s*/;
const LETTERS_ONLY_RE = /^[A-Ha-h](?:[\s,，、;；|/#.．)）(（]*[A-Ha-h])*[\s,，、;；|/#.．)）(（]*$/;
const SHORT_TYPE_BY_LABEL = Object.freeze({ 单选题: '单选', 多选题: '多选', 判断题: '判断', 填空题: '填空', 问答题: '问答' });

function stripOptionLead(option) {
  return String(option).trim().replace(OPTION_LEAD_RE, '').trim();
}

/** 从答案文本里定位选项字母：优先整体字母串，其次按选项正文匹配。 */
function lettersOf(answer, options) {
  const s = String(answer).trim();
  if (!s) return null;
  if (LETTERS_ONLY_RE.test(s)) {
    const found = s.match(/[A-Ha-h]/g);
    if (found && found.length) return [...new Set(found.map((c) => c.toUpperCase()))].sort();
  }
  const list = Array.isArray(options) ? options : [];
  if (!list.length) return null;
  const parts = s.split(/[\s,，、;；|/#]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const part of parts) {
    const np = normalize(part);
    if (!np) return null;
    let hit = null;
    for (let i = 0; i < list.length; i++) {
      const body = normalize(stripOptionLead(list[i]));
      if (body && body === np) {
        hit = i;
        break;
      }
    }
    if (hit === null) return null;
    const letter = String.fromCharCode(65 + hit);
    if (!out.includes(letter)) out.push(letter);
  }
  return out.length ? out.sort() : null;
}

/** 判断题答案归一：DECISIONS #4 —— A/B 仅在选项能确定语义时才映射。 */
export function normalizeJudgeAnswer(answer, options) {
  const s = String(answer).trim();
  if (!s) return '';
  if (JUDGE_TRUE_RE.test(s)) return '正确';
  if (JUDGE_FALSE_RE.test(s)) return '错误';
  const list = Array.isArray(options) ? options : [];
  const up = s.toUpperCase();
  if (/^[AB]$/.test(up) && list.length >= 2) {
    const truthy = (o) => /正确|对|是|√/.test(stripOptionLead(o));
    const firstTruthy = truthy(list[0]);
    const secondTruthy = truthy(list[1]);
    if (firstTruthy && !secondTruthy) return up === 'A' ? '正确' : '错误';
    if (secondTruthy && !firstTruthy) return up === 'A' ? '错误' : '正确';
  }
  const letters = lettersOf(s, list);
  if (letters && letters.length === 1) {
    const idx = letters[0].charCodeAt(0) - 65;
    const body = stripOptionLead(list[idx] || '');
    if (JUDGE_TRUE_RE.test(body)) return '正确';
    if (JUDGE_FALSE_RE.test(body)) return '错误';
  }
  return s;
}

/**
 * 答案后处理。type 为短题型（单选/多选/判断/填空/问答）。
 * 无法归一时保留原文（导入侧宁可用原文，也不丢数据），由调用方决定是否计入可疑统计。
 */
export function normalizeAnswer(raw, type, options) {
  let s = stripBom(raw).trim();
  if (!s) return '';
  s = s.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(ANSWER_PREFIX_RE, '');
    if (next === s) break;
    s = next.trim();
  }
  s = s.replace(TRIM_EDGE_RE, '').trim();
  if (!s) return '';
  if (/^(?:unknown|不知道|无)$/i.test(s)) return '';
  switch (type) {
    case '判断':
      return normalizeJudgeAnswer(s, options);
    case '单选': {
      const letters = lettersOf(s, options);
      return letters && letters.length ? letters[0] : s;
    }
    case '多选': {
      const letters = lettersOf(s, options);
      return letters && letters.length ? letters.join('#') : s;
    }
    case '填空': {
      const parts = s.split(/[;；|]+/).map((x) => x.trim()).filter(Boolean);
      return parts.length > 1 ? parts.join('#') : s;
    }
    default:
      return s;
  }
}

/**
 * 题型判定：数据行 type 优先，其次 --type，最后交给 normalizeType 推断（CONTRACT §1.4）。
 * T6 裁决 P0-2③：「答案是多字母形态且有 >=2 个选项 → 多选」的兜底规则已收编进
 * lib/normalize.js 推断链规则 0（ctx.answer 入参），本函数只做透传，消除两窗口口径不一致。
 */
export function resolveShortType(typeRaw, cliType, title, options, answerRaw) {
  const raw = String(typeRaw || '').trim() || String(cliType || '').trim();
  const short = normalizeType(raw, {
    optionCount: Array.isArray(options) ? options.length : 0,
    title,
    options,
    answer: answerRaw,
  });
  return SHORT_TYPE_BY_LABEL[toLabel(short)] || short;
}

/**
 * 候选条目 → CONTRACT §3 Record（字段严格照 HANDOFF §8.3，不多不少，顺序一致）。
 * 校验失败抛 bad_request（消息只含原因，不含题目原文）。
 */
export function toRecord(item, opts = {}) {
  if (!item || typeof item !== 'object' || item.bad) throw badRequest('数据条目结构非法');
  const title = stripBom(item.title).replace(/\ufeff/g, '').trim();
  if (!title) throw badRequest('题干为空');
  if (!normalize(title)) throw badRequest('题干归一化后为空');
  const options = (Array.isArray(item.options) ? item.options : splitOptionCell(item.options))
    .map((o) => stripBom(o).replace(/\ufeff/g, '').trim())
    .filter((o) => o !== '');
  const shortType = resolveShortType(item.typeRaw, opts.type, title, options, item.answerRaw);
  const type = toLabel(shortType);
  const answer = normalizeAnswer(item.answerRaw, shortType, options);
  if (!answer) throw badRequest('答案为空或无法识别');
  const record = {
    key: makeKey(title, options),
    title,
    options,
    answer,
    type,
    source: 'import',
  };
  if (typeof item.model === 'string' && item.model.trim()) record.model = item.model.trim();
  record.verified = opts.verified === true ? true : typeof item.verified === 'boolean' ? item.verified : false;
  record.createdAt = Number.isFinite(item.createdAt) && item.createdAt > 0 ? Math.trunc(item.createdAt) : Date.now();
  return record;
}
/* ------------------------------------------------------------------ *
 * 题库文件读写：顶层结构 {version,updatedAt,records}，兼容裸数组（DECISIONS #13）；
 * 写盘策略与 lib/store.js 一致：先 .bak，再临时文件 + rename 原子替换（DECISIONS #14）。
 * ------------------------------------------------------------------ */

/** import 从不做匹配，给 Store 注入一个惰性 matcher，避免为一次性导入重建 trigram 索引。 */
const INERT_MATCHER = Object.freeze({
  build() {},
  add() {},
  remove() {},
  get size() {
    return 0;
  },
  lookupExact() {
    return undefined;
  },
  lookup() {
    return null;
  },
});

/** 只允许错误码/scope 落地，绝不透传内容（CONTRACT §11.5）。 */
function makeLog(sink) {
  return {
    moderation(_key, code, provider) {
      sink('[qbank][import][moderation] ' + String(code || '') + ' ' + String(provider || '') + '\n');
    },
    error(scope, errCode) {
      sink('[qbank][import][' + String(errCode || 'ai_error') + '] scope=' + String(scope || '') + '\n');
    },
    info(scope, obj) {
      const counts = obj && typeof obj === 'object' ? Object.keys(obj).filter((k) => typeof obj[k] === 'number').map((k) => k + '=' + obj[k]).join(' ') : '';
      sink('[qbank][import][info] scope=' + String(scope || '') + (counts ? ' ' + counts : '') + '\n');
    },
  };
}

/** 直接读文件（Store 不可用时的回落路径）。损坏按空库处理 + 一条 stderr 警告（CONTRACT §3）。 */
export function readBankFile(bankPath, warn) {
  let text;
  try {
    text = fs.readFileSync(bankPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { records: [], existed: false, via: 'missing' };
    if (warn) warn('[qbank][import][bad_request] 题库读取失败，按空库处理：' + bankPath + '（' + (err && err.code) + '）\n');
    return { records: [], existed: false, via: 'unreadable' };
  }
  const body = stripBom(text).trim();
  if (!body) return { records: [], existed: true, via: 'empty' };
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    if (warn) warn('[qbank][import][bad_request] 题库 JSON 损坏，按空库处理（原文件已备份为 .bak）：' + bankPath + '\n');
    return { records: [], existed: true, via: 'corrupt' };
  }
  const arr = Array.isArray(data) ? data : data && Array.isArray(data.records) ? data.records : [];
  const records = arr.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  return { records, existed: true, via: 'file' };
}

/**
 * 按 CONTRACT §3 的签名尝试接入 lib/store.js（T3）读取现有题库。
 * store.js 尚未就绪或构造失败时静默回落到 readBankFile，绝不代写别人的文件。
 */
async function createStore(bankPath, bakPath, hooks, warn) {
  try {
    if (typeof hooks.storeFactory === 'function') return await hooks.storeFactory({ bankPath, bakPath });
    const mod = await import('../lib/store.js');
    const Store = mod && (mod.Store || (typeof mod.default === 'function' ? mod.default : null));
    if (typeof Store !== 'function') return null;
    let config = {};
    try {
      const cfgMod = await import('../config.js');
      config = cfgMod.loadConfig({ cwd: process.cwd(), env: process.env });
    } catch {
      config = {};
    }
    return new Store({ bankPath, bakPath, config, matcher: INERT_MATCHER, log: makeLog(warn) });
  } catch {
    return null;
  }
}

async function loadExisting(bankPath, hooks, warn) {
  const bakPath = bankPath + '.bak';
  const store = await createStore(bankPath, bakPath, hooks, warn);
  if (store && typeof store.load === 'function') {
    try {
      await store.load();
      const recs = typeof store.records === 'function' ? store.records() : null;
      if (Array.isArray(recs)) {
        if (typeof store.close === 'function') await store.close();
        return { records: recs.slice(), existed: true, via: 'store' };
      }
    } catch (err) {
      if (warn) warn('[qbank][import][bad_request] store.load 失败，改用直接读文件（' + ((err && err.code) || 'error') + '）\n');
    }
  }
  return readBankFile(bankPath, warn);
}

/** 原子写盘：copy → .bak，写 tmp，rename 覆盖。 */
export function writeBankAtomic(bankPath, bakPath, records) {
  const dir = path.dirname(bankPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw badRequest('无法创建目录：' + dir + '（' + (err && err.code) + '）');
  }
  let existed = false;
  try {
    existed = fs.statSync(bankPath).isFile();
  } catch {
    existed = false;
  }
  if (existed) {
    try {
      fs.copyFileSync(bankPath, bakPath);
    } catch (err) {
      throw badRequest('备份失败：' + bakPath + '（' + (err && err.code) + '）');
    }
  }
  const payload = { version: 1, updatedAt: Date.now(), records };
  const json = (records.length > PRETTY_LIMIT ? JSON.stringify(payload) : JSON.stringify(payload, null, 2)) + '\n';
  const tmp = tmpName(bankPath);
  try {
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, bankPath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 忽略清理失败 */
    }
    throw badRequest('写入失败：' + bankPath + '（' + (err && err.code) + '）');
  }
  return { bytes: Buffer.byteLength(json, 'utf8'), backup: existed };
}

function parseByFormat(text, format) {
  if (format === 'csv' || format === 'tsv') return parseTable(text, format);
  if (format === 'json') return parseJsonItems(text);
  if (format === 'txt') return parseTxt(text);
  throw badRequest('不支持的格式：' + format);
}

function emptySummary() {
  return { parsed: 0, imported: 0, skipped: 0, duplicates: 0, failed: 0, elapsed: 0 };
}

/**
 * 执行导入。永不抛异常：失败以 {exitCode:1,error:{code,message}} 返回。
 * @param {object} opts parseArgs 的产物（或测试直接构造）
 * @param {{stdout?:Function,stderr?:Function,storeFactory?:Function}} [hooks]
 */
export async function runImport(opts, hooks = {}) {
  const started = Date.now();
  const summary = emptySummary();
  const stderr = typeof hooks.stderr === 'function' ? hooks.stderr : (s) => process.stderr.write(s);
  const finish = (exitCode, error) => {
    summary.elapsed = Date.now() - started;
    const out = {};
    for (const k of SUMMARY_KEYS) out[k] = summary[k];
    return error ? { summary: out, exitCode, error } : { summary: out, exitCode };
  };
  try {
    if (!opts || typeof opts !== 'object') throw badRequest('缺少参数');
    if (!opts.file) throw badRequest('缺少 --file 参数');
    const format = String(opts.format || '').toLowerCase();
    if (!FORMATS.includes(format)) throw badRequest('不支持的格式：' + (format || '(空)'));
    const inFile = path.resolve(String(opts.file));
    const outPath = path.resolve(String(opts.out || path.join('data', 'bank.json')));
    const bakPath = outPath + '.bak';
    const mode = opts.mode === 'replace' ? 'replace' : 'merge';
    let text;
    try {
      text = fs.readFileSync(inFile, 'utf8');
    } catch (err) {
      throw badRequest('文件读取失败：' + inFile + '（' + ((err && err.code) || 'io_error') + '）');
    }
    const parsed = parseByFormat(text, format);
    summary.parsed = parsed.items.length;
    summary.skipped = parsed.skipped || 0;
    if (opts.verbose) {
      stderr('[qbank][import][info] format=' + format + ' mode=' + mode + ' parsed=' + summary.parsed + ' skipped=' + summary.skipped + '\n');
      if (parsed.unknown && parsed.unknown.length) stderr('[qbank][import][info] 未识别表头列数=' + parsed.unknown.length + '\n');
      if (parsed.skippedLines && parsed.skippedLines.length) {
        stderr('[qbank][import][info] 无法解析的块行号=' + parsed.skippedLines.join(',') + '\n');
      }
    }
    const batch = new Map();
    let suspectAnswer = 0;
    for (const item of parsed.items) {
      let record;
      try {
        record = toRecord(item, opts);
      } catch (err) {
        summary.failed += 1;
        if (opts.verbose) stderr('[qbank][import][bad_request] 第 ' + item.line + ' ' + (item.unit || '行') + ' 丢弃\n');
        continue;
      }
      const short = SHORT_TYPE_BY_LABEL[record.type];
      if ((short === '单选' || short === '多选') && !/^[A-H](#[A-H])*$/.test(record.answer)) suspectAnswer += 1;
      if (batch.has(record.key)) {
        summary.duplicates += 1;
        if (opts.verbose) stderr('[qbank][import][info] 批内重复 key=' + record.key.slice(0, 12) + ' 第 ' + item.line + ' ' + (item.unit || '行') + '\n');
        continue;
      }
      batch.set(record.key, record);
    }
    let existing = { records: [], existed: false, via: 'missing' };
    if (mode === 'merge') existing = await loadExisting(outPath, hooks, stderr);
    const existingKeys = new Set();
    for (const r of existing.records) if (r && typeof r.key === 'string') existingKeys.add(r.key);
    const toAdd = [];
    for (const record of batch.values()) {
      if (existingKeys.has(record.key)) {
        summary.duplicates += 1;
        continue;
      }
      existingKeys.add(record.key);
      toAdd.push(record);
    }
    summary.imported = toAdd.length;
    if (opts.verbose && suspectAnswer) stderr('[qbank][import][info] 选择题答案非字母形态条数=' + suspectAnswer + '\n');
    if (!opts.dryRun) {
      const shouldWrite = mode === 'replace' || toAdd.length > 0;
      if (shouldWrite) {
        const records = mode === 'replace' ? toAdd : existing.records.concat(toAdd);
        const res = writeBankAtomic(outPath, bakPath, records);
        if (opts.verbose) stderr('[qbank][import][info] 落盘 total=' + records.length + ' bytes=' + res.bytes + ' backup=' + (res.backup ? 1 : 0) + '\n');
      } else if (opts.verbose) {
        stderr('[qbank][import][info] 无新增条目，目标文件未改动\n');
      }
    }
    return finish(0);
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'bad_request';
    const message = err && typeof err.message === 'string' ? err.message : '导入失败';
    if (opts && opts.verbose && err && err.stack) stderr(String(err.stack) + '\n');
    return finish(1, { code, message });
  }
}

/** CLI 入口。stdout 只打 JSON 摘要；错误打 stderr 中文一行，不打堆栈（--verbose 才打）。 */
export async function main(argv, io = {}) {
  const stdout = typeof io.stdout === 'function' ? io.stdout : (s) => process.stdout.write(s);
  const stderr = typeof io.stderr === 'function' ? io.stderr : (s) => process.stderr.write(s);
  const exit = typeof io.exit === 'function' ? io.exit : (c) => process.exit(c);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr('[qbank][import][' + ((err && err.code) || 'bad_request') + '] ' + ((err && err.message) || '参数非法') + '\n');
    stdout(JSON.stringify(emptySummary()) + '\n');
    await exit(1);
    return 1;
  }
  if (opts.help) {
    stdout(USAGE + '\n');
    await exit(0);
    return 0;
  }
  const res = await runImport(opts, { stdout, stderr, storeFactory: io.storeFactory });
  if (res.exitCode !== 0 && res.error) {
    stderr('[qbank][import][' + res.error.code + '] ' + res.error.message + '\n');
  }
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
    process.stderr.write('[qbank][import][' + ((err && err.code) || 'ai_error') + '] 未预期错误\n');
    process.exit(1);
  });
}

export default { parseArgs, runImport, main, toRecord, parseDelimited, parseTable, parseTxt, parseJsonItems };