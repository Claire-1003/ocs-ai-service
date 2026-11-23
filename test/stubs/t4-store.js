// test/stubs/t4-store.js — T4 测试专用桩（非交付物）。
//
// 目的：让 tools/import.js 在 --merge/--replace 测试中通过 storeFactory 注入读取「现有题库」，
//       从而不触碰真实 config.js / lib/store.js / data/（CONTRACT §11.2 数据隔离）。
// 契约：按 CONTRACT §3 的 Store 形状实现 import.js 实际用到的最小方法集：
//       constructor({bankPath,bakPath}) / async load() / records() / async close()。
// 纪律：顶层无 I/O、无副作用；只读传入的 bankPath（测试临时目录），绝不写仓库 data/。

import fs from 'node:fs';

function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export class StubStore {
  #bankPath;
  #records = [];

  constructor(opts = {}) {
    this.#bankPath = String((opts && opts.bankPath) || '');
  }

  /** 读取 bank.json：缺失/损坏/结构不识别一律回退空库（与 lib/store.js 行为一致，不抛）。 */
  async load() {
    this.#records = [];
    let raw;
    try {
      raw = fs.readFileSync(this.#bankPath, 'utf8');
    } catch {
      return; // 文件缺失 -> 空库
    }
    const body = stripBom(raw).trim();
    if (!body) return;
    let doc;
    try {
      doc = JSON.parse(body);
    } catch {
      return; // 损坏 -> 空库
    }
    const arr = Array.isArray(doc)
      ? doc
      : doc && Array.isArray(doc.records)
        ? doc.records
        : [];
    const seen = new Set();
    for (const r of arr) {
      if (r && typeof r === 'object' && !Array.isArray(r) && typeof r.key === 'string' && !seen.has(r.key)) {
        seen.add(r.key);
        this.#records.push(r);
      }
    }
  }

  /** 只读数组引用（import.js 会 slice 后使用）。 */
  records() {
    return this.#records;
  }

  /** import.js 的 loadExisting 会可选调用；桩里是 no-op。 */
  async close() {}
}

/** storeFactory 钩子：import.js 的 createStore 会 await storeFactory({bankPath,bakPath})。 */
export function stubStoreFactory(hookOpts = {}) {
  return new StubStore(hookOpts);
}

export default StubStore;
