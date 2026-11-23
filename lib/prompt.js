// lib/prompt.js — AI Prompt 构建（Owner: T2）
//
// 契约：docs/CONTRACT.md §5；模板逐字照抄 HANDOFF.md §7.3 的 [system] 段。
// 铁律：纯函数，无 I/O、无副作用、永不抛异常；日志与 prompt 之外不接触任何数据。
//
// 导出：
//   export const SYSTEM_PROMPT
//   export function buildMessages({ type, title, options }) -> [{role,content}]
//
// 说明：
// - options 为空（undefined / 空串 / 空数组 / 全空项数组）时，user 段**整行省略**「选项：」。
// - title / options 使用剥杂质后原文（不做 normalize），type 使用 toLabel() 结果。
// - D3/Patch 7（2026-11-22 用户批准）：title 原文同样先经 stripOptionJunk 剥图片占位杂质
//   （超星编辑器把 spacer.gif 等也混进题干）；其余仍不做 normalize；SYSTEM_PROMPT 一字不改。
// - D3/Patch 4（2026-11-22 用户批准）：options 原文先经 stripOptionJunk 剥离图片占位杂质
//   （spacer.gif 等），其余仍不做 normalize；SYSTEM_PROMPT 一字不改。
// - D3/Patch 5（2026-11-22 用户批准）：选项缺字母标号时按原始位置补 A./B./…（已有标号原样
//   保留，幂等），仅作用于送 AI 的 prompt 文本，不影响 key/存储/匹配；SYSTEM_PROMPT 一字不改。
//   动机：超星常传纯文字选项（无 A./B.），带填空括号的多选题会诱导 qwen-flash 抄选项文字
//   而非输出字母，被 postProcess 按契约拒收（invalid_output）→ 真实页面红号。
// - toLabel 的权威实现属于 T1 的 lib/normalize.js（已落地）。T6 裁决（P2/T2#1）：
//   固化为强制静态 import，删除并行开发期的内置回退映射（死代码会掩盖接线错误）。

import { toLabel, stripOptionJunk } from './normalize.js';

export const SYSTEM_PROMPT = `你是一个题库检索系统的答案输出模块。根据用户给出的题型、题干和选项，输出唯一正确答案。

严格遵守以下规则，违反任何一条都视为失败：
1. 只输出答案本身。不要解释、不要推理过程、不要标点包裹、不要任何前后缀。
2. 单项选择题：只输出一个大写字母，例如 A
3. 多项选择题：输出所有正确选项的大写字母，按字母升序用 # 连接，例如 A#C
4. 判断题：只输出「正确」或「错误」
5. 填空题：多个空的答案用 # 连接
6. 问答题：输出简洁的要点式答案，不超过 200 字，不使用 markdown
7. 如果题目信息不足、需要看图、或你无法确定，只输出 UNKNOWN
8. 不要复述题干，不要输出选项内容，只输出选项字母`;

function labelOf(type) {
  try {
    const v = toLabel(type);
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch {
    /* toLabel 是纯函数不应抛；兜底绝不让 buildMessages 抛错 */
  }
  return '问答题';
}

// D3/Patch 5：选项是否已带字母标号（A. / A、 / A) / A） / A: / A： / A␠ / 单字母）。
// 命中则原样保留，避免重复加标号；未命中才按原始位置补「字母.」。
const OPTION_TAGGED_RE = /^[A-H](?:[.、)）:：]|\s|$)/;

/**
 * options 可为 string（OCS 的 # 拼接串）或 string[]；返回空串表示「无选项」。
 * D3/Patch 4：每项先经 stripOptionJunk 剥图片占位杂质。
 * D3/Patch 5：缺标号的项按**原始位置**补 A./B./…（空项跳过但保留其字母槽位，
 * 使字母与页面选项位置对齐）；已有标号原样保留；幂等。仅影响 prompt 文本。
 */
function optionsText(options) {
  if (options == null) return '';
  let parts;
  if (Array.isArray(options)) {
    parts = options.map((o) => (o == null ? '' : String(o)));
  } else if (typeof options === 'string') {
    parts = options.split('#');
  } else {
    parts = String(options).split('#');
  }
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const cleaned = stripOptionJunk(parts[i]);
    if (!cleaned) continue;
    if (OPTION_TAGGED_RE.test(cleaned) || i >= 26) {
      out.push(cleaned);
    } else {
      out.push(String.fromCharCode(65 + i) + '.' + cleaned);
    }
  }
  return out.join('#');
}

/**
 * @param {{type?:string, title?:string, options?:string|string[]}} input
 * @returns {{role:'system'|'user', content:string}[]}
 */
export function buildMessages(input) {
  try {
    const src = input && typeof input === 'object' ? input : {};
    const label = labelOf(src.type);
    const title = stripOptionJunk(src.title); // D3/Patch 7：题干剥图片占位杂质（幂等、永不抛）
    const opts = optionsText(src.options);
    let user = `题型：${label}\n题干：${title}`;
    if (opts) user += `\n选项：${opts}`;
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ];
  } catch {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: '题型：单选题\n题干：' },
    ];
  }
}

export default { SYSTEM_PROMPT, buildMessages };