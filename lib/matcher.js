// lib/matcher.js — L1/L2 匹配与 trigram 索引（Owner: T1）
// 契约依据：docs/CONTRACT.md §2；docs/DECISIONS.md #12；HANDOFF §6
// 纪律：纯计算模块，无 I/O、不 import fs/http、不 import config（配置走构造函数入参）。

import { makeKey, normalize } from './normalize.js';

const MATCH_DEFAULTS = Object.freeze({
  fuzzyThreshold: 0.9,
  suspiciousThreshold: 0.8,
  acceptSuspicious: false,
  candidateLimit: 200,
});

function toFloat01(v, fallback) {
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function toIntPos(v, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

/**
 * trigram 切分。长度 < 3 时用空格 pad 到 3，保证仍产出可用 gram（CONTRACT §2）。
 * @param {unknown} s
 * @returns {string[]}
 */
export function trigrams(s) {
  const str = s === null || s === undefined ? '' : String(s);
  const padded = str.length < 3 ? str + ' '.repeat(3 - str.length) : str;
  const out = [];
  for (let i = 0; i + 3 <= padded.length; i++) out.push(padded.slice(i, i + 3));
  return out;
}

function bigramCounts(s) {
  const m = new Map();
  if (s.length === 0) return m;
  if (s.length === 1) {
    m.set(s, 1);
    return m;
  }
  for (let i = 0; i + 2 <= s.length; i++) {
    const bg = s.slice(i, i + 2);
    m.set(bg, (m.get(bg) || 0) + 1);
  }
  return m;
}

/** Sørensen–Dice 二元组系数，0..1（多重集交集，取 min 计数）。 */
export function diceBigram(a, b) {
  const A = a === null || a === undefined ? '' : String(a);
  const B = b === null || b === undefined ? '' : String(b);
  if (A.length === 0 && B.length === 0) return 1;
  if (A.length === 0 || B.length === 0) return 0;
  const ca = bigramCounts(A);
  const cb = bigramCounts(B);
  let sa = 0;
  let sb = 0;
  for (const v of ca.values()) sa += v;
  for (const v of cb.values()) sb += v;
  let inter = 0;
  for (const [k, v] of ca) {
    const w = cb.get(k);
    if (w) inter += Math.min(v, w);
  }
  return (2 * inter) / (sa + sb);
}

/** LCS 长度 / max(len)，0..1。双行 DP，O(n*m) 时间 O(m) 空间。 */
export function lcsRatio(a, b) {
  const A = a === null || a === undefined ? '' : String(a);
  const B = b === null || b === undefined ? '' : String(b);
  const la = A.length;
  const lb = B.length;
  if (la === 0 && lb === 0) return 1;
  if (la === 0 || lb === 0) return 0;
  // 让短串做列，减少内存
  const [S, L] = la <= lb ? [A, B] : [B, A];
  const ls = S.length;
  const ll = L.length;
  let prev = new Uint32Array(ls + 1);
  let cur = new Uint32Array(ls + 1);
  for (let i = 1; i <= ll; i++) {
    const ch = L.charCodeAt(i - 1);
    for (let j = 1; j <= ls; j++) {
      cur[j] = ch === S.charCodeAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev;
    prev = cur;
    cur = t;
    cur.fill(0);
  }
  return prev[ls] / Math.max(la, lb);
}

/** 综合得分（HANDOFF §6）：0.6 * Dice(bigram) + 0.4 * LCS_ratio。 */
export function scorePair(a, b) {
  return 0.6 * diceBigram(a, b) + 0.4 * lcsRatio(a, b);
}

/**
 * L1（key 精确）+ L2（trigram 倒排 + 长度分桶裁剪 + 打分）匹配器。
 * 索引条目惰性删除（alive 标记），remove 后倒排集合同步清理。
 */
export class Matcher {
  /** @param {{fuzzyThreshold?:number,suspiciousThreshold?:number,acceptSuspicious?:boolean,candidateLimit?:number}} [matchConfig] */
  constructor(matchConfig = {}) {
    const c = matchConfig && typeof matchConfig === 'object' ? matchConfig : {};
    this.fuzzyThreshold = toFloat01(c.fuzzyThreshold, MATCH_DEFAULTS.fuzzyThreshold);
    this.suspiciousThreshold = toFloat01(c.suspiciousThreshold, MATCH_DEFAULTS.suspiciousThreshold);
    this.acceptSuspicious =
      typeof c.acceptSuspicious === 'boolean' ? c.acceptSuspicious : MATCH_DEFAULTS.acceptSuspicious;
    this.candidateLimit = toIntPos(c.candidateLimit, MATCH_DEFAULTS.candidateLimit);
    if (this.suspiciousThreshold > this.fuzzyThreshold) {
      // 与 config.js 同款保护：阈值倒挂自动对调
      const t = this.suspiciousThreshold;
      this.suspiciousThreshold = this.fuzzyThreshold;
      this.fuzzyThreshold = t;
    }
    this._entries = [];           // 全部条目（含已删除的墓碑）
    this._byKey = new Map();      // key -> entry（L1）
    this._tri = new Map();        // trigram -> Set<entryIdx>（L2 倒排）
  }

  get size() {
    return this._byKey.size;
  }

  /** 全量重建。单条坏记录跳过，不影响其余（CONTRACT §11.7 防御性）。 */
  build(records) {
    this._entries = [];
    this._byKey = new Map();
    this._tri = new Map();
    if (!Array.isArray(records)) return this;
    for (const r of records) {
      try {
        this.add(r);
      } catch {
        // 跳过坏记录，索引保持可用
      }
    }
    return this;
  }

  /**
   * 增量插入（回写场景用）。同 key 已存在时先 remove 再插入（后写覆盖）。
   * record 至少需要 { title, options }；record.key 缺省时用 makeKey 计算。
   */
  add(record) {
    if (!record || typeof record !== 'object') return false;
    if (record.title === null || record.title === undefined) return false;
    const title = String(record.title);
    const mkey = makeKey(title, record.options);
    const key = typeof record.key === 'string' && record.key !== '' ? record.key : mkey;
    if (this._byKey.has(key)) this.remove(key);
    const ntitle = normalize(title);
    const entry = {
      idx: this._entries.length,
      record,
      key,
      mkey,
      ntitle,
      nlen: ntitle.length,
      tris: [...new Set(trigrams(ntitle))],
      alive: true,
    };
    this._entries.push(entry);
    this._byKey.set(key, entry);
    for (const t of entry.tris) {
      let set = this._tri.get(t);
      if (!set) {
        set = new Set();
        this._tri.set(t, set);
      }
      set.add(entry.idx);
    }
    return true;
  }

  /** 按 key 删除。返回是否删掉了条目。 */
  remove(key) {
    const entry = this._byKey.get(key);
    if (!entry) return false;
    entry.alive = false;
    this._byKey.delete(key);
    for (const t of entry.tris) {
      const set = this._tri.get(t);
      if (set) {
        set.delete(entry.idx);
        if (set.size === 0) this._tri.delete(t);
      }
    }
    return true;
  }

  /** L1 精确查找。 */
  lookupExact(key) {
    const entry = this._byKey.get(key);
    return entry && entry.alive ? entry.record : undefined;
  }

  /**
   * 候选裁剪：记录数 <= candidateLimit 时全表；否则长度容差(±30%)过滤 +
   * trigram 倒排交集计数取 Top-N；候选 < 5 时退回全表（CONTRACT §2）。
   */
  _candidates(nt, limit) {
    const alive = () => this._entries.filter((e) => e.alive);
    if (this._byKey.size <= limit) return alive();
    const qtris = new Set(trigrams(nt));
    const tol = Math.max(2, Math.ceil(nt.length * 0.3));
    const counts = new Map();
    for (const t of qtris) {
      const set = this._tri.get(t);
      if (!set) continue;
      for (const idx of set) {
        const e = this._entries[idx];
        if (!e.alive) continue;
        if (Math.abs(e.nlen - nt.length) > tol) continue;
        counts.set(idx, (counts.get(idx) || 0) + 1);
      }
    }
    if (counts.size < 5) return alive();
    const idxs = [...counts.keys()];
    idxs.sort((a, b) => counts.get(b) - counts.get(a) || a - b);
    return idxs.slice(0, limit).map((i) => this._entries[i]);
  }

  /**
   * 先 L1（makeKey 精确），未命中走 L2。
   * @param {unknown} title 原始题干
   * @param {unknown} options 原始选项（string 或 string[]）
   * @param {{acceptSuspicious?:boolean,fuzzyThreshold?:number,suspiciousThreshold?:number,candidateLimit?:number}} [opts]
   * @returns {{record:object, score:number, level:'L1'|'L2', suspicious:boolean}|null}
   */
  lookup(title, options, opts = {}) {
    try {
      const o = opts && typeof opts === 'object' ? opts : {};
      const fuzzyThreshold = toFloat01(o.fuzzyThreshold, this.fuzzyThreshold);
      const suspiciousThreshold = toFloat01(o.suspiciousThreshold, this.suspiciousThreshold);
      const acceptSuspicious =
        typeof o.acceptSuspicious === 'boolean' ? o.acceptSuspicious : this.acceptSuspicious;
      const candidateLimit = toIntPos(o.candidateLimit, this.candidateLimit);

      const key = makeKey(title, options);
      const exact = this._byKey.get(key);
      if (exact && exact.alive) {
        return { record: exact.record, score: 1, level: 'L1', suspicious: false };
      }

      const nt = normalize(title);
      if (!nt || this._byKey.size === 0) return null;

      const candidates = this._candidates(nt, candidateLimit);
      let tie = null;                 // DECISIONS #12：options key 完全相同者优先
      let best = null;                // score >= fuzzyThreshold 的最高分
      let bestSusp = null;            // suspiciousThreshold <= score < fuzzyThreshold 的最高分
      for (const e of candidates) {
        const score = scorePair(e.ntitle, nt);
        if (score < suspiciousThreshold) continue;
        if (e.mkey === key || e.key === key) {
          tie = e;
          break; // 满分 tie-break，无需再看其余候选
        }
        if (score >= fuzzyThreshold) {
          if (!best || score > best.score) best = { entry: e, score };
        } else if (!bestSusp || score > bestSusp.score) {
          bestSusp = { entry: e, score };
        }
      }
      if (tie) {
        return { record: tie.record, score: 1, level: 'L2', suspicious: false };
      }
      if (best) {
        return { record: best.entry.record, score: best.score, level: 'L2', suspicious: false };
      }
      if (acceptSuspicious && bestSusp) {
        return { record: bestSusp.entry.record, score: bestSusp.score, level: 'L2', suspicious: true };
      }
      return null; // acceptSuspicious=false 时疑似命中一律丢弃
    } catch {
      return null; // 匹配失败视为未命中，绝不向上抛（CONTRACT §11.7）
    }
  }
}

export default Matcher;