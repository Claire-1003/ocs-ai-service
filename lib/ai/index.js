// lib/ai/index.js — Provider 路由 + fallback 链 + 审核错误识别（Owner: T2）
//
// 契约：docs/CONTRACT.md §7；HANDOFF §7.1 / §7.5 / §8.1；DECISIONS #1 #9；ACCEPTANCE Patch 8。
// Patch 8（provider 中立化）：链上成员是任意实例名，经 presets.js 解析到 impl（'openai'|'ollama'）；
// 百炼降格为 dashscope 预置，代码不硬编码任何「主力」。
//
// 导出：
//   export const MODERATION_CODES
//   export function isModerationError(errOrBody, signature?)  // Patch 8：第二参可选（preset 名或签名对象）
//   export function createAI({ config, env, log, gate })
//     -> { answer({key,type,title,options}), stats(), chain }
//
// 铁律：
//   - answer() **永不抛异常、永不 reject**，一律返回 {ok:false, reason}；
//   - 命中审核错误不重试同 provider，直接切下一家，并调 log.moderation(key, code, provider)；
//   - 日志/stderr 只允许出现 key、错误码、计数、耗时、provider 名，
//     **禁止**出现题干、选项、答案原文、API Key（CONTRACT §11.5）；
//   - 模块顶层无 I/O、无副作用；不使用 process.exit。

import { buildMessages } from '../prompt.js';
import { postProcess } from '../answer.js';
import openai from './openai.js';
import ollama from './ollama.js';
import { resolveInstance, signatureFor } from './presets.js';

export const MODERATION_CODES = Object.freeze([
  'DataInspectionFailed',
  'InvalidParameter.DataInspection',
  'InternalError.Algo.DataInspectionFailed',
]);

// 内部注册表（不导出，避免扩张契约接口）。
// Patch 8：以 impl 为键（'openai'|'ollama'）；实例名经 presets.js 解析（bailian 降格为 dashscope 预置）。
const REGISTRY = Object.freeze({ openai, ollama });

const PUBLIC_REASON = new Set([
  'no_match', 'ai_timeout', 'ai_moderation', 'ai_error',
  'queue_full', 'image_or_formula', 'ai_disabled',
]);

function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 只把内部码收敛到 HANDOFF §4.2 的对外枚举；invalid_output 等一律映射为 ai_error（DECISIONS #9）。 */
function publicReason(code) {
  return PUBLIC_REASON.has(code) ? code : 'ai_error';
}

function lowerIncludes(hay, needle) {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle);
}

/**
 * 审核错误识别。入参可以是：provider 抛出的 Error、HTTP 响应体对象、或任意 body。
 * 检查 body.code / body.error.code / err.code（含 'ai_moderation'）/ HTTP 400|500 且文案含 'data inspection'。
 * @param {*} errOrBody
 * @param {string|{codes?:string[],keywords?:string[]}} [signature] Patch 8：实例级签名（preset 名或签名对象）；
 *   缺省时行为与旧版逐字一致（全局兜底）。
 * @returns {boolean}
 */
export function isModerationError(errOrBody, signature) {
  try {
    const v = errOrBody;
    if (!v || typeof v !== 'object') return false;

    const codes = [];
    const push = (c) => { if (typeof c === 'string' && c) codes.push(c); };
    push(v.code);
    push(v.detailCode);
    push(v.moderationCode);
    const e = v.error;
    if (e && typeof e === 'object') push(e.code);
    const b = v.body;
    if (b && typeof b === 'object') {
      push(b.code);
      const be = b.error;
      if (be && typeof be === 'object') push(be.code);
    }
    if (codes.includes('ai_moderation')) return true;
    for (const c of codes) {
      const low = c.toLowerCase();
      if (MODERATION_CODES.some((m) => m.toLowerCase() === low)) return true;
      if (low.includes('datainspection')) return true;
    }

    const status = toInt(v.status !== undefined ? v.status : v.statusCode, 0)
      || (e && typeof e === 'object' ? toInt(e.status, 0) : 0);
    if (status === 400 || status === 500) {
      const msg = `${typeof v.message === 'string' ? v.message : ''} ${typeof e === 'string' ? e : ''}`;
      if (lowerIncludes(msg, 'data inspection')) return true;
      if (b && lowerIncludes(JSON.stringify(b), 'data inspection')) return true;
    }

    // Patch 8：实例级签名（第二参）。单参调用不进入此分支，全局兜底行为逐字不变。
    const sig = typeof signature === 'string' ? signatureFor(signature)
      : (signature && typeof signature === 'object' ? signature : null);
    if (sig) {
      const sigCodes = [];
      const pushSig = (c) => {
        if (typeof c === 'string' && c) sigCodes.push(c);
        else if (typeof c === 'number' && Number.isFinite(c)) sigCodes.push(String(c));
      };
      pushSig(v.code); pushSig(v.detailCode); pushSig(v.moderationCode); pushSig(v.type);
      if (e && typeof e === 'object') {
        pushSig(e.code); pushSig(e.type);
        if (e.innererror && typeof e.innererror === 'object') pushSig(e.innererror.code);
      }
      if (b && typeof b === 'object') {
        pushSig(b.code); pushSig(b.type);
        const be = b.error;
        if (be && typeof be === 'object') {
          pushSig(be.code); pushSig(be.type);
          if (be.innererror && typeof be.innererror === 'object') pushSig(be.innererror.code);
        }
      }
      if (Array.isArray(sig.codes)) {
        for (const c of sigCodes) {
          const low = c.toLowerCase();
          if (sig.codes.some((m) => String(m).toLowerCase() === low)) return true;
        }
      }
      if ((status === 400 || status === 500) && Array.isArray(sig.keywords)) {
        const msg = `${typeof v.message === 'string' ? v.message : ''} ${typeof e === 'string' ? e : ''}`;
        const bodyStr = b ? JSON.stringify(b) : '';
        for (const kw of sig.keywords) {
          if (typeof kw !== 'string' || !kw) continue;
          if (lowerIncludes(msg, kw.toLowerCase()) || lowerIncludes(bodyStr, kw.toLowerCase())) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** 从错误对象里取出可写日志的审核错误码（不含任何题目内容）。 */
function moderationCodeOf(err) {
  try {
    if (err && typeof err === 'object') {
      if (typeof err.detailCode === 'string' && err.detailCode) return err.detailCode;
      const b = err.body;
      if (b && typeof b === 'object') {
        if (typeof b.code === 'string' && b.code) return b.code;
        if (b.error && typeof b.error === 'object' && typeof b.error.code === 'string') return b.error.code;
      }
    }
  } catch { /* ignore */ }
  return 'ai_moderation';
}

function newProviderStat() {
  return { calls: 0, success: 0, failed: 0, moderation: 0, timeout: 0, ms: 0 };
}

/**
 * @param {{config?:object, env?:object, log?:object, gate?:object}} [deps]
 *   log: { moderation(key, code, provider), error(scope, errCode), info(scope, obj) } —— 由 server 注入，可选
 *   gate: 保留入参（兼容签名）。P0-7 裁决后 AI 内部**不再**包闸：
 *         gate 由 server 单层包裹（server.js 第 7 步 gate.run(() => ai.answer(...))），
 *         双层闸会死锁。queue_full / ai_timeout 由 server 侧从 gate 的 reject 中取 code。
 */
export function createAI(deps = {}) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const config = d.config && typeof d.config === 'object' ? d.config : {};
  const ai = config.ai && typeof config.ai === 'object' ? config.ai : {};
  const providersCfg = config.providers && typeof config.providers === 'object' ? config.providers : {};
  const env = d.env && typeof d.env === 'object' ? d.env : process.env;
  const log = d.log && typeof d.log === 'object' ? d.log : null;
  const gate = d.gate && typeof d.gate.run === 'function' ? d.gate : null;

  const enabled = ai.enabled !== false;
  const timeoutMs = toInt(ai.timeoutMs, 20000);

  // 剔除 isConfigured=false 的 provider（config.js 也会剔除一次，这里做二次保险）。
  // Patch 8：实例名 → resolveInstance（preset/impl）→ impl 模块；未知 impl/preset 由 presets.js 警告一次并剔除。
  const chain = [];
  const resolved = new Map();
  const fallback = Array.isArray(ai.fallback) ? ai.fallback : [];
  for (const name of fallback) {
    const pc = providersCfg[name];
    if (!pc || typeof pc !== 'object' || Array.isArray(pc)) continue;
    const r = resolveInstance(name, pc);
    if (!r.ok) continue;
    const provider = REGISTRY[r.impl];
    if (!provider || typeof provider.isConfigured !== 'function') continue;
    let ok = false;
    try { ok = Boolean(provider.isConfigured(r.cfg, env)); } catch { ok = false; }
    if (ok) {
      chain.push(name);
      resolved.set(name, { impl: r.impl, preset: r.preset, cfg: r.cfg, provider });
    }
  }

  const statsState = {
    calls: 0,
    success: 0,
    failed: 0,
    byProvider: {},
    tokensIn: 0,
    tokensOut: 0,
    moderation: 0,
    queueFull: 0,
    chainExhausted: 0,
  };
  for (const name of chain) statsState.byProvider[name] = newProviderStat();

  let emptyChainWarned = false;

  function safeLog(kind, a, b, c) {
    if (!log) return;
    try {
      if (kind === 'moderation' && typeof log.moderation === 'function') log.moderation(a, b, c);
      else if (kind === 'error' && typeof log.error === 'function') log.error(a, b);
      else if (kind === 'info' && typeof log.info === 'function') log.info(a, b);
    } catch { /* 日志器异常绝不影响主流程 */ }
  }

  function bucket(name) {
    if (!statsState.byProvider[name]) statsState.byProvider[name] = newProviderStat();
    return statsState.byProvider[name];
  }

  async function runChain(input) {
    const key = typeof input.key === 'string' ? input.key : '';
    const type = input.type;
    const title = input.title;
    const options = input.options;
    const messages = buildMessages({ type, title, options });
    const retryBaseMs = ai.retryBaseMs !== undefined ? ai.retryBaseMs : undefined;
    let lastCode = 'ai_error';

    for (const name of chain) {
      const inst = resolved.get(name);
      const provider = inst.provider;
      const pc = inst.cfg;
      const st = bucket(name);
      statsState.calls += 1;
      st.calls += 1;
      const t0 = Date.now();

      let res;
      try {
        res = await provider.chat(messages, {
          providerCfg: pc,
          providerName: name,
          timeoutMs,
          env,
          ...(retryBaseMs === undefined ? {} : { retryBaseMs }),
        });
      } catch (err) {
        const ms = Date.now() - t0;
        st.ms += ms;
        st.failed += 1;
        statsState.failed += 1;

        if (isModerationError(err, inst.preset)) {
          st.moderation += 1;
          statsState.moderation += 1;
          lastCode = 'ai_moderation';
          // 只传 key / 错误码 / provider 名，绝不传题目原文
          safeLog('moderation', key, moderationCodeOf(err), name);
          safeLog('error', name, 'ai_moderation');
          continue; // 不重试同 provider
        }

        const code = err && typeof err.code === 'string' ? err.code : 'ai_error';
        if (code === 'ai_timeout') {
          st.timeout += 1;
          lastCode = 'ai_timeout';
        } else {
          lastCode = 'ai_error';
        }
        safeLog('error', name, code);
        continue;
      }

      const ms = Date.now() - t0;
      st.ms += ms;

      let pp;
      try {
        pp = postProcess(res && res.text, { type, options });
      } catch {
        pp = { ok: false, code: 'invalid_output' };
      }
      if (!pp || pp.ok !== true || typeof pp.answer !== 'string' || !pp.answer) {
        st.failed += 1;
        statsState.failed += 1;
        lastCode = 'ai_error'; // DECISIONS #9：invalid_output 对外归 ai_error
        safeLog('error', name, 'invalid_output');
        continue;
      }

      const tokens = res && res.tokens && typeof res.tokens === 'object' ? res.tokens : { in: 0, out: 0 };
      const tin = toInt(tokens.in, 0);
      const tout = toInt(tokens.out, 0);
      st.success += 1;
      statsState.success += 1;
      statsState.tokensIn += tin;
      statsState.tokensOut += tout;
      safeLog('info', name, { ok: true, ms, via: pp.via, model: String((res && res.model) || '') });

      return {
        ok: true,
        answer: pp.answer,
        provider: name,
        model: String((res && res.model) || (pc && pc.model) || ''),
        tokens: { in: tin, out: tout },
      };
    }

    statsState.chainExhausted += 1;
    return { ok: false, reason: publicReason(lastCode) };
  }

  /**
   * @param {{key?:string, type?:string, title?:string, options?:string[]|string}} input
   * @returns {Promise<{ok:true,answer:string,provider:string,model:string,tokens:{in:number,out:number}} | {ok:false,reason:string}>}
   */
  async function answer(input) {
    try {
      if (!enabled) return { ok: false, reason: 'ai_disabled' };
      if (!chain.length) {
        if (!emptyChainWarned) {
          emptyChainWarned = true;
          process.stderr.write('[qbank][ai][ai_error] 未配置任何可用 provider，请设置 DASHSCOPE_API_KEY\n');
        }
        statsState.calls += 1;
        statsState.failed += 1;
        return { ok: false, reason: 'ai_error' };
      }
      const arg = input && typeof input === 'object' ? input : {};

      // P0-7（T6 裁决）：gate 由 server 创建且只包**一层**（CONTRACT §6/§7/§8）。
      // AI 内部不再包闸，否则双层闸在 concurrency=N 时会互相占槽死锁（外层 N 个槽
      // 被占满后内层永远拿不到槽，直到 timeoutMs 才失败）。gate 入参保留仅为兼容签名。
      void gate;
      return await runChain(arg);
    } catch (err) {
      // answer() 永不抛：任何意外都收敛成 ai_error
      const code = err && typeof err.code === 'string' ? err.code : 'ai_error';
      safeLog('error', 'ai', code);
      return { ok: false, reason: publicReason(code) };
    }
  }

  function stats() {
    const byProvider = {};
    for (const [name, v] of Object.entries(statsState.byProvider)) byProvider[name] = { ...v };
    return {
      calls: statsState.calls,
      success: statsState.success,
      failed: statsState.failed,
      byProvider,
      tokensIn: statsState.tokensIn,
      tokensOut: statsState.tokensOut,
      moderation: statsState.moderation,
      queueFull: statsState.queueFull,
      chainExhausted: statsState.chainExhausted,
    };
  }

  return {
    answer,
    stats,
    get chain() { return [...chain]; },
    get enabled() { return enabled; },
  };
}

export default { MODERATION_CODES, isModerationError, createAI };