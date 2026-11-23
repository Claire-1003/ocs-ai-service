// test/ai.test.js — lib/ai/*（Owner: T2）
//
// 纪律（CONTRACT §11）：
//   - 假 provider 全部用 node:http + listen(0)，**绝不联网**、绝不监听 8080/11434；
//   - 不读写仓库内真实 data/ 与 logs/（本文件全程不落盘）；
//   - 退避/超时用注入的毫秒级参数，无真实 sleep > 200ms；
//   - after() 里关闭所有 server，避免 node --test 挂住；
//   - 断言日志回调参数里不含题干/选项/答案原文。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAI, isModerationError, MODERATION_CODES } from '../lib/ai/index.js';
import bailian from '../lib/ai/bailian.js';
import openai from '../lib/ai/openai.js';
import ollama from '../lib/ai/ollama.js';
import { createGate } from '../lib/queue.js';
import { buildMessages } from '../lib/prompt.js';
import { createFakeProvider, chatOK, chatErr, ollamaOK, scripted } from './stubs/t2-fakeProvider.js';
import { createFakeLog, makeConfig, FAKE_ENV, sleep } from './stubs/t2-fakeLog.js';

const TITLE = '敏感题干XYZ123：以下哪项属于敏感内容？';
const OPTIONS = ['A.选项甲UNIQ1', 'B.选项乙UNIQ2', 'C.选项丙UNIQ3'];
const KEY = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';

const servers = [];
async function fake(handler) {
  const s = createFakeProvider(handler);
  const { baseUrl, port } = await s.listen();
  s.baseUrl = baseUrl;
  s.port = port;
  servers.push(s);
  return s;
}
after(async () => {
  for (const s of servers.splice(0)) { await s.close(); }
});

function bailianCfg(baseUrl, extra = {}) {
  return { baseUrl, model: 'qwen-flash', apiKeyEnv: 'DASHSCOPE_API_KEY', temperature: 0, maxTokens: 64, retryBaseMs: 5, ...extra };
}
function ollamaCfg(baseUrl, extra = {}) {
  return { baseUrl, model: 'stub-ollama', retryBaseMs: 5, ...extra };
}
function openaiCfg(baseUrl, extra = {}) {
  return { baseUrl, model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY', retryBaseMs: 5, ...extra };
}
function input(over = {}) {
  return { key: KEY, type: '单选', title: TITLE, options: OPTIONS, ...over };
}

// ---------------------------------------------------------------- isModerationError

test('MODERATION_CODES 覆盖 HANDOFF §7.5 的三个错误码', () => {
  assert.deepEqual([...MODERATION_CODES], [
    'DataInspectionFailed',
    'InvalidParameter.DataInspection',
    'InternalError.Algo.DataInspectionFailed',
  ]);
});

test('isModerationError：body.code / body.error.code / err.code / 400|500 + data inspection 文案', () => {
  assert.equal(isModerationError({ code: 'DataInspectionFailed' }), true);
  assert.equal(isModerationError({ code: 'InvalidParameter.DataInspection' }), true);
  assert.equal(isModerationError({ error: { code: 'InternalError.Algo.DataInspectionFailed' } }), true);
  assert.equal(isModerationError({ code: 'ai_moderation' }), true);
  assert.equal(isModerationError({ detailCode: 'DataInspectionFailed' }), true);
  assert.equal(isModerationError({ body: { code: 'DataInspectionFailed' } }), true);
  assert.equal(isModerationError({ body: { error: { code: 'InvalidParameter.DataInspection' } } }), true);
  assert.equal(isModerationError({ status: 400, message: 'Input data may contain inappropriate content (Data Inspection failed)' }), true);
  assert.equal(isModerationError({ status: 500, error: 'data inspection triggered' }), true);
  // 反例
  assert.equal(isModerationError({ code: 'InvalidApiKey', status: 401 }), false);
  assert.equal(isModerationError({ status: 429, message: 'Requests rate limit exceeded' }), false);
  assert.equal(isModerationError({ status: 400, message: 'bad param' }), false);
  assert.equal(isModerationError(null), false);
  assert.equal(isModerationError('DataInspectionFailed'), false); // 非对象入参不抛
  assert.equal(isModerationError(undefined), false);
  assert.equal(isModerationError({}), false);
});

// ---------------------------------------------------------------- 正常链路

test('200 正常响应：拿到 text 并成功 postProcess，请求体符合 HANDOFF §7.2', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const log = createFakeLog();
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) } }),
    env: FAKE_ENV,
    log,
  });
  assert.deepEqual(ai.chain, ['bailian']);
  const r = await ai.answer(input());
  assert.deepEqual(r, {
    ok: true, answer: 'A', provider: 'bailian', model: 'stub-model', tokens: { in: 11, out: 7 },
  });
  assert.equal(srv.requestCount, 1);
  const req = srv.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer sk-xxxxxxxx');
  assert.equal(req.headers['content-type'], 'application/json');
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'qwen-flash');
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 64);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, buildMessages({ type: '单选', title: TITLE, options: OPTIONS }));
  const s = ai.stats();
  assert.deepEqual(
    Object.keys(s).sort(),
    ['byProvider', 'calls', 'chainExhausted', 'failed', 'moderation', 'queueFull', 'success', 'tokensIn', 'tokensOut'],
  );
  assert.deepEqual(s.byProvider.bailian, { calls: 1, success: 1, failed: 0, moderation: 0, timeout: 0, ms: s.byProvider.bailian.ms });
  assert.equal(s.calls, 1);
  assert.equal(s.success, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.tokensIn, 11);
  assert.equal(s.tokensOut, 7);
  assert.equal(s.chainExhausted, 0);
  assert.equal(log.calls.moderation.length, 0);
});

test('模型输出带前后缀也能被 postProcess 收拾（代码块 / 答案：C）', async () => {
  const fence = '`'.repeat(3);
  const srv = await fake(scripted([chatOK(fence + 'B' + fence)]));
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) } }),
    env: FAKE_ENV,
  });
  assert.deepEqual(await ai.answer(input()), {
    ok: true, answer: 'B', provider: 'bailian', model: 'stub-model', tokens: { in: 11, out: 7 },
  });

  const srv2 = await fake(scripted([chatOK('答案：C')]));
  const ai2 = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv2.baseUrl) } }),
    env: FAKE_ENV,
  });
  const r2 = await ai2.answer(input());
  assert.equal(r2.ok, true);
  assert.equal(r2.answer, 'C');
});

// ---------------------------------------------------------------- 内容审核降级

async function moderationCase(status, errBody, label) {
  const bad = await fake(scripted([chatErr(status, errBody)]));
  const good = await fake(scripted([ollamaOK('正确')]));
  const log = createFakeLog();
  const ai = createAI({
    config: makeConfig({
      chain: ['bailian', 'ollama'],
      providers: { bailian: bailianCfg(bad.baseUrl), ollama: ollamaCfg(good.baseUrl) },
    }),
    env: FAKE_ENV,
    log,
  });
  const r = await ai.answer(input({ type: '判断' }));
  assert.equal(r.ok, true, label);
  assert.equal(r.answer, '正确', label);
  assert.equal(r.provider, 'ollama', label);
  assert.equal(bad.requestCount, 1, label + '：审核错误不得重试同 provider');
  assert.equal(good.requestCount, 1, label);
  assert.equal(log.calls.moderation.length, 1, label);
  const m = log.calls.moderation[0];
  assert.deepEqual(Object.keys(m).sort(), ['code', 'key', 'provider']);
  assert.equal(m.key, KEY);
  assert.equal(m.provider, 'bailian');
  assert.equal(typeof m.code, 'string');
  assert.ok(m.code.toLowerCase().includes('datainspection'), label + '：code 应为审核码，实际 ' + m.code);
  const dump = log.dump();
  assert.ok(!dump.includes('敏感题干XYZ123'), label + '：日志泄漏题干');
  assert.ok(!dump.includes('UNIQ1'), label + '：日志泄漏选项');
  assert.ok(!dump.includes('sk-xxxxxxxx'), label + '：日志泄漏 API Key');
  const st = ai.stats();
  assert.equal(st.moderation, 1, label);
  assert.equal(st.byProvider.bailian.moderation, 1, label);
  assert.equal(st.byProvider.bailian.success, 0, label);
  assert.equal(st.byProvider.ollama.success, 1, label);
}

test('HTTP 400 + {code:"DataInspectionFailed"} → 审核降级到下一家', async () => {
  await moderationCase(400, { code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' }, '400');
});

test('HTTP 500 + {error:{code:"InternalError.Algo.DataInspectionFailed"}} → 审核降级到下一家', async () => {
  await moderationCase(500, { error: { code: 'InternalError.Algo.DataInspectionFailed', message: 'data inspection failed' } }, '500');
});

test('HTTP 400 + {error:{code:"InvalidParameter.DataInspection"}} → 审核降级', async () => {
  await moderationCase(400, { error: { code: 'InvalidParameter.DataInspection' } }, 'InvalidParameter');
});

test('全链都被审核拦截 → reason=ai_moderation，moderation 计数为链长', async () => {
  const b = await fake(scripted([chatErr(400, { code: 'DataInspectionFailed' })]));
  const o = await fake(scripted([chatErr(500, { error: { code: 'InternalError.Algo.DataInspectionFailed' } })]));
  const log = createFakeLog();
  const ai = createAI({
    config: makeConfig({ chain: ['bailian', 'ollama'], providers: { bailian: bailianCfg(b.baseUrl), ollama: ollamaCfg(o.baseUrl) } }),
    env: FAKE_ENV,
    log,
  });
  const r = await ai.answer(input());
  assert.deepEqual(r, { ok: false, reason: 'ai_moderation' });
  assert.equal(log.calls.moderation.length, 2);
  assert.deepEqual(log.calls.moderation.map((x) => x.provider), ['bailian', 'ollama']);
  const s = ai.stats();
  assert.equal(s.moderation, 2);
  assert.equal(s.chainExhausted, 1);
  assert.equal(s.success, 0);
  assert.equal(s.failed, 2);
});

// ---------------------------------------------------------------- 鉴权 / 速率 / 超时 / 坏响应

test('HTTP 401 → ai_error 且不重试；单 provider 链直接 chainExhausted', async () => {
  const srv = await fake(scripted([chatErr(401, { error: { code: 'InvalidApiKey', message: 'Invalid API-key provided.' } })]));
  const log = createFakeLog();
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) } }),
    env: FAKE_ENV,
    log,
  });
  assert.deepEqual(await ai.answer(input()), { ok: false, reason: 'ai_error' });
  assert.equal(srv.requestCount, 1, '401 不得重试');
  const s = ai.stats();
  assert.equal(s.failed, 1);
  assert.equal(s.chainExhausted, 1);
  assert.equal(s.moderation, 0);
  assert.equal(log.calls.moderation.length, 0);
  assert.deepEqual(log.calls.error.map((e) => e.errCode), ['ai_error']);
});

test('HTTP 401 后自动切下一家 provider', async () => {
  const bad = await fake(scripted([chatErr(401, { error: { code: 'InvalidApiKey' } })]));
  const good = await fake(scripted([ollamaOK('A')]));
  const ai = createAI({
    config: makeConfig({ chain: ['bailian', 'ollama'], providers: { bailian: bailianCfg(bad.baseUrl), ollama: ollamaCfg(good.baseUrl) } }),
    env: FAKE_ENV,
  });
  const r = await ai.answer(input());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'ollama');
  assert.equal(bad.requestCount, 1);
});

test('HTTP 429 → 指数退避重试 2 次（共 3 次请求）后换 provider', async () => {
  const throttled = await fake(scripted([chatErr(429, { error: { code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded.' } })]));
  const good = await fake(scripted([ollamaOK('B')]));
  const ai = createAI({
    config: makeConfig({
      chain: ['bailian', 'ollama'],
      providers: { bailian: bailianCfg(throttled.baseUrl), ollama: ollamaCfg(good.baseUrl) },
    }),
    env: FAKE_ENV,
  });
  const t0 = Date.now();
  const r = await ai.answer(input());
  const elapsed = Date.now() - t0;
  assert.equal(throttled.requestCount, 3, '初次 + 2 次退避重试 = 3 次请求');
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'ollama', '重试耗尽后必须换 provider');
  assert.equal(r.answer, 'B');
  assert.ok(elapsed < 200, '退避间隔必须可注入（retryBaseMs=5），实际耗时 ' + elapsed + 'ms');
  assert.equal(ai.stats().byProvider.bailian.failed, 1);
});

test('429 退避间隔随 retryBaseMs 放大（30ms → 60ms 两档）', async () => {
  const srv = await fake(scripted([chatErr(429, { code: 'Throttling' })]));
  const t0 = Date.now();
  await assert.rejects(
    () => bailian.chat(buildMessages(input()), { providerCfg: bailianCfg(srv.baseUrl), env: FAKE_ENV, timeoutMs: 5000, retryBaseMs: 30 }),
    (err) => {
      assert.equal(err.code, 'ai_error');
      assert.equal(err.status, 429);
      return true;
    },
  );
  const elapsed = Date.now() - t0;
  assert.equal(srv.requestCount, 3);
  assert.ok(elapsed >= 80, '30ms + 60ms 退避应 >= 80ms，实际 ' + elapsed + 'ms');
  assert.ok(elapsed < 2000, '退避不应失控');
});

test('慢响应：AbortController 生效 → ai_timeout（provider 与 fallback 链两层）', async () => {
  const slow = await fake(scripted([{ status: 200, body: '{}', delayMs: 300 }]));
  const t0 = Date.now();
  await assert.rejects(
    () => bailian.chat(buildMessages(input()), { providerCfg: bailianCfg(slow.baseUrl), env: FAKE_ENV, timeoutMs: 40 }),
    (err) => {
      assert.equal(err.code, 'ai_timeout');
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 200, '必须在注入的 40ms 左右中止');

  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(slow.baseUrl) }, ai: { timeoutMs: 40 } }),
    env: FAKE_ENV,
  });
  const r = await ai.answer(input());
  assert.deepEqual(r, { ok: false, reason: 'ai_timeout' });
  assert.equal(ai.stats().byProvider.bailian.timeout, 1);
});

test('外部 signal abort → provider 抛 ai_timeout', async () => {
  const slow = await fake(scripted([{ status: 200, body: '{}', delayMs: 300 }]));
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20);
  if (t.unref) t.unref();
  await assert.rejects(
    () => bailian.chat(buildMessages(input()), { providerCfg: bailianCfg(slow.baseUrl), env: FAKE_ENV, signal: ac.signal }),
    (err) => err.code === 'ai_timeout',
  );
  clearTimeout(t);
});

test('已 abort 的 signal 直接失败，不发请求', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => bailian.chat(buildMessages(input()), { providerCfg: bailianCfg(srv.baseUrl), env: FAKE_ENV, signal: ac.signal, timeoutMs: 1000 }),
    (err) => err.code === 'ai_timeout',
  );
  assert.equal(srv.requestCount, 0);
});

test('响应体是 HTML / 坏 JSON → ai_error，进程不崩', async () => {
  const html = await fake(scripted([chatErr(200, '<html><head><title>502 Bad Gateway</title></head></html>')]));
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(html.baseUrl) } }),
    env: FAKE_ENV,
  });
  assert.deepEqual(await ai.answer(input()), { ok: false, reason: 'ai_error' });
  assert.equal(html.requestCount, 1);

  const badJson = await fake(scripted([{ status: 200, body: '{"choices": [ truncated' }]));
  const ai2 = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(badJson.baseUrl) } }),
    env: FAKE_ENV,
  });
  assert.deepEqual(await ai2.answer(input()), { ok: false, reason: 'ai_error' });
  assert.ok(process.pid > 0, '进程仍然健康');
});

test('choices 为空 / content 为空 / content 非字符串 → ai_error', async () => {
  const cases = [
    { status: 200, body: JSON.stringify({ choices: [], usage: {} }) },
    { status: 200, body: JSON.stringify({ choices: [{ message: { content: '' } }] }) },
    { status: 200, body: JSON.stringify({ choices: [{ message: { content: '   ' } }] }) },
    { status: 200, body: JSON.stringify({ choices: [{ message: { content: 123 } }] }) },
    { status: 200, body: JSON.stringify({ choices: [{}] }) },
    { status: 200, body: JSON.stringify({}) },
  ];
  for (const spec of cases) {
    const srv = await fake(scripted([spec]));
    const ai = createAI({
      config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) } }),
      env: FAKE_ENV,
    });
    assert.deepEqual(await ai.answer(input()), { ok: false, reason: 'ai_error' }, spec.body.slice(0, 40));
  }
});

test('网络错误 / DNS 失败 / 连接被拒 → ai_error，不抛到 process', async () => {
  const dead = await fake(scripted([chatOK('A')]));
  const deadUrl = dead.baseUrl; // 先拿到端口再关掉，制造 ECONNREFUSED
  await dead.close();
  servers.splice(servers.indexOf(dead), 1);

  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(deadUrl) } }),
    env: FAKE_ENV,
  });
  assert.deepEqual(await ai.answer(input()), { ok: false, reason: 'ai_error' });

  await assert.rejects(
    () => bailian.chat(buildMessages(input()), { providerCfg: bailianCfg(deadUrl), env: FAKE_ENV, timeoutMs: 2000 }),
    (err) => {
      assert.equal(err.code, 'ai_error');
      assert.ok(!err.message.includes('sk-xxxxxxxx'), '错误信息不得泄漏 Key');
      assert.ok(!err.message.includes('敏感题干XYZ123'), '错误信息不得泄漏题干');
      return true;
    },
  );

  // DNS 失败 / 域名解析错误：注入 fetchImpl 模拟，避免真实联网与平台 DNS 差异
  for (const netCode of ['ENOTFOUND', 'EAI_AGAIN']) {
    const cfg = bailianCfg('http://qbank-invalid-host-xyz.local/v1', {
      fetchImpl: () => Promise.reject(Object.assign(new Error('getaddrinfo failed'), { code: netCode })),
    });
    const dns = createAI({
      config: makeConfig({ chain: ['bailian'], providers: { bailian: cfg } }),
      env: FAKE_ENV,
    });
    assert.deepEqual(await dns.answer(input()), { ok: false, reason: 'ai_error' }, netCode);
    await assert.rejects(
      () => bailian.chat(buildMessages(input()), { providerCfg: cfg, env: FAKE_ENV, timeoutMs: 2000 }),
      (err) => err.code === 'ai_error',
      netCode,
    );
  }
});

// ---------------------------------------------------------------- 输出不合规 → 切下一家

test('postProcess 判失败（UNKNOWN）→ 视为该 provider 失败并切下一家', async () => {
  const bad = await fake(scripted([chatOK('UNKNOWN')]));
  const good = await fake(scripted([ollamaOK('A')]));
  const log = createFakeLog();
  const ai = createAI({
    config: makeConfig({ chain: ['bailian', 'ollama'], providers: { bailian: bailianCfg(bad.baseUrl), ollama: ollamaCfg(good.baseUrl) } }),
    env: FAKE_ENV,
    log,
  });
  const r = await ai.answer(input());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'ollama');
  assert.equal(r.answer, 'A');
  const s = ai.stats();
  assert.equal(s.calls, 2);
  assert.equal(s.byProvider.bailian.failed, 1);
  assert.equal(s.byProvider.bailian.success, 0);
  assert.equal(log.calls.moderation.length, 0, '输出不合规不是审核错误');
  assert.ok(log.calls.error.some((e) => e.errCode === 'invalid_output'), '应记录 invalid_output');
});

test('全链输出都不合规 → reason=ai_error（DECISIONS #9）', async () => {
  const b = await fake(scripted([chatOK('UNKNOWN')]));
  const o = await fake(scripted([ollamaOK('')]));
  const ai = createAI({
    config: makeConfig({ chain: ['bailian', 'ollama'], providers: { bailian: bailianCfg(b.baseUrl), ollama: ollamaCfg(o.baseUrl) } }),
    env: FAKE_ENV,
  });
  const r = await ai.answer(input());
  assert.deepEqual(r, { ok: false, reason: 'ai_error' });
  const s = ai.stats();
  assert.equal(s.chainExhausted, 1);
  assert.equal(s.success, 0);
  assert.equal(s.failed, 2);
});

// ---------------------------------------------------------------- 配置分支

test('ai.enabled=false → 立即 ai_disabled，零请求', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) }, ai: { enabled: false } }),
    env: FAKE_ENV,
  });
  assert.deepEqual(await ai.answer(input()), { ok: false, reason: 'ai_disabled' });
  assert.equal(srv.requestCount, 0);
  assert.equal(ai.stats().calls, 0);
});

test('链为空（缺 API Key）→ ai_error + stderr 中文提示只打一次', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  let ai;
  try {
    ai = createAI({
      config: makeConfig({ chain: ['bailian', 'openai'], providers: { bailian: bailianCfg(srv.baseUrl), openai: openaiCfg(srv.baseUrl) } }),
      env: {}, // 没有任何 Key
    });
    assert.deepEqual(ai.chain, []);
    assert.deepEqual(await ai.answer(input()), { ok: false, reason: 'ai_error' });
    assert.deepEqual(await ai.answer(input()), { ok: false, reason: 'ai_error' });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(srv.requestCount, 0);
  assert.equal(lines.length, 1, '空链提示只打一次');
  assert.ok(lines[0].includes('未配置任何可用 provider'), '提示文案不符：' + lines[0]);
  assert.ok(lines[0].includes('DASHSCOPE_API_KEY'));
  assert.ok(!lines[0].includes('敏感题干XYZ123'), 'stderr 不得出现题干');
});

test('未配置的 provider 被剔除；openai 默认不在链上但可用（DECISIONS #1）', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const ai = createAI({
    config: makeConfig({
      chain: ['bailian', 'ollama', 'openai'],
      providers: {
        bailian: bailianCfg(srv.baseUrl),
        ollama: { model: 'x' },        // 缺 baseUrl → 剔除
        openai: openaiCfg(srv.baseUrl), // 有 Key → 保留
      },
    }),
    env: FAKE_ENV,
  });
  assert.deepEqual(ai.chain, ['bailian', 'openai']);
  const ai2 = createAI({
    config: makeConfig({ chain: ['nosuch', 'bailian'], providers: { bailian: bailianCfg(srv.baseUrl) } }),
    env: FAKE_ENV,
  });
  assert.deepEqual(ai2.chain, ['bailian']);
});

// ---------------------------------------------------------------- 闸门集成

// T6/P0-7 裁决：gate 单层——由 server 在 answer() 外面包 gate.run()，AI 内部不得再包。
// 原「传入 gate：…」三条用例按单层语义重写（server.js 第 7 步的包裹方式与此处一致）。

test('P0-7 单层闸：外部 gate.run 包裹后并发被限制在 concurrency，超出的排队', async () => {
  let inflight = 0;
  let maxInflight = 0;
  const srv = await fake(() => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    const t = setTimeout(() => { inflight -= 1; }, 20);
    if (t.unref) t.unref();
    return { ...chatOK('A'), delayMs: 20 };
  });
  const gate = createGate({ concurrency: 2, queueLimit: 50, timeoutMs: 3000 });
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) } }),
    env: FAKE_ENV,
    gate,
  });
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 6 }, () => gate.run(() => ai.answer(input()))));
  assert.equal(results.filter((r) => r.ok).length, 6);
  assert.ok(maxInflight <= 2, '闸门应把并发压到 <= 2，实际 ' + maxInflight);
  assert.equal(srv.requestCount, 6);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(gate.stats().completed, 6);
  assert.ok(gate.stats().peak <= 2, 'gate.stats().peak 应 <= concurrency，实际 ' + gate.stats().peak);
  assert.ok(gate.stats().peak >= 1);
});

test('P0-7 单层闸：队列满 → gate reject queue_full，rejected 计数为单一事实来源（P1-6）', async () => {
  const srv = await fake(() => ({ ...chatOK('A'), delayMs: 60 }));
  const gate = createGate({ concurrency: 1, queueLimit: 0, timeoutMs: 3000 });
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) } }),
    env: FAKE_ENV,
    gate,
  });
  const rs = await Promise.allSettled([
    gate.run(() => ai.answer(input())),
    gate.run(() => ai.answer(input())),
    gate.run(() => ai.answer(input())),
  ]);
  const okCount = rs.filter((r) => r.status === 'fulfilled' && r.value.ok).length;
  const qf = rs.filter((r) => r.status === 'rejected' && r.reason && r.reason.code === 'queue_full').length;
  assert.equal(okCount, 1);
  assert.equal(qf, 2);
  assert.equal(gate.stats().rejected, 2, 'server /stats.ai.queueFull 直接取该值');
});

test('P0-7 单层闸：gate 超时 → reject ai_timeout（server 第 7 步 catch 转 reason）', async () => {
  const srv = await fake(() => ({ ...chatOK('A'), delayMs: 200 }));
  const gate = createGate({ concurrency: 1, queueLimit: 5, timeoutMs: 30 });
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) }, ai: { timeoutMs: 1500 } }),
    env: FAKE_ENV,
    gate,
  });
  await assert.rejects(
    () => gate.run(() => ai.answer(input())),
    (err) => err && err.code === 'ai_timeout',
  );
  assert.equal(gate.stats().timeouts >= 1, true);
});

test('P0-7 回归：注入 gate 后直接 answer() 不再产生任何闸门计数（双层闸已拆除）', async () => {
  const srv = await fake(() => chatOK('A'));
  const gate = createGate({ concurrency: 1, queueLimit: 0, timeoutMs: 3000 });
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) } }),
    env: FAKE_ENV,
    gate,
  });
  // 旧双层闸实现下：concurrency=1 + queueLimit=0，两个并发 answer 必有一个 queue_full/死锁。
  const [r1, r2] = await Promise.all([ai.answer(input()), ai.answer(input())]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  const s = gate.stats();
  assert.equal(s.completed, 0, 'AI 内部不得再走闸');
  assert.equal(s.inflight, 0);
  assert.equal(s.rejected, 0);
  assert.equal(ai.stats().queueFull, 0);
});

// ---------------------------------------------------------------- provider 单体

test('ollama：POST /api/chat，body/取字段符合契约，无需 apiKey', async () => {
  const srv = await fake(scripted([{
    status: 200,
    body: JSON.stringify({ model: 'qwen2.5:7b', message: { role: 'assistant', content: 'A#C' }, done: true, prompt_eval_count: 21, eval_count: 4 }),
  }]));
  assert.equal(ollama.isConfigured({ baseUrl: 'http://127.0.0.1:1' }), true);
  assert.equal(ollama.isConfigured({}), false);
  const ai = createAI({
    config: makeConfig({ chain: ['ollama'], providers: { ollama: ollamaCfg(srv.baseUrl) } }),
    env: {}, // 不给任何 Key 也能用
  });
  assert.deepEqual(ai.chain, ['ollama']);
  const r = await ai.answer(input({ type: '多选' }));
  assert.deepEqual(r, { ok: true, answer: 'A#C', provider: 'ollama', model: 'qwen2.5:7b', tokens: { in: 21, out: 4 } });
  const req = srv.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/api/chat');
  assert.equal(req.headers.authorization, undefined, 'ollama 不应发送 Authorization');
  const body = JSON.parse(req.body);
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'options', 'stream']);
  assert.equal(body.stream, false);
  assert.deepEqual(body.options, { temperature: 0 });
  assert.deepEqual(body.messages, buildMessages({ type: '多选', title: TITLE, options: OPTIONS }));
});

test('ollama：tokens 缺失记 0；message.content 缺失 → ai_error', async () => {
  const noTokens = await fake(scripted([{ status: 200, body: JSON.stringify({ message: { content: '正确' } }) }]));
  const ai = createAI({
    config: makeConfig({ chain: ['ollama'], providers: { ollama: ollamaCfg(noTokens.baseUrl) } }),
    env: {},
  });
  const r = await ai.answer(input({ type: '判断' }));
  assert.deepEqual(r.tokens, { in: 0, out: 0 });
  assert.equal(r.answer, '正确');

  const noMsg = await fake(scripted([{ status: 200, body: JSON.stringify({ done: true }) }]));
  const ai2 = createAI({
    config: makeConfig({ chain: ['ollama'], providers: { ollama: ollamaCfg(noMsg.baseUrl) } }),
    env: {},
  });
  assert.deepEqual(await ai2.answer(input()), { ok: false, reason: 'ai_error' });

  const errText = await fake(scripted([chatErr(404, { error: 'model "x" not found, try pulling it first' })]));
  const ai3 = createAI({
    config: makeConfig({ chain: ['ollama'], providers: { ollama: ollamaCfg(errText.baseUrl) } }),
    env: {},
  });
  assert.deepEqual(await ai3.answer(input()), { ok: false, reason: 'ai_error' });
});

test('openai provider：同构可用，默认模型 gpt-4o-mini，鉴权走 OPENAI_API_KEY', async () => {
  const srv = await fake(scripted([chatOK('B', { model: 'gpt-4o-mini-2024-07-18' })]));
  assert.equal(openai.name, 'openai');
  assert.equal(openai.isConfigured({ baseUrl: srv.baseUrl, apiKeyEnv: 'OPENAI_API_KEY' }, FAKE_ENV), true);
  assert.equal(openai.isConfigured({ baseUrl: srv.baseUrl, apiKeyEnv: 'OPENAI_API_KEY' }, {}), false);
  const res = await openai.chat(buildMessages(input()), {
    providerCfg: { baseUrl: srv.baseUrl, apiKeyEnv: 'OPENAI_API_KEY' },
    env: FAKE_ENV,
    timeoutMs: 2000,
  });
  assert.deepEqual(res, { text: 'B', model: 'gpt-4o-mini-2024-07-18', tokens: { in: 11, out: 7 } });
  const req = srv.requests[0];
  assert.equal(req.url, '/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer sk-xxxxxxxx');
  assert.equal(JSON.parse(req.body).model, 'gpt-4o-mini');

  const ai = createAI({
    config: makeConfig({ chain: ['openai'], providers: { openai: openaiCfg(srv.baseUrl) } }),
    env: FAKE_ENV,
  });
  const r = await ai.answer(input());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'openai');
  assert.equal(r.answer, 'B');
});

test('provider 层入参校验：缺 baseUrl / 缺 Key / messages 空 → ai_error', async () => {
  await assert.rejects(() => bailian.chat([{ role: 'user', content: 'x' }], { providerCfg: {}, env: FAKE_ENV }), (e) => e.code === 'ai_error');
  await assert.rejects(() => bailian.chat([{ role: 'user', content: 'x' }], { providerCfg: { baseUrl: 'http://127.0.0.1:1' }, apiKeyEnv: 'DASHSCOPE_API_KEY', env: {} }), (e) => e.code === 'ai_error');
  await assert.rejects(() => bailian.chat([{ role: 'user', content: 'x' }], { providerCfg: { baseUrl: 'http://127.0.0.1:1', apiKeyEnv: 'K' }, env: {} }), (e) => e.code === 'ai_error');
  await assert.rejects(() => bailian.chat([], { providerCfg: { baseUrl: 'http://127.0.0.1:1', apiKeyEnv: 'K' }, env: { K: 'sk-xxxxxxxx' } }), (e) => e.code === 'ai_error');
  await assert.rejects(() => ollama.chat([{ role: 'user', content: 'x' }], { providerCfg: {} }), (e) => e.code === 'ai_error');
  assert.equal(bailian.isConfigured(undefined, undefined), false);
  assert.equal(ollama.isConfigured(undefined), false);
  assert.equal(openai.isConfigured(undefined, undefined), false);
});

// ---------------------------------------------------------------- answer() 永不抛

test('answer() 永不抛、永不 reject：畸形入参 / 畸形配置 / provider 抛非 Error', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) } }),
    env: FAKE_ENV,
  });
  for (const bad of [undefined, null, {}, { type: null, title: null, options: null }, 'string', 42]) {
    const r = await ai.answer(bad);
    assert.equal(typeof r, 'object');
    assert.equal(typeof r.ok, 'boolean');
    if (!r.ok) assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  }
  for (const cfg of [undefined, null, {}, { ai: null, providers: null }, { ai: { fallback: 'not-array' }, providers: {} }]) {
    const a = createAI({ config: cfg, env: FAKE_ENV });
    const r = await a.answer(input());
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
  }
  const throwing = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl, { fetchImpl: () => { throw 'not-an-error'; } }) } }),
    env: FAKE_ENV,
  });
  const r = await throwing.answer(input());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ai_error');
});

test('log 回调抛异常不影响主流程', async () => {
  const bad = await fake(scripted([chatErr(400, { code: 'DataInspectionFailed' })]));
  const good = await fake(scripted([ollamaOK('A')]));
  const evilLog = {
    moderation() { throw new Error('logger down'); },
    error() { throw new Error('logger down'); },
    info() { throw new Error('logger down'); },
  };
  const ai = createAI({
    config: makeConfig({ chain: ['bailian', 'ollama'], providers: { bailian: bailianCfg(bad.baseUrl), ollama: ollamaCfg(good.baseUrl) } }),
    env: FAKE_ENV,
    log: evilLog,
  });
  const r = await ai.answer(input());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'ollama');
  assert.equal(ai.stats().moderation, 1);
});

test('stats() 返回副本，外部修改不污染内部状态', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) } }),
    env: FAKE_ENV,
  });
  await ai.answer(input());
  const s1 = ai.stats();
  s1.calls = 999;
  s1.byProvider.bailian.success = 999;
  ai.chain.push('hacked');
  const s2 = ai.stats();
  assert.equal(s2.calls, 1);
  assert.equal(s2.byProvider.bailian.success, 1);
  assert.deepEqual(ai.chain, ['bailian']);
});

test('连续多题：计数累加正确', async () => {
  const answers = ['A', 'B', 'C'];
  let i = 0;
  const srv = await fake(() => chatOK(answers[i++]));
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: bailianCfg(srv.baseUrl) } }),
    env: FAKE_ENV,
  });
  const titles = ['题目一UNIQ', '题目二UNIQ', '题目三UNIQ'];
  for (let n = 0; n < 3; n += 1) {
    const r = await ai.answer(input({ title: titles[n] }));
    assert.equal(r.ok, true);
    assert.equal(r.answer, answers[n]);
  }
  const s = ai.stats();
  assert.equal(s.calls, 3);
  assert.equal(s.success, 3);
  assert.equal(s.byProvider.bailian.calls, 3);
  assert.equal(s.tokensIn, 33);
  assert.equal(s.tokensOut, 21);
  assert.deepEqual(srv.requests.map((rq) => JSON.parse(rq.body).messages[1].content.includes('题干：')), [true, true, true]);
  await sleep(1);
});