// lib/ai/openai.js — OpenAI Chat Completions 兼容通用实现（Patch 8：provider 中立化通用体）
//
// 契约：docs/CONTRACT.md §7；HANDOFF §7.2 / §7.5 / §8.1；ACCEPTANCE Patch 8。
//   POST {baseUrl}/chat/completions
//   Authorization: Bearer <env[apiKeyEnv]>（配置了 apiKeyEnv 且 Key 存在时；无 Key 不发鉴权头）
//   body: { model, temperature:0, max_tokens:64, stream:false, messages }
//   取 data.choices[0].message.content 与 data.usage.prompt_tokens/completion_tokens
//
// 预置与协议开关（均为可选 providerCfg 字段；预置表见 lib/ai/presets.js）：
//   preset            预置名，用于查审核签名表（dashscope/openai/deepseek/kimi/zhipu/…）
//   maxTokensParam    'max_completion_tokens' 生效，其余值一律 max_tokens
//   omitTemperature   true → 不发送 temperature 字段
//   extraHeaders      对象 → 合并入请求头（非敏感头；鉴权头永远由环境变量 Key 生成且最后写入）
//   apiKeyHeader      自定义头名 → 发裸 Key 值；缺省或 'authorization' → Bearer
//   query             对象 → URLSearchParams 拼入 URL（为 Azure api-version 留口）
//
// 铁律：
//   - 抛出的每个 Error 都必须带 code ∈ 'ai_moderation' | 'ai_error' | 'ai_timeout'；
//   - 错误信息只允许出现 provider/实例名 / HTTP 状态码 / 错误码 / 计数 / 耗时，
//     **禁止**出现题干、选项、答案原文、API Key、响应体原文（CONTRACT §11.5）；
//   - 模块顶层无 I/O、无副作用；不使用 process.exit；
//   - HTTP 429 指数退避（默认 1s / 2s，最多 2 次重试），退避间隔可注入（retryBaseMs）。
//
// 审核识别（fail-closed，认不出的 400 仍 ai_error 交给链切下一家）：
//   - 全局兜底：DataInspectionFailed 族 + HTTP 400|500 文案含 'data inspection'（逐字保留）；
//   - 预置签名：MODERATION_SIGNATURES[preset] 的 codes / keywords（来源见 presets.js 注释）；
//   - 协议级：HTTP 200 且 choices[0].finish_reason==='content_filter' → ai_moderation（所有实例）；
//     预置签名可追加 finish_reason 取值（如 zhipu 'sensitive'）。
//
// 说明：bailian/openai/deepseek/kimi/… 均为预置（lib/ai/presets.js），代码不硬编码任何「主力」；
//       链上成员与顺序完全由 config.ai.fallback 决定（DECISIONS #1 修订，Patch 8）。

import { signatureFor } from './presets.js';

const NAME = 'openai';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MAX_TOKENS = 64;
const CHAT_PATH = '/chat/completions';

// 与 lib/ai/index.js 的 MODERATION_CODES 保持一致（index.js 为权威，会二次校验）。
const MODERATION_CODES = [
  'DataInspectionFailed',
  'InvalidParameter.DataInspection',
  'InternalError.Algo.DataInspectionFailed',
];

function mkError(code, detail, extra, providerName) {
  const scope = typeof providerName === 'string' && providerName ? providerName : NAME;
  const err = new Error(`[qbank][${scope}][${code}] ${detail}`);
  err.code = code;
  err.provider = scope;
  if (extra && typeof extra === 'object') Object.assign(err, extra);
  return err;
}

function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { resolve(); return; }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    if (typeof t.unref === 'function') t.unref();
    function onAbort() {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** body.code / body.error.code 两处都要检查（HANDOFF §7.5）。 */
function pickDetailCode(body) {
  if (!body || typeof body !== 'object') return undefined;
  if (typeof body.code === 'string' && body.code) return body.code;
  const e = body.error;
  if (e && typeof e === 'object' && typeof e.code === 'string' && e.code) return e.code;
  if (typeof e === 'string' && e) return undefined;
  return undefined;
}

function isModerationCode(code) {
  if (typeof code !== 'string' || !code) return false;
  const low = code.toLowerCase();
  if (low.includes('datainspection')) return true;
  return MODERATION_CODES.some((c) => c.toLowerCase() === low);
}

/** 预置签名：错误码命中（body.code / body.type / error.code / error.type / innererror.code；数字码字符串化）。 */
function signatureCodeHit(body, sig) {
  if (!sig || !Array.isArray(sig.codes) || !body || typeof body !== 'object') return undefined;
  const candidates = [];
  const push = (c) => {
    if (typeof c === 'string' && c) candidates.push(c);
    else if (typeof c === 'number' && Number.isFinite(c)) candidates.push(String(c));
  };
  push(body.code);
  push(body.type);
  const e = body.error;
  if (e && typeof e === 'object') {
    push(e.code);
    push(e.type);
    if (e.innererror && typeof e.innererror === 'object') push(e.innererror.code);
  }
  for (const c of candidates) {
    const low = c.toLowerCase();
    if (sig.codes.some((m) => String(m).toLowerCase() === low)) return c;
  }
  return undefined;
}

/** 预置签名：关键词命中（仅 HTTP 400|500，与全局兜底口径一致）。 */
function signatureKeywordHit(text, status, sig) {
  if (!sig || !Array.isArray(sig.keywords)) return false;
  if (status !== 400 && status !== 500) return false;
  if (typeof text !== 'string' || !text) return false;
  const hay = text.toLowerCase();
  return sig.keywords.some((kw) => typeof kw === 'string' && kw && hay.includes(kw.toLowerCase()));
}

export default {
  name: NAME,

  /** 缺 apiKey 即 false（CONTRACT §7）。 */
  isConfigured(providerCfg, env = process.env) {
    try {
      const pc = providerCfg && typeof providerCfg === 'object' ? providerCfg : {};
      if (!pc.baseUrl || typeof pc.baseUrl !== 'string') return false;
      if (!pc.apiKeyEnv) return true;
      const src = env && typeof env === 'object' ? env : {};
      const v = src[pc.apiKeyEnv];
      return typeof v === 'string' && Boolean(v.trim());
    } catch {
      return false;
    }
  },

  /**
   * @param {{role:string,content:string}[]} messages
   * @param {{providerCfg?:object, signal?:AbortSignal, timeoutMs?:number, env?:object,
   *          retryBaseMs?:number, retryMax?:number, fetchImpl?:Function, providerName?:string}} [opts]
   *   providerName：实例名（错误消息 / err.provider 用；缺省 'openai'）。
   * @returns {Promise<{text:string, model:string, tokens:{in:number,out:number}}>}
   */
  async chat(messages, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const pc = o.providerCfg && typeof o.providerCfg === 'object' ? o.providerCfg : {};
    const env = o.env && typeof o.env === 'object' ? o.env : process.env;
    const providerName = typeof o.providerName === 'string' && o.providerName ? o.providerName : NAME;
    const mkErr = (code, detail, extra) => mkError(code, detail, extra, providerName);
    const sig = signatureFor(pc.preset);
    // fetchImpl 既可由 opts 注入，也可由 providerCfg 注入（测试用；生产走 globalThis.fetch）
    const doFetch = typeof o.fetchImpl === 'function'
      ? o.fetchImpl
      : (pc && typeof pc.fetchImpl === 'function' ? pc.fetchImpl : globalThis.fetch);

    const base = String(pc.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw mkErr('ai_error', '缺少 baseUrl');
    const apiKey = pc.apiKeyEnv ? String(env[pc.apiKeyEnv] || '').trim() : '';
    if (pc.apiKeyEnv && !apiKey) throw mkErr('ai_error', `缺少环境变量 ${pc.apiKeyEnv}`);
    if (typeof doFetch !== 'function') throw mkErr('ai_error', '运行时缺少 fetch');
    if (!Array.isArray(messages) || !messages.length) throw mkErr('ai_error', 'messages 为空');

    const model = String(pc.model || DEFAULT_MODEL);
    let url = base + CHAT_PATH;
    if (pc.query && typeof pc.query === 'object' && !Array.isArray(pc.query)) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(pc.query)) {
        if (typeof k === 'string' && k && v !== undefined && v !== null) qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    const payloadObj = { model };
    if (pc.omitTemperature !== true) payloadObj.temperature = toNum(pc.temperature, 0);
    const maxTokensKey = pc.maxTokensParam === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';
    payloadObj[maxTokensKey] = toInt(pc.maxTokens, DEFAULT_MAX_TOKENS);
    payloadObj.stream = false;
    payloadObj.messages = messages;
    const payload = JSON.stringify(payloadObj);

    // 请求头：content-type + extraHeaders（非敏感）+ 鉴权头（由环境变量 Key 生成，最后写入）
    const headers = { 'content-type': 'application/json' };
    if (pc.extraHeaders && typeof pc.extraHeaders === 'object' && !Array.isArray(pc.extraHeaders)) {
      for (const [k, v] of Object.entries(pc.extraHeaders)) {
        if (typeof k === 'string' && k && typeof v === 'string') headers[k.toLowerCase()] = v;
      }
    }
    if (apiKey) {
      const h = typeof pc.apiKeyHeader === 'string' ? pc.apiKeyHeader.trim().toLowerCase() : '';
      if (h && h !== 'authorization') headers[h] = apiKey;
      else headers.authorization = `Bearer ${apiKey}`;
    }

    const retryBaseMs = toNum(o.retryBaseMs !== undefined ? o.retryBaseMs : pc.retryBaseMs, 1000);
    const retryMax = toInt(o.retryMax !== undefined ? o.retryMax : pc.retryMax, 2);
    const timeoutMs = toNum(o.timeoutMs !== undefined ? o.timeoutMs : pc.timeoutMs, 0);

    // 超时 + 外部 signal 合并成一个内部 signal
    const ac = new AbortController();
    let timer = null;
    const onOuterAbort = () => {
      try { ac.abort(o.signal && o.signal.reason); } catch { /* ignore */ }
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { ac.abort(mkErr('ai_timeout', `请求超时（${timeoutMs}ms）`)); } catch { /* ignore */ }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    if (o.signal) {
      if (o.signal.aborted) onOuterAbort();
      else o.signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      for (let attempt = 0; ; attempt += 1) {
        let res;
        try {
          res = await doFetch(url, {
            method: 'POST',
            headers,
            body: payload,
            signal: ac.signal,
          });
        } catch (err) {
          if (ac.signal.aborted) {
            throw mkErr('ai_timeout', timeoutMs > 0 ? `请求超时（${timeoutMs}ms）` : '请求被取消', {
              causeCode: err && err.code,
            });
          }
          // 网络错误 / DNS 失败 / 连接被拒
          throw mkErr('ai_error', `网络错误（${(err && (err.code || err.name)) || 'unknown'}）`);
        }

        const status = toInt(res && res.status, 0);
        let text = '';
        try {
          text = typeof res.text === 'function' ? await res.text() : '';
        } catch {
          text = '';
        }

        if (status === 429) {
          if (attempt < retryMax) {
            await sleep(retryBaseMs * Math.pow(2, attempt), ac.signal);
            if (ac.signal.aborted) throw mkErr('ai_timeout', '退避期间被取消');
            continue;
          }
          throw mkErr('ai_error', 'HTTP 429 速率限制，重试已耗尽', { status: 429, retries: attempt });
        }

        if (status < 200 || status >= 300) {
          const body = parseJson(text);
          const detailCode = pickDetailCode(body);
          const sigCode = signatureCodeHit(body, sig);
          const moderation = isModerationCode(detailCode)
            || Boolean(sigCode)
            || signatureKeywordHit(text, status, sig)
            || ((status === 400 || status === 500) && typeof text === 'string'
                && text.toLowerCase().includes('data inspection'));
          if (moderation) {
            throw mkErr('ai_moderation', `HTTP ${status} 内容审核拦截`, {
              status,
              detailCode: detailCode || sigCode || (sig ? 'content_filter' : 'DataInspectionFailed'),
              body,
            });
          }
          throw mkErr('ai_error', `HTTP ${status}`, { status, detailCode, body });
        }

        const data = parseJson(text);
        if (!data) throw mkErr('ai_error', '响应体不是合法 JSON');
        const choices = data.choices;
        if (!Array.isArray(choices) || choices.length === 0) {
          throw mkErr('ai_error', 'choices 为空');
        }
        // 协议级审核：finish_reason content_filter（OpenAI/Azure/DeepSeek 等）；预置可追加（zhipu sensitive）。
        // 必须在 content 校验之前：DeepSeek 拒答时 content 为空但 finish_reason 已标明审核。
        const finishReason = choices[0] && choices[0].finish_reason;
        const frModeration = finishReason === 'content_filter'
          || (sig && Array.isArray(sig.finishReasons) && typeof finishReason === 'string'
              && sig.finishReasons.includes(finishReason));
        if (frModeration) {
          throw mkErr('ai_moderation', '内容审核拦截（finish_reason）', {
            status,
            detailCode: typeof finishReason === 'string' && finishReason ? finishReason : 'content_filter',
            body: data,
          });
        }
        const msg = choices[0] && choices[0].message;
        const content = msg && msg.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw mkErr('ai_error', 'content 为空');
        }
        const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
        return {
          text: content,
          model: String(data.model || model),
          tokens: {
            in: toInt(usage.prompt_tokens, 0),
            out: toInt(usage.completion_tokens, 0),
          },
        };
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (o.signal) {
        try { o.signal.removeEventListener('abort', onOuterAbort); } catch { /* ignore */ }
      }
    }
  },
};