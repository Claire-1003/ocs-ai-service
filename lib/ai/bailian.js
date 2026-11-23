// lib/ai/bailian.js — 百炼（DashScope）预置薄壳（Patch 8：provider 中立化）
//
// 契约：docs/CONTRACT.md §7；HANDOFF §7.2；ACCEPTANCE Patch 8。
// 百炼不再是「主力」，只是 openai 兼容通用实现的一个预置（presets.js 的 dashscope）。
// 本文件保留为薄壳，仅为兼容直接 import 本模块的既有调用方（test/ai.test.js 等）：
//   - chat 委托 openai 通用体，只补**参数默认**（model/temperature/maxTokens）与 preset 签名；
//   - **不补 baseUrl / apiKeyEnv**：缺 baseUrl 仍抛 ai_error，绝不隐式联网；
//   - isConfigured 与 openai 通用体完全一致（缺 baseUrl 或 apiKeyEnv 对应 Key 即 false）。
// 路由层（lib/ai/index.js）按实例名解析预置后直接调用 openai 通用体，不再经过本壳。
//
// 铁律：抛出的每个 Error 都带 code ∈ 'ai_moderation' | 'ai_error' | 'ai_timeout'；
//       错误信息只含 provider 名 / 状态码 / 错误码；模块顶层无 I/O；不使用 process.exit。

import openai from './openai.js';

const NAME = 'bailian';
// 与旧版 bailian.js 逐字一致的参数默认（不含 baseUrl/apiKeyEnv，理由见上）。
const PARAM_DEFAULTS = Object.freeze({ model: 'qwen-flash', temperature: 0, maxTokens: 64 });

export default {
  name: NAME,

  isConfigured(providerCfg, env) {
    return openai.isConfigured(providerCfg, env);
  },

  async chat(messages, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const pc = o.providerCfg && typeof o.providerCfg === 'object' ? o.providerCfg : {};
    const merged = { ...PARAM_DEFAULTS, ...pc };
    if (!merged.preset) merged.preset = 'dashscope';
    return openai.chat(messages, {
      ...o,
      providerCfg: merged,
      providerName: typeof o.providerName === 'string' && o.providerName ? o.providerName : NAME,
    });
  },
};