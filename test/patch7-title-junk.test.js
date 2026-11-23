// test/patch7-title-junk.test.js — D3/Patch 7 回归（Owner: T6，2026-11-22 用户批准）
//
// 覆盖：题干图片占位杂质清洗（镜像 Patch 4 选项口径）——
// isUnanswerable 题干先 stripOptionJunk 再判标记（纯图片题干清洗后为空，仍 fail-closed）；
// makeKey 题干预清洗（幂等、干净题干零迁移）；buildMessages 题干清洗（SYSTEM_PROMPT 一字不改）。
// server 接线（match/AI/回写/响应 question 用清洗后题干）由 e2e 4b + http 短路用例 + 隔离冒烟覆盖。
// 纪律：纯单元测试，无 I/O、无网络、无端口；题干一律占位文本，不出现真实题目或 API Key。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalize, normalizeOptions, makeKey, isUnanswerable, stripOptionJunk } from '../lib/normalize.js';
import { buildMessages, SYSTEM_PROMPT } from '../lib/prompt.js';

const T = '示例题干：某概念将哪两个属性结合在了一起';
const OPTS = '明度和色相#色相和纯度#饱和度和色相#明度和纯度';
const SPACER = 'https://mooc1.chaoxing.com/images/spacer.gif';
const JUNK = [`<img src="${SPACER}">`, ` ${SPACER}`, `![](${SPACER})`, `${SPACER}?v=1&x=2`];

test('Patch 7: 题干四种图片杂质形态 + 文字选项 → 不短路', () => {
  for (const j of JUNK) assert.equal(isUnanswerable(T + j, OPTS), false, j);
});

test('Patch 7: 纯图片题干（清洗后为空）仍 fail-closed', () => {
  for (const j of JUNK) assert.equal(isUnanswerable(j, OPTS), true, j);
  assert.equal(isUnanswerable('spacer.gif', OPTS), true);
});

test('Patch 7: 文字+图片混合题干不短路（送 AI，SYSTEM_PROMPT 规则 7 兜底）', () => {
  assert.equal(isUnanswerable(`请看下图 <img src="${SPACER}"> 选出正确答案`, OPTS), false);
});

test('Patch 7: LaTeX/成对$/过短/空题干规则不变', () => {
  assert.equal(isUnanswerable('求 $\\frac{1}{2}$ 的值', OPTS), true);
  assert.equal(isUnanswerable('成对美元符 $x$ 也算', OPTS), true);
  assert.equal(isUnanswerable('短', OPTS), true);
  assert.equal(isUnanswerable(null, OPTS), true);
  assert.equal(isUnanswerable(undefined, OPTS), true);
});

test('Patch 7: 干净题干 + 纯图片占位选项仍短路（Patch 4 不回归）', () => {
  assert.equal(isUnanswerable(T, `A.${SPACER}#B.振兴`), true);
  assert.equal(isUnanswerable(T, OPTS), false);
});

test('Patch 7: makeKey 脏题干与干净题干同 key（四形态）', () => {
  for (const j of JUNK) assert.equal(makeKey(T + j, OPTS), makeKey(T, OPTS), j);
});

test('Patch 7: makeKey 干净题干零迁移（公式与 Patch 7 前一致）', () => {
  const o = normalizeOptions(OPTS).map((x) => x.replace(/#/g, '')).sort().join('#');
  const legacy = createHash('sha256').update(`${normalize(T)}||${o}`, 'utf8').digest('hex');
  assert.equal(makeKey(T, OPTS), legacy);
});

test('Patch 7: makeKey 题干+选项双杂质 === 全干净；乱序仍一致', () => {
  const dirtyOpts = `明度和色相${SPACER}#色相和纯度#饱和度和色相#明度和纯度`;
  assert.equal(makeKey(T + JUNK[0], dirtyOpts), makeKey(T, OPTS));
  assert.equal(makeKey(T + JUNK[1], OPTS.split('#').reverse()), makeKey(T, OPTS));
});

test('Patch 7: makeKey 防御入参不抛（null/undefined/数字题干）', () => {
  assert.equal(makeKey(null, OPTS), makeKey('', OPTS));
  assert.equal(makeKey(undefined, OPTS), makeKey('', OPTS));
  assert.equal(typeof makeKey(42, OPTS), 'string');
});

test('Patch 7: normalize 本身不剥 URL（清洗是前置步）；stripOptionJunk 幂等', () => {
  assert.ok(normalize(SPACER).includes('spacer'));
  assert.equal(stripOptionJunk(stripOptionJunk(T + JUNK[0])), stripOptionJunk(T + JUNK[0]));
});

test('Patch 7: buildMessages 题干已清洗、无杂质标记、文字保留', () => {
  for (const j of JUNK) {
    const msgs = buildMessages({ type: '单选题', title: T + j, options: OPTS });
    assert.ok(!msgs[1].content.includes('spacer.gif'), j);
    assert.ok(!msgs[1].content.includes('<img'), j);
    assert.ok(!msgs[1].content.includes('!['), j);
    assert.ok(msgs[1].content.includes(`题干：${T}`), j);
  }
});

test('Patch 7: buildMessages SYSTEM_PROMPT 一字不改（规则 7 看图兜底仍在）', () => {
  const msgs = buildMessages({ type: '单选题', title: T + JUNK[0], options: OPTS });
  assert.equal(msgs[0].content, SYSTEM_PROMPT);
  assert.ok(SYSTEM_PROMPT.includes('7. 如果题目信息不足、需要看图、或你无法确定，只输出 UNKNOWN'));
});

test('Patch 7: buildMessages 混合题干保留文字剥图片；null 题干不抛', () => {
  const msgs = buildMessages({ type: '单选题', title: `请看下图 <img src="${SPACER}"> 选出正确答案`, options: OPTS });
  assert.ok(msgs[1].content.includes('请看下图'));
  assert.ok(msgs[1].content.includes('选出正确答案'));
  assert.ok(!msgs[1].content.includes('spacer.gif'));
  const empty = buildMessages({ type: '单选题', title: null, options: '' });
  assert.equal(empty[1].content, '题型：单选题\n题干：');
});

test('Patch 7: 清洗幂等后 key 稳定（二次清洗同 key）', () => {
  const once = stripOptionJunk(T + JUNK[2]);
  assert.equal(makeKey(once, OPTS), makeKey(T + JUNK[2], OPTS));
});
