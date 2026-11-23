// test/normalize.test.js — T1 归一化模块测试（纯内存，不落盘、不监听端口）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalize,
  splitOptions,
  normalizeOptions,
  makeKey,
  normalizeType,
  toLabel,
  isUnanswerable,
  PUNCT_RE,
} from '../lib/normalize.js';

describe('normalize 步骤1：NFKC + 全角转半角', () => {
  test('全角字母数字转半角并小写', () => {
    assert.equal(normalize('ＡＢＣ１２３'), 'abc123');
  });
  test('全角空格 U+3000 被清除', () => {
    assert.equal(normalize('中国\u3000梦'), '中国梦');
  });
  test('大小写统一为小写', () => {
    assert.equal(normalize('Marxism LENINISM'), 'marxismleninism');
  });
});

describe('normalize 步骤2：空白/换行/制表符', () => {
  test('空格、tab、换行、\\r、NBSP、零宽字符全部删除', () => {
    assert.equal(normalize(' a b\tc\nd\re\u00a0f\u200bg '), 'abcdefg');
  });
});

describe('normalize 步骤3：题号前缀剥离', () => {
  const cases = [
    ['1.什么是中国梦', '什么是中国梦'],
    ['12、什么是中国梦', '什么是中国梦'],
    ['(3)什么是中国梦', '什么是中国梦'],
    ['（4）什么是中国梦', '什么是中国梦'],
    ['一、什么是中国梦', '什么是中国梦'],
    ['第5题：什么是中国梦', '什么是中国梦'],
    ['第 12 题 什么是中国梦', '什么是中国梦'],
    ['1．什么是中国梦', '什么是中国梦'],
    ['十、什么是中国梦', '什么是中国梦'],
  ];
  for (const [input, expected] of cases) {
    test(`剥离 ${JSON.stringify(input.slice(0, 6))}`, () => {
      assert.equal(normalize(input), expected);
    });
  }
  test('循环剥离最多 3 次', () => {
    assert.equal(normalize('1.2.(3)内容'), '内容');
  });
  test('非题号数字不误删（1949年开头）', () => {
    assert.equal(normalize('1949年发生了什么'), '1949年发生了什么');
  });
});

describe('normalize 步骤4：题型标记剥离', () => {
  const cases = [
    ['【单选题】内容是什么', '内容是什么'],
    ['[多选题]内容是什么', '内容是什么'],
    ['单选题：内容是什么', '内容是什么'],
    ['判断题:内容是什么', '内容是什么'],
    ['（填空题）内容是什么', '内容是什么'],
    ['简答题: 内容是什么', '内容是什么'],
  ];
  for (const [input, expected] of cases.slice(0, 6)) {
    test(`剥离 ${JSON.stringify(input.slice(0, 6))}`, () => {
      assert.equal(normalize(input), expected);
    });
  }
  test('题号 + 题型标记混合顺序均可剥离', () => {
    assert.equal(normalize('1.【单选题】内容是什么'), '内容是什么');
    assert.equal(normalize('【单选题】2.内容是什么'), '内容是什么');
  });
});

describe('normalize 步骤5-7：小写、去标点、保留字', () => {
  test('中英文标点删除', () => {
    assert.equal(normalize('你好，世界！“引号”（括号）《书名》【方括】…—·'), '你好世界引号括号书名方括');
    assert.equal(normalize('a,b.c!?;:\'"()<>[]{}'), 'abc');
  });
  test('半角符号 -_*/\\|~@%^&+= 与 $ 删除', () => {
    assert.equal(normalize('a-b_c*d/e\\f|g~h@i%j^k&l+=m$n'), 'abcdefghijklmn');
  });
  test('# 必须保留（选项分隔符）', () => {
    assert.equal(normalize('A.富强#B.振兴'), 'a富强#b振兴');
  });
  test('汉字、字母、数字保留', () => {
    assert.equal(normalize('中国梦2020ABC'), '中国梦2020abc');
  });
  test('null/undefined/数字入参不抛错', () => {
    assert.equal(normalize(null), '');
    assert.equal(normalize(undefined), '');
    assert.equal(normalize(123), '123');
  });
  test('PUNCT_RE 是 RegExp 且不含 #', () => {
    assert.ok(PUNCT_RE instanceof RegExp);
    assert.ok(!'#'.match(PUNCT_RE));
    assert.ok('，'.match(PUNCT_RE));
  });
});

describe('splitOptions 五级切分优先级', () => {
  test('1) 含 # 按 # 切', () => {
    assert.deepEqual(splitOptions('A.富强#B.振兴#C.和平'), ['A.富强', 'B.振兴', 'C.和平']);
  });
  test('2) 无 # 含换行按换行切（\\n 与 \\r\\n）', () => {
    assert.deepEqual(splitOptions('A.富强\nB.振兴'), ['A.富强', 'B.振兴']);
    assert.deepEqual(splitOptions('A.富强\r\nB.振兴\r\nC.和平'), ['A.富强', 'B.振兴', 'C.和平']);
  });
  test('3) 无换行含 ; 或 ； 按其切', () => {
    assert.deepEqual(splitOptions('富强;振兴；和平'), ['富强', '振兴', '和平']);
  });
  test('4) A. 标号模式整段切分且保留字母', () => {
    assert.deepEqual(splitOptions('A.富强 B.振兴 C.和平 D.发展'), ['A.富强', 'B.振兴', 'C.和平', 'D.发展']);
    assert.deepEqual(splitOptions('A、富强B、振兴'), ['A、富强', 'B、振兴']);
  });
  test('5) 都不满足 → 整体一项', () => {
    assert.deepEqual(splitOptions('富强'), ['富强']);
  });
  test('每项 trim 并丢弃空串', () => {
    assert.deepEqual(splitOptions(' A.富强 ## B.振兴 '), ['A.富强', 'B.振兴']);
    assert.deepEqual(splitOptions('   '), []);
    assert.deepEqual(splitOptions(''), []);
    assert.deepEqual(splitOptions(null), []);
    assert.deepEqual(splitOptions(undefined), []);
  });
  test('入参为数组时逐项 trim', () => {
    assert.deepEqual(splitOptions([' A.富强 ', '', 'B.振兴']), ['A.富强', 'B.振兴']);
  });
});

describe('normalizeOptions', () => {
  test('切分 + normalize + 去选项内 # + 去空项', () => {
    assert.deepEqual(normalizeOptions('A.富强#B.振兴#'), ['a富强', 'b振兴']);
  });
  test('全角/大小写归一', () => {
    assert.deepEqual(normalizeOptions('Ａ.富强\nＢ.振兴'), ['a富强', 'b振兴']);
  });
});

describe('makeKey', () => {
  test('返回 64 位 sha256 hex', () => {
    const k = makeKey('什么是中国梦', 'A.富强#B.振兴');
    assert.match(k, /^[0-9a-f]{64}$/);
  });
  test('选项乱序同题 → 相同 key', () => {
    const k1 = makeKey('中国梦的本质内涵是什么', 'A.富强#B.振兴#C.和平');
    const k2 = makeKey('中国梦的本质内涵是什么', 'C.和平#A.富强#B.振兴');
    const k3 = makeKey('中国梦的本质内涵是什么', 'B.振兴#C.和平#A.富强');
    assert.equal(k1, k2);
    assert.equal(k2, k3);
  });
  test('选项文本相同但顺序不同（含题号前缀差异）也算同题', () => {
    const k1 = makeKey('1.题干内容', ['A.富强', 'B.振兴']);
    const k2 = makeKey('【单选题】题干内容', 'B.振兴#A.富强');
    assert.equal(k1, k2);
  });
  test('题干不同 → key 不同', () => {
    assert.notEqual(makeKey('题干甲', 'A.1#B.2'), makeKey('题干乙', 'A.1#B.2'));
  });
  test('string 与 string[] 入参等价', () => {
    assert.equal(makeKey('t', 'A.富强#B.振兴'), makeKey('t', ['A.富强', 'B.振兴']));
  });
  test('无选项时 key 稳定', () => {
    assert.equal(makeKey('问答题干', ''), makeKey('问答题干', []));
  });
});

describe('normalizeType 映射表', () => {
  const cases = [
    ['多选题', '多选'], ['single choice', '单选'], ['radio', '单选'],
    ['checkbox', '多选'], ['multiple', '多选'], ['判断题', '判断'],
    ['TRUE', '判断'], ['judge', '判断'], ['填空题', '填空'],
    ['completion', '填空'], ['fill in', '填空'], ['问答题', '问答'],
    ['essay', '问答'], ['qa', '问答'], ['简答题', '问答'], ['论述题', '问答'],
    ['不定项选择题', '多选'], ['不定项', '多选'], // T6/P0-2①
  ];
  for (const [raw, expected] of cases) {
    test(`${JSON.stringify(raw)} → ${expected}`, () => {
      assert.equal(normalizeType(raw, { optionCount: 0, title: '', options: [] }), expected);
    });
  }
});

describe('normalizeType 推断链', () => {
  test('2 个选项且为「正确/错误」→ 判断', () => {
    assert.equal(normalizeType('', { optionCount: 2, options: ['A.正确', 'B.错误'] }), '判断');
    assert.equal(normalizeType('', { optionCount: 2, options: ['对', '错'] }), '判断');
    assert.equal(normalizeType('', { optionCount: 2, options: ['√', '×'] }), '判断');
    assert.equal(normalizeType(undefined, { optionCount: 2, options: ['T', 'F'] }), '判断');
  });
  test('2 个普通选项不误判为判断', () => {
    assert.equal(normalizeType('', { optionCount: 2, options: ['A.富强', 'B.振兴'] }), '单选');
  });
  test('题干含连续空位且有选项 → 填空', () => {
    assert.equal(normalizeType('', { optionCount: 3, options: ['甲', '乙', '丙'], title: '坚持____原则' }), '填空');
    assert.equal(normalizeType('', { optionCount: 3, options: ['甲', '乙', '丙'], title: '在（ ）里填入' }), '填空');
  });
  test('无选项 → 问答', () => {
    assert.equal(normalizeType('', { optionCount: 0, options: [] }), '问答');
    assert.equal(normalizeType(''), '问答');
    assert.equal(normalizeType(null, {}), '问答');
  });
  test('有选项且无其他特征 → 单选', () => {
    assert.equal(normalizeType('未知题型xx', { optionCount: 4, options: ['a', 'b', 'c', 'd'], title: '普通题干' }), '单选');
  });
  test('ctx.options 传原始 # 串也可推断', () => {
    assert.equal(normalizeType('', { options: 'A.正确#B.错误' }), '判断');
  });
  test('T6/P0-2① 规则 0：ctx.answer 为多字母形态且 >=2 选项 → 多选（置于推断链最前）', () => {
    assert.equal(normalizeType('', { optionCount: 4, options: ['A.a', 'B.b', 'C.c', 'D.d'], answer: 'A#C' }), '多选');
    assert.equal(normalizeType('', { optionCount: 4, options: ['A.a', 'B.b', 'C.c', 'D.d'], answer: 'AC' }), '多选');
    assert.equal(normalizeType('', { optionCount: 4, options: ['A.a', 'B.b', 'C.c', 'D.d'], answer: 'A、C' }), '多选');
    // 单字母不触发规则 0（不定项可能只有 1 个正确项，交给后续规则）
    assert.equal(normalizeType('', { optionCount: 4, options: ['A.a', 'B.b', 'C.c', 'D.d'], answer: 'A' }), '单选');
    // 判断题不因 answer='A' 被抢答成多选
    assert.equal(normalizeType('', { optionCount: 2, options: ['A.正确', 'B.错误'], answer: 'A' }), '判断');
    // 显式 type 关键字优先于规则 0（normalizeType 先查映射表）
    assert.equal(normalizeType('单选题', { optionCount: 4, options: ['A.a', 'B.b', 'C.c', 'D.d'], answer: 'A#C' }), '单选');
    // server 在线侧不传 answer → 保持原推断
    assert.equal(normalizeType('', { optionCount: 4, options: ['A.a', 'B.b', 'C.c', 'D.d'] }), '单选');
    // 无选项时 answer 多字母也不判多选（问答）
    assert.equal(normalizeType('', { optionCount: 0, options: [], answer: 'A#C' }), '问答');
  });
});

describe('toLabel', () => {
  test('五种题型映射', () => {
    assert.equal(toLabel('单选'), '单选题');
    assert.equal(toLabel('多选'), '多选题');
    assert.equal(toLabel('判断'), '判断题');
    assert.equal(toLabel('填空'), '填空题');
    assert.equal(toLabel('问答'), '问答题');
  });
  test('已是标签形态原样返回；未知/非字符串保守返回问答题', () => {
    assert.equal(toLabel('多选题'), '多选题');
    assert.equal(toLabel('不存在'), '问答题');
    assert.equal(toLabel(undefined), '问答题');
  });
  test('T6/P0-2① 别名兜底：不定项/多项 → 多选题', () => {
    assert.equal(toLabel('不定项'), '多选题');
    assert.equal(toLabel('不定项选择题'), '多选题');
    assert.equal(toLabel('多项'), '多选题');
    assert.equal(toLabel(' 多选 '), '多选题');
  });
});

describe('isUnanswerable（HANDOFF §7.6 短路）', () => {
  test('图片标记命中（纯图片题干，Patch 7 清洗后仍 fail-closed）', () => {
    assert.equal(isUnanswerable('![img](x)'), true);
    assert.equal(isUnanswerable('a.jpg'), true);
    assert.equal(isUnanswerable('a.jpeg'), true);
    assert.equal(isUnanswerable('a.gif'), true);
    assert.equal(isUnanswerable('a.webp'), true);
    assert.equal(isUnanswerable('<img src="x">'), true);
  });
  test('Patch 7: 文字+图片杂质混合题干清洗后不短路（送 AI，规则 7 兜底）', () => {
    assert.equal(isUnanswerable('请看下图 ![img](x)'), false);
    assert.equal(isUnanswerable('文件 https://x.com/example.png 是什么'), false);
    assert.equal(isUnanswerable('文件 example.png 是什么'), true); // 裸文件名非占位白名单，保守短路保留
  });
  test('LaTeX 命中', () => {
    assert.equal(isUnanswerable('求 $\\frac{1}{2}$ 的值'), true);
    assert.equal(isUnanswerable('\\begin{array}{c}x\\end{array}'), true);
    assert.equal(isUnanswerable('计算 \\sqrt{2} 结果'), true);
    assert.equal(isUnanswerable('\\sum_{i=1}^{n} i 等于'), true);
    assert.equal(isUnanswerable('成对美元符 $x$ 也算'), true);
  });
  test('归一化后长度 < 4 命中', () => {
    assert.equal(isUnanswerable('abc'), true);
    assert.equal(isUnanswerable('1.短'), true);
    assert.equal(isUnanswerable(''), true);
    assert.equal(isUnanswerable(null), true);
  });
  test('正常题目不命中', () => {
    assert.equal(isUnanswerable('中国梦的本质内涵是什么'), false);
    assert.equal(isUnanswerable('单个美元 a$b 但长度够'), false);
  });
});
