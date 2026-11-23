// test/cache.test.js — lib/cache.js 单元测试（Owner: T3）
// 覆盖：LRU 淘汰顺序、100 次写入触发 flush、flush 内容完整（tmp+rename）、load 缺失/损坏不抛、
//       startAutoFlush/stopAutoFlush（interval 可注入，无真实 sleep > 200ms）、与 bank 同 key 脏缓存被丢弃。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LRU } from '../lib/cache.js';
import { createServer } from '../server.js';
import { makeKey } from '../lib/normalize.js';
import { StubMatcher } from './stubs/t3-matcher.js';
import { createStubGate } from './stubs/t3-gate.js';
import { createStubAI } from './stubs/t3-ai.js';
import { makeTmpEnv, cleanup, sleep, readJson, writeJson } from './stubs/t3-env.js';

const dirs = [];
function tmp(extraEnv) {
  const e = makeTmpEnv(extraEnv);
  dirs.push(e.dir);
  return e;
}
after(() => { for (const d of dirs) cleanup(d); });

const val = (answer, extra = {}) => ({ answer, source: 'ai', type: '单选', createdAt: 1700000000000, ...extra });

test('cache: load 缺失/损坏均不抛，得到空缓存', async () => {
  const env = tmp();
  const c1 = new LRU({ file: env.paths.cachePath });
  await c1.load(); // 文件不存在
  assert.equal(c1.size, 0);

  fs.writeFileSync(env.paths.cachePath, '{ broken json !!', 'utf8');
  const c2 = new LRU({ file: env.paths.cachePath });
  await c2.load();
  assert.equal(c2.size, 0);
  assert.deepEqual(c2.stats(), { size: 0, hits: 0, misses: 0, evictions: 0, writes: 0, flushedAt: 0 });
});

test('cache: LRU 淘汰顺序 — get 刷新热度，满时淘汰最久未使用', () => {
  const c = new LRU({ maxEntries: 3, file: '' });
  c.set('a', val('A'));
  c.set('b', val('B'));
  c.set('c', val('C'));
  assert.equal(c.size, 3);
  assert.equal(c.get('a').answer, 'A', 'a 被访问后变为最新');
  c.set('d', val('D'));
  assert.equal(c.has('b'), false, 'b 是最久未使用，应被淘汰');
  assert.equal(c.has('a'), true);
  assert.equal(c.has('c'), true);
  assert.equal(c.has('d'), true);
  assert.equal(c.size, 3);
  const s = c.stats();
  assert.equal(s.evictions, 1);
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 0);
  assert.equal(s.writes, 4);
  c.get('不存在的key');
  assert.equal(c.stats().misses, 1);
});

test('cache: 第 100 次 set 强制 flush，文件条目完整', async () => {
  const env = tmp();
  const c = new LRU({ maxEntries: 10000, file: env.paths.cachePath });
  await c.load();
  for (let i = 0; i < 99; i += 1) c.set(`key-${i}`, val(`A${i}`));
  assert.ok(!fs.existsSync(env.paths.cachePath), '99 次写入不应触发 flush');
  c.set('key-99', val('A99'));
  assert.equal(await c.flushing, true);
  assert.ok(fs.existsSync(env.paths.cachePath), '第 100 次 set 必须触发 flush');
  const doc = readJson(env.paths.cachePath);
  assert.equal(doc.version, 1);
  assert.equal(typeof doc.updatedAt, 'number');
  assert.equal(Object.keys(doc.entries).length, 100);
  assert.deepEqual(doc.entries['key-99'], { answer: 'A99', source: 'ai', type: '单选', createdAt: 1700000000000 });
});

test('cache: flush 原子落盘后可完整回读（load 往返一致）', async () => {
  const env = tmp();
  const c = new LRU({ maxEntries: 100, file: env.paths.cachePath });
  await c.load();
  c.set('k1', val('答案一', { model: 'qwen-flash' }));
  c.set('k2', val('答案二'));
  assert.equal(await c.flush(), true);
  const before = fs.readFileSync(env.paths.cachePath, 'utf8');

  const c2 = new LRU({ maxEntries: 100, file: env.paths.cachePath });
  await c2.load();
  assert.equal(c2.size, 2);
  assert.deepEqual(c2.get('k1'), { answer: '答案一', source: 'ai', type: '单选', model: 'qwen-flash', createdAt: 1700000000000 });
  assert.deepEqual(c2.get('k2'), { answer: '答案二', source: 'ai', type: '单选', createdAt: 1700000000000 });
  assert.equal(c2.stats().writes, 0, '载入不得计入 writes');
  assert.ok(before.length > 0);
  // 载入非法条目被跳过
  writeJson(env.paths.cachePath, { version: 1, updatedAt: 1, entries: { good: val('G'), bad: { answer: 123 }, worse: null } });
  const c3 = new LRU({ maxEntries: 100, file: env.paths.cachePath });
  await c3.load();
  assert.equal(c3.size, 1);
});

test('cache: startAutoFlush 周期落盘（注入 20ms），stopAutoFlush 后不再 flush', async () => {
  const env = tmp();
  const c = new LRU({ maxEntries: 100, file: env.paths.cachePath, flushIntervalMs: 20 });
  await c.load();
  c.set('auto-1', val('A'));
  c.startAutoFlush();
  await sleep(80);
  await c.flushing; // 等在途 flush 落定，避免竞态
  const t1 = c.stats().flushedAt;
  assert.ok(t1 > 0, '自动 flush 应已发生');
  assert.ok(fs.existsSync(env.paths.cachePath));
  c.stopAutoFlush();
  await sleep(80);
  assert.equal(c.stats().flushedAt, t1, 'stop 后 flushedAt 不应再变化');
  c.stopAutoFlush(); // 幂等
});

test('cache: 启动加载顺序 — 与 bank 同 key 的脏缓存被丢弃（DECISIONS #10）', async (t) => {
  const env = tmp();
  const title = '银行权威题目内容';
  const options = 'A.选项甲#B.选项乙';
  const key = makeKey(title, options);
  writeJson(env.paths.bankPath, {
    version: 1, updatedAt: 1, records: [{
      key, title, options: ['A.选项甲', 'B.选项乙'], answer: 'A',
      type: '单选题', source: 'local', verified: true, createdAt: 1700000000000,
    }],
  });
  writeJson(env.paths.cachePath, {
    version: 1, updatedAt: 1, entries: {
      [key]: { answer: 'B', source: 'ai', type: '单选题', createdAt: 1 }, // 脏缓存，应被丢弃
      'other-key': { answer: 'C', source: 'ai', type: '单选题', createdAt: 1 }, // 无关条目，应保留
    },
  });
  const inst = await createServer({
    config: env.cfg, paths: env.paths,
    matcher: new StubMatcher(env.cfg.match), gate: createStubGate(), ai: createStubAI(),
  });
  t.after(async () => { await inst.close(); });
  assert.equal(inst.app.cache.has(key), false, 'bank 同 key 的缓存条目必须被丢弃');
  assert.equal(inst.app.cache.has('other-key'), true, '无关缓存条目应保留');
  assert.equal(inst.app.store.get(key).answer, 'A');
});