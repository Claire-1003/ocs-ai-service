// test/stubs/t5-readme-smoke.js — T5 专属：验证 README「冒烟自测」章节写出来的流程真的能跑通。
//
// 隔离纪律（CONTRACT §11）：
//   - 数据只写 os.tmpdir() 下的 qbank-t5-smoke-* 临时目录，结束 rmSync；绝不碰仓库 data/ logs/
//   - 服务用 QBANK_PORT=0 让内核分配随机端口（从 stderr 的 listening 行解析），绝不监听 8080
//   - 子进程用 SIGINT 优雅关闭并等待退出，不留孤儿进程 / interval
//   - 题干一律用「示例题干」占位文本，不出现任何真实题目原文或 API Key
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const NODE = process.execPath;

// 隔离修正（2026-11-22，T6 验收期）：宿主机可能持久设置了 DASHSCOPE_API_KEY（用户级环境变量），
// 显式剔除 Key 类变量，保证本测试的「缺 Key」场景在任何机器上可复现；断言语义不变。
const baseEnv = { ...process.env };
delete baseEnv.DASHSCOPE_API_KEY;
delete baseEnv.OPENAI_API_KEY;

const DEMO_TITLE = '示例题干：甲等于多少';
const DEMO_OPTS = 'A.一#B.二#C.三#D.四';
const DEMO_CSV = `question,type,options,answer\r\n${DEMO_TITLE},单选题,A.一|B.二|C.三|D.四,B\r\n`;

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-t5-smoke-'));
}

function waitForPort(stderrBuf, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const m = /\[qbank\]\[server\]\[listening\] http:\/\/[^:]+:(\d+)/.exec(stderrBuf.text);
      if (m) return resolve(Number(m[1]));
      if (stderrBuf.exited) return reject(new Error('server 提前退出：' + stderrBuf.text.slice(-400)));
      if (Date.now() - started > timeoutMs) return reject(new Error('等待 listening 超时'));
      setTimeout(tick, 25).unref();
      return undefined;
    };
    tick();
  });
}

async function getJson(port, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  assert.equal(res.status, 200, `${pathname} 必须 200`);
  assert.match(String(res.headers.get('content-type') || ''), /application\/json/);
  return res.json();
}

test('README §2.4 冒烟流程：import -> server -> /health /api /stats（临时目录 + 随机端口）', async (t) => {
  const tmp = mkTmp();
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } });

  // 1) 造一条占位数据并导入到临时 bank.json（显式 --out，不写仓库 data/）
  const csvPath = path.join(tmp, 'demo.csv');
  fs.writeFileSync(csvPath, DEMO_CSV, 'utf8');
  const bankPath = path.join(tmp, 'bank.json');
  const imp = spawnSync(NODE, ['tools/import.js', '--file', csvPath, '--format', 'csv', '--out', bankPath], {
    cwd: ROOT, encoding: 'utf8', env: { ...baseEnv, QBANK_DATA_DIR: tmp, QBANK_LOGS_DIR: tmp },
  });
  assert.equal(imp.status, 0, `import 退出码：${imp.stderr}`);
  const stat = JSON.parse(imp.stdout.trim().split('\n').pop());
  assert.deepEqual(
    { parsed: stat.parsed, imported: stat.imported, failed: stat.failed, duplicates: stat.duplicates },
    { parsed: 1, imported: 1, failed: 0, duplicates: 0 },
  );
  assert.ok(fs.existsSync(bankPath), 'bank.json 必须落盘到 --out 指定路径');

  // 2) 起服务：QBANK_PORT=0 取随机端口；关掉 AI，确保不联网
  const buf = { text: '', exited: false };
  const child = spawn(NODE, ['server.js'], {
    cwd: ROOT,
    env: {
      ...baseEnv,
      QBANK_DATA_DIR: tmp,
      QBANK_LOGS_DIR: tmp,
      QBANK_PORT: '0',
      QBANK_AI_ENABLED: 'false',
      QBANK_WRITEBACK: 'false',
    },
  });
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', (d) => { buf.text += d; });
  child.stdout.on('data', () => { /* 服务不往 stdout 写业务日志 */ });
  child.on('exit', () => { buf.exited = true; });
  t.after(() => {
    if (child.exitCode === null && !child.killed) { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } }
  });

  let port;
  try {
    port = await waitForPort(buf);
  } catch (err) {
    try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
    throw err;
  }
  assert.ok(port > 0 && port !== 8080, `必须用随机端口，实际 ${port}`);
  assert.match(buf.text, /\[qbank\]\[server\]\[listening\]/, '启动日志格式');

  // 3) /health
  const health = await getJson(port, '/health');
  assert.equal(health.code, 1);
  assert.equal(health.status, 'ok');
  assert.equal(health.bank, 1, '题库条数应等于导入条数');
  // T6/P0-8：/health.ai 由裸数组升级为 { enabled, chain } 对象（契约增补，见 docs/ACCEPTANCE.md）
  assert.equal(typeof health.ai, 'object', '/health.ai 必须是对象');
  assert.ok(!Array.isArray(health.ai), '/health.ai 必须是 { enabled, chain } 对象');
  assert.equal(typeof health.ai.enabled, 'boolean', '/health.ai.enabled 必须是布尔');
  assert.ok(Array.isArray(health.ai.chain), '/health.ai.chain 必须是数组');
  // 注意：ai.enabled=false 不会清空 chain（chain 反映「配好且可用的 provider」），
  // 但 answer() 会直接返回 ai_disabled —— 这是当前实现的既有行为，README §4.3 已如实说明。
  assert.ok(health.ai.chain.includes('ollama') || health.ai.chain.length === 0, `chain 只应含免 Key 的 provider：${health.ai.chain}`);
  assert.ok(!health.ai.chain.includes('bailian'), '缺 Key 时 bailian 必须被剔除');

  // 4) /api 命中 L1
  const q = encodeURIComponent(DEMO_TITLE);
  const ty = encodeURIComponent('单选题');
  const op = encodeURIComponent(DEMO_OPTS);
  const hit = await getJson(port, `/api?q=${q}&type=${ty}&options=${op}`);
  assert.equal(hit.code, 1, `应命中：${JSON.stringify({ reason: hit.reason })}`);
  assert.equal(hit.answer, 'B');
  assert.equal(hit.source, 'local');
  assert.equal(typeof hit.elapsed, 'number', 'DECISIONS #8：响应带 elapsed');

  // 4b) 选项乱序 + 加空格，仍应命中 L1（归一化 + 选项排序）
  const shuffled = encodeURIComponent('  D.四#B.二 # A.一#C.三  ');  // 乱序 + 空白噪声，分隔符 # 必须保留
  const hit2 = await getJson(port, `/api?q=${encodeURIComponent('  ' + DEMO_TITLE + ' ')}&type=${ty}&options=${shuffled}`);
  assert.equal(hit2.code, 1, '归一化后应命中同一 key');
  assert.equal(hit2.source, 'local');

  // 5) /api 未命中 + AI 关闭
  const miss = await getJson(port, `/api?q=${encodeURIComponent('另一道占位题干乙')}&type=${ty}&options=${op}`);
  assert.equal(miss.code, 0);
  assert.equal(miss.answer, '');
  assert.equal(miss.reason, 'ai_disabled', 'QBANK_AI_ENABLED=false 时必须短路成 ai_disabled');

  // 6) bad_request：缺 q
  const bad = await getJson(port, '/api?type=单选题');
  assert.equal(bad.code, 0);
  assert.equal(bad.reason, 'bad_request');

  // 7) /stats
  const stats = await getJson(port, '/stats');
  assert.equal(stats.bank.total, 1);
  assert.equal(stats.match.l1, 2, '两次命中都记 L1');
  assert.equal(stats.match.noMatch >= 1, true);
  assert.equal(stats.ai.calls, 0, 'AI 关闭时不得有调用');
  assert.ok(stats.elapsed && typeof stats.elapsed.p95 === 'number', 'elapsed 分位数必须存在');

  // 8) 优雅退出：SIGINT 后进程必须自己结束（cache/bank 落盘不抛错）
  const exited = new Promise((resolve) => { child.once('exit', (code) => resolve(code)); });
  child.kill('SIGINT');
  const code = await Promise.race([
    exited,
    new Promise((resolve) => { setTimeout(() => resolve('TIMEOUT'), 8000).unref(); }),
  ]);
  assert.notEqual(code, 'TIMEOUT', 'SIGINT 后 8s 内必须退出');
  // 不依赖 'exit' 监听器的注册顺序：Node 在 emit 'exit' 之前就已写好 exitCode / signalCode
  assert.equal(child.exitCode !== null || child.signalCode !== null, true, '子进程必须已经退出');
  assert.ok(fs.existsSync(bankPath), '退出后 bank.json 仍在');
});