// test/patch5-option-letter.test.js — D3/Patch 5 回归（Owner: T6，2026-11-22 用户批准）
//
// 覆盖：送 AI 的选项缺字母标号时按原始位置补 A./B./…（已有标号原样保留、幂等、
// 空项保留字母槽位）；SYSTEM_PROMPT 一字不改；空选项仍整行省略。
// 动机：超星纯文字选项诱导 qwen-flash 抄文字而非字母 → postProcess 拒收 → 红号。
// 纪律：纯单元测试，无 I/O、无网络、无端口；题干一律占位文本，不出现真实题目或 API Key。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, SYSTEM_PROMPT } from '../lib/prompt.js';

const TITLE = '示例题干：某概念是指（ ）与（ ）';
const optsLine = (msgs) => msgs[1].content.split('\n').find((l) => l.startsWith('选项：')) || '';

test('Patch 5: 纯文字数组选项按序补 A./B./C./D.', () => {
  const msgs = buildMessages({ type: '多选', title: TITLE, options: ['感觉', '知觉', '认识', '理解'] });
  assert.equal(optsLine(msgs), '选项：A.感觉#B.知觉#C.认识#D.理解');
});

test('Patch 5: 纯文字 # 拼接串同样补标号', () => {
  const msgs = buildMessages({ type: '多选', title: TITLE, options: '感觉#知觉#认识#理解' });
  assert.equal(optsLine(msgs), '选项：A.感觉#B.知觉#C.认识#D.理解');
});

test('Patch 5: 已带标号原样保留（数组与字符串），幂等', () => {
  const arr = buildMessages({ type: '多选', title: TITLE, options: ['A.感觉', 'B.知觉'] });
  assert.equal(optsLine(arr), '选项：A.感觉#B.知觉');
  const str = buildMessages({ type: '单选', title: 'T', options: 'A.富强#B.振兴' });
  assert.equal(optsLine(str), '选项：A.富强#B.振兴');
  // 对已补标号的输出再跑一次，结果不变
  const again = buildMessages({ type: '多选', title: TITLE, options: ['A.感觉', 'B.知觉', 'C.认识', 'D.理解'] });
  assert.equal(optsLine(again), '选项：A.感觉#B.知觉#C.认识#D.理解');
});

test('Patch 5: 多种标号分隔符均识别为已带标号，不重复加', () => {
  for (const tag of ['A.', 'A、', 'A)', 'A）', 'A:', 'A：', 'A ']) {
    const msgs = buildMessages({ type: '单选', title: 'T', options: [tag + '富强', 'B.振兴'] });
    assert.equal(optsLine(msgs), '选项：' + tag + '富强#B.振兴', 'tag=' + JSON.stringify(tag));
  }
});

test('Patch 5: 混合（部分带标号）保留已有、按位置补缺', () => {
  const msgs = buildMessages({ type: '多选', title: TITLE, options: ['感觉', 'B.知觉', '认识'] });
  assert.equal(optsLine(msgs), '选项：A.感觉#B.知觉#C.认识');
});

test('Patch 5: 空项跳过但保留字母槽位（与页面位置对齐）', () => {
  const msgs = buildMessages({ type: '多选', title: TITLE, options: ['手', '', '脑', '嘴'] });
  assert.equal(optsLine(msgs), '选项：A.手#C.脑#D.嘴');
});

test('Patch 5: 判断题纯文字选项补标号（A.正确#B.错误）', () => {
  const msgs = buildMessages({ type: '判断', title: 'T', options: ['正确', '错误'] });
  assert.equal(optsLine(msgs), '选项：A.正确#B.错误');
});

test('Patch 5: 单个纯文字选项补 A.', () => {
  const msgs = buildMessages({ type: '单选', title: 'T', options: ['唯一选项'] });
  assert.equal(optsLine(msgs), '选项：A.唯一选项');
});

test('Patch 5: 先清洗图片占位再补标号（与 Patch 4 叠加）', () => {
  const SPACER = 'https://mooc1.chaoxing.com/images/spacer.gif';
  const msgs = buildMessages({ type: '多选', title: TITLE, options: ['感觉' + SPACER, '知觉', '理解'] });
  assert.equal(optsLine(msgs), '选项：A.感觉#B.知觉#C.理解');
  assert.ok(!msgs[1].content.includes('spacer.gif'));
});

test('Patch 5: 空选项仍整行省略「选项：」（填空/问答不受影响）', () => {
  for (const options of [[], '', undefined, null, ['  ', '']]) {
    const msgs = buildMessages({ type: '填空', title: '___ 是第一生产力', options });
    assert.ok(!msgs[1].content.includes('选项：'), 'options=' + JSON.stringify(options));
    assert.equal(msgs[1].content.split('\n').length, 2);
  }
});

test('Patch 5: SYSTEM_PROMPT 一字不改（防回归）', () => {
  const msgs = buildMessages({ type: '多选', title: TITLE, options: ['感觉', '知觉'] });
  assert.equal(msgs[0].content, SYSTEM_PROMPT);
  assert.ok(SYSTEM_PROMPT.includes('8. 不要复述题干，不要输出选项内容，只输出选项字母'));
  assert.equal(SYSTEM_PROMPT.split('\n').length, 11);
});

test('Patch 5: 超过 26 项时不再补标号（防御，避免越界字母）', () => {
  const many = Array.from({ length: 28 }, (_, i) => '选项' + i);
  const msgs = buildMessages({ type: '多选', title: TITLE, options: many });
  const line = optsLine(msgs);
  assert.ok(line.startsWith('选项：A.选项0#B.选项1#'));
  assert.ok(line.includes('#Z.选项25#'));
  assert.ok(line.endsWith('#选项26#选项27'));
});
