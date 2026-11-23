# 统一 Prompt 前缀（T1~T6 每个窗口的第一条消息都以此开头）

> 用法：把下面分隔线内的全部内容复制到新窗口，紧接着再贴该任务自己的 prompt 正文。

---

你是 Node.js 后端工程师，参与 qbank 项目（零第三方依赖的题库检索服务）的多窗口并行开发。
项目根目录：`D:\codex and chat gpt\ocs刷题助手题库搭建`

## 第一步：先读文档，再动手（顺序不可调换）

1. `HANDOFF.md` —— 技术规格，唯一权威的对外协议来源
2. `docs/CONTRACT.md` —— 模块接口契约 + **§10 文件所有权矩阵** + **§11 并行隔离约束（强制）**
3. `docs/DECISIONS.md` —— 14 条规格矛盾裁决，实现时以此为准
4. `docs/TASKS.md` —— 依赖图、你所在任务的 DoD、任务级隔离要点
5. 已存在的源码（`config.js` 等），了解已有约定

读完先用不超过 10 行复述你对**自己这个任务**的理解和边界，然后直接开始实现，不要停下来等确认。

## 全局铁律（违反即返工）

- **零第三方依赖**：禁止 `npm install`、禁止 `node_modules`、禁止改 `package.json`。
  只用 `node:` 内置模块与全局 `fetch`/`AbortController`。全程 **ESM**。
- **只写属于你的文件**（CONTRACT §10 所有权矩阵）。需要别人的模块就按契约签名 import；
  跑不通就在自己的 `test/stubs/` 下打桩。**严禁**创建 `lib/util.js`、`lib/errors.js`、`lib/log.js`
  之类的「顺手公共文件」，也严禁修改 `docs/` 与 `HANDOFF.md`。
- **端口隔离**（CONTRACT §11.1）：测试一律 `listen(0)` 取随机端口，**严禁**监听 8080；
  测试结束必须 close 掉所有 server 与 interval，不能让 `node --test` 挂住。
- **数据隔离**（CONTRACT §11.2）：测试严禁读写仓库内真实的 `data/` 与 `logs/`，
  一律 `fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-<任务号>-'))`，用完 `rmSync`。
  需要完整配置时用：
  `loadConfig({ cwd: <临时目录>, env: { QBANK_DATA_DIR: <临时目录>, QBANK_LOGS_DIR: <临时目录>, QBANK_PORT: '0' } })`
  配合 `resolvePaths(cfg, { cwd: <临时目录> })`。CLI 工具自测一律显式传 `--out`/`--file` 到临时目录。
- **日志纪律**（CONTRACT §11.5）：任何 console/stderr/文件日志中都**禁止**出现题干、选项、答案原文，
  只允许 key（可截断 12 位）、错误码、计数、耗时、provider 名、行号。禁止出现任何真实 API Key。
- **健壮性红线**（CONTRACT §11.7）：外部输入一律 try/catch；模块顶层禁止 I/O 与副作用；
  `lib/**` 里禁止 `process.exit()`；内部错误必须是带 `err.code` 的 `Error`，
  code 取值限于 CONTRACT §0 列出的枚举。
- **接口不可改**：`HANDOFF §4` 的字段名与 `code` 语义、`§4.3` 的答案格式是硬约定。
  发现契约有缺项或歧义 → 按最保守方式实现，并写进最终报告的「契约歧义」小节，由 T6 统一裁决，
  **不要自行扩张接口**。
- 测试用 `node:test` + `node:assert/strict`，断言必须卡住数值/结构，不允许只 `console.log` 人肉看。
  涉及时间的测试禁止真实 sleep 超过 200ms，间隔必须可注入。

## 交付要求（最终回复必须包含，格式见 CONTRACT §11.8）

1. 文件清单：新增/修改的**绝对路径**，逐行
2. 自检输出：完整命令 + 完整原始输出（含 `node --test` 的结尾统计行）
3. DoD 核对：`docs/TASKS.md` 中你这一任务的 DoD，逐条标 ✅/❌
4. 契约歧义：你发现的缺项/矛盾 + 你采取的保守做法（没有写「无」）
5. 需要他人配合：必须由别的任务改动的点（没有写「无」）

## 你的任务

---
