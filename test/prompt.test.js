// test/prompt.test.js — lib/prompt.js（Owner: T2）
// 纯函数测试：无网络、无端口、无文件 I/O。

import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT, buildMessages } from '../lib/prompt.js';

// HANDOFF §7.3 [system] 段逐字副本（用于防回归）
const EXPECTED_SYSTEM = [
  '你是一个题库检索系统的答案输出模块。根据用户给出的题型、题干和选项，输出唯一正确答案。',
  '',
  '严格遵守以下规则，违反任何一条都视为失败：',
  '1. 只输出答案本身。不要解释、不要推理过程、不要标点包裹、不要任何前后缀。',
  '2. 单项选择题：只输出一个大写字母，例如 A',
  '3. 多项选择题：输出所有正确选项的大写字母，按字母升序用 # 连接，例如 A#C',
  '4. 判断题：只输出「正确」或「错误」',
  '5. 填空题：多个空的答案用 # 连接',
  '6. 问答题：输出简洁的要点式答案，不超过 200 字，不使用 markdown',
  '7. 如果题目信息不足、需要看图、或你无法确定，只输出 UNKNOWN',
  '8. 不要复述题干，不要输出选项内容，只输出选项字母',
].join('\n');

test('SYSTEM_PROMPT 与 HANDOFF §7.3 逐字一致', () => {
  assert.equal(typeof SYSTEM_PROMPT, 'string');
  assert.equal(SYSTEM_PROMPT, EXPECTED_SYSTEM);
  assert.equal(SYSTEM_PROMPT.split('\n').length, 11);
  assert.ok(!SYSTEM_PROMPT.includes('{type}'));
  assert.ok(!SYSTEM_PROMPT.includes('{title}'));
});

test('buildMessages 返回 system + user 两段，system 段等于 SYSTEM_PROMPT', () => {
  const msgs = buildMessages({ type: '单选', title: '1+1=?', options: ['A.1', 'B.2'] });
  assert.ok(Array.isArray(msgs));
  assert.equal(msgs.length, 2);
  assert.deepEqual(Object.keys(msgs[0]).sort(), ['content', 'role']);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, SYSTEM_PROMPT);
  assert.equal(msgs[1].role, 'user');
});

test('user 段格式：题型用中文 label，题干与选项用原文', () => {
  const title = '中国梦的本质内涵是什么？（多选）  ';
  const options = ['A.国家富强', 'B.民族振兴', 'C.人民幸福'];
  const msgs = buildMessages({ type: '多选', title, options });
  assert.equal(
    msgs[1].content,
    '题型：多选题\n题干：中国梦的本质内涵是什么？（多选）\n选项：A.国家富强#B.民族振兴#C.人民幸福',
  );
  // 原文保留：全角问号、括号、汉字都不被 normalize
  assert.ok(msgs[1].content.includes('？（多选）'));
});

test('options 为空数组 / 空串 / undefined / 全空项 → 整行省略「选项：」', () => {
  for (const options of [[], '', undefined, null, ['  ', '']]) {
    const msgs = buildMessages({ type: '填空', title: '___ 是第一生产力', options });
    const lines = msgs[1].content.split('\n');
    assert.equal(lines.length, 2, `options=${JSON.stringify(options)} 应只有 2 行`);
    assert.equal(lines[0], '题型：填空题');
    assert.equal(lines[1], '题干：___ 是第一生产力');
    assert.ok(!msgs[1].content.includes('选项：'));
  }
});

test('options 为 # 拼接串时原样透传', () => {
  const msgs = buildMessages({ type: '单选', title: 'T', options: 'A.富强#B.振兴' });
  assert.equal(msgs[1].content, '题型：单选题\n题干：T\n选项：A.富强#B.振兴');
});

test('题型 label 映射覆盖五种题型 + 兼容「xx题」输入', () => {
  // 契约里 buildMessages 收到的 type 已是 normalizeType() 的规范值（CONTRACT §1.4 值域）
  const cases = [
    ['单选', '单选题'], ['单选题', '单选题'],
    ['多选', '多选题'], ['多选题', '多选题'],
    ['判断', '判断题'], ['判断题', '判断题'],
    ['填空', '填空题'], ['填空题', '填空题'],
    ['问答', '问答题'], ['问答题', '问答题'],
  ];
  for (const [input, label] of cases) {
    const msgs = buildMessages({ type: input, title: 'x', options: [] });
    assert.equal(msgs[1].content.split('\n')[0], `题型：${label}`, `type=${input}`);
  }
});

test('异常入参不抛：undefined / 字符串 / 缺字段', () => {
  for (const bad of [undefined, null, 'str', 42, {}, { title: null, options: 0 }]) {
    let msgs;
    assert.doesNotThrow(() => { msgs = buildMessages(bad); });
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, SYSTEM_PROMPT);
    assert.ok(msgs[1].content.startsWith('题型：'));
    assert.ok(msgs[1].content.includes('\n题干：'));
  }
});