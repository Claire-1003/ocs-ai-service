// config.js — 配置加载与环境变量覆盖（T0 所有，零第三方依赖）
//
// 导出：
//   loadConfig({ path, env, cwd } = {}) -> Readonly<Config>
//   resolvePaths(config, { cwd } = {})  -> { rootDir, dataDir, logsDir, bankPath, bakPath,
//                                            cachePath, moderationLogPath }
//   apiKeyFor(providerCfg, env)         -> string | undefined
//   DEFAULTS                            -> 内置默认配置（深冻结）
//
// 优先级：真实环境变量 > .env 文件 > config.json > 内置 DEFAULTS
// 铁律：本模块任何情况下都不得抛异常、不得让进程退出。
//       配置缺失/损坏只打一条 stderr 警告并回退默认值。
//       日志中绝不出现题目原文（本模块也接触不到题目）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstance } from './lib/ai/presets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8080,
  cors: '*',
  dataDir: '',       // 空 = <root>/data；可用 QBANK_DATA_DIR 覆盖（测试请指向 os.tmpdir()）
  logsDir: '',       // 空 = <root>/logs；可用 QBANK_LOGS_DIR 覆盖
  mockAi: false,     // QBANK_MOCK_AI=1 时用内置假 AI 应答，供 M1 端到端联调（不写 bank.json）
  ai: Object.freeze({
    enabled: true,
    fallback: Object.freeze(['bailian', 'ollama']),
    concurrency: 3,
    queueLimit: 200,
    timeoutMs: 20000,
  }),
  providers: Object.freeze({
    bailian: Object.freeze({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-flash',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      temperature: 0,
      maxTokens: 64,
    }),
    ollama: Object.freeze({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' }),
    openai: Object.freeze({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKeyEnv: 'OPENAI_API_KEY',
    }),
  }),
  match: Object.freeze({
    fuzzyThreshold: 0.9,
    suspiciousThreshold: 0.8,
    acceptSuspicious: false,
    candidateLimit: 200,
  }),
  cache: Object.freeze({ maxEntries: 10000, flushIntervalMs: 30000 }),
  writeback: Object.freeze({ enabled: true, requireVerified: false }),
});

const TRUE_SET = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSE_SET = new Set(['0', 'false', 'no', 'n', 'off']);
const warned = new Set();

function warnOnce(code, msg) {
  if (warned.has(code)) return;
  warned.add(code);
  process.stderr.write(`[qbank][config][${code}] ${msg}\n`);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：later 覆盖 former，对象递归合并，数组与标量整体替换。 */
function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = isPlainObject(base[k]) && isPlainObject(over[k])
      ? deepMerge(base[k], over[k])
      : over[k];
  }
  return out;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function toBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return fallback;
  const s = v.trim().toLowerCase();
  if (TRUE_SET.has(s)) return true;
  if (FALSE_SET.has(s)) return false;
  return fallback;
}

function toInt(v, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toFloat(v, fallback, min = 0, max = 1) {
  const n = Number.parseFloat(String(v).trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readEnvFile(file, target) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0; // .env 不存在是完全正常的情况，不告警
  }
  let n = 0;
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!k) continue;
    let v = t.slice(eq + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
      v = v.slice(1, -1);
    } else {
      const hash = v.indexOf(' #'); // 未加引号时允许行尾注释
      if (hash >= 0) v = v.slice(0, hash).trim();
    }
    if (!(k in target)) { target[k] = v; n += 1; } // 真实环境变量优先，不被 .env 覆盖
  }
  return n;
}

function readConfigFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') warnOnce('config_unreadable', `config.json 读取失败（${err.code}），使用内置默认值`);
    else warnOnce('config_missing', '未找到 config.json，使用内置默认值');
    return {};
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!isPlainObject(parsed)) throw new Error('not_object');
    return parsed;
  } catch {
    warnOnce('config_broken', 'config.json 不是合法 JSON，已整体回退到内置默认值');
    return {};
  }
}

/** 把扁平的 QBANK_* 环境变量映射到配置树上。 */
function applyEnv(cfg, env) {
  if (env.QBANK_HOST) cfg.host = String(env.QBANK_HOST).trim();
  if (env.QBANK_PORT) cfg.port = toInt(env.QBANK_PORT, cfg.port, 0, 65535);
  if (env.PORT && !env.QBANK_PORT) cfg.port = toInt(env.PORT, cfg.port, 0, 65535);
  if (env.QBANK_CORS) cfg.cors = String(env.QBANK_CORS).trim();
  if (env.QBANK_DATA_DIR) cfg.dataDir = String(env.QBANK_DATA_DIR).trim();
  if (env.QBANK_LOGS_DIR) cfg.logsDir = String(env.QBANK_LOGS_DIR).trim();
  if (env.QBANK_MOCK_AI !== undefined) cfg.mockAi = toBool(env.QBANK_MOCK_AI, cfg.mockAi);

  const ai = cfg.ai;
  if (env.QBANK_AI_ENABLED !== undefined) ai.enabled = toBool(env.QBANK_AI_ENABLED, ai.enabled);
  if (env.QBANK_AI_FALLBACK) {
    const list = String(env.QBANK_AI_FALLBACK).split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length) ai.fallback = list;
  }
  if (env.QBANK_CONCURRENCY) ai.concurrency = toInt(env.QBANK_CONCURRENCY, ai.concurrency, 1, 1024);
  if (env.QBANK_QUEUE_LIMIT !== undefined) ai.queueLimit = toInt(env.QBANK_QUEUE_LIMIT, ai.queueLimit, 0, 100000);
  if (env.QBANK_TIMEOUT_MS) ai.timeoutMs = toInt(env.QBANK_TIMEOUT_MS, ai.timeoutMs, 500, 600000);

  const p = cfg.providers;
  if (env.QBANK_MODEL) p.bailian.model = String(env.QBANK_MODEL).trim();
  if (env.QBANK_BAILIAN_MODEL) p.bailian.model = String(env.QBANK_BAILIAN_MODEL).trim();
  if (env.QBANK_BAILIAN_BASE_URL) p.bailian.baseUrl = String(env.QBANK_BAILIAN_BASE_URL).trim();
  if (env.QBANK_OPENAI_MODEL) p.openai.model = String(env.QBANK_OPENAI_MODEL).trim();
  if (env.OLLAMA_BASE_URL) p.ollama.baseUrl = String(env.OLLAMA_BASE_URL).trim();
  if (env.QBANK_OLLAMA_MODEL) p.ollama.model = String(env.QBANK_OLLAMA_MODEL).trim();

  const m = cfg.match;
  if (env.QBANK_FUZZY_THRESHOLD) m.fuzzyThreshold = toFloat(env.QBANK_FUZZY_THRESHOLD, m.fuzzyThreshold, 0, 1);
  if (env.QBANK_SUSPICIOUS_THRESHOLD) m.suspiciousThreshold = toFloat(env.QBANK_SUSPICIOUS_THRESHOLD, m.suspiciousThreshold, 0, 1);
  if (env.QBANK_ACCEPT_SUSPICIOUS !== undefined) m.acceptSuspicious = toBool(env.QBANK_ACCEPT_SUSPICIOUS, m.acceptSuspicious);
  if (env.QBANK_CANDIDATE_LIMIT) m.candidateLimit = toInt(env.QBANK_CANDIDATE_LIMIT, m.candidateLimit, 1, 100000);

  if (env.QBANK_CACHE_MAX_ENTRIES) cfg.cache.maxEntries = toInt(env.QBANK_CACHE_MAX_ENTRIES, cfg.cache.maxEntries, 1, 10000000);
  if (env.QBANK_CACHE_FLUSH_MS) cfg.cache.flushIntervalMs = toInt(env.QBANK_CACHE_FLUSH_MS, cfg.cache.flushIntervalMs, 1000, 3600000);
  if (env.QBANK_WRITEBACK !== undefined) cfg.writeback.enabled = toBool(env.QBANK_WRITEBACK, cfg.writeback.enabled);
  if (env.QBANK_REQUIRE_VERIFIED !== undefined) cfg.writeback.requireVerified = toBool(env.QBANK_REQUIRE_VERIFIED, cfg.writeback.requireVerified);

  if (m.suspiciousThreshold > m.fuzzyThreshold) {
    warnOnce('threshold_inverted', 'suspiciousThreshold 大于 fuzzyThreshold，已自动对调');
    const t = m.suspiciousThreshold; m.suspiciousThreshold = m.fuzzyThreshold; m.fuzzyThreshold = t;
  }
  return cfg;
}

/**
 * 剔除未正确配置（缺 API Key / 缺 baseUrl / 未知 impl/preset）的 provider，缺 Key 时打印清晰中文提示。
 * 只处理 ai.fallback 数组，不删除 providers 定义本身。
 * Patch 8：preset 感知——先 resolveInstance 再按生效配置检查（裸 {"preset":"deepseek"} 不会被误剔）。
 */
function pruneFallback(cfg, env) {
  const chain = Array.isArray(cfg.ai.fallback) ? [...cfg.ai.fallback] : [];
  const kept = [];
  for (const name of chain) {
    const pc = cfg.providers[name];
    if (!isPlainObject(pc)) {
      warnOnce(`unknown_provider_${name}`, `ai.fallback 中的 "${name}" 在 providers 里没有定义，已忽略`);
      continue;
    }
    const r = resolveInstance(name, pc);
    if (!r.ok) continue; // 未知 impl/preset 等：presets.js 已警告一次（只含名字/错误码），永不抛
    const eff = r.cfg;
    if (!eff.baseUrl) {
      warnOnce(`no_baseurl_${name}`, `provider "${name}" 缺少 baseUrl，已从 fallback 链剔除`);
      continue;
    }
    if (eff.apiKeyEnv && !apiKeyFor(eff, env)) {
      warnOnce(`no_key_${name}`, `provider "${name}" 需要环境变量 ${eff.apiKeyEnv}，当前未设置，已从 fallback 链剔除。` +
        `设置方式：复制 .env.example 为 .env 并填入，或先执行 $env:${eff.apiKeyEnv}="你的Key" 再启动。`);
      continue;
    }
    kept.push(name);
  }
  cfg.ai.fallback = kept;
  if (!kept.length && cfg.ai.enabled) {
    warnOnce('no_provider', '当前没有任何可用 AI provider：/api 将全部返回 {"code":0,"reason":"ai_error"}。' +
      '服务本身仍可正常使用本地题库检索。');
  }
  return cfg;
}

/**
 * 加载配置。任何异常都被吞掉并回退默认值，保证「进程永不因配置问题退出」。
 * @param {{path?:string, env?:object, cwd?:string, loadDotEnv?:boolean}} [opts]
 */
export function loadConfig(opts = {}) {
  const cwd = opts.cwd || HERE;
  const env = { ...(opts.env || process.env) };
  if (opts.loadDotEnv !== false) {
    try { readEnvFile(path.join(cwd, '.env'), env); } catch (err) {
      warnOnce('dotenv_failed', `.env 解析失败（${err && err.code}），已忽略`);
    }
  }

  let cfg = deepMerge(DEFAULTS, readConfigFile(opts.path || path.join(cwd, 'config.json')));
  cfg = deepMerge(cfg, {}); // 断开与冻结的 DEFAULTS 的引用共享
  cfg.ai = { ...cfg.ai };
  // Patch 8：保留任意 provider 条目（自定义实例名不再被丢弃）；三个内置名仍合并 DEFAULTS。
  const srcProviders = isPlainObject(cfg.providers) ? cfg.providers : {};
  const rebuiltProviders = {};
  for (const [name, raw] of Object.entries(srcProviders)) {
    if (isPlainObject(raw)) rebuiltProviders[name] = { ...raw };
  }
  for (const name of Object.keys(DEFAULTS.providers)) {
    const raw = isPlainObject(srcProviders[name]) ? srcProviders[name] : {};
    rebuiltProviders[name] = { ...DEFAULTS.providers[name], ...raw };
  }
  cfg.providers = rebuiltProviders;
  cfg.match = { ...cfg.match };
  cfg.cache = { ...cfg.cache };
  cfg.writeback = { ...cfg.writeback };

  cfg = applyEnv(cfg, env);
  cfg = pruneFallback(cfg, env);

  cfg.host = String(cfg.host || '127.0.0.1');
  cfg.port = toInt(cfg.port, 8080, 0, 65535);
  cfg.envSnapshot = Object.freeze({
    hasDashscopeKey: Boolean(apiKeyFor(cfg.providers.bailian, env)),
    hasOpenaiKey: Boolean(apiKeyFor(cfg.providers.openai, env)),
  });
  return deepFreeze(cfg);
}

/** @returns {string|undefined} */
export function apiKeyFor(providerCfg, env = process.env) {
  const name = providerCfg && providerCfg.apiKeyEnv;
  if (!name) return undefined;
  const v = env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** 解析全部运行时文件路径。dataDir/logsDir 为空时落在项目根下。 */
export function resolvePaths(config, opts = {}) {
  const rootDir = opts.cwd || HERE;
  const dataDir = config.dataDir ? path.resolve(rootDir, config.dataDir) : path.join(rootDir, 'data');
  const logsDir = config.logsDir ? path.resolve(rootDir, config.logsDir) : path.join(rootDir, 'logs');
  return Object.freeze({
    rootDir,
    dataDir,
    logsDir,
    bankPath: path.join(dataDir, 'bank.json'),
    bakPath: path.join(dataDir, 'bank.json.bak'),
    cachePath: path.join(dataDir, 'cache.json'),
    moderationLogPath: path.join(logsDir, 'moderation.log'),
  });
}

export default { loadConfig, resolvePaths, apiKeyFor, DEFAULTS };
