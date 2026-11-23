// test/stubs/t3-gate.js — T3 自用的最小并发闸桩（形状照 CONTRACT §6 的 createGate）。
// lib/queue.js 属于 T2，可能尚未落地。FIFO、并发上限、队列上限、drain 齐备，无定时器泄漏。
export function createStubGate({ concurrency = 3, queueLimit = 200 } = {}) {
  let inflight = 0;
  let peak = 0;
  const q = [];
  const st = { completed: 0, failed: 0, rejected: 0, timeouts: 0, startedAt: Date.now() };
  function next() {
    while (inflight < concurrency && q.length) {
      const item = q.shift();
      inflight += 1;
      if (inflight > peak) peak = inflight; // 供断言「AI 实际并发 <= concurrency」
      Promise.resolve()
        .then(() => item.task(new AbortController().signal))
        .then(
          (r) => { inflight -= 1; st.completed += 1; item.resolve(r); next(); },
          (e) => { inflight -= 1; st.failed += 1; item.reject(e); next(); },
        );
    }
  }
  return {
    run(task) {
      if (inflight >= concurrency && q.length >= queueLimit) {
        st.rejected += 1;
        return Promise.reject(Object.assign(new Error('queue full'), { code: 'queue_full' }));
      }
      return new Promise((resolve, reject) => { q.push({ task, resolve, reject }); next(); });
    },
    stats() { return { inflight, queued: q.length, peak, ...st }; },
    get inflight() { return inflight; },
    get queued() { return q.length; },
    get peak() { return peak; },
    drain() {
      return new Promise((resolve) => {
        const t = setInterval(() => {
          if (inflight === 0 && q.length === 0) { clearInterval(t); resolve(); }
        }, 5);
        if (typeof t.unref === 'function') t.unref();
      });
    },
  };
}

export default createStubGate;