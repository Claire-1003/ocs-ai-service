// lib/store.js — 题库存储（Owner: T3，零第三方依赖，ESM）
//
// CONTRACT §3：
//   bank.json 顶层 {version:1,updatedAt,records:[Record]}，load 兼容裸数组；
//   Record 字段严格照 HANDOFF §8.3：{key,title,options,answer,type,source,model?,verified,createdAt}
//   type 存 toLabel() 后的中文题型；source ∈ local|ai|import|fuzzy。
//   persist：先复制 bank.json -> bank.json.bak，再写临时文件 + rename 原子替换（DECISIONS #14），
//   且通过单写队列串行化，同一时刻只有一个写在途。
//   add 后 1000ms 去抖合并落盘（persistDebounceMs 可注入，供测试）。
//   requireVerified=true 时 get/match 过滤未验证条目（DECISIONS #6）。
// 健壮性：所有 fs 操作 try/catch，失败只 stderr 记错误码，不抛；顶层无 I/O；无 process.exit。
// 日志纪律：只输出错误码/计数/key 前 12 位，绝不输出题干、选项、答案原文。

import fs from 'node:fs';
import path from 'node:path';

const SOURCES = new Set(['local', 'ai', 'import', 'fuzzy']);

/** 按契约字段清洗一条记录；非法返回 null。字段顺序与 HANDOFF §8.3 一致。 */
function sanitizeRecord(raw, defaultSource) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const key = typeof raw.key === 'string' ? raw.key : '';
    const title = typeof raw.title === 'string' ? raw.title : '';
    if (!key || !title) return null;
    const options = Array.isArray(raw.options) ? raw.options.map((o) => String(o)) : [];
    const answer = typeof raw.answer === 'string' ? raw.answer : String(raw.answer ?? '');
    const type = typeof raw.type === 'string' && raw.type ? raw.type : '问答题';
    const source = SOURCES.has(raw.source) ? raw.source : defaultSource;
    const verified = raw.verified === true;
    const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
    if (typeof raw.model === 'string' && raw.model) {
      return { key, title, options, answer, type, source, model: raw.model, verified, createdAt };
    }
    return { key, title, options, answer, type, source, verified, createdAt };
  } catch {
    return null;
  }
}

export class Store {
  #bankPath;
  #bakPath;
  #config;
  #matcher;
  #log;
  #records = [];
  #byKey = new Map();
  #writeChain = Promise.resolve();
  #debounceTimer = null;
  #debounceMs;
  #counters = { l1Hits: 0, l2Hits: 0, l2Suspicious: 0, noMatch: 0 };
  #warned = new Set();

  /**
   * @param {{bankPath:string, bakPath:string, config?:object, matcher?:object, log?:object, persistDebounceMs?:number}} opts
   *   matcher 为构造注入（CONTRACT §2 的 Matcher 形状），缺失时 match() 返回 null 但 get() 仍可用。
   */
  constructor(opts = {}) {
    this.#bankPath = String(opts.bankPath || 'bank.json');
    this.#bakPath = String(opts.bakPath || this.#bankPath + '.bak');
    this.#config = opts.config || null;
    this.#matcher = opts.matcher || null;
    this.#log = opts.log || null;
    const d = Number(opts.persistDebounceMs);
    this.#debounceMs = Number.isFinite(d) && d >= 0 ? d : 1000;
  }

  #warn(code, msg) {
    if (this.#warned.has(code)) return;
    this.#warned.add(code);
    const line = `[qbank][store][${code}] ${msg}\n`;
    try {
      if (this.#log && typeof this.#log.error === 'function') this.#log.error('store', code);
      else process.stderr.write(line);
    } catch {
      try { process.stderr.write(line); } catch { /* 忽略 */ }
    }
  }

  #requireVerified() {
    try { return this.#config?.writeback?.requireVerified === true; } catch { return false; }
  }

  #rebuildIndex() {
    try {
      if (this.#matcher && typeof this.#matcher.build === 'function') this.#matcher.build(this.#records);
    } catch (err) {
      this.#warn('index_build_failed', `matcher.build 失败（${(err && (err.code || err.name)) || 'error'}），L1/L2 可能不可用`);
    }
  }

  /** 读 bank.json。缺失/损坏 -> 空库 + 一条 stderr 警告，不抛。 */
  async load() {
    this.#records = [];
    this.#byKey = new Map();
    let raw;
    try {
      raw = fs.readFileSync(this.#bankPath, 'utf8');
    } catch (err) {
      const code = (err && err.code) || 'read_failed';
      this.#warn('bank_missing', `题库文件不可读（${code}），使用空题库`);
      this.#rebuildIndex();
      return;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      this.#warn('bank_corrupt', `题库文件 JSON 解析失败（${(err && (err.code || err.name)) || 'SyntaxError'}），已回退空题库`);
      this.#rebuildIndex();
      return;
    }
    let arr;
    if (Array.isArray(doc)) arr = doc; // DECISIONS #13：兼容裸数组
    else if (doc && typeof doc === 'object' && Array.isArray(doc.records)) arr = doc.records;
    else {
      this.#warn('bank_shape', '题库文件结构不识别（期望 {records:[...]} 或裸数组），已回退空题库');
      this.#rebuildIndex();
      return;
    }
    let skipped = 0;
    for (const item of arr) {
      const rec = sanitizeRecord(item, 'local');
      if (!rec) { skipped += 1; continue; }
      if (this.#byKey.has(rec.key)) { skipped += 1; continue; } // 同 key 保留首条
      this.#records.push(rec);
      this.#byKey.set(rec.key, rec);
    }
    if (skipped > 0) this.#warn('bank_skipped', `载入时跳过 ${skipped} 条非法/重复记录`);
    this.#rebuildIndex();
  }

  /** @returns {object|undefined} 受 requireVerified 过滤（DECISIONS #6） */
  get(key) {
    const rec = this.#byKey.get(key);
    if (!rec) return undefined;
    if (this.#requireVerified() && rec.verified !== true) return undefined;
    return rec;
  }

  /** @returns {{record,score,level,suspicious}|null} 同 Matcher.lookup 结果，受 requireVerified 过滤 */
  match(title, options) {
    let res = null;
    try {
      if (this.#matcher && typeof this.#matcher.lookup === 'function') {
        res = this.#matcher.lookup(title, options, {});
      }
    } catch (err) {
      this.#warn('match_error', `matcher.lookup 失败（${(err && (err.code || err.name)) || 'error'}）`);
      res = null;
    }
    if (res && res.record) {
      if (this.#requireVerified() && res.record.verified !== true) {
        this.#counters.noMatch += 1;
        return null;
      }
      if (res.level === 'L1') this.#counters.l1Hits += 1;
      else if (res.suspicious === true) this.#counters.l2Suspicious += 1;
      else this.#counters.l2Hits += 1;
      return res;
    }
    this.#counters.noMatch += 1;
    return null;
  }

  /** 内存追加（同 key 原位替换）+ 索引 add + 触发去抖 persist。返回清洗后的记录或 null。 */
  add(record) {
    const rec = sanitizeRecord(record, 'ai');
    if (!rec) return null;
    const old = this.#byKey.get(rec.key);
    if (old) {
      const idx = this.#records.indexOf(old);
      if (idx >= 0) this.#records[idx] = rec;
      else this.#records.push(rec);
    } else {
      this.#records.push(rec);
    }
    this.#byKey.set(rec.key, rec);
    try {
      if (this.#matcher && typeof this.#matcher.add === 'function') this.#matcher.add(rec);
    } catch (err) {
      this.#warn('index_add_failed', `matcher.add 失败（${(err && (err.code || err.name)) || 'error'}）`);
    }
    this.#schedulePersist();
    return rec;
  }

  /** 人工标记 verified 并触发去抖落盘（DECISIONS #11）。@returns {boolean} key 是否存在 */
  setVerified(key, verified) {
    const rec = this.#byKey.get(key);
    if (!rec) return false;
    rec.verified = Boolean(verified);
    this.#schedulePersist();
    return true;
  }

  #schedulePersist() {
    if (this.#debounceTimer) return;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this.persist().catch(() => { /* persist 内部已兜底，不会 reject */ });
    }, this.#debounceMs);
    if (typeof this.#debounceTimer.unref === 'function') this.#debounceTimer.unref();
  }

  /** 立即落盘（串行化排队）。@returns {Promise<boolean>} 是否成功 */
  persist() {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    this.#writeChain = this.#writeChain.then(() => this.#writeOnce(), () => this.#writeOnce());
    return this.#writeChain;
  }

  /** 当前在途写队列（测试/退出钩子可 await）。 */
  get flushing() {
    return this.#writeChain;
  }

  #writeOnce() {
    try {
      const dir = path.dirname(this.#bankPath);
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
      // 1) 先备份现有 bank.json -> bank.json.bak（HANDOFF §8.3 / DECISIONS #14）
      try {
        if (this.#bakPath && fs.existsSync(this.#bankPath)) {
          fs.copyFileSync(this.#bankPath, this.#bakPath);
        }
      } catch (err) {
        this.#warn('bak_failed', `生成 .bak 失败（${(err && err.code) || 'error'}），继续写入`);
      }
      // 2) 写临时文件 + rename 原子替换
      const doc = { version: 1, updatedAt: Date.now(), records: this.#records };
      const tmp = `${this.#bankPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
      fs.renameSync(tmp, this.#bankPath);
      return true;
    } catch (err) {
      this.#warn('persist_failed', `落盘失败（${(err && (err.code || err.name)) || 'error'}）`);
      return false;
    }
  }

  /** @returns {{total,verified,bySource:{local,ai,import,fuzzy},l1Hits,l2Hits,l2Suspicious,noMatch}} */
  stats() {
    let verified = 0;
    const bySource = { local: 0, ai: 0, import: 0, fuzzy: 0 };
    for (const r of this.#records) {
      if (r.verified === true) verified += 1;
      if (bySource[r.source] !== undefined) bySource[r.source] += 1;
    }
    return {
      total: this.#records.length,
      verified,
      bySource,
      l1Hits: this.#counters.l1Hits,
      l2Hits: this.#counters.l2Hits,
      l2Suspicious: this.#counters.l2Suspicious,
      noMatch: this.#counters.noMatch,
    };
  }

  /** 只读数组引用（bench/tools 用）。 */
  records() {
    return this.#records;
  }
}

export default Store;