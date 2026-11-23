// test/stubs/t5-selfcheck.js — T5 交付物自检（tools/bench.js + tools/accuracy.js）
//
// 运行：node --test test/stubs/t5-selfcheck.js
//
// 这些测试验证「工具自身」的正确性（计时/分位数/达标判定/报表格式/隐私纪律/退出码），
// 不验证被评测系统的真实达标数字（那要等 T6 用 5 万条真数据跑）。
//
// 隔离纪律（CONTRACT §11）：
//   §11.1 不监听任何端口（两个工具都是纯 CLI，不起 server）；不留 setInterval。
//   §11.2 只写 os.tmpdir() 下的 qbank-t5-* 临时目录，after 里 rmSync；不碰仓库 data/ 与 logs/。
//   §11.5 断言里显式检查报表不泄露完整题干；测试内出现的 Key 一律是 sk-xxxxxxxx 占位。
//   §11.6 断言卡数值/结构；无真实 sleep > 200ms；超时/延迟全部注入。
//   §11.7 真实 AI 链路一律用注入的假 createAI / 假 fetch，绝不联网。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as bench from '../../tools/bench.js';
import * as acc from '../../tools/accuracy.js';
import { createGate } from '../../lib/queue.js';
import { makeSampleRecords, wrapBank } from './t5-sample-bank.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'accuracy_set.json');

let tmpRoot = '';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-t5-'));
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/* ---------------- 小工具 ---------------- */

function tmpPath(name) {
  return path.join(tmpRoot, name);
}

function writeJson(name, value) {
  const p = tmpPath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value), 'utf8');
  return p;
}

function writeText(name, text) {
  const p = tmpPath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

/** 收集工具输出的假 stdout/stderr。 */
function sink() {
  const chunks = [];
  return { chunks, write: (s) => chunks.push(String(s)), text: () => chunks.join('') };
}

/** 最小可用的 config 对象（避免测试触发 config.js 的 stderr 告警与真实 .env）。 */
function stubCfg(over = {}) {
  const base = {
    host: '127.0.0.1',
    port: 0,
    cors: '*',
    ai: { enabled: true, fallback: ['bailian', 'ollama'], concurrency: 3, queueLimit: 200, timeoutMs: 20000 },
    providers: {
      bailian: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-flash',
        apiKeyEnv: 'DASHSCOPE_API_KEY',
      },
      ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
    },
    match: { fuzzyThreshold: 0.9, suspiciousThreshold: 0.8, acceptSuspicious: false, candidateLimit: 200 },
    cache: { maxEntries: 10, flushIntervalMs: 30000 },
    writeback: { enabled: false, requireVerified: false },
  };
  return {
    ...base,
    ...over,
    ai: { ...base.ai, ...((over && over.ai) || {}) },
    providers: { ...base.providers, ...((over && over.providers) || {}) },
  };
}

const stubApiKeyFor = (pc, env) => (pc && pc.apiKeyEnv ? (env || {})[pc.apiKeyEnv] : undefined);

function readFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

/* ================================================================== *
 * tools/bench.js
 * ================================================================== */

test('bench: summarize/percentile 的数值与分位数算法（R type-7 线性插值）', () => {
  const ns = [];
  for (let i = 1; i <= 10; i += 1) ns.push(i * 1e6); // 1ms..10ms
  const s = bench.summarize(ns);
  assert.equal(s.samples, 10);
  assert.equal(s.avgMs, 5.5);
  assert.equal(s.minMs, 1);
  assert.equal(s.p50Ms, 5.5);
  assert.equal(s.p95Ms, 9.55);
  assert.equal(s.p99Ms, 9.91);
  assert.equal(s.maxMs, 10);
  assert.equal(s.totalMs, 55);

  const empty = bench.summarize([]);
  assert.deepEqual(empty, { samples: 0, avgMs: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, totalMs: 0 });

  // 非法样本被丢弃，不参与统计
  assert.equal(bench.summarize([1e6, -5, Number.NaN, 3e6]).samples, 2);

  assert.equal(bench.percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(bench.percentile([1, 2, 3, 4], 0), 1);
  assert.equal(bench.percentile([1, 2, 3, 4], 1), 4);
  assert.equal(bench.percentile([7], 0.9), 7);
  assert.equal(bench.percentile([], 0.9), 0);
});

test('bench: parseArgs 默认值 / = 形式 / 上下界收敛 / 非法参数', () => {
  const d = bench.parseArgs(['--file', 'data/bench.json']);
  assert.deepEqual(
    { l1: d.l1, l2: d.l2, warmup: d.warmup, json: d.json, verbose: d.verbose, help: d.help },
    { l1: 10000, l2: 2000, warmup: 200, json: false, verbose: false, help: false },
  );
  assert.equal(d.file, 'data/bench.json');

  const inline = bench.parseArgs(['--file=x.json', '--l1=5', '--l2=3', '--warmup=0', '--json']);
  assert.deepEqual(
    { file: inline.file, l1: inline.l1, l2: inline.l2, warmup: inline.warmup, json: inline.json },
    { file: 'x.json', l1: 5, l2: 3, warmup: 0, json: true },
  );

  assert.equal(bench.parseArgs(['-f', 'y.json']).file, 'y.json');
  assert.equal(bench.parseArgs(['--file', 'y.json', '--l1', 'abc']).l1, 10000);
  assert.equal(bench.parseArgs(['--file', 'y.json', '--warmup', '-3']).warmup, 0);
  assert.equal(bench.parseArgs(['--help']).help, true);

  assert.throws(() => bench.parseArgs(['--file', 'y.json', '--nope']), (e) => e.code === 'bad_request');
  assert.throws(() => bench.parseArgs([]), (e) => e.code === 'bad_request');
  assert.throws(() => bench.parseArgs(['--file']), (e) => e.code === 'bad_request');
});

test('bench: judge 的达标边界（严格小于；样本为 0 一律 FAIL）', () => {
  const ok = bench.judge({ l1: { samples: 10, avgMs: 0.9999 }, l2: { samples: 10, p95Ms: 49.999 } });
  assert.equal(ok.pass, true);
  assert.equal(ok.status, 'PASS');
  assert.equal(ok.l1.metric, 'avg');
  assert.equal(ok.l1.limitMs, 1);
  assert.equal(ok.l2.metric, 'p95');
  assert.equal(ok.l2.limitMs, 50);

  // HANDOFF §12.6 写的是「<」，等于阈值不算达标
  assert.equal(bench.judge({ l1: { samples: 10, avgMs: 1 }, l2: { samples: 10, p95Ms: 1 } }).status, 'FAIL');
  assert.equal(bench.judge({ l1: { samples: 10, avgMs: 0.1 }, l2: { samples: 10, p95Ms: 50 } }).status, 'FAIL');
  assert.equal(bench.judge({ l1: { samples: 0, avgMs: 0 }, l2: { samples: 5, p95Ms: 1 } }).note, 'no_samples');
  assert.equal(bench.judge({}).status, 'FAIL');
});
test('bench: loadBankFile 兼容两种结构并跳过非法记录', () => {
  const wrapped = writeJson('bank-wrapped.json', wrapBank([
    { key: 'k1', title: '第一个题干', options: ['A.甲', 'B.乙'], answer: 'A', type: '单选题' },
    null,
    { title: '   ' },
    42,
    { key: 'k2', title: '第二个题干', options: 'A.甲#B.乙', answer: 'B', type: '单选题' },
  ], 1763452800000));
  const r = bench.loadBankFile(wrapped);
  assert.equal(r.total, 5);
  assert.equal(r.records.length, 2);
  assert.equal(r.skipped, 3);

  const bare = writeJson('bank-array.json', [{ title: '裸数组题干', options: [], answer: 'A' }]);
  const r2 = bench.loadBankFile(bare);
  assert.equal(r2.total, 1);
  assert.equal(r2.records.length, 1);
  assert.equal(r2.skipped, 0);

  const badJson = writeText('bank-bad.json', '{oops not json');
  assert.throws(() => bench.loadBankFile(badJson), (e) => e.code === 'bad_request');
  const badShape = writeJson('bank-shape.json', { foo: 1 });
  assert.throws(() => bench.loadBankFile(badShape), (e) => e.code === 'bad_request');
  assert.throws(() => bench.loadBankFile(tmpPath('does-not-exist.json')), (e) => e.code === 'bad_request');
});

test('bench: pickSamples 等步长取样可复现', () => {
  const recs = Array.from({ length: 10 }, (_, i) => ({ title: 't' + i }));
  assert.deepEqual(bench.pickSamples(recs, 3).map((r) => r.title), ['t0', 't3', 't6']);
  assert.deepEqual(bench.pickSamples(recs, 10).map((r) => r.title), recs.map((r) => r.title));
  assert.deepEqual(bench.pickSamples(recs, 0).map((r) => r.title), ['t0']);
  assert.deepEqual(bench.pickSamples([], 5), []);
  // 同一输入两次调用结果一致
  assert.deepEqual(bench.pickSamples(recs, 4), bench.pickSamples(recs, 4));
});

test('bench: mutateTitle 确定性扰动且必不等于原文', () => {
  const src = '下列关于计算机网络协议的描述正确的是第1号案例';
  assert.equal(bench.mutateTitle(src, 1), bench.mutateTitle(src, 1));
  assert.notEqual(bench.mutateTitle(src, 1), src);
  assert.notEqual(bench.mutateTitle(src, 2), src);
  assert.notEqual(bench.mutateTitle(src, 1), bench.mutateTitle(src, 2));
  const len = [...bench.mutateTitle(src, 1)].length;
  assert.ok(Math.abs(len - [...src].length) <= 1, '扰动后长度变化过大');
  assert.equal(bench.mutateTitle('', 3), '');
});

test('bench: 合成题库的 key 与 makeKey 一致（否则 L1 永远命不中）', async () => {
  const { makeKey } = await import('../../lib/normalize.js');
  for (const r of makeSampleRecords({ count: 20, seed: 1 })) {
    assert.equal(r.key, makeKey(r.title, r.options));
  }
  const keys = new Set(makeSampleRecords({ count: 2000, seed: 42 }).map((r) => r.key));
  assert.equal(keys.size, 2000, '合成题库出现重复 key，索引条目会少于记录数');
});

test('bench: runBench 端到端（400 条合成库，--json）', async () => {
  const bank = writeJson('bench-400.json', wrapBank(makeSampleRecords({ count: 400, seed: 7 })));
  const out = sink();
  const err = sink();
  const { result, exitCode, text } = await bench.runBench({
    argv: ['--file', bank, '--l1', '200', '--l2', '100', '--warmup', '10', '--json'],
    out,
    err,
  });

  assert.equal(exitCode, 0, `期望达标退出码 0，stderr=${err.text()}`);
  assert.equal(out.text(), text);
  const parsed = JSON.parse(text);
  assert.equal(parsed.tool, 'bench');
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.bank.records, 400);
  assert.equal(parsed.bank.skipped, 0);
  assert.deepEqual(parsed.args, { l1: 200, l2: 100, warmup: 10, requestedL1: 200, requestedL2: 100 });

  // L1 必须真的走精确路径
  assert.equal(result.l1.samples, 200);
  assert.equal(result.l1.hitRate, 1);
  assert.equal(result.l1.exactHits, 200);
  assert.equal(result.l1.fuzzyFallback, 0);
  assert.equal(result.l1.misses, 0);
  assert.ok(result.l1.avgMs < bench.LIMITS.l1AvgMs, `L1 avg=${result.l1.avgMs}ms`);

  // L2 必须一个都不退回精确路径（否则测的不是模糊匹配）
  assert.equal(result.l2.samples, 100);
  assert.equal(result.l2.exactHits, 0);
  assert.equal(result.l2.fuzzyFallback, 100);
  assert.ok(result.l2.hitRate >= 0.9, `L2 命中率过低：${result.l2.hitRate}`);
  assert.ok(result.l2.avgCandidates > 0);
  assert.ok(result.l2.avgCandidates <= 200);

  // 额外报告：索引构建耗时 / trigram 条目数 / 内存
  assert.ok(result.index.buildMs >= 0);
  assert.equal(result.index.size, 400);
  assert.ok(result.index.trigramEntries > 0);
  assert.ok(result.index.trigramPostings >= result.index.trigramEntries);
  assert.deepEqual(result.index.matchConfig, {
    fuzzyThreshold: 0.9,
    suspiciousThreshold: 0.8,
    acceptSuspicious: false,
    candidateLimit: 200,
  });
  assert.ok(result.memory.rssBytes > 0);
  assert.ok(result.memory.heapUsedBytes > 0);
  assert.ok(result.memory.rssMb > 0);
  assert.equal(result.verdict.status, 'PASS');
  assert.equal(result.verdict.note, '');
  assert.equal(err.text(), '');
});

test('bench: 文本报表格式（表头/两阶段/内存/达标判定）', async () => {
  const bank = writeJson('bench-text.json', wrapBank(makeSampleRecords({ count: 200, seed: 11 })));
  const out = sink();
  const { exitCode, text } = await bench.runBench({
    argv: ['--file', bank, '--l1', '50', '--l2', '20', '--warmup', '5'],
    out,
    err: sink(),
  });
  assert.equal(exitCode, 0);
  assert.equal(text, out.text());
  assert.match(text, /阶段\s+样本数\s+avg\(ms\)\s+p50\(ms\)\s+p95\(ms\)\s+p99\(ms\)\s+max\(ms\)\s+命中率/);
  assert.match(text, /L1 精确命中/);
  assert.match(text, /L2 模糊匹配/);
  assert.match(text, /trigram 索引：条目=\d+ 倒排总数=\d+ L2 平均候选数=/);
  assert.match(text, /内存 rss=[\d.]+MB heapUsed=[\d.]+MB heapTotal=[\d.]+MB/);
  assert.match(text, /计时=process\.hrtime\.bigint\(\)/);
  assert.match(text, /命中层级 L1 阶段：精确=50 退回模糊=0 未命中=0/);
  assert.match(text, /\[达标判定 HANDOFF §12\.6\] L1 avg [\d.]+ms < 1ms \[OK\] \| L2 p95 [\d.]+ms < 50ms \[OK\] -> PASS/);
  assert.ok(!text.includes('data/bench.json'), '报表里不该出现别的题库路径');
});

test('bench: 计时被注入成 10ms/次时判定 FAIL 且退出码 1', async () => {
  const bank = writeJson('bench-slow.json', wrapBank(makeSampleRecords({ count: 60, seed: 3 })));
  let t = 0n;
  const hrtime = () => {
    const v = t;
    t += 10_000_000n; // 每次调用推进 10ms
    return v;
  };
  const out = sink();
  const { result, exitCode } = await bench.runBench({
    argv: ['--file', bank, '--l1', '20', '--l2', '10', '--warmup', '2', '--json'],
    deps: { hrtime },
    out,
    err: sink(),
  });
  assert.equal(exitCode, 1);
  assert.equal(result.verdict.status, 'FAIL');
  assert.equal(result.verdict.l1.pass, false);
  assert.equal(result.l1.avgMs, 10);
  assert.match(out.text(), /"status": "FAIL"/);
});

test('bench: L1 未走精确路径时给出告警（key 与 makeKey 不一致的诊断）', async () => {
  const recs = makeSampleRecords({ count: 80, seed: 5 }).map((r) => ({ ...r, key: 'stale-' + r.key.slice(0, 8) }));
  const bank = writeJson('bank-stalekey.json', wrapBank(recs));
  const out = sink();
  const { result, exitCode } = await bench.runBench({
    argv: ['--file', bank, '--l1', '40', '--l2', '10', '--warmup', '2'],
    out,
    err: sink(),
  });
  assert.equal(result.l1.exactHits, 0);
  assert.equal(result.l1.fuzzyFallback, 40);
  assert.match(out.text(), /警告：L1 阶段有 40 个样本没走精确路径/);
  assert.ok(exitCode === 0 || exitCode === 1);
});

test('bench: 无法执行的情况退出码 2（缺文件 / 未知参数 / --help）', async () => {
  const err = sink();
  const out = sink();
  const miss = await bench.runBench({ argv: ['--file', tmpPath('nope.json')], out, err });
  assert.equal(miss.exitCode, 2);
  assert.equal(miss.result, null);
  assert.match(err.text(), /\[qbank\]\[bench\]\[bad_request\]/);

  const err2 = sink();
  const out2 = sink();
  const badArg = await bench.runBench({ argv: ['--file', 'x.json', '--nope'], out: out2, err: err2 });
  assert.equal(badArg.exitCode, 2);
  assert.match(out2.text(), /用法：/);
  assert.match(err2.text(), /未知参数/);

  const out3 = sink();
  const help = await bench.runBench({ argv: ['--help'], out: out3, err: sink() });
  assert.equal(help.exitCode, 0);
  assert.match(out3.text(), /达标判定（HANDOFF §12\.6）/);

  const emptyBank = writeJson('bank-empty.json', wrapBank([]));
  const err4 = sink();
  const empty = await bench.runBench({ argv: ['--file', emptyBank], out: sink(), err: err4 });
  assert.equal(empty.exitCode, 2);
  assert.match(err4.text(), /题库为空/);
});
/* ================================================================== *
 * tools/accuracy.js
 * ================================================================== */

test('accuracy: parseArgs 默认值 / 覆盖 / --mock-accuracy 联动 / 非法参数', () => {
  const d = acc.parseArgs(['--file', 'a.json']);
  assert.deepEqual(
    {
      file: d.file, provider: d.provider, concurrency: d.concurrency, timeout: d.timeout,
      limit: d.limit, out: d.out, json: d.json, mock: d.mock, mockAccuracy: d.mockAccuracy,
    },
    { file: 'a.json', provider: '', concurrency: 3, timeout: 20000, limit: 0, out: '', json: false, mock: false, mockAccuracy: 1 },
  );

  const o = acc.parseArgs([
    '--file=a.json', '--provider', 'ollama', '--concurrency', '5', '--timeout', '3000',
    '--limit', '7', '--json', '--out', 'r.json',
  ]);
  assert.deepEqual(
    { file: o.file, provider: o.provider, concurrency: o.concurrency, timeout: o.timeout, limit: o.limit, json: o.json, out: o.out },
    { file: 'a.json', provider: 'ollama', concurrency: 5, timeout: 3000, limit: 7, json: true, out: 'r.json' },
  );

  const m = acc.parseArgs(['--file', 'a.json', '--mock-accuracy', '0.75']);
  assert.equal(m.mock, true, '--mock-accuracy 必须隐含 --mock');
  assert.equal(m.mockAccuracy, 0.75);

  assert.equal(acc.parseArgs(['--file', 'a.json', '--concurrency', '999']).concurrency, 64);
  assert.equal(acc.parseArgs(['--file', 'a.json', '--timeout', '1']).timeout, 100);
  assert.equal(acc.parseArgs(['--help']).help, true);
  assert.throws(() => acc.parseArgs(['--file', 'a.json', '--nope']), (e) => e.code === 'bad_request');
  assert.throws(() => acc.parseArgs([]), (e) => e.code === 'bad_request');
});

test('accuracy: titlePrefix / shortKey 的隐私截断', () => {
  assert.equal(acc.titlePrefix('一二三四五六七八九十'), '一二三四五六七八…');
  assert.equal(acc.titlePrefix('短题干'), '短题干');
  assert.equal(acc.titlePrefix(''), '');
  assert.equal(acc.titlePrefix(null), '');
  assert.equal(acc.shortKey('abcdef1234567890'), 'abcdef123456');
  assert.equal([...acc.titlePrefix('一二三四五六七八九十')].length, 9);
});

test('accuracy: gradeAnswer 覆盖五种题型的判分规则', () => {
  const g = acc.gradeAnswer;

  // 单选：字母比对，容忍小写与尾随标点
  assert.equal(g('B', 'b', '单选题').pass, true);
  assert.equal(g('B', 'B.', '单选题').pass, true);
  assert.equal(g('B', '答案是 B', '单选题').pass, true);
  assert.equal(g('B', 'C', '单选题').pass, false);
  assert.equal(g('B', '', '单选题').pass, false);
  assert.equal(g('B', '', '单选题').method, 'empty');

  // 多选：字母集合完全一致，顺序无关
  assert.equal(g('A#C', 'C#A', '多选题').pass, true);
  assert.equal(g('A#C', 'a#c', '多选题').pass, true);
  assert.equal(g('A#C', 'A', '多选题').pass, false);
  assert.equal(g('A#C', 'A#B#C', '多选题').pass, false);

  // 判断：同义词归一
  assert.equal(g('正确', '对', '判断题').pass, true);
  assert.equal(g('正确', '√', '判断题').pass, true);
  assert.equal(g('正确', 'T', '判断题').pass, true);
  assert.equal(g('错误', '×', '判断题').pass, true);
  assert.equal(g('错误', '错', '判断题').pass, true);
  assert.equal(g('正确', '错误', '判断题').pass, false);

  // 填空：按 # 逐空比对，允许「上海市」包含「上海」
  assert.equal(g('def', 'def', '填空题').pass, true);
  assert.equal(g('def', 'def', '填空题').method, 'blanks');
  assert.equal(g('11001', '11001', '填空题').pass, true);
  assert.equal(g('北京#上海', '北京#上海市', '填空题').pass, true);
  assert.equal(g('北京#上海', '上海#北京', '填空题').pass, false);
  assert.equal(g('北京#上海', '北京', '填空题').pass, false);

  // 问答：全等 / 包含 / bigram Dice >= 0.6
  const exact = g('物理层、数据链路层、网络层', '物理层、数据链路层、网络层', '问答题');
  assert.equal(exact.pass, true);
  assert.equal(exact.method, 'exact');
  assert.equal(g('OSI 模型有七层', 'OSI 模型有七层，自下而上依次是物理层等', '问答题').pass, true);
  const fuzzy = g('物理层数据链路层网络层', '物理层与数据链路层以及网络层', '问答题');
  assert.equal(fuzzy.pass, true);
  assert.equal(fuzzy.method, 'fuzzy');
  assert.equal(g('物理层、数据链路层、网络层', '完全不相干的另一段回答文本', '问答题').pass, false);

  // 未知题型：最保守，归一化后全等才算对
  assert.equal(g('x', 'X', '未知').pass, true);
  assert.equal(g('x', 'y', '未知').pass, false);
});

test('accuracy: normalizeJudgeText 同义词归一', () => {
  assert.equal(acc.normalizeJudgeText(' 对 '), '正确');
  assert.equal(acc.normalizeJudgeText('√'), '正确');
  assert.equal(acc.normalizeJudgeText('false'), '错误');
  assert.equal(acc.normalizeJudgeText('×'), '错误');
  assert.equal(acc.normalizeJudgeText(''), '');
  assert.equal(acc.normalizeJudgeText('不知道'), '不知道');
});

test('accuracy: buildMockPlan 确定性地挑出错题', () => {
  assert.equal(acc.buildMockPlan(20, 1).failIndexes.size, 0);
  assert.deepEqual([...acc.buildMockPlan(20, 0.9).failIndexes], [9, 19]);
  assert.deepEqual([...acc.buildMockPlan(20, 0.8).failIndexes], [4, 9, 14, 19]);
  assert.equal(acc.buildMockPlan(20, 0.5).failIndexes.size, 10);
  assert.equal(acc.buildMockPlan(0, 0.5).failIndexes.size, 0);
  assert.equal(acc.buildMockPlan(20, 0).failIndexes.size, 20);
});

test('accuracy: createMockAI 的结构与 CONTRACT §7 的 createAI 一致', async () => {
  const items = [
    { key: 'k1', valid: true, expected: 'A' },
    { key: 'k2', valid: true, expected: 'B' },
  ];
  const ai = acc.createMockAI({ items, plan: acc.buildMockPlan(2, 0.5), latencyMs: 0 });
  assert.deepEqual(ai.chain, ['mock']);
  assert.equal(typeof ai.stats, 'function');

  const r1 = await ai.answer({ key: 'k1', type: '单选题', title: 't1', options: 'A.a#B.b' });
  assert.equal(r1.ok, true);
  assert.equal(r1.answer, 'A');
  assert.equal(r1.provider, 'mock');
  assert.ok(r1.tokens.in > 0 && r1.tokens.out > 0);

  const r2 = await ai.answer({ key: 'k2', type: '单选题', title: 't2', options: '' });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'ai_error');

  const r3 = await ai.answer({ key: 'unknown' });
  assert.equal(r3.ok, false);

  const st = ai.stats();
  assert.equal(st.calls, 3);
  assert.equal(st.success, 1);
  assert.equal(st.failed, 2);
  assert.equal(st.chainExhausted, 1);
  assert.equal(st.byProvider.mock.calls, 3);
});

test('accuracy: summarizeResults 汇总口径 + judge 的 85% 边界', () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push({
      pass: i < 17,
      type: i % 2 ? '单选题' : '多选题',
      provider: 'bailian',
      ms: 10 + i,
      tokensIn: 5,
      tokensOut: 1,
      reason: i < 17 ? '' : 'ai_error',
    });
  }
  const s = acc.summarizeResults(rows);
  assert.equal(s.total, 20);
  assert.equal(s.passed, 17);
  assert.equal(s.failed, 3);
  assert.equal(s.accuracy, 0.85);
  assert.equal(s.accuracyPct, 85);
  assert.deepEqual(s.reasons, { ai_error: 3 });
  assert.equal(s.tokensIn, 100);
  assert.equal(s.tokensOut, 20);
  assert.equal(s.tokensTotal, 120);
  assert.equal(s.ms.samples, 20);
  assert.equal(s.ms.avg, 19.5);
  assert.equal(s.ms.max, 29);
  assert.equal(s.byType['单选题'].total, 10);
  assert.equal(s.byType['多选题'].total, 10);
  assert.equal(s.byProvider.bailian.calls, 20);
  assert.equal(acc.judge(s).status, 'PASS');
  assert.equal(acc.judge(s).thresholdPct, 85);

  rows[16].pass = false;
  rows[16].reason = 'ai_timeout';
  const s2 = acc.summarizeResults(rows);
  assert.equal(s2.accuracyPct, 80);
  assert.deepEqual(s2.reasons, { ai_error: 3, ai_timeout: 1 });
  assert.equal(acc.judge(s2).status, 'FAIL');

  const none = acc.summarizeResults([]);
  assert.equal(none.total, 0);
  assert.equal(acc.judge(none).status, 'FAIL');
  assert.equal(acc.judge(none).note, 'no_samples');
});
test('accuracy: schedule 保持输入顺序并遵守并发上限', async () => {
  const items = Array.from({ length: 9 }, (_, i) => i);
  let inflight = 0;
  let peak = 0;
  const res = await acc.schedule(
    items,
    async (it, i) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      assert.equal(it, i);
      return it * 2;
    },
    { concurrency: 2 },
  );
  assert.equal(res.length, 9);
  assert.ok(res.every((r) => r.ok));
  assert.deepEqual(res.map((r) => r.value), items.map((i) => i * 2));
  assert.ok(peak <= 2, `并发超限 peak=${peak}`);
  assert.deepEqual(await acc.schedule([], async () => 1, {}), []);
});

test('accuracy: schedule 用注入的 gate，单个任务抛错不影响其它任务', async () => {
  const gate = createGate({ concurrency: 2, queueLimit: 10, timeoutMs: 1000 });
  const res = await acc.schedule(
    [1, 2, 3],
    async (i) => {
      if (i === 2) {
        const e = new Error('boom');
        e.code = 'ai_error';
        throw e;
      }
      return i;
    },
    { gate },
  );
  assert.deepEqual(res.map((r) => r.ok), [true, false, true]);
  assert.deepEqual(res.map((r) => r.value), [1, undefined, 3]);
  assert.equal(res[1].error.code, 'ai_error');
  await gate.drain();
  gate.close();
});

test('accuracy: schedule 超时 -> ai_timeout，且不真的等完', async () => {
  const t0 = Date.now();
  const res = await acc.schedule(
    [1],
    async () => {
      await new Promise((r) => setTimeout(r, 80));
      return 'late';
    },
    { concurrency: 1, timeoutMs: 20 },
  );
  assert.equal(res[0].ok, false);
  assert.equal(res[0].error.code, 'ai_timeout');
  assert.ok(Date.now() - t0 < 200, '超时没有被及时触发');
});

test('accuracy: gate 队列满 -> queue_full 被如实记录', async () => {
  const gate = createGate({ concurrency: 1, queueLimit: 1, timeoutMs: 2000 });
  const slow = () => new Promise((r) => setTimeout(r, 30));
  const p1 = gate.run(slow);
  const p2 = gate.run(slow);
  const res = await acc.schedule([3], async () => 'x', { gate });
  assert.equal(res[0].ok, false);
  assert.equal(res[0].error.code, 'queue_full');
  await Promise.all([p1, p2]);
  await gate.drain();
  gate.close();
});

test('accuracy: loadFixture 兼容三种容器、标记非法条目、支持依赖注入', () => {
  const one = [{ type: '单选题', title: 't1', options: 'A.a#B.b', answer: 'A' }];
  const arr = writeJson('fx-array.json', one);
  const r = acc.loadFixture(arr);
  assert.equal(r.total, 1);
  assert.equal(r.invalid, 0);
  assert.equal(r.items[0].valid, true);
  assert.equal(r.items[0].type, '单选题');
  assert.equal(r.items[0].expected, 'A');
  assert.match(r.items[0].key, /^[0-9a-f]{64}$/);
  assert.equal(r.items[0].index, 1);

  assert.equal(acc.loadFixture(writeJson('fx-items.json', { items: one })).total, 1);
  assert.equal(acc.loadFixture(writeJson('fx-questions.json', { questions: one })).total, 1);
  assert.equal(acc.loadFixture(writeJson('fx-keyed.json', [{ ...one[0], key: 'fixed-key' }])).items[0].key, 'fixed-key');

  assert.throws(() => acc.loadFixture(writeJson('fx-bad.json', { nope: 1 })), (e) => e.code === 'bad_request');
  assert.throws(() => acc.loadFixture(writeText('fx-notjson.json', 'oops')), (e) => e.code === 'bad_request');
  assert.throws(() => acc.loadFixture(tmpPath('fx-missing.json')), (e) => e.code === 'bad_request');

  const injected = acc.loadFixture(arr, {
    normalizeType: () => '多选',
    toLabel: (t) => t + '题',
    splitOptions: (s) => String(s || '').split('#'),
    makeKey: () => 'injected-key',
  });
  assert.equal(injected.items[0].type, '多选题');

  const mixed = acc.loadFixture(writeJson('fx-mixed.json', [
    { type: '单选题', title: '有答案', options: 'A.a#B.b', answer: 'A' },
    { type: '单选题', title: '缺答案', options: 'A.a#B.b' },
    { type: '单选题', answer: 'A' },
    null,
  ]));
  assert.equal(mixed.total, 4);
  assert.equal(mixed.invalid, 3);
  assert.deepEqual(mixed.items.map((i) => i.valid), [true, false, false, false]);
});

test('accuracy: resolveChain 剔除缺 Key / 缺 baseUrl 的 provider', () => {
  const cfg = stubCfg();
  assert.deepEqual(acc.resolveChain(cfg, {}, '', stubApiKeyFor).chain, ['ollama']);
  assert.deepEqual(acc.resolveChain(cfg, { DASHSCOPE_API_KEY: 'sk-xxxxxxxx' }, '', stubApiKeyFor).chain, ['bailian', 'ollama']);
  assert.deepEqual(acc.resolveChain(cfg, {}, 'bailian', stubApiKeyFor).chain, []);
  assert.deepEqual(acc.resolveChain(cfg, { DASHSCOPE_API_KEY: 'sk-xxxxxxxx' }, 'bailian', stubApiKeyFor).chain, ['bailian']);
  const unknown = acc.resolveChain(cfg, {}, 'nope', stubApiKeyFor);
  assert.deepEqual(unknown.unknown, ['nope']);
  assert.deepEqual(unknown.chain, []);
  const noBase = acc.resolveChain({ providers: { x: { model: 'm' } }, ai: { fallback: ['x'] } }, {}, '', stubApiKeyFor);
  assert.deepEqual(noBase.chain, []);
});

test('accuracy: probeChain 有 Key 不联网；无 Key 时按探活结果过滤', async () => {
  const cfg = stubCfg();
  const keyed = await acc.probeChain(['bailian', 'ollama'], cfg.providers, {
    env: { DASHSCOPE_API_KEY: 'sk-xxxxxxxx' },
    apiKeyFor: stubApiKeyFor,
    fetchImpl: () => {
      throw new Error('有 Key 时不该联网');
    },
  });
  assert.deepEqual(keyed.ready, ['bailian', 'ollama']);
  assert.equal(keyed.probed, false);

  const urls = [];
  const up = await acc.probeChain(['ollama'], cfg.providers, {
    env: {},
    apiKeyFor: stubApiKeyFor,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return { status: 200 };
    },
  });
  assert.deepEqual(up.ready, ['ollama']);
  assert.deepEqual(up.unreachable, []);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/api\/tags$/);

  const down = await acc.probeChain(['ollama', 'openai'], cfg.providers, {
    env: {},
    apiKeyFor: stubApiKeyFor,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.deepEqual(down.ready, []);
  assert.deepEqual(down.unreachable, ['ollama', 'openai']);
  assert.equal(down.probed, true);

  const badBase = await acc.probeChain(['x'], { x: { baseUrl: 'not-a-url' } }, {
    env: {},
    apiKeyFor: stubApiKeyFor,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.deepEqual(badBase.ready, []);
  assert.deepEqual(badBase.unreachable, ['x']);
});

/* ================================================================== *
 * tools/accuracy.js — runAccuracy 端到端
 *   全部依赖注入：零联网、零真实 sleep、零真实 Key（一律 sk-xxxxxxxx）
 * ================================================================== */

const normMod = await import('../../lib/normalize.js');

const NORM_DEPS = {
  normalizeType: normMod.normalizeType,
  toLabel: normMod.toLabel,
  makeKey: normMod.makeKey,
  splitOptions: normMod.splitOptions,
};

function fixtureItems(file = FIXTURE) {
  return acc.loadFixture(file, NORM_DEPS);
}

/** 假 createAI：按 title 查表返回正确答案（结构对齐 CONTRACT §7）。 */
function makeFakeAI(opts = {}) {
  const o = opts || {};
  const byTitle = new Map((o.items || []).map((i) => [i.title, i.expected]));
  const blocked = o.blocked instanceof Set ? o.blocked : new Set();
  const seen = [];
  return {
    seen,
    chain: o.chain || ['bailian'],
    stats: () => ({
      calls: seen.length,
      success: seen.filter((r) => !blocked.has(r.key)).length,
      failed: seen.filter((r) => blocked.has(r.key)).length,
      tokensIn: seen.length * 11,
      tokensOut: seen.length * 2,
      byProvider: { bailian: { calls: seen.length, success: 0, failed: 0, moderation: blocked.size, timeout: 0, ms: 0 } },
    }),
    async answer(req) {
      seen.push(req);
      if (blocked.has(req.key)) return { ok: false, reason: o.blockedReason || 'ai_moderation', provider: 'bailian' };
      return {
        ok: true,
        answer: byTitle.has(req.title) ? byTitle.get(req.title) : '',
        provider: 'bailian',
        model: 'qwen-flash',
        tokens: { in: 11, out: 2 },
      };
    },
  };
}

/** live 模式的公共注入：真 config.js/queue.js/normalize.js + 假 createAI + 假探活。 */
function liveDeps(fakeAI, over = {}) {
  return {
    loadConfig: () => stubCfg({ ai: { fallback: ['bailian'] } }),
    loadAIModule: async () => ({ createAI: (o) => { liveDeps.captured = o; return fakeAI; } }),
    probeChain: async () => ({ ready: ['bailian'], unreachable: [], probed: false }),
    ...over,
  };
}

test('accuracy_set.json: 20 题分布 / key 唯一 / 答案客观可判（评测基准）', () => {
  const fx = fixtureItems();
  assert.equal(fx.total, 20);
  assert.equal(fx.invalid, 0);
  assert.equal(fx.items.length, 20);

  const dist = {};
  for (const it of fx.items) dist[it.type] = (dist[it.type] || 0) + 1;
  assert.deepEqual(dist, { 单选题: 8, 多选题: 5, 判断题: 4, 填空题: 2, 问答题: 1 });

  assert.equal(new Set(fx.items.map((i) => i.key)).size, 20, 'key 必须唯一，否则 mock 桩会串题');
  for (const it of fx.items) {
    assert.equal(it.valid, true);
    assert.match(it.key, /^[0-9a-f]{64}$/, `第 ${it.index} 题 key 必须是 sha256 hex`);
    assert.equal(normMod.isUnanswerable(it.title, it.options), false, `第 ${it.index} 题被 isUnanswerable 判为不可答`);
    assert.ok([...it.title].length > 8, `第 ${it.index} 题题干过短，无法验证截断纪律`);
    if (it.type === '判断题') assert.ok(['正确', '错误'].includes(it.expected), `第 ${it.index} 题判断题答案必须是 正确/错误`);
    if (it.type === '单选题') assert.match(it.expected, /^[A-Z]$/, `第 ${it.index} 题单选答案格式`);
    if (it.type === '多选题') assert.match(it.expected, /^[A-Z](#[A-Z])+$/, `第 ${it.index} 题多选答案格式`);
    if (it.type === '填空题' || it.type === '问答题') assert.equal(it.options, '');
    else assert.ok(it.options.split('#').filter(Boolean).length >= 2, `第 ${it.index} 题选项不足`);
  }

  // 反偏置：正确答案的字母分布必须打散，否则模型「每题都猜同一个选项」也能刷高分，
  // 评测数据就失去了意义（这是评测基准自身的质量要求，不是 CONTRACT 的硬约束）。
  const single = fx.items.filter((i) => i.type === '单选题').map((i) => i.expected);
  assert.ok(new Set(single).size >= 4, `单选答案过于集中：${single.join(',')}`);
  assert.deepEqual(
    ['A', 'B', 'C', 'D'].map((L) => single.filter((a) => a === L).length),
    [2, 2, 2, 2],
    '单选答案 A/B/C/D 必须各 2 题',
  );
  const multi = fx.items.filter((i) => i.type === '多选题').map((i) => i.expected);
  assert.equal(new Set(multi).size, multi.length, `多选答案模式必须互不相同：${multi.join(' | ')}`);
  const judge = fx.items.filter((i) => i.type === '判断题').map((i) => i.expected);
  assert.equal(judge.filter((a) => a === '正确').length, 2, '判断题正误必须各半');
  assert.equal(judge.filter((a) => a === '错误').length, 2, '判断题正误必须各半');
});

test('runAccuracy --mock --json：全对 -> 退出码 0，报表不泄露完整题干', async () => {
  const out = sink();
  const err = sink();
  const res = await acc.runAccuracy({
    argv: ['--file', FIXTURE, '--mock', '--json'],
    cwd: tmpRoot,
    env: {},
    out,
    err,
    deps: { loadConfig: () => stubCfg(), mockLatencyMs: 0 },
  });

  assert.equal(err.text(), '', `mock 模式不该有 stderr：${err.text()}`);
  assert.equal(res.exitCode, 0);
  assert.equal(res.text, out.text());
  const report = JSON.parse(res.text);
  assert.deepEqual(report, res.report);

  assert.equal(report.tool, 'accuracy');
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.node, process.version);
  assert.equal(report.outFile, '', '没传 --out 就不该声称写了文件');

  assert.equal(report.header.file, FIXTURE);
  assert.equal(report.header.mode, 'mock');
  assert.deepEqual(report.header.chain, ['mock']);
  assert.equal(report.header.total, 20);
  assert.equal(report.header.executed, 20);
  assert.equal(report.header.invalid, 0);
  assert.equal(report.header.limited, false);
  assert.equal(report.header.concurrency, 3);
  assert.equal(report.header.timeoutMs, 20000);
  assert.equal(report.header.threshold, 0.85);

  assert.equal(report.rows.length, 20);
  assert.deepEqual(report.rows.map((r) => r.index), Array.from({ length: 20 }, (_, i) => i + 1), '行序必须与测试集一致');
  assert.equal(report.summary.total, 20);
  assert.equal(report.summary.passed, 20);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.accuracy, 1);
  assert.equal(report.summary.accuracyPct, 100);
  assert.deepEqual(report.summary.reasons, {});
  assert.ok(report.summary.tokensTotal > 0, 'tokens 必须被统计');
  assert.equal(report.summary.tokensTotal, report.summary.tokensIn + report.summary.tokensOut);
  assert.equal(report.summary.ms.samples, 20);
  assert.deepEqual(report.summary.byType, {
    单选题: { total: 8, passed: 8, failed: 0, accuracyPct: 100 },
    多选题: { total: 5, passed: 5, failed: 0, accuracyPct: 100 },
    判断题: { total: 4, passed: 4, failed: 0, accuracyPct: 100 },
    填空题: { total: 2, passed: 2, failed: 0, accuracyPct: 100 },
    问答题: { total: 1, passed: 1, failed: 0, accuracyPct: 100 },
  });
  assert.equal(report.verdict.pass, true);
  assert.equal(report.verdict.status, 'PASS');
  assert.equal(report.verdict.metric, 'accuracy');
  assert.equal(report.verdict.valuePct, 100);
  assert.equal(report.aiStats.calls, 20, 'aiStats 必须来自 ai.stats()');

  const fx = fixtureItems();
  for (const r of report.rows) {
    const it = fx.items[r.index - 1];
    assert.equal(r.pass, true);
    assert.equal(r.reason, '', 'pass 行 reason 必须为空（T6 修复：不得残留 emptyRow 默认 ai_error）');
    assert.equal(r.provider, 'mock');
    assert.equal(r.expected, it.expected);
    assert.equal(r.actual, it.expected);
    assert.equal(r.type, it.type);
    assert.equal(r.key12, it.key.slice(0, 12));
    assert.equal(r.key12.length, 12);
    assert.ok([...r.titlePrefix].length <= 9, '题干列最多 8 字 + 省略号');
    assert.equal(r.titlePrefix, it.title.slice(0, 8) + '…');
    assert.equal(typeof r.ms, 'number');
    assert.ok(r.ms >= 0 && r.ms < 200, `单题耗时异常：${r.ms}`);
    assert.ok(!res.text.includes(it.title), `报表泄露完整题干：第 ${r.index} 题`);
  }
});
test('runAccuracy --mock-accuracy 0.8：确定性错 4 题 -> 退出码 1', async () => {
  const res = await acc.runAccuracy({
    argv: ['--file', FIXTURE, '--mock', '--mock-accuracy', '0.8', '--json'],
    cwd: tmpRoot,
    env: {},
    out: sink(),
    err: sink(),
    deps: { loadConfig: () => stubCfg(), mockLatencyMs: 0 },
  });
  assert.equal(res.exitCode, 1);
  const s = res.report.summary;
  assert.equal(s.total, 20);
  assert.equal(s.passed, 16);
  assert.equal(s.failed, 4);
  assert.equal(s.accuracy, 0.8);
  assert.equal(s.accuracyPct, 80);
  assert.deepEqual(s.reasons, { ai_error: 4 });
  assert.equal(res.report.verdict.status, 'FAIL');
  assert.equal(res.report.verdict.valuePct, 80);
  assert.equal(res.report.verdict.thresholdPct, 85);
  // buildMockPlan(20, 0.8) -> step 5 -> 下标 4,9,14,19 答错
  assert.deepEqual(res.report.rows.filter((r) => !r.pass).map((r) => r.index), [5, 10, 15, 20]);
  assert.deepEqual(res.report.rows.filter((r) => !r.pass).map((r) => r.actual), ['', '', '', '']);
  // 失败行 provider 为空，summarizeResults 归入 none（如实反映「没有 provider 给出答案」）
  assert.equal(res.report.summary.byProvider.mock.calls, 16);
  assert.equal(res.report.summary.byProvider.mock.passed, 16);
  assert.equal(res.report.summary.byProvider.mock.accuracyPct, 100);
  assert.equal(res.report.summary.byProvider.none.calls, 4);
  assert.equal(res.report.summary.byProvider.none.passed, 0);
  assert.equal(res.report.summary.byProvider.none.failed, 4);
});

test('runAccuracy --out + --limit：报表落盘到指定路径（临时目录）', async () => {
  const target = path.join(tmpRoot, 'reports', 'acc.json');
  const res = await acc.runAccuracy({
    argv: ['--file', FIXTURE, '--mock', '--limit', '4', '--out', target, '--json'],
    cwd: tmpRoot,
    env: {},
    out: sink(),
    err: sink(),
    deps: { loadConfig: () => stubCfg(), mockLatencyMs: 0 },
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.report.outFile, target);
  assert.equal(res.report.header.limited, true);
  assert.equal(res.report.header.total, 4);
  assert.equal(res.report.header.executed, 4);
  assert.equal(res.report.rows.length, 4);
  assert.deepEqual(res.report.rows.map((r) => r.index), [1, 2, 3, 4]);
  assert.equal(res.report.summary.total, 4);

  const disk = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepEqual(disk, res.report, '落盘内容必须与 stdout 报表一致');
  assert.equal(disk.rows.length, 4);
  assert.equal(disk.outFile, target);
  assert.equal(disk.verdict.status, 'PASS');
});

test('runAccuracy：相对 --out 按 cwd 解析，非法条目计入失败而不是被丢弃', async () => {
  const bad = writeJson('acc-invalid.json', [
    { type: '单选题', title: '示例题干：甲属于下列哪一类设备', options: 'A.甲类#B.乙类', answer: 'A' },
    { type: '单选题', title: '这一条缺少 answer 字段，必须被标记为非法' },
    { type: '单选题', options: 'A.甲#B.乙', answer: 'B' },
    null,
  ]);
  const out = sink();
  const res = await acc.runAccuracy({
    argv: ['--file', bad, '--mock', '--json', '--out', 'nested/rel.json'],
    cwd: tmpRoot,
    env: {},
    out,
    err: sink(),
    deps: { loadConfig: () => stubCfg(), mockLatencyMs: 0 },
  });
  assert.equal(res.exitCode, 1);
  assert.equal(res.report.outFile, path.join(tmpRoot, 'nested', 'rel.json'));
  assert.ok(fs.existsSync(res.report.outFile));
  assert.equal(res.report.header.invalid, 3);
  assert.equal(res.report.header.total, 4);
  assert.equal(res.report.rows.length, 4, '非法条目也要出现在报表里');
  assert.equal(res.report.summary.total, 4);
  assert.equal(res.report.summary.passed, 1);
  assert.equal(res.report.summary.accuracyPct, 25);
  assert.deepEqual(res.report.summary.reasons, { invalid_item: 3 });
  const invalidRows = res.report.rows.filter((r) => r.reason === 'invalid_item');
  assert.equal(invalidRows.length, 3);
  assert.ok(invalidRows.every((r) => r.type === '非法条目' && r.pass === false && r.actual === ''));
  assert.equal(res.report.summary.byType['非法条目'].total, 3);
  assert.equal(res.report.verdict.status, 'FAIL');
});

test('runAccuracy：isUnanswerable 命中 -> image_or_formula，不浪费 AI 调用', async () => {
  const fake = makeFakeAI({ items: fixtureItems().items });
  const res = await acc.runAccuracy({
    argv: ['--file', FIXTURE, '--json'],
    cwd: tmpRoot,
    env: { DASHSCOPE_API_KEY: 'sk-xxxxxxxx' },
    out: sink(),
    err: sink(),
    deps: { ...liveDeps(fake), isUnanswerable: () => true },
  });
  assert.equal(res.exitCode, 1);
  assert.equal(fake.seen.length, 0, '不可答题目根本不该调用 AI');
  assert.deepEqual(res.report.summary.reasons, { image_or_formula: 20 });
  assert.equal(res.report.summary.passed, 0);
  assert.ok(res.report.rows.every((r) => r.reason === 'image_or_formula' && r.actual === '' && r.provider === ''));
});

test('runAccuracy live：缺 Key / 探活失败 / ai.enabled=false / 未知 provider -> 退出码 2 且不联网', async () => {
  // a) 链上只有需要 Key 的 bailian，env 里没 Key -> resolveChain 直接清空，不该刷 20 个 FAIL
  const outA = sink();
  const errA = sink();
  let netCalls = 0;
  const resA = await acc.runAccuracy({
    argv: ['--file', FIXTURE],
    cwd: tmpRoot,
    env: {},
    out: outA,
    err: errA,
    deps: {
      loadConfig: () => stubCfg({ ai: { fallback: ['bailian'] } }),
      fetchImpl: () => {
        netCalls += 1;
        throw new Error('有 Key 缺失时也不该联网');
      },
    },
  });
  assert.equal(resA.exitCode, 2);
  assert.equal(resA.report, null);
  assert.equal(outA.text(), '', '退出码 2 时不该输出半成品报表');
  assert.equal(netCalls, 0);
  assert.match(errA.text(), /ai_disabled/);
  assert.match(errA.text(), /sk-xxxxxxxx/);
  assert.match(errA.text(), /bailian\.console\.aliyun\.com/);
  assert.match(errA.text(), /退出码 2（不计为 FAIL）/);
  assert.doesNotMatch(errA.text(), /sk-(?!xxxxxxxx)[A-Za-z0-9_-]{8,}/, '提示里出现了疑似真实 Key');

  // b) 链上是免 Key 的本地 provider，但探活连不上 -> 退出码 2
  const errB = sink();
  const resB = await acc.runAccuracy({
    argv: ['--file', FIXTURE],
    cwd: tmpRoot,
    env: {},
    out: sink(),
    err: errB,
    deps: {
      loadConfig: () => stubCfg({ ai: { fallback: ['ollama'] } }),
      probeChain: async (chain) => ({ ready: [], unreachable: chain, probed: true }),
      loadAIModule: async () => {
        throw new Error('探活失败后不该再去装配 AI');
      },
    },
  });
  assert.equal(resB.exitCode, 2);
  assert.equal(resB.report, null);
  assert.match(errB.text(), /探活但连不上：ollama/);
  assert.match(errB.text(), /ollama pull qwen2\.5:7b/);

  // c) ai.enabled=false
  const errC = sink();
  const resC = await acc.runAccuracy({
    argv: ['--file', FIXTURE],
    cwd: tmpRoot,
    env: {},
    out: sink(),
    err: errC,
    deps: { loadConfig: () => stubCfg({ ai: { enabled: false } }) },
  });
  assert.equal(resC.exitCode, 2);
  assert.match(errC.text(), /ai_disabled/);
  assert.match(errC.text(), /QBANK_AI_ENABLED/);
  assert.match(errC.text(), /--mock/);

  // d) 未知 provider
  const errD = sink();
  const resD = await acc.runAccuracy({
    argv: ['--file', FIXTURE, '--provider', 'nope'],
    cwd: tmpRoot,
    env: {},
    out: sink(),
    err: errD,
    deps: { loadConfig: () => stubCfg() },
  });
  assert.equal(resD.exitCode, 2);
  assert.match(errD.text(), /bad_request/);
  assert.match(errD.text(), /nope/);
  assert.match(errD.text(), /bailian, ollama, openai/);

  // e) 测试集文件不存在
  const errE = sink();
  const resE = await acc.runAccuracy({
    argv: ['--file', path.join(tmpRoot, 'nope.json'), '--mock'],
    cwd: tmpRoot,
    env: {},
    out: sink(),
    err: errE,
    deps: { loadConfig: () => stubCfg() },
  });
  assert.equal(resE.exitCode, 2);
  assert.match(errE.text(), /bad_request/);
  assert.match(errE.text(), /测试集读取失败/);
});
test('runAccuracy live：真 config/queue + 注入 createAI 的装配（零联网）', async () => {
  const fx = fixtureItems();
  const fake = makeFakeAI({ items: fx.items });
  const gates = [];
  const out = sink();
  const err = sink();
  let res;
  try {
    res = await acc.runAccuracy({
      argv: ['--file', FIXTURE, '--json', '--concurrency', '2', '--timeout', '5000'],
      cwd: tmpRoot,
      env: { DASHSCOPE_API_KEY: 'sk-xxxxxxxx' },
      out,
      err,
      deps: liveDeps(fake, {
        queueMod: {
          createGate: (o) => {
            const g = createGate(o);
            gates.push({ gate: g, opts: o });
            return g;
          },
        },
      }),
    });
  } finally {
    gates.forEach(({ gate }) => {
      try {
        gate.close();
      } catch {
        /* 忽略 */
      }
    });
  }

  assert.equal(err.text(), '', `live 装配不该有告警：${err.text()}`);
  assert.equal(res.exitCode, 0);
  assert.equal(res.report.header.mode, 'live');
  assert.deepEqual(res.report.header.chain, ['bailian']);
  assert.equal(res.report.header.concurrency, 2);
  assert.equal(res.report.header.timeoutMs, 5000);

  // createAI 的入参必须符合 CONTRACT §7：{ config, env, log, gate }
  const captured = liveDeps.captured;
  assert.ok(captured, 'createAI 未被调用');
  assert.deepEqual(Object.keys(captured).sort(), ['config', 'env', 'gate', 'log']);
  assert.deepEqual(captured.config.ai.fallback, ['bailian'], 'AI 链必须是过滤后的结果');
  assert.equal(captured.config.ai.concurrency, 2, '--concurrency 必须覆盖配置');
  assert.equal(captured.config.ai.timeoutMs, 5000, '--timeout 必须覆盖配置');
  assert.equal(captured.config.ai.enabled, true);
  // queueLimit = max(config.ai.queueLimit, 题数 + 8)，否则一次性投递会 queue_full
  assert.equal(captured.config.ai.queueLimit, Math.max(200, fx.items.length + 8));
  assert.ok(captured.config.ai.queueLimit >= fx.items.length, 'queueLimit 至少要能装下全部题目');
  assert.deepEqual(captured.env, { DASHSCOPE_API_KEY: 'sk-xxxxxxxx' });
  assert.equal(typeof captured.log.moderation, 'function');
  assert.equal(typeof captured.log.error, 'function');
  assert.equal(typeof captured.log.info, 'function');

  // 双闸：外层给 schedule，内层给 createAI，绝不能是同一个实例（嵌套自锁）
  assert.equal(gates.length, 2, '必须创建两个独立 gate');
  assert.notEqual(gates[0].gate, gates[1].gate);
  assert.equal(captured.gate, gates[1].gate);
  assert.equal(gates[0].opts.concurrency, 2);
  assert.equal(gates[0].opts.timeoutMs, 5000);
  assert.equal(gates[0].opts.queueLimit, gates[1].opts.queueLimit);
  assert.ok(gates[0].opts.queueLimit >= fx.items.length);

  // 完整题干只交给 AI，报表里只有前 8 字 + key12
  assert.equal(fake.seen.length, 20);
  assert.ok(fake.seen.every((r) => typeof r.title === 'string' && r.title.length > 0));
  assert.ok(fake.seen.every((r) => /^[0-9a-f]{64}$/.test(r.key)));
  assert.ok(fake.seen.some((r) => [...r.title].length > 8), 'AI 必须拿到完整题干');
  assert.deepEqual(
    fake.seen.map((r) => r.type).sort(),
    fx.items.map((i) => i.type).sort(),
  );

  assert.equal(res.report.rows.length, 20);
  assert.equal(res.report.summary.passed, 20);
  assert.equal(res.report.summary.accuracyPct, 100);
  assert.equal(res.report.summary.tokensIn, 220);
  assert.equal(res.report.summary.tokensOut, 40);
  assert.equal(res.report.summary.tokensTotal, 260);
  assert.ok(res.report.rows.every((r) => r.provider === 'bailian' && r.model === 'qwen-flash'));
  assert.equal(res.report.summary.byProvider.bailian.calls, 20);
  assert.equal(res.report.aiStats.byProvider.bailian.calls, 20);
  for (const it of fx.items) assert.ok(!res.text.includes(it.title), '报表泄露完整题干');
  assert.doesNotMatch(res.text, /sk-(?!xxxxxxxx)[A-Za-z0-9_-]{8,}/);
});

test('runAccuracy live：ai_moderation 计为失败，17/20 = 85% 恰好压线 PASS', async () => {
  const fx = fixtureItems();
  const run = (blockedCount, reason) => {
    const blocked = new Set(fx.items.slice(0, blockedCount).map((i) => i.key));
    const fake = makeFakeAI({ items: fx.items, blocked, blockedReason: reason });
    const err = sink();
    return acc
      .runAccuracy({
        argv: ['--file', FIXTURE, '--json'],
        cwd: tmpRoot,
        env: { DASHSCOPE_API_KEY: 'sk-xxxxxxxx' },
        out: sink(),
        err,
        deps: liveDeps(fake),
      })
      .then((r) => ({ ...r, fake, err }));
  };

  const ok = await run(3, 'ai_moderation');
  assert.equal(ok.err.text(), '');
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.report.summary.passed, 17);
  assert.equal(ok.report.summary.failed, 3);
  assert.equal(ok.report.summary.accuracy, 0.85);
  assert.equal(ok.report.summary.accuracyPct, 85);
  assert.deepEqual(ok.report.summary.reasons, { ai_moderation: 3 });
  assert.equal(ok.report.verdict.status, 'PASS');
  assert.equal(ok.report.verdict.value, 0.85);
  assert.equal(ok.fake.seen.length, 20);

  const bad = await run(4, 'ai_moderation');
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.report.summary.passed, 16);
  assert.equal(bad.report.summary.accuracyPct, 80);
  assert.deepEqual(bad.report.summary.reasons, { ai_moderation: 4 });
  assert.equal(bad.report.verdict.status, 'FAIL');

  const timeouts = await run(2, 'ai_timeout');
  assert.equal(timeouts.exitCode, 0);
  assert.deepEqual(timeouts.report.summary.reasons, { ai_timeout: 2 });
  assert.equal(timeouts.report.summary.accuracyPct, 90);
});

test('runAccuracy 文本模式：章节齐全 + §12.7 判定行 + 隐私截断', async () => {
  const out = sink();
  const res = await acc.runAccuracy({
    argv: ['--file', FIXTURE, '--mock', '--mock-accuracy', '0.8'],
    cwd: tmpRoot,
    env: {},
    out,
    err: sink(),
    deps: { loadConfig: () => stubCfg(), mockLatencyMs: 0 },
  });
  assert.equal(res.exitCode, 1);
  const t = res.text;
  assert.equal(t, out.text());
  assert.match(t, /^\[qbank\]\[accuracy\] 测试集=.*accuracy_set\.json 模式=mock 题目=20（非法 0）/);
  assert.match(t, /provider 链=mock 并发=3 单题超时=20000ms 判定阈值=85%/);
  assert.match(t, /mock 模式：桩 provider 离线应答，不联网、不消耗真实额度/);
  assert.match(t, /^\s+#题型\s+结果\s+key\(12\)\s+题干\(前8字\)\s+期望\s+实际\s+provider\s+ms\s+tokens\s+备注/m);
  assert.match(t, /---- 汇总 ----/);
  assert.match(t, /总题数 20 \| 通过 16 \| 失败 4 \| 总准确率 80%/);
  assert.match(t, /分题型准确率：单选题 7\/8 \(87\.5%\) \| 多选题 4\/5 \(80%\) \| 判断题 3\/4 \(75%\) \| 填空题 2\/2 \(100%\) \| 问答题 0\/1 \(0%\)/);
  assert.match(t, /耗时 avg=[\d.]+ms p50=[\d.]+ms p95=[\d.]+ms max=[\d.]+ms/);
  assert.match(t, /失败原因分布：ai_error=4/);
  assert.match(t, /provider 命中：mock 16\/16 \| none 0\/4/);
  assert.match(t, /\[达标判定 HANDOFF §12\.7\] 总准确率 80% >= 85% -> FAIL/);
  assert.ok(!t.includes('机器可读报表已写入'), '没传 --out 不该声称写了报表');

  const TYPES = '单选题|多选题|判断题|填空题|问答题|非法条目';
  const items = fixtureItems().items;
  const rowLines = t.split('\n').filter((l) => new RegExp(`^\\s*\\d\\d(${TYPES})\\s*(PASS|FAIL)`).test(l));
  assert.equal(rowLines.length, 20, '每题一行');
  for (const l of rowLines) {
    const m = l.match(new RegExp(`^\\s*(\\d\\d)(${TYPES})\\s*(PASS|FAIL)\\s+([0-9a-f]{12})\\s+(.*)$`));
    assert.ok(m, `行格式不符：${l}`);
    const idx = Number(m[1]);
    const it = items[idx - 1];
    assert.equal(m[4], it.key.slice(0, 12), `第 ${idx} 行 key 列必须是 key 前 12 位`);
    assert.ok(m[5].startsWith(it.title.slice(0, 8)), `第 ${idx} 行题干列必须以前 8 字开头`);
    assert.ok(!l.includes(it.title), `第 ${idx} 行泄露完整题干`);
  }
  // tokens 列与备注列之间必须留白，不能粘连成 "-ai_error" / "37/5letters"
  assert.ok(!/[-\d](letters|judge|blanks|ai_error|wrong_answer|image_or_formula)/.test(t), 'tokens 列与备注列粘连');
  for (const it of fixtureItems().items) assert.ok(!t.includes(it.title), '文本报表泄露完整题干');
  assert.doesNotMatch(t, /sk-(?!xxxxxxxx)[A-Za-z0-9_-]{8,}/);
});

test('renderNoProviderHint / USAGE：退出码语义与占位 Key 纪律', () => {
  const hint = acc.renderNoProviderHint({ requested: 'bailian', unreachable: ['ollama'] });
  assert.match(hint, /\[qbank\]\[accuracy\]\[ai_disabled\]/);
  assert.match(hint, /--provider bailian/);
  assert.match(hint, /已探活但连不上：ollama/);
  assert.match(hint, /退出码 2（不计为 FAIL）/);
  assert.match(hint, /\.env\.example/);
  assert.match(hint, /DASHSCOPE_API_KEY=sk-xxxxxxxx/);
  assert.match(hint, /ollama serve/);
  assert.match(hint, /ollama pull qwen2\.5:7b/);
  assert.match(hint, /11434\/api\/tags/);
  assert.match(hint, /--mock/);
  assert.doesNotMatch(hint, /sk-(?!xxxxxxxx)[A-Za-z0-9_-]{8,}/);

  assert.equal(acc.renderNoProviderHint().includes('已探活'), false);
  assert.match(acc.USAGE, /总准确率 >= 85% -> PASS/);
  assert.match(acc.USAGE, /0 = PASS，1 = FAIL，2 = 无法执行/);
  assert.equal(acc.THRESHOLD, 0.85);
  assert.deepEqual(acc.EXIT, { PASS: 0, FAIL: 1, UNUSABLE: 2 });
  assert.deepEqual(acc.REPORT_REASONS, { WRONG_ANSWER: 'wrong_answer', INVALID_ITEM: 'invalid_item' });
});