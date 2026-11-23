// test/import.test.js — T4「数据导入与数据生成」测试（Owner: T4）
// 纪律：node:test + node:assert/strict；数据目录一律 os.tmpdir()；严禁写仓库 data/ logs/；
//       报错/日志不含题目原文；断言卡数值/结构；无真实 sleep>200ms；结束清理临时目录。
// 隔离：所有 CLI 调用默认注入 stubStoreFactory（test/stubs/t4-store.js），
//       因此测试进程绝不 import 真实 lib/store.js 与 config.js（CONTRACT §11.2）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  main as importMain,
  parseArgs as importParseArgs,
  toRecord,
  parseTable,
  parseTxt,
  parseJsonItems,
  splitTxtBlocks,
  normalizeAnswer,
  resolveShortType,
  readBankFile,
  writeBankAtomic,
  stripBom,
} from '../tools/import.js';
import {
  generate as genGenerate,
  writeRecords as genWriteRecords,
  mulberry32,
  EPOCH as GEN_EPOCH,
} from '../tools/genbank.js';
import { makeKey } from '../lib/normalize.js';
import { stubStoreFactory } from './stubs/t4-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NODE = process.execPath;

function fix(name) {
  return path.join(HERE, 'fixtures', name);
}

let TMP;
let seq = 0;
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-t4-'));
});
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});
function tmpOut(base) {
  seq += 1;
  return path.join(TMP, base + '-' + seq + '.json');
}

// 调用 CLI 入口 main()，捕获 stdout/stderr/exitCode，并从 stdout 解析 JSON 摘要。
async function runCli(argv, io) {
  const opts2 = io || {};
  const out = [];
  const err = [];
  let exitCode = null;
  const rc = await importMain(argv, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    exit: (c) => {
      exitCode = c;
    },
    storeFactory: opts2.storeFactory === undefined ? stubStoreFactory : opts2.storeFactory,
  });
  const stdout = out.join('');
  const stderr = err.join('');
  let summary = null;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const p = JSON.parse(t);
      if (p && typeof p.parsed === 'number') summary = p;
    } catch {}
  }
  return { code: exitCode === null ? rc : exitCode, stdout, stderr, summary };
}

// 导入一个 fixture 到临时库并读回记录。
async function importFixture(fmt, name, extra, io) {
  const out = tmpOut('bank-' + fmt);
  const argv = ['--file', fix(name), '--format', fmt, '--out', out];
  if (extra) argv.push(...extra);
  const r = await runCli(argv, io);
  let records = [];
  let doc = null;
  if (fs.existsSync(out)) {
    doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    records = Array.isArray(doc.records) ? doc.records : [];
  }
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, summary: r.summary, out, doc, records };
}

function summaryShape(s) {
  return { parsed: s.parsed, imported: s.imported, skipped: s.skipped, duplicates: s.duplicates, failed: s.failed };
}

const FIELDS_NO_MODEL = ['key', 'title', 'options', 'answer', 'type', 'source', 'verified', 'createdAt'];
const FIELDS_WITH_MODEL = ['key', 'title', 'options', 'answer', 'type', 'source', 'model', 'verified', 'createdAt'];
const ALL_TYPES = ['单选题', '多选题', '判断题', '填空题', '问答题'];

// ============ 四种格式导入：计数 + Record 结构（HANDOFF §8.3） ============

test('CSV 导入：计数与 Record 字段逐一对齐 §8.3', async () => {
  const r = await importFixture('csv', 'sample.csv');
  assert.equal(r.code, 0);
  assert.deepEqual(summaryShape(r.summary), { parsed: 9, imported: 7, skipped: 0, duplicates: 1, failed: 1 });
  assert.equal(r.doc.version, 1);
  assert.equal(r.records.length, 7);
  const rec = r.records[0];
  assert.deepEqual(Object.keys(rec), FIELDS_NO_MODEL);
  assert.equal(rec.type, '多选题');
  assert.equal(rec.answer, 'A#B#C');
  assert.equal(rec.source, 'import');
  assert.equal(rec.verified, false);
  assert.equal(typeof rec.createdAt, 'number');
  assert.ok(Array.isArray(rec.options));
  assert.equal(rec.options.length, 4);
  assert.equal(rec.key, makeKey(rec.title, rec.options));
  assert.equal(typeof rec.key, 'string');
  assert.equal(rec.key.length, 64);
});

test('TSV 导入：缺 type 列时推断题型 + 计数', async () => {
  const r = await importFixture('tsv', 'sample.tsv');
  assert.equal(r.code, 0);
  assert.deepEqual(summaryShape(r.summary), { parsed: 7, imported: 5, skipped: 0, duplicates: 1, failed: 1 });
  assert.equal(r.records.length, 5);
  const judge = r.records.find((x) => x.title.indexOf('宪法规定') === 0);
  assert.equal(judge.type, '判断题');
  assert.equal(judge.answer, '正确');
  const multi = r.records.find((x) => x.title.indexOf('行政处罚') >= 0);
  assert.equal(multi.type, '多选题');
  assert.equal(multi.answer, 'A#B#D');
  for (const rec of r.records) assert.deepEqual(Object.keys(rec), FIELDS_NO_MODEL);
});

test('TXT 导入：容错解析 + 无法解析块进 skipped（退出码仍 0）', async () => {
  const r = await importFixture('txt', 'sample.txt');
  assert.equal(r.code, 0);
  assert.deepEqual(summaryShape(r.summary), { parsed: 8, imported: 7, skipped: 1, duplicates: 1, failed: 0 });
  assert.equal(r.records.length, 7);
  const eco = r.records.find((x) => x.title.indexOf('基本经济制度') >= 0);
  assert.equal(eco.type, '多选题');
  assert.equal(eco.answer, 'A#C#D');
  const judge = r.records.find((x) => x.title.indexOf('公民的基本权利') >= 0);
  assert.equal(judge.type, '判断题');
  assert.equal(judge.answer, '正确');
  const inline = r.records.find((x) => x.title.indexOf('输入设备') >= 0);
  assert.equal(inline.type, '单选题');
  assert.equal(inline.answer, 'C');
  assert.equal(inline.options.length, 4);
});

test('JSON 导入：{records} 形态 + model/verified/createdAt 保留 + source 强制 import', async () => {
  const r = await importFixture('json', 'sample.json');
  assert.equal(r.code, 0);
  assert.deepEqual(summaryShape(r.summary), { parsed: 8, imported: 5, skipped: 0, duplicates: 1, failed: 2 });
  assert.equal(r.records.length, 5);
  const first = r.records[0];
  assert.deepEqual(Object.keys(first), FIELDS_WITH_MODEL);
  assert.equal(first.source, 'import');
  assert.equal(first.model, 'qwen-flash');
  assert.equal(first.verified, true);
  assert.equal(first.createdAt, 1700000000001);
  assert.notEqual(first.key, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  assert.equal(first.key, makeKey(first.title, first.options));
  const hash = r.records.find((x) => x.title.indexOf('本质内涵是什么') >= 0);
  assert.equal(hash.options.length, 4);
  const judge = r.records.find((x) => x.title.indexOf('民法典') >= 0);
  assert.equal(judge.type, '判断题');
  assert.equal(judge.answer, '正确');
});

test('摘要不变式：parsed = imported + duplicates + failed（四格式）', async () => {
  for (const [fmt, name] of [['csv', 'sample.csv'], ['tsv', 'sample.tsv'], ['txt', 'sample.txt'], ['json', 'sample.json']]) {
    const r = await importFixture(fmt, name);
    const s = r.summary;
    assert.equal(s.parsed, s.imported + s.duplicates + s.failed, fmt + ' 摘要不变式');
  }
});

// ============ 引号 / 换行 / BOM / CRLF / 答案归一 ============

test('CSV 引号内含逗号与换行被解析为同一条记录', async () => {
  const r = await importFixture('csv', 'sample.csv');
  const withComma = r.records.find((x) => x.title.indexOf('人工智能') >= 0);
  assert.ok(withComma, '应存在含逗号题干的记录');
  assert.equal(withComma.title.indexOf(',') >= 0, true);
  assert.equal(withComma.type, '单选题');
  const withNewline = r.records.find((x) => x.title.indexOf('数据安全') >= 0);
  assert.ok(withNewline, '应存在含换行题干的记录');
  assert.equal(withNewline.title.indexOf('\n') >= 0, true);
  assert.equal(withNewline.title.indexOf('"') >= 0, true);
  assert.equal(withNewline.options.length, 4);
});

test('CSV 判断题与「内容答案→字母」归一', async () => {
  const r = await importFixture('csv', 'sample.csv');
  const judge = r.records.find((x) => x.title.indexOf('地球') >= 0);
  assert.equal(judge.type, '判断题');
  assert.equal(judge.answer, '正确');
  assert.equal(judge.options.length, 2);
  const content = r.records.find((x) => x.title.indexOf('根本制度') >= 0);
  assert.equal(content.type, '单选题');
  assert.equal(content.answer, 'A');
});

test('stripBom 去除 UTF-8 BOM；BOM 表头首字段被识别', () => {
  assert.equal(stripBom('\uFEFFabc'), 'abc');
  assert.equal(stripBom('abc'), 'abc');
  const withBom = '\uFEFFquestion,type,options,answer\n题一,单选题,A.甲|B.乙,A\n';
  const res = parseTable(withBom, 'csv');
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].title, '题一');
});

test('CRLF 行尾被正确解析（不残留 \\r）', () => {
  const crlf = 'question,type,options,answer\r\n题一,单选题,A.甲|B.乙,A\r\n题二,判断题,A.对|B.错,对\r\n';
  const res = parseTable(crlf, 'csv');
  assert.equal(res.items.length, 2);
  assert.equal(res.items[0].answerRaw, 'A');
  assert.equal(res.items[1].answerRaw, '对');
  assert.equal(res.items[1].title.indexOf('\r'), -1);
});

// ============ 重复 key ============

test('重复 key：CSV/TSV 选项乱序仍判重，JSON 数组乱序仍判重', async () => {
  const csv = await importFixture('csv', 'sample.csv');
  assert.equal(csv.summary.duplicates, 1);
  const tsv = await importFixture('tsv', 'sample.tsv');
  assert.equal(tsv.summary.duplicates, 1);
  const json = await importFixture('json', 'sample.json');
  assert.equal(json.summary.duplicates, 1);
  const txt = await importFixture('txt', 'sample.txt');
  assert.equal(txt.summary.duplicates, 1);
});

// ============ --merge 幂等 / --replace / --dry-run ============

test('--merge 幂等：同一 CSV 导两次，第二次 imported=0 duplicates=8', async () => {
  const out = tmpOut('merge-csv');
  const argv = ['--file', fix('sample.csv'), '--format', 'csv', '--out', out, '--merge'];
  const r1 = await runCli(argv);
  assert.equal(r1.code, 0);
  assert.equal(r1.summary.imported, 7);
  assert.equal(r1.summary.duplicates, 1);
  const r2 = await runCli(argv);
  assert.equal(r2.code, 0);
  assert.equal(r2.summary.imported, 0);
  assert.equal(r2.summary.duplicates, 8);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(doc.records.length, 7);
});

test('--merge 走 readBankFile 回落（storeFactory=null）：TSV 幂等 duplicates=6', async () => {
  const out = tmpOut('merge-tsv');
  const argv = ['--file', fix('sample.tsv'), '--format', 'tsv', '--out', out, '--merge'];
  const r1 = await runCli(argv, { storeFactory: () => null });
  assert.equal(r1.summary.imported, 5);
  const r2 = await runCli(argv, { storeFactory: () => null });
  assert.equal(r2.summary.imported, 0);
  assert.equal(r2.summary.duplicates, 6);
});

test('--replace 整库替换：旧记录消失 + 生成 .bak 备份', async () => {
  const out = tmpOut('replace');
  const r1 = await runCli(['--file', fix('sample.csv'), '--format', 'csv', '--out', out, '--replace']);
  assert.equal(r1.summary.imported, 7);
  assert.equal(fs.existsSync(out + '.bak'), false);
  const r2 = await runCli(['--file', fix('sample.json'), '--format', 'json', '--out', out, '--replace']);
  assert.equal(r2.summary.imported, 5);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(doc.records.length, 5);
  assert.equal(doc.records.some((x) => x.title.indexOf('请简述依法治国') >= 0), false);
  assert.equal(fs.existsSync(out + '.bak'), true);
  const bak = JSON.parse(fs.readFileSync(out + '.bak', 'utf8'));
  assert.equal(bak.records.length, 7);
});

test('--dry-run 不创建目标文件', async () => {
  const out = tmpOut('dry-new');
  const r = await runCli(['--file', fix('sample.csv'), '--format', 'csv', '--out', out, '--dry-run']);
  assert.equal(r.code, 0);
  assert.equal(r.summary.parsed, 9);
  assert.equal(r.summary.imported, 7);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(out + '.bak'), false);
});

test('--dry-run 不修改已存在文件（逐字节不变）', async () => {
  const out = tmpOut('dry-exist');
  await runCli(['--file', fix('sample.csv'), '--format', 'csv', '--out', out, '--replace']);
  const before = fs.readFileSync(out);
  const r = await runCli(['--file', fix('sample.json'), '--format', 'json', '--out', out, '--merge', '--dry-run']);
  assert.equal(r.code, 0);
  const after = fs.readFileSync(out);
  assert.equal(Buffer.compare(before, after), 0);
});

// ============ 错误处理：退出码 1 + 中文报错 + 无堆栈 ============

test('文件不存在 → 退出码 1 + 中文报错 + 无堆栈污染', async () => {
  const out = tmpOut('err-missing');
  const r = await runCli(['--file', path.join(TMP, 'no-such-file.csv'), '--format', 'csv', '--out', out, '--dry-run']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /文件读取失败/);
  assert.equal(/\n\s+at\s/.test(r.stderr), false);
  assert.equal(fs.existsSync(out), false);
  assert.ok(r.summary && typeof r.summary.parsed === 'number');
});

test('非法 JSON → 退出码 1 + 中文报错 + 无堆栈', async () => {
  seq += 1;
  const badFile = path.join(TMP, 'bad-' + seq + '.json');
  fs.writeFileSync(badFile, '{ 这不是合法 JSON ', 'utf8');
  const out = tmpOut('err-json');
  const r = await runCli(['--file', badFile, '--format', 'json', '--out', out, '--dry-run']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /JSON/);
  assert.equal(/\n\s+at\s/.test(r.stderr), false);
});

test('非法 --format → 退出码 1', async () => {
  const r = await runCli(['--file', fix('sample.csv'), '--format', 'xlsx', '--out', tmpOut('err-fmt'), '--dry-run']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /格式/);
});

// ============ parseArgs / 解析器单元测试 ============

test('parseArgs：--merge/--replace 互斥 + 默认值 + 扩展名推断', () => {
  assert.throws(() => importParseArgs(['--file', 'a.csv', '--format', 'csv', '--merge', '--replace']), /互斥/);
  const o = importParseArgs(['--file', 'a.csv', '--format', 'csv']);
  assert.equal(o.mode, 'merge');
  assert.equal(o.dryRun, false);
  const rp = importParseArgs(['--file', 'a.csv', '--format', 'csv', '--replace']);
  assert.equal(rp.mode, 'replace');
  const inf = importParseArgs(['--file', 'x.tsv']);
  assert.equal(inf.format, 'tsv');
});

test('splitTxtBlocks：相邻无空行块在「已答 + 新题号」处切分', () => {
  const txt = '【单选题】题一\nA.甲\nB.乙\n答案：A\n【单选题】题二\nA.丙\nB.丁\n答案：B\n';
  const blocks = splitTxtBlocks(txt);
  assert.equal(blocks.length, 2);
  const parsed = parseTxt(txt);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.skipped, 0);
});

test('parseTxt：缺答案标记的块进 skipped，其余正常解析', () => {
  const txt = '【单选题】题一\nA.甲\nB.乙\n答案：A\n\n这是一段说明文字没有答案标记\n\n【判断题】题二\nA.正确\nB.错误\n答案：对\n';
  const parsed = parseTxt(txt);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.skipped, 1);
});

test('normalizeAnswer：各题型归一（多选/判断/单选/填空/内容→字母）', () => {
  assert.equal(normalizeAnswer('AC', '多选', ['A.x', 'B.y', 'C.z']), 'A#C');
  assert.equal(normalizeAnswer('对', '判断', ['A.正确', 'B.错误']), '正确');
  assert.equal(normalizeAnswer('错', '判断', ['A.正确', 'B.错误']), '错误');
  assert.equal(normalizeAnswer('答案是：B', '单选', ['A.x', 'B.y']), 'B');
  assert.equal(normalizeAnswer('甲;乙', '填空', []), '甲#乙');
  assert.equal(normalizeAnswer('社会主义制度', '单选', ['A.社会主义制度', 'B.其他']), 'A');
});

test('resolveShortType：无 type + 多字母答案 → 多选；显式 type 优先', () => {
  assert.equal(resolveShortType('', null, '题', ['A.a', 'B.b', 'C.c'], 'A#C'), '多选');
  assert.equal(resolveShortType('单选题', null, '题', ['A.a', 'B.b'], 'A'), '单选');
  // T6/P0-2③：兜底规则已委托给 normalizeType 规则 0，口径与 lib/normalize.js 完全一致
  assert.equal(resolveShortType('不定项选择题', null, '题', ['A.a', 'B.b', 'C.c'], 'A'), '多选');
  assert.equal(resolveShortType('', '不定项', '题', ['A.a', 'B.b', 'C.c'], 'A'), '多选');
  assert.equal(resolveShortType('', null, '题', ['A.a', 'B.b', 'C.c'], 'AC'), '多选');
  assert.equal(resolveShortType('', null, '题', ['A.a', 'B.b', 'C.c'], 'A'), '单选'); // 单字母不触发
  assert.equal(resolveShortType('', null, '题', ['A.正确', 'B.错误'], 'A'), '判断'); // 判断题不被抢答
});

test('parseTable：表头大小写与中英冒号容错', () => {
  const csv = 'Question：,TYPE,options,Answer\n题一,单选题,A.甲|B.乙,A\n';
  const res = parseTable(csv, 'csv');
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].title, '题一');
  assert.equal(res.items[0].typeRaw, '单选题');
});

test('parseJsonItems：三形态（数组 / {records} / 单对象）+ 非法 JSON 抛错', () => {
  const arr = parseJsonItems('[{"title":"题一","answer":"A","type":"单选题","options":["A.a","B.b"]}]');
  assert.equal(arr.items.length, 1);
  const wrapped = parseJsonItems('{"records":[{"title":"题二","answer":"B","type":"单选题","options":["A.a","B.b"]}]}');
  assert.equal(wrapped.items.length, 1);
  const single = parseJsonItems('{"title":"题三","answer":"C","type":"单选题","options":["A.a","B.b","C.c"]}');
  assert.equal(single.items.length, 1);
  assert.throws(() => parseJsonItems('{bad'), /JSON/);
});

test('toRecord：字段顺序 + key/source/verified + --verified 覆盖 + 空题干抛 bad_request', () => {
  const rec = toRecord({ title: '题一', options: ['A.甲', 'B.乙'], answerRaw: 'A', typeRaw: '单选题' }, {});
  assert.deepEqual(Object.keys(rec), FIELDS_NO_MODEL);
  assert.equal(rec.source, 'import');
  assert.equal(rec.verified, false);
  assert.equal(rec.key, makeKey('题一', ['A.甲', 'B.乙']));
  const v = toRecord({ title: '题二', options: [], answerRaw: '答', typeRaw: '问答题' }, { verified: true });
  assert.equal(v.verified, true);
  assert.throws(
    () => toRecord({ title: '   ', options: [], answerRaw: 'A', typeRaw: '单选题' }, {}),
    (e) => e && e.code === 'bad_request'
  );
});

test('writeBankAtomic + readBankFile 往返（备份 / 缺失 / 损坏）', () => {
  const bank = tmpOut('roundtrip');
  const recs = [{ key: 'k1', title: 't', options: [], answer: 'a', type: '问答题', source: 'import', verified: false, createdAt: 1 }];
  const w1 = writeBankAtomic(bank, bank + '.bak', recs);
  assert.equal(w1.backup, false);
  const read1 = readBankFile(bank);
  assert.equal(read1.records.length, 1);
  assert.equal(read1.existed, true);
  const recs2 = recs.concat([{ key: 'k2', title: 't2', options: [], answer: 'a2', type: '问答题', source: 'import', verified: false, createdAt: 2 }]);
  const w2 = writeBankAtomic(bank, bank + '.bak', recs2);
  assert.equal(w2.backup, true);
  assert.equal(fs.existsSync(bank + '.bak'), true);
  assert.equal(readBankFile(bank).records.length, 2);
  seq += 1;
  const missing = readBankFile(path.join(TMP, 'definitely-missing-' + seq + '.json'));
  assert.equal(missing.existed, false);
  assert.deepEqual(missing.records, []);
  seq += 1;
  const corrupt = path.join(TMP, 'corrupt-' + seq + '.json');
  fs.writeFileSync(corrupt, '{ bad json', 'utf8');
  assert.deepEqual(readBankFile(corrupt).records, []);
});

// ============ genbank：确定性 PRNG + 合成数据 ============

test('genbank：mulberry32 同 seed 序列一致且落在 [0,1)', () => {
  const r1 = mulberry32(42);
  const r2 = mulberry32(42);
  const s1 = [r1(), r1(), r1()];
  const s2 = [r2(), r2(), r2()];
  assert.deepEqual(s1, s2);
  for (const x of s1) {
    assert.ok(x >= 0 && x < 1);
  }
});

test('genbank：同 seed 两次 generate 结果完全一致', () => {
  const a = genGenerate(500, 42);
  const b = genGenerate(500, 42);
  assert.equal(JSON.stringify(a.records), JSON.stringify(b.records));
  assert.equal(a.records.length, 500);
});

test('genbank：结构 / 统计 / 题型比例 / key 唯一 / 字段对齐', () => {
  const { records, stats } = genGenerate(2000, 42);
  assert.equal(records.length, 2000);
  assert.equal(stats.count, 2000);
  assert.ok(stats.nearDuplicates >= 60 && stats.nearDuplicates <= 160, '近似重复约 5%，实际=' + stats.nearDuplicates);
  assert.equal(new Set(records.map((r) => r.key)).size, 2000);
  const bt = stats.byType;
  assert.ok(bt['单选题'] > bt['多选题']);
  assert.ok(bt['多选题'] > bt['判断题']);
  assert.ok(bt['判断题'] > bt['填空题']);
  assert.ok(Math.abs(bt['填空题'] - bt['问答题']) <= 20);
  assert.ok(bt['单选题'] >= 800 && bt['单选题'] <= 1150);
  for (const r of records) {
    assert.deepEqual(Object.keys(r), FIELDS_NO_MODEL);
    assert.equal(r.source, 'import');
    assert.equal(r.verified, false);
    assert.equal(r.key, makeKey(r.title, r.options));
    assert.ok(r.title.length >= 15 && r.title.length <= 60, '题干长度越界=' + r.title.length);
    assert.ok(ALL_TYPES.indexOf(r.type) >= 0);
    if (r.type === '单选题' || r.type === '多选题') {
      assert.ok(r.options.length >= 2 && r.options.length <= 5);
    }
  }
});

test('genbank：writeRecords 输出 {version:1,updatedAt:EPOCH,records}', () => {
  const { records } = genGenerate(50, 7);
  const out = tmpOut('gen-write');
  const w = genWriteRecords(out, records);
  assert.equal(typeof w.bytes, 'number');
  assert.ok(w.bytes > 0);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(doc), ['version', 'updatedAt', 'records']);
  assert.equal(doc.version, 1);
  assert.equal(doc.updatedAt, GEN_EPOCH);
  assert.equal(doc.records.length, 50);
});

// ============ 子进程端到端（验证真实 CLI 入口 / process.exit / 逐字节复现） ============

test('import CLI 子进程：--dry-run 输出 JSON 摘要且退出码 0、不写盘', () => {
  const out = tmpOut('cli-sub');
  const script = path.join(ROOT, 'tools', 'import.js');
  const stdout = execFileSync(NODE, [script, '--file', fix('sample.csv'), '--format', 'csv', '--out', out, '--replace', '--dry-run'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const summary = JSON.parse(stdout.trim().split('\n').pop());
  assert.deepEqual(summaryShape(summary), { parsed: 9, imported: 7, skipped: 0, duplicates: 1, failed: 1 });
  assert.equal(fs.existsSync(out), false);
});

test('import CLI 子进程：文件不存在 → 退出码 1（无堆栈）', () => {
  const out = tmpOut('cli-sub-err');
  const script = path.join(ROOT, 'tools', 'import.js');
  let status = 0;
  let stderr = '';
  try {
    execFileSync(NODE, [script, '--file', path.join(TMP, 'ghost.csv'), '--format', 'csv', '--out', out, '--dry-run'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    status = e.status;
    stderr = String(e.stderr || '');
  }
  assert.equal(status, 1);
  assert.match(stderr, /文件读取失败/);
  assert.equal(/\n\s+at\s/.test(stderr), false);
});

test('genbank CLI 子进程：同 seed 两次运行产出逐字节相同的文件', () => {
  const out1 = tmpOut('gencli-a');
  const out2 = tmpOut('gencli-b');
  const script = path.join(ROOT, 'tools', 'genbank.js');
  const o1 = execFileSync(NODE, [script, '--count', '800', '--seed', '42', '--out', out1], { cwd: ROOT, encoding: 'utf8' });
  execFileSync(NODE, [script, '--count', '800', '--seed', '42', '--out', out2], { cwd: ROOT, encoding: 'utf8' });
  const b1 = fs.readFileSync(out1);
  const b2 = fs.readFileSync(out2);
  assert.equal(Buffer.compare(b1, b2), 0);
  const s1 = JSON.parse(o1.trim().split('\n').pop());
  assert.equal(s1.count, 800);
  assert.equal(s1.seed, 42);
});
