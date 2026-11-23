// test/patch6-judge-override.test.js — D3/Patch 6 回归（Owner: T6，2026-11-22 用户批准）
//
// 覆盖：normalizeType 选项性质 override —— 恰好两选项且剥 A. 前缀后皆判断语义词
// （√/×/正确/错误/对/错/是/否/T/F/true/false，大小写不敏感、排除裸 A/B）→ 强制「判断」，
// 优先于题型标签（超星把 √/× 判断题标成【单选题】）。
// 联动：postProcess 判断分支输出 正确/错误（A/B 经 options[0] 映射）；buildMessages 题型行=判断题。
// 动机：OCS 单选匹配器对判断性质选项改走判断匹配（isJudgementOptions→resolveJudgement，
// 见 ocsjs core/worker/resolvers），只认 正确/错误/√/× 等语义词不认字母；存字母必 mismatch。
// 纪律：纯单元测试，无 I/O、无网络、无端口；题干一律占位文本，不出现真实题目或 API Key。

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeType } from '../lib/normalize.js';
import { postProcess } from '../lib/answer.js';
import { buildMessages, SYSTEM_PROMPT } from '../lib/prompt.js';

const T = '示例题干：某说法是否成立';
const ctx = (options) => ({ title: T, options, optionCount: Array.isArray(options) ? options.length : undefined });

test('Patch 6: 单选题标签 + √/×（两种顺序）→ 判断', () => {
  assert.equal(normalizeType('单选题', ctx(['√', '×'])), '判断');
  assert.equal(normalizeType('单选题', ctx(['×', '√'])), '判断');
});

test('Patch 6: 单选题标签 + 正确/错误、对/错、是/否 → 判断', () => {
  assert.equal(normalizeType('单选题', ctx(['正确', '错误'])), '判断');
  assert.equal(normalizeType('单选题', ctx(['对', '错'])), '判断');
  assert.equal(normalizeType('单选题', ctx(['是', '否'])), '判断');
});

test('Patch 6: 单选题标签 + T/F、true/false（含大小写变体）→ 判断', () => {
  assert.equal(normalizeType('单选题', ctx(['T', 'F'])), '判断');
  assert.equal(normalizeType('单选题', ctx(['true', 'false'])), '判断');
  assert.equal(normalizeType('单选题', ctx(['True', 'False'])), '判断');
});

test('Patch 6: 带 A./A、前缀的判断选项剥前缀后命中 override', () => {
  assert.equal(normalizeType('单选题', ctx(['A.√', 'B.×'])), '判断');
  assert.equal(normalizeType('单选题', ctx(['A、正确', 'B、错误'])), '判断');
});

test('Patch 6: # 拼接串选项同样命中 override', () => {
  assert.equal(normalizeType('单选题', { title: T, options: '√#×' }), '判断');
});

test('Patch 6: override 优先于任何标签（多选标签也覆盖）', () => {
  assert.equal(normalizeType('多选题', ctx(['√', '×'])), '判断');
  assert.equal(normalizeType('判断题', ctx(['√', '×'])), '判断');
});

test('Patch 6: 无标签路径行为不变（推断链仍判判断）', () => {
  assert.equal(normalizeType('', ctx(['√', '×'])), '判断');
  assert.equal(normalizeType(undefined, ctx(['√', '×'])), '判断');
});

test('Patch 6: 裸 A/B 选项不触发 override（真单选防误伤）', () => {
  assert.equal(normalizeType('单选题', ctx(['A', 'B'])), '单选');
});

test('Patch 6: 普通两选项单选不受影响', () => {
  assert.equal(normalizeType('单选题', ctx(['感觉', '理解'])), '单选');
  assert.equal(normalizeType('单选题', { title: T, options: [] }), '单选');
});

test('Patch 6: 三选项含 √/× 不触发 override', () => {
  assert.equal(normalizeType('单选题', ctx(['√', '×', '其他'])), '单选');
});

test('Patch 6: optionCount 与 options.length 双条件（不一致不覆盖）', () => {
  assert.equal(normalizeType('单选题', { title: T, options: ['√', '×', '其他'], optionCount: 2 }), '单选');
});

test('Patch 6: 单选项不触发 override（标签优先）', () => {
  assert.equal(normalizeType('单选题', ctx(['√'])), '单选');
});

test('Patch 6: postProcess 判断分支 —— 正确/错误 直通，A/B 经 √/× 映射', () => {
  assert.deepEqual(postProcess('正确', { type: '判断', options: ['√', '×'] }), { ok: true, answer: '正确', via: 'strict' });
  assert.deepEqual(postProcess('错误', { type: '判断', options: ['√', '×'] }), { ok: true, answer: '错误', via: 'strict' });
  assert.deepEqual(postProcess('A', { type: '判断', options: ['√', '×'] }), { ok: true, answer: '正确', via: 'strict' });
  assert.deepEqual(postProcess('B', { type: '判断', options: ['√', '×'] }), { ok: true, answer: '错误', via: 'strict' });
});

test('Patch 6: 单选校验链不变（正确/错误 仍被单选拒收，修复点在类型侧）', () => {
  assert.equal(postProcess('正确', { type: '单选', options: ['√', '×'] }).ok, false);
});

test('Patch 6: buildMessages 判断题型行 + SYSTEM_PROMPT 判断规则防回归', () => {
  const msgs = buildMessages({ type: '判断', title: T, options: ['√', '×'] });
  assert.ok(msgs[1].content.startsWith('题型：判断题'));
  assert.ok(SYSTEM_PROMPT.includes('判断题：只输出「正确」或「错误」'));
});

test('Patch 6: 管线联动 —— 单选标签+√/× 经 override 后 A 输出归一为 正确', () => {
  const type = normalizeType('单选题', ctx(['√', '×']));
  const out = postProcess('A', { type, options: ['√', '×'] });
  assert.equal(type, '判断');
  assert.deepEqual(out, { ok: true, answer: '正确', via: 'strict' });
});
