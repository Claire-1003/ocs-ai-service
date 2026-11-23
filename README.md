# qbank · 零第三方依赖的题库检索服务

给 [OCS（Open Course Script）](https://github.com/ocsjs/ocsjs) 用的本地题库后端。
对外兼容 OCS 开放题库协议（AnswererWrapper），对内实现
**「本地精确检索 → 模糊匹配 → 大模型兜底 → 结果回写」** 的三层混合架构。

- **零第三方依赖**：不需要 `npm install`，仓库里没有也不会有 `node_modules`
- **一条命令启动**：`node server.js`
- **同题永不重复调用 AI**：AI 答过的题写回 `data/bank.json`，第二次直接走本地 O(1) 命中
- **运行期高容错**：provider 可插拔、任意一路失败自动降级、外部输入 `try/catch`（启动阶段失败则快速退出，见 §11）
- **只绑本机**：默认 `127.0.0.1`，无鉴权（见 [已知局限](#10-已知局限)）

> **项目状态**：v1.0.0 · 个人学习与研究项目 · 按需维护（无商业支持）· MIT 许可证（见 [LICENSE](LICENSE)）· HANDOFF §12 八项验收已通过（证据见 `docs/ACCEPTANCE.md`）。

---

## 目录

1. [它能做什么](#1-它能做什么)
2. [安装与启动](#2-安装与启动)
3. [配置](#3-配置)
4. [OCS 对接](#4-ocs-对接)
5. [数据导入](#5-数据导入)
6. [性能与准确率验收](#6-性能与准确率验收)
7. [故障排查](#7-故障排查)
8. [项目结构](#8-项目结构)
9. [里程碑与验收清单](#9-里程碑与验收清单)
10. [已知局限](#10-已知局限)
11. [安全与隐私纪律](#11-安全与隐私纪律)

---

## 1. 它能做什么

OCS 在网页上遇到一道题时，会拿题干去问你配置的题库地址。qbank 收到请求后按固定管线处理：

```
OCS 浏览器脚本
   |  GET /api?q=<题干>&type=<题型>&options=<选项>
   v
server.js  ── HTTP 入口 / CORS / 路由
   v
normalize()  ── 归一化（全角转半角、去空白、去标点、去题号、去题型标记）
   v
L1 精确匹配   Map<key, Record>  O(1)      ── 命中 -> source=local
   v 未命中
L2 模糊匹配   长度分桶 + trigram 倒排裁剪  ── 命中 -> source=fuzzy
   v 未命中
内存 LRU 缓存                              ── 命中 -> source=cache
   v 未命中
图片 / 公式短路（不调 AI，省钱省时）        ── code:0, reason=image_or_formula
   v
并发闸（默认并发 3 / 队列 200）            ── 队列满 -> code:0, reason=queue_full
   v
LLM provider 链  bailian -> ollama (-> openai)
   | 成功 -> 输出后处理 + 按题型正则校验 -> 回写 bank.json -> code:1, source=ai
   v 全链失败 / 审核拦截 / 超时
code:0 + reason（ai_error / ai_moderation / ai_timeout / ai_disabled / queue_full）
```

| 层 | 数据来源 | 典型耗时 | 说明 |
|---|---|---|---|
| L1 | `data/bank.json` | < 0.01ms | `sha256(归一化题干 + 排序后的归一化选项)` 做键，选项乱序也能命中 |
| L2 | 同上 | ~8ms（5 万条） | `score = 0.6 × Dice(bigram) + 0.4 × LCS_ratio`，`>= 0.90` 采纳 |
| L3 | 大模型 | 0.5~5s | 只处理「库里没有的新题」，答完立刻回写 |

---

## 2. 安装与启动

### 2.1 环境要求

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | **>= 18**（需要内置 `fetch` / `AbortController`） | `node -v` |
| 第三方依赖 | **无** | `ls node_modules` 应当报「找不到」 |
| 磁盘 | 5 万条题库约 19MB JSON | — |
| 可选 | Ollama（本地兜底模型） | `ollama --version` |

```powershell
node -v          # 期望 v18.x 或更高；本项目在 v24 上验证过
```

低于 18 会怎样：`fetch is not defined`，AI 链路整条不可用（本地检索仍能跑）。请升级 Node。

### 2.2 零依赖说明

`package.json` 里 **没有 `dependencies`，也没有 `devDependencies`**，只用 `node:` 内置模块：
`node:http` `node:fs` `node:path` `node:crypto` `node:url` `node:test` `node:assert/strict`。

所以：

```powershell
# 不需要执行 npm install。执行了也不会有任何东西被装进来。
git clone <你的仓库地址> qbank
cd qbank
node server.js
```

测试用 Node 自带的 test runner（`node:test`），不需要 jest / mocha。

### 2.3 启动

```powershell
node server.js
```

正常会看到（stderr）：

```
[qbank][server][listening] http://127.0.0.1:8080 ai=bailian->ollama
```

- 没配 `DASHSCOPE_API_KEY` 时会多一行 `[qbank][config][no_key_bailian] ...`，
  这是**提示不是错误**：服务照常启动，只是把 `bailian` 从链上剔除，剩下 `ollama`。
- 想改端口：`$env:QBANK_PORT="9000"; node server.js`（bash/zsh 用 `QBANK_PORT=9000 node server.js`）。
- 停服务：`Ctrl+C`。收到 `SIGINT`/`SIGTERM` 会先把缓存和题库落盘再退出。

### 2.4 冒烟自测（30 秒确认装对了）

```powershell
# 1) 造一条占位数据并导入（内容纯属示例，实际用时换成你自己的题库文件）
#    ⚠ 先导入、后启动：服务启动时把 bank.json 加载进内存，
#    服务运行中导入的新数据必须重启服务才生效（T6 实测修正，见 docs/ACCEPTANCE.md §2.8）。
Set-Content -Path "$env:TEMP\qbank-demo.csv" -Encoding utf8 -Value @(
  'question,type,options,answer'
  '示例题干：甲等于多少,单选题,A.一|B.二|C.三|D.四,B'
)
node tools/import.js --file "$env:TEMP\qbank-demo.csv" --format csv --merge
#    期望 stdout：{"parsed":1,"imported":1,"skipped":0,"duplicates":0,"failed":0,"elapsed":14}（elapsed 为示例值，随机器波动）

# 2) 启动服务（保持这个窗口不关，另开一个窗口跑后面的 curl）
node server.js

# 3) 健康检查：期望 {"code":1,"status":"ok",...,"bank":1,...}
curl.exe "http://127.0.0.1:8080/health"

# 4) 查这道题：期望 {"code":1,...,"source":"local","answer":"B"}
#    URL 里三段依次是 q=示例题干：甲等于多少 / type=单选题 / options=A.一#B.二#C.三#D.四 的 URL 编码
curl.exe "http://127.0.0.1:8080/api?q=%E7%A4%BA%E4%BE%8B%E9%A2%98%E5%B9%B2%EF%BC%9A%E7%94%B2%E7%AD%89%E4%BA%8E%E5%A4%9A%E5%B0%91&type=%E5%8D%95%E9%80%89%E9%A2%98&options=A.%E4%B8%80%23B.%E4%BA%8C%23C.%E4%B8%89%23D.%E5%9B%9B"

# 5) 看统计：match.l1 应该有 1 次命中，ai.calls 应该是 0
curl.exe "http://127.0.0.1:8080/stats"
```

> PowerShell 里请用 `curl.exe`，不要用 `curl`（那是 `Invoke-WebRequest` 的别名，参数不兼容）。
> 浏览器里直接打开 `http://127.0.0.1:8080/health` 也可以。

不想配 Key 又想端到端看一遍流程？用内置假 AI：

```powershell
$env:QBANK_MOCK_AI="1"; node server.js      # AI 层用桩应答，不联网、不消耗额度、不回写 bank.json
```

### 2.5 跑测试

```powershell
node --test                       # 全量
node --test test/matcher.test.js  # 单个文件
node --test test/stubs/t5-selfcheck.js   # bench / accuracy 两个工具自身的自检
```

所有测试都遵守：**不监听固定端口**（一律 `listen(0)`）、**不读写仓库里的 `data/` 与 `logs/`**
（一律用 `os.tmpdir()` 下的临时目录并在结束时删除）、跑完自动退出（不留 `setInterval`）。

### 2.6 npm scripts（可选快捷方式）

`package.json` **没有 `dependencies` 字段**，只有几个脚本别名，等价于直接敲 `node` 命令：

| 命令 | 等价于 |
|---|---|
| `npm start` / `npm run dev` | `node server.js` |
| `npm test` | `node --test` |
| `npm run import -- --file a.csv --format csv` | `node tools/import.js --file a.csv --format csv` |
| `npm run genbank -- --count 50000` | `node tools/genbank.js --count 50000` |
| `npm run bench -- --file data/bench.json` | `node tools/bench.js --file data/bench.json` |
| `npm run accuracy -- --file test/fixtures/accuracy_set.json --mock` | `node tools/accuracy.js --file test/fixtures/accuracy_set.json --mock` |

> `npm run xxx` 后面要传参数必须加 `--` 分隔符。嫌麻烦就直接用 `node` 命令，本文档全篇都是这么写的。

---

## 3. 配置

配置的三个来源，**优先级从低到高**：

```
内置 DEFAULTS（config.js）  <  config.json  <  环境变量 / .env
```

`.env` 里写的值 **不会覆盖** 已经存在的真实环境变量（真实环境变量优先）。
`config.json` 缺失或不是合法 JSON 时不会崩溃，只会打印一条告警并整体回退到内置默认值。

### 3.1 `config.json` 字段逐项说明

仓库里已经带了一份可直接使用的 `config.json`：

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

全部字段的逐项说明（默认值 / 含义 / 调整建议）见 [`docs/CONFIG-REFERENCE.md`](docs/CONFIG-REFERENCE.md) §1。

### 3.2 环境变量覆盖表

环境变量覆盖全表见 [`docs/CONFIG-REFERENCE.md`](docs/CONFIG-REFERENCE.md) §2。

超出范围的数值会被**收敛到边界**而不是报错（例如 `QBANK_CONCURRENCY=99999` 会变成 1024）。

表中 `*_API_KEY` 行不是 QBANK_ 覆盖变量，而是各预置 `apiKeyEnv` 默认引用的环境变量名（Patch 8）；自定义实例可用 `apiKeyEnv` 指定任意变量名。

```powershell
# PowerShell：当前会话临时生效
$env:DASHSCOPE_API_KEY = "sk-xxxxxxxx"
$env:QBANK_PORT = "9000"
node server.js
```

```bash
# bash / zsh
export DASHSCOPE_API_KEY=sk-xxxxxxxx
QBANK_PORT=9000 node server.js
```

### 3.3 `.env` 用法

```powershell
Copy-Item .env.example .env
notepad .env          # 把 DASHSCOPE_API_KEY= 后面填上你的 Key
node server.js
```

`.env` 解析规则（自己实现的，不依赖 dotenv）：

- 逐行 `KEY=VALUE`；支持 `export KEY=VALUE` 前缀
- `#` 开头整行是注释；**未加引号**时允许行尾注释（`KEY=value # 注释`）
- 值两侧的双引号/单引号会被剥掉
- 允许 UTF-8 BOM、CRLF
- **真实环境变量优先**：`.env` 不会覆盖已经存在的同名环境变量
- `.env` 已在 `.gitignore` 里，**永远不要提交**

### 3.4 申请 API Key（按厂商列举，Patch 8 起 provider 中立）

以百炼（preset `dashscope`，默认链成员）为例：

1. 打开 <https://bailian.console.aliyun.com/>，用阿里云账号登录
2. 右上角头像 →「API-KEY」→ 创建新的 API-KEY（形如 `sk-xxxxxxxx`）
3. 复制，填进 `.env` 的 `DASHSCOPE_API_KEY=`
4. 验证：

```powershell
node tools/accuracy.js --file test/fixtures/accuracy_set.json --provider bailian --limit 2
```

注意事项：

- 端点必须是 **OpenAI 兼容模式**：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- 新用户一般有免费额度；`qwen-flash` 单价很低，20 道题评测合计约 5241 tokens（实测见 `docs/ACCEPTANCE.md` §2.7），花费在几分钱以内
- Key 泄露 = 额度被盗刷。只走环境变量、只绑 `127.0.0.1`、不要写进 `config.json`、不要贴进 issue

**其他厂商 Key 申请入口（Patch 8；预置默认值见 `lib/ai/presets.js`，来源注于其注释）**：

| 预置 | 控制台 / 文档 | 环境变量（预置默认 `apiKeyEnv`） | 默认模型 |
|---|---|---|---|
| `dashscope` | <https://bailian.console.aliyun.com/> | `DASHSCOPE_API_KEY` | `qwen-flash` |
| `openai` | <https://platform.openai.com/api-keys> | `OPENAI_API_KEY` | `gpt-4o-mini` |
| `deepseek` | <https://platform.deepseek.com/api_keys> | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `kimi` | <https://platform.moonshot.cn/console/api-keys> | `MOONSHOT_API_KEY` | `moonshot-v1-8k` |
| `zhipu` | <https://open.bigmodel.cn/usercenter/apikeys> | `ZHIPU_API_KEY` | `glm-4-flash` |
| `siliconflow` | <https://cloud.siliconflow.cn/account/ak> | `SILICONFLOW_API_KEY` | `Qwen/Qwen2.5-7B-Instruct` |
| `openrouter` | <https://openrouter.ai/keys> | `OPENROUTER_API_KEY` | `deepseek/deepseek-chat` |
| `lmstudio` / `vllm` / `xinference` / `ollama-openai` | 本地服务，**免 Key** | 无 | `local-model`（占位，须覆盖为实际加载/部署模型名）/ `qwen2.5:7b`（ollama-openai） |

入链方式见 §3.6「一条配置接任意兼容厂商」。

### 3.5 Ollama 本地部署（可选备用 provider，免 Key、免审核）

百炼有内容安全审核，思政/时政/法律类题目容易被拦。本地模型没有这个问题，适合做兜底。

> **可选**：不装 Ollama 完全不影响云端 provider（默认链 bailian）。未安装时备用链调用恒失败（属预期：2026-11-22 实测
> ollama 35/35 失败、bailian 正常兜住）；介意失败计数可设 `$env:QBANK_AI_FALLBACK="bailian"` 只走主力。

```powershell
# 1) 装 Ollama（https://ollama.com/download），然后启动服务
ollama serve            # 已作为系统服务运行时可跳过

# 2) 拉模型（约 4.7GB）
ollama pull qwen2.5:7b

# 3) 确认服务活着
curl.exe http://127.0.0.1:11434/api/tags

# 4) 只用本地模型跑
$env:QBANK_AI_FALLBACK = "ollama"
node server.js
```

- 想换模型：`ollama pull qwen2.5:14b`，再设 `$env:QBANK_OLLAMA_MODEL="qwen2.5:14b"`
- 7B 模型的准确率明显低于 `qwen-flash`，**建议只当兜底**，链顺序保持 `["bailian","ollama"]`
- `tools/accuracy.js` 在调用前会先探活 `http://127.0.0.1:11434/api/tags`，
  连不上就直接报「无法评测」（退出码 2），不会刷出 20 个假 FAIL
- 也可走 Ollama 的 **OpenAI 兼容端点**（预置 `ollama-openai`，`http://127.0.0.1:11434/v1`，免 Key）：
  `providers` 加一条 `{"preset":"ollama-openai","model":"qwen2.5:7b"}` 并把实例名列入 `ai.fallback`（见 §3.6）；
  该路径走 openai 通用体，与上面的原生 `/api/chat` 不同

### 3.6 一条配置接任意兼容厂商（Patch 8，2026-11-23 用户批准）

Patch 8 起 AI 层 provider 中立：OpenAI Chat Completions 兼容为唯一主协议，百炼只是内置预置之一。
**任何实现兼容协议的服务，加一条配置即可入链，零代码改动。**内置预置 11 家（默认值逐字段可被配置覆盖；来源见 `lib/ai/presets.js` 注释）：

| 预置 | baseUrl | 默认模型 | Key 环境变量 |
|---|---|---|---|
| `dashscope`（百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-flash` | `DASHSCOPE_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `kimi`（Moonshot） | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | `MOONSHOT_API_KEY` |
| `zhipu` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `ZHIPU_API_KEY` |
| `siliconflow` | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` | `SILICONFLOW_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` | `OPENROUTER_API_KEY` |
| `lmstudio` | `http://127.0.0.1:1234/v1` | `local-model`（占位，覆盖为实际加载模型） | 免 Key |
| `vllm` | `http://127.0.0.1:8000/v1` | `local-model`（占位，覆盖为实际部署名） | 免 Key |
| `xinference` | `http://127.0.0.1:9997/v1` | `local-model`（占位，覆盖为实际部署名） | 免 Key |
| `ollama-openai` | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` | 免 Key |

**例 1：预置 + 自定义实例名**（同一厂商可多实例并存；stats/日志以实例名为键）：

```json
{
  "ai": { "fallback": ["my-ds", "my-local"] },
  "providers": {
    "my-ds": { "preset": "deepseek" },
    "my-local": { "preset": "lmstudio", "model": "qwen2.5-7b-instruct" }
  }
}
```

```powershell
$env:DEEPSEEK_API_KEY = "sk-xxxxxxxx"   # Key 只走环境变量，绝不进 config.json
node server.js
```

**例 2：任意兼容服务的裸配置**（不用预置，自带 baseUrl/model/apiKeyEnv）：

```json
{
  "ai": { "fallback": ["vendor-x"] },
  "providers": {
    "vendor-x": {
      "baseUrl": "https://api.vendor-x.com/v1",
      "model": "vendor-x-chat",
      "apiKeyEnv": "MY_VENDOR_KEY"
    }
  }
}
```

**协议差异开关**（全可选，字段表见 §3.1）：Azure 风格服务可用
`"apiKeyHeader": "api-key"`（发裸 Key）+ `"query": { "api-version": "2024-06-01" }` +
`"maxTokensParam": "max_completion_tokens"` + `"omitTemperature": true`（Azure 原生适配器为二期提案，一期不做）。

**防御行为**：未知 `impl` / `preset`、或两者冲突 → 该实例剔除 + stderr 警告一次（只含实例名/错误码），永不崩溃；
缺 baseUrl 或缺 Key（按生效 `apiKeyEnv`）→ 同样剔除并提示。**旧配置（无新字段）行为逐字不变**：
`bailian`/`openai`/`ollama` 按名字推断到原预置/impl，默认链 `["bailian","ollama"]` 不受影响。

---

## 4. OCS 对接

### 4.1 题库配置 JSON（直接粘贴，逐字可用）

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

> ⚠ 2026-11-22 实测修正（D1）：旧模板曾误写 `"method":"fetch"`，OCS 客户端会直接拒绝（红字「不支持的请求方式」）。
> 官方 schema：`method∈{get,post}`、`type∈{fetch,GM_xmlhttpRequest}`、`contentType∈{json,text}`
> （<https://docs.ocsjs.com/docs/other/api>）。上面是修正后的可用配置，已在超星页面实测连通并自动填答。

字段含义：

| 字段 | 说明 |
|---|---|
| `name` | 在 OCS 题库列表里显示的名字，随便改 |
| `url` | 服务地址。`${title}` / `${type}` / `${options}` 是 **OCS 的占位符**，由 OCS 在发请求前替换成真实内容，服务端不需要关心 |
| `method` | HTTP 方法。OCS 官方 schema 只允许 `get` / `post`，本服务用 **`get`**（误写 `fetch` 会被 OCS 拒绝：红字「不支持的请求方式」） |
| `type` | 请求实现，`fetch` 或 `GM_xmlhttpRequest`，用 **`fetch`** 即可 |
| `contentType` | 响应解析方式，`json` 或 `text`。本服务返回 JSON，用 **`json`** |
| `headers` | 留空即可。本服务无鉴权 |
| `handler` | **关键**。返回值约定见下 |

`handler` 的返回值约定：

- 返回 `[题目, 答案]` —— 单条结果
- 返回 `[[题目, 答案], ...]` —— 多条结果
- 返回 `undefined` —— 这条结果无效（本服务用 `res.code !== 1` 表示「没搜到」）

> 响应里除了 `code` / `question` / `answer` / `reason` 还会带一个 `elapsed`（毫秒），
> 属于额外字段，`handler` 不读它就完全无害。
> 所有响应都是 `application/json; charset=utf-8`，带 `Access-Control-Allow-Origin: *`，
> 并且实现了 `OPTIONS` 预检，浏览器扩展直接跨域调用没有障碍。

### 4.2 在 OCS 里新增题库

不同版本的 OCS 菜单名略有差异，路径大致是：

1. 打开任意网课页面，点 OCS 悬浮球 / 侧边栏图标
2. 进 **设置** → **题库设置**
3. 找到 **自定义题库**（有的版本叫「添加题库」「导入题库配置」）
4. 粘贴上面那段 JSON，保存
5. **刷新网课页面**（配置改了不刷新不生效，这是最常见的坑）

保存后可以在 OCS 的题库测试入口验证，或直接手动访问（中文与 `#` 必须 URL 编码）：

```
http://127.0.0.1:8080/api?q=<题干>&type=<题型>&options=<A.选项一%23B.选项二%23C.选项三%23D.选项四>
```

一条已经编码好、可以直接跑的命令见 [§2.4](#24-冒烟自测30-秒确认装对了) 第 4 步。
浏览器地址栏可以直接写中文，不用手动编码。

### 4.3 「搜不到题」排查顺序

按这个顺序查，90% 的问题在第 2、3 步：

1. **服务起来了吗**
   `curl.exe http://127.0.0.1:8080/health`
   正常返回 `{"code":1,"status":"ok",...,"ai":{"enabled":true,"chain":["bailian","ollama"]}}`。
   连不上 → 看 `node server.js` 的窗口有没有报错，端口对不对。
2. **地址写的是 `127.0.0.1` 而不是 `localhost`**
   Windows 上 `localhost` 可能解析成 IPv6 `::1`，而服务默认只绑 IPv4 `127.0.0.1`，
   于是表现为「浏览器里打得开、OCS 里搜不到」或者反过来。统一写 `127.0.0.1`。
   端口要和 `config.json` 的 `port`（或 `QBANK_PORT`）一致。
3. **库里真的有这道题吗**
   把 OCS 页面上的题干原文一字不改地手动查一次 `/api`。
   注意 `curl.exe` 在 PowerShell 里要给 URL 加引号，否则 `&` 会被解释成后台执行：
   ```powershell
   curl.exe "http://127.0.0.1:8080/api?q=xxx&type=单选题&options=A.a#B.b"
   ```
   中文建议先 URL 编码，或者直接用浏览器地址栏。
4. **归一化能吃掉什么、吃不掉什么**
   空格、全角半角、标点、大小写、题号（`1.` / `（1）` / `一、`）、题型标记（`【单选题】`）
   全部会被抹平，**这些差异不影响命中**。
   但「措辞不一样」（同一道题换了个说法）L1 不会命中，只能靠 L2 模糊或 AI。
5. **看响应里的 `reason`**
   `code:0` 时 `reason` 直接告诉你为什么失败，对照 [§7.1](#71-按-reason-逐条排查) 处理。
6. **AI 链是否可用**
   `/health` 的 `ai` 字段是 `{"enabled":..., "chain":[...]}`：`chain` 是**当前解析出来的
   provider 链**（配好 baseUrl / Key 的那些），`enabled` 是 AI 总开关的实时状态（T6/P0-8 起暴露）。
   - `chain` 为空 → 所有新题都会 `ai_error`（stderr 有「未配置任何可用 provider」中文提示）。
   - 缺 `DASHSCOPE_API_KEY` 时 `bailian` 会被自动剔除，stderr 有中文提示。
   - **注意**：`enabled: false`（`QBANK_AI_ENABLED=false`）**不会**清空 `chain`，
     但所有 AI 调用会直接短路成 `reason: ai_disabled`。
     「链非空却全是 ai_disabled」时先看 `/health` 的 `ai.enabled`。
   - `/stats` 的 `ai.calls` / `ai.success` / `ai.failed` / `ai.chain` 能看到调用是否真的发生了。
7. **浏览器 console 有没有 CORS 报错**
   本服务发 `Access-Control-Allow-Origin: *`，正常不会报。
   若报错，多半是请求打到了别的端口/别的进程，或者被本地代理改写了响应头。
8. **两个容易忽略的开关**
   - `match.acceptSuspicious = false`（默认）会丢掉得分 `0.80 ~ 0.90` 的「疑似」候选。
     如果你的题库同源、错配风险低，可以设 `true` 换更高召回。
   - `writeback.requireVerified = true`（或 `QBANK_REQUIRE_VERIFIED=true`）时，
     **题库层（L1/L2）只采信 `verified:true` 的条目**：AI 回写的未验证答案仍会入库，
     但下一次查询不会把它当本地命中，而是继续走 AI；缓存层不受此限制（DECISIONS #6）。
     用 `POST /admin/verify` 人工核验后才会被题库层采信（§5.7）。
9. **OCS 客户端缓存截胡（重测本地命中前必清）**
   OCS 自己有一层「题库缓存」：搜到过的题存在客户端本地，下次直接出结果并带 **「题库缓存」标签**，
   根本不打服务端 —— 表现为「页面有答案但 `/stats` 的 `match.l1` 不动」。
   清空路径：**设置 → 通用 → 拓展应用 → 题库缓存 → 清空题库缓存**，然后**重新点击题号**再搜。
   判定服务端真命中：`match.l1` 增量 **且** 结果无「题库缓存」标签（2026-11-22 §12.2 实测口径）。

---

## 5. 数据导入

### 5.1 命令总览

```powershell
node tools/import.js --file <路径> --format csv|tsv|txt|json [选项]
```

| 选项 | 说明 |
|---|---|
| `--file`, `-f` | 待导入文件（必填） |
| `--format` | `csv` / `tsv` / `txt` / `json`，省略时按扩展名推断 |
| `--merge` | **默认**。与目标库合并，按 `key` 跳过已存在条目 |
| `--replace` | 整库替换，旧记录全部丢弃（仍会先生成 `.bak`） |
| `--dry-run` | 只统计不写盘，用来先看看这份数据能进多少条 |
| `--type <题型>` | 数据行缺题型时的兜底题型，如 `--type 单选题` |
| `--out`, `-o` | 目标题库文件，默认 `data/bank.json` |
| `--verified` | 导入条目 `verified` 置 `true`（默认 `false`） |
| `--verbose` | 额外诊断打到 stderr，**只有行号与错误码，绝无题目原文** |

stdout 输出统计 JSON（`elapsed` 单位 ms，为示例值、随机器与数据量波动），退出码 `0` 成功 / `1` 失败：

```json
{ "parsed": 120, "imported": 118, "skipped": 0, "duplicates": 2, "failed": 0, "elapsed": 43 }
```

### 5.2 CSV / TSV：表头与竖线约定

表头固定四个字段（**顺序无所谓、大小写无所谓、带中文冒号也能认**，如 `Question：`）：

```csv
question,type,options,answer
示例题干：甲等于多少,单选题,A.一|B.二|C.三|D.四,B
示例题干：乙属于哪几类,多选题,A.甲|B.乙|C.丙|D.丁,A#B#D
示例题干：丙的说法是否正确,判断题,A.正确|B.错误,正确
示例题干：丁的取值是____,填空题,,42
```

（上面是格式示例，题干与选项都是占位文本，换成你自己的数据即可。）

表头**按名字匹配、不按位置**，所以列顺序可以随意，还认这些别名（大小写、空白、结尾中英文冒号都忽略）：

| 规范字段 | 可接受的表头写法 |
|---|---|
| `question` | `question` / `title` / `q` / `stem` / `题干` / `题目` / `试题` / `问题` / `内容` |
| `type` | `type` / `qtype` / `questiontype` / `题型` / `类型` / `题目类型` |
| `options` | `options` / `option` / `choices` / `choice` / `选项` / `备选项` / `候选项` |
| `answer` | `answer` / `ans` / `correctanswer` / `correct` / `答案` / `参考答案` / `正确答案` / `标准答案` / `本题答案` |

**`question` 与 `answer` 两列是必需的**（`type` / `options` 可选），缺了会直接报 `bad_request` 并退出码 1，不会静默导入一堆垃圾。
`options` 单元格优先按竖线切；没有竖线时退回归一化模块的切分规则（`#` → 换行 → `;`/`；` → `A.` 标号）。

**关键约定：选项内部用竖线 `|` 分隔，不能用逗号** —— 逗号是 CSV 的字段分隔符，
用了会把一列拆成好几列。

- 支持标准 CSV 引号字段：字段里有逗号/换行时用 `"..."` 包起来，字段内的引号写成 `""`
- 支持 UTF-8 BOM 与 CRLF
- TSV 就是制表符分隔，其余规则相同，`--format tsv`
- 多选答案写 `A#C`（字母升序、`#` 连接）；判断写 `正确` / `错误`；多空填空用 `#` 连接
- 题型写法宽松（T6/P0-2）：`不定项` / `不定项选择题` / `多项选择题` 等统一归一为 `多选题`，
  `单项` / `单项选择题` 归一为 `单选题`。缺 `type` 列时按答案推断：有 >=2 个选项且答案是
  多字母形态（`ACD`、`A、C、D`、`A,C,D` 等）→ 多选题；单字母 → 单选题。
  多选题答案恰好只有一个字母（如 `B`，不定项常见）也合法，不会被格式校验拒掉

### 5.3 TXT：容错能力与局限

`--format txt` 按「题型关键字 + 空行」切分题目块，能容错这些常见写法：

| 能处理 | 例子 |
|---|---|
| 题号前缀 | `1.` `1、` `(1)` `（1）` `一、` `第1题` |
| 题型标记 | `【单选题】` `[多选题]` `单选题：` `判断题` |
| 答案标记 | `答案：` `参考答案：` `正确答案：` |
| 多选答案写法 | `A、C、D` → 自动转 `A#C#D` |
| 判断答案写法 | `对` → `正确`，`错` → `错误` |
| 选项挤在一行 | `A.键盘 B.鼠标 C.显示器 D.打印机` 会自动拆开 |

**局限**：没有任何题型标记、没有空行分隔的纯散文式文本切不开，
这些块会被计入 `skipped`（`failed` 统计的是切出后逐条格式校验失败的条目，二者不同）。
看 stdout 的 `parsed` / `imported` / `skipped` / `failed` 就知道效果，
`skipped` 很大时先加 `--verbose` 看是哪些行号出的问题（日志里不会打印题目内容）。

### 5.4 JSON

两种结构都认：

```json
{ "version": 1, "records": [ { "type": "单选题", "title": "...", "options": "A.xx#B.xx", "answer": "A" } ] }
```

或者直接一个裸数组 `[{...}, {...}]`。

- `options` 可以是数组 `["A.xx","B.xx"]`，也可以是 `#` 或 `|` 连接的字符串
- 缺 `key` 会自动用 `sha256(归一化题干 + 排序归一化选项)` 补上
- 非对象元素、缺 `answer` 的元素 → 计入 `failed`，不影响其余条目

### 5.5 xlsx 为什么不支持

本项目 **零第三方依赖**，解析 xlsx（本质是 zip + XML + 共享字符串表）需要引包，
和这个约束冲突。解决办法：

> Excel / WPS 打开 → 另存为 → **CSV UTF-8（逗号分隔）** → 按 §5.2 导入。

### 5.6 生成压测数据（genbank）

```powershell
node tools/genbank.js --count 50000 --out data/bench.json --seed 42
```

| 选项 | 说明 |
|---|---|
| `--count` | 条数，默认 50000 |
| `--out` | 输出文件，默认 `data/bench.json` |
| `--seed` | PRNG 种子，默认 42。**同 seed 逐字节可复现**，方便对比不同版本的性能 |

stdout 输出 `{count, nearDuplicates, collisions, generateMs}` 摘要。
5 万条约 19MB、不到 1 秒生成完毕。

### 5.7 人工标记「已验证」

AI 回写的条目默认 `verified: false`。核对无误后可以标记为可信：

```powershell
curl.exe -X POST http://127.0.0.1:8080/admin/verify -H "Content-Type: application/json" -d '{\"key\":\"<64位key>\",\"verified\":true}'
```

成功返回 `{"code":1,"key":"...","verified":true}`，并立刻落盘（写盘前生成 `.bak`）。
`key` 未知时保守返回 `code:0 / bad_request`。本服务**没有 Web 管理界面**，只有这个 JSON 接口。

---

## 6. 性能与准确率验收

两个工具都**只读**，不监听端口、不改仓库里的 `data/`，可以放心跑。

### 6.1 性能基准 `tools/bench.js`

```powershell
# 1) 先生成 5 万条压测数据（同 seed 可复现）
node tools/genbank.js --count 50000 --out data/bench.json --seed 42

# 2) 跑基准（默认 L1 采样 10000 次、L2 采样 2000 次、预热 200 次）
node tools/bench.js --file data/bench.json

# 3) 机器可读输出，便于归档
node tools/bench.js --file data/bench.json --json
```

| 选项 | 说明 |
|---|---|
| `--file`, `-f` | 题库文件，必填。`{"version":1,"records":[...]}` 与裸数组两种结构都认 |
| `--l1 <n>` | L1 精确命中路径采样次数，默认 10000（自动收敛到题库条数） |
| `--l2 <n>` | L2 模糊路径采样次数，默认 2000。**对题干改 1~2 个字**，强制走模糊 |
| `--warmup <n>` | 每阶段正式采样前的预热次数，默认 200（预热样本不计入统计） |
| `--json` | 只输出机器可读 JSON |
| `--verbose` | 内部错误时打印堆栈 |

计时全部用 `process.hrtime.bigint()`（纳秒级单调时钟），分位数用线性插值法（R type-7，与 numpy 默认一致）。
输出包含样本数、avg、p50、p95、p99、max、命中率、精确/模糊拆分、`rss` / `heapUsed` 内存、
以及索引构建耗时、trigram 索引条目数与倒排总数、平均每查询候选数。

示例输出（一次真实运行，Node v24，5 万条，`--l1 2000 --l2 400 --warmup 50`；**计时随机器与负载波动，仅供参考**，确定性统计可复现）。默认参数（L1 10000 / L2 2000 / 预热 200）的归档实测见 `docs/ACCEPTANCE.md` §2.6：

```
[qbank][bench] 题库=data/bench.json
[qbank][bench] 记录数=50000（原始 50000，跳过非法 0） 索引条目=50000 构建耗时=1021.524ms
[qbank][bench] trigram 索引：条目=11109 倒排总数=1338504 L2 平均候选数=200

阶段              样本数   avg(ms)   p50(ms)   p95(ms)   p99(ms)   max(ms)   命中率   精确/模糊
-----------------------------------------------------------------------------------------------
L1 精确命中         2000    0.0086    0.0081    0.0114    0.0223    0.2059   100.0%      2000/0
L2 模糊匹配          400    7.2091    7.0526   12.1771   14.2331   14.8999    66.8%       0/267

[qbank][bench] 内存 rss=330.22MB heapUsed=154.34MB heapTotal=280.66MB
[qbank][bench] 采样参数 l1=2000 l2=400 warmup=50 计时=process.hrtime.bigint()
[qbank][bench] 命中层级 L1 阶段：精确=2000 退回模糊=0 未命中=0 | L2 阶段：精确=0 模糊=267 未命中=133 疑似=0

[达标判定 HANDOFF §12.6] L1 avg 0.0086ms < 1ms [OK] | L2 p95 12.1771ms < 50ms [OK] -> PASS
```

**达标判定（HANDOFF §12.6）**：`L1 avg < 1ms` **且** `L2 p95 < 50ms` → `PASS`，否则 `FAIL`。
退出码：`0` = PASS，`1` = FAIL，`2` = 无法执行（缺文件、文件损坏、依赖模块未就绪）。

> L2 命中率不是达标项（合成数据的近似查询本来就有一部分改得太狠、低于 0.80 阈值），
> 它只用来确认「模糊路径真的被走到了」。上面 `0/267` 表示 400 个样本里 267 个走了模糊命中。

### 6.2 准确率评测 `tools/accuracy.js`

```powershell
# 真实链路（需要 API Key）
node tools/accuracy.js --file test/fixtures/accuracy_set.json --provider bailian --concurrency 3

# 归档报表
node tools/accuracy.js --file test/fixtures/accuracy_set.json --out docs/accuracy-report.json --json

# 离线自测（不联网、不花额度，CI 用）
node tools/accuracy.js --file test/fixtures/accuracy_set.json --mock

# 故意制造 20% 错误，验证 FAIL 分支与退出码 1
node tools/accuracy.js --file test/fixtures/accuracy_set.json --mock --mock-accuracy 0.8
```

| 选项 | 说明 |
|---|---|
| `--file`, `-f` | 测试集 JSON，必填。结构见 §6.3 |
| `--provider <name>` | 只用指定 provider（`bailian` / `ollama` / `openai`）；默认走 `config.ai.fallback` 整条链 |
| `--concurrency <n>` | 并发上限，默认 3，与 `config.ai.concurrency` 一致 |
| `--timeout <ms>` | 单题超时，默认 20000 |
| `--limit <n>` | 只跑前 n 题（0 = 全部），省额度的冒烟测试 |
| `--out <p>` | 报表写盘路径。**没有默认值**，不传就只打到 stdout |
| `--json` | stdout 只输出机器可读 JSON |
| `--mock` | 内置桩 provider，离线跑通报表逻辑 |
| `--mock-accuracy <0~1>` | 桩的模拟准确率，默认 1（全对） |

评测走**真实 AI 链路**（`lib/ai/index.js` + `lib/queue.js`），所以并发闸、退避、审核降级、
输出后处理这些线上会经过的代码全都被覆盖到了。

逐题输出：序号、题型、**题干前 8 个字**、**key 前 12 位**、期望答案、实际答案、provider、耗时、tokens、PASS/FAIL。

> **隐私纪律**：报表与日志里**永远不会出现完整题干、完整选项或任何真实 API Key**。
> 期望答案与实际答案是评分必需的，只出现在 stdout 与 `--out` 报表里，不进 `logs/`。

汇总输出：总准确率、分题型准确率、平均耗时、总 tokens（in/out）、失败原因分布（按 `reason` 计数）。

**达标判定（HANDOFF §12.7）**：总准确率 `>= 85%` → `PASS`，否则 `FAIL`。
退出码：`0` = PASS，`1` = FAIL，`2` = **无法执行**（缺 API Key / 测试集文件不存在 /
`ai.enabled=false` / provider 探活失败 / 参数错误）。退出码 2 **不计作 FAIL**——
没 Key 不等于准确率低，把它算成 0% 会污染验收数据。

### 6.3 测试集格式与本次的题目分布

`test/fixtures/accuracy_set.json` 是一个数组，每项：

```json
{
  "key": "可选，不填自动用 sha256(归一化题干+排序归一化选项) 计算",
  "type": "单选题",
  "title": "题干原文",
  "options": "A.选项一#B.选项二#C.选项三#D.选项四",
  "answer": "A"
}
```

本次 20 道题的分布（严格按 HANDOFF §12.7 的要求）：

| 题型 | 数量 | 答案格式 |
|---|---|---|
| 单选题 | 8 | `A` |
| 多选题 | 5 | `A#B#D`（字母升序） |
| 判断题 | 4 | `正确` / `错误` |
| 填空题 | 2 | 文本，多空用 `#` 连接 |
| 问答题 | 1 | 纯文本 |

选题原则：**答案客观唯一**、大学网课通识难度（计算机基础 / 网络 / 数制转换 / 大学语文 / 基础物理化学常识）、
**不含图片与公式**、**不涉及时政敏感话题** —— 后两条是因为百炼有内容安全审核，
被拦下来会记成 `ai_moderation`，那不是模型能力问题，留在测试集里只会污染准确率数据。
每道题的 `answer` 字段都经过逐题人工确认（T6 集成验收已再次逐题复核，结论见 `docs/ACCEPTANCE.md`）。

问答题的判定用「包含关键要点 **或** bigram Dice >= 0.6」双条件取或，
避免模型换个说法就被判错。

---

## 7. 故障排查

### 7.1 按 reason 逐条排查

`code:0` 时响应里的 `reason` 就是失败原因，取值固定为下面 8 个：

| reason | 含义 | 处置 |
|---|---|---|
| `no_match` | **只出现在 HTTP 404**：访问了未知路径。`/api` 上本地未命中会继续走缓存/AI，失败时给的是 `ai_*` / `image_or_formula` / `ai_disabled`，**不会**给 `no_match`（T6 裁决，见 ACCEPTANCE） | 检查 URL 路径拼写；OCS 配置里的 url 必须指向 `/api?q=...`。库里确实没有的题，导入它，或者让 AI 答一次（会自动回写） |
| `ai_timeout` | 单题超过 `ai.timeoutMs`（默认 20s）被 abort | 查网络/代理；换更快的模型（`qwen-flash`）；本地 Ollama 用 CPU 跑 7B 很容易超时，考虑 GPU 或调大 `QBANK_TIMEOUT_MS` |
| `ai_moderation` | 百炼内容安全审核拦截（`DataInspectionFailed`） | **不会对同一家 provider 重试**，直接降级到链上下一个。看 `logs/moderation.log` 与 `/stats` 的 `ai.moderation`。|
| `ai_error` | 整条链全部失败：网络错误、401 Key 无效、429 限流耗尽重试、模型输出不符合题型格式 | 先怀疑 Key：`401` 就是 Key 错/欠费/地域不对。再看 stderr 的 `[qbank][ai][...]` 错误码。输出不合规通常是模型太小，换 `qwen-plus` 试试 |
| `queue_full` | 并发闸队列满（默认并发 3、队列 200） | 降低请求速率；或调大 `QBANK_QUEUE_LIMIT` / `QBANK_CONCURRENCY`。这其实是保护机制在生效，不是 bug |
| `image_or_formula` | 题干含图片（`![`、`<img`、图片扩展名）或 LaTeX 公式（`\frac`、`\begin{`、`\sqrt`、`\sum`、两个以上 `$`） | **设计内短路**，根本不调 AI —— 纯文本模型看不到图，硬调只会浪费钱并给出错误答案。这类题只能靠本地题库命中 |
| `ai_disabled` | `config.ai.enabled = false`（`QBANK_AI_ENABLED=false`）。注意：**provider 链为空不算 ai_disabled**，那种情况返回 `ai_error` | 看 `/health` 的 `ai.enabled` 并打开开关；若是链为空（`ai.chain: []`）则配 `DASHSCOPE_API_KEY`，或起本地 Ollama 并把 `QBANK_AI_FALLBACK` 设成 `ollama` |
| `bad_request` | 请求本身不合法：缺 `q` 参数、POST body 超过 1MB、POST body 不是合法 JSON 对象（**表单编码 `a=1&b=2` 也算**，本服务只收 JSON）、`/admin/verify` 缺 `key`/`verified` 或 key 未知 | 检查 URL 参数与请求体（POST 请用 `Content-Type: application/json`）。OCS 正常发问不会触发 |

另外：归一化后题干长度 < 4 个字符的会被判定为「不可作答」（`isUnanswerable`），
同样走短路，不会浪费一次 AI 调用。

### 7.2 `/stats` 各字段怎么看

`curl.exe http://127.0.0.1:8080/stats`

各字段的含义与用法逐项说明见 [`docs/STATS-REFERENCE.md`](docs/STATS-REFERENCE.md)。

### 7.3 `bank.json` 损坏怎么回滚

每次落盘都是「先复制 `bank.json` → `bank.json.bak`，再写临时文件 + 原子 rename」，所以永远有一份上一代的完整备份：

```powershell
# 1) 先停服务（Ctrl+C），避免边写边覆盖
# 2) 回滚
Copy-Item data/bank.json.bak data/bank.json -Force
# 3) 重新启动
node server.js
```

注意 `.bak` **落后一代**：如果最后一次写入本身就是坏的（极少见，因为是原子 rename），
`.bak` 里是上一次的好数据。真的两个都坏了，就用 `tools/import.js` 从原始 CSV/TXT 重新导入。

服务启动时读到坏 JSON 会回退成空库并打 stderr 警告，**不会崩溃**，此时 `/health` 的 `bank` 为 0。

### 7.4 日志在哪、长什么样

| 位置 | 内容 |
|---|---|
| `logs/moderation.log` | 每行 `时间戳 key=<前12位> code=<错误码> provider=<名字>` |
| stderr | `[qbank][<模块>][<错误码>] ...`，以及 `[qbank][server][listening] ...` 这类启动信息 |
| stdout | 只有工具的统计 JSON / 报表，服务本身不往 stdout 写业务日志 |

**日志里绝不会出现题干、选项、答案原文，也不会出现任何真实 API Key。**
这是硬性纪律：题库内容可能涉及版权，Key 泄露会被盗刷额度。排查问题时请提供 `key` 前 12 位而不是题目原文。

### 7.5 其他常见问题

| 现象 | 原因与处置 |
|---|---|
| stderr `[qbank][server][boot_failed] EADDRINUSE` | 8080 被占。`$env:QBANK_PORT="8081"` 换端口（记得同步改 OCS 配置里的 url），或 `Get-NetTCPConnection -LocalPort 8080` 找到 PID 后结束它 |
| PowerShell 里 `curl` 行为怪异 | Windows PowerShell 的 `curl` 是 `Invoke-WebRequest` 的别名。请显式用 `curl.exe` |
| PowerShell 里 URL 带 `&` 报错 | `&` 是保留字符，URL 必须整体加双引号 |
| 中文查询在命令行里乱码 | 先 `chcp 65001`，或直接用浏览器地址栏 / OCS 发请求 |
| OCS 里改了配置不生效 | 必须**刷新网课页面** |
| 第二次查同一道题还是调了 AI | 检查 `writeback.enabled` 是否为 `true`；`QBANK_MOCK_AI=1` 模式下假数据只进 cache、**不写 bank.json** |
| 服务运行中导入新题库后查不到 | 服务启动时把 `bank.json` 加载进内存，运行中导入**不会热生效**：重启服务，或先导入再启动（§2.4） |
| 服务能起但 `/health` 里 `ai.chain` 是空数组 | 缺 `DASHSCOPE_API_KEY` 且本地没起 Ollama。见 §3.4 / §3.5。此时新题返回 `ai_error` |
| POST 发表单编码（`q=...&type=...`）返回 `bad_request` | 本服务 `/api` POST 只接受 JSON body（T3 裁决，T6 批准）。OCS 默认 GET/fetch JSON，不受影响；若你的 OCS 版本实测发表单编码，需回来给 server 加解析分支 |

### 7.6 提 issue 的最小复现模板

复制下面这段填好再提，**不要贴题目原文和 Key**：

```markdown
### 环境
- Node 版本：`node -v` 的输出
- 操作系统：Windows 11 / macOS 14 / Ubuntu 22.04
- qbank 版本 / commit：

### 复现步骤
1. 启动命令与环境变量（Key 用 sk-xxxxxxxx 占位）：
2. 触发的请求（题干可替换成等长的占位文本，保留题型与选项个数）：
3. 实际响应 JSON：
4. 期望结果：

### 相关日志
- stderr 中所有 `[qbank][...]` 行：
- `logs/moderation.log` 相关行（只含 key 前 12 位，可直接贴）：
- `/stats` 输出：
- `/health` 输出：
```

---

## 8. 项目结构

```
.                                  # 项目根目录
├── server.js                      # HTTP 入口、路由、CORS、优雅退出
├── config.js                      # config.json + 环境变量覆盖（loadConfig / resolvePaths / apiKeyFor）
├── config.json                    # 默认配置（可被环境变量覆盖）
├── package.json                   # "type": "module" + npm scripts，**没有 dependencies 字段**
├── lib/
│   ├── normalize.js               # 归一化 7 步 + key 生成 + 图片/公式检测
│   ├── matcher.js                 # L1/L2 匹配、长度分桶、trigram 倒排索引
│   ├── store.js                   # 题库读写、索引构建、原子落盘 + .bak
│   ├── cache.js                   # LRU + 定时落盘
│   ├── queue.js                   # 并发闸（createGate：run / drain / close / stats）
│   ├── answer.js                  # AI 输出后处理与按题型格式校验
│   ├── prompt.js                  # Prompt 模板（HANDOFF §7.3）
│   └── ai/
│       ├── index.js               # provider 路由 + fallback + 审核错误识别
│       ├── presets.js             # 11 家厂商预置默认值（Patch 8，来源注于注释）
│       ├── bailian.js             # 阿里云百炼（主力，OpenAI 兼容模式）
│       ├── openai.js
│       └── ollama.js              # 本地模型（免 Key、免审核）
├── tools/
│   ├── import.js                  # CSV / TSV / TXT / JSON 导入
│   ├── genbank.js                 # 合成压测题库（同 seed 逐字节可复现）
│   ├── bench.js                   # 性能基准（HANDOFF §12.6 判定）
│   └── accuracy.js                # 准确率评测（HANDOFF §12.7 判定）
├── data/                          # bank.json / cache.json / bank.json.bak / bench.json（均不入库）
├── logs/                          # moderation.log
├── test/                          # node:test 单元测试
│   ├── fixtures/                  # accuracy_set.json + 四种格式的导入样本
│   └── stubs/                     # 各任务自测用的桩
├── docs/
│   ├── CONTRACT.md                # 模块接口契约 + 文件所有权矩阵 + 并行隔离约束
│   ├── DECISIONS.md               # 规格矛盾裁决
│   ├── TASKS.md                   # 任务拆分与 DoD
│   ├── ACCEPTANCE.md              # T6 集成与验收报告（HANDOFF §12 逐条实测证据）
│   ├── accuracy-report.json       # 准确率评测归档报表（§12.7）
│   ├── evidence/                  # OCS 对接实测截图（§12.2）
│   ├── PROMPT_PREFIX.md           # 并行窗口统一 Prompt 前缀
│   ├── PROMPT_T6.md               # T6 集成与验收任务 Prompt
│   └── T1-T5-REPORTS.md           # T1–T5 交付汇总与裁决记录
├── HANDOFF.md                     # 技术规格（唯一权威的对外协议来源）
├── PROMPT.md                      # 项目原始构建 Prompt（角色与总需求）
├── .env.example                   # DASHSCOPE_API_KEY=
├── .gitignore                     # 忽略 data/ logs/ .env node_modules 等
└── README.md                      # 本文
```

---

## 9. 里程碑与验收清单

里程碑与验收属过程性文档，本节只留指针，不再内联重复表格（权威来源均在库内）：

- 实施里程碑（M1–M5）：`HANDOFF.md` §13。
- 验收标准（§12.1–12.8）：`HANDOFF.md` §12。
- 逐条实测证据（原始命令 + 原始输出）：`docs/ACCEPTANCE.md`。
- 日常快速验证：本文件 §2.4 冒烟自测、§6 性能与准确率验收。

## 10. 已知局限

明确说清楚边界，避免误用：

1. **JSON 文件存储，实用上限约 5 万条。**
   每次落盘都是全量写 + 生成 `.bak`，条数上去后写盘耗时和内存占用都会线性增长
   （5 万条约 19MB 文件、345MB RSS）。到 20 万条以上应该换 SQLite，
   但那会引入第三方依赖，与本项目「零依赖」的定位冲突，需要单独决策。
2. **无鉴权，只绑 `127.0.0.1`。**
   服务没有任何认证机制，安全性完全依赖「只监听本机回环」。
   **不要**把 `host` 改成 `0.0.0.0` 直接暴露到公网或局域网 ——
   任何人拿到地址就能白嫖你的 API Key 额度。
   确实需要远程访问，请自己套一层带鉴权的反向代理，或者用 SSH 隧道。
3. **不支持 xlsx。** 零依赖约束下不解析 Office 文件，请先另存为 CSV UTF-8（§5.5）。
4. **没有 Web 管理界面。** 人工验证条目只有 `POST /admin/verify` 这个 JSON 接口（§5.7）。
5. **图片题与公式题不做。** 检测到就短路返回 `image_or_formula`，不调多模态模型（§7.1）。
6. **百炼有内容安全审核。** 思政/时政/法律类题目拦截率偏高。
7. **本地题库优先于缓存。** 同一道题如果 bank 和 cache 里都有，以 bank 为准
   （bank 是持久化的权威数据，cache 只是省一次 AI 调用的临时层）。
8. **L2 模糊匹配对「措辞改写」无能为力。** 打分基于 bigram Dice + LCS，
   同义改述（「下列哪个」→「以下哪一项」之外的实质性改写）得分会掉到阈值以下，只能走 AI。
9. **回写会改变 bank.json。** 如果希望题库保持只读，设 `QBANK_WRITEBACK=false`。
10. **超星选项里的图片占位 URL（D3，已于 2026-11-22 修复）。** 真实课程页面的选项文字常混入编辑器
    图片占位链接（`https://mooc1.chaoxing.com/.../spacer.gif`），曾干扰 AI 输出格式导致 `invalid_output`
    （2026-11-22 实测 bailian 35/42 被拒收，干净题集对照 100%）。现在计算 key、送 AI、回写前会自动剥除
    杂质（markdown 图片、`<img>` 标签、图片资源 URL、常见占位文件名；普通文本与非图片 URL 不动）；
    选项清洗后为空（纯图片占位）时整题按 `image_or_formula` 拦截，fail-closed 宁可不答不错答不变。
    契约依据见 ACCEPTANCE §7 Patch 4（HANDOFF §5/§7.6 已写回）。
11. **纯文字选项会诱导 AI 抄文字（D5，已于 2026-11-22 修复）。** 超星有时只传选项文字、不带 `A.`/`B.` 标号。
    对带填空括号的多选题，qwen-flash 容易把选项文字当答案抄出来（如「感觉#知觉」）而非输出字母，被答案校验拒收
    （`invalid_output`）→ 页面红号。现在送 AI 前会给缺标号的选项按位置补 `A.`/`B.`/…（已有标号不动、幂等），
    模型即稳定输出字母。只影响 prompt，不改题库存储与匹配。契约依据见 ACCEPTANCE §7 Patch 5（HANDOFF §7.3 已写回）。
    注意：补标号解决「格式被拒」，AI 对个别题仍可能答错（回写默认未校验，可经 `/admin/verify` 或人工纠正）。
12. **判断题被超星标成【单选题】（D6，已于 2026-11-22 修复）。** 选项为 `√`/`×`（或 正确/错误、对/错 等）的判断题，
    超星页面与 OCS 传参常标成「单选题」。OCS 客户端的单选匹配器见到判断性质选项会改走判断匹配，只认
    「正确/错误/√/×」等语义词、不认字母；若题库按单选存字母，页面会黄条「答案和选项不匹配」且不自动选。
    现在服务端在题型判定时加「选项性质 override」：恰好两个判断语义选项 → 强制按判断题处理（优先于标签），
    AI 与校验链路输出「正确/错误」，OCS 即可自动选中 √/×。裸 `A`/`B` 文字选项不受影响。
    契约依据见 ACCEPTANCE §7 Patch 6（HANDOFF §4.3 / CONTRACT §1.4 已写回）。
13. **题干图片占位误短路纯文字题（D7，已于 2026-11-22 修复）。** 超星编辑器把 spacer.gif 等图片占位也混进**题干**（OCS 卡片显示碎图图标），
    曾使纯文字题被当图片题拦截 image_or_formula（0 结果+黄条）。现在题干在计算 key、图片判定、送 AI、回写前同样自动剥除图片杂质
    （与选项清洗同口径）；纯图片题干清洗后仍拦截（fail-closed），真·看图题由 AI 规则 7 UNKNOWN 兜底，不瞎答。
    契约依据见 ACCEPTANCE §7 Patch 7（HANDOFF §5/§7.6 / CONTRACT §1.3/§1.5/§5 已写回）。
14. **`tools/accuracy.js` 不感知预置（Patch 8 一期范围外的已知局限）。** 评测脚本的 `resolveChain` 直查
    `providers.<name>.baseUrl`，不走 `resolveInstance` 预置解析：只配裸 `{"preset":"deepseek"}` 的实例评测时
    需显式补 `baseUrl`（或使用内置三名 bailian/openai/ollama）。服务端链不受影响；评测脚本的预置感知留待后续提案。

---

## 11. 安全与隐私纪律

服务运行时会用到**使用者自有的 API Key**，并可能缓存**使用者自行导入、可能含第三方版权题目的题库内容**，所以下面几条是硬规矩：

- **Key 只走环境变量。** 写进 `.env`（已在 `.gitignore` 里）或系统环境变量，
  **绝不**写进 `config.json`、源码、README、issue、截图或日志。示例一律用 `sk-xxxxxxxx` 占位。
- **日志与报表里不出现题目原文。**
  `logs/moderation.log` 与 stderr 只记录：题目缓存 `key` 前 12 位、错误码、计数、耗时、provider 名、行号。
  `tools/accuracy.js` 的报表只显示题干前 8 个字。
  提 issue 时也请遵守同样的规则（§7.6 的模板）。
- **只绑 `127.0.0.1`。** 默认配置就是回环地址，不要为了方便改成 `0.0.0.0`。
- **运行期不轻易崩溃。** 所有外部输入（HTTP 请求、题库文件、AI 响应、命令行参数）都被 `try/catch` 包住，
  任何一路失败都降级成 `code:0 + reason`，而不是抛异常或退出；`uncaughtException` / `unhandledRejection` 也只记日志。
  `lib/` 里没有 `process.exit()`；模块顶层没有 I/O 与副作用。
  **例外**：启动阶段失败（如端口被占 `EADDRINUSE`、配置无法加载）会打 `[qbank][server][boot_failed]` 并 `exit(1)` 快速退出，不进入服务态。
- **AI 答案默认 `verified: false`。** 模型会犯错，未经人工核对的条目不该被当成权威数据。
  在意正确率就开 `writeback.requireVerified`，或者定期跑 `tools/accuracy.js` 抽查。

---

## 附：一分钟跑通

```powershell
# 0) 检查 Node（需要 >= 18）
node -v

# 1) 生成一点测试数据并导入
node tools/genbank.js --count 2000 --out data/bank.json --seed 42

# 2) 启动服务
node server.js

# 3) 另开一个窗口验证
curl.exe http://127.0.0.1:8080/health
curl.exe http://127.0.0.1:8080/stats

# 4) 把 README §4.1 的 JSON 粘进 OCS 题库设置，刷新网课页面
```

没有 API Key 也能跑通本地检索这一半：`$env:QBANK_MOCK_AI="1"` 会用内置假 AI 应答
（假数据只进 cache、不写 `bank.json`），适合先验证 OCS 握手与填答链路。

---

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布，Copyright (c) 2026 Claire-1003。许可证全文见仓库根目录 [`LICENSE`](LICENSE)。

---

## 免责声明

- 本项目（ocs-ai-service / ocs网课助手ai题库，内部代号 qbank）为个人学习与研究项目，仅供技术交流与研究用途。
- 本项目与 OCS 平台或任何课程平台均无关联，未获得其背书或授权；相关平台名称归其各自所有者。
- 使用者须自行遵守所在课程平台的服务条款及学校/机构的学术诚信规定。因使用本项目产生的一切后果（包括但不限于账号处罚、成绩作废、纪律处分）由使用者自行承担。
- 本仓库仅包含代码与合成样例题，不分发任何平台题库数据或用户作答记录；请勿上传、分享第三方版权题目内容。
- AI 生成的答案不保证正确性与完整性，不构成任何学术或专业建议。
- 本项目按 [MIT 许可证](LICENSE)「按原样」提供，不附带任何明示或暗示的担保；作者不对因使用本项目造成的任何直接或间接损失承担责任。
- 本声明不能豁免使用者在平台条款与学术诚信规定下应承担的义务，使用前请自行评估合规风险。
