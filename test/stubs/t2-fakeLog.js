// test/stubs/t2-fakeLog.js — T2 专用的假日志器（CONTRACT §7 的 log 注入接口）
// 记录所有回调参数，供断言「日志里不含题目原文」。

export function createFakeLog() {
  const calls = { moderation: [], error: [], info: [] };
  return {
    calls,
    moderation(key, code, provider) { calls.moderation.push({ key, code, provider }); },
    error(scope, errCode) { calls.error.push({ scope, errCode }); },
    info(scope, obj) { calls.info.push({ scope, obj }); },
    /** 所有回调参数拼成一个字符串，用于「不含题干/选项/答案原文」断言 */
    dump() {
      return JSON.stringify(calls);
    },
  };
}

export function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** 构造测试用配置对象（不落盘、不读仓库 config.json） */
export function makeConfig({ chain = ['bailian'], providers = {}, ai = {} } = {}) {
  return {
    ai: {
      enabled: true,
      fallback: chain,
      concurrency: 3,
      queueLimit: 200,
      timeoutMs: 1000,
      ...ai,
    },
    providers,
  };
}

export const FAKE_ENV = Object.freeze({
  DASHSCOPE_API_KEY: 'sk-xxxxxxxx',
  OPENAI_API_KEY: 'sk-xxxxxxxx',
});