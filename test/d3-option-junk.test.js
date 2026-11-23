// test/d3-option-junk.test.js — D3/Patch 4 回归（Owner: T6，2026-11-22 用户批准）
//
// 覆盖：stripOptionJunk 清洗规则 / normalizeOptions+makeKey key 一致性 /
// isUnanswerable 纯图片选项短路 / buildMessages AI 输入清洗。
// 纪律：纯单元测试，无 I/O、无网络、无端口；题干一律占位文本，不出现真实题目或 API Key。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripOptionJunk, normalizeOptions, makeKey, isUnanswerable,
} from '../lib/normalize.js';
import { buildMessages, SYSTEM_PROMPT } from '../lib/prompt.js';

const SPACER = 'https://mooc1.chaoxing.com/images/spacer.gif';
const DIRTY_OPTS = `A.富强${SPACER}#B.振兴${SPACER}#C.幸福${SPACER}`;
const CLEAN_OPTS = 'A.富强#B.振兴#C.幸福';
const TITLE = '示例题干：中国梦的本质内涵是什么';

// ---------------------------------------------------------------- stripOptionJunk

test('stripOptionJunk: 剥图片占位 URL（含查询串/协议相对/大小写变体）', () => {
  assert.equal(stripOptionJunk(`A.富强${SPACER}`), 'A.富强');
  assert.equal(stripOptionJunk(`A.富强${SPACER}?v=123`), 'A.富强');
  assert.equal(stripOptionJunk('A.富强//mooc1.chaoxing.com/x/spacer.gif'), 'A.富强');
  assert.equal(stripOptionJunk('A.富强HTTPS://X.COM/SPACER.GIF'), 'A.富强');
  assert.equal(stripOptionJunk('A.富强 https://x.com/a.jpeg?x=1&y=2'), 'A.富强');
  assert.equal(stripOptionJunk('A.富强https://x.com/a.webp'), 'A.富强');
});

test('stripOptionJunk: 剥 markdown 图片 / <img> 标签 / 裸占位文件名', () => {
  assert.equal(stripOptionJunk('A.富强![img](https://x.com/a.png)'), 'A.富强');
  assert.equal(stripOptionJunk('A.富强<img src="https://x.com/a.gif" />'), 'A.富强');
  assert.equal(stripOptionJunk('A.富强 spacer.gif'), 'A.富强');
  assert.equal(stripOptionJunk('A.富强 BLANK.PNG'), 'A.富强');
});

test('stripOptionJunk: 非图片 URL 与普通文本保留；# 分隔符不被吞', () => {
  assert.equal(stripOptionJunk('A.参见 https://example.com/page'), 'A.参见 https://example.com/page');
  assert.equal(stripOptionJunk('A.富强#B.振兴'), 'A.富强#B.振兴');
  assert.equal(stripOptionJunk(`A.富强${SPACER}#B.振兴`), 'A.富强#B.振兴');
  assert.equal(stripOptionJunk('A.全角　空格　折叠'), 'A.全角 空格 折叠');
});

test('stripOptionJunk: 幂等、防御、永不抛', () => {
  for (const s of [`A.富强${SPACER}`, 'A.![x](y.png)', 'A.正确', '', '  ']) {
    assert.equal(stripOptionJunk(stripOptionJunk(s)), stripOptionJunk(s));
  }
  assert.equal(stripOptionJunk(null), '');
  assert.equal(stripOptionJunk(undefined), '');
  assert.equal(stripOptionJunk(42), '42');
  assert.equal(stripOptionJunk({}), '[object Object]');
});

// ---------------------------------------------------------------- key 管线一致性

test('makeKey: 脏选项与干净选项同 key；乱序仍一致；数组入参一致', () => {
  assert.equal(makeKey(TITLE, DIRTY_OPTS), makeKey(TITLE, CLEAN_OPTS));
  const shuffled = `C.幸福${SPACER}#A.富强${SPACER}#B.振兴${SPACER}`;
  assert.equal(makeKey(TITLE, shuffled), makeKey(TITLE, CLEAN_OPTS));
  assert.equal(makeKey(TITLE, DIRTY_OPTS.split('#')), makeKey(TITLE, CLEAN_OPTS));
  assert.notEqual(makeKey(TITLE, DIRTY_OPTS), makeKey(TITLE + '变体', CLEAN_OPTS));
});

test('normalizeOptions: 每项先清洗再 normalize', () => {
  assert.deepEqual(normalizeOptions(DIRTY_OPTS), normalizeOptions(CLEAN_OPTS));
  assert.deepEqual(normalizeOptions(`A.富强${SPACER}`), ['a富强']);
});

// ---------------------------------------------------------------- isUnanswerable

test('isUnanswerable: 纯图片占位选项 → 短路（string/array 入参）', () => {
  assert.equal(isUnanswerable(TITLE, `A.${SPACER}#B.${SPACER}`), true);
  assert.equal(isUnanswerable(TITLE, [`A.${SPACER}`, 'B.![x](https://y.com/b.png)']), true);
  assert.equal(isUnanswerable(TITLE, [`A.${SPACER}`, `B.振兴${SPACER}`]), true, '任一选项纯图片即整题短路');
  assert.equal(isUnanswerable(TITLE, 'A.spacer.gif#B.blank.gif'), true);
});

test('isUnanswerable: 文字+杂质混合不短路；缺省行为不变（题干口径 Patch 7 更新）', () => {
  assert.equal(isUnanswerable(TITLE, DIRTY_OPTS), false);
  assert.equal(isUnanswerable(TITLE, CLEAN_OPTS), false);
  assert.equal(isUnanswerable(TITLE), false, 'options 缺省只看题干（旧行为）');
  assert.equal(isUnanswerable('请看下图 ![img](a.png) 选出正确答案', CLEAN_OPTS), false); // Patch 7：题干清洗后送 AI，规则 7 兜底
  assert.equal(isUnanswerable('a.gif', CLEAN_OPTS), true);
  assert.equal(isUnanswerable('短', CLEAN_OPTS), true);
  assert.equal(isUnanswerable(TITLE, 'A.正确#B.错误'), false);
});

// ---------------------------------------------------------------- buildMessages

test('buildMessages: AI 输入选项已清洗，SYSTEM_PROMPT 一字不改，干净选项原样透传', () => {
  const msgs = buildMessages({ type: '多选', title: TITLE, options: DIRTY_OPTS });
  assert.equal(msgs[0].content, SYSTEM_PROMPT);
  assert.ok(!msgs[1].content.includes('spacer.gif'));
  assert.ok(msgs[1].content.endsWith(`选项：${CLEAN_OPTS}`));
  const arr = buildMessages({ type: '多选', title: TITLE, options: DIRTY_OPTS.split('#') });
  assert.equal(arr[1].content, msgs[1].content);
  const clean = buildMessages({ type: '单选', title: 'T', options: 'A.富强#B.振兴' });
  assert.equal(clean[1].content, '题型：单选题\n题干：T\n选项：A.富强#B.振兴');
});
