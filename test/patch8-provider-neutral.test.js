// test/patch8-provider-neutral.test.js — Patch 8：AI 层 provider 中立化（Owner: T2）
//
// 纪律（CONTRACT §11）：
//   - 假 provider 全部 node:http + listen(0)，绝不联网、绝不监听 8080/11434；
//   - 预置实例一律把 baseUrl 覆盖到本地假 provider（预置默认 URL 只用于纯解析断言，不发请求）；
//   - Key 一律占位 sk-xxxxxxxx；退避/超时用注入毫秒级参数，无真实 sleep > 200ms；
//   - loadConfig 用例走 os.tmpdir() 临时目录（前缀 qbank-p8-），不读仓库 config.json；
//   - after() 关闭全部 server 并清理临时目录。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAI, isModerationError, MODERATION_CODES } from '../lib/ai/index.js';
import openai from '../lib/ai/openai.js';
import bailian from '../lib/ai/bailian.js';
import { PRESETS, MODERATION_SIGNATURES, signatureFor, resolveInstance } from '../lib/ai/presets.js';
import { loadConfig } from '../config.js';
import { buildMessages } from '../lib/prompt.js';
import { createFakeProvider, chatOK, chatErr, ollamaOK, scripted } from './stubs/t2-fakeProvider.js';
import { createFakeLog, makeConfig, FAKE_ENV } from './stubs/t2-fakeLog.js';

const TITLE = 'Patch8敏感题干P8UNIQ：以下哪项正确？';
const OPTIONS = ['A.甲P8U1', 'B.乙P8U2', 'C.丙P8U3'];
const KEY = 'p8key1234567890p8key1234567890p8key1234567890p8key1234567890p8k';

const ALL_KEYS = Object.freeze({
  ...FAKE_ENV,
  DEEPSEEK_API_KEY: 'sk-xxxxxxxx',
  MOONSHOT_API_KEY: 'sk-xxxxxxxx',
  ZHIPU_API_KEY: 'sk-xxxxxxxx',
  SILICONFLOW_API_KEY: 'sk-xxxxxxxx',
  OPENROUTER_API_KEY: 'sk-xxxxxxxx',
});

const servers = [];
const dirs = [];
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
  for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function input(over = {}) {
  return { key: KEY, type: '单选', title: TITLE, options: OPTIONS, ...over };
}
function captureStderr(fn) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { return { out: fn(), lines }; } finally { process.stderr.write = original; }
}
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-p8-'));
  dirs.push(d);
  return d;
}
function writeCfg(dir, obj) {
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

// ---------------------------------------------------------------- 预置表与解析

test('PRESETS：11 个预置齐全，impl 均为 openai，baseUrl/model 与厂商文档一致', () => {
  const names = Object.keys(PRESETS).sort();
  assert.deepEqual(names, [
    'dashscope', 'deepseek', 'kimi', 'lmstudio', 'ollama-openai', 'openai',
    'openrouter', 'siliconflow', 'vllm', 'xinference', 'zhipu',
  ].sort());
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.equal(p.impl, 'openai', name);
    assert.equal(typeof p.baseUrl, 'string', name);
    assert.ok(p.baseUrl.length > 0, name);
    assert.equal(typeof p.model, 'string', name);
  }
  assert.equal(PRESETS.dashscope.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(PRESETS.dashscope.model, 'qwen-flash');
  assert.equal(PRESETS.dashscope.apiKeyEnv, 'DASHSCOPE_API_KEY');
  assert.equal(PRESETS.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(PRESETS.openai.model, 'gpt-4o-mini');
  assert.equal(PRESETS.openai.apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(PRESETS.deepseek.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(PRESETS.kimi.baseUrl, 'https://api.moonshot.cn/v1');
  assert.equal(PRESETS.zhipu.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(PRESETS.siliconflow.model, 'Qwen/Qwen2.5-7B-Instruct');
  for (const n of ['lmstudio', 'vllm', 'xinference', 'ollama-openai']) {
    assert.equal(PRESETS[n].apiKeyEnv, undefined, n);
    assert.ok(PRESETS[n].baseUrl.startsWith('http://127.0.0.1:'), n);
  }
  assert.equal(PRESETS['ollama-openai'].baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(Object.keys(MODERATION_SIGNATURES).length, 7);
  assert.equal(signatureFor('lmstudio'), undefined);
  assert.equal(signatureFor('nosuch'), undefined);
  assert.equal(signatureFor(undefined), undefined);
});

test('resolveInstance：名字推断——bailian/openai 补预置默认，ollama 不补 baseUrl，自定义名原样', () => {
  const b = resolveInstance('bailian', {});
  assert.equal(b.ok, true);
  assert.equal(b.impl, 'openai');
  assert.equal(b.preset, 'dashscope');
  assert.equal(b.cfg.baseUrl, PRESETS.dashscope.baseUrl);
  assert.equal(b.cfg.apiKeyEnv, 'DASHSCOPE_API_KEY');
  assert.equal(b.cfg.model, 'qwen-flash');

  const o = resolveInstance('openai', {});
  assert.equal(o.preset, 'openai');
  assert.equal(o.cfg.model, 'gpt-4o-mini');

  const ol = resolveInstance('ollama', { model: 'x' });
  assert.equal(ol.ok, true);
  assert.equal(ol.impl, 'ollama');
  assert.equal(ol.preset, undefined);
  assert.equal(ol.cfg.baseUrl, undefined, 'ollama 名字推断不得补 baseUrl（缺 baseUrl 必须被剔除）');

  const x = resolveInstance('my-vendor', { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' });
  assert.equal(x.ok, true);
  assert.equal(x.impl, 'openai');
  assert.equal(x.preset, undefined);
  assert.equal(x.cfg.baseUrl, 'http://127.0.0.1:9/v1');
  assert.equal(x.cfg.apiKeyEnv, undefined, '自定义名不推断 Key');
});

test('resolveInstance：显式 preset 提供全默认且可被 raw 覆盖；显式 impl 优先', () => {
  const d = resolveInstance('any-name', { preset: 'deepseek' });
  assert.equal(d.ok, true);
  assert.equal(d.impl, 'openai');
  assert.equal(d.cfg.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(d.cfg.model, 'deepseek-chat');
  assert.equal(d.cfg.apiKeyEnv, 'DEEPSEEK_API_KEY');

  const ov = resolveInstance('any-name', { preset: 'kimi', model: 'moonshot-v1-32k', baseUrl: 'http://127.0.0.1:9/v1' });
  assert.equal(ov.cfg.model, 'moonshot-v1-32k');
  assert.equal(ov.cfg.baseUrl, 'http://127.0.0.1:9/v1');
  assert.equal(ov.cfg.apiKeyEnv, 'MOONSHOT_API_KEY');

  const im = resolveInstance('openai', { impl: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
  assert.equal(im.impl, 'ollama');
  assert.equal(im.preset, undefined);
  assert.equal(im.cfg.model, undefined, '显式 impl 不带预置默认');

  const ok = resolveInstance('x', { impl: 'openai', preset: 'zhipu' });
  assert.equal(ok.ok, true);
  assert.equal(ok.cfg.model, 'glm-4-flash');
});

test('resolveInstance：未知 impl / 未知 preset / impl-preset 冲突 → ok:false + stderr 警告一次（只含名字/错误码）', () => {
  const { out, lines } = captureStderr(() => {
    const a1 = resolveInstance('bad-impl-a', { impl: 'azure' });
    const a2 = resolveInstance('bad-impl-a', { impl: 'azure' });
    const b1 = resolveInstance('bad-preset-a', { preset: 'nosuch' });
    const c1 = resolveInstance('conflict-a', { impl: 'ollama', preset: 'deepseek' });
    const d1 = resolveInstance('bad-impl-num', { impl: 42 });
    return [a1, a2, b1, c1, d1];
  });
  assert.deepEqual(out.map((r) => r.ok), [false, false, false, false, false]);
  assert.deepEqual(out.map((r) => r.errorCode), [
    'unknown_impl', 'unknown_impl', 'unknown_preset', 'impl_preset_conflict', 'unknown_impl',
  ]);
  assert.equal(lines.length, 4, '每个名字只警告一次，实际：' + JSON.stringify(lines));
  assert.ok(lines[0].includes('bad-impl-a') && lines[0].includes('unknown_impl'));
  assert.ok(lines[1].includes('bad-preset-a') && lines[1].includes('unknown_preset'));
  assert.ok(lines[2].includes('conflict-a') && lines[2].includes('impl_preset_conflict'));
  for (const l of lines) {
    assert.ok(!l.includes('sk-'), '警告不得含 Key');
    assert.ok(!l.includes(TITLE), '警告不得含题干');
  }
  for (const bad of [undefined, null, 'str', 42, []]) {
    const r = resolveInstance('weird', bad);
    assert.equal(typeof r.ok, 'boolean');
  }
});

// ---------------------------------------------------------------- 路由层：旧配置兼容与实例名

test('createAI：名字推断最小配置（无 model 字段）→ 预置默认生效，请求形状与旧版一致', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const ai = createAI({
    config: makeConfig({ chain: ['bailian'], providers: { bailian: { baseUrl: srv.baseUrl, apiKeyEnv: 'DASHSCOPE_API_KEY' } } }),
    env: FAKE_ENV,
  });
  assert.deepEqual(ai.chain, ['bailian']);
  const r = await ai.answer(input());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'bailian');
  const body = JSON.parse(srv.requests[0].body);
  assert.equal(body.model, 'qwen-flash');
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 64);
  assert.equal(body.stream, false);
  assert.equal(srv.requests[0].headers.authorization, 'Bearer sk-xxxxxxxx');

  const srv2 = await fake(scripted([chatOK('B')]));
  const ai2 = createAI({
    config: makeConfig({ chain: ['openai'], providers: { openai: { baseUrl: srv2.baseUrl, apiKeyEnv: 'OPENAI_API_KEY' } } }),
    env: FAKE_ENV,
  });
  assert.equal((await ai2.answer(input())).ok, true);
  assert.equal(JSON.parse(srv2.requests[0].body).model, 'gpt-4o-mini');
});

test('createAI：任意实例名 + 一条配置即可入链（零代码改动接兼容厂商）', async () => {
  const srv = await fake(scripted([chatOK('C')]));
  const ai = createAI({
    config: makeConfig({
      chain: ['vendor-x'],
      providers: { 'vendor-x': { baseUrl: srv.baseUrl, model: 'some-compatible-model' } },
    }),
    env: {},
  });
  assert.deepEqual(ai.chain, ['vendor-x']);
  const r = await ai.answer(input());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'vendor-x');
  assert.equal(r.model, 'stub-model');
  assert.equal(JSON.parse(srv.requests[0].body).model, 'some-compatible-model');
  assert.equal(srv.requests[0].headers.authorization, undefined, '无 apiKeyEnv 不发鉴权头');
  assert.deepEqual(Object.keys(ai.stats().byProvider), ['vendor-x']);
});

// ---------------------------------------------------------------- 协议开关请求形状

test('maxTokensParam：max_completion_tokens 生效；其他值一律 max_tokens', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const ai = createAI({
    config: makeConfig({
      chain: ['o1'],
      providers: { o1: { impl: 'openai', baseUrl: srv.baseUrl, apiKeyEnv: 'OPENAI_API_KEY', maxTokensParam: 'max_completion_tokens', maxTokens: 128 } },
    }),
    env: FAKE_ENV,
  });
  assert.equal((await ai.answer(input())).ok, true);
  const body = JSON.parse(srv.requests[0].body);
  assert.equal(body.max_completion_tokens, 128);
  assert.equal(body.max_tokens, undefined);

  const srv2 = await fake(scripted([chatOK('A')]));
  const ai2 = createAI({
    config: makeConfig({
      chain: ['o2'],
      providers: { o2: { impl: 'openai', baseUrl: srv2.baseUrl, maxTokensParam: 'bogus' } },
    }),
    env: {},
  });
  assert.equal((await ai2.answer(input())).ok, true);
  const body2 = JSON.parse(srv2.requests[0].body);
  assert.equal(body2.max_tokens, 64);
  assert.equal(body2.max_completion_tokens, undefined);
});

test('omitTemperature：true → body 无 temperature 字段，其余字段不变', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const ai = createAI({
    config: makeConfig({
      chain: ['o1'],
      providers: { o1: { impl: 'openai', baseUrl: srv.baseUrl, omitTemperature: true } },
    }),
    env: {},
  });
  assert.equal((await ai.answer(input())).ok, true);
  const body = JSON.parse(srv.requests[0].body);
  assert.equal(body.temperature, undefined);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream']);
});

test('extraHeaders + apiKeyHeader + query：Azure 风格请求形状（自定义头裸 Key、URL 带 api-version）', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const ai = createAI({
    config: makeConfig({
      chain: ['azure-like'],
      providers: {
        'azure-like': {
          impl: 'openai', baseUrl: srv.baseUrl, apiKeyEnv: 'OPENAI_API_KEY',
          apiKeyHeader: 'api-key',
          extraHeaders: { 'X-Title': 'qbank', 'HTTP-Referer': 'http://127.0.0.1' },
          query: { 'api-version': '2024-06-01' },
        },
      },
    }),
    env: FAKE_ENV,
  });
  assert.equal((await ai.answer(input())).ok, true);
  const req = srv.requests[0];
  assert.equal(req.url, '/chat/completions?api-version=2024-06-01');
  assert.equal(req.headers['api-key'], 'sk-xxxxxxxx');
  assert.equal(req.headers.authorization, undefined, '自定义 apiKeyHeader 时不再发 Bearer');
  assert.equal(req.headers['x-title'], 'qbank');
  assert.equal(req.headers['http-referer'], 'http://127.0.0.1');
  assert.equal(req.headers['content-type'], 'application/json');
});

test('本地预置 lmstudio / ollama-openai：免 Key，ollama-openai 走 /v1/chat/completions 而非 /api/chat', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const ai = createAI({
    config: makeConfig({
      chain: ['local-lm'],
      providers: { 'local-lm': { preset: 'lmstudio', baseUrl: srv.baseUrl } },
    }),
    env: {},
  });
  assert.deepEqual(ai.chain, ['local-lm']);
  assert.equal((await ai.answer(input())).ok, true);
  assert.equal(srv.requests[0].headers.authorization, undefined);
  assert.equal(srv.requests[0].url, '/chat/completions');

  const srv2 = await fake(scripted([chatOK('B')]));
  const ai2 = createAI({
    config: makeConfig({
      chain: ['ol-v1'],
      providers: { 'ol-v1': { preset: 'ollama-openai', baseUrl: srv2.baseUrl } },
    }),
    env: {},
  });
  assert.equal((await ai2.answer(input())).ok, true);
  const req = srv2.requests[0];
  assert.equal(req.url, '/chat/completions');
  assert.equal(req.headers.authorization, undefined);
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'qwen2.5:7b');
  assert.equal(body.max_tokens, 64);
});

// ---------------------------------------------------------------- 各家审核签名

test('deepseek：400 文案 Content Exists Risk（无错误码）→ ai_moderation 切链，日志只含 key/码/实例名', async () => {
  const bad = await fake(scripted([chatErr(400, { error: { message: 'Content Exists Risk' } })]));
  const good = await fake(scripted([ollamaOK('A')]));
  const log = createFakeLog();
  const ai = createAI({
    config: makeConfig({
      chain: ['ds', 'ollama'],
      providers: {
        ds: { preset: 'deepseek', baseUrl: bad.baseUrl, apiKeyEnv: 'DEEPSEEK_API_KEY', retryBaseMs: 5 },
        ollama: { baseUrl: good.baseUrl, retryBaseMs: 5 },
      },
    }),
    env: ALL_KEYS,
    log,
  });
  const r = await ai.answer(input());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'ollama');
  assert.equal(bad.requestCount, 1, '审核不重试同 provider');
  assert.equal(log.calls.moderation.length, 1);
  assert.equal(log.calls.moderation[0].provider, 'ds');
  assert.equal(log.calls.moderation[0].code, 'content_filter');
  assert.equal(log.calls.moderation[0].key, KEY);
  const dump = log.dump();
  assert.ok(!dump.includes('P8UNIQ') && !dump.includes('P8U1') && !dump.includes('sk-xxxxxxxx'));
  assert.equal(ai.stats().byProvider.ds.moderation, 1);
});

test('kimi：400 error.type/code content_filter → 审核；zhipu：400 数字码 1301 → 审核（detailCode 字符串化）', async () => {
  const kimiBad = await fake(scripted([chatErr(400, { error: { type: 'content_filter', code: 'content_filter', message: 'The request was rejected because it was considered high risk' } })]));
  const good1 = await fake(scripted([ollamaOK('A')]));
  const log1 = createFakeLog();
  const ai1 = createAI({
    config: makeConfig({
      chain: ['kimi-inst', 'ollama'],
      providers: {
        'kimi-inst': { preset: 'kimi', baseUrl: kimiBad.baseUrl, apiKeyEnv: 'MOONSHOT_API_KEY', retryBaseMs: 5 },
        ollama: { baseUrl: good1.baseUrl },
      },
    }),
    env: ALL_KEYS,
    log: log1,
  });
  const r1 = await ai1.answer(input());
  assert.equal(r1.ok, true);
  assert.equal(r1.provider, 'ollama');
  assert.equal(log1.calls.moderation[0].provider, 'kimi-inst');
  assert.equal(log1.calls.moderation[0].code, 'content_filter');

  const zhipuBad = await fake(scripted([chatErr(400, { code: 1301, message: '系统检测到输入或生成内容可能包含不安全或敏感内容' })]));
  const good2 = await fake(scripted([ollamaOK('B')]));
  const log2 = createFakeLog();
  const ai2 = createAI({
    config: makeConfig({
      chain: ['zp', 'ollama'],
      providers: {
        zp: { preset: 'zhipu', baseUrl: zhipuBad.baseUrl, apiKeyEnv: 'ZHIPU_API_KEY', retryBaseMs: 5 },
        ollama: { baseUrl: good2.baseUrl },
      },
    }),
    env: ALL_KEYS,
    log: log2,
  });
  const r2 = await ai2.answer(input());
  assert.equal(r2.ok, true);
  assert.equal(r2.provider, 'ollama');
  assert.equal(log2.calls.moderation[0].code, '1301');
  assert.equal(ai2.stats().byProvider.zp.moderation, 1);
});

test('finish_reason：200 + content_filter 协议级审核（无预置也生效）；zhipu sensitive 仅预置签名生效', async () => {
  const cf = await fake(scripted([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }) }]));
  const good = await fake(scripted([ollamaOK('A')]));
  const log = createFakeLog();
  const ai = createAI({
    config: makeConfig({
      chain: ['plain', 'ollama'],
      providers: { plain: { impl: 'openai', baseUrl: cf.baseUrl }, ollama: { baseUrl: good.baseUrl } },
    }),
    env: {},
    log,
  });
  const r = await ai.answer(input());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'ollama');
  assert.equal(log.calls.moderation.length, 1);
  assert.equal(log.calls.moderation[0].code, 'content_filter');
  assert.equal(ai.stats().moderation, 1);

  const dsCf = await fake(scripted([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'content_filter' }] }) }]));
  const good2 = await fake(scripted([ollamaOK('B')]));
  const ai2 = createAI({
    config: makeConfig({
      chain: ['ds', 'ollama'],
      providers: { ds: { preset: 'deepseek', baseUrl: dsCf.baseUrl, apiKeyEnv: 'DEEPSEEK_API_KEY' }, ollama: { baseUrl: good2.baseUrl } },
    }),
    env: ALL_KEYS,
  });
  assert.equal((await ai2.answer(input())).provider, 'ollama');
  assert.equal(ai2.stats().byProvider.ds.moderation, 1);

  const zpS = await fake(scripted([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'x' }, finish_reason: 'sensitive' }] }) }]));
  const good3 = await fake(scripted([ollamaOK('C')]));
  const ai3 = createAI({
    config: makeConfig({
      chain: ['zp', 'ollama'],
      providers: { zp: { preset: 'zhipu', baseUrl: zpS.baseUrl, apiKeyEnv: 'ZHIPU_API_KEY' }, ollama: { baseUrl: good3.baseUrl } },
    }),
    env: ALL_KEYS,
  });
  assert.equal((await ai3.answer(input())).provider, 'ollama');
  assert.equal(ai3.stats().byProvider.zp.moderation, 1);

  const plainS = await fake(scripted([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'A' }, finish_reason: 'sensitive' }] }) }]));
  const ai4 = createAI({
    config: makeConfig({ chain: ['plain'], providers: { plain: { impl: 'openai', baseUrl: plainS.baseUrl } } }),
    env: {},
  });
  const r4 = await ai4.answer(input());
  assert.equal(r4.ok, true);
  assert.equal(r4.answer, 'A');
  assert.equal(ai4.stats().moderation, 0);
});

test('siliconflow 关键词签名 / openrouter 透传上游码 → 审核；认不出的 400 仍 ai_error 切链（fail-closed）', async () => {
  const sfBad = await fake(scripted([chatErr(400, { error: { message: 'Your request contains sensitive content' } })]));
  const good = await fake(scripted([ollamaOK('A')]));
  const ai = createAI({
    config: makeConfig({
      chain: ['sf', 'ollama'],
      providers: { sf: { preset: 'siliconflow', baseUrl: sfBad.baseUrl, apiKeyEnv: 'SILICONFLOW_API_KEY' }, ollama: { baseUrl: good.baseUrl } },
    }),
    env: ALL_KEYS,
  });
  assert.equal((await ai.answer(input())).provider, 'ollama');
  assert.equal(ai.stats().byProvider.sf.moderation, 1);

  const orBad = await fake(scripted([chatErr(400, { error: { code: 'content_policy_violation' } })]));
  const good2 = await fake(scripted([ollamaOK('B')]));
  const ai2 = createAI({
    config: makeConfig({
      chain: ['or', 'ollama'],
      providers: { or: { preset: 'openrouter', baseUrl: orBad.baseUrl, apiKeyEnv: 'OPENROUTER_API_KEY' }, ollama: { baseUrl: good2.baseUrl } },
    }),
    env: ALL_KEYS,
  });
  assert.equal((await ai2.answer(input())).provider, 'ollama');
  assert.equal(ai2.stats().byProvider.or.moderation, 1);

  const plainBad = await fake(scripted([chatErr(400, { error: { code: 'invalid_request', message: 'bad param' } })]));
  const good3 = await fake(scripted([ollamaOK('C')]));
  const log3 = createFakeLog();
  const ai3 = createAI({
    config: makeConfig({
      chain: ['ds', 'ollama'],
      providers: { ds: { preset: 'deepseek', baseUrl: plainBad.baseUrl, apiKeyEnv: 'DEEPSEEK_API_KEY' }, ollama: { baseUrl: good3.baseUrl } },
    }),
    env: ALL_KEYS,
    log: log3,
  });
  const r3 = await ai3.answer(input());
  assert.equal(r3.ok, true);
  assert.equal(r3.provider, 'ollama');
  assert.equal(log3.calls.moderation.length, 0);
  assert.equal(ai3.stats().byProvider.ds.moderation, 0);
  assert.equal(ai3.stats().byProvider.ds.failed, 1);
});

test('isModerationError：第二参实例级签名；单参行为逐字不变；MODERATION_CODES 仍恰为 3 码', () => {
  assert.deepEqual([...MODERATION_CODES], [
    'DataInspectionFailed', 'InvalidParameter.DataInspection', 'InternalError.Algo.DataInspectionFailed',
  ]);
  assert.equal(isModerationError({ code: 1301 }, 'zhipu'), true);
  assert.equal(isModerationError({ code: '1301' }, 'zhipu'), true);
  assert.equal(isModerationError({ status: 400, message: 'Content Exists Risk' }, 'deepseek'), true);
  assert.equal(isModerationError({ error: { type: 'content_filter' } }, 'kimi'), true);
  assert.equal(isModerationError({ error: { innererror: { code: 'ResponsibleAIPolicyViolation' } } }, 'openai'), true);
  assert.equal(isModerationError({ body: { code: 'content_policy_violation' } }, 'openrouter'), true);
  assert.equal(isModerationError({ code: 'X1' }, { codes: ['X1'] }), true);
  assert.equal(isModerationError({ status: 400, message: 'blocked by kw' }, { keywords: ['blocked by kw'] }), true);
  assert.equal(isModerationError({ code: 1301 }), false);
  assert.equal(isModerationError({ status: 400, message: 'Content Exists Risk' }), false);
  assert.equal(isModerationError({ error: { type: 'content_filter' } }), false);
  assert.equal(isModerationError({ code: 'InvalidApiKey', status: 401 }), false);
  assert.equal(isModerationError({ status: 429, message: 'Requests rate limit exceeded' }), false);
  assert.equal(isModerationError({ status: 400, message: 'bad param' }), false);
  assert.equal(isModerationError(null), false);
  assert.equal(isModerationError('DataInspectionFailed'), false);
  assert.equal(isModerationError({ code: 'DataInspectionFailed' }, 'deepseek'), true);
  assert.equal(isModerationError({ status: 500, message: 'data inspection failed' }, 'kimi'), true);
});

// ---------------------------------------------------------------- 429 / 超时 / 空 content / 多实例链

test('预置实例 429：退避可注入（retryBaseMs=5），3 次请求后切链，elapsed < 200ms', async () => {
  const throttled = await fake(scripted([chatErr(429, { error: { code: 'Throttling' } })]));
  const good = await fake(scripted([ollamaOK('A')]));
  const ai = createAI({
    config: makeConfig({
      chain: ['ds', 'ollama'],
      providers: {
        ds: { preset: 'deepseek', baseUrl: throttled.baseUrl, apiKeyEnv: 'DEEPSEEK_API_KEY', retryBaseMs: 5 },
        ollama: { baseUrl: good.baseUrl },
      },
    }),
    env: ALL_KEYS,
  });
  const t0 = Date.now();
  const r = await ai.answer(input());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'ollama');
  assert.equal(throttled.requestCount, 3);
  assert.ok(Date.now() - t0 < 200);
});

test('预置实例超时 / 空 content：ai_timeout 与 ai_error 计数落在实例名上', async () => {
  const slow = await fake(scripted([{ status: 200, body: '{}', delayMs: 300 }]));
  const ai = createAI({
    config: makeConfig({
      chain: ['ds-slow'],
      providers: { 'ds-slow': { preset: 'deepseek', baseUrl: slow.baseUrl, apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      ai: { timeoutMs: 40 },
    }),
    env: ALL_KEYS,
  });
  assert.deepEqual(await ai.answer(input()), { ok: false, reason: 'ai_timeout' });
  assert.equal(ai.stats().byProvider['ds-slow'].timeout, 1);

  const empty = await fake(scripted([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: '  ' }, finish_reason: 'stop' }] }) }]));
  const ai2 = createAI({
    config: makeConfig({
      chain: ['kimi-empty'],
      providers: { 'kimi-empty': { preset: 'kimi', baseUrl: empty.baseUrl, apiKeyEnv: 'MOONSHOT_API_KEY' } },
    }),
    env: ALL_KEYS,
  });
  assert.deepEqual(await ai2.answer(input()), { ok: false, reason: 'ai_error' });
  assert.equal(ai2.stats().byProvider['kimi-empty'].failed, 1);
  assert.equal(ai2.stats().byProvider['kimi-empty'].moderation, 0);
});

test('多实例链：顺序正确，stats/byProvider、日志、err.provider 一律以实例名为键', async () => {
  const a = await fake(scripted([chatErr(400, { error: { message: 'Content Exists Risk' } })]));
  const b = await fake(scripted([chatErr(401, { error: { code: 'InvalidApiKey' } })]));
  const c = await fake(scripted([chatOK('A')]));
  const log = createFakeLog();
  const ai = createAI({
    config: makeConfig({
      chain: ['ds-a', 'kimi-b', 'local-c'],
      providers: {
        'ds-a': { preset: 'deepseek', baseUrl: a.baseUrl, apiKeyEnv: 'DEEPSEEK_API_KEY', retryBaseMs: 5 },
        'kimi-b': { preset: 'kimi', baseUrl: b.baseUrl, apiKeyEnv: 'MOONSHOT_API_KEY', retryBaseMs: 5 },
        'local-c': { preset: 'lmstudio', baseUrl: c.baseUrl },
      },
    }),
    env: ALL_KEYS,
    log,
  });
  assert.deepEqual(ai.chain, ['ds-a', 'kimi-b', 'local-c']);
  const r = await ai.answer(input());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'local-c');
  assert.equal(a.requestCount, 1);
  assert.equal(b.requestCount, 1);
  assert.equal(c.requestCount, 1);
  const s = ai.stats();
  assert.deepEqual(Object.keys(s.byProvider), ['ds-a', 'kimi-b', 'local-c']);
  assert.equal(s.calls, 3);
  assert.equal(s.byProvider['ds-a'].moderation, 1);
  assert.equal(s.byProvider['kimi-b'].failed, 1);
  assert.equal(s.byProvider['local-c'].success, 1);
  assert.equal(log.calls.moderation[0].provider, 'ds-a');
  assert.ok(log.calls.error.some((e) => e.scope === 'kimi-b' && e.errCode === 'ai_error'));
  assert.ok(log.calls.info.some((e) => e.scope === 'local-c'));

  await assert.rejects(
    () => openai.chat(buildMessages(input()), {
      providerCfg: { baseUrl: 'http://127.0.0.1:9/v1', fetchImpl: () => Promise.reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })) },
      providerName: 'kimi-b',
      env: {},
    }),
    (err) => {
      assert.equal(err.code, 'ai_error');
      assert.equal(err.provider, 'kimi-b');
      assert.ok(err.message.includes('[qbank][kimi-b]'));
      return true;
    },
  );
});

test('createAI：未知 impl/preset 的实例被剔除 + 警告一次，其余实例照常工作，永不崩溃', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const { out: ai, lines } = captureStderr(() => createAI({
    config: makeConfig({
      chain: ['ghost-impl', 'ghost-preset', 'good'],
      providers: {
        'ghost-impl': { impl: 'azure', baseUrl: srv.baseUrl },
        'ghost-preset': { preset: 'nosuch', baseUrl: srv.baseUrl },
        good: { impl: 'openai', baseUrl: srv.baseUrl },
      },
    }),
    env: {},
  }));
  assert.deepEqual(ai.chain, ['good']);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('ghost-impl') && lines[0].includes('unknown_impl'));
  assert.ok(lines[1].includes('ghost-preset') && lines[1].includes('unknown_preset'));
  const r = await ai.answer(input());
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'good');
  assert.equal(srv.requestCount, 1);
});

// ---------------------------------------------------------------- bailian 薄壳兼容

test('bailian 薄壳：委托通用体，参数默认 qwen-flash/0/64，缺 baseUrl 抛 ai_error 不联网，审核码不变', async () => {
  const srv = await fake(scripted([chatOK('A')]));
  const res = await bailian.chat(buildMessages(input()), {
    providerCfg: { baseUrl: srv.baseUrl, apiKeyEnv: 'DASHSCOPE_API_KEY' },
    env: FAKE_ENV,
    timeoutMs: 2000,
  });
  assert.equal(res.text, 'A');
  const body = JSON.parse(srv.requests[0].body);
  assert.equal(body.model, 'qwen-flash');
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 64);

  await assert.rejects(
    () => bailian.chat([{ role: 'user', content: 'x' }], { providerCfg: {}, env: FAKE_ENV }),
    (err) => err.code === 'ai_error' && err.provider === 'bailian',
  );
  assert.equal(bailian.isConfigured({ baseUrl: 'http://127.0.0.1:1', apiKeyEnv: 'DASHSCOPE_API_KEY' }, FAKE_ENV), true);
  assert.equal(bailian.isConfigured({ baseUrl: 'http://127.0.0.1:1', apiKeyEnv: 'DASHSCOPE_API_KEY' }, {}), false);
  assert.equal(bailian.isConfigured(undefined, undefined), false);

  const mod = await fake(scripted([chatErr(400, { code: 'DataInspectionFailed' })]));
  await assert.rejects(
    () => bailian.chat(buildMessages(input()), { providerCfg: { baseUrl: mod.baseUrl, apiKeyEnv: 'DASHSCOPE_API_KEY' }, env: FAKE_ENV }),
    (err) => err.code === 'ai_moderation' && err.detailCode === 'DataInspectionFailed' && err.provider === 'bailian',
  );
});

// ---------------------------------------------------------------- config.js：保留任意条目 + preset 感知剔除

test('loadConfig：自定义实例名不再被丢弃；preset 感知剔除（裸 preset 缺 Key 剔除、本地预置免 Key 保留）', () => {
  const dir = tmpDir();
  const p = writeCfg(dir, {
    ai: { enabled: true, fallback: ['bailian', 'my-ds', 'my-local', 'custom'] },
    providers: {
      bailian: {},
      'my-ds': { preset: 'deepseek' },
      'my-local': { preset: 'lmstudio' },
      custom: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' },
    },
  });
  const { out: cfg, lines } = captureStderr(() => loadConfig({ path: p, cwd: dir, env: { DASHSCOPE_API_KEY: 'sk-xxxxxxxx' }, loadDotEnv: false }));
  assert.deepEqual(cfg.providers['my-ds'], { preset: 'deepseek' });
  assert.deepEqual(cfg.providers['my-local'], { preset: 'lmstudio' });
  assert.equal(cfg.providers.custom.baseUrl, 'http://127.0.0.1:9/v1');
  assert.equal(cfg.providers.bailian.model, 'qwen-flash');
  assert.equal(cfg.providers.ollama.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(cfg.providers.openai.model, 'gpt-4o-mini');
  assert.deepEqual(cfg.ai.fallback, ['bailian', 'my-local', 'custom']);
  assert.ok(lines.some((l) => l.includes('no_key_my-ds') && l.includes('DEEPSEEK_API_KEY')));
  assert.deepEqual({ ...cfg.envSnapshot }, { hasDashscopeKey: true, hasOpenaiKey: false });

  const cfg2 = loadConfig({ path: p, cwd: dir, env: { DASHSCOPE_API_KEY: 'sk-xxxxxxxx', DEEPSEEK_API_KEY: 'sk-xxxxxxxx' }, loadDotEnv: false });
  assert.deepEqual(cfg2.ai.fallback, ['bailian', 'my-ds', 'my-local', 'custom']);
});

test('loadConfig：旧配置（生产 config.json 形状）行为逐字不变；环境变量覆盖仍生效', () => {
  const dir = tmpDir();
  const legacy = {
    host: '127.0.0.1', port: 8080, cors: '*',
    ai: { enabled: true, fallback: ['bailian', 'ollama'], concurrency: 3, queueLimit: 200, timeoutMs: 20000 },
    providers: {
      bailian: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-flash', apiKeyEnv: 'DASHSCOPE_API_KEY', temperature: 0, maxTokens: 64 },
      ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
    },
  };
  const p = writeCfg(dir, legacy);
  const cfg = loadConfig({ path: p, cwd: dir, env: {}, loadDotEnv: false });
  assert.deepEqual(cfg.ai.fallback, ['ollama']);
  assert.equal(cfg.providers.bailian.apiKeyEnv, 'DASHSCOPE_API_KEY');
  assert.deepEqual({ ...cfg.envSnapshot }, { hasDashscopeKey: false, hasOpenaiKey: false });
  const cfg2 = loadConfig({
    path: p, cwd: dir, loadDotEnv: false,
    env: { DASHSCOPE_API_KEY: 'sk-xxxxxxxx', QBANK_BAILIAN_BASE_URL: 'http://127.0.0.1:9/v1', QBANK_MODEL: 'qwen-plus', QBANK_AI_FALLBACK: 'bailian' },
  });
  assert.deepEqual(cfg2.ai.fallback, ['bailian']);
  assert.equal(cfg2.providers.bailian.baseUrl, 'http://127.0.0.1:9/v1');
  assert.equal(cfg2.providers.bailian.model, 'qwen-plus');
  assert.equal(cfg2.envSnapshot.hasDashscopeKey, true);
});

test('loadConfig：未知 impl/preset 防御——剔除 + 警告一次，进程不崩；providers 畸形不抛', () => {
  const dir = tmpDir();
  const p = writeCfg(dir, {
    ai: { fallback: ['weird-impl', 'weird-preset', 'ollama'] },
    providers: {
      'weird-impl': { impl: 'anthropic', baseUrl: 'http://127.0.0.1:9/v1' },
      'weird-preset': { preset: 'gemini', baseUrl: 'http://127.0.0.1:9/v1' },
    },
  });
  const { out: cfg, lines } = captureStderr(() => loadConfig({ path: p, cwd: dir, env: {}, loadDotEnv: false }));
  assert.deepEqual(cfg.ai.fallback, ['ollama']);
  assert.ok(lines.some((l) => l.includes('weird-impl') && l.includes('unknown_impl')));
  assert.ok(lines.some((l) => l.includes('weird-preset') && l.includes('unknown_preset')));
  const p2 = writeCfg(dir, { providers: [1, 2, 3], ai: { fallback: ['bailian'] } });
  const cfg2 = loadConfig({ path: p2, cwd: dir, env: { DASHSCOPE_API_KEY: 'sk-xxxxxxxx' }, loadDotEnv: false });
  assert.equal(cfg2.providers.bailian.model, 'qwen-flash');
  assert.deepEqual(cfg2.ai.fallback, ['bailian']);
});
