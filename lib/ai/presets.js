// lib/ai/presets.js — Provider 预置表 + 实例解析（Patch 8：AI 层 provider 中立化）
//
// 契约：docs/CONTRACT.md §7；HANDOFF §7.1 / §10；ACCEPTANCE Patch 8（批准来源：用户 prompt §2，2026-11-23）。
// 纯数据 + 纯函数：模块顶层无 I/O；warnOnce 仅在被调用时写 stderr
// （进程内按 code 去重，config.js 与 lib/ai/index.js 共享；警告只含实例名 / 错误码）。
//
// impl 种类仅 'openai' | 'ollama'。预置只是「默认值包」：一切字段可被配置覆盖。
// 任何实现 OpenAI Chat Completions 兼容协议的服务，加一条配置即可入链，零代码改动。

const IMPLS = Object.freeze(['openai', 'ollama']);

// 内置预置表。来源（实施时按厂商官方文档核对，2026-11）：
//   dashscope     阿里云百炼 compatible-mode   help.aliyun.com/zh/model-studio/compatible-mode
//   openai        OpenAI 官方                  platform.openai.com/docs/api-reference/chat
//   deepseek      DeepSeek 官方（/v1 与模型版本无关） api-docs.deepseek.com/zh-cn/
//   kimi          Moonshot AI                  platform.moonshot.cn/docs/api/chat
//   zhipu         智谱 BigModel                docs.bigmodel.cn
//   siliconflow   硅基流动（Qwen/Qwen2.5-7B-Instruct 经核对 2026-04 下线名单后仍在线） docs.siliconflow.com
//   openrouter    OpenRouter 聚合网关（审核透传上游） openrouter.ai/docs
//   lmstudio      LM Studio 本地服务（免 Key；model 字段以实际加载模型为准） lmstudio.ai/docs
//   vllm          vLLM OpenAI 兼容服务（model 须覆盖为实际部署名） docs.vllm.ai
//   xinference    Xinference 本地推理（model 须覆盖为实际部署名） inference.readthedocs.io
//   ollama-openai Ollama 的 OpenAI 兼容端点（/v1，区别于原生 /api/chat） ollama.com/docs
export const PRESETS = Object.freeze({
  dashscope: Object.freeze({ impl: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-flash', apiKeyEnv: 'DASHSCOPE_API_KEY', temperature: 0, maxTokens: 64 }),
  openai: Object.freeze({ impl: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY', temperature: 0, maxTokens: 64 }),
  deepseek: Object.freeze({ impl: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY', temperature: 0, maxTokens: 64 }),
  kimi: Object.freeze({ impl: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', apiKeyEnv: 'MOONSHOT_API_KEY', temperature: 0, maxTokens: 64 }),
  zhipu: Object.freeze({ impl: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', apiKeyEnv: 'ZHIPU_API_KEY', temperature: 0, maxTokens: 64 }),
  siliconflow: Object.freeze({ impl: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', apiKeyEnv: 'SILICONFLOW_API_KEY', temperature: 0, maxTokens: 64 }),
  openrouter: Object.freeze({ impl: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', apiKeyEnv: 'OPENROUTER_API_KEY', temperature: 0, maxTokens: 64 }),
  lmstudio: Object.freeze({ impl: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', temperature: 0, maxTokens: 64 }),
  vllm: Object.freeze({ impl: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', model: 'local-model', temperature: 0, maxTokens: 64 }),
  xinference: Object.freeze({ impl: 'openai', baseUrl: 'http://127.0.0.1:9997/v1', model: 'local-model', temperature: 0, maxTokens: 64 }),
  'ollama-openai': Object.freeze({ impl: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', temperature: 0, maxTokens: 64 }),
});

// 审核签名表（preset → codes / keywords / finishReasons）。
// 全局兜底（DataInspectionFailed 族 + 400|500 'data inspection' 文案 + 200 finish_reason 'content_filter'）
// 在 openai.js / index.js 中恒生效；本表只**追加**厂商特有签名。来源：
//   dashscope   help.aliyun.com/zh/model-studio/error-code（DataInspectionFailed 族）
//   openai      OpenAI content_policy_violation + learn.microsoft.com Azure content-filter
//               （ContentFilter / innererror ResponsibleAIPolicyViolation / 'content management policy' 文案）
//   deepseek    api-docs.deepseek.com/zh-cn/guides/safety（400 'Content Exists Risk'；拒答时 finish_reason content_filter 且 content 空）
//   kimi        platform.moonshot.cn 错误文档（400 error.type/code content_filter，'considered high risk' 文案）
//   zhipu       docs.bigmodel.cn/cn/faq/api-code（code 1301，可能字符串或数字）+ securityaudit（finish_reason 'sensitive'）
//   siliconflow docs.siliconflow.com 错误码页未公布专用审核码 → 关键词签名（代理 DeepSeek 透传
//               'sensitive content' / 'content exists risk'）+ finish_reason 兜底
//   openrouter  审核透传上游 → openai + deepseek 签名并集
// 本地预置（lmstudio / vllm / xinference / ollama-openai）无审核签名，走全局兜底。
export const MODERATION_SIGNATURES = Object.freeze({
  dashscope: Object.freeze({
    codes: Object.freeze(['DataInspectionFailed', 'InvalidParameter.DataInspection', 'InternalError.Algo.DataInspectionFailed']),
    keywords: Object.freeze(['data inspection']),
    finishReasons: Object.freeze([]),
  }),
  openai: Object.freeze({
    codes: Object.freeze(['content_filter', 'content_policy_violation', 'ContentFilter', 'ResponsibleAIPolicyViolation']),
    keywords: Object.freeze(['content management policy']),
    finishReasons: Object.freeze(['content_filter']),
  }),
  deepseek: Object.freeze({
    codes: Object.freeze([]),
    keywords: Object.freeze(['content exists risk']),
    finishReasons: Object.freeze(['content_filter']),
  }),
  kimi: Object.freeze({
    codes: Object.freeze(['content_filter']),
    keywords: Object.freeze(['considered high risk']),
    finishReasons: Object.freeze([]),
  }),
  zhipu: Object.freeze({
    codes: Object.freeze(['1301']),
    keywords: Object.freeze(['不安全或敏感']),
    finishReasons: Object.freeze(['sensitive']),
  }),
  siliconflow: Object.freeze({
    codes: Object.freeze([]),
    keywords: Object.freeze(['sensitive content', 'content exists risk']),
    finishReasons: Object.freeze(['content_filter']),
  }),
  openrouter: Object.freeze({
    codes: Object.freeze(['content_filter', 'content_policy_violation']),
    keywords: Object.freeze(['content exists risk', 'content management policy']),
    finishReasons: Object.freeze(['content_filter']),
  }),
});

/** preset 名 → 审核签名（无该 preset 或无签名时返回 undefined）。 */
export function signatureFor(preset) {
  if (typeof preset !== 'string' || !preset) return undefined;
  return MODERATION_SIGNATURES[preset];
}

const warned = new Set();
function warnOnce(code, msg) {
  if (warned.has(code)) return;
  warned.add(code);
  process.stderr.write(`[qbank][ai][${code}] ${msg}\n`);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function presetDefaults(name) {
  const { impl, ...rest } = PRESETS[name];
  return rest;
}

/**
 * 把 config.providers 的一条原始配置解析为 { ok, impl, preset, cfg, errorCode }。
 * 规则（Patch 8）：
 *   - 显式 impl 优先；显式 preset 提供默认值（可被 raw 覆盖）并声明 impl；两者冲突 → 拒绝（防御）；
 *   - 未知 impl / preset → ok:false + stderr 警告一次（只含实例名 / 错误码），永不抛；
 *   - 两字段都缺省时按实例名推断：bailian→dashscope 预置、openai→openai 预置、
 *     ollama→ollama impl（不补任何默认值，baseUrl 必须自带）、其他名字→openai impl 无预置。
 * cfg 为「生效配置」= 预置默认 ← raw 覆盖，并附 impl / preset 字段。
 * @param {string} name 实例名（config.providers 的键 / ai.fallback 的成员）
 * @param {*} rawCfg 原始 provider 配置
 */
export function resolveInstance(name, rawCfg) {
  try {
    const raw = isPlainObject(rawCfg) ? rawCfg : {};
    const instName = typeof name === 'string' ? name : '';
    const hasImpl = raw.impl !== undefined && raw.impl !== null;
    const hasPreset = raw.preset !== undefined && raw.preset !== null;
    let impl;
    let preset;

    if (hasImpl) {
      if (typeof raw.impl !== 'string' || !IMPLS.includes(raw.impl)) {
        warnOnce(`unknown_impl_${instName}`, `provider "${instName}" 的 impl 未知，已从链上剔除（unknown_impl）`);
        return { ok: false, errorCode: 'unknown_impl' };
      }
      impl = raw.impl;
    }
    if (hasPreset) {
      if (typeof raw.preset !== 'string' || !PRESETS[raw.preset]) {
        warnOnce(`unknown_preset_${instName}`, `provider "${instName}" 的 preset 未知，已从链上剔除（unknown_preset）`);
        return { ok: false, errorCode: 'unknown_preset' };
      }
      preset = raw.preset;
      const declared = PRESETS[preset].impl;
      if (impl && impl !== declared) {
        warnOnce(`impl_preset_conflict_${instName}`, `provider "${instName}" 的 impl 与 preset 冲突，已从链上剔除（impl_preset_conflict）`);
        return { ok: false, errorCode: 'impl_preset_conflict' };
      }
      impl = declared;
    }

    let defaults = {};
    if (preset) {
      defaults = presetDefaults(preset);
    } else if (!impl) {
      if (instName === 'bailian') { preset = 'dashscope'; impl = 'openai'; defaults = presetDefaults('dashscope'); }
      else if (instName === 'openai') { preset = 'openai'; impl = 'openai'; defaults = presetDefaults('openai'); }
      else if (instName === 'ollama') { impl = 'ollama'; }
      else { impl = 'openai'; }
    }

    const cfg = { ...defaults, ...raw, impl };
    if (preset) cfg.preset = preset;
    else delete cfg.preset;
    return { ok: true, impl, preset, cfg };
  } catch {
    return { ok: false, errorCode: 'resolve_failed' };
  }
}

export default { PRESETS, MODERATION_SIGNATURES, signatureFor, resolveInstance };