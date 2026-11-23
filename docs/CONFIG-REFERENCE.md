# 配置参考：`config.json` 字段与环境变量覆盖

本文件是 README §3.1 / §3.2 的全量表格外置（表格内容自 README 原样迁出，未做改写）。安装、快速上手、`.env` 用法与 PowerShell/bash 设置示例仍见 README §3。

## 1. `config.json` 字段逐项说明

| 字段 | 默认值 | 含义 / 调整建议 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址。**保持默认**：服务无鉴权，绑 `0.0.0.0` 等于把 API 额度送给全网 |
| `port` | `8080` | 监听端口。改这里要同步改 OCS 配置里的 url |
| `cors` | `*` | `Access-Control-Allow-Origin`。OCS 是浏览器脚本，必须是 `*` 或你的油猴脚本域 |
| `ai.enabled` | `true` | 总开关。`false` 时只查本地库，未命中一律 `reason: ai_disabled` |
| `ai.fallback` | `["bailian","ollama"]` | provider 调用顺序，成员可为**任意实例名**，逐个尝试直到成功或耗尽。想用 OpenAI 就加 `"openai"`；接其他兼容厂商见 §3.6（Patch 8） |
| `ai.concurrency` | `3` | LLM 全局并发上限。调大容易撞 429 |
| `ai.queueLimit` | `200` | 排队上限，满了立即返回 `queue_full`，不占住 HTTP 连接 |
| `ai.timeoutMs` | `20000` | 单请求超时，用 `AbortController` 实现 |
| `providers.<name>.baseUrl` | 见上 | OpenAI 兼容端点。**注意百炼要带 `/compatible-mode/v1`** |
| `providers.<name>.model` | `qwen-flash` | 换 `qwen-plus` 更准更慢更贵；换 `qwen-turbo` 更快 |
| `providers.<name>.apiKeyEnv` | `DASHSCOPE_API_KEY` | **只写环境变量名，不写 Key 本身**（Key 永远不进配置文件） |
| `providers.<name>.temperature` | `0` | 题库场景必须 0，要的是稳定不是创意 |
| `providers.<name>.maxTokens` | `64` | 答案很短，给大了只会拖慢并多花钱 |
| `providers.<name>.impl` | 按名字推断 | **Patch 8 新增**：实现种类，仅 `openai`（OpenAI 兼容通用体）/ `ollama`（原生 /api/chat）；未知值 → 剔除 + 警告一次 |
| `providers.<name>.preset` | 无 | **Patch 8 新增**：预置名（11 家内置之一，见 §3.6）；提供 baseUrl/model/apiKeyEnv 等默认值，逐字段可覆盖；与显式 `impl` 冲突 → 剔除 |
| `providers.<name>.maxTokensParam` | `max_tokens` | **Patch 8 新增**：`max_completion_tokens` 生效（OpenAI 部分新模型要求）；其余值一律 `max_tokens` |
| `providers.<name>.omitTemperature` | `false` | **Patch 8 新增**：`true` → 不发送 `temperature` 字段（部分推理模型不接受） |
| `providers.<name>.extraHeaders` | 无 | **Patch 8 新增**：对象，合并入请求头（非敏感头；鉴权头永远由环境变量 Key 生成且最后写入） |
| `providers.<name>.apiKeyHeader` | `authorization` | **Patch 8 新增**：自定义头名发裸 Key 值；缺省或 `authorization` → `Authorization: Bearer <Key>` |
| `providers.<name>.query` | 无 | **Patch 8 新增**：对象，`URLSearchParams` 拼入 URL（为 Azure `api-version` 留口） |
| `match.fuzzyThreshold` | `0.9` | `>=` 此分直接采纳为 `source=fuzzy` |
| `match.suspiciousThreshold` | `0.8` | `[0.8, 0.9)` 记为「疑似」 |
| `match.acceptSuspicious` | `false` | 疑似要不要采纳。**建议保持 false**：宁可不答，不要错答 |
| `match.candidateLimit` | `200` | L2 候选集裁剪上限。调大会线性拖慢 L2 |
| `cache.maxEntries` | `10000` | 内存 LRU 容量 |
| `cache.flushIntervalMs` | `30000` | 缓存落盘周期（或每 100 次写入落盘一次） |
| `writeback.enabled` | `true` | AI 答完是否回写 `bank.json`。关掉就永远不会「学会」新题 |
| `writeback.requireVerified` | `false` | `true` 时 L1/L2 只采信 `verified:true` 的条目（缓存层不受此限制） |
| `dataDir` | `""`（= `<根>/data`） | 题库/缓存目录，一般不用改 |
| `logsDir` | `""`（= `<根>/logs`） | 日志目录，一般不用改 |
| `mockAi` | `false` | `true` 时用内置假 AI 应答，供离线联调 |

## 2. 环境变量覆盖表

| 环境变量 | 覆盖的配置 | 取值 / 范围 |
|---|---|---|
| `QBANK_HOST` | `host` | 字符串 |
| `QBANK_PORT` | `port` | 0~65535 |
| `PORT` | `port`（仅当没设 `QBANK_PORT`） | 0~65535 |
| `QBANK_CORS` | `cors` | 字符串 |
| `QBANK_DATA_DIR` | `dataDir` | 路径 |
| `QBANK_LOGS_DIR` | `logsDir` | 路径 |
| `QBANK_MOCK_AI` | `mockAi` | `1/true/yes` ↔ `0/false/no` |
| `QBANK_AI_ENABLED` | `ai.enabled` | 布尔 |
| `QBANK_AI_FALLBACK` | `ai.fallback` | 逗号分隔，如 `bailian,ollama,openai` |
| `QBANK_CONCURRENCY` | `ai.concurrency` | 1~1024 |
| `QBANK_QUEUE_LIMIT` | `ai.queueLimit` | 0~100000 |
| `QBANK_TIMEOUT_MS` | `ai.timeoutMs` | 500~600000 |
| `QBANK_MODEL` / `QBANK_BAILIAN_MODEL` | `providers.bailian.model` | 字符串（后者更明确，建议用它） |
| `QBANK_BAILIAN_BASE_URL` | `providers.bailian.baseUrl` | URL |
| `QBANK_OPENAI_MODEL` | `providers.openai.model` | 字符串 |
| `OLLAMA_BASE_URL` | `providers.ollama.baseUrl` | URL |
| `QBANK_OLLAMA_MODEL` | `providers.ollama.model` | 字符串 |
| `QBANK_FUZZY_THRESHOLD` | `match.fuzzyThreshold` | 0~1 |
| `QBANK_SUSPICIOUS_THRESHOLD` | `match.suspiciousThreshold` | 0~1 |
| `QBANK_ACCEPT_SUSPICIOUS` | `match.acceptSuspicious` | 布尔 |
| `QBANK_CANDIDATE_LIMIT` | `match.candidateLimit` | 1~100000 |
| `QBANK_CACHE_MAX_ENTRIES` | `cache.maxEntries` | 1~10000000 |
| `QBANK_CACHE_FLUSH_MS` | `cache.flushIntervalMs` | 1000~3600000 |
| `QBANK_WRITEBACK` | `writeback.enabled` | 布尔 |
| `QBANK_REQUIRE_VERIFIED` | `writeback.requireVerified` | 布尔 |
| `DASHSCOPE_API_KEY` | 百炼鉴权（被 `apiKeyEnv` 引用） | `sk-xxxxxxxx` |
| `OPENAI_API_KEY` | OpenAI 鉴权（被 `apiKeyEnv` 引用） | `sk-xxxxxxxx` |
| `DEEPSEEK_API_KEY` | DeepSeek 鉴权（`deepseek` 预置 `apiKeyEnv` 默认引用） | `sk-xxxxxxxx` |
| `MOONSHOT_API_KEY` | Kimi（Moonshot）鉴权（`kimi` 预置 `apiKeyEnv` 默认引用） | `sk-xxxxxxxx` |
| `ZHIPU_API_KEY` | 智谱鉴权（`zhipu` 预置 `apiKeyEnv` 默认引用） | `sk-xxxxxxxx` |
| `SILICONFLOW_API_KEY` | 硅基流动鉴权（`siliconflow` 预置 `apiKeyEnv` 默认引用） | `sk-xxxxxxxx` |
| `OPENROUTER_API_KEY` | OpenRouter 鉴权（`openrouter` 预置 `apiKeyEnv` 默认引用） | `sk-xxxxxxxx` |

超出范围的数值会被**收敛到边界**而不是报错（例如 `QBANK_CONCURRENCY=99999` 会变成 1024）。

表中 `*_API_KEY` 行不是 QBANK_ 覆盖变量，而是各预置 `apiKeyEnv` 默认引用的环境变量名（Patch 8）；自定义实例可用 `apiKeyEnv` 指定任意变量名。
