// lib/ai/ollama.js — 本地 Ollama Provider（原生 /api/chat；Owner: T2）
// Patch 8：支持 opts.providerName（实例名），错误消息 / err.provider 以实例名为键；其余行为逐字不变。
//
// 契约：docs/CONTRACT.md §7；HANDOFF §7.1 / §8.1。
//   POST {baseUrl}/api/chat
//   body: { model, messages, stream:false, options:{ temperature:0 } }
//   取 data.message.content；tokens 取 data.prompt_eval_count / data.eval_count（缺失记 0）
//   **无需 apiKey**：isConfigured 只看 baseUrl。
//
// 铁律：抛出的每个 Error 都带 code ∈ 'ai_moderation' | 'ai_error' | 'ai_timeout'；
//       错误信息只含 provider 名 / 状态码 / 错误码，**禁止**出现题目原文、响应体原文；
//       模块顶层无 I/O；不使用 process.exit；429 退避间隔可注入（retryBaseMs）。

const NAME = 'ollama';
const DEFAULT_MODEL = 'qwen2.5:7b';
const CHAT_PATH = '/api/chat';

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
  return new Promise((resolve) => {
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

function pickDetailCode(body) {
  if (!body || typeof body !== 'object') return undefined;
  if (typeof body.code === 'string' && body.code) return body.code;
  const e = body.error;
  if (e && typeof e === 'object' && typeof e.code === 'string' && e.code) return e.code;
  return undefined;
}

function isModerationCode(code) {
  if (typeof code !== 'string' || !code) return false;
  const low = code.toLowerCase();
  if (low.includes('datainspection')) return true;
  return MODERATION_CODES.some((c) => c.toLowerCase() === low);
}

export default {
  name: NAME,

  /** Ollama 免鉴权：只要 baseUrl 在就算可用。 */
  isConfigured(providerCfg) {
    try {
      const pc = providerCfg && typeof providerCfg === 'object' ? providerCfg : {};
      return typeof pc.baseUrl === 'string' && Boolean(pc.baseUrl.trim());
    } catch {
      return false;
    }
  },

  /**
   * @param {{role:string,content:string}[]} messages
   * @param {{providerCfg?:object, signal?:AbortSignal, timeoutMs?:number, env?:object,
   *          retryBaseMs?:number, retryMax?:number, fetchImpl?:Function, providerName?:string}} [opts]
   * @returns {Promise<{text:string, model:string, tokens:{in:number,out:number}}>}
   */
  async chat(messages, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const pc = o.providerCfg && typeof o.providerCfg === 'object' ? o.providerCfg : {};
    const providerName = typeof o.providerName === 'string' && o.providerName ? o.providerName : NAME;
    const mkErr = (code, detail, extra) => mkError(code, detail, extra, providerName);
    // fetchImpl 既可由 opts 注入，也可由 providerCfg 注入（测试用；生产走 globalThis.fetch）
    const doFetch = typeof o.fetchImpl === 'function'
      ? o.fetchImpl
      : (pc && typeof pc.fetchImpl === 'function' ? pc.fetchImpl : globalThis.fetch);

    const base = String(pc.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw mkErr('ai_error', '缺少 baseUrl');
    if (typeof doFetch !== 'function') throw mkErr('ai_error', '运行时缺少 fetch');
    if (!Array.isArray(messages) || !messages.length) throw mkErr('ai_error', 'messages 为空');

    const model = String(pc.model || DEFAULT_MODEL);
    const url = base + CHAT_PATH;
    const payload = JSON.stringify({
      model,
      messages,
      stream: false,
      options: { temperature: toNum(pc.temperature, 0) },
    });

    const retryBaseMs = toNum(o.retryBaseMs !== undefined ? o.retryBaseMs : pc.retryBaseMs, 1000);
    const retryMax = toInt(o.retryMax !== undefined ? o.retryMax : pc.retryMax, 2);
    const timeoutMs = toNum(o.timeoutMs !== undefined ? o.timeoutMs : pc.timeoutMs, 0);

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
            headers: { 'content-type': 'application/json' },
            body: payload,
            signal: ac.signal,
          });
        } catch (err) {
          if (ac.signal.aborted) {
            throw mkErr('ai_timeout', timeoutMs > 0 ? `请求超时（${timeoutMs}ms）` : '请求被取消');
          }
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
          // Ollama 本地模型一般无内容审核，但仍按同一套错误码识别，便于将来接入代理网关。
          if (isModerationCode(detailCode)
            || ((status === 400 || status === 500) && typeof text === 'string'
                && text.toLowerCase().includes('data inspection'))) {
            throw mkErr('ai_moderation', `HTTP ${status} 内容审核拦截`, {
              status,
              detailCode: detailCode || 'DataInspectionFailed',
              body,
            });
          }
          // Ollama 出错时常返回 { error: "model not found" }（字符串），只取状态码入日志。
          throw mkErr('ai_error', `HTTP ${status}`, { status, detailCode, body });
        }

        const data = parseJson(text);
        if (!data) throw mkErr('ai_error', '响应体不是合法 JSON');
        const content = data.message && data.message.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw mkErr('ai_error', 'content 为空');
        }
        return {
          text: content,
          model: String(data.model || model),
          tokens: {
            in: toInt(data.prompt_eval_count, 0),
            out: toInt(data.eval_count, 0),
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