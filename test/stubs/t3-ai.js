// test/stubs/t3-ai.js — T3 自用的最小 AI 桩（形状照 CONTRACT §7 的 createAI 返回值）。
// lib/ai/* 属于 T2，可能尚未落地。可注入延迟、失败 reason、直接抛错，用于验证 server 行为。
export function createStubAI(opts = {}) {
  const { answer = 'A', ok = true, reason = 'ai_error', delayMs = 0, throwError = null } = opts;
  const counters = { calls: 0 };
  return {
    counters,
    async answer(req) {
      counters.calls += 1;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (throwError) throw throwError;
      if (!ok) return { ok: false, reason };
      const text = typeof answer === 'function' ? answer(req) : answer;
      return { ok: true, answer: text, provider: 'stub', model: 'stub-model', tokens: { in: 1, out: 2 } };
    },
    stats() {
      return { calls: counters.calls, success: counters.calls, failed: 0, byProvider: { stub: { calls: counters.calls, success: counters.calls, failed: 0, moderation: 0, timeout: 0, ms: 0 } }, tokensIn: counters.calls, tokensOut: counters.calls * 2, moderation: 0, queueFull: 0, chainExhausted: 0 };
    },
    chain: ['stub'],
  };
}

export default createStubAI;