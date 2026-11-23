// test/matcher.test.js — T1 匹配器测试（纯内存生成数据，不落盘、不监听端口、无真实 sleep）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { trigrams, diceBigram, lcsRatio, scorePair, Matcher } from '../lib/matcher.js';
import { makeKey } from '../lib/normalize.js';

// ---------- 工具：可复现的合成数据（mulberry32，种子固定） ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感';

function randText(rnd, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += POOL[Math.floor(rnd() * POOL.length)];
  return s;
}

function synthRecords(count, seed) {
  const rnd = mulberry32(seed);
  const records = [];
  const seen = new Set();
  // 聚簇式合成：每个「主题模板」派生约 25 条记录（模板 + 唯一尾串），
  // 模拟真实题库同主题题干大量共享子串的形态，保证 trigram 召回有效。
  const templateCount = Math.max(1, Math.ceil(count / 25));
  const templates = [];
  while (templates.length < templateCount) {
    templates.push(randText(rnd, 18 + Math.floor(rnd() * 8))); // 18..25 字
  }
  let ti = 0;
  while (records.length < count) {
    const base = templates[ti % templates.length];
    ti += 1;
    const title = base + randText(rnd, 5); // 唯一尾串，兄弟记录间至少差 5 字
    const oc = 2 + Math.floor(rnd() * 3);
    const options = [];
    for (let j = 0; j < oc; j++) {
      options.push(String.fromCharCode(65 + j) + '.' + randText(rnd, 4 + Math.floor(rnd() * 6)));
    }
    const key = makeKey(title, options);
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({ key, title, options, answer: 'A', type: '单选题', source: 'import', verified: false, createdAt: Date.now() });
  }
  return records;
}

/** 把 s 中 pos 位置的字符换成另一个不同的池内字符 */
function mutate(s, pos, extraSeed) {
  const rnd = mulberry32(extraSeed);
  let ch = POOL[Math.floor(rnd() * POOL.length)];
  while (ch === s[pos]) ch = POOL[Math.floor(rnd() * POOL.length)];
  return s.slice(0, pos) + ch + s.slice(pos + 1);
}

// ---------- 基础打分函数 ----------
describe('trigrams', () => {
  test('常规切分', () => {
    assert.deepEqual(trigrams('abcd'), ['abc', 'bcd']);
  });
  test('长度 < 3 时补 pad 仍可用', () => {
    assert.deepEqual(trigrams('ab'), ['ab ']);
    assert.deepEqual(trigrams(''), ['   ']);
  });
});

describe('diceBigram', () => {
  test('相同串 = 1，完全不同 = 0，双空 = 1', () => {
    assert.equal(diceBigram('中国梦', '中国梦'), 1);
    assert.equal(diceBigram('abc', 'xyz'), 0);
    assert.equal(diceBigram('', ''), 1);
    assert.equal(diceBigram('a', ''), 0);
  });
  test('部分重叠落在 (0,1) 开区间', () => {
    const d = diceBigram('abcd', 'abxd');
    assert.ok(d > 0 && d < 1, `dice=${d}`);
  });
});

describe('lcsRatio', () => {
  test('相同串 = 1', () => {
    assert.equal(lcsRatio('abc', 'abc'), 1);
  });
  test('LCS 长度 / max(len)', () => {
    assert.equal(lcsRatio('abc', 'axbxc'), 3 / 5);
  });
  test('双空 = 1，单空 = 0', () => {
    assert.equal(lcsRatio('', ''), 1);
    assert.equal(lcsRatio('a', ''), 0);
  });
});

describe('scorePair', () => {
  test('score = 0.6*dice + 0.4*lcs', () => {
    const a = '中国新民主主义革命取得胜利的基本历史经验';
    const b = '中国新民主主义革命取得了胜利的基本历史经验';
    const expected = 0.6 * diceBigram(a, b) + 0.4 * lcsRatio(a, b);
    assert.ok(Math.abs(scorePair(a, b) - expected) < 1e-12);
  });
  test('相同串 = 1', () => {
    assert.equal(scorePair('abc', 'abc'), 1);
  });
});

// ---------- Matcher ----------
function rec(title, options, extra = {}) {
  return { title, options, answer: 'A', type: '单选题', source: 'import', verified: false, createdAt: Date.now(), ...extra };
}

const T_BASE = '中国新民主主义革命取得胜利的基本历史经验'; // 20 字
const T_ONE = mutate(T_BASE, 10, 7);                          // 改 1 字
const T_TWO = T_BASE.slice(0, 6) + '旧' + T_BASE.slice(7, 12) + '败' + T_BASE.slice(13); // 改 2 字

describe('Matcher L1 精确匹配', () => {
  test('完全命中返回 level L1、score 1、suspicious false', () => {
    const m = new Matcher();
    const r = rec(T_BASE, ['A.富强', 'B.振兴']);
    m.build([r]);
    const hit = m.lookup(T_BASE, 'A.富强#B.振兴');
    assert.ok(hit);
    assert.equal(hit.level, 'L1');
    assert.equal(hit.score, 1);
    assert.equal(hit.suspicious, false);
    assert.equal(hit.record, r);
  });
  test('选项乱序仍命中 L1（同 key）', () => {
    const m = new Matcher();
    m.build([rec(T_BASE, ['A.富强', 'B.振兴', 'C.和平'])]);
    const hit = m.lookup(T_BASE, ['C.和平', 'A.富强', 'B.振兴']);
    assert.ok(hit);
    assert.equal(hit.level, 'L1');
  });
  test('题号/题型前缀差异不影响 L1', () => {
    const m = new Matcher();
    m.build([rec('1.【单选题】' + T_BASE, ['A.富强', 'B.振兴'])]);
    const hit = m.lookup(T_BASE, 'A.富强#B.振兴');
    assert.ok(hit);
    assert.equal(hit.level, 'L1');
  });
  test('lookupExact 命中/未命中', () => {
    const m = new Matcher();
    const r = rec(T_BASE, ['A.富强']);
    m.build([r]);
    assert.equal(m.lookupExact(makeKey(T_BASE, 'A.富强')), r);
    assert.equal(m.lookupExact('f'.repeat(64)), undefined);
  });
  test('空库返回 null', () => {
    const m = new Matcher();
    assert.equal(m.lookup(T_BASE, ''), null);
  });
});

describe('Matcher L2 模糊匹配与阈值', () => {
  test('改一个字 score >= 0.90 命中 L2', () => {
    const m = new Matcher();
    const r = rec(T_BASE, ['A.富强', 'B.振兴']);
    m.build([r]);
    const pre = scorePair(T_ONE, T_BASE);
    assert.ok(pre >= 0.9, `前置校验：单字改动得分应 >= 0.90，实际 ${pre}`);
    const hit = m.lookup(T_ONE, 'A.富强#B.振兴');
    assert.ok(hit, '应命中 L2');
    assert.equal(hit.level, 'L2');
    assert.equal(hit.suspicious, false);
    assert.ok(hit.score >= 0.9);
    assert.equal(hit.record, r);
  });
  test('改一半落入 0.80~0.90：acceptSuspicious=false 时返回 null', () => {
    const pre = scorePair(T_TWO, T_BASE);
    assert.ok(pre >= 0.8 && pre < 0.9, `前置校验：应落在疑似区间，实际 ${pre}`);
    const m = new Matcher(); // 默认 acceptSuspicious:false
    m.build([rec(T_BASE, ['A.富强', 'B.振兴'])]);
    assert.equal(m.lookup(T_TWO, 'A.富强#B.振兴'), null);
  });
  test('acceptSuspicious=true 时疑似命中返回 suspicious:true', () => {
    const m = new Matcher({ acceptSuspicious: true });
    m.build([rec(T_BASE, ['A.富强', 'B.振兴'])]);
    const hit = m.lookup(T_TWO, 'A.富强#B.振兴');
    assert.ok(hit);
    assert.equal(hit.level, 'L2');
    assert.equal(hit.suspicious, true);
    assert.ok(hit.score >= 0.8 && hit.score < 0.9);
  });
  test('lookup opts 可覆盖 acceptSuspicious', () => {
    const m = new Matcher();
    m.build([rec(T_BASE, ['A.富强', 'B.振兴'])]);
    const hit = m.lookup(T_TWO, 'A.富强#B.振兴', { acceptSuspicious: true });
    assert.ok(hit && hit.suspicious === true);
  });
  test('得分低于 suspiciousThreshold 返回 null', () => {
    const m = new Matcher();
    m.build([rec(T_BASE, ['A.富强'])]);
    assert.equal(m.lookup('完全不相干的另一道题目内容字符串', 'A.富强'), null);
  });
});

describe('Matcher tie-break（DECISIONS #12：同题干不同选项）', () => {
  test('options key 完全相同的候选优先', () => {
    const m = new Matcher();
    // 显式 key 使 L1 不命中，强制走 L2 tie-break 路径
    const rA = rec(T_BASE, ['A.甲甲', 'B.乙乙'], { key: 'custom-key-a' });
    const rB = rec(T_BASE, ['A.丙丙', 'B.丁丁'], { key: 'custom-key-b' });
    m.build([rA, rB]); // rA 排前，若只按分数+插入序会误选 rA
    const hit = m.lookup(T_BASE, 'A.丙丙#B.丁丁');
    assert.ok(hit, '应命中');
    assert.equal(hit.record, rB, 'tie-break 必须选中 options 完全一致的 rB');
    assert.equal(hit.level, 'L2');
    assert.equal(hit.score, 1);
    assert.equal(hit.suspicious, false);
  });
});

describe('Matcher 索引行为：build/add/remove/size', () => {
  test('build 全量重建，重复 build 不残留', () => {
    const m = new Matcher();
    m.build([rec(T_BASE, 'A.1'), rec('另一道题目的题干内容', 'B.2')]);
    assert.equal(m.size, 2);
    m.build([rec('第三道题目的题干内容', 'C.3')]);
    assert.equal(m.size, 1);
    assert.equal(m.lookupExact(makeKey(T_BASE, 'A.1')), undefined);
  });
  test('add 增量插入后立即可 L1/L2 命中（回写场景）', () => {
    const m = new Matcher();
    m.build(synthRecords(10, 1));
    const r = rec(T_BASE, ['A.富强', 'B.振兴']);
    assert.equal(m.lookup(T_BASE, 'A.富强#B.振兴'), null);
    m.add(r);
    assert.equal(m.size, 11);
    const hit = m.lookup(T_BASE, 'A.富强#B.振兴');
    assert.ok(hit && hit.level === 'L1' && hit.record === r);
  });
  test('add 同 key 覆盖旧记录', () => {
    const m = new Matcher();
    const r1 = rec(T_BASE, ['A.1'], { answer: 'A' });
    const r2 = rec(T_BASE, ['A.1'], { answer: 'A', verified: true });
    m.add(r1);
    m.add(r2);
    assert.equal(m.size, 1);
    assert.equal(m.lookupExact(makeKey(T_BASE, 'A.1')), r2);
  });
  test('add 忽略无效记录', () => {
    const m = new Matcher();
    assert.equal(m.add(null), false);
    assert.equal(m.add({}), false);
    assert.equal(m.size, 0);
  });
  test('remove 后 L1 与倒排索引均失效', () => {
    const m = new Matcher();
    const r = rec(T_BASE, ['A.富强']);
    m.build([r]);
    const key = makeKey(T_BASE, 'A.富强');
    assert.equal(m.remove(key), true);
    assert.equal(m.remove(key), false);
    assert.equal(m.size, 0);
    assert.equal(m.lookupExact(key), undefined);
    assert.equal(m.lookup(T_ONE, 'A.富强'), null);
  });
  test('坏记录不炸 build', () => {
    const m = new Matcher();
    m.build([null, {}, rec(T_BASE, 'A.1'), 42]);
    assert.equal(m.size, 1);
  });
});

describe('Matcher 大库索引路径（> candidateLimit 走 trigram 裁剪）', () => {
  test('candidateLimit=50 时 300 条库仍能命中近似题', () => {
    const m = new Matcher({ candidateLimit: 50 });
    const records = synthRecords(300, 99);
    m.build(records);
    assert.equal(m.size, 300);
    const target = records[123];
    const q = mutate(target.title, 5, 11);
    const hit = m.lookup(q, target.options.join('#'));
    assert.ok(hit, '索引路径应召回');
    assert.equal(hit.record.key, target.key);
    assert.equal(hit.level, 'L2');
  });
  test('小库（<= candidateLimit）走全表打分也可命中', () => {
    const m = new Matcher({ candidateLimit: 200 });
    const records = synthRecords(30, 5);
    m.build(records);
    const target = records[7];
    const hit = m.lookup(mutate(target.title, 3, 13), target.options.join('#'));
    assert.ok(hit && hit.record.key === target.key);
  });
});

describe('Matcher 性能：5000 条合成记录，单次 lookup 平均 < 5ms', () => {
  test('200 次混合 L1/L2 lookup 平均耗时 < 5ms', () => {
    const N = 5000;
    const records = synthRecords(N, 42);
    const m = new Matcher();
    const t0 = process.hrtime.bigint();
    m.build(records);
    const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(m.size, N);
    assert.ok(buildMs < 20000, `build 应在 20s 内完成，实际 ${buildMs.toFixed(0)}ms`);

    const rnd = mulberry32(1234);
    const LOOKUPS = 200;
    let l1 = 0;
    let l2 = 0;
    const t1 = process.hrtime.bigint();
    for (let i = 0; i < LOOKUPS; i++) {
      const target = records[Math.floor(rnd() * N)];
      if (i % 2 === 0) {
        const hit = m.lookup(target.title, target.options.join('#'));
        assert.ok(hit && hit.level === 'L1', 'L1 查询必须命中');
        l1++;
      } else {
        const q = mutate(target.title, Math.floor(target.title.length / 2), 1000 + i);
        const hit = m.lookup(q, target.options.join('#'));
        if (hit) l2++;
      }
    }
    const totalMs = Number(process.hrtime.bigint() - t1) / 1e6;
    const avgMs = totalMs / LOOKUPS;
    assert.equal(l1, 100);
    assert.ok(l2 >= 80, `单字改动的 L2 查询召回率过低：${l2}/100`);
    assert.ok(avgMs < 5, `平均单次 lookup ${avgMs.toFixed(3)}ms，应 < 5ms`);
  });
});
