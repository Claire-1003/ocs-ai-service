// test/queue.test.js — lib/queue.js（Owner: T2）
// 纪律：无网络、无端口、无文件 I/O；所有 sleep <= 30ms（CONTRACT §11.6）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate } from '../lib/queue.js';
import { sleep } from './stubs/t2-fakeLog.js';

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('并发 20 个任务时在途数恒 <= 3，且全部完成', async () => {
  const gate = createGate({ concurrency: 3, queueLimit: 200, timeoutMs: 2000 });
  let inflight = 0;
  let maxInflight = 0;
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => gate.run(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await sleep(5);
      inflight -= 1;
      return i;
    })),
  );
  assert.deepEqual(results, Array.from({ length: 20 }, (_, i) => i));
  assert.ok(maxInflight <= 3, `最大在途数应 <= 3，实际 ${maxInflight}`);
  assert.equal(maxInflight, 3, '并发应被真正用满到 3');
  assert.equal(gate.inflight, 0);
  assert.equal(gate.queued, 0);
  const s = gate.stats();
  assert.deepEqual(
    { inflight: s.inflight, queued: s.queued, completed: s.completed, failed: s.failed, rejected: s.rejected, timeouts: s.timeouts },
    { inflight: 0, queued: 0, completed: 20, failed: 0, rejected: 0, timeouts: 0 },
  );
  assert.ok(Number.isInteger(s.startedAt) && s.startedAt > 0);
});

test('concurrency=1 时严格 FIFO', async () => {
  const gate = createGate({ concurrency: 1, queueLimit: 50, timeoutMs: 2000 });
  const started = [];
  const finished = [];
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => gate.run(async () => {
      started.push(i);
      await sleep(2);
      finished.push(i);
    })),
  );
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(finished, started);
  assert.equal(gate.stats().completed, 12);
});

test('concurrency=3 时入队部分仍按 FIFO 出队', async () => {
  const gate = createGate({ concurrency: 3, queueLimit: 50, timeoutMs: 2000 });
  const started = [];
  const block = deferred();
  // 前 3 个占住并发槽
  const head = [0, 1, 2].map((i) => gate.run(async () => { started.push(i); await block.promise; }));
  assert.equal(gate.inflight, 3);
  const rest = [3, 4, 5, 6].map((i) => gate.run(async () => { started.push(i); }));
  assert.equal(gate.queued, 4);
  block.resolve();
  await Promise.all([...head, ...rest]);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
});

test('queueLimit=5：排到第 6 个立即 reject queue_full，不入队、不等待', async () => {
  const gate = createGate({ concurrency: 1, queueLimit: 5, timeoutMs: 2000 });
  const block = deferred();
  const running = gate.run(() => block.promise);          // 占住唯一并发槽
  const queued = [1, 2, 3, 4, 5].map(() => gate.run(async () => 'q'));
  assert.equal(gate.inflight, 1);
  assert.equal(gate.queued, 5);

  const t0 = Date.now();
  let caught = null;
  await gate.run(async () => 'never').then(null, (e) => { caught = e; });
  const elapsed = Date.now() - t0;

  assert.ok(caught instanceof Error, '必须 reject 一个 Error');
  assert.equal(caught.code, 'queue_full');
  assert.equal(elapsed < 50, true, `queue_full 必须立即返回，实际耗时 ${elapsed}ms`);
  assert.equal(gate.queued, 5, 'queue_full 的请求不得入队');
  assert.equal(gate.stats().rejected, 1);

  block.resolve();
  await Promise.all([running, ...queued]);
  const s = gate.stats();
  assert.deepEqual({ completed: s.completed, failed: s.failed, rejected: s.rejected }, { completed: 6, failed: 0, rejected: 1 });
});

test('concurrency=3 / queueLimit=5：第 9 个提交立即 queue_full', async () => {
  const gate = createGate({ concurrency: 3, queueLimit: 5, timeoutMs: 2000 });
  const block = deferred();
  const running = [0, 1, 2].map(() => gate.run(() => block.promise));
  const queued = [3, 4, 5, 6, 7].map(() => gate.run(() => block.promise.then(() => 'q')));
  assert.equal(gate.inflight, 3);
  assert.equal(gate.queued, 5);
  await assert.rejects(() => gate.run(async () => 'x'), (err) => err.code === 'queue_full');
  block.resolve();
  await Promise.all([...running, ...queued]);
  assert.equal(gate.stats().rejected, 1);
});

test('queueLimit=0：并发槽满时立即 queue_full', async () => {
  const gate = createGate({ concurrency: 1, queueLimit: 0, timeoutMs: 2000 });
  const block = deferred();
  const running = gate.run(() => block.promise);
  await assert.rejects(() => gate.run(async () => 1), (err) => err.code === 'queue_full');
  block.resolve();
  await running;
  assert.equal(await gate.run(async () => 2), 2);
});

test('超时：reject ai_timeout 且 abort 传给 task 的 signal，后续调度不受影响', async () => {
  const gate = createGate({ concurrency: 1, queueLimit: 10, timeoutMs: 20 });
  let seenSignal = null;
  const t0 = Date.now();
  await assert.rejects(
    () => gate.run((signal) => {
      seenSignal = signal;
      return new Promise(() => {}); // 永不 settle，靠闸门超时
    }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'ai_timeout');
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 200, '超时必须按注入的 20ms 触发');
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenSignal.aborted, true, '超时后必须 abort signal');
  const s = gate.stats();
  assert.equal(s.timeouts, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.completed, 0);
  // 闸门仍可继续调度
  assert.equal(await gate.run(async () => 'ok'), 'ok');
  assert.equal(gate.stats().completed, 1);
});

test('opts.timeoutMs 可覆盖闸门默认值', async () => {
  const gate = createGate({ concurrency: 2, queueLimit: 10, timeoutMs: 5000 });
  await assert.rejects(
    () => gate.run(() => new Promise(() => {}), { timeoutMs: 15 }),
    (err) => err.code === 'ai_timeout',
  );
  assert.equal(await gate.run(async () => 'fast', { timeoutMs: 5000 }), 'fast');
});

test('timeoutMs=0 表示不设超时', async () => {
  const gate = createGate({ concurrency: 1, queueLimit: 5, timeoutMs: 0 });
  const block = deferred();
  const p = gate.run(() => block.promise);
  await sleep(30);
  assert.equal(gate.stats().timeouts, 0);
  block.resolve('done');
  assert.equal(await p, 'done');
});

test('单个 task 抛错（同步 throw / reject / 非 Error）不中断后续调度', async () => {
  const gate = createGate({ concurrency: 2, queueLimit: 20, timeoutMs: 2000 });
  const boom = new Error('boom');
  boom.code = 'ai_error';
  const results = await Promise.allSettled([
    gate.run(() => { throw boom; }),                 // 同步抛
    gate.run(async () => { throw boom; }),            // async reject
    gate.run(async () => Promise.reject('字符串错误')), // 非 Error
    gate.run(async () => 'ok1'),
    gate.run(async () => 'ok2'),
    gate.run(async () => 'ok3'),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason, boom);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'ai_error');
  assert.equal(results[2].status, 'rejected');
  assert.equal(results[2].reason.code, 'ai_error', '非 Error 拒绝要收敛成带 code 的 Error');
  assert.deepEqual(results.slice(3).map((r) => r.value), ['ok1', 'ok2', 'ok3']);
  const s = gate.stats();
  assert.equal(s.completed, 3);
  assert.equal(s.failed, 3);
  assert.equal(gate.inflight, 0);
  assert.equal(gate.queued, 0);
});

test('drain() 在全部结束后 resolve；空闲时立即 resolve', async () => {
  const gate = createGate({ concurrency: 2, queueLimit: 20, timeoutMs: 2000 });
  await gate.drain(); // 空闲
  let done = 0;
  for (let i = 0; i < 6; i += 1) {
    gate.run(async () => { await sleep(5); done += 1; }).catch(() => {});
  }
  assert.ok(gate.inflight > 0 || gate.queued > 0);
  await gate.drain();
  assert.equal(done, 6);
  assert.equal(gate.inflight, 0);
  assert.equal(gate.queued, 0);
  assert.equal(gate.stats().completed, 6);
});

test('入参非法 / 默认值：task 非函数 reject bad_request，默认并发 3 队列 200', () => {
  const gate = createGate();
  assert.equal(gate.concurrency, 3);
  assert.equal(gate.queueLimit, 200);
  return assert.rejects(() => gate.run('not-a-function'), (err) => err.code === 'bad_request');
});

test('close() 后清空队列且不再调度新任务', async () => {
  const gate = createGate({ concurrency: 1, queueLimit: 10, timeoutMs: 2000 });
  const block = deferred();
  const running = gate.run(() => block.promise);
  const queued = gate.run(async () => 'q');
  gate.close();
  await assert.rejects(() => queued, (err) => err.code === 'queue_full');
  await assert.rejects(() => gate.run(async () => 'x'), (err) => err.code === 'ai_error');
  assert.equal(gate.queued, 0);
  block.resolve();
  await running;
  await gate.drain();
  assert.equal(gate.inflight, 0);
});