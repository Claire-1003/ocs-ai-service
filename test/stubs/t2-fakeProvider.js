// test/stubs/t2-fakeProvider.js — T2 专用的本地假 LLM provider（node:http + listen(0)）
//
// 纪律（CONTRACT §11.1 / §11.2）：
//   - 一律 listen(0) 取随机端口，绝不监听 8080/11434，绝不联网；
//   - close() 会销毁所有 socket，避免 node --test 挂住；
//   - 桩文件只放在 T2 自己的 test/stubs/ 下。

import http from 'node:http';

// fetch 规范的「bad ports」：undici/Node fetch 拒绝连接这些端口（cause: bad port）。
// OS 给 listen(0) 随机分配到表中端口时，假 provider 会被测试客户端 fetch 直接拒绝 -> 随机假失败。
// T6 集成期实测复现（6000/6666 -> fetch failed: bad port）并修复：命中即重绑。
// 与 server.js 的 FETCH_BAD_PORTS 保持同一份清单（生产代码不 import 测试桩，故各自内联）。
export const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

/**
 * @param {(info:{method:string,url:string,headers:object,body:string,index:number}, i:number)
 *          => ({status?:number, body?:string, headers?:object, delayMs?:number}|Promise<any>)} handler
 */
export function createFakeProvider(handler) {
  const requests = [];
  const sockets = new Set();
  let closed = false;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const info = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw,
        index: requests.length,
      };
      requests.push(info);
      let out;
      try {
        out = handler(info, requests.length - 1);
      } catch (err) {
        safeEnd(res, { status: 500, body: JSON.stringify({ error: { code: 'StubError' } }) });
        return;
      }
      Promise.resolve(out).then(
        (spec) => {
          const s = spec && typeof spec === 'object' ? spec : {};
          if (s.delayMs > 0) {
            const t = setTimeout(() => safeEnd(res, s), s.delayMs);
            if (typeof t.unref === 'function') t.unref();
          } else {
            safeEnd(res, s);
          }
        },
        () => safeEnd(res, { status: 500, body: JSON.stringify({ error: { code: 'StubError' } }) }),
      );
    });
  });

  function safeEnd(res, spec) {
    if (closed) return;
    try {
      res.writeHead(spec.status || 200, spec.headers || { 'content-type': 'application/json' });
      res.end(spec.body === undefined ? '' : spec.body);
    } catch { /* socket 可能已被销毁（超时用例），忽略 */ }
  }

  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return {
    requests,
    get requestCount() { return requests.length; },
    async listen() {
      // T6 集成修复：随机端口命中 fetch bad port 时重绑（最多 32 次，概率上不可能连续命中）。
      for (let i = 0; i < 32; i++) {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        const port = server.address().port;
        if (!FETCH_BAD_PORTS.has(port)) return { port, baseUrl: `http://127.0.0.1:${port}` };
        await new Promise((resolve) => server.close(resolve));
      }
      throw new Error('fake provider: 连续 32 次随机端口都命中 fetch bad ports');
    },
    async close() {
      closed = true;
      for (const s of [...sockets]) { try { s.destroy(); } catch { /* ignore */ } }
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** OpenAI 兼容格式（bailian / openai）的成功响应 */
export function chatOK(content, extra = {}) {
  return {
    status: 200,
    body: JSON.stringify({
      id: 'stub-1',
      model: extra.model || 'stub-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      ...extra,
    }),
  };
}

/** Ollama /api/chat 的成功响应 */
export function ollamaOK(content, extra = {}) {
  return {
    status: 200,
    body: JSON.stringify({
      model: extra.model || 'stub-ollama',
      message: { role: 'assistant', content },
      done: true,
      prompt_eval_count: 13,
      eval_count: 5,
      ...extra,
    }),
  };
}

/** 错误响应；body 可为对象（自动 JSON 序列化）或字符串（如 HTML） */
export function chatErr(status, body) {
  return {
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: typeof body === 'string'
      ? { 'content-type': 'text/html; charset=utf-8' }
      : { 'content-type': 'application/json' },
  };
}

/** 依次消费 script 数组，用完后重复最后一项 */
export function scripted(script) {
  const list = Array.isArray(script) ? script : [script];
  return (info, i) => list[Math.min(i, list.length - 1)];
}

/** 按顺序消费 script，用完返回 undefined（交给 handler 默认值） */
export function once(script) {
  const list = Array.isArray(script) ? script : [script];
  let n = 0;
  return () => list[Math.min(n++, list.length - 1)];
}