# 题库检索服务 · 项目交接文件

> 版本 v1.0 ｜ 生成日期 2026-11-18
> 本文件自包含，可作为新会话的完整上下文起点，不依赖任何历史对话。

---

## 1. 项目目标

构建一个 **零第三方依赖的 Node.js HTTP 题库检索服务**：对外兼容 OCS（Open Course Script）
开放题库协议（AnswererWrapper），对内实现 **「本地检索 → 模糊匹配 → 大模型兜底 → 结果回写」**
的三层混合架构。

核心设计原则：
- 本地数据优先，大模型只处理新题，**同题永不重复调用 AI**
- Provider 可插拔，任意一路失败自动降级，服务进程永不崩溃
- 零依赖，`node server.js` 一条命令跑起来

---

## 2. 技术选型

| 项 | 选择 | 说明 |
|---|---|---|
| 运行时 | Node.js >= 18 | 需要内置 `fetch` |
| 第三方依赖 | **无** | 只用 `node:http` / `node:fs` / `node:crypto` / `node:path` |
| 存储 | JSON 文件 | `data/bank.json` + `data/cache.json` |
| LLM 主用 | 阿里云百炼 DashScope | OpenAI 兼容模式，默认 `qwen-flash` |
| LLM 备用 | Ollama 本地 | 免审核、免网络，最后兜底 |
| 对外协议 | OCS AnswererWrapper | 见第 4 节 |

---

## 3. 系统架构

```
OCS 浏览器脚本
   |  GET /api?q=<题干>&type=<题型>&options=<选项>
   v
+----------------------------------------------+
|  server.js   HTTP 入口 / CORS / 路由          |
|      v                                       |
|  normalize()  归一化                          |
|      v                                       |
|  L1 精确匹配   -- 命中 --> source=local       |
|      v 未命中                                 |
|  L2 模糊匹配   -- 命中 --> source=fuzzy       |
|      v 未命中                                 |
|  图片/公式短路 --> code:0 (不浪费 AI 调用)     |
|      v                                       |
|  queue 并发闸 (并发 3 / 队列 200)              |
|      v                                       |
|  LLM provider 链: bailian -> ollama -> openai |
|      | 成功                                   |
|      |--> answer.js 输出后处理 + 正则校验      |
|      |--> 回写 data/bank.json (source=ai)     |
|      +--> 返回 code:1                         |
|      v 全链失败 / 审核拦截 / 超时              |
|  返回 {"code":0,"reason":"..."}               |
+----------------------------------------------+
```

---

## 4. 对外接口契约（关键，不可随意改）

### 4.1 请求

```
GET  http://127.0.0.1:8080/api?q=<题干>&type=<题型>&options=<选项>
POST http://127.0.0.1:8080/api        body: {"q":"","type":"","options":""}
GET  http://127.0.0.1:8080/health
GET  http://127.0.0.1:8080/stats
```

- `options` 由 OCS 用 `#` 拼接，例如 `A.富强#B.振兴#C.和平`
- `q` / `options` 必须做 `decodeURIComponent`
- 所有响应带 `Content-Type: application/json; charset=utf-8`
- CORS：`Access-Control-Allow-Origin: *`，并处理 OPTIONS 预检

`GET /health` 返回 200，响应体（**T6 契约增补，2026-11-19 用户批准**，见 ACCEPTANCE「契约增补」Patch 2）：

```json
{ "code": 1, "status": "ok", "uptime": 1789, "version": "1.0.0", "bank": 0,
  "ai": { "enabled": true, "chain": ["ollama"] } }
```

`ai` 为附加字段（enabled=AI 总开关；chain=探活后的实际 provider 链）；OCS 不读 /health，无破坏。

### 4.2 响应

命中：
```json
{ "code": 1, "question": "中国梦的本质内涵是什么", "answer": "A#B",
  "source": "local", "elapsed": 3 }
```

未命中（仅未知路径 404；/api 本地未命中会继续走 AI 管线，见下方增补）：
```json
{ "code": 0, "question": "", "answer": "", "reason": "no_match" }
```

- `source` ∈ `local` / `fuzzy` / `ai` / `cache`
- `reason` ∈ `no_match` / `ai_timeout` / `ai_moderation` /
  `ai_error` / `queue_full` / `image_or_formula` / `ai_disabled` / `bad_request`

> **T6 契约增补（2026-11-19 用户批准，提案与依据见 docs/ACCEPTANCE.md「契约增补」Patch 1）**：
> - `bad_request` 仅用于**请求本身非法**（缺 q、POST body 超过 1MB、body 不是 JSON 对象、/admin/verify 参数非法）。
> - HTTP 状态策略：除未知路径返回 404 外，`/api` 一律返回 **HTTP 200 + JSON**
>   （OCS handler 只读 body 的 code，4xx 会触发 fetch 异常分支）。
> - `no_match` 仅用于 404 场景；/api 未命中本地库时继续走 AI 管线，不返回 no_match。

### 4.3 答案格式硬约定

| 题型 | 输出 |
|---|---|
| 单选 | `A` |
| 多选 | `A#C`（字母升序，`#` 连接） |
| 判断 | `正确` 或 `错误` |
| 填空 | 多空用 `#` 连接 |
| 问答 | 纯文本，不含 markdown |

**禁止**返回解释、序号、引号包裹、「答案是」之类前缀。

> **D3/Patch 6 契约增补（2026-11-22 用户批准，提案与依据见 docs/ACCEPTANCE.md「契约增补」Patch 6）**：
> 题型判定新增**选项性质 override**（优先于题型标签，CONTRACT §1.4）：恰好两个选项且剥 `A.` 前缀后
> 皆为判断语义词（`√/×/正确/错误/对/错/是/否/T/F/true/false`，大小写不敏感，排除裸 A/B）→ 强制「判断」，
> 即使 OCS 传 `type=单选题`（超星把 √/× 判断题标成【单选题】）。动机：OCS 单选匹配器对判断性质选项
> 同样改走判断匹配（isJudgementOptions→resolveJudgement），只认 正确/错误/√/× 等语义词、不认字母；
> 按标签走单选存字母必致「答案和选项不匹配」。答案格式表本身不变（判断仍输出 正确/错误）。

### 4.4 OCS 端题库配置

> **T6 契约增补（2026-11-22 用户批准，提案与依据见 docs/ACCEPTANCE.md「契约增补」Patch 3）**：
> 原模板 `"method": "fetch"` 为笔误（OCS 官方 schema：method∈{get,post}、type∈{fetch,GM_xmlhttpRequest}、
> contentType∈{json,text}，见 <https://docs.ocsjs.com/docs/other/api>）；现修正为浏览器实测可用版本，并补充 contentType 字段。

```json
[
  {
    "name": "本地混合题库",
    "url": "http://127.0.0.1:8080/api?q=${title}&type=${type}&options=${options}",
    "method": "get",
    "type": "fetch",
    "contentType": "json",
    "headers": {},
    "handler": "return (res)=> res.code===1 ? [res.question,res.answer] : undefined"
  }
]
```

> `url` 里的 ${title}` / ${type}` / ${options}` 是 OCS 的占位符，
> 由 OCS 在发请求前替换成真实内容，服务端无需关心。
> `handler` 必须返回 `[题目, 答案]` 或二维数组 `[[题目,答案],...]`，
> 返回 `undefined` 表示这条结果无效。

---

## 5. 文本归一化管线

`normalize(s)` 依次执行：

1. Unicode NFKC 归一 + 全角字符转半角
2. 英文统一小写
3. 删除所有空白（含全角空格、换行、制表符）
4. 删除中英文标点：`，。、；：？！“”‘’（）《》【】…—,.!?;:'"()<>[]{}`
5. 删除题号前缀：`1.` `1、` `(1)` `（1）` `一、` `第1题`
6. 删除题型标记：`【单选题】` `[多选题]` `单选题：` 等

索引键：
```
key = sha256( normalize(title) + '||' + normalize(options).split('#').sort().join('#') )
```
> 选项排序后再拼，保证「同一道题选项乱序」也能命中 L1。

> **T6 契约增补（2026-11-22 用户批准，提案与依据见 docs/ACCEPTANCE.md「契约增补」Patch 4）**：
> 选项归一化前先经 `stripOptionJunk` 剥离图片占位杂质（markdown 图片、`<img>` 标签、图片资源 URL、
> spacer.gif 等常见裸占位文件名；非图片 URL 与普通文本不动）。key 公式本身不变，仅选项输入预清洗；
> makeKey/L1/L2/import 去重口径天然一致（D3 修复，空库期零迁移）。

> **T6 契约增补（2026-11-22 用户批准，Patch 7）**：题干同样先经 `stripOptionJunk` 剥图片占位杂质再 normalize
> （超星编辑器把 spacer.gif / `<img>` / markdown 图片也混进**题干**，致纯文字题被误短路为图片题）。
> key 公式本身不变，仅题干输入预清洗；幂等、干净题干零迁移；makeKey/L1/L2/import 口径天然一致。

---

## 6. 匹配算法

### L1 精确
`Map<key, Record>`，O(1)。

### L2 模糊
- **候选集裁剪**（避免全表扫描）：按 `normalize(title).length` 分桶 +
  trigram 倒排索引，取 Top-N（默认 200）作为候选
- **打分**：`score = 0.6 * Dice(bigram) + 0.4 * LCS_ratio`
- **阈值**：
  - `>= 0.90` 直接采纳，`source=fuzzy`
  - `0.80 ~ 0.90` 记为「疑似」，是否采纳由 `match.acceptSuspicious` 决定
  - `< 0.80` 转 L3

### 性能目标
本地 5 万条数据：L1 < 1ms，L2 p95 < 50ms。

---

## 7. AI 层设计

### 7.1 Provider 抽象

```js
// 每个 provider 实现同一接口
export default {
  name: 'bailian',
  // 返回 { text, model, tokens: { in, out } }
  async chat(messages, opts) { /* ... */ }
}
```

**Provider 中立（Patch 8，2026-11-23 用户批准，立案见 docs/ACCEPTANCE.md §7）**：
OpenAI Chat Completions 兼容为唯一主协议；impl 种类仅 `'openai'`（通用体 `lib/ai/openai.js`）与 `'ollama'`（原生 `/api/chat`）。
百炼不再是「主力」，降格为内置预置之一（dashscope）；`lib/ai/bailian.js` 仅保留为兼容直接 import 的薄壳。
内置预置表 `lib/ai/presets.js` 共 11 家：dashscope / openai / deepseek / kimi / zhipu / siliconflow / openrouter / lmstudio / vllm / xinference / ollama-openai。
预置只是「默认值包」，一切字段可被配置覆盖；任何实现兼容协议的服务加一条配置即可入链，零代码改动。
调用顺序由 `config.ai.fallback` 数组决定，成员可为**任意实例名**，逐个尝试直到成功或耗尽。
未知 impl / preset → 该实例剔除 + stderr 警告一次（只含实例名/错误码），永不崩溃。

### 7.2 OpenAI 兼容 Provider（通用实现，百炼/DeepSeek/Kimi/… 均为预置）

通用体 `lib/ai/openai.js` 对**一切** OpenAI Chat Completions 兼容服务生效（百炼/DeepSeek/Kimi/智谱/硅基流动/OpenRouter/本地 LM Studio/vLLM/Xinference/Ollama `/v1` 等）；
预置只提供默认值（Patch 8，2026-11-23 用户批准）。下表以 dashscope（百炼）预置为例：

| 项 | 值 |
|---|---|
| baseURL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 端点 | `POST {baseURL}/chat/completions` |
| 鉴权 | `Authorization: Bearer <DASHSCOPE_API_KEY>`（Key 只走环境变量；无 Key 不发鉴权头） |
| 默认模型 | `qwen-flash`（可切 `qwen-plus` / `qwen-turbo` / `deepseek-v3`） |
| 参数 | `temperature: 0`、`max_tokens: 64`、`stream: false` |

请求体：
```json
{
  "model": "qwen-flash",
  "temperature": 0,
  "max_tokens": 64,
  "messages": [
    { "role": "system", "content": "见 7.3" },
    { "role": "user",   "content": "见 7.3" }
  ]
}
```

响应取 `data.choices[0].message.content`，
用量取 `data.usage.prompt_tokens` / `completion_tokens`。

**协议差异开关（Patch 8，均为可选 provider 配置字段，字段表见 §10）**：
`maxTokensParam: 'max_completion_tokens'`（OpenAI 部分新模型要求；其余值一律 `max_tokens`）、
`omitTemperature: true`（不发送 temperature 字段）、`extraHeaders`（对象，合并入请求头；鉴权头永远由环境变量 Key 生成且最后写入）、
`apiKeyHeader`（自定义头名发裸 Key 值；缺省或 `'authorization'` → `Authorization: Bearer`）、
`query`（对象，URLSearchParams 拼入 URL，为 Azure `api-version` 留口）。
HTTP 200 且 `choices[0].finish_reason === 'content_filter'` 为协议级审核拦截（见 §7.5）。

### 7.3 Prompt 模板

```
[system]
你是一个题库检索系统的答案输出模块。根据用户给出的题型、题干和选项，输出唯一正确答案。

严格遵守以下规则，违反任何一条都视为失败：
1. 只输出答案本身。不要解释、不要推理过程、不要标点包裹、不要任何前后缀。
2. 单项选择题：只输出一个大写字母，例如 A
3. 多项选择题：输出所有正确选项的大写字母，按字母升序用 # 连接，例如 A#C
4. 判断题：只输出「正确」或「错误」
5. 填空题：多个空的答案用 # 连接
6. 问答题：输出简洁的要点式答案，不超过 200 字，不使用 markdown
7. 如果题目信息不足、需要看图、或你无法确定，只输出 UNKNOWN
8. 不要复述题干，不要输出选项内容，只输出选项字母

[user]
题型：{type}
题干：{title}
选项：{options}
```

> `{options}` 为空（填空/问答）时该行整行省略。

> **T6 契约增补（2026-11-22 用户批准，Patch 5）**：`{options}` 各项若缺字母标号，按**原始位置**补 `A.`/`B.`/…
> （已有标号原样保留、幂等；空项跳过但保留其字母槽位，使字母与页面选项位置对齐；超过 26 项不再补）。
> 仅作用于送 AI 的 prompt 文本，不影响 key/存储/匹配，`[system]` 段一字不改。动机：超星常传纯文字选项
> （无 `A.`/`B.`），带填空括号的多选题会诱导 qwen-flash 抄选项文字而非输出字母，被 §7.4 校验拒收
> （invalid_output）→ 真实页面红号；补标号后模型稳定输出字母（复现：无标号→「感觉#知觉」拒收，带标号→「A#B」通过）。

### 7.4 输出后处理（必须做，模型一定会不听话）

```
raw
 -> trim
 -> 剥掉三反引号代码块包裹
 -> 正则去掉「答案：」「答案是」「应选」「正确选项是」等前缀
 -> 去掉首尾句号与引号
 -> 若为 UNKNOWN / 空串 -> 判定该 provider 失败
 -> 按题型校验：
      单选   /^[A-Z]$/
      多选   /^[A-Z](#[A-Z])+$/     并做字母升序重排
      判断   /^(正确|错误|对|错|√|×|T|F|A|B)$/  -> 归一为「正确/错误」
 -> 校验失败 -> 兜底从文本里提取大写字母 /[A-Z]/g
 -> 仍失败 -> 判定该 provider 失败，走 fallback 下一家
```

### 7.5 内容审核降级（百炼特有的坑，务必实现）

百炼 API 带**内容安全审核**。题目内容触发审核时不返回正常结果，而是报错：

- HTTP 400，`code` 为 `DataInspectionFailed` 或 `InvalidParameter.DataInspection`
- HTTP 500，`code` 为 `InternalError.Algo.DataInspectionFailed`
- 响应体路径可能是 `body.code` 或 `body.error.code`，两处都要检查

**处理方式：**
1. `try/catch` 包住调用，识别上述错误码（写成常量数组便于扩展）
2. 命中审核错误 → **不要重试同一 provider**，直接走 fallback 链下一家
3. 写 `logs/moderation.log`：时间戳、题目 key、错误码
   （**不记题目原文**，避免日志本身成为敏感内容）
4. 全链失败 → 返回 `{"code":0,"reason":"ai_moderation"}`
5. `/stats` 暴露审核拦截计数，便于评估哪些课程不适合走 AI

> 经验：思政、时政、法律类内容被拦截概率显著更高。
> 这类课程的策略应是「优先导入本地题库，AI 只当补充」。

> **T6 契约增补（2026-11-23 用户批准，Patch 8）**：审核识别升级为「全局兜底 + 实例级签名」。
> 全局兜底逐字保留：`DataInspectionFailed` 族三码 + HTTP 400|500 文案含 'data inspection'；
> 另增协议级：HTTP 200 且 `finish_reason === 'content_filter'` 视为审核拦截（所有实例生效）。
> `lib/ai/presets.js` 导出 `MODERATION_SIGNATURES`，按 preset 挂厂商特有 codes / keywords / finishReasons，
> 覆盖 dashscope / openai / deepseek / kimi / zhipu / siliconflow / openrouter 7 家（来源见 presets.js 注释；本地预置无签名，走全局兜底）。
> `isModerationError(errOrBody, signature?)` 第二参可选（preset 名或 `{codes, keywords}` 签名对象），单参调用行为逐字不变。
> 认不出的 400 仍 `ai_error` fail-closed 切下一家；上方处理方式 1~5 不变；`moderation.log` 的 provider 字段记**实例名**。

### 7.6 不可答题目短路（省钱省时）

题干命中以下特征时**不调用 AI**，直接返回 `code:0, reason:image_or_formula`：
- 图片标记：`![`、`.png`、`.jpg`、`<img`
- LaTeX：成对 `$`、`\frac`、`\begin{`
- 归一化后长度 < 4

> **T6 契约增补（2026-11-22 用户批准，Patch 4）**：激活 `isUnanswerable(title, options)` 的保留 options 入参——
> 任一选项为「纯图片占位」（剥除杂质并去掉 A. 标号后 normalize 为空）→ 整题按 image_or_formula 短路；
> 「文字+杂质」混合选项不短路，清洗后走正常 AI。题干判定规则不变。

> **T6 契约增补（2026-11-22 用户批准，Patch 7）**：题干先经 `stripOptionJunk` 剥图片占位杂质再判标记——
> 「文字+图片杂质」混合题干清洗后走正常 AI（真·看图题由 SYSTEM_PROMPT 规则 7 UNKNOWN 兜底）；
> 纯图片题干清洗后为空，仍按归一化长度 < 4 短路（fail-closed 不变）。选项口径（Patch 4）不变。

---

## 8. 并发、缓存、回写

### 8.1 并发闸
- LLM 全局并发上限 `ai.concurrency = 3`
- 超出进入 FIFO 队列，队列上限 `ai.queueLimit = 200`
- 队列满 → 立即返回 `reason: queue_full`，不占住 HTTP 连接
- 单请求超时 `ai.timeoutMs = 20000`，用 `AbortController` 实现
- HTTP 429 → 指数退避 1s / 2s / 4s，最多 2 次，之后换下一个 provider

### 8.2 缓存
- 内存 LRU，容量 10000，键为第 5 节的 `key`
- 每 30s 或每 100 次写入落盘 `data/cache.json`
- `SIGINT` / `SIGTERM` 钩子强制落盘后退出

### 8.3 回写
L3 成功后追加到 `data/bank.json`：
```json
{ "key": "...", "title": "...", "options": ["A.富强", "B.振兴"],
  "answer": "A#B", "type": "多选题", "source": "ai",
  "model": "qwen-flash", "verified": false, "createdAt": 1763452800000 }
```
- `verified: false` = AI 生成、人工未确认
- `writeback.requireVerified = true` 时，L1/L2 只采信 `verified: true` 的条目
- 提供 `POST /admin/verify` 供人工标记
- 每次落盘前生成 `data/bank.json.bak`，防止脏数据无法回滚

---

## 9. 目录结构

```
.                                  # 项目根目录（即本文件所在目录）
├── server.js              # HTTP 入口、路由、CORS、优雅退出
├── config.js              # config.json + 环境变量覆盖
├── lib/
│   ├── normalize.js       # 归一化 + key 生成
│   ├── matcher.js         # L1/L2 匹配、trigram 索引
│   ├── store.js           # 题库读写、索引构建、回写
│   ├── cache.js           # LRU + 落盘
│   ├── queue.js           # 并发闸
│   ├── answer.js          # AI 输出后处理与格式校验
│   ├── prompt.js          # Prompt 模板
│   └── ai/
│       ├── index.js       # provider 路由 + fallback + 审核错误识别
│       ├── presets.js     # 预置表 + 实例解析（Patch 8）
│       ├── bailian.js     # dashscope 预置薄壳（Patch 8）
│       ├── openai.js      # OpenAI 兼容通用体（Patch 8）
│       └── ollama.js      # 原生 /api/chat
├── tools/
│   ├── import.js          # CSV/TSV/TXT/JSON 导入
│   ├── bench.js           # 性能基准
│   └── accuracy.js        # 准确率评测
├── data/                  # bank.json / cache.json / bank.json.bak
├── logs/                  # moderation.log
├── config.json
├── .env.example           # DASHSCOPE_API_KEY=
└── README.md
```

---

## 10. 配置文件

`config.json`：
```json
{
  "host": "127.0.0.1",
  "port": 8080,
  "cors": "*",
  "ai": {
    "enabled": true,
    "fallback": ["bailian", "ollama"],
    "concurrency": 3,
    "queueLimit": 200,
    "timeoutMs": 20000
  },
  "providers": {
    "bailian": {
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen-flash",
      "apiKeyEnv": "DASHSCOPE_API_KEY",
      "temperature": 0,
      "maxTokens": 64
    },
    "ollama": { "baseUrl": "http://127.0.0.1:11434", "model": "qwen2.5:7b" },
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  },
  "match": {
    "fuzzyThreshold": 0.9,
    "suspiciousThreshold": 0.8,
    "acceptSuspicious": false,
    "candidateLimit": 200
  },
  "cache": { "maxEntries": 10000, "flushIntervalMs": 30000 },
  "writeback": { "enabled": true, "requireVerified": false }
}
```

环境变量优先级高于配置文件。缺失 `DASHSCOPE_API_KEY` 时应打印清晰提示并把
`bailian` 从 fallback 链里剔除，而不是崩溃。

**providers 可选新字段（Patch 8，2026-11-23 用户批准；预置表与来源见 `lib/ai/presets.js`）**：

| 字段 | 缺省 | 含义 |
|---|---|---|
| `impl` | 按实例名推断 | 实现种类，仅 `'openai'` 或 `'ollama'`；未知值 → 剔除 + 警告一次 |
| `preset` | 无 | 预置名（11 家内置之一）；提供默认值包（baseUrl/model/apiKeyEnv/temperature/maxTokens），逐字段可被配置覆盖；与显式 `impl` 冲突 → 剔除 + 警告一次 |
| `maxTokensParam` | `'max_tokens'` | `'max_completion_tokens'` 生效，其余值一律 `max_tokens` |
| `omitTemperature` | `false` | `true` → 不发送 `temperature` 字段 |
| `extraHeaders` | 无 | 对象，合并入请求头（非敏感头；鉴权头永远由环境变量 Key 生成且最后写入） |
| `apiKeyHeader` | `'authorization'` | 自定义头名发裸 Key 值；缺省或 `'authorization'` → `Authorization: Bearer <Key>` |
| `query` | 无 | 对象，`URLSearchParams` 拼入 URL（为 Azure `api-version` 留口） |

名字推断规则（`impl`/`preset` 两字段都缺省时，旧配置行为逐字不变）：`bailian` → dashscope 预置（openai impl）、
`openai` → openai 预置、`ollama` → ollama impl（**不补任何默认值，baseUrl 必须自带**）、其他名字 → openai impl 无预置。
`loadConfig` 保留任意实例名的 provider 条目（三个内置名仍合并 DEFAULTS）；`pruneFallback` 先经 `resolveInstance`
解析预置再按生效配置检查：缺 baseUrl 或缺 Key（按生效 `apiKeyEnv`）→ 剔除 + 提示；
本地预置免 Key（lmstudio / vllm / xinference / ollama-openai 无 `apiKeyEnv`，不因缺 Key 剔除）。

---

## 11. 数据导入

`tools/import.js` 支持：

| 格式 | 说明 |
|---|---|
| JSON | 原生结构，见 8.3 |
| CSV / TSV | 表头 `question,type,options,answer`，options 内部用竖线分隔 |
| TXT | 常见题库文本，按题型关键字 + 空行切分，需容错解析 |

xlsx 不在零依赖范围内：让用户先用 Excel 另存为 CSV，
或作为可选增强单独引入 `xlsx` 包。

命令：`node tools/import.js --file ./data.csv --format csv --merge`

---

## 12. 验收标准

1. `node server.js` 启动无报错，`GET /health` 返回 200
2. 粘贴 4.4 节配置到 OCS，能搜到本地已有题目并正确填答
3. 本地无该题时走 AI，返回正确答案且**写入 bank.json**；
   第二次请求同题走 L1，**无任何 AI 调用**
4. 并发 20 个请求：服务不崩，AI 实际并发 <= 3，其余排队或返回 queue_full
5. 四种异常均返回 `code:0` 且进程不退出：断网/DNS 失败、401 无效 Key、
   DataInspectionFailed 审核拦截、请求超时
6. `tools/bench.js`：5 万条数据，L1 < 1ms，L2 p95 < 50ms
7. `tools/accuracy.js`：20 道真实题目测试集，AI 准确率 >= 85%
8. README 覆盖：安装、配置、OCS 对接、数据导入、故障排查

---

## 13. 实施里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| **M1** | 骨架：HTTP 服务、配置加载、CORS、静态假数据、/health /stats | 与 OCS 完成端到端握手 |
| **M2** | 归一化 + L1/L2 匹配 + trigram 索引 + store | 本地检索完全可用 |
| **M3** | AI 层：prompt、bailian provider、输出后处理、审核降级 | 新题能拿到 AI 答案 |
| **M4** | 工程化：并发闸、LRU 缓存、回写、导入工具、日志 | 生产可用 |
| **M5** | 验证：bench、accuracy、README、.env.example | 交付 |

按 M1 → M5 顺序推进，每阶段跑一次对应验收再进下一步。

---

## 14. 待决策项

1. **默认模型**：`qwen-flash`（最快最便宜）还是 `qwen-plus`（更准）？
   建议默认 `qwen-flash`，配置一行可切。
2. **是否要 Web 管理界面**（浏览/编辑/人工标记 verified）？
   建议 M5 之后再议，先纯 API + CLI。
3. **疑似匹配 0.8~0.9** 是否返回？建议默认 `false`，宁可不答不错答。
4. **存储**：5 万条内 JSON 够用；超 20 万条建议迁 SQLite（会引入依赖）。
5. **鉴权**：仅本机 127.0.0.1 使用则不需要；若部署公网必须加 token，
   否则会被陌生人刷爆 API 额度。

---

## 15. 已知风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 百炼内容审核拦截 | 部分题目拿不到 AI 答案 | fallback 到 Ollama 本地模型；改用本地题库 |
| AI 输出格式不合规 | 填答失败 | 7.4 后处理 + 正则校验，不合规即判失败 |
| 客户端超时早于 AI 返回 | 答案到了页面已跳过 | 客户端调大超时；用快模型 + 限制 max_tokens |
| 并发打爆速率限制 | 429 | 并发闸 + 队列 + 指数退避 |
| 回写脏数据污染本地库 | 后续一直错答 | verified 字段 + requireVerified 开关 + .bak 备份 |
| 题目含图片/公式 | AI 必然答错 | 7.6 短路，直接 code:0 |
| API Key 泄露 | 额度被盗刷 | 只读环境变量、.env 加入 .gitignore、绑定 127.0.0.1 |
