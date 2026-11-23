你是 Node.js 后端工程师，负责 qbank 项目的 **T6「集成与验收」**（里程碑 M5 收口）。
T0~T5 已全部落地：骨架/配置、归一化+匹配、AI 层+并发闸、存储+缓存+HTTP、导入+数据生成、bench+accuracy+README。
你的职责是把它们真正拼起来、裁决 41 条遗留歧义、逐条完成 HANDOFF §12 验收，并产出交付结论。

项目根目录：`D:\codex and chat gpt\ocs刷题助手题库搭建`
环境：Windows + PowerShell，Node v24.21.0，无 .git、无 node_modules。

---

## 第一步：按顺序读完这些文件，再动手（不得跳过）

1. `docs/PROMPT_PREFIX.md` —— 全局铁律（零依赖 / ESM / 端口隔离 / 数据隔离 / 日志纪律 / 报告格式）
2. `HANDOFF.md` —— 技术规格，§4 接口契约与 §12 验收标准是硬约定
3. `docs/CONTRACT.md` —— 模块契约，重点 §0 错误码、§8 server 管线、§10 所有权、§11 并行隔离约束
4. `docs/DECISIONS.md` —— 14 条规格裁决
5. `docs/TASKS.md` —— DoD 与 T6 行
6. **`docs/T1-T5-REPORTS.md`（77KB，最重要）** —— 五个窗口的交付报告 + 总览。
   必读章节：总览 §1 pass/fail 汇总、§2 跨任务依赖闭环、**§3 的 P0-1~P0-8 / P1-1~P1-13 / P2 全部条目**、
   §4 建议验收顺序、§5 交付物清单；以及五份分报告各自的「§4 契约歧义」「§5 需转达」「§6 接口速查」
7. `README.md`（49KB）与全部源码（`server.js`、`lib/**`、`tools/**`）

读完先用 **不超过 15 行** 复述：当前代码实际形态、你认为集成风险最高的 3 个点、你的执行计划。
然后**直接开始**，不要停下来等确认（只在需要真实 API Key 或需要用户改 HANDOFF.md 时才问）。

---

## 你的权限（与 T1~T5 不同）

- 集成期**可以修改任意文件**，包括 `lib/**`、`server.js`、`tools/**`、`test/**`、`docs/CONTRACT.md`、`docs/DECISIONS.md`、`README.md`、`package.json`。
- **两个例外，必须先问用户**：
  1. `HANDOFF.md`（PROMPT.md 明令「禁止未经确认就改 HANDOFF.md 里定义的接口契约」）——
     需要新增 reason 枚举等改动时，写进 `docs/ACCEPTANCE.md` 的「契约增补」章节，并在报告里列出待用户批准的 HANDOFF 补丁。
  2. 任何会**放宽**验收判据的改动（如把 §12.6 的 1ms/50ms、§12.7 的 85% 调松）——一律禁止。
- 新增文件：`test/e2e.test.js`、`docs/ACCEPTANCE.md`（你独占）、`docs/accuracy-report.json`（accuracy 产物）。
- 每一处跨任务文件的改动都必须记进 `docs/ACCEPTANCE.md` 的「变更表」（文件 / 改了什么 / 依据哪条 P0-P1-P2 编号 / 影响面）。

---

## 第二步：裁决（先裁决，再改代码，不要边改边猜）

在 `docs/ACCEPTANCE.md` 建「裁决记录」章节，对 `docs/T1-T5-REPORTS.md` §3 的 **P0-1~P0-8、P1-1~P1-13、P2 全部条目**逐条给出：
`编号 | 裁决(采纳/驳回/修正) | 理由 | 落地动作(改哪个文件哪一处) | 是否影响对外协议或全库 key`。

下面是建议基线（你应当独立复核，若不同意要写明理由；同意的话直接照此落地）：

**P0**
- **P0-1 splitOptions 保留字母标号**：采纳 T1 的 lookahead 实现（`split(/(?=[A-H][.、)）:：])/)`）。
  依据 HANDOFF §8.3 示例 `["A.富强","B.振兴"]` 带标号。**修 CONTRACT §1.2 第 4 级的措辞**，删掉「丢弃首段空串」这句错误表述。
  影响：`makeKey` 口径。当前 `data/bank.json` 是空的（只有 .gitkeep），**无需重建**，但要在裁决里写明「若已有生产数据则需重建索引与清缓存」。
- **P0-2 题型归属两处缺口**：两处都改，口径统一。
  ① `lib/normalize.js` §1.4 推断链**最前面**插入「答案字母数 > 1 → 多选」（需要 `ctx.answer` 入参，
     由 import 侧传入；server 侧无答案，保持现有推断）；`不定项选择题` 明确映射为 `多选`。
  ② `lib/answer.js` 多选校验放宽为 `/^[A-Z](#[A-Z])*$/`（允许单个字母），因为不定项可能只有一个正确答案；
     仍做去重 + 升序重排。
  ③ `tools/import.js` 的「答案字母数 >1 → 多选」兜底改为调用 ①（消除两窗口口径不一致）。
  同步更新 CONTRACT §1.4 / §5 与 README 的题型表。
- **P0-3 bad_request 与 HTTP 状态码**：采纳 T3 现状——**除未知路径 404 外，`/api` 一律 HTTP 200 + JSON**，
  `reason:'bad_request'` 保留。理由：OCS handler 只读 body 的 `code`，返回 4xx 反而可能触发 fetch 异常分支。
  把 `bad_request` 写进 `docs/ACCEPTANCE.md` 的「契约增补（待用户批准写回 HANDOFF §4.2）」，**不要自己改 HANDOFF.md**。
- **P0-4 ai.answer() 入参**：采纳 T3 现状——传**原文选项**（`splitOptions` 后、未归一化）+ 中文 label 题型。
  理由：prompt 要给模型可读文本，归一化会删掉标点与大小写信息。写进 CONTRACT §7 的 `answer()` 签名注释。
- **P0-5 前缀剥离正则**：采纳 T2，`/^(答案|正确答案|参考答案|答案是|答案应为|应选|应该选|正确选项是|选项)\s*(?:是|为)?\s*[:：]?\s*/`。
  补一条测试：「正确答案是 A#C」、「答案应为 B」必须解析成功。更新 CONTRACT §5。
- **P0-6 问答/填空判对口径**：采纳 T5（多选 `#` 集合全等；判断归一「正确/错误」；填空逐空相等；
  问答「包含要点 或 bigram Dice ≥ 0.6」）。**但你必须人工复核 `test/fixtures/accuracy_set.json` 20 题的 answer 字段是否真的正确**，
  并把复核结论写进 ACCEPTANCE（这是 §12.7 的分母，错了整个准确率数据就没意义）。阈值 0.6 保持写死且在 README 公开。
- **P0-7 gate 单层**：追认「gate 由 server 创建且只建一个，注入 `createAI`，AI 内部不得再包一层」。
  写进 CONTRACT §6/§7/§8。必须用 `gate.stats().peak <= 3` 的断言在 `test/e2e.test.js` 里再验一次。
- **P0-8 /health 暴露 ai.enabled**：**采纳**，加**附加字段**（不删不改现有字段，OCS 不受影响）：
  `/health` 返回增加 `ai: { enabled: <bool>, chain: [<provider>...] }`。同步改 README §4.3 与 CONTRACT §8。

**P1（全部追认进 CONTRACT，除下列两条需要动作）**
- P1-1 cache.json 格式 `{version:1,updatedAt,entries:{key:{answer,source,type,model?,createdAt}}}` → 写入 CONTRACT §4。
- P1-2 genbank 固定 `updatedAt=1700000000000` → 追认「**仅合成 bench 数据豁免** CONTRACT §0 的 Date.now() 约定」，
  并在 CONTRACT §0 加一行豁免说明；`import.js` 写库仍用 `Date.now()`。
- P1-3/P1-4 import stdout 超集 `{parsed,imported,skipped,duplicates,failed,elapsed}` 与 skipped/failed 语义 → 写入 CONTRACT §9。
- P1-5 bench 的 L2 命中口径以 `nearDuplicates` 为准，`collisions` 不算重复题 → 写入 CONTRACT §9 备注。
- **P1-6 queueFull 重复计数**：需要动作。统一为**单一来源 = `gate.stats().rejected`**，
  `/stats.ai.queueFull` 直接取它，`ai.stats().queueFull` 仅作 fallback。改 `server.js`（+ 必要时 `lib/ai/index.js`），补断言。
- P1-7 `Store.setVerified(key, boolean) -> boolean` → 补进 CONTRACT §3。
- P1-8 `createGate().close()`、P1-9 `timeoutMs` 从 task **开始执行**起算（排队不计）、
- P1-10 `chat()` opts 支持 `fetchImpl/retryBaseMs/retryMax` 测试注入位、P1-11 CLI 退出码 **2 = 环境未就绪（不计 FAIL）**、
- P1-12 分位数口径 R type-7、P1-13 `Matcher.lookup(title, options, opts)` 的 opts 可覆盖四个 match 配置
  → 全部追认并写进 CONTRACT 对应小节。
- **P1-9 附带检查**：确认 `/stats` 里的 AI 耗时**没有**把排队时间算进去（T2 明确提醒过 T3）。

**P2（保守实现确认）**
- T1 #2/#4/#5/#7/#8、T2 #1/#3/#6、T4 #4、T5 #2/#4/#6 → 全部**认可，无需改动**。
- T2 #1：把 `toLabel` 的「可失败动态 import + 内置回退映射」**固化为强制 import**（T1 已交付，回退映射是死代码且会掩盖接线错误）。
- **T3 #11（重点）**：`server.js` 里对 matcher/gate/ai 的动态 import + 缺失时回退内置最小实现（`*_module_missing`）——
  **裁决：删除这些回退分支**，改成正常静态 import。理由：T1/T2 已落地，回退分支会静默掩盖集成失败，
  让 e2e 测试「假通过」。删除后必须重跑 `test/http.test.js`，若测试依赖回退分支则改测试（改用 `test/stubs/t3-*` 注入）。
- T3 #8：只解析 JSON body，`x-www-form-urlencoded` → `bad_request`。**认可**，但在 ACCEPTANCE 里记一条
  「若用户实测 OCS 发表单编码，需回来加分支」，并在 README 故障排查里加一条对应说明。
- T3 #9 `/admin/verify` 无鉴权 + 未知 key → `bad_request` → **认可**（仅绑 127.0.0.1）。

---

## 第三步：全量测试与集成（裁决落地后）

1. `node --test test/*.test.js test/stubs/t5-*.js` —— 期望 **267 pass / 0 fail**（基线来自 T1~T5 报告）。
   若出现时序 flake，用 `node --test --test-concurrency=1` 复跑并在 ACCEPTANCE 记录。
   你改动代码后测试数会变，**新增的断言必须让总数增加，不许删别人的断言来凑绿**。
2. 静态一致性检查：把所有跨模块 import 的**实际签名**与 CONTRACT 逐一对照，产出「偏差表」，
   以（裁决后的）CONTRACT 为准修实现方。
3. 新增 `test/e2e.test.js`（你的独占文件），至少覆盖：
   - `listen(0)` 起服务 + `QBANK_DATA_DIR`/`QBANK_LOGS_DIR` 指向 `os.tmpdir()` 临时目录（**严禁碰仓库 data/ logs/**）
   - 用 `test/stubs/` 的假 provider 打通完整管线，六条路径各一次：
     L1 命中(`source:'local'`) / L2 命中(`source:'fuzzy'`) / suspicious 被丢弃(`code:0,no_match`) /
     图片公式短路(`image_or_formula`) / AI 成功并**回写 bank.json**+二次请求走 L1 且 `ai.calls` 不增长 /
     AI 全链失败(`ai_error`)
   - 审核降级：假 provider 返回 400 `DataInspectionFailed` → 切下一家 → `logs/moderation.log` 有一行
     且**内容里不含题干原文**（断言日志文本里搜不到题目字符串）
   - 并发 20 个请求 → `gate.stats().peak <= 3`、无 ECONNRESET、进程存活、`queueLimit` 调小时返回 `queue_full`
   - `POST /admin/verify` 后 `store.get(key).verified === true`，且 `requireVerified:true` 时行为符合 DECISIONS #6
   - Ctrl+C 等价路径：调用优雅退出钩子后 `cache.json` / `bank.json` / `bank.json.bak` 均可再次载入且结构合法
   - 顶层异常兜底：人为让 handler 抛错 → 仍返回 200 + `{code:0,reason:'ai_error'}`

---

## 第四步：HANDOFF §12 逐条实测（原始命令 + 原始输出，一条不许省略）

写进 `docs/ACCEPTANCE.md`，每项标 PASS / FAIL / BLOCKED，FAIL 必须写根因 + 你的修复动作 + 复测结果。

1. `node server.js` 启动无报错 + `GET /health` 200（贴响应体）。**测完必须 Ctrl+C 释放 8080**。
2. §4.4 的 OCS 题库配置：产出**可直接粘贴的 JSON**（用真实 8080 地址）+ 一份「预期看到什么」的核对清单，
   标注为「需用户在浏览器操作」→ 状态记 BLOCKED(user)，不算 FAIL。
3. 新题走 AI → 返回正确答案 → `data/bank.json` 新增一条 `source:"ai"` 记录 → **立刻重复同一请求**，
   用 `/stats` 的 `ai.calls` 前后差值证明零新增 AI 调用，且 `source` 变为 `local`。
4. 并发 20 请求：服务不崩、`/stats` 显示 `ai.inflight` 峰值 <= 3、超出部分排队或 `queue_full`。
5. 四种异常各返回 `code:0` 且进程存活：
   - 断网/DNS 失败：把 `providers.bailian.baseUrl` 指向不存在的主机（用环境变量 `QBANK_BAILIAN_BASE_URL` 覆盖，别改 config.json）
   - 401 无效 Key：`DASHSCOPE_API_KEY=sk-invalid`
   - `DataInspectionFailed`：用本地假 provider 模拟（不要真的去触发审核）
   - 超时：假 provider 挂住 30s + `QBANK_TIMEOUT_MS=2000`
   每一种都要在**同一次运行里**验证进程没退出（连续发第二个正常请求能应答）。
6. 性能（§12.6）：
   ```powershell
   node tools/genbank.js --count 50000 --seed 42 --out $env:TEMP\qbank-bench.json
   node tools/bench.js --file $env:TEMP\qbank-bench.json --json
   ```
   判据：L1 avg < 1ms、L2 p95 < 50ms。参考值（T5 的 2000 条小样本）：L1 0.0096ms、L2 p95 2.81ms；
   5 万条全量约 21s、rss ≈ 340MB。**产物写到 `$env:TEMP`，不要写进仓库 data/**，测完删掉。
7. 准确率（§12.7）：需要真实 `DASHSCOPE_API_KEY`（或本地 Ollama + `--provider ollama`）。
   - 先 `node tools/accuracy.js --mock` 验报表逻辑；
   - 再问用户 Key 是否已就绪。**没有 Key 就记 BLOCKED(env)，退出码 2 不算 FAIL**，不要伪造数据。
   - 有 Key 时：`node tools/accuracy.js --file test/fixtures/accuracy_set.json --out docs/accuracy-report.json --concurrency 3`
     判据 >= 85%。注意这会**真实花钱**，跑之前告知用户题目数（20 题）与预估 token。
8. README 覆盖度（§12.8）：核对安装/配置/OCS 对接/数据导入/故障排查五节是否都「照着做能跑通」，
   逐节实测其中的命令，把跑不通的地方直接修 README（你有权限）。

---

## 第五步：安全与健壮性复查（全部用命令验证，贴输出）

- `git` 不存在也要做等价检查：全仓库 grep 确认**没有任何硬编码 API Key**（`sk-` 后跟真实字符）、
  `package.json` 无 `dependencies`/`devDependencies`、`node_modules` 不存在、`lib/**` 内无 `process.exit(`、
  无 `require(` / `module.exports`（全程 ESM）。
- grep 确认 `console.*` / `stderr` / `logs/**` 中没有题干、选项、答案原文（只允许 key、错误码、计数、耗时、provider 名、行号）。
  用 `test/fixtures/sample.csv` 里的某条题干作为搜索词去 grep 全仓库与 `logs/`。
- `.gitignore` 确实忽略 `.env`、`data/*.json`、`data/*.bak`、`logs/*.log`。
- 收尾：把 `data/` 与 `logs/` 恢复成只有 `.gitkeep` 的干净状态（e2e 与 §12.3/§12.5 会在真实目录留痕迹的话），
  删掉所有临时文件，确认没有 node 进程残留在 8080。

---

## 硬性纪律（违反即返工）

- 禁止 `npm install` 任何包；禁止引入 `node_modules`。
- 禁止为了让测试变绿而放宽断言、跳过用例、或改动 §12 的判据数值。
- 禁止改 `HANDOFF.md`（要改先问用户）。
- 测试与 e2e 一律 `listen(0)` + `os.tmpdir()`；只有 §12.1 和 §12.2 的真实启动演示才用 8080，且用完立刻关闭。
- 进程永不因外部错误退出是最高优先级：任何「返回 500 / 未捕获异常 / 连接被重置 / 进程退出」都算**阻断性缺陷**，
  必须修掉才能标 PASS。
- 真实 AI 调用只在 §12.3 与 §12.7 两处发生，且必须先告知用户会消耗额度。

---

## 最终报告（格式见 CONTRACT §11.8，五段都要）

1. **文件清单**：新增/修改的绝对路径逐行，并标注属于哪个原任务（T1~T5）
2. **自检输出**：`node --test` 的完整结尾统计行、§12 每一项的原始命令与原始输出
3. **DoD 核对**：`docs/TASKS.md` T6 行 + HANDOFF §12 的 1~8 项，逐条 ✅/❌/BLOCKED
4. **裁决回填**：P0-1~P0-8、P1-1~P1-13、P2 全部条目的裁决结果（与 `docs/ACCEPTANCE.md` 一致），
   以及 CONTRACT.md / DECISIONS.md 的具体改动摘要
5. **遗留问题**：按优先级排序的清单 + 每条的建议动作；单独列出「需要用户批准才能做的 HANDOFF.md 补丁」

交付物：`docs/ACCEPTANCE.md`（验收结果表 + 裁决记录 + 变更表 + 遗留问题）、`test/e2e.test.js`、
更新后的 `docs/CONTRACT.md`（追认 P1）、必要时更新的 `README.md`。
