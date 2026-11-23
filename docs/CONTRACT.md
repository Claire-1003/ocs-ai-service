# qbank 共享契约 v1.1（T6 集成裁决版）

> 本文件是并行开发的唯一接口依据。`HANDOFF.md` 定义对外协议，本文件定义**模块内部接口**。
> 冲突时：对外协议以 HANDOFF.md §4/§5/§7 为准；模块签名以本文件为准。
> 已采纳的 14 条规格补全见 `docs/DECISIONS.md`。
>
> **v1.1 变更说明（T6，依据 docs/PROMPT_T6.md 的裁决授权）**：T1~T5 交付报告中提出的
> P0-1~P0-8 / P1-1~P1-13 / P2 全部歧义已由 T6 统一裁决，裁决记录与落地动作见
> `docs/ACCEPTANCE.md`「裁决记录」。本版本把已批准的实现细节**追认进契约正文**，
> 不改变任何模块的既有行为；涉及对外协议的两处（/health 的 ai 字段、bad_request 枚举）
> 已整理成 HANDOFF 补丁，见 ACCEPTANCE「契约增补」；2026-11-19 经用户批准写回 HANDOFF §4.1/§4.2。

## 0. 全局硬性约定

- 语言：**ESM**（`import`/`export`），Node >= 18，实测环境 v24。
- **零第三方依赖**。只允许 `node:http` `node:fs` `node:fs/promises` `node:path` `node:crypto` `node:url` `node:os` `node:test` `node:assert` 与全局 `fetch`/`AbortController`。
- `package.json` **不得出现 `dependencies` / `devDependencies` 字段**。
- 测试框架：内置 `node:test` + `node:assert/strict`，统一 `node --test`（自动发现；T6 实测：Node 24 下
  `node --test test/` 目录参数会报 MODULE_NOT_FOUND，故改用无参发现或显式文件列表）。文件名 `test/*.test.js`。
- 内部错误约定（替代共享 errors 模块，避免文件争用）：
  任何模块抛出的错误必须是 `Error` 实例并带 `err.code`，取值**只能**是
  `no_match` / `ai_timeout` / `ai_moderation` / `ai_error` / `queue_full` / `image_or_formula` / `ai_disabled` / `invalid_output` / `bad_request`。
  `invalid_output` 与 `bad_request` 为内部码，对外由 server 映射（见 §8）。
- **日志纪律**：任何日志/stderr 只允许出现 key（sha256 前 12 位即可）、错误码、计数、耗时。
  **禁止**出现题干、选项、答案原文。
- 所有异步函数必须自带 try/catch 边界，不得让 rejection 冒泡到 `process`。
- 时间戳统一 `Date.now()`（毫秒整数）。**唯一豁免（P1-2，T6 批准）**：`tools/genbank.js`
  的 `updatedAt` / `createdAt` 使用固定基准常量 `1700000000000`，否则「同 seed 逐字节可复现」不成立。
- **CLI 退出码约定（P1-11，T6 批准）**：`tools/*.js` 统一 `0` = 成功/达标，`1` = 失败/未达标，
  `2` = 无法执行（缺文件、缺 Key、provider 探活失败、参数错误等环境原因）。
  退出码 2 **不计作 FAIL**，验收时记 BLOCKED(env)。

## 1. lib/normalize.js  （Owner: T1，纯函数，无 I/O）

```js
export function normalize(s)                  // -> string
export function splitOptions(raw)             // -> string[]  仅切分，不归一化
export function normalizeOptions(raw)         // -> string[]  切分 + 每项 normalize + 去空项
export function makeKey(title, options)       // -> string (sha256 hex, 64 chars)
export function normalizeType(raw, ctx)       // -> '单选'|'多选'|'判断'|'填空'|'问答'
export function toLabel(type)                 // -> '单选题'|'多选题'|'判断题'|'填空题'|'问答题'
export function isUnanswerable(title, options)// -> boolean   (HANDOFF §7.6)
export const PUNCT_RE                          // RegExp，标点集合
```

### 1.1 normalize 管线顺序（已修正 HANDOFF §5 的顺序矛盾，见 DECISIONS #2）

1. `String(s).normalize('NFKC')` + 全角字符转半角（U+FF01..U+FF5E → 减 0xFEE0；U+3000 → 空格）
2. 删除所有空白：`/[\s\u3000\u00a0\u200b\ufeff]+/g`
3. 去题号前缀（循环剥离，最多 3 次）：`^\d{1,3}[.、)）]`、`^[(（]\d{1,3}[)）]`、`^[一二三四五六七八九十]{1,3}[、.．]`、`^第\s*\d{1,3}\s*题[：:.、]?`
4. 去题型标记：`^[【\[(（]\s*(单选题?|多选题?|判断题?|填空题?|问答题?|简答题?|不定项选择题?)\s*[】\])）]` 以及 `^(单选题|多选题|判断题|填空题|问答题|简答题)\s*[：:]`
5. 英文统一小写 `toLowerCase()`
6. 删除标点：`，。、；：？！“”‘’（）《》【】…—·,.!?;:'"()<>[]{}` 以及 `-_*/\\|~@#$%^&+=` 之外的**保留字符不删**（`#` 必须在 `normalizeOptions` 之前已被用作分隔符，故 `normalize` 内**不删 `#`**；`makeKey` 自行处理）
   - 明确保留：汉字、字母、数字、`#`
7. 结果不做 trim（空白已在第 2 步清除）

> 注意：`normalize` 对**单条选项文本**调用时不得保留 `#`（选项内不应有 `#`）；
> 实现方式：`normalize(s)` 保留 `#`，`normalizeOptions` 先 `splitOptions` 再对每段调用 `normalize` 后 `replace(/#/g,'')`。

### 1.2 splitOptions 切分优先级

1. 若含 `#` → 按 `#` 切
2. 否则若含换行/`\r` → 按换行切
3. 否则若含 `;` 或 `；` → 按其切
4. 否则若能匹配 `[A-H][.、)）:：]` 标号模式 → 用 **lookahead** `/(?=[A-H][.、)）:：])/` 切分，
   **保留字母标号**（P0-1，T6 裁决：直接 split 会吃掉 `A.`/`B.` 首字母，导致 normalizeOptions
   丢字母、makeKey 与 OCS 侧不一致；lookahead 切分后首段若为空串由「丢弃空串」规则自然处理）
5. 否则 → `[raw]`
切分后每项 `trim`，丢弃空串。

### 1.3 makeKey

```js
const t = normalize(stripOptionJunk(title)); // D3/Patch 7：题干预清洗
const o = normalizeOptions(options).map(x => x.replace(/#/g, '')).sort().join('#');
return sha256Hex(t + '||' + o);
```
`options` 入参可为 `string`（原始 `#` 拼接串）或 `string[]`。

> **D3/Patch 4（2026-11-22 用户批准）**：`normalizeOptions` 每项先经 `stripOptionJunk`（剥 markdown 图片 / `<img>` /
> 图片资源 URL / 常见裸占位文件名；非图片 URL 与普通文本不动；幂等、永不抛）再 normalize；key 公式不变。
> 新增导出 `stripOptionJunk(s)`（纯函数）。空库期零迁移；历史 bank 旧 key 退化为 L2 题干相似命中，不丢失。

> **D3/Patch 7（2026-11-22 用户批准）**：`makeKey` 的 title 先经 `stripOptionJunk` 再 normalize（与选项同口径）；
> 幂等、干净题干零迁移。server 侧 match/AI/回写/响应 question 统一用清洗后题干。

### 1.4 normalizeType(raw, ctx) 映射（DECISIONS #3）

`ctx = { optionCount: number, title: string, options: string[]|string, answer?: string }`

> **P0-2①（T6 裁决）**：`ctx.answer` 为原始答案文本，**仅导入侧（tools/import.js）提供**；
> server 在线侧无标准答案，不传 `answer`，推断规则 0 自然不生效。

> **D3/Patch 6（2026-11-22 用户批准）选项性质 override，优先于下表标签关键词**：
> `optionCount === 2` 且选项恰 2 项、剥 `A.` 类前缀后皆命中 `正确|错误|对|错|是|否|√|×|T|F|true|false`
> （大小写不敏感，**排除裸 A/B**）→ 强制 `判断`，即使 `raw` 含 `单选`/`多选` 等标签。
> 动机：超星把 √/× 判断题标成【单选题】，OCS 单选匹配器见判断性质选项改走判断匹配
> （core/worker/resolvers：isJudgementOptions→resolveJudgement），只认语义词不认字母。
> override 不命中时下表与推断链行为零变化。

| 输入（normalize 后小写比较） | 输出 |
|---|---|
| 含 `多选`/`不定项`/`multiple`/`multi`/`checkbox` | `多选` |
| 含 `判断`/`对错`/`true`/`false`/`judge` | `判断` |
| 含 `填空`/`completion`/`fill` | `填空` |
| 含 `问答`/`简答`/`论述`/`essay`/`qa` | `问答` |
| 含 `单选`/`single`/`radio` | `单选` |
| 空 / 未识别 | 走推断（见下） |

推断顺序（`raw` 为空或未识别时）：
0. **（P0-2①，T6 新增）**`optionCount >= 2` 且 `ctx.answer` 命中多字母形态
   `/^[A-Ha-h](?:[\s#,，、;；|/.．)）(（]*[A-Ha-h])+$/`（如 `ACD`、`A、C`、`A,C,D`）→ `多选`。
   不定项可能只有 1 个正确项，单字母不在此判，落到后续规则。
1. `optionCount === 2` 且选项文本命中 `正确|错误|对|错|是|否|√|×|T|F|A|B` → `判断`
2. `optionCount >= 2` 且题干含 `___`/`（ ）`/`( )` 连续空位 → `填空`
3. `optionCount === 0` → `问答`
4. `optionCount >= 2` → `单选`（server 侧若 AI 返回多字母则按 `多选` 校验，见 §5）
5. `optionCount === 1`：契约未定义，保守归 `问答`（T1 报告歧义，T6 批准）

**toLabel 别名表（P0-2①，T6 批准）**：入参先 trim；除规范短题型与中文标签外，另接受
`不定项` / `不定项选择题` / `不定项选择` / `多项` / `多项选择题` → `多选题`，
`单项` / `单项选择题` → `单选题`；未知输入保守返回 `问答题`。

### 1.5 isUnanswerable（§7.6）

剥图片占位杂质后（`stripOptionJunk`，D3/Patch 7）的 `title`（**未归一化**）命中任一即 true：`![`、`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`<img`、`\frac`、`\begin{`、`\sqrt`、`\sum`；
或成对 `$`（`$` 出现次数 >= 2）；或 `normalize(title).length < 4`。

> **D3/Patch 4（2026-11-22 用户批准）**：激活保留 `options` 入参（string 或 string[]）：任一选项为「纯图片占位」
> （`stripOptionJunk` 剥除杂质后去掉 `[A-H][.、)）:：]` 标号再 normalize 为空）→ true；「文字+杂质」混合选项不触发。
> options 缺省时只看题干（旧行为）。

> **D3/Patch 7（2026-11-22 用户批准）**：题干先经 `stripOptionJunk` 再判标记；「文字+杂质」混合题干不短路
> （送 AI，规则 7 兜底）；纯图片题干清洗后为空仍经 `normalize(title).length < 4` fail-closed。

## 2. lib/matcher.js  （Owner: T1，纯计算，无 I/O，不 import store）

```js
export function trigrams(s)                 // -> string[]  长度<3 时补 pad 使可用
export function diceBigram(a, b)            // -> number 0..1
export function lcsRatio(a, b)              // -> number 0..1  (LCS长度 / max(len))
export function scorePair(a, b)             // -> 0.6*diceBigram + 0.4*lcsRatio
export class Matcher {
  constructor(matchConfig)                  // {fuzzyThreshold,suspiciousThreshold,acceptSuspicious,candidateLimit}
  build(records)                            // records: 题库记录数组，重建全部索引
  add(record)                               // 增量插入（回写用）
  remove(key)
  get size()
  lookupExact(key)                          // -> record | undefined
  lookup(title, options, opts)              // -> {record, score, level:'L1'|'L2', suspicious:boolean} | null
  // opts（P1-13，T6 批准）：{acceptSuspicious?, fuzzyThreshold?, suspiciousThreshold?, candidateLimit?}
  // 逐字段覆盖构造时的 matchConfig，未传字段用构造值；非法值回退构造值
}
```

- `lookup` 内部：先 `makeKey` 查 L1；未命中走 L2。
- L2 候选裁剪：按 `normalize(title).length` 分桶（桶宽 ±30%长度）+ trigram 倒排取交集计数 Top-N（`candidateLimit`，默认 200）；候选数 < 5 时直接全表打分。
- 打分对象是 `normalize(record.title)` vs `normalize(title)`。
- 阈值判定：`score >= fuzzyThreshold` → 采纳，`level:'L2'`；`suspiciousThreshold <= score < fuzzyThreshold` → `suspicious:true`，仅当 `acceptSuspicious===true` 才采纳，否则继续找下一个候选，全都没有则返回 `null`。
- Tie-break（DECISIONS #12）：在所有 `score >= suspiciousThreshold` 的候选中，若存在 `makeKey(record.title, record.options) === 查询key` 的，直接选它（视为 L2 满分命中）。
- 记录数 <= candidateLimit 时跳过分桶与 trigram，直接全表打分（小库更快）。

## 3. lib/store.js  （Owner: T3）

```js
export class Store {
  constructor({ bankPath, bakPath, config, matcher, log })
  async load()                 // 读 bank.json（缺失/损坏 -> 空库 + 一条 stderr 警告，不抛）
  get(key)                     // -> record | undefined   （受 requireVerified 过滤，DECISIONS #6）
  match(title, options)        // -> 同 Matcher.lookup 结果 | null
  add(record)                  // 内存追加 + 索引 add + 触发 debounced persist
  async persist()              // 立即落盘：先复制 bank.json -> bank.json.bak，再临时文件 rename
  stats()                      // -> {total, verified, bySource:{local,ai,import,fuzzy}, l1Hits, l2Hits, l2Suspicious, noMatch}
  records()                    // -> 只读数组引用（bench/tools 用）
  setVerified(key, verified)   // -> boolean（P1-7，T6 批准）key 存在则置 verified 并触发去抖落盘
  get flushing()               // -> Promise（P1-7）当前在途写队列，测试/退出钩子可 await
}
```

- bank.json 顶层：`{"version":1,"updatedAt":<ms>,"records":[Record]}`；`load` 兼容裸数组。
- Record 字段（严格照 HANDOFF §8.3，不多不少）：
  `{ key, title, options: string[], answer, type, source, model?, verified:boolean, createdAt:number }`
  `source ∈ 'local'|'ai'|'import'|'fuzzy'`（回写用 `ai`，导入用 `import`）。
- `type` 存 `toLabel()` 后的中文题型（`多选题` 等）。
- 落盘去抖：`add` 后 1000ms 内的多次写入合并为一次 `persist`；进程退出钩子调用 `persist()`。
- 所有 fs 操作 try/catch，失败只 stderr 记录错误码，**不抛**。

## 4. lib/cache.js  （Owner: T3）

```js
export class LRU {
  constructor({ maxEntries, file, flushIntervalMs, log })
  async load()                 // 缺失/损坏 -> 空缓存，不抛
  get(key)                     // -> {answer, source, type, model, createdAt} | undefined
  set(key, value)
  has(key)
  delete(key)
  get size()
  async flush()                // 立即落盘 data/cache.json（临时文件 + rename）
  stats()                      // -> {size, hits, misses, evictions, writes, flushedAt}
  startAutoFlush()             // setInterval(flushIntervalMs)，unref()
  stopAutoFlush()
  get flushing()               // -> Promise（P2/T3#10，T6 批准）当前在途 flush，测试可 await
}
```
- **cache.json 文件格式（P1-1，T6 批准）**：`{"version":1,"updatedAt":<ms>,"entries":{key:{answer,source,type,model?,createdAt}}}`。
  `load` 兼容裸 map（无 version/records/entries 包装时整体视为 entries）；结构不识别 → 空缓存 + stderr 警告，不抛。
- `maxEntries` 满时淘汰最久未使用；每 100 次 `set` 强制 flush 一次。
- 加载优先级（DECISIONS #10）：`server` 启动时先 `store.load()` 再 `cache.load()`，
  **cache 中与 bank 同 key 的条目一律丢弃**（bank 权威，可能含人工修正）。

## 5. lib/prompt.js + lib/answer.js  （Owner: T2，纯函数）

```js
// prompt.js
export const SYSTEM_PROMPT            // 逐字照抄 HANDOFF §7.3 的 [system] 段
export function buildMessages({ type, title, options })  // -> [{role,content}]
//   options 为空数组/空串时，user 段不输出「选项：」整行
//   user 段格式：`题型：{label}\n题干：{title}\n选项：{A.xx#B.xx}`
//   title/options 使用剥杂质后原文（不 normalize），type 使用 toLabel() 结果
//   D3/Patch 4（2026-11-22 用户批准）：options 原文先经 stripOptionJunk 剥图片占位杂质；SYSTEM_PROMPT 一字不改
//   D3/Patch 5（2026-11-22 用户批准）：选项缺字母标号时按原始位置补 A./B./…（已有标号原样保留、幂等、
//   空项跳过但保留字母槽位），仅作用于 prompt 文本，不影响 key/存储/匹配；SYSTEM_PROMPT 一字不改
//   D3/Patch 7（2026-11-22 用户批准）：title 原文同样先经 stripOptionJunk 剥图片占位杂质；SYSTEM_PROMPT 一字不改

// answer.js
export function postProcess(raw, ctx)  // ctx={type, options}
   // -> { ok:true, answer:string, via:'strict'|'fallback' }
   // -> { ok:false, code:'invalid_output' }
export function validate(answer, type, options)  // -> boolean
export function normalizeJudge(token, options)   // -> '正确'|'错误'|null
export function cleanRaw(raw)                    // -> string（P0-5，T6 批准）剥代码块/前缀/边缘标点后的干净文本
```

> **ctx 约定（P0-4，T6 批准）**：`postProcess(raw, ctx)` 的 `ctx.type` 同时接受短题型
> （`单选`）与中文标签（`单选题`，内部 normalizeTypeAlias 归一，空值保守默认 `单选`）；
> `ctx.options` 接受 `string[]` 或原始 `#` 拼接串，server/AI 链传**原文选项**（不 normalize，
> 保留 `A.` 标号；D3/Patch 4：原文先经 stripOptionJunk 剥图片占位杂质再传），
> 判断题型 A/B 映射依赖 `options[0]` 原文含「正确/对/√/是」。

`postProcess` 步骤严格照 HANDOFF §7.4，补充：
- 剥代码块：`^```[\w]*\n?` 与 `\n?```$`。
- 前缀剥离正则（P0-5，T6 修订）：`/^(正确答案|参考答案|答案应为|正确选项是|应该选|答案是|应选|答案|选项)\s*(?:是|为)?\s*[:：]?\s*/`，
  **长前缀优先**（避免「正确答案」被「答案」抢先剥半截），循环剥离直到不再变化（最多 3 次）。
- 去首尾 `。．.！!，,、` 与成对引号 `"'“”‘’「」『』`。
- `UNKNOWN`/`unknown`/`不知道`/空串 → `ok:false`。
- 题型校验：单选 `/^[A-Z]$/`；多选 `/^[A-Z](#[A-Z])*$/`（P0-2②，T6 裁决：**单字母也合法**，
  不定项可能只有 1 个正确项）后按字母升序重排去重；判断走 `normalizeJudge`；填空按 `#` 切后每段非空且长度 <= 100；问答非空且 <= 400 字且不含 ``` 与 `#` 开头 markdown 标记。
- `normalizeJudge`：`正确|对|√|T|true|是|Y` → `正确`；`错误|错|×|F|false|否|N` → `错误`；
  `A|B` 仅在 `options` 存在且 `options[0]` 含 `正确|对|√|是` 时映射 A→正确、B→错误，否则返回 `null`（DECISIONS #4）。
- 兜底提取：校验失败时 `raw.match(/[A-Z]/g)`，去重升序 join('#')；仅当 `type` 为 `单选`（取首字母）或 `多选`（>=2 字母）时接受，其余题型不接受兜底。

## 6. lib/queue.js  （Owner: T2）

```js
export function createGate({ concurrency, queueLimit, timeoutMs })
// -> {
//   run(task, opts)   // task: (signal) => Promise；opts.timeoutMs 可覆盖
//                     // 队列满 -> reject Error{code:'queue_full'}（不入队、不等待）
//                     // 超时 -> reject Error{code:'ai_timeout'}，且 abort 传给 task 的 signal
//   stats()           // -> {inflight, peak, queued, completed, failed, rejected, timeouts, startedAt}
//                     // peak（P0-7/T6 新增）：历史并发峰值，e2e 用它断言「AI 实际并发 <= concurrency」
//   get inflight(); get queued(); get concurrency(); get queueLimit()
//   drain()           // -> Promise，等待在途任务与队列全部结束（优雅退出用）
//   close()           // （P1-8，T6 批准）停止调度：排队任务立即 reject{code:'queue_full'}，
//                     // 不 abort 在途任务；close 后 run() 一律 reject{code:'ai_error'}
// }
```
FIFO 严格顺序；`run` 不得因单个 task 抛错而中断后续调度。
**超时计时起点（P1-9，T6 批准）**：`timeoutMs` 从任务**实际开始执行**（出队）起算，
排队等待时间不计入超时；超时 reject `{code:'ai_timeout'}` 并 abort 传给 task 的 signal。

## 7. lib/ai/*  （Owner: T2）

```js
// lib/ai/openai.js | ollama.js —— impl 通用体，各自 default export（Patch 8：内部 REGISTRY 仅 {openai, ollama}）
// lib/ai/bailian.js —— dashscope 兼容薄壳：chat 委托 openai 通用体，只补参数默认（qwen-flash/0/64）+ preset:'dashscope'，
//   **不补 baseUrl/apiKeyEnv**（缺 baseUrl 仍抛 ai_error，绝不隐式联网）；仅为兼容直接 import 的既有调用方保留，路由层不经过本壳
export default {
  name: 'openai',
  isConfigured(providerCfg, env)   // -> boolean（缺 baseUrl 或 apiKeyEnv 对应 Key 即 false；ollama 只看 baseUrl，免 Key）
  async chat(messages, { providerCfg, providerName?, signal, timeoutMs, env, fetchImpl?, retryBaseMs?, retryMax? })
     // -> { text:string, model:string, tokens:{in:number,out:number} }
     // providerName（Patch 8）：实例名，错误消息 / err.provider 以实例名为键（缺省回退模块名）
     // 抛错时必须带 code：'ai_moderation' | 'ai_error' | 'ai_timeout'
     // P1-10（T6 批准）：fetchImpl 可注入（opts 优先，其次 providerCfg.fetchImpl，默认 globalThis.fetch）；
     // 429 退避 retryBaseMs 默认 1000、retryMax 默认 2，均可注入（测试禁止真实 sleep > 200ms）
     // 协议开关（Patch 8，可选 providerCfg 字段）：maxTokensParam（'max_completion_tokens' 生效，其余一律 max_tokens）/
     //   omitTemperature（true → 不发 temperature）/ extraHeaders（对象并入请求头；鉴权头永远由环境变量 Key 生成且最后写入）/
     //   apiKeyHeader（自定义头名发裸 Key；缺省或 'authorization' → Authorization: Bearer；无 Key 不发鉴权头）/
     //   query（对象 URLSearchParams 拼入 URL，为 Azure api-version 留口）
}

// lib/ai/presets.js（Patch 8 新增；纯数据 + 纯函数，顶层无 I/O）
export const PRESETS               // 11 家预置：dashscope/openai/deepseek/kimi/zhipu/siliconflow/openrouter/lmstudio/vllm/xinference/ollama-openai
                                   // 每家 { impl, baseUrl, model, apiKeyEnv?, temperature:0, maxTokens:64 }；来源见文件注释
export const MODERATION_SIGNATURES // preset → { codes, keywords, finishReasons }；7 家：dashscope/openai/deepseek/kimi/zhipu/siliconflow/openrouter
export function signatureFor(preset)   // -> 签名对象 | undefined
export function resolveInstance(name, rawCfg)
// -> { ok:true, impl, preset, cfg } | { ok:false, errorCode }
// 显式 impl 优先；显式 preset 提供默认值（可被 raw 覆盖）并声明 impl；两者冲突 → 拒绝；
// 未知 impl/preset → ok:false + stderr 警告一次（只含实例名/错误码，进程内按 code+名去重），永不抛；
// 两字段缺省时按名字推断：bailian→dashscope 预置、openai→openai 预置、ollama→ollama impl（不补默认值）、其他→openai impl 无预置；
// cfg = 预置默认 ← raw 覆盖，附 impl/preset 字段

// lib/ai/index.js
export const MODERATION_CODES   // ['DataInspectionFailed','InvalidParameter.DataInspection','InternalError.Algo.DataInspectionFailed']
export function isModerationError(errOrBody, signature?)
// 单参：检查 body.code / body.error.code / err.code / HTTP 400|500 + 文案含 'data inspection'（行为逐字不变）
// 第二参（Patch 8，可选）：preset 名或 {codes,keywords} 签名对象；数字码字符串化；keywords 仅 HTTP 400|500 命中
export function createAI({ config, env, log, gate })
// -> {
//   answer({ key, type, title, options })
//      -> { ok:true, answer, provider, model, tokens } | { ok:false, reason }   // 永不抛；provider 为实例名
//   stats()  // -> {calls,success,failed,byProvider:{<实例名>:{calls,success,failed,moderation,timeout,ms}},tokensIn,tokensOut,moderation,queueFull,chainExhausted}
//   chain    // -> string[]  实际生效的实例名顺序（已剔除未配置 / 未知 impl/preset 的）
//   get enabled()  // -> boolean（P0-8，T6 批准）AI 总开关实时状态，/health 用
// }
```
- **并发闸只有一层（P0-7，T6 裁决）**：`gate.run` 由 **server 在调用 `ai.answer` 外面包一次**；
  `createAI` 内部**不再**套第二层 gate（保留 `gate` 入参仅为兼容签名，内部 `void gate`）。
  双层闸会把实际并发压到 concurrency² 以下并虚增排队，e2e 用 `gate.stats().peak <= concurrency` 卡死。
- `stats().queueFull` 在 AI 层恒为 0（闸不在这一层）；**对外 /stats 的 `ai.queueFull` 由 server
  取 `gate.stats().rejected`**（P1-6，T6 裁决），AI 层数值仅作兜底。
- `createAI` 内：`config.ai.enabled===false` → 立即 `{ok:false, reason:'ai_disabled'}`。
- 链为空（全部 `isConfigured` false）→ `{ok:false, reason:'ai_error'}` 并 stderr 打印一次「未配置任何可用 provider，请设置 DASHSCOPE_API_KEY」。
- 命中 `ai_moderation`：**不重试同 provider**，`log.moderation(key, code, provider)`，切下一家。
- HTTP 429：在 provider 内部指数退避 1s/2s，最多 2 次重试，仍失败则抛 `code:'ai_error'` 让链继续。
- 拿到 `text` 后由 `createAI` 调 `postProcess`；`ok:false` → 视为该 provider 失败，切下一家（DECISIONS #9 → 对外 `ai_error`）。
- `log` 接口（由 server 注入）：`log.moderation(key, code, provider)`、`log.error(scope, errCode)`、`log.info(scope, obj)`。
- **Provider 中立化（Patch 8，2026-11-23 用户批准）**：内部 `REGISTRY` 以 impl 为键（仅 `{openai, ollama}`，不导出）；
  链上成员为任意实例名，经 `presets.js resolveInstance` 解析到 impl + 生效配置；bailian 降格为 dashscope 预置，
  代码不硬编码任何「主力」（DECISIONS #1 修订 / #15）。未知 impl/preset、impl/preset 冲突 → 该实例剔除 + stderr 警告一次
  （`[qbank][ai][unknown_impl_<名>]` / `unknown_preset_<名>` / `impl_preset_conflict_<名>`，进程内按 code+名去重），永不崩溃。
- **审核判定扩展（Patch 8）**：错误路径 = 全局兜底（DataInspectionFailed 族三码 + HTTP 400|500 'data inspection'）
  + 预置签名码（检查 body.code / body.type / error.code / error.type / error.innererror.code，数字码字符串化）
  + 签名关键词（仅 HTTP 400|500）；成功路径 = HTTP 200 且 `finish_reason==='content_filter'` 为协议级拦截，
  **在 content 校验之前**判定（DeepSeek 拒答时 content 为空），预置 finishReasons 可追加取值（zhipu 'sensitive'）。
  `err.detailCode` 兜底顺序：`detailCode || sigCode || (sig ? 'content_filter' : 'DataInspectionFailed')`。
  ollama 无审核签名；认不出的 400 仍 ai_error fail-closed 切下一家。
- **providers 配置 schema（Patch 8）**：每条可选新增 `impl`（'openai' 或 'ollama'）/ `preset`（11 家之一）/
  `maxTokensParam` / `omitTemperature` / `extraHeaders` / `apiKeyHeader` / `query`（语义见上方 openai.js 注释块与 HANDOFF §10）；
  生效配置 = 预置默认 ← raw 覆盖。`loadConfig` 保留任意实例名的 provider 条目（bailian/ollama/openai 三内置名仍合并 DEFAULTS）；
  `pruneFallback` 先 `resolveInstance` 再按生效配置检查（裸 `{"preset":"deepseek"}` 不被误剔；缺 Key 按生效 `apiKeyEnv` 判定；本地预置免 Key）。

## 8. server.js 路由与管线（Owner: T3）

```
GET|POST /api            主体
GET      /health         -> {code:1,status:'ok',uptime,version,bank:total,ai:{enabled,chain}}  // P0-8，T6 裁决
GET      /stats          -> 见 DECISIONS #7 的结构
POST     /admin/verify   body {key, verified:true|false} -> {code:1,key,verified} | {code:0,reason:'bad_request'}
OPTIONS  *               -> 204 + CORS 头
其它路径                  -> 404 {"code":0,"reason":"no_match"}
```

`/api` 处理顺序（固定，不得调整）：
1. 解析入参：GET 用 `URLSearchParams` + `decodeURIComponent` 容错（已解码则不重复解码，捕获 URIError）；
   POST 读 body（上限 1MB，超限 → `{"code":0,"reason":"bad_request"}`）。**body 只接受 JSON 对象**
   （T3#8，T6 批准）：非法 JSON / 数组 / 表单编码一律 `bad_request`，HTTP 状态仍 200。缺 `q` → `bad_request`。
2. `title=normalize(q)`；`options=normalizeOptions(optionsParam)`；`type=normalizeType(typeParam,{...})`；`key=makeKey(q, optionsParam)`。
3. `store.match(q, optionsParam)` → L1 命中：`{code:1, question:<record.title>, answer:record.answer, source:'local', elapsed}`。
4. L2 命中（非 suspicious 或 acceptSuspicious）：同上，`source:'fuzzy'`。
5. `cache.get(key)` 命中：`{code:1, question:<q 原文>, answer, source:'cache', elapsed}`。
6. `isUnanswerable(q, options)` → `{code:0, question:'', answer:'', reason:'image_or_formula', elapsed}`。
7. `gate.run(...)` → `ai.answer(...)`；`ok:false` → `{code:0, question:'', answer:'', reason:<reason>, elapsed}`。
8. 成功：`store.add(record)`（若 `writeback.enabled`）+ `cache.set(key,...)` → `{code:1, question:<q 原文>, answer, source:'ai', elapsed}`。
9. `QueueFullError` → `reason:'queue_full'`（立即返回，不占连接）。

- **no_match 语义（T6 裁决）**：`no_match` **只用于 404 未知路径**。`/api` 上本地未命中会继续走
  缓存 → 短路检测 → AI，失败给 `ai_*` / `image_or_formula` / `ai_disabled` / `queue_full`，不给 `no_match`。
- **静态装配（T3#11，T6 批准）**：server 顶层静态 import 真实 Matcher/createGate/createAI，
  **删除一切「模块缺失就降级到内置假实现」的 fallback 分支**；测试注入只走 `createServer(overrides)`。
- **/admin/verify 无鉴权（T3#9，T6 批准）**：与整机一致，安全边界 = 只绑 127.0.0.1（HANDOFF §9）。
- 内部码映射：`invalid_output` → `ai_error`；`bad_request` 原样返回（`reason:'bad_request'`，属于 §4.2 枚举外新增，仅用于请求本身非法，DECISIONS #9 补充；HANDOFF 补丁已于 2026-11-19 经用户批准写回，见 ACCEPTANCE「契约增补」）。
- 所有响应：`Content-Type: application/json; charset=utf-8`、`Access-Control-Allow-Origin: <config.cors>`、`Cache-Control: no-store`；OPTIONS 另加 `Allow-Methods/Headers`。
- 顶层 `try/catch` 包住整个 handler，catch 里返回 `{"code":0,"reason":"ai_error"}`，**绝不 500 空响应、绝不 throw**。
- `process.on('uncaughtException'|'unhandledRejection')`：只打印 `err.code||err.name`，不退出。
- `SIGINT`/`SIGTERM`：`cache.stopAutoFlush()` → `cache.flush()` → `store.persist()` → `gate.drain()` → `server.close()` → `process.exit(0)`；10s 兜底强制退出。
- 测试友好：`export async function createServer(overrides)` 返回 `{server, listen(), close(), app}`，
  且 `node server.js` 直接执行时才 `listen(config.port)`（用 `import.meta.url === pathToFileURL(process.argv[1]).href` 判定）。
  测试一律用 `listen(0)` 随机端口，**禁止占用 8080**。

## 9. tools/*  （Owner: T4 / T5）

```
tools/import.js  --file <p> --format csv|tsv|txt|json [--merge|--replace] [--type 单选题] [--dry-run] [--out data/bank.json]
                 退出码：0 成功 / 1 失败 / 2 无法执行（P1-11）
                 stdout 打印 {parsed, imported, skipped, duplicates, failed, elapsed}
                 （P1-3/P1-4，T6 批准：skipped=缺必需字段/无法解析的行，failed=处理异常的行，
                 elapsed=毫秒；--verbose 诊断只打 stderr，仅行号与错误码）
tools/genbank.js --count 50000 [--out data/bench.json] [--seed 42]   # 合成题库，供 bench 使用，无随机依赖外部包
                 # P1-5（T6 批准）：stdout summary 区分 nearDuplicates（主动构造的近似重复，供 L2 压测）
                 # 与 collisions（key 撞车后加序号重试的次数）；updatedAt/createdAt 固定 1700000000000（P1-2）
tools/bench.js   --file data/bench.json [--l1 10000] [--l2 2000] [--json]
                 输出 L1 avg/p50/p95/p99、L2 avg/p50/p95/p99、内存 rss、是否达标(§12.6)
                 # P1-12（T6 批准）：分位数用线性插值（R type-7，与 numpy 默认一致）；
                 # 退出码 0=PASS / 1=FAIL / 2=无法执行
tools/accuracy.js --file test/fixtures/accuracy_set.json [--provider bailian] [--concurrency 3] [--json]
                 [--timeout 20000] [--limit n] [--out <p>] [--mock] [--mock-accuracy 0~1]
                 输出逐题 期望/实际/对错（题干只打印前 8 字 + key，不打印全文）、总准确率、是否达标(§12.7)
                 # T6 批准：--out 无默认值（不传只打 stdout）；退出码 0=PASS / 1=FAIL / 2=BLOCKED(env)
                 # （缺 Key/缺文件/enabled=false/探活失败/参数错误），2 不计 FAIL；--mock 离线桩不联网
```
`accuracy_set.json` 结构：`[{"key":"可选","type":"单选题","title":"...","options":"A.xx#B.xx","answer":"A"}]`，20 条。

## 10. 文件所有权矩阵（严禁越界写入）

| 任务 | 独占写入的文件 |
|---|---|
| T0 | `package.json` `config.json` `config.js` `.env.example` `.gitignore` `data/.gitkeep` `logs/.gitkeep` |
| T1 | `lib/normalize.js` `lib/matcher.js` `test/normalize.test.js` `test/matcher.test.js` |
| T2 | `lib/prompt.js` `lib/answer.js` `lib/queue.js` `lib/ai/index.js` `lib/ai/bailian.js` `lib/ai/openai.js` `lib/ai/ollama.js` `test/prompt.test.js` `test/answer.test.js` `test/queue.test.js` `test/ai.test.js` |
| T3 | `server.js` `lib/store.js` `lib/cache.js` `test/store.test.js` `test/cache.test.js` `test/http.test.js` |
| T4 | `tools/import.js` `tools/genbank.js` `test/import.test.js` `test/fixtures/sample.csv` `test/fixtures/sample.tsv` `test/fixtures/sample.txt` `test/fixtures/sample.json` |
| T5 | `tools/bench.js` `tools/accuracy.js` `test/fixtures/accuracy_set.json` `README.md` |
| T6 | 集成期可改任意文件（**除 HANDOFF.md**）；新增 `test/e2e.test.js` `docs/ACCEPTANCE.md` `docs/accuracy-report.json`；裁决落地时修订 `docs/CONTRACT.md`（本 v1.1）与 `docs/DECISIONS.md`，每处跨任务改动记入 ACCEPTANCE「变更表」 |
| 只读 | `HANDOFF.md` `PROMPT.md` `docs/PROMPT_T6.md` `docs/TASKS.md`（HANDOFF 的修改只能以补丁提案形式写入 ACCEPTANCE「契约增补」，经用户批准后方可写回；本次两处增补已于 2026-11-19 获批写回 §4.1/§4.2） |

依赖别人的模块时，一律 **按本契约的签名 import**，不要为了跑通而去实现/修改别人的文件；
若必须打桩，桩文件写在自己的 `test/` 目录下（例如 `test/stubs/fakeAI.js`）。

## 11. 并行隔离约束（强制，T1~T6 全部适用）

多窗口并行时最容易出的事故是「互相抢端口 / 互相写坏 data / 互相改对方文件」。以下 8 条是硬性纪律，
违反任意一条即视为该任务未通过 DoD。

### 11.1 端口隔离
- 单元测试与工具自测**严禁**监听 `config.port`（默认 8080）。
- 一律 `server.listen(0)` 后从 `server.address().port` 取真实端口，请求打这个端口。
- 严禁硬编码 8080/3000/11434 等固定端口；需要假 provider 时同样 `listen(0)`。
- 测试结束必须 `await server.close()` 并释放所有 `setInterval`（`unref()` 或显式 `clearInterval`），
  否则 `node --test` 会挂住不退出。

### 11.2 数据隔离
- 单元测试**严禁**读写仓库内的真实 `data/` 与 `logs/`。
- 每个测试文件在 `before` 里建自己的临时目录：`fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-t1-'))`，
  前缀带上任务号（`qbank-t1-` / `qbank-t3-` …）便于排查；`after` 里 `fs.rmSync(dir,{recursive:true,force:true})`。
- 需要完整配置时走已实现的覆盖入口，不要自己造配置对象：
  `loadConfig({ cwd: <临时目录>, env: { QBANK_DATA_DIR: <临时目录>, QBANK_LOGS_DIR: <临时目录>, QBANK_PORT: '0' } })`
  再用 `resolvePaths(cfg, { cwd: <临时目录> })` 拿路径。
- 命令行工具（T4/T5）自测时一律显式传 `--out` / `--file` 指向临时目录，
  **禁止**依赖默认路径；`tools/genbank.js` 的大文件产物（`data/bench.json`）只允许在 T5/T6 手动运行时生成。
- 禁止把测试产物提交进仓库；`test/fixtures/` 下只放小于 20KB 的固定样例。

### 11.3 文件写权限
- 只写 CONTRACT §10 所有权矩阵里属于自己那一行的文件。
- 需要别人的模块 → 按契约签名 `import`，跑不通就在**自己的** `test/stubs/` 下打桩；
  桩文件命名 `test/stubs/<task>-<name>.js`（如 `test/stubs/t3-fakeAI.js`）。
- 严禁创建「顺手」的公共文件（`lib/util.js`、`lib/errors.js`、`lib/log.js` 等）。
  错误约定见 §0（`Error` + `err.code`），日志约定见 §7 的 `log` 注入接口，**不需要**公共模块。
- 发现契约缺项或有歧义 → **不要自行扩张接口**，照最保守的方式实现，并在最终报告的
  「契约歧义」小节写清楚，由 T6 统一裁决。

### 11.4 依赖与运行时
- 禁止 `npm install` / `npx <包>` / 引入任何 `node_modules`。
- 禁止修改 `package.json`（T0 所有）。若需要新 script，写进最终报告由 T6 统一加。
- 只允许 `node:` 前缀的内置模块与全局 `fetch` / `AbortController` / `URL`。
- 全程 ESM，禁止混入 `require` / `module.exports`。

### 11.5 日志与隐私
- 任何 `console.*` / `process.stderr.write` / 文件日志中**禁止**出现题干、选项、答案原文。
- 允许出现：`key`（可截断为前 12 位）、错误码、计数、耗时、provider 名、文件名、行号。
- 报错信息面向用户时用中文，格式统一为 `[qbank][<scope>][<code>] <简述>`，不打印堆栈（`--verbose` 时才打）。
- 禁止把任何真实 API Key 写进源码、测试、fixture、README 或提交信息；示例一律 `sk-xxxxxxxx`。

### 11.6 测试规范
- 框架：`node:test` + `node:assert/strict`；文件名 `test/*.test.js`；一个模块一个测试文件。
- 断言必须卡住数值/结构，不允许只 `console.log` 人肉看结果。
- 涉及时间的测试禁止真实 sleep 超过 200ms；退避/去抖等必须支持注入（把间隔做成参数或可覆盖的字段）。
- 每个测试文件必须能**单独**跑通：`node --test test/<file>.test.js`。
- 自己的测试全绿是交付前置条件，报告里必须贴原始输出（不是「已通过」四个字）。

### 11.7 健壮性红线
- 任何外部输入（HTTP body、文件内容、AI 响应、环境变量）都视为不可信，必须 try/catch。
- 模块顶层**禁止**执行 I/O 或有副作用的代码（`config.js` 的 `loadConfig()` 也必须显式调用）。
- 禁止 `process.exit()` 出现在 `lib/**` 里；只有 `server.js` 的退出钩子和 `tools/**` 的 CLI 收尾可以用。

### 11.8 交付报告格式（每个窗口最终回复必须包含）
```
1. 文件清单：新增/修改的绝对路径，逐行
2. 自检输出：完整命令 + 完整原始输出（node --test 的结尾统计行必须包含）
3. DoD 核对：docs/TASKS.md 中本任务 DoD 的每一项，逐条标 ✅/❌
4. 契约歧义：实现中发现的契约缺项/矛盾，以及你采取的保守做法（没有就写「无」）
5. 需要他人配合：必须由别的任务改动的点（没有就写「无」）
```
