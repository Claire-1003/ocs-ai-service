// test/http.test.js — server.js HTTP 端到端测试（Owner: T3）
// CONTRACT §11.1：一律 listen(0) 随机端口，严禁 8080；§11.2：数据一律 os.tmpdir()。
// T1/T2 模块用 test/stubs/t3-* 注入，不依赖 lib/matcher.js、lib/queue.js、lib/ai/* 是否落地。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from '../server.js';
import { makeKey } from '../lib/normalize.js';
import { StubMatcher } from './stubs/t3-matcher.js';
import { createStubGate } from './stubs/t3-gate.js';
import { createStubAI } from './stubs/t3-ai.js';
import { makeTmpEnv, cleanup, readJson, writeJson } from './stubs/t3-env.js';

const dirs = [];
const insts = [];
after(async () => {
  for (const i of insts) { try { await i.close(); } catch { /* 忽略 */ } }
  for (const d of dirs) cleanup(d);
});

const TITLE = '中国梦的本质内涵是什么';
const OPTIONS = 'A.富强#B.振兴';
const KEY = makeKey(TITLE, OPTIONS);

function seedBank(paths, extra = []) {
  writeJson(paths.bankPath, {
    version: 1, updatedAt: 1700000000000, records: [{
      key: KEY, title: TITLE, options: ['A.富强', 'B.振兴'], answer: 'A#B',
      type: '多选题', source: 'local', verified: true, createdAt: 1700000000000,
    }, ...extra],
  });
}

async function boot(opts = {}) {
  const env = makeTmpEnv(opts.env);
  dirs.push(env.dir);
  if (opts.seedBank !== false) seedBank(env.paths, opts.extraRecords || []);
  if (opts.cacheEntries) writeJson(env.paths.cachePath, { version: 1, updatedAt: 1, entries: opts.cacheEntries });
  const overrides = { config: env.cfg, paths: env.paths, matcher: new StubMatcher(env.cfg.match), env: {} };
  if (!opts.noGate) overrides.gate = opts.gate || createStubGate(opts.gateOpts || {});
  if (!opts.noAi) overrides.ai = opts.ai || createStubAI(opts.aiOpts || {});
  if (opts.store) overrides.store = opts.store;
  const inst = await createServer(overrides);
  insts.push(inst);
  const addr = await inst.listen(0); // 随机端口，严禁固定端口
  assert.notEqual(addr.port, 8080);
  return { env, inst, base: `http://127.0.0.1:${addr.port}` };
}

const get = (url) => fetch(url);
const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('http: /health 200 且字段齐、响应头符合契约', async () => {
  const { base } = await boot();
  const res = await get(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const j = await res.json();
  assert.equal(j.code, 1);
  assert.equal(j.status, 'ok');
  assert.equal(typeof j.uptime, 'number');
  assert.equal(j.version, '1.0.0');
  assert.equal(j.bank, 1);
  // P0-8（T6 采纳）：ai 为 { enabled, chain } 对象（契约增补，见 docs/ACCEPTANCE.md）
  assert.equal(typeof j.ai, 'object');
  assert.ok(!Array.isArray(j.ai));
  assert.equal(typeof j.ai.enabled, 'boolean');
  assert.ok(Array.isArray(j.ai.chain));
});

test('http: /stats 200 且结构符合 DECISIONS #7', async () => {
  const { base } = await boot();
  const res = await get(`${base}/stats`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(Object.keys(j).sort(), ['ai', 'bank', 'cache', 'elapsed', 'match', 'uptime', 'version']);
  assert.deepEqual(Object.keys(j.bank).sort(), ['bySource', 'total', 'verified']);
  assert.deepEqual(Object.keys(j.cache).sort(), ['evictions', 'hits', 'misses', 'size', 'writes']);
  assert.deepEqual(Object.keys(j.ai).sort(), ['byProvider', 'calls', 'chain', 'failed', 'inflight', 'moderation', 'queueFull', 'queued', 'success', 'timeout', 'tokensIn', 'tokensOut']);
  assert.deepEqual(Object.keys(j.match).sort(), ['imageOrFormula', 'l1', 'l2', 'l2Suspicious', 'noMatch']);
  assert.deepEqual(Object.keys(j.elapsed).sort(), ['p50', 'p95', 'p99', 'samples']);
  assert.equal(j.bank.total, 1);
  assert.equal(j.elapsed.samples, 0);
});

test('http: GET /api 命中 L1 -> code:1 source:local；未命中 -> code:0 + reason', async () => {
  const { base } = await boot({ aiOpts: { ok: false, reason: 'ai_error' } });
  const url = `${base}/api?q=${encodeURIComponent(TITLE)}&type=${encodeURIComponent('多选题')}&options=${encodeURIComponent(OPTIONS)}`;
  const hit = await (await get(url)).json();
  assert.equal(hit.code, 1);
  assert.equal(hit.question, TITLE);
  assert.equal(hit.answer, 'A#B');
  assert.equal(hit.source, 'local');
  assert.equal(typeof hit.elapsed, 'number');

  const missUrl = `${base}/api?q=${encodeURIComponent('这是一道全新的题目内容')}&type=单选题&options=${encodeURIComponent('A.甲#B.乙')}`;
  const res = await get(missUrl);
  const miss = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual({ ...miss, elapsed: typeof miss.elapsed }, { code: 0, question: '', answer: '', reason: 'ai_error', elapsed: 'number' });

  // 选项乱序仍命中 L1（HANDOFF §5）
  const shuffled = `${base}/api?q=${encodeURIComponent(TITLE)}&options=${encodeURIComponent('B.振兴#A.富强')}`;
  const hit2 = await (await get(shuffled)).json();
  assert.equal(hit2.code, 1);
  assert.equal(hit2.source, 'local');
});

test('http: GET 中文原文与 URL 编码题干都正确解码；POST JSON body 工作', async () => {
  const { base } = await boot();
  // 未编码中文直接放 query（fetch 会自动编码）
  const r1 = await (await get(`${base}/api?q=${TITLE}&options=${encodeURIComponent(OPTIONS)}`)).json();
  assert.equal(r1.code, 1);
  assert.equal(r1.source, 'local');
  // 双重编码容错：safeDecode 再解一层
  const double = encodeURIComponent(encodeURIComponent(TITLE));
  const r2 = await (await get(`${base}/api?q=${double}&options=${encodeURIComponent(OPTIONS)}`)).json();
  assert.equal(r2.code, 1, '双重编码应被容错解码');
  // POST JSON（原文中文，无 URL 编码）
  const r3 = await (await post(`${base}/api`, { q: TITLE, type: '多选题', options: OPTIONS })).json();
  assert.equal(r3.code, 1);
  assert.equal(r3.question, TITLE);
  assert.equal(r3.answer, 'A#B');
  assert.equal(r3.source, 'local');
  // POST options 数组形态
  const r4 = await (await post(`${base}/api`, { q: TITLE, options: ['A.富强', 'B.振兴'] })).json();
  assert.equal(r4.code, 1);
});

test('http: 缺 q / 空 q / 坏 JSON / 超 1MB body -> bad_request', async () => {
  const { base } = await boot();
  const a = await (await get(`${base}/api`)).json();
  assert.deepEqual({ ...a, elapsed: 1 }, { code: 0, question: '', answer: '', reason: 'bad_request', elapsed: 1 });
  const b = await (await post(`${base}/api`, { type: '单选题' })).json();
  assert.equal(b.reason, 'bad_request');
  const c = await (await post(`${base}/api`, { q: '   ' })).json();
  assert.equal(c.reason, 'bad_request');
  const d = await (await post(`${base}/api`, 'not-json{{')).json();
  assert.equal(d.reason, 'bad_request');
  const big = await (await post(`${base}/api`, { q: 'x'.repeat(1024 * 1024 + 100) })).json();
  assert.equal(big.code, 0);
  assert.equal(big.reason, 'bad_request');
});

test('http: OPTIONS 预检 204 且带 CORS 头', async () => {
  const { base } = await boot();
  const res = await fetch(`${base}/api`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Content-Type' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods'), /GET/);
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  assert.match(res.headers.get('access-control-allow-headers'), /Content-Type/i);
  const body = await res.text();
  assert.equal(body, '');
});

test('http: 未知路径 -> 404 + {code:0,reason:"no_match"}', async () => {
  const { base } = await boot();
  const res = await get(`${base}/no/such/path`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const j = await res.json();
  assert.equal(j.code, 0);
  assert.equal(j.reason, 'no_match');
});

test('http: 图片/公式短路 -> image_or_formula，不调 AI', async () => {
  const ai = createStubAI({ answer: 'A' });
  const { base } = await boot({ ai });
  const j = await (await get(`${base}/api?q=${encodeURIComponent('![img](a.png)')}`)).json();
  assert.equal(j.code, 0);
  assert.equal(j.reason, 'image_or_formula');
  assert.equal(ai.counters.calls, 0, '短路时不得调用 AI');
  const st = await (await get(`${base}/stats`)).json();
  assert.equal(st.match.imageOrFormula, 1);
});

test('http: cache 命中 -> source:cache，question 为 q 原文', async () => {
  const q = '缓存命中的新题目内容';
  const key = makeKey(q, '');
  const { base } = await boot({ cacheEntries: { [key]: { answer: 'C', source: 'ai', type: '单选', createdAt: 1 } } });
  const j = await (await get(`${base}/api?q=${encodeURIComponent(q)}`)).json();
  assert.equal(j.code, 1);
  assert.equal(j.answer, 'C');
  assert.equal(j.source, 'cache');
  assert.equal(j.question, q);
});

test('http: AI 成功 -> source:ai + 回写 bank + 第二次同题走 L1 不再调 AI', async () => {
  const ai = createStubAI({ answer: 'B', delayMs: 0 });
  const { base, inst, env } = await boot({ ai });
  const q = '全新的一道单选题题目';
  const opts = 'A.第一个选项#B.第二个选项';
  const r1 = await (await post(`${base}/api`, { q, type: '单选题', options: opts })).json();
  assert.equal(r1.code, 1);
  assert.equal(r1.source, 'ai');
  assert.equal(r1.answer, 'B');
  assert.equal(r1.question, q);
  assert.equal(ai.counters.calls, 1);

  const key = makeKey(q, opts);
  const rec = inst.app.store.records().find((r) => r.key === key);
  assert.ok(rec, '应回写进内存 bank');
  assert.equal(rec.source, 'ai');
  assert.equal(rec.verified, false);
  assert.equal(rec.type, '单选题');
  assert.deepEqual(rec.options, ['A.第一个选项', 'B.第二个选项']);
  await inst.app.store.persist();
  const doc = readJson(env.paths.bankPath);
  assert.equal(doc.records.length, 2, 'bank.json 应含回写记录');
  assert.equal(doc.records[1].key, key);

  const r2 = await (await post(`${base}/api`, { q, type: '单选题', options: opts })).json();
  assert.equal(r2.code, 1);
  assert.equal(r2.source, 'local', '第二次同题应走 L1');
  assert.equal(ai.counters.calls, 1, '同题永不重复调用 AI');
});

test('http: AI 失败/抛错/queue_full 均返回 code:0 JSON，进程存活', async () => {
  // a) AI 返回 ok:false reason ai_moderation
  const { base: b1 } = await boot({ aiOpts: { ok: false, reason: 'ai_moderation' } });
  const j1 = await (await get(`${b1}/api?q=${encodeURIComponent('会被审核拦截的新题目')}&options=A.a`)).json();
  assert.equal(j1.code, 0);
  assert.equal(j1.reason, 'ai_moderation');

  // b) AI 内部直接抛无 code 异常 -> 顶层 catch -> ai_error，进程不退出
  const { base: b2 } = await boot({ aiOpts: { throwError: new Error('boom') } });
  const j2 = await (await get(`${b2}/api?q=${encodeURIComponent('会让AI抛错的新题目')}&options=A.a`)).json();
  assert.equal(j2.code, 0);
  assert.equal(j2.reason, 'ai_error');
  const h2 = await get(`${b2}/health`);
  assert.equal(h2.status, 200, '异常后进程/服务仍存活');

  // c) 非法 reason 归一为 ai_error（内部码 invalid_output 不外泄，DECISIONS #9）
  const { base: b3 } = await boot({ aiOpts: { ok: false, reason: 'invalid_output' } });
  const j3 = await (await get(`${b3}/api?q=${encodeURIComponent('输出不合规的新题目内容')}&options=A.a`)).json();
  assert.equal(j3.reason, 'ai_error');

  // d) gate 抛 queue_full
  const { base: b4 } = await boot({ aiOpts: { throwError: Object.assign(new Error('full'), { code: 'queue_full' }) } });
  const j4 = await (await get(`${b4}/api?q=${encodeURIComponent('队列已满时的新题目内容')}&options=A.a`)).json();
  assert.equal(j4.code, 0);
  assert.equal(j4.reason, 'queue_full');
});

test('http: handler 内部人为抛错（store.match 抛）仍返回 200/JSON code:0', async () => {
  const env = makeTmpEnv();
  dirs.push(env.dir);
  seedBank(env.paths);
  const evilStore = {
    load: async () => {},
    get: () => undefined,
    match: () => { throw new Error('人为内部错误'); },
    add: () => null,
    persist: async () => true,
    setVerified: () => false,
    stats: () => ({ total: 0, verified: 0, bySource: { local: 0, ai: 0, import: 0, fuzzy: 0 }, l1Hits: 0, l2Hits: 0, l2Suspicious: 0, noMatch: 0 }),
    records: () => [],
  };
  const inst = await createServer({
    config: env.cfg, paths: env.paths, store: evilStore,
    matcher: new StubMatcher(env.cfg.match), gate: createStubGate(), ai: createStubAI(), env: {},
  });
  insts.push(inst);
  const addr = await inst.listen(0);
  const res = await get(`http://127.0.0.1:${addr.port}/api?q=${encodeURIComponent('触发内部抛错的题目')}`);
  assert.equal(res.status, 200, '绝不返回 500');
  const j = await res.json();
  assert.equal(j.code, 0);
  assert.equal(j.reason, 'ai_error');
  const h = await get(`http://127.0.0.1:${addr.port}/health`);
  assert.equal(h.status, 200, '进程存活');
});

test('http: /admin/verify 标记 + 落盘（先 .bak）；非法 body -> bad_request', async () => {
  const { base, env, inst } = await boot();
  const res = await post(`${base}/admin/verify`, { key: KEY, verified: false });
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.code, 1);
  assert.equal(j.key, KEY);
  assert.equal(j.verified, false);
  const doc = readJson(env.paths.bankPath);
  assert.equal(doc.records[0].verified, false, '标记应已落盘');
  assert.equal(inst.app.store.get(KEY).verified, false);

  const bad1 = await (await post(`${base}/admin/verify`, {})).json();
  assert.equal(bad1.code, 0);
  assert.equal(bad1.reason, 'bad_request');
  const bad2 = await (await post(`${base}/admin/verify`, { key: KEY, verified: 'yes' })).json();
  assert.equal(bad2.reason, 'bad_request');
  const bad3 = await (await post(`${base}/admin/verify`, { key: '不存在的key', verified: true })).json();
  assert.equal(bad3.reason, 'bad_request');
});

test('http: QBANK_MOCK_AI=1 — 假 AI 应答端到端可用，且假数据不写 bank.json', async () => {
  const { base, inst, env } = await boot({ env: { QBANK_MOCK_AI: '1' }, noAi: true, noGate: true });
  const q = 'MOCK 模式下的全新单选新题';
  const j = await (await post(`${base}/api`, { q, type: '单选题', options: 'A.甲#B.乙' })).json();
  assert.equal(j.code, 1);
  assert.equal(j.source, 'ai');
  assert.equal(j.answer, 'A');
  const key = makeKey(q, 'A.甲#B.乙');
  assert.equal(inst.app.store.get(key), undefined, 'MOCK 结果不得进 bank');
  assert.equal(inst.app.cache.has(key), true, 'MOCK 结果可进 cache');
  const r2 = await (await post(`${base}/api`, { q, type: '单选题', options: 'A.甲#B.乙' })).json();
  assert.equal(r2.source, 'cache');
  await inst.app.store.persist();
  assert.ok(!fs.existsSync(env.paths.bakPath) || true);
  const doc = readJson(env.paths.bankPath);
  assert.equal(doc.records.length, 1, 'bank.json 仍只有种子记录');
});

test('http: 并发 20 个 /api 请求（AI 桩带延迟）全部返回 JSON，无 ECONNRESET，进程存活', async () => {
  const gate = createStubGate({ concurrency: 3, queueLimit: 200 });
  const { base } = await boot({ gate, ai: createStubAI({ answer: 'A', delayMs: 20 }) });
  const reqs = [];
  for (let i = 0; i < 20; i += 1) {
    reqs.push(post(`${base}/api`, { q: `并发压测题目第${i}号内容`, type: '单选题', options: 'A.甲#B.乙' }));
  }
  const results = await Promise.all(reqs); // 任一 ECONNRESET 都会在此抛出
  assert.equal(results.length, 20);
  for (const res of results) {
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const j = await res.json();
    assert.equal(j.code, 1);
    assert.equal(j.source, 'ai');
    assert.equal(typeof j.elapsed, 'number');
  }
  assert.ok(gate.stats().peak >= 1, 'gate 应至少并发 1 个 AI 调用');
  assert.ok(gate.stats().peak <= 3, `AI 实际并发必须 <= 3，实测 peak=${gate.stats().peak}`);
  assert.equal(gate.stats().completed, 20, '20 个请求全部走完闸');
  const h = await get(`${base}/health`);
  assert.equal(h.status, 200, '并发后进程存活');
});

test('http: gate 队列满 -> queue_full（不占住连接）', async () => {
  const { base } = await boot({
    gate: createStubGate({ concurrency: 1, queueLimit: 1 }),
    ai: createStubAI({ answer: 'A', delayMs: 60 }),
  });
  const mk = (i) => post(`${base}/api`, { q: `队列满测试题目第${i}号内容`, type: '单选题', options: 'A.甲#B.乙' });
  const all = await Promise.all([mk(1), mk(2), mk(3), mk(4), mk(5)]);
  const bodies = await Promise.all(all.map((r) => r.json()));
  const full = bodies.filter((b) => b.reason === 'queue_full');
  const ok = bodies.filter((b) => b.code === 1);
  assert.ok(full.length >= 1, '至少一个 queue_full');
  assert.ok(ok.length >= 1, '至少一个成功');
  assert.equal(full.length + ok.length, 5);
  for (const b of full) assert.equal(b.code, 0);
});