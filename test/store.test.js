// test/store.test.js — lib/store.js 单元测试（Owner: T3）
// CONTRACT §11：listen 无关；数据一律 os.tmpdir()（前缀 qbank-t3-）；断言卡数值/结构；sleep < 200ms。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { makeKey } from '../lib/normalize.js';
import { StubMatcher } from './stubs/t3-matcher.js';
import { makeTmpEnv, cleanup, sleep, readJson, writeJson } from './stubs/t3-env.js';

const dirs = [];
function tmp(extraEnv) {
  const e = makeTmpEnv(extraEnv);
  dirs.push(e.dir);
  return e;
}
after(() => { for (const d of dirs) cleanup(d); });

function mkStore(env, opts = {}) {
  return new Store({
    bankPath: env.paths.bankPath,
    bakPath: env.paths.bakPath,
    config: env.cfg,
    matcher: opts.matcher !== undefined ? opts.matcher : new StubMatcher(env.cfg.match),
    persistDebounceMs: opts.persistDebounceMs ?? 1000,
  });
}

function mkRecord(title, optionsRaw, answer, extra = {}) {
  const options = String(optionsRaw).split('#');
  return {
    key: makeKey(title, optionsRaw),
    title,
    options,
    answer,
    type: '多选题',
    source: 'local',
    verified: true,
    createdAt: 1700000000000,
    ...extra,
  };
}

test('store: 文件缺失 -> 空库 + 一条 stderr 警告，不抛', async () => {
  const env = tmp();
  const store = mkStore(env);
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    await store.load(); // 不得抛
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(store.records().length, 0);
  assert.equal(store.stats().total, 0);
  const storeLines = lines.filter((l) => l.includes('[qbank][store]'));
  assert.equal(storeLines.length, 1, '应恰好一条 store 警告');
  assert.match(storeLines[0], /\[qbank\]\[store\]\[[\w_]+\]/);
});

test('store: 坏 JSON -> 空库，不抛，警告不含数据内容', async () => {
  const env = tmp();
  fs.writeFileSync(env.paths.bankPath, '{"records": [oops 敏感题干不得出现', 'utf8');
  const store = mkStore(env);
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try { await store.load(); } finally { process.stderr.write = orig; }
  assert.equal(store.records().length, 0);
  const warn = lines.filter((l) => l.includes('[qbank][store]')).join('');
  assert.ok(warn.length > 0, '应有警告');
  assert.ok(!warn.includes('敏感题干不得出现'), '警告不得回显文件内容');
});

test('store: 顶层 {version,updatedAt,records} 与裸数组都能载入', async () => {
  const env = tmp();
  const rec = mkRecord('载入测试题目一', 'A.选项一#B.选项二', 'A');
  writeJson(env.paths.bankPath, { version: 1, updatedAt: 1700000000001, records: [rec] });
  const s1 = mkStore(env);
  await s1.load();
  assert.equal(s1.records().length, 1);
  assert.deepEqual(s1.get(rec.key), rec);

  writeJson(env.paths.bankPath, [rec]); // DECISIONS #13 裸数组兼容
  const s2 = mkStore(env);
  await s2.load();
  assert.equal(s2.records().length, 1);
  assert.equal(s2.get(rec.key).answer, 'A');
});

test('store: add 后 persist 生成 .bak，Record 结构逐字段符合 HANDOFF §8.3', async () => {
  const env = tmp();
  const store = mkStore(env);
  await store.load();
  const r1 = mkRecord('第一道题目标题', 'A.甲#B.乙', 'A', { source: 'import', verified: false, model: undefined });
  delete r1.model;
  store.add(r1);
  assert.equal(await store.persist(), true);
  assert.ok(!fs.existsSync(env.paths.bakPath), '首次落盘（此前无 bank.json）不应有 .bak');

  const r2 = mkRecord('第二道题目标题', 'A.丙#B.丁#C.戊', 'B#C', { source: 'ai', model: 'qwen-flash', verified: false, createdAt: 1700000000999 });
  const added = store.add(r2);
  assert.deepEqual(Object.keys(added), ['key', 'title', 'options', 'answer', 'type', 'source', 'model', 'verified', 'createdAt']);
  assert.equal(await store.persist(), true);

  assert.ok(fs.existsSync(env.paths.bakPath), '第二次落盘必须先生成 bank.json.bak');
  const bak = readJson(env.paths.bakPath);
  assert.equal(bak.records.length, 1, '.bak 应为上一次的内容');
  const doc = readJson(env.paths.bankPath);
  assert.equal(doc.version, 1);
  assert.equal(typeof doc.updatedAt, 'number');
  assert.ok(doc.updatedAt >= 1700000000000);
  assert.equal(doc.records.length, 2);
  assert.deepEqual(doc.records[1], {
    key: r2.key, title: '第二道题目标题', options: ['A.丙', 'B.丁', 'C.戊'],
    answer: 'B#C', type: '多选题', source: 'ai', model: 'qwen-flash',
    verified: false, createdAt: 1700000000999,
  });
  assert.deepEqual(Object.keys(doc.records[0]), ['key', 'title', 'options', 'answer', 'type', 'source', 'verified', 'createdAt']);
});

test('store: 去抖合并落盘（注入 persistDebounceMs=30）', async () => {
  const env = tmp();
  const store = mkStore(env, { persistDebounceMs: 30 });
  await store.load();
  store.add(mkRecord('去抖题目一', 'A.a#B.b', 'A'));
  store.add(mkRecord('去抖题目二', 'A.a#B.b', 'B'));
  store.add(mkRecord('去抖题目三', 'A.a#B.b', 'A#B'));
  assert.ok(!fs.existsSync(env.paths.bankPath), '去抖窗口内不应落盘');
  await sleep(90);
  assert.ok(fs.existsSync(env.paths.bankPath), '去抖到期后应落盘');
  assert.equal(readJson(env.paths.bankPath).records.length, 3, '多次 add 合并为一次写');
});

test('store: 并发 persist 串行化，文件不损坏', async () => {
  const env = tmp();
  const store = mkStore(env);
  await store.load();
  for (let i = 0; i < 10; i += 1) store.add(mkRecord(`并发落盘题目${i}`, 'A.a#B.b', 'A'));
  const results = await Promise.all([store.persist(), store.persist(), store.persist(), store.persist(), store.persist()]);
  assert.deepEqual(results, [true, true, true, true, true]);
  const doc = readJson(env.paths.bankPath); // 能 parse 即未交叉写坏
  assert.equal(doc.records.length, 10);
});

test('store: requireVerified=true 时 get/match 过滤未验证条目（DECISIONS #6）', async () => {
  const env = tmp({ QBANK_REQUIRE_VERIFIED: '1' });
  assert.equal(env.cfg.writeback.requireVerified, true);
  const store = mkStore(env);
  await store.load();
  const un = mkRecord('未验证的题目内容', 'A.甲#B.乙', 'A', { source: 'ai', verified: false });
  const ok = mkRecord('已验证的题目内容', 'A.丙#B.丁', 'B', { source: 'local', verified: true });
  store.add(un);
  store.add(ok);
  assert.equal(store.get(un.key), undefined, '未验证条目 get 应被过滤');
  assert.equal(store.get(ok.key).answer, 'B');
  assert.equal(store.match('未验证的题目内容', 'A.甲#B.乙'), null, '未验证条目 match 应被过滤');
  const m = store.match('已验证的题目内容', 'A.丙#B.丁');
  assert.ok(m && m.level === 'L1' && m.record.key === ok.key);
  assert.equal(store.setVerified(un.key, true), true);
  assert.equal(store.get(un.key).verified, true, '标记后应可见');
  assert.equal(store.setVerified('不存在的key', true), false);
});

test('store: stats() 结构与计数符合 CONTRACT §3', async () => {
  const env = tmp();
  const store = mkStore(env);
  await store.load();
  store.add(mkRecord('统计题目甲', 'A.a#B.b', 'A', { source: 'local', verified: true }));
  store.add(mkRecord('统计题目乙', 'A.a#B.b', 'B', { source: 'ai', verified: false }));
  store.add(mkRecord('统计题目丙', 'A.a#B.b', 'A#B', { source: 'import', verified: true }));
  store.match('统计题目甲', 'A.a#B.b');            // L1 命中
  store.match('完全找不到的一句话题目', 'A.a#B.b'); // noMatch
  const s = store.stats();
  assert.deepEqual(s.bySource, { local: 1, ai: 1, import: 1, fuzzy: 0 });
  assert.equal(s.total, 3);
  assert.equal(s.verified, 2);
  assert.equal(s.l1Hits, 1);
  assert.equal(s.l2Hits, 0);
  assert.equal(s.l2Suspicious, 0);
  assert.equal(s.noMatch, 1);
  assert.deepEqual(Object.keys(s).sort(), ['bySource', 'l1Hits', 'l2Hits', 'l2Suspicious', 'noMatch', 'total', 'verified']);
});

test('store: L2 命中计数 + add 清洗非法字段', async () => {
  const env = tmp();
  const store = mkStore(env);
  await store.load();
  const rec = mkRecord('模糊匹配目标题', 'A.a#B.b', 'A');
  store.add(rec);
  const m = store.match('模糊匹配目标题', 'B.b#A.a#C.c'); // 选项不同 -> 桩判定 L2
  assert.ok(m && m.level === 'L2');
  assert.equal(store.stats().l2Hits, 1);
  const junk = store.add({ key: '', title: '' });
  assert.equal(junk, null, '非法记录应被拒绝');
  const cleaned = store.add({ key: makeKey('清洗题目', 'A.a'), title: '清洗题目', options: 'A.a', answer: 'A', type: 123, source: 'hacker', verified: 'yes', evil: 'x' });
  assert.equal(cleaned.type, '问答题');
  assert.equal(cleaned.source, 'ai', '非法 source 回退默认 ai');
  assert.equal(cleaned.verified, false, '非 boolean true 一律 false');
  assert.ok(!('evil' in cleaned), '多余字段应被剥掉');
});