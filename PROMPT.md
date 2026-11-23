# 角色

你是一名 Node.js 后端工程师。请为我实现一个**题库检索服务**（HTTP API），项目代号 `qbank`。

# 规格来源

完整技术规格在 `HANDOFF.md` 里，共 15 节。**开工前必须先完整读一遍**，它是唯一权威依据，
包含：接口契约、归一化管线、匹配算法、AI provider 设计、并发/缓存/回写策略、
目录结构、配置文件、验收标准、里程碑。

> 文件位置：`D:\codex and chat gpt\ocs刷题助手题库搭建\HANDOFF.md`
> （若路径不对，我会把该文件作为附件提供，以附件为准）

读完之后，用不超过 15 行复述你对架构的理解，等我确认后开始写代码。
如果规格里有自相矛盾或缺失的地方，**现在就一次性提出来**，不要边写边问。

# 核心约束（速览，与 HANDOFF.md 冲突时以 HANDOFF.md 为准）

1. **零第三方依赖**。只用 `node:http`、`node:fs`、`node:crypto`、`node:path`
   和内置 `fetch`。不要 `npm install` 任何东西，`package.json` 里不要出现
   `dependencies` 字段。
2. **Node.js >= 18**，ESM 或 CJS 二选一并全程统一。
3. 对外接口严格遵守 HANDOFF.md 第 4 节的请求/响应格式，**字段名和 `code` 语义不可改**——
   这是与客户端的硬约定。
4. 答案输出严格遵守第 4.3 节的格式约定：多选 `#` 连接、判断题为「正确/错误」、
   **绝不返回解释性文字**。
5. **进程永不因外部错误退出**。断网、401、超时、内容审核拦截、队列满、JSON 解析失败——
   全部转成 `{"code":0,"reason":"..."}` 返回。
6. AI provider 必须走 fallback 链（`bailian` → `ollama`），单家失败自动切下一家，
   全失败才返回 `code:0`。
7. API Key 只从环境变量读，**绝不硬编码进源码**，`.env` 写入 `.gitignore`。

# 工作方式

按 HANDOFF.md 第 13 节的 **M1 → M2 → M3 → M4 → M5** 顺序推进，
**每个里程碑做完就停下来**，跑一遍对应的验收项（第 12 节），把结果贴给我，
等我说「继续」再进下一阶段。

不要一次性把五个阶段的代码全写完再给我看。

每阶段产出要求：
- **M1**：能启动、`/health` 通、用假数据跑通一次端到端请求
- **M2**：`normalize.js` + `matcher.js` + `store.js`，附单元测试脚本
- **M3**：`prompt.js` + `answer.js` + `ai/bailian.js`，审核降级必须实现
- **M4**：`queue.js` + `cache.js` + 回写 + `tools/import.js`
- **M5**：`tools/bench.js` + `tools/accuracy.js` + `README.md` + `.env.example`

# 已经定好的决策，不要再问我

| 项 | 决定 |
|---|---|
| 默认模型 | `qwen-flash`（配置可切） |
| 百炼端点 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Web 管理界面 | **不做**，纯 API + CLI |
| 疑似匹配 0.8~0.9 | 默认**不采纳**（`acceptSuspicious: false`） |
| 存储 | JSON 文件，暂不上 SQLite |
| 鉴权 | 不做，服务只绑定 `127.0.0.1` |
| xlsx 导入 | 不支持，让用户先转 CSV |
| 项目根目录 | `D:\codex and chat gpt\ocs刷题助手题库搭建`（代码直接建在此目录下，不再套 `qbank/`） |

# 明确禁止

- 禁止引入任何第三方包（包括 `express`、`xlsx`、`dotenv`、`better-sqlite3`）
- 禁止在答案里编造内容；模型输出不合规就判失败，不要「猜一个看起来对的」
- 禁止把题目原文写进日志，日志只记 key 和错误码
- 禁止跳过第 7.5 节的内容审核降级逻辑——这是百炼的已知高发问题
- 禁止未经确认就改 HANDOFF.md 里定义的接口契约

# 现在的第一步

1. 读 `HANDOFF.md`
2. 用 <= 15 行复述架构理解
3. 列出规格中的疑问或矛盾（没有就说「无」）
4. 等我确认，然后开始 M1
