// lib/queue.js — LLM 并发闸（Owner: T2）
//
// 契约：docs/CONTRACT.md §6；HANDOFF §8.1。
// 铁律：
//   - 队列满**立即** reject（code:'queue_full'），不入队、不占住调用方；
//   - 单请求超时用 AbortController，超时 reject（code:'ai_timeout'）并 abort signal；
//   - 单个 task 抛错绝不能中断后续调度；
//   - 不使用 setInterval，所有 setTimeout 在 settle 时 clearTimeout 且 unref()，
//     保证 node --test 不会挂住（CONTRACT §11.1）。
//   - 本模块不接触题目内容，日志纪律天然满足。

function toInt(v, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 内部错误：必须是带 err.code 的 Error（CONTRACT §0 枚举）。 */
function mkError(code, message) {
  const err = new Error(`[qbank][queue][${code}] ${message}`);
  err.code = code;
  return err;
}

/**
 * @param {{concurrency?:number, queueLimit?:number, timeoutMs?:number}} [opts]
 */
export function createGate(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const concurrency = toInt(o.concurrency, 3, 1, 1024);
  const queueLimit = toInt(o.queueLimit, 200, 0, 100000);
  const defaultTimeoutMs = toInt(o.timeoutMs, 20000, 0, 600000);

  const queue = []; // FIFO：{ task, resolve, reject, timeoutMs }
  const drainWaiters = [];
  let inflight = 0;
  let peak = 0; // P0-7/T6：历史并发峰值，供 e2e 断言「AI 实际并发 <= concurrency」
  let completed = 0;
  let failed = 0;
  let rejected = 0; // queue_full 计数
  let timeouts = 0;
  let closed = false;
  const startedAt = Date.now();

  function checkDrain() {
    if (inflight === 0 && queue.length === 0 && drainWaiters.length) {
      const waiters = drainWaiters.splice(0, drainWaiters.length);
      for (const w of waiters) {
        try { w(); } catch { /* 回调异常不得影响调度 */ }
      }
    }
  }

  function start(entry) {
    inflight += 1;
    if (inflight > peak) peak = inflight;
    let settled = false;
    const ac = new AbortController();
    let timer = null;

    const finish = (isOk, value) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      inflight -= 1;
      if (isOk) completed += 1; else failed += 1;
      try {
        if (isOk) entry.resolve(value); else entry.reject(value);
      } catch { /* 调用方 then/catch 里的异常不得影响闸门 */ }
      pump();
    };

    const timeoutMs = entry.timeoutMs;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        timeouts += 1;
        const err = mkError('ai_timeout', `任务超时（${timeoutMs}ms）`);
        try { ac.abort(err); } catch { /* AbortController.abort 不应抛，兜底忽略 */ }
        finish(false, err);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    let p;
    try {
      p = entry.task(ac.signal);
    } catch (err) {
      p = Promise.reject(err);
    }
    Promise.resolve(p).then(
      (v) => finish(true, v),
      (err) => {
        const e = err instanceof Error ? err : mkError('ai_error', '任务失败');
        if (!e.code) e.code = 'ai_error';
        finish(false, e);
      },
    );
  }

  function pump() {
    while (!closed && inflight < concurrency && queue.length > 0) {
      const entry = queue.shift();
      start(entry);
    }
    checkDrain();
  }

  /**
   * @param {(signal:AbortSignal)=>Promise<any>} task
   * @param {{timeoutMs?:number}} [runOpts]
   * @returns {Promise<any>}
   */
  function run(task, runOpts) {
    if (typeof task !== 'function') {
      return Promise.reject(mkError('bad_request', 'task 必须是函数'));
    }
    if (closed) {
      return Promise.reject(mkError('ai_error', '闸门已关闭'));
    }
    const ro = runOpts && typeof runOpts === 'object' ? runOpts : {};
    const timeoutMs = ro.timeoutMs === undefined
      ? defaultTimeoutMs
      : toInt(ro.timeoutMs, defaultTimeoutMs, 0, 600000);

    if (inflight >= concurrency) {
      if (queue.length >= queueLimit) {
        rejected += 1;
        // 立即 reject：不入队、不等待，调用方可以马上返回 queue_full
        return Promise.reject(mkError('queue_full', `队列已满（上限 ${queueLimit}）`));
      }
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject, timeoutMs });
      });
    }
    return new Promise((resolve, reject) => {
      start({ task, resolve, reject, timeoutMs });
    });
  }

  function stats() {
    return {
      inflight,
      peak,
      queued: queue.length,
      completed,
      failed,
      rejected,
      timeouts,
      startedAt,
    };
  }

  /** 等待在途任务与队列全部结束（优雅退出用）。 */
  function drain() {
    if (inflight === 0 && queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => { drainWaiters.push(resolve); });
  }

  /** 停止调度新任务（不 abort 在途任务）。仅供退出钩子使用。 */
  function close() {
    closed = true;
    while (queue.length) {
      const entry = queue.shift();
      rejected += 1;
      try { entry.reject(mkError('queue_full', '闸门已关闭')); } catch { /* ignore */ }
    }
    checkDrain();
  }

  return {
    run,
    stats,
    drain,
    close,
    get inflight() { return inflight; },
    get queued() { return queue.length; },
    get concurrency() { return concurrency; },
    get queueLimit() { return queueLimit; },
  };
}

export default { createGate };