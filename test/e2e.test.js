// test/e2e.test.js — T6 集成端到端测试（Owner: T6，独占文件）
//
// 与 test/http.test.js 的区别：http.test 用 t3-* 桩注入 matcher/gate/ai 验证 server 行为；
// 本文件**不注入任何桩**，走真实 Matcher + 真实 createGate + 真实 createAI 全链路，
// 仅把 bailian 的 baseUrl 指向本地假 provider（node:http + listen(0)，绝不联网）。
//
// 纪律（CONTRACT §11）：listen(0) 随机端口（断言 != 8080）；数据/日志全部 os.tmpdir()（前缀 qbank-t6-）；
// after() 关闭全部 server 与假 provider 并清理临时目录。
//
// 覆盖（PROMPT_T6 第三步 + HANDOFF §12）：
//   六条管线路径 / 审核降级 / 20 并发 peak<=3 与 queue_full / /admin/verify /
//   优雅退出 / 顶层异常 200+ai_error / gate 超时 / P0-8 health 形状 / P1-6 queueFull 单一来源。

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { loadConfig, resolvePaths } from '../config.js';
import { makeKey } from '../lib/normalize.js';
import { createFakeProvider, chatOK, chatErr, FETCH_BAD_PORTS } from './stubs/t2-fakeProvider.js';

const dirs = [];
const insts = [];
const providers = [];
after(async () => {
  for (const i of insts.splice(0)) { try { await i.close(); } catch { /* 忽略 */ } }
  for (const p of providers.splice(0)) { try { await p.close(); } catch { /* 忽略 */ } }
  for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

const TITLE = '中国梦的本质内涵是什么';
const OPTIONS = 'A.富强#B.振兴';
const KEY = makeKey(TITLE, OPTIONS);

function seedRecord(over = {}) {
  return {
    key: KEY, title: TITLE, options: ['A.富强', 'B.振兴'], answer: 'A#B',
    type: '多选题', source: 'local', verified: true, createdAt: 1700000000000, ...over,
  };
}

/**
 * 起一个全真实栈的服务（只有 bailian baseUrl 指向本地假 provider）。
 * @param {{env?:object, handler?:Function, seed?:object[]}} opts
 */
async function boot(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-t6-'));
  dirs.push(dir);
  const provider = createFakeProvider(opts.handler || (() => chatOK('B')));
  const { baseUrl } = await provider.listen();
  providers.push(provider);

  const env = {
    QBANK_DATA_DIR: dir,
    QBANK_LOGS_DIR: dir,
    QBANK_PORT: '0',
    QBANK_AI_FALLBACK: 'bailian',
    QBANK_BAILIAN_BASE_URL: baseUrl,
    DASHSCOPE_API_KEY: 'sk-xxxxxxxx', // 假 Key，只发给本地假 provider，绝不联网
    ...(opts.env || {}),
  };
  const cfg = loadConfig({ cwd: dir, env });
  const paths = resolvePaths(cfg, { cwd: dir });
  if (opts.seed) {
    fs.writeFileSync(paths.bankPath, JSON.stringify({ version: 1, updatedAt: 1700000000000, records: opts.seed }), 'utf8');
  }
  const inst = await createServer({ config: cfg, paths, env });
  insts.push(inst);
  const addr = await inst.listen(0);
  assert.notEqual(addr.port, 8080, 'e2e 严禁 8080');
  assert.ok(!FETCH_BAD_PORTS.has(addr.port), '随机端口不得命中 fetch bad port（T6 flake 修复回归断言）');
  return { base: `http://127.0.0.1:${addr.port}`, inst, dir, paths, provider, env, cfg };
}

const get = (url) => fetch(url);
const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const api = (base, q, type = '单选题', options = 'A.甲#B.乙') =>
  post(`${base}/api`, { q, type, options });
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ---------------------------------------------------------------- 六条管线路径

test('e2e: L1 命中 local / L2 命中 fuzzy / suspicious 被丢弃走 AI / 图片公式短路', async () => {
  const { base, provider } = await boot({ seed: [seedRecord()] });

  // 1) L1：原题原选项 → local
  const l1 = await (await api(base, TITLE, '多选题', OPTIONS)).json();
  assert.equal(l1.code, 1);
  assert.equal(l1.source, 'local');
  assert.equal(l1.answer, 'A#B');
  assert.equal(l1.question, TITLE);

  // 2) L2：scorePair(原题, 「…是什么呢」)=0.9381 >= fuzzyThreshold 0.9 → fuzzy
  const l2 = await (await api(base, TITLE + '呢', '多选题', OPTIONS)).json();
  assert.equal(l2.code, 1);
  assert.equal(l2.source, 'fuzzy');
  assert.equal(l2.answer, 'A#B');

  // 3) suspicious：scorePair(原题, 「…是什么内容」)=0.8839 ∈ [0.8,0.9)，
  //    acceptSuspicious=false → 丢弃疑似命中，继续走 AI（而不是返回 fuzzy）。
  const before = provider.requestCount;
  const susp = await (await api(base, TITLE + '内容', '多选题', OPTIONS)).json();
  assert.equal(susp.code, 1);
  assert.equal(susp.source, 'ai', '疑似命中必须被丢弃，不得以 fuzzy 返回');
  assert.equal(susp.answer, 'B'); // P0-2②：多选允许单字母答案
  assert.equal(provider.requestCount, before + 1, '丢弃疑似命中后应真实调用 AI');

  // 4) 图片/公式短路：不调 AI（Patch 7：纯图片题干清洗后仍 fail-closed）
  const before2 = provider.requestCount;
  const img = await (await api(base, '![img](a.png)')).json();
  assert.equal(img.code, 0);
  assert.equal(img.reason, 'image_or_formula');
  assert.equal(provider.requestCount, before2, '短路不得调用 AI');

  // 4b) Patch 7: 文字+图片杂质混合题干 → 清洗后走 AI，响应 question 为清洗后题干
  const before3 = provider.requestCount;
  const mix = await (await api(base, '请看下图 ![img](a.png) 选出正确答案')).json();
  assert.equal(mix.code, 1);
  assert.equal(mix.source, 'ai');
  assert.equal(mix.answer, 'B');
  assert.equal(mix.question, '请看下图 选出正确答案');
  assert.equal(provider.requestCount, before3 + 1, '混合题干不再短路，应调用 AI');

  const h = await get(`${base}/health`);
  assert.equal(h.status, 200, '进程存活');
});

test('e2e: AI 成功 → 回写 bank.json(source:ai) → 二次请求走 L1 且 ai.calls 不增长', async () => {
  const { base, inst, paths } = await boot({ handler: () => chatOK('C') });
  const q = '太阳系中体积最大的行星是哪一颗';
  const options = 'A.地球#B.木星#C.土星';

  const r1 = await (await api(base, q, '单选题', options)).json();
  assert.equal(r1.code, 1);
  assert.equal(r1.source, 'ai');
  assert.equal(r1.answer, 'C');
  const s1 = await (await get(`${base}/stats`)).json();
  assert.equal(s1.ai.calls, 1);

  // 回写落盘（store.add 是去抖 persist，这里显式 flush）
  await inst.app.store.persist();
  const doc = readJson(paths.bankPath);
  const rec = doc.records.find((r) => r.title === q);
  assert.ok(rec, 'bank.json 应新增该题');
  assert.equal(rec.source, 'ai');
  assert.equal(rec.verified, false);
  assert.equal(rec.answer, 'C');
  assert.equal(rec.type, '单选题');
  assert.equal(rec.model, 'stub-model');
  assert.equal(rec.key, makeKey(q, options));

  // 立刻重复同一请求：L1 命中，source 变 local，ai.calls 零增长
  const r2 = await (await api(base, q, '单选题', options)).json();
  assert.equal(r2.code, 1);
  assert.equal(r2.source, 'local');
  assert.equal(r2.answer, 'C');
  const s2 = await (await get(`${base}/stats`)).json();
  assert.equal(s2.ai.calls, 1, '重复请求不得新增 AI 调用');
  assert.equal(s2.bank.total, 1);
});

test('e2e: AI 全链失败(401) → code:0 ai_error，进程存活且后续请求正常', async () => {
  let calls = 0;
  const { base, provider } = await boot({
    handler: () => { calls += 1; return calls === 1 ? chatErr(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }) : chatOK('A'); },
  });
  const r1 = await (await api(base, '第一道全新题目内容甲')).json();
  assert.equal(r1.code, 0);
  assert.equal(r1.reason, 'ai_error');
  const h = await get(`${base}/health`);
  assert.equal(h.status, 200, '401 后进程必须存活');
  const r2 = await (await api(base, '第二道全新题目内容乙')).json();
  assert.equal(r2.code, 1, '失败后下一个正常请求必须能应答');
  assert.equal(r2.source, 'ai');
  assert.equal(provider.requestCount, 2);
});

// ---------------------------------------------------------------- 审核降级

test('e2e: DataInspectionFailed → ai_moderation 降级；moderation.log 只含 key/码/provider，不含题目原文', async () => {
  const q = '这是一道会触发审核拦截的全新题目';
  const options = 'A.敏感选项甲#B.敏感选项乙';
  const { base, paths } = await boot({
    handler: (info, i) => (i === 0
      ? chatErr(400, { code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' })
      : chatOK('A')),
  });
  const r1 = await (await api(base, q, '单选题', options)).json();
  assert.equal(r1.code, 0);
  assert.equal(r1.reason, 'ai_moderation');
  const s = await (await get(`${base}/stats`)).json();
  assert.equal(s.ai.moderation, 1);

  // 同一次运行里继续发正常请求：审核不重试同 provider，链路继续
  const r2 = await (await api(base, q, '单选题', options)).json();
  assert.equal(r2.code, 1);

  const logText = fs.readFileSync(paths.moderationLogPath, 'utf8');
  assert.ok(logText.includes('DataInspectionFailed'), '日志应含审核错误码');
  assert.ok(logText.includes('bailian'), '日志应含 provider 名');
  assert.ok(logText.includes(makeKey(q, options).slice(0, 12)), '日志应含 key 前 12 位');
  assert.ok(!logText.includes(q), '日志严禁出现题干原文');
  assert.ok(!logText.includes('敏感选项甲'), '日志严禁出现选项原文');
});

// ---------------------------------------------------------------- 并发与闸门（P0-7 / P1-6）

test('e2e: 20 并发 → 全部 200 JSON；gate.stats().peak<=3；超出 queue_full；/stats.ai.queueFull 取 gate.rejected', async () => {
  const { base, inst } = await boot({
    env: { QBANK_QUEUE_LIMIT: '2' },
    handler: () => ({ ...chatOK('A'), delayMs: 120 }),
  });
  const reqs = [];
  for (let i = 0; i < 20; i += 1) {
    reqs.push(api(base, `并发压测第${i}号全新题目内容`));
  }
  const results = await Promise.all(reqs); // 任一 ECONNRESET 都会在此抛出
  assert.equal(results.length, 20);
  const bodies = [];
  for (const res of results) {
    assert.equal(res.status, 200, '绝不 500/重置');
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    bodies.push(await res.json());
  }
  const ok = bodies.filter((b) => b.code === 1);
  const qf = bodies.filter((b) => b.code === 0 && b.reason === 'queue_full');
  assert.ok(ok.length >= 3, '至少 concurrency 个成功');
  assert.ok(qf.length >= 1, 'queueLimit=2 时必有 queue_full');
  assert.equal(ok.length + qf.length, 20, '只允许成功或 queue_full 两种结局');

  const peak = inst.app.gate.stats().peak;
  assert.ok(peak >= 1, 'gate 应至少并发 1 个 AI 调用');
  assert.ok(peak <= 3, `P0-7：AI 实际并发必须 <= 3，实测 peak=${peak}`);

  const s = await (await get(`${base}/stats`)).json();
  assert.equal(s.ai.queueFull, inst.app.gate.stats().rejected, 'P1-6：queueFull 单一来源 = gate.stats().rejected');
  assert.equal(s.ai.queueFull, qf.length, '/stats 计数应与响应里的 queue_full 个数一致');

  await inst.app.gate.drain();
  const s2 = await (await get(`${base}/stats`)).json();
  assert.equal(s2.ai.inflight, 0);
  assert.equal(s2.ai.queued, 0);
  const h = await get(`${base}/health`);
  assert.equal(h.status, 200, '并发后进程存活');
});

test('e2e: gate 超时(QBANK_TIMEOUT_MS=500, provider 挂 1500ms) → ai_timeout，进程存活', async () => {
  const { base } = await boot({
    env: { QBANK_TIMEOUT_MS: '500' },
    handler: (info, i) => (i === 0 ? { ...chatOK('A'), delayMs: 1500 } : chatOK('A')),
  });
  const t0 = Date.now();
  const r1 = await (await api(base, '超时测试的全新题目内容')).json();
  assert.equal(r1.code, 0);
  assert.equal(r1.reason, 'ai_timeout');
  assert.ok(Date.now() - t0 < 5000, '超时必须及时返回，不得挂死');
  const r2 = await (await api(base, '超时之后的正常题目内容')).json();
  assert.equal(r2.code, 1, '超时后下一个正常请求必须能应答');
});

// ---------------------------------------------------------------- 管理接口 / 异常兜底 / 退出

test('e2e: /admin/verify 标记落盘；未知 key 与非法 body → bad_request', async () => {
  const { base, inst, paths } = await boot({ handler: () => chatOK('B') });
  const q = '需要人工核验的全新题目内容';
  const options = 'A.甲#B.乙';
  await api(base, q, '单选题', options);
  await inst.app.store.persist();
  const key = makeKey(q, options);

  const ok = await (await post(`${base}/admin/verify`, { key, verified: true })).json();
  assert.equal(ok.code, 1);
  assert.equal(ok.verified, true);
  const doc = readJson(paths.bankPath);
  assert.equal(doc.records.find((r) => r.key === key).verified, true, '标记应已落盘');

  const unknown = await (await post(`${base}/admin/verify`, { key: 'f'.repeat(64), verified: true })).json();
  assert.equal(unknown.code, 0);
  assert.equal(unknown.reason, 'bad_request');
  const bad = await (await post(`${base}/admin/verify`, { key })).json();
  assert.equal(bad.reason, 'bad_request');
});

test('e2e: 顶层异常 → 200 + ai_error（绝不 500）；bad_request 分支；进程存活', async () => {
  const { base, inst } = await boot();
  // 注入一个会在管线里抛错的 store.match（handleApi 顶层 try/catch 必须兜住）
  const orig = inst.app.store.match.bind(inst.app.store);
  inst.app.store.match = () => { throw new Error('e2e-boom'); };
  const boom = await (await api(base, '触发内部异常的全新题目')).json();
  assert.equal(boom.code, 0);
  assert.equal(boom.reason, 'ai_error');
  inst.app.store.match = orig;

  const h = await get(`${base}/health`);
  assert.equal(h.status, 200, '异常后进程存活');

  // bad_request：非 JSON body / 缺 q / 表单编码（T3#8：只解析 JSON）
  const notJson = await (await post(`${base}/api`, '这不是JSON')).json();
  assert.equal(notJson.reason, 'bad_request');
  const noQ = await (await post(`${base}/api`, { type: '单选题' })).json();
  assert.equal(noQ.reason, 'bad_request');
  const form = await (await post(`${base}/api`, 'q=表单编码题目&type=单选题', { 'Content-Type': 'application/x-www-form-urlencoded' })).json();
  assert.equal(form.reason, 'bad_request');

  const r = await (await api(base, '异常之后的正常题目内容')).json();
  assert.equal(r.code, 1, '兜底后服务必须继续可用');
});

test('e2e: 优雅退出 close() → bank/cache/bak 均可再载入、端口释放、重复 close 幂等', async () => {
  // seed 使 bank.json 预先存在 → persist 必然先生成 bank.json.bak（DECISIONS #14）
  const { base, inst, paths } = await boot({ seed: [seedRecord()], handler: () => chatOK('A') });
  await api(base, '退出前写入的全新题目内容');
  await inst.close();
  assert.ok(fs.existsSync(paths.bankPath), '退出时 bank.json 应落盘');
  assert.ok(fs.existsSync(paths.cachePath), '退出时 cache.json 应落盘');
  assert.ok(fs.existsSync(paths.bakPath), '退出时 bank.json.bak 应存在');
  // 三份文件均可再次载入且结构合法（Ctrl+C 等价路径）
  const doc = readJson(paths.bankPath);
  assert.equal(doc.version, 1);
  assert.ok(Array.isArray(doc.records));
  assert.ok(doc.records.some((r) => r.title === '退出前写入的全新题目内容'));
  const bak = readJson(paths.bakPath);
  assert.equal(bak.version, 1);
  assert.ok(Array.isArray(bak.records));
  const cacheDoc = readJson(paths.cachePath);
  assert.equal(cacheDoc.version, 1);
  assert.equal(typeof cacheDoc.entries, 'object');
  await assert.rejects(() => get(`${base}/health`), '端口应已释放');
  await inst.close(); // 幂等，不得抛
});

// ---------------------------------------------------------------- requireVerified（DECISIONS #6）

test('e2e: requireVerified=true → bank 层过滤未验证记录；cache 层不受约束；核验后走 L1', async () => {
  const { base } = await boot({
    env: { QBANK_REQUIRE_VERIFIED: '1' },
    seed: [seedRecord({ verified: false })],
    handler: () => chatOK('A#B'),
  });
  // 1) bank 里有同 key 记录但 verified:false → L1 必须被过滤，落到 AI
  const r1 = await (await api(base, TITLE, '多选题', OPTIONS)).json();
  assert.equal(r1.code, 1);
  assert.equal(r1.source, 'ai', 'requireVerified=true 时未验证的 bank 记录不得应答');
  assert.equal(r1.answer, 'A#B');
  // 2) 二次请求：AI 回写仍 verified:false，但 cache 层不受 requireVerified 约束（DECISIONS #6）
  const r2 = await (await api(base, TITLE, '多选题', OPTIONS)).json();
  assert.equal(r2.code, 1);
  assert.equal(r2.source, 'cache', 'cache 层不受 requireVerified 约束');
  // 3) /admin/verify 人工核验后 → L1 返回 local
  const v = await (await post(`${base}/admin/verify`, { key: KEY, verified: true })).json();
  assert.equal(v.code, 1);
  assert.equal(v.verified, true);
  const r3 = await (await api(base, TITLE, '多选题', OPTIONS)).json();
  assert.equal(r3.code, 1);
  assert.equal(r3.source, 'local');
  assert.equal(r3.answer, 'A#B');
});

// ---------------------------------------------------------------- /health 形状（P0-8）

test('e2e: /health ai={enabled,chain}；QBANK_AI_ENABLED=0 → enabled:false + ai_disabled', async () => {
  const a = await boot();
  const h1 = await (await get(`${a.base}/health`)).json();
  assert.equal(h1.code, 1);
  assert.equal(typeof h1.ai, 'object');
  assert.equal(h1.ai.enabled, true);
  assert.deepEqual(h1.ai.chain, ['bailian']);

  const b = await boot({ env: { QBANK_AI_ENABLED: '0' }, seed: [seedRecord()] });
  const h2 = await (await get(`${b.base}/health`)).json();
  assert.equal(h2.ai.enabled, false);
  assert.deepEqual(h2.ai.chain, ['bailian'], 'enabled=false 不清空 chain（既有行为）');
  const r = await (await api(b.base, 'AI 关闭时的全新题目内容')).json();
  assert.equal(r.code, 0);
  assert.equal(r.reason, 'ai_disabled');
  // suspicious（0.8839）被丢弃后落到 AI，而 AI 已关 → ai_disabled；绝不以 fuzzy 返回
  const susp = await (await api(b.base, TITLE + '内容', '多选题', OPTIONS)).json();
  assert.equal(susp.code, 0);
  assert.equal(susp.reason, 'ai_disabled', '疑似命中必须被丢弃，不得以 fuzzy 应答');
});

// ---------------------------------------------------------------- D3/Patch 4（2026-11-22 用户批准）

test('e2e D3: 脏选项 → AI 收干净 prompt → 回写干净 → 重查脏选项命中 L1；纯图片占位选项短路', async () => {
  const SPACER = 'https://mooc1.chaoxing.com/images/spacer.gif';
  const title = '示例题干：中国梦的本质内涵是什么';
  const dirty = `A.富强${SPACER}#B.振兴${SPACER}`;
  const clean = 'A.富强#B.振兴';
  const { base, inst, paths, provider } = await boot({ handler: () => chatOK('A#B') });

  // 1) 首查脏选项 → AI 成功
  const r1 = await (await api(base, title, '多选题', dirty)).json();
  assert.equal(r1.code, 1);
  assert.equal(r1.source, 'ai');
  assert.equal(r1.answer, 'A#B');

  // 2) AI 实际收到的 prompt 无占位杂质
  const sent = JSON.parse(provider.requests[0].body);
  const userMsg = sent.messages.find((m) => m.role === 'user').content;
  assert.ok(!userMsg.includes('spacer.gif'), 'prompt 不得含图片占位 URL');
  assert.ok(userMsg.includes('选项：A.富强#B.振兴'), `prompt 选项应已清洗：${userMsg}`);

  // 3) 回写记录：options 干净、key 与干净 key 一致
  await inst.app.store.persist();
  const doc = readJson(paths.bankPath);
  const rec = doc.records.find((r) => r.title === title);
  assert.ok(rec, '回写记录应存在');
  assert.deepEqual(rec.options, ['A.富强', 'B.振兴']);
  assert.equal(rec.key, makeKey(title, clean));
  assert.equal(rec.source, 'ai');

  // 4) 重查脏/干净/乱序 → 全部 L1 命中，AI 调用数不增长
  for (const opts of [dirty, clean, `B.振兴${SPACER}#A.富强${SPACER}`]) {
    const r = await (await api(base, title, '多选题', opts)).json();
    assert.equal(r.code, 1);
    assert.equal(r.source, 'local', `应命中 L1：${opts}`);
    assert.equal(r.answer, 'A#B');
  }
  assert.equal(provider.requestCount, 1, '重查不得再调 AI');

  // 5) 纯图片占位选项 → image_or_formula 短路，零 AI 调用，不回写
  const img = await (await api(base, '示例题干：看图选出正确选项', '单选题', `A.${SPACER}#B.${SPACER}`)).json();
  assert.equal(img.code, 0);
  assert.equal(img.reason, 'image_or_formula');
  assert.equal(provider.requestCount, 1);
  const stats = await (await get(`${base}/stats`)).json();
  assert.equal(stats.match.imageOrFormula, 1);
  assert.equal(stats.bank.total, 1, '短路题不得回写');
});
