// lib/cache.js — LRU 内存缓存 + 落盘（Owner: T3，零第三方依赖，ESM）
//
// CONTRACT §4：
//   LRU（maxEntries 默认 10000），满时淘汰最久未使用；
//   每 100 次 set 强制 flush；startAutoFlush 的 interval 必须 unref()；
//   flush 用临时文件 + rename 原子替换（DECISIONS #14）；load 缺失/损坏不抛。
//   启动加载顺序（DECISIONS #10）：先 store 后 cache，cache 中与 bank 同 key 的条目由 server 丢弃。
// 文件格式：{"version":1,"updatedAt":<ms>,"entries":{key:{answer,source,type,model?,createdAt}}}
// 日志纪律：只输出错误码/计数/key 前 12 位，绝不输出题干、选项、答案原文。

import fs from 'node:fs';
import path from 'node:path';

const FLUSH_EVERY_N_WRITES = 100;

function sanitizeValue(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.answer !== 'string' || raw.answer === '') return null;
    const v = {
      answer: raw.answer,
      source: typeof raw.source === 'string' && raw.source ? raw.source : 'ai',
      type: typeof raw.type === 'string' && raw.type ? raw.type : '问答题',
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    };
    if (typeof raw.model === 'string' && raw.model) v.model = raw.model;
    return v;
  } catch {
    return null;
  }
}

export class LRU {
  #map = new Map();
  #maxEntries;
  #file;
  #flushIntervalMs;
  #log;
  #timer = null;
  #writeChain = Promise.resolve();
  #stats = { hits: 0, misses: 0, evictions: 0, writes: 0, flushedAt: 0 };
  #warned = new Set();

  /** @param {{maxEntries?:number, file?:string, flushIntervalMs?:number, log?:object}} opts */
  constructor(opts = {}) {
    const m = Number(opts.maxEntries);
    this.#maxEntries = Number.isFinite(m) && m >= 1 ? m : 10000;
    this.#file = String(opts.file || '');
    const f = Number(opts.flushIntervalMs);
    this.#flushIntervalMs = Number.isFinite(f) && f >= 1 ? f : 30000;
    this.#log = opts.log || null;
  }

  #warn(code, msg) {
    if (this.#warned.has(code)) return;
    this.#warned.add(code);
    const line = `[qbank][cache][${code}] ${msg}\n`;
    try {
      if (this.#log && typeof this.#log.error === 'function') this.#log.error('cache', code);
      else process.stderr.write(line);
    } catch {
      try { process.stderr.write(line); } catch { /* 忽略 */ }
    }
  }

  /** 缺失/损坏 -> 空缓存，不抛。 */
  async load() {
    this.#map = new Map();
    if (!this.#file) return;
    let raw;
    try {
      raw = fs.readFileSync(this.#file, 'utf8');
    } catch (err) {
      const code = (err && err.code) || 'read_failed';
      if (code !== 'ENOENT') this.#warn('cache_missing', `缓存文件不可读（${code}），使用空缓存`);
      return;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      this.#warn('cache_corrupt', `缓存文件 JSON 解析失败（${(err && (err.code || err.name)) || 'SyntaxError'}），已回退空缓存`);
      return;
    }
    let entries = null;
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      if (doc.entries && typeof doc.entries === 'object' && !Array.isArray(doc.entries)) entries = doc.entries;
      else if (!('records' in doc) && !('version' in doc)) entries = doc; // 兼容裸 map
    }
    if (!entries) {
      this.#warn('cache_shape', '缓存文件结构不识别（期望 {entries:{...}}），已回退空缓存');
      return;
    }
    let skipped = 0;
    for (const [k, v] of Object.entries(entries)) {
      const val = sanitizeValue(v);
      if (!val || typeof k !== 'string' || !k) { skipped += 1; continue; }
      this.#map.set(k, val); // 载入不计 writes、不触发 flush
    }
    if (skipped > 0) this.#warn('cache_skipped', `载入时跳过 ${skipped} 条非法缓存条目`);
  }

  /** @returns {{answer,source,type,model?,createdAt}|undefined} */
  get(key) {
    if (typeof key !== 'string' || !this.#map.has(key)) {
      this.#stats.misses += 1;
      return undefined;
    }
    const v = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, v); // 移到最新端
    this.#stats.hits += 1;
    return v;
  }

  set(key, value) {
    if (typeof key !== 'string' || !key) return;
    const v = sanitizeValue(value);
    if (!v) return;
    this.#map.delete(key);
    this.#map.set(key, v);
    this.#stats.writes += 1;
    while (this.#map.size > this.#maxEntries) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      this.#map.delete(oldest.value);
      this.#stats.evictions += 1;
    }
    if (this.#stats.writes % FLUSH_EVERY_N_WRITES === 0) {
      this.flush().catch(() => { /* writeOnce 已兜底 */ });
    }
  }

  has(key) {
    return typeof key === 'string' && this.#map.has(key);
  }

  delete(key) {
    if (typeof key !== 'string') return false;
    return this.#map.delete(key); // 主动删除不计 evictions
  }

  get size() {
    return this.#map.size;
  }

  /** 立即落盘（临时文件 + rename，串行化排队）。@returns {Promise<boolean>} */
  flush() {
    if (!this.#file) return Promise.resolve(false);
    this.#writeChain = this.#writeChain.then(() => this.#writeOnce(), () => this.#writeOnce());
    return this.#writeChain;
  }

  /** 当前在途写队列（测试/退出钩子可 await）。 */
  get flushing() {
    return this.#writeChain;
  }

  #writeOnce() {
    try {
      const dir = path.dirname(this.#file);
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
      const doc = { version: 1, updatedAt: Date.now(), entries: Object.fromEntries(this.#map) };
      const tmp = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
      fs.renameSync(tmp, this.#file);
      this.#stats.flushedAt = Date.now();
      return true;
    } catch (err) {
      this.#warn('flush_failed', `缓存落盘失败（${(err && (err.code || err.name)) || 'error'}）`);
      return false;
    }
  }

  /** @returns {{size,hits,misses,evictions,writes,flushedAt}} */
  stats() {
    return { size: this.#map.size, ...this.#stats };
  }

  startAutoFlush() {
    this.stopAutoFlush();
    this.#timer = setInterval(() => {
      this.flush().catch(() => { /* writeOnce 已兜底 */ });
    }, this.#flushIntervalMs);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  stopAutoFlush() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}

export default LRU;