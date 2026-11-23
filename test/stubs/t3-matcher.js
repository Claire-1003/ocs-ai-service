// test/stubs/t3-matcher.js — T3 自用的最小 Matcher 桩（形状照 CONTRACT §2）。
// lib/matcher.js 属于 T1，可能尚未落地；本桩只实现 L1 精确 + 平凡 L2（同归一化题干）。
import { makeKey, normalize } from '../../lib/normalize.js';

export class StubMatcher {
  constructor(matchConfig) {
    this.cfg = matchConfig || {};
    this.map = new Map();
    this.list = [];
  }
  build(records) {
    this.list = Array.isArray(records) ? records.slice() : [];
    this.map = new Map(this.list.map((r) => [r.key, r]));
  }
  add(record) {
    if (!record || !record.key) return;
    const old = this.map.get(record.key);
    if (old) {
      const i = this.list.indexOf(old);
      if (i >= 0) this.list[i] = record; else this.list.push(record);
    } else this.list.push(record);
    this.map.set(record.key, record);
  }
  remove(key) {
    const old = this.map.get(key);
    if (old) this.list = this.list.filter((r) => r !== old);
    this.map.delete(key);
  }
  get size() { return this.map.size; }
  lookupExact(key) { return this.map.get(key); }
  lookup(title, options) {
    const key = makeKey(title ?? '', options ?? '');
    const exact = this.map.get(key);
    if (exact) return { record: exact, score: 1, level: 'L1', suspicious: false };
    const nt = normalize(title ?? '');
    if (nt) {
      for (const rec of this.list) {
        if (normalize(rec.title) === nt) {
          return { record: rec, score: 0.95, level: 'L2', suspicious: false };
        }
      }
    }
    return null;
  }
}

export default StubMatcher;