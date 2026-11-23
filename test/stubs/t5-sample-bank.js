// test/stubs/t5-sample-bank.js — T5 自测用的合成题库生成器（桩，非交付物）
//
// 用途：T4 的 tools/genbank.js 与 data/bench.json 尚未就绪时，为 tools/bench.js 提供
//       可控规模的合成题库。按 CONTRACT §11.2 / TASKS.md 的 T5 隔离要点，桩只放在
//       test/stubs/ 下，产物只写到 --out 指定的路径（默认 os.tmpdir()），绝不写仓库 data/。
//
// 作为模块：import { makeSampleRecords } from './t5-sample-bank.js'
// 作为 CLI：node test/stubs/t5-sample-bank.js --count 20000 --out <tmp>/bench.json [--seed 42] [--format bank|array]
//
// 本文件顶层无 I/O、无副作用（CONTRACT §11.7），被 node --test 当作测试文件加载时也是惰性的。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeKey } from '../../lib/normalize.js';
import { pathToFileURL } from 'node:url';

const SUBJECTS = [
  '数据库管理系统', '计算机网络协议', '操作系统进程调度', '软件工程需求分析', '数据结构与算法',
  '人工智能机器学习', '信息安全加密算法', '分布式系统一致性', '编译原理语法分析', '计算机组成原理',
  '面向对象程序设计', '操作系统内存管理',
];
const MODS = [
  '在实际应用中的主要作用是', '下列关于其特性的描述正确的是', '在生产环境中通常采用的实现方式是',
  '与同类方案相比其显著优势在于', '在课程实验中需要重点掌握的内容是',
];
const TAILS = [
  '请从下列选项中选择最恰当的一项', '下列说法中最准确的是哪一项', '以下描述中符合实际情况的是',
  '请判断以下哪一项表述成立', '在给定条件下最合理的结论是',
];
const OPTION_TEXTS = [
  '能够显著提升系统吞吐量', '需要额外的硬件支持才能生效', '仅适用于单机部署场景',
  '与具体实现细节完全无关', '必须依赖第三方组件库', '在低负载时表现更稳定',
];
const TYPES = ['单选题', '单选题', '单选题', '多选题', '判断题'];

/** 确定性伪随机数（mulberry32），同 seed 同 count 必得同结果。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成合成题库记录（结构与 CONTRACT §3 的 Record 一致）。
 * @param {{count?:number, seed?:number, baseTime?:number}} [opts]
 * @returns {Array<{key:string,title:string,options:string[],answer:string,type:string,source:string,verified:boolean,createdAt:number}>}
 */
export function makeSampleRecords(opts = {}) {
  const o = opts || {};
  const count = Math.max(0, Number.parseInt(o.count, 10) || 0);
  const rand = mulberry32(Number.isFinite(o.seed) ? o.seed : 42);
  const baseTime = Number.isFinite(o.baseTime) ? o.baseTime : 1763452800000;
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const s = SUBJECTS[Math.floor(rand() * SUBJECTS.length) % SUBJECTS.length];
    const m = MODS[Math.floor(rand() * MODS.length) % MODS.length];
    const t = TAILS[Math.floor(rand() * TAILS.length) % TAILS.length];
    const title = `${s}${m}${t}第${i + 1}号案例`;
    const type = TYPES[i % TYPES.length];
    const options = [];
    if (type !== '判断题') {
      const letters = ['A', 'B', 'C', 'D'];
      for (let k = 0; k < 4; k += 1) {
        options.push(`${letters[k]}.${OPTION_TEXTS[(i + k * 3) % OPTION_TEXTS.length]}`);
      }
    } else {
      options.push('A.正确', 'B.错误');
    }
    const answer = type === '判断题' ? (i % 2 === 0 ? '正确' : '错误') : type === '多选题' ? 'A#C' : 'B';
    // key 必须与 lib/normalize.js 的 makeKey 完全一致，否则 Matcher 的 L1（_byKey）永远命不中，
    // bench 的「L1 阶段」会退化成 L2 候选扫描，测出来的数字是假的。
    const key = makeKey(title, options);
    records.push({
      key,
      title,
      options,
      answer,
      type,
      source: 'import',
      verified: true,
      createdAt: baseTime + i,
    });
  }
  return records;
}

/** 包成 bank.json 顶层结构（DECISIONS #13）。 */
export function wrapBank(records, updatedAt = Date.now()) {
  return { version: 1, updatedAt, records };
}

export function parseStubArgs(argv = []) {
  const out = { count: 2000, out: '', seed: 42, format: 'bank' };
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--count') out.count = Number.parseInt(list[++i], 10) || out.count;
    else if (a === '--out') out.out = String(list[++i] || '');
    else if (a === '--seed') out.seed = Number.parseInt(list[++i], 10) || out.seed;
    else if (a === '--format') out.format = String(list[++i] || 'bank') === 'array' ? 'array' : 'bank';
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseStubArgs(argv);
  const records = makeSampleRecords({ count: args.count, seed: args.seed });
  const payload = args.format === 'array' ? records : wrapBank(records);
  const target = args.out
    ? path.resolve(args.out)
    : path.join(os.tmpdir(), `qbank-t5-bench-${args.count}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(payload), 'utf8');
  process.stdout.write(
    `[qbank][t5-stub] 合成题库已写入 ${target}（records=${records.length} seed=${args.seed} format=${args.format}）\n`,
  );
  return target;
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) main();

export default { makeSampleRecords, wrapBank, mulberry32, main };
