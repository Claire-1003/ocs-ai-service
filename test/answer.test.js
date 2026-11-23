// test/answer.test.js — lib/answer.js（Owner: T2）
// 纯函数测试：无网络、无端口、无文件 I/O、无 sleep。

import test from 'node:test';
import assert from 'node:assert/strict';
import { postProcess, validate, normalizeJudge, cleanRaw } from '../lib/answer.js';

const FENCE = '`'.repeat(3);

test('HANDOFF §7.4 / 任务书列出的关键用例', () => {
  const cases = [
    // [raw, ctx, expected]
    [`${FENCE}A${FENCE}`, { type: '单选' }, { ok: true, answer: 'A', via: 'strict' }],
    [`${FENCE}\nA\n${FENCE}`, { type: '单选' }, { ok: true, answer: 'A', via: 'strict' }],
    [`${FENCE}json\nA#C\n${FENCE}`, { type: '多选' }, { ok: true, answer: 'A#C', via: 'strict' }],
    ['答案：B', { type: '单选' }, { ok: true, answer: 'B', via: 'strict' }],
    ['正确答案是 A#C', { type: '多选' }, { ok: true, answer: 'A#C', via: 'strict' }],
    ['应选：AC', { type: '多选' }, { ok: true, answer: 'A#C', via: 'fallback' }], // 升序重排
    ['C#A', { type: '多选' }, { ok: true, answer: 'A#C', via: 'strict' }],        // 升序重排
    ['A#C#A#B', { type: '多选' }, { ok: true, answer: 'A#B#C', via: 'strict' }],   // 去重 + 升序
    ['UNKNOWN', { type: '单选' }, { ok: false, code: 'invalid_output' }],
    ['unknown', { type: '多选' }, { ok: false, code: 'invalid_output' }],
    ['不知道', { type: '判断' }, { ok: false, code: 'invalid_output' }],
    ['', { type: '单选' }, { ok: false, code: 'invalid_output' }],
    ['   \n\t ', { type: '单选' }, { ok: false, code: 'invalid_output' }],
    [null, { type: '单选' }, { ok: false, code: 'invalid_output' }],
    [undefined, { type: '单选' }, { ok: false, code: 'invalid_output' }],
    ['对', { type: '判断' }, { ok: true, answer: '正确', via: 'strict' }],
    ['错误', { type: '判断' }, { ok: true, answer: '错误', via: 'strict' }],
    ['A', { type: '判断' }, { ok: false, code: 'invalid_output' }], // 无 options → 判失败（DECISIONS #4）
    ['A', { type: '判断', options: ['A.正确', 'B.错误'] }, { ok: true, answer: '正确', via: 'strict' }],
    ['B', { type: '判断', options: ['A.正确', 'B.错误'] }, { ok: true, answer: '错误', via: 'strict' }],
    ['A', { type: '判断', options: ['A.错误', 'B.正确'] }, { ok: false, code: 'invalid_output' }],
    ['答案是A。', { type: '单选' }, { ok: true, answer: 'A', via: 'strict' }],
    ['  “正确”  ', { type: '判断' }, { ok: true, answer: '正确', via: 'strict' }],
    ['参考选项：D', { type: '单选' }, { ok: true, answer: 'D', via: 'fallback' }],
  ];
  for (const [raw, ctx, expected] of cases) {
    const got = postProcess(raw, ctx);
    assert.deepEqual(got, expected, `raw=${JSON.stringify(String(raw).slice(0, 20))} ctx=${JSON.stringify(ctx)}`);
  }
});

test('问答题：超长 / markdown / 含 ``` 判失败，正常要点通过', () => {
  assert.deepEqual(postProcess('x'.repeat(400), { type: '问答' }), { ok: true, answer: 'x'.repeat(400), via: 'strict' });
  assert.deepEqual(postProcess('x'.repeat(401), { type: '问答' }), { ok: false, code: 'invalid_output' });
  assert.deepEqual(postProcess('# 标题\n内容', { type: '问答' }), { ok: false, code: 'invalid_output' });
  assert.deepEqual(postProcess(`答案 ${FENCE}js${FENCE}`, { type: '问答' }), { ok: false, code: 'invalid_output' });
  assert.deepEqual(postProcess('坚持党的领导、人民当家作主、依法治国有机统一', { type: '问答' }),
    { ok: true, answer: '坚持党的领导、人民当家作主、依法治国有机统一', via: 'strict' });
});

test('填空题：# 分空、空段或超长判失败', () => {
  assert.deepEqual(postProcess('北京#上海', { type: '填空' }), { ok: true, answer: '北京#上海', via: 'strict' });
  assert.deepEqual(postProcess('只有一个空', { type: '填空' }), { ok: true, answer: '只有一个空', via: 'strict' });
  assert.deepEqual(postProcess('北京##上海', { type: '填空' }), { ok: false, code: 'invalid_output' });
  assert.deepEqual(postProcess(`北京#${'x'.repeat(101)}`, { type: '填空' }), { ok: false, code: 'invalid_output' });
  // 填空题不接受大写字母兜底
  // 超长（>100 字）即使含大写字母也不接受兜底
  assert.deepEqual(postProcess(`${'x'.repeat(101)}ABC`, { type: '填空' }), { ok: false, code: 'invalid_output' });
});

test('单选题兜底：抽首个大写字母；无大写字母则失败', () => {
  assert.deepEqual(postProcess('选 B 项', { type: '单选' }), { ok: true, answer: 'B', via: 'fallback' });
  assert.deepEqual(postProcess('B、C 都对', { type: '单选' }), { ok: true, answer: 'B', via: 'fallback' });
  assert.deepEqual(postProcess('无法作答', { type: '单选' }), { ok: false, code: 'invalid_output' });
  assert.deepEqual(postProcess('a', { type: '单选' }), { ok: false, code: 'invalid_output' }); // 小写不算
});

test('多选题兜底：>=2 个字母才接受，去重升序', () => {
  assert.deepEqual(postProcess('AC', { type: '多选' }), { ok: true, answer: 'A#C', via: 'fallback' });
  assert.deepEqual(postProcess('CBA', { type: '多选' }), { ok: true, answer: 'A#B#C', via: 'fallback' });
  assert.deepEqual(postProcess('AABB', { type: '多选' }), { ok: true, answer: 'A#B', via: 'fallback' });
  // T6/P0-2②：单字母现在是**严格校验**通过（不定项可能只有 1 个正确答案），via 为 strict
  assert.deepEqual(postProcess('A', { type: '多选' }), { ok: true, answer: 'A', via: 'strict' });
});

test('P0-2②：多选严格校验放宽为 /^[A-Z](#[A-Z])*$/，仍去重升序重排', () => {
  assert.deepEqual(postProcess('A', { type: '多选' }), { ok: true, answer: 'A', via: 'strict' });
  assert.deepEqual(postProcess('C#A', { type: '多选' }), { ok: true, answer: 'A#C', via: 'strict' });
  assert.deepEqual(postProcess('B#A#B', { type: '多选' }), { ok: true, answer: 'A#B', via: 'strict' });
  assert.deepEqual(postProcess('A#', { type: '多选' }), { ok: false, code: 'invalid_output' });
  assert.deepEqual(postProcess('a#c', { type: '多选' }), { ok: false, code: 'invalid_output' }); // 小写不算
});

test('P0-5：前缀剥离正则——「正确答案是 A#C」「答案应为 B」必须解析成功', () => {
  assert.deepEqual(postProcess('正确答案是 A#C', { type: '多选' }), { ok: true, answer: 'A#C', via: 'strict' });
  assert.deepEqual(postProcess('答案应为 B', { type: '单选' }), { ok: true, answer: 'B', via: 'strict' });
  assert.deepEqual(postProcess('正确答案是A#C', { type: '多选' }), { ok: true, answer: 'A#C', via: 'strict' });
  assert.deepEqual(postProcess('答案：正确', { type: '判断' }), { ok: true, answer: '正确', via: 'strict' });
});

test('判断题不接受字母兜底，且 normalizeJudge 覆盖全映射表', () => {
  assert.deepEqual(postProcess('这道题应该选 T', { type: '判断' }), { ok: false, code: 'invalid_output' });
  const pos = ['正确', '对', '√', 'T', 't', 'true', 'TRUE', '是', 'Y'];
  const neg = ['错误', '错', '×', 'F', 'f', 'false', 'False', '否', 'N'];
  for (const tok of pos) assert.equal(normalizeJudge(tok), '正确', `pos ${tok}`);
  for (const tok of neg) assert.equal(normalizeJudge(tok), '错误', `neg ${tok}`);
  assert.equal(normalizeJudge('A'), null);
  assert.equal(normalizeJudge('B'), null);
  assert.equal(normalizeJudge('A', []), null);
  assert.equal(normalizeJudge('A', ['A.正确', 'B.错误']), '正确');
  assert.equal(normalizeJudge('B', ['A.正确', 'B.错误']), '错误');
  assert.equal(normalizeJudge('A', ['A.对', 'B.错']), '正确');
  assert.equal(normalizeJudge('A', ['A.√', 'B.×']), '正确');
  assert.equal(normalizeJudge('A', ['A.是', 'B.否']), '正确');
  assert.equal(normalizeJudge('B', ['A.错误', 'B.正确']), null); // options[0] 不含正确类词 → 不映射
  assert.equal(normalizeJudge('随便一段话'), null);
  assert.equal(normalizeJudge(''), null);
  assert.equal(normalizeJudge(undefined), null);
  // options 传 # 拼接串也可用
  assert.equal(normalizeJudge('A', 'A.正确#B.错误'), '正确');
});

test('validate() 与 postProcess 的严格校验一致', () => {
  assert.equal(validate('A', '单选'), true);
  assert.equal(validate('AB', '单选'), false);
  assert.equal(validate('a', '单选'), false);
  assert.equal(validate('A#C', '多选'), true);
  assert.equal(validate('A', '多选'), true); // T6/P0-2②：不定项允许单个正确答案
  assert.equal(validate('正确', '判断'), true);
  assert.equal(validate('对', '判断'), true);
  assert.equal(validate('A', '判断'), false);
  assert.equal(validate('A', '判断', ['A.正确', 'B.错误']), true);
  assert.equal(validate('北京#上海', '填空'), true);
  assert.equal(validate('', '填空'), false);
  assert.equal(validate('要点', '问答'), true);
  assert.equal(validate('x'.repeat(401), '问答'), false);
  assert.equal(validate(undefined, '单选'), false);
});

test('cleanRaw：剥代码块 / 循环剥前缀 / 去首尾句号引号', () => {
  assert.equal(cleanRaw(`${FENCE}A${FENCE}`), 'A');
  assert.equal(cleanRaw(`${FENCE}\n答案：A\n${FENCE}`), 'A');
  assert.equal(cleanRaw('答案：答案是 A'), 'A');       // 循环剥离
  assert.equal(cleanRaw('答案：答案：答案：答案：A'), '答案：A'); // 契约限定最多剥 3 次 // 最多 3 次仍收敛到可判定
  assert.deepEqual(postProcess('答案：答案：答案：答案：A', { type: '单选' }), { ok: true, answer: 'A', via: 'fallback' });
  assert.equal(cleanRaw('“A。”'), 'A');
  assert.equal(cleanRaw('  A.  '), 'A');
  assert.equal(cleanRaw(null), '');
  assert.equal(cleanRaw(123), '123');
});

test('type 缺失时保守按单选处理；非法入参不抛', () => {
  assert.deepEqual(postProcess('B', {}), { ok: true, answer: 'B', via: 'strict' });
  assert.deepEqual(postProcess('B'), { ok: true, answer: 'B', via: 'strict' });
  assert.deepEqual(postProcess('B', { type: '单选题' }), { ok: true, answer: 'B', via: 'strict' });
  assert.deepEqual(postProcess('A#C', { type: '多选题' }), { ok: true, answer: 'A#C', via: 'strict' });
  for (const bad of [{}, 42, 'x', null]) {
    assert.doesNotThrow(() => postProcess('A', bad));
  }
  const r = postProcess({ toString: null }, { type: '单选' });
  assert.deepEqual(r, { ok: false, code: 'invalid_output' });
});