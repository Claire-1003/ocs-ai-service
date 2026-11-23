// server.js — HTTP 入口 / 路由 / CORS / 优雅退出（Owner: T3，零第三方依赖，ESM）
//
// CONTRACT §8：路由 /api(GET+POST)、/health、/stats、/admin/verify、OPTIONS、404。
// /api 九步管线顺序固定：解析入参 -> L1 -> L2 -> cache -> 图片公式短路 -> gate+ai -> 回写+缓存 -> 返回。
// 响应字段与 code 语义严格遵守 HANDOFF §4.2/§4.3；所有响应统一带 elapsed（DECISIONS #8）。
// 顶层 try/catch 包住 handler：绝不 500 空响应、绝不让异常冒泡。
// 测试友好：export createServer(overrides)，只有直接 node server.js 时才 listen(config.port)。
// T6 裁决（P2/T3#11）：matcher/gate/ai 一律静态 import，删除「模块缺失回退内置最小实现」分支 ——
//   T1/T2 早已落地，静默回退只会掩盖集成失败、让 e2e 假通过。
// QBANK_MOCK_AI=1：内置假 AI 应答，假数据只进 cache，不写 bank.json。
// 日志纪律：只输出错误码/计数/耗时/key 前 12 位/provider 名，绝不输出题干、选项、答案原文。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, resolvePaths } from './config.js';
import { normalize, splitOptions, stripOptionJunk, normalizeOptions, normalizeType, makeKey, isUnanswerable, toLabel } from './lib/normalize.js';
import { Store } from './lib/store.js';
import { LRU } from './lib/cache.js';
import { Matcher } from './lib/matcher.js';
import { createGate } from './lib/queue.js';
import { createAI } from './lib/ai/index.js';

const MAX_BODY_BYTES = 1024 * 1024; // POST body 上限 1MB
const SHUTDOWN_FORCE_MS = 10000;    // 优雅退出 10s 兜底
const FALLBACK_VERSION = '1.0.0';
const OUT_REASONS = new Set([
  'no_match', 'ai_timeout', 'ai_moderation', 'ai_error',
  'queue_full', 'image_or_formula', 'ai_disabled', 'bad_request',
]);

// fetch 规范的「bad ports」：undici/Node fetch 拒绝连接这些端口（TypeError, cause: bad port）。
// listen(0) 随机分配命中时测试客户端会直接 fetch 失败 -> 随机假失败（T6 集成期实测复现并修复）。
// 命中即重新绑定；生产固定端口 8080 不在表内、不受影响。与 test/stubs/t2-fakeProvider.js 保持同一份清单。
const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);


// ---------------------------------------------------------------- 日志

function createDefaultLog(paths) {
  return {
    moderation(key, code, provider) {
      try {
        fs.mkdirSync(paths.logsDir, { recursive: true });
        fs.appendFileSync(
          paths.moderationLogPath,
          `${new Date().toISOString()} key=${String(key).slice(0, 12)} code=${code} provider=${provider}\n`,
        );
      } catch { /* 日志失败不影响主流程 */ }
    },
    error(scope, errCode) {
      try { process.stderr.write(`[qbank][${scope}][${errCode}] 内部错误\n`); } catch { /* 忽略 */ }
    },
    info(scope, obj) {
      try { process.stderr.write(`[qbank][${scope}] ${JSON.stringify(obj)}\n`); } catch { /* 忽略 */ }
    },
  };
}

/** QBANK_MOCK_AI=1 用的内置假 AI（M1 端到端联调；结果只进 cache，不写 bank.json）。 */
function createMockAI() {
  const MOCK_ANSWER = { 单选: 'A', 多选: 'A#B', 判断: '正确', 填空: '示例答案', 问答: '这是 MOCK_AI 生成的示例答案' };
  let calls = 0;
  return {
    async answer(req) {
      calls += 1;
      const type = req && typeof req.type === 'string' ? req.type : '问答';
      return { ok: true, answer: MOCK_ANSWER[type] || MOCK_ANSWER['问答'], provider: 'mock', model: 'mock-ai', tokens: { in: 0, out: 0 } };
    },
    stats() {
      return { calls, success: calls, failed: 0, byProvider: { mock: { calls, success: calls, failed: 0, moderation: 0, timeout: 0, ms: 0 } }, tokensIn: 0, tokensOut: 0, moderation: 0, queueFull: 0, chainExhausted: 0 };
    },
    chain: ['mock'],
  };
}

// ---------------------------------------------------------------- 工具

function safeDecode(v) {
  if (typeof v !== 'string') return '';
  try { return decodeURIComponent(v); } catch { return v; } // URIError 容错；已解码时幂等
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      if (over) return; // 继续排空但不累积，避免客户端被 RST
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(Object.assign(new Error('request body too large'), { code: 'bad_request' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (err) => { if (!over) reject(err); });
  });
}

function createRing(cap) {
  const arr = new Array(cap);
  let n = 0;
  return {
    push(v) { arr[n % cap] = v; n += 1; },
    snapshot() { return arr.slice(0, Math.min(n, cap)); },
  };
}

function percentiles(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const pick = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), samples: sorted.length };
}

function readVersion(rootDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

// ---------------------------------------------------------------- 响应

function sendJson(res, status, obj, ctx) {
  try {
    if (res.writableEnded || res.headersSent) return;
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': ctx.config.cors,
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch { /* 客户端断开等，忽略 */ }
}

function sendOptions(req, res, ctx) {
  try {
    if (res.writableEnded || res.headersSent) return;
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ctx.config.cors,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
    });
    res.end();
  } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------- /api 管线

async function handleApi(req, res, ctx, url, started) {
  const finish = (obj) => {
    const out = { ...obj, elapsed: Date.now() - started };
    ctx.ring.push(out.elapsed);
    sendJson(res, 200, out, ctx);
    return out;
  };
  try {
    // 1. 解析入参
    let q;
    let typeParam = '';
    let optionsParam = '';
    if (req.method === 'GET') {
      q = safeDecode(url.searchParams.get('q') ?? '');
      typeParam = safeDecode(url.searchParams.get('type') ?? '');
      optionsParam = safeDecode(url.searchParams.get('options') ?? '');
    } else {
      let text;
      try {
        text = await readBody(req, MAX_BODY_BYTES);
      } catch {
        return finish({ code: 0, question: '', answer: '', reason: 'bad_request' });
      }
      let body;
      try { body = JSON.parse(text || '{}'); } catch { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return finish({ code: 0, question: '', answer: '', reason: 'bad_request' });
      }
      q = typeof body.q === 'string' ? body.q : (body.q === null || body.q === undefined ? '' : String(body.q));
      typeParam = typeof body.type === 'string' ? body.type : '';
      optionsParam = typeof body.options === 'string'
        ? body.options
        : Array.isArray(body.options) ? body.options.map((o) => String(o)).join('#') : '';
    }
    if (typeof q !== 'string' || !q.trim()) {
      return finish({ code: 0, question: '', answer: '', reason: 'bad_request' });
    }

    // 2. 归一化 + key
    const cleanTitle = stripOptionJunk(q); // D3/Patch 7：题干剥图片占位杂质（与 Patch 4 选项同口径）
    const title = normalize(cleanTitle);
    const rawOptions = splitOptions(optionsParam); // 原文选项（图片判定用，须见原始杂质）
    const cleanOptions = rawOptions.map((o) => stripOptionJunk(o)); // D3/Patch 4：类型推断/AI/回写用
    const options = normalizeOptions(optionsParam);
    const type = normalizeType(typeParam, { optionCount: cleanOptions.length, title, options: cleanOptions });
    const key = makeKey(cleanTitle, optionsParam);

    // 3+4. L1 精确 / L2 模糊（matcher 已按 acceptSuspicious 裁决）
    const m = ctx.store.match(cleanTitle, optionsParam);
    if (m && m.record && (m.level === 'L1' || m.suspicious !== true || ctx.config.match.acceptSuspicious)) {
      return finish({
        code: 1,
        question: m.record.title,
        answer: m.record.answer,
        source: m.level === 'L1' ? 'local' : 'fuzzy',
      });
    }

    // 5. cache 命中（DECISIONS #6：cache 层不受 requireVerified 约束）
    const cached = ctx.cache.get(key);
    if (cached && typeof cached.answer === 'string' && cached.answer) {
      return finish({ code: 1, question: cleanTitle, answer: cached.answer, source: 'cache' });
    }

    // 6. 图片/公式短路
    if (isUnanswerable(cleanTitle, rawOptions)) {
      ctx.counters.imageOrFormula += 1;
      return finish({ code: 0, question: '', answer: '', reason: 'image_or_formula' });
    }

    // 7+9. 并发闸 -> AI
    let out;
    try {
      out = await ctx.gate.run(() => ctx.ai.answer({ key, type, title: cleanTitle, options: cleanOptions }));
    } catch (err) {
      const code = err && err.code;
      const reason = code === 'queue_full' ? 'queue_full'
        : code === 'ai_timeout' ? 'ai_timeout'
          : code === 'ai_moderation' ? 'ai_moderation' : 'ai_error';
      return finish({ code: 0, question: '', answer: '', reason });
    }
    if (!out || out.ok !== true || typeof out.answer !== 'string' || !out.answer) {
      let reason = out && typeof out.reason === 'string' ? out.reason : 'ai_error';
      if (reason === 'invalid_output') reason = 'ai_error'; // 内部码不外泄（DECISIONS #9）
      if (reason === 'bad_request' || !OUT_REASONS.has(reason)) reason = 'ai_error';
      return finish({ code: 0, question: '', answer: '', reason });
    }

    // 8. 回写 bank（MOCK 数据不写 bank.json）+ 写 cache
    try {
      if (ctx.config.writeback.enabled && !ctx.isMock) {
        const rec = {
          key, title: cleanTitle, options: cleanOptions, answer: out.answer,
          type: toLabel(type), source: 'ai',
          verified: false, createdAt: Date.now(),
        };
        if (typeof out.model === 'string' && out.model) {
          rec.model = out.model; // 字段顺序：source 之后、verified 之前（HANDOFF §8.3）
          const ordered = { key: rec.key, title: rec.title, options: rec.options, answer: rec.answer, type: rec.type, source: rec.source, model: rec.model, verified: rec.verified, createdAt: rec.createdAt };
          ctx.store.add(ordered);
        } else {
          ctx.store.add(rec);
        }
      }
      ctx.cache.set(key, { answer: out.answer, source: 'ai', type, model: out.model, createdAt: Date.now() });
    } catch (err) {
      ctx.log.error('writeback', (err && (err.code || err.name)) || 'error');
    }
    return finish({ code: 1, question: cleanTitle, answer: out.answer, source: 'ai' });
  } catch (err) {
    try { ctx.log.error('api', (err && (err.code || err.name)) || 'error'); } catch { /* 忽略 */ }
    return finish({ code: 0, question: '', answer: '', reason: 'ai_error' });
  }
}

async function handleVerify(req, res, ctx, started) {
  const finish = (obj) => {
    const out = { ...obj, elapsed: Date.now() - started };
    sendJson(res, 200, out, ctx);
    return out;
  };
  try {
    const text = await readBody(req, MAX_BODY_BYTES);
    let body;
    try { body = JSON.parse(text || '{}'); } catch { body = null; }
    const key = body && typeof body.key === 'string' ? body.key.trim() : '';
    const verified = body ? body.verified : undefined;
    if (!key || typeof verified !== 'boolean') return finish({ code: 0, reason: 'bad_request' });
    const found = ctx.store.setVerified(key, verified);
    if (!found) return finish({ code: 0, reason: 'bad_request' }); // 未知 key 保守判 bad_request
    await ctx.store.persist(); // DECISIONS #11：改标记 + 落盘（先 .bak）
    return finish({ code: 1, key, verified });
  } catch (err) {
    try { ctx.log.error('admin_verify', (err && (err.code || err.name)) || 'error'); } catch { /* 忽略 */ }
    return finish({ code: 0, reason: 'bad_request' });
  }
}

function healthPayload(ctx) {
  let chain;
  try { chain = Array.isArray(ctx.ai.chain) ? [...ctx.ai.chain] : (ctx.config.ai.fallback || []); } catch { chain = []; }
  // P0-8（T6 采纳）：ai 升级为 { enabled, chain }，便于运维判断 AI 是否可用。
  // 属 HANDOFF §4.3 的契约增补（待用户批准写回，见 docs/ACCEPTANCE.md）；OCS 不读 /health，无兼容风险。
  let enabled;
  try {
    enabled = ctx.ai.enabled !== undefined ? Boolean(ctx.ai.enabled) : ctx.config.ai.enabled !== false;
  } catch { enabled = false; }
  return {
    code: 1,
    status: 'ok',
    uptime: Math.round(process.uptime() * 1000),
    version: ctx.version,
    bank: ctx.store.stats().total,
    ai: { enabled, chain },
  };
}

function statsPayload(ctx) {
  const s = ctx.store.stats();
  const c = ctx.cache.stats();
  let a = {};
  let g = {};
  try { a = ctx.ai.stats() || {}; } catch { /* 忽略 */ }
  try { g = ctx.gate.stats() || {}; } catch { /* 忽略 */ }
  let chain;
  try { chain = Array.isArray(ctx.ai.chain) ? ctx.ai.chain : (ctx.config.ai.fallback || []); } catch { chain = []; }
  return {
    uptime: Math.round(process.uptime() * 1000),
    version: ctx.version,
    bank: { total: s.total, verified: s.verified, bySource: s.bySource },
    cache: { size: c.size, hits: c.hits, misses: c.misses, evictions: c.evictions, writes: c.writes },
    ai: {
      calls: a.calls || 0,
      success: a.success || 0,
      failed: a.failed || 0,
      moderation: a.moderation || 0,
      timeout: g.timeouts || 0,
      // P1-6（T6）：queueFull 单一事实来源 = gate.stats().rejected；ai.stats().queueFull 仅作 fallback
      queueFull: g.rejected !== undefined ? g.rejected : (a.queueFull || 0),
      inflight: g.inflight || 0,
      queued: g.queued || 0,
      tokensIn: a.tokensIn || 0,
      tokensOut: a.tokensOut || 0,
      byProvider: a.byProvider || {},
      chain,
    },
    match: { l1: s.l1Hits, l2: s.l2Hits, l2Suspicious: s.l2Suspicious, noMatch: s.noMatch, imageOrFormula: ctx.counters.imageOrFormula },
    elapsed: percentiles(ctx.ring.snapshot()),
  };
}

function createHandler(ctx) {
  return async function handleRequest(req, res) {
    const started = Date.now();
    try {
      let url;
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        return sendJson(res, 404, { code: 0, question: '', answer: '', reason: 'no_match', elapsed: Date.now() - started }, ctx);
      }
      const p = url.pathname;
      if (req.method === 'OPTIONS') return sendOptions(req, res, ctx);
      if (p === '/api' && (req.method === 'GET' || req.method === 'POST')) {
        return await handleApi(req, res, ctx, url, started);
      }
      if (p === '/health' && req.method === 'GET') {
        return sendJson(res, 200, healthPayload(ctx), ctx);
      }
      if (p === '/stats' && req.method === 'GET') {
        return sendJson(res, 200, statsPayload(ctx), ctx);
      }
      if (p === '/admin/verify' && req.method === 'POST') {
        return await handleVerify(req, res, ctx, started);
      }
      return sendJson(res, 404, { code: 0, question: '', answer: '', reason: 'no_match', elapsed: Date.now() - started }, ctx);
    } catch (err) {
      // 顶层兜底：绝不 500 空响应、绝不 throw（CONTRACT §8）
      try { ctx.log.error('http', (err && (err.code || err.name)) || 'error'); } catch { /* 忽略 */ }
      return sendJson(res, 200, { code: 0, question: '', answer: '', reason: 'ai_error', elapsed: Date.now() - started }, ctx);
    }
  };
}

// ---------------------------------------------------------------- createServer

/**
 * 构建（不监听）HTTP 服务。测试用 listen(0)；只有直接 node server.js 才监听 config.port。
 * @param {object} [overrides] {config,paths,env,log,matcher,store,cache,gate,ai}
 * @returns {Promise<{server:http.Server, app:object, listen:Function, close:Function}>}
 */
export async function createServer(overrides = {}) {
  const env = overrides.env || process.env;
  const config = overrides.config || loadConfig({ env });
  const paths = overrides.paths || resolvePaths(config);
  try { fs.mkdirSync(paths.dataDir, { recursive: true }); } catch { /* 忽略 */ }
  try { fs.mkdirSync(paths.logsDir, { recursive: true }); } catch { /* 忽略 */ }

  const log = overrides.log || createDefaultLog(paths);
  const matcher = overrides.matcher || new Matcher(config.match);
  const store = overrides.store || new Store({
    bankPath: paths.bankPath, bakPath: paths.bakPath, config, matcher, log,
  });
  const cache = overrides.cache || new LRU({
    maxEntries: config.cache.maxEntries,
    file: paths.cachePath,
    flushIntervalMs: config.cache.flushIntervalMs,
    log,
  });

  // DECISIONS #10：先 store 后 cache；bank 权威，cache 中与 bank 同 key 的条目一律丢弃
  await store.load();
  await cache.load();
  try {
    for (const r of store.records()) {
      if (cache.has(r.key)) cache.delete(r.key);
    }
  } catch { /* 忽略 */ }

  // P0-7：gate 全系统只在这一处创建，单层包裹 /api 第 7 步；注入 createAI 仅为签名兼容，AI 内部不得再包。
  const gate = overrides.gate || createGate({
    concurrency: config.ai.concurrency,
    queueLimit: config.ai.queueLimit,
    timeoutMs: config.ai.timeoutMs,
  });
  const ai = overrides.ai || (config.mockAi ? createMockAI() : createAI({ config, env, log, gate }));

  const ctx = {
    config, paths, log, matcher, store, cache, gate, ai,
    version: readVersion(paths.rootDir),
    isMock: !overrides.ai && config.mockAi === true, // MOCK 数据不得写进 bank.json
    counters: { imageOrFormula: 0 },
    ring: createRing(1024),
  };

  const server = http.createServer(createHandler(ctx));
  server.on('clientError', (err, socket) => {
    try {
      if (socket && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch { /* 忽略 */ }
  });

  const app = {
    config, paths, log, matcher, store, cache, gate, ai,
    version: ctx.version, counters: ctx.counters,
  };

  let closed = false;
  return {
    server,
    app,
    listen(port = 0, host = config.host) {
      // T6 集成修复（flake 根因）：listen(0) 随机命中 fetch bad port 时自动重绑（仅随机端口模式）。
      const bind = () => new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          resolve(server.address());
        });
      });
      return (async () => {
        let addr = await bind();
        for (let i = 0; port === 0 && FETCH_BAD_PORTS.has(addr.port) && i < 32; i++) {
          await new Promise((resolve) => server.close(resolve));
          addr = await bind();
        }
        return addr;
      })();
    },
    async close() {
      if (closed) return;
      closed = true;
      try { cache.stopAutoFlush(); } catch { /* 忽略 */ }
      try { await cache.flush(); } catch { /* 忽略 */ }
      try { await store.persist(); } catch { /* 忽略 */ }
      try { server.closeIdleConnections(); } catch { /* Node < 18.2 无此方法 */ }
      await new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(() => {
          try { server.closeAllConnections(); } catch { /* 忽略 */ }
        }, 2000).unref();
      });
    },
  };
}

// ---------------------------------------------------------------- 直接运行

async function main() {
  const config = loadConfig();
  const paths = resolvePaths(config);
  const inst = await createServer({ config, paths });
  const addr = await inst.listen(config.port, config.host);
  inst.app.cache.startAutoFlush();
  const chain = (inst.app.ai.chain || []).join('->') || 'none';
  process.stderr.write(`[qbank][server][listening] http://${addr.address}:${addr.port} ai=${chain}${config.mockAi ? ' (MOCK_AI)' : ''}\n`);

  const onFatal = (label) => (err) => {
    try { process.stderr.write(`[qbank][process][${label}] ${(err && (err.code || err.name)) || 'unknown'}\n`); } catch { /* 忽略 */ }
  };
  process.on('uncaughtException', onFatal('uncaughtException'));
  process.on('unhandledRejection', onFatal('unhandledRejection'));

  let shutting = false;
  const shutdown = async () => {
    if (shutting) return;
    shutting = true;
    const force = setTimeout(() => { process.exit(0); }, SHUTDOWN_FORCE_MS); // 10s 兜底强制退出
    try {
      inst.app.cache.stopAutoFlush();
      await inst.app.cache.flush();
      await inst.app.store.persist();
      if (typeof inst.app.gate.drain === 'function') await inst.app.gate.drain();
      await inst.close();
    } catch (err) {
      try { process.stderr.write(`[qbank][server][shutdown_error] ${(err && (err.code || err.name)) || 'error'}\n`); } catch { /* 忽略 */ }
    }
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    try { process.stderr.write(`[qbank][server][boot_failed] ${(err && (err.code || err.name)) || 'error'}\n`); } catch { /* 忽略 */ }
    process.exit(1);
  });
}

export default createServer;