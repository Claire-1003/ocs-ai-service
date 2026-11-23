# 总览：T1~T5 交付汇总（供 T6 集成验收）

> 数据来源：本文件下方五份窗口报告（T1~T5），均于 2026-11-18 各自窗口重跑产出。
> 环境：Windows + PowerShell，Node **v24.21.0**，仓库无 `.git`、无 `node_modules`、`package.json` 无 `dependencies`。
> 全局铁律复核：五份报告各自 grep 过 `require(` / `node_modules` / 硬编码 `8080` / 真实 `sk-*` / 题干选项答案原文入日志，**命中均为 0**（说明性文字除外）。`data/`、`logs/` 现只剩 `.gitkeep`，测试产物全部落在 `os.tmpdir()\qbank-t<N>-*` 并已 `rmSync`。

## 1. 五任务 pass/fail 汇总

| 任务 | 交付模块 | 自测命令 | tests / pass / fail | DoD | 歧义数 |
|---|---|---|---|---|---|
| **T1** 归一化与匹配 | `lib/normalize.js`、`lib/matcher.js` | `node --test test/normalize.test.js test/matcher.test.js` | **100 / 100 / 0**（单文件 71 + 29） | 8/8 ✅ | 8 |
| **T2** AI 层与并发闸 | `lib/prompt.js`、`lib/answer.js`、`lib/queue.js`、`lib/ai/*` | `node --test test/prompt.test.js test/answer.test.js test/queue.test.js test/ai.test.js` | **63 / 63 / 0** | 14/14 ✅ | 8 |
| **T3** 存储、缓存、HTTP | `lib/store.js`、`lib/cache.js`、`server.js` | `node --test test/store.test.js test/cache.test.js test/http.test.js` | **31 / 31 / 0** | 7/7 ✅ | 11 |
| **T4** 导入与数据生成 | `tools/import.js`、`tools/genbank.js`、`test/fixtures/sample.*` | `node --test test/import.test.js` | **34 / 34 / 0** | 9/9 ✅ | 6 |
| **T5** 基准、评测、README | `tools/bench.js`、`tools/accuracy.js`、`test/fixtures/accuracy_set.json`、`README.md` | `node --test test/stubs/t5-selfcheck.js t5-sample-bank.js t5-readme-smoke.js` | **39 / 39 / 0** | 8 ✅ + 3 ⏳ | 8 |
| **合计** | | 全量 13 文件 `node --test` | **267 / 267 / 0**（T5 曾遇 1 次不可复现 flake，建议 CI 加 `--test-concurrency=1`） | 46 ✅ / 3 ⏳ / **0 ❌** | **41** |

**3 项 ⏳ 全部集中在 T5，且不是实现问题，是「必须真实数据/真实 Key 才能下的结论」**，只能由 T6 实测：

| ⏳ 项 | 判据 | T5 小样本参考值（2000 条） | 待 T6 动作 |
|---|---|---|---|
| L1 avg | HANDOFF §12.6 < 1ms | 0.0096 ms | 5 万条库复跑 `bench.js` |
| L2 p95 | HANDOFF §12.6 < 50ms | 2.8083 ms（avgCandidates 194.21，逼近 candidateLimit=200） | 同上 |
| 总准确率 | HANDOFF §12.7 ≥ 85% | mock 链路 100%（仅验报表逻辑，不算数） | 需真实 `DASHSCOPE_API_KEY` 或本地 Ollama |

## 2. 跨任务依赖闭环状态（各窗口「第 5 节 需转达」的收敛结果）

| 提出方 → 接收方 | 事项 | 状态 |
|---|---|---|
| T1 → T4 | genbank 必须**聚簇式**题干，否则 trigram 候选 <5 触发全表打分，L2 p95 失真（5 万条单次可达 400ms+） | ✅ **已闭环**。T4 确认：`TOPICS(30) × SUBTOPICS(30) × 模板池 + 共享选项池`，非均匀随机；2000 条实测「出现 ≥5 次的 6-gram 2039 个」，最热 8 字前缀被 23 条共享。T5 独立复核同意（L2 avgCandidates 194.21 ⇒ 回退几乎不触发）。**5 万条规模仍是同一模板池**（T4 §2⑨ 实测 840ms / 18.13MB / SHA256 可复现） |
| T4 → T5 | bench 数据直接用 `genbank --count 50000 --seed 42`，勿自造随机文本 | ✅ 已采纳（T5 全程用 genbank 产物） |
| T2 ↔ T3 | **gate 只能建一个**，否则实际并发 3×3 | ✅ **已闭环且经实测**。T3 集成时构造唯一 gate 注入 `createAI`，管线只包一层；T3 新增断言 `gate.stats().peak ∈ [1,3]` 且 `completed===20`；T2 侧确认 `createAI` 内部未自建 gate。T5 评测亦只用单层外部闸门 |
| T2 → T3 | `log` 三方法（`moderation/error/info`）、`/stats` 透传 `ai.stats()`、`gate.drain()/close()` | ✅ 已对接（T3 §2 演示链路含 `gate.drain`） |
| T2 → T1 | `prompt.js` 依赖 `toLabel` 现有签名 | ✅ 一致（T1 §6 导出 `toLabel`；T2 另留可失败动态 import + 回退映射） |
| T3 → T4 | bank.json 顶层 `{version:1,updatedAt,records:[…]}`、Record 字段顺序照 HANDOFF §8.3、`source:'import'`、`type` 存中文 label | ✅ 已实现。T4 产物字段顺序 `key,title,options,answer,type,source,verified,createdAt`；`store.load` 与 T4/T5 双向兼容裸数组（DECISIONS #13） |
| T3 → T5 | `store.records()` 只读引用供 bench；`/stats.elapsed` 为环形采样 p50/p95/p99 | ✅ 已用（bench 直接 import `lib/store`+`lib/matcher`，不发 HTTP） |
| T3 → T2 | `answer({key,type,title,options})` 传**原文选项**（splitOptions 后、未归一化），type 为中文 label | ⚠️ **待 T6 拍板**（见 P0-4） |

## 3. 41 条歧义合并清单（按影响面排序，编号可直接回引各窗口「第 4 节」）

### P0 —— 影响对外行为/协议/全库 key，**必须 T6 先裁决再集成**

| 编号 | 来源 | 内容 | 各窗口保守实现 | 风险 |
|---|---|---|---|---|
| **P0-1** | T1#1 | `splitOptions` 第 4 级：契约字面「split 后丢首段空串」会**丢掉字母标号**，与 HANDOFF §8.3 示例 `["A.富强","B.振兴"]` 矛盾 | 用 lookahead `split(/(?=[A-H][.、)）:：])/)` **保留字母** | 改判会改变 `makeKey` ⇒ **整库 key 变动、bank.json 需重建、cache 全失效**；也导致带/不带标号同题 key 不一致 |
| **P0-2** | T1#3 + T4#3 | 题型归属两处缺口：① `不定项选择题` §1.1 剥标记但 §1.4 无映射 → 现走推断归**单选**；② import 缺 type 列且答案含多字母时，§1.4 推断链给**单选**并会截断答案 | T1 未自行扩张映射表；T4 在「无 type 列且无 `--type`」时按**答案字母数 >1 → 多选**兜底 | 两窗口口径**目前不一致**，直接影响多选判对与 §12.7 准确率。建议在 §1.4 推断链**最前**加「答案字母数 >1 → 多选」，并明确「不定项选择题」归属（T1 文件，需 T1 窗口改） |
| **P0-3** | T3#1 + T3#2 | `bad_request` 不在 HANDOFF §4.2 reason 枚举内；`/api` 失败时的 HTTP 状态码未定义 | 按 CONTRACT §8/DECISIONS #9 返回 `bad_request`；除未知路径 404 外**一律 200 + JSON** | OCS 脚本端若判 HTTP 状态而非 body，会对不上。需确认是否改 4xx（T3 改一行） |
| **P0-4** | T3#4 ↔ T2 | `ai.answer()` 入参：T3 传**原文选项**（未归一化），type 为中文 label | 双方已跑通，但契约未写死 | 若 T2 的 prompt 期望归一化选项，判断题/多选题校验口径会变 → 影响准确率 |
| **P0-5** | T2#2 | `postProcess` 前缀剥离正则未含「是/为」，而 HANDOFF §7.4 示例是「正确答案**是** X」 | 前缀集合后加可选「是/为」 | 不加则残留字符导致校验失败、准确率虚低。建议并入契约正则 |
| **P0-6** | T5#5 | 问答/填空「答对」判据契约完全未定义 | 多选按 `#` 集合全等；判断归一化为「正确/错误」；填空逐空相等；问答「包含要点 **或** bigram Dice ≥ 0.6」，阈值写死并在 README §6.3 公开 | **直接决定 §12.7 是否达标**。T6 若要更严只调阈值、不改结构 |
| **P0-7** | T2#7 + T3#3 + T5#7 | gate 归属层级：§7 `createAI({gate})` 已收 gate，§8 又要求 server 侧限流 | 三窗口一致：**gate 由 server 建且只建一个**，AI 内部不再包 | 已实测无双层（并发峰值 ≤3）。仅需契约**追认**「gate 由 server 注入且 AI 内部不得再包」 |
| **P0-8** | T5#1 | `/health` 不暴露 `ai.enabled`：AI 被关时 fallback 链仍非空，只有 `answer()` 返回 `ai_disabled`，运维从 `/health` 看不出 | 不改他人文件，README §4.3 写成「查 `/stats` 的 `ai.calls` 是否为 0」 | 属**接口扩张**，需 T6 决定；若加字段，T5 同步更新 README §4.3 |

### P1 —— 数据格式/统计口径/契约增补，裁决成本低但**不写进文档会互相误解析**

| 编号 | 来源 | 内容 | 保守实现 |
|---|---|---|---|
| P1-1 | T3#5 | `data/cache.json` 格式契约**未定义**（只定义了 bank.json） | `{version:1,updatedAt,entries:{key:{answer,source,type,model?,createdAt}}}`，临时文件 + rename。**请写入 CONTRACT，防 T4/T5 误解析** |
| P1-2 | T4#1 | genbank 固定 `updatedAt = 1700000000000` 与 CONTRACT §0「统一 `Date.now()`」冲突（否则无法同 seed 逐字节可复现） | 仅合成数据文件豁免；import 写库仍用 `Date.now()`。**请明确 bench 数据豁免 §0，或让 bench 忽略 `updatedAt`** |
| P1-3 | T4#2 | import stdout 为 §9 的**超集** `{parsed,imported,skipped,duplicates,failed,elapsed}` | 前 4 字段名与语义未变；建议把 `failed/elapsed` 追认进 §9 |
| P1-4 | T4#5 | `skipped` vs `failed` 语义边界契约未区分 | `skipped`=整块无法解析；`failed`=已解析但归一化/建 Record 抛错；**两者都不影响退出码 0**（1 才是致命） |
| P1-5 | T4#6 | genbank 的 `nearDuplicates`（约 5%，编辑距离极小/选项乱序）≠ `collisions`（50k 时 1129，key 撞车后加确定性后缀保证 `uniqueKeys=count`） | **T5 bench 统计 L2 命中请以 `nearDuplicates` 为口径**，勿把 `collisions` 当重复题 |
| P1-6 | T3#7 | `/stats.ai.queueFull`：`ai.stats().queueFull` 与 `gate.stats().rejected` 可能重复计数 | 优先取 ai 的值，缺失才回退 gate；建议**统一由 gate 单一来源**提供 |
| P1-7 | T3#6 | CONTRACT §3 `Store` 签名未列 `setVerified`，但 DECISIONS #11 需要 | 已提供 `setVerified(key, boolean) -> boolean`（key 不存在返回 false）。请补进 §3 |
| P1-8 | T2#4 | §6 `createGate` 返回未列 `close()` | 额外导出 `close()`（清队列、reject 剩余、停调度），供优雅退出；纯增量 |
| P1-9 | T2#5 | §6 未定义 `timeoutMs` 起算点 | 从 task **开始执行**起算，排队不计；超时即释放槽位并 `abort(signal)`。**T3 请勿把排队耗时算进 `/stats` 的 AI 耗时** |
| P1-10 | T2#8 | §7 `chat()` opts 未列测试注入位 | 支持 `fetchImpl/retryBaseMs/retryMax`，缺省即契约默认（1s/2s、2 次、`globalThis.fetch`）。**不写进契约则「不联网 + 可注入」的 DoD 无法满足** |
| P1-11 | T5#3 | **退出码 2** 未在 CONTRACT §0 定义 | 无 Key / provider 全不可用 / `ai.enabled=false` / 未知 provider / 缺 `--file` / `--help` → 2，stdout 明写「不计为 FAIL」。**CI 请把 2 归为「环境未就绪」而非红** |
| P1-12 | T5#8 | 百分位算法未指定 | 线性插值 **R type-7**，已在 README 与 `--json` 字段名标注口径 |
| P1-13 | T1#6 | `lookup(title, options, opts)` 的 `opts` 契约未定义内容 | 实现为可覆盖 `acceptSuspicious/fuzzyThreshold/suspiciousThreshold/candidateLimit`，不传则用构造配置 |

### P2 —— 纯保守实现确认（不影响对外协议，T6 认可即可，无需改动）

- **T1**：#2 `optionCount===1` → 归 `问答`；#4 `toLabel` 未知输入 → 返回 `问答题`，已是标签形态则原样返回；#5 `normalize(null/undefined)` → 返回 `''` 而非 `"null"`（防污染 key）；#7「候选 <5 → 全表打分」回退严格照契约保留（P0 之外的性能问题已由聚簇数据消解）；#8 tie-break 仅在记录带外部 `key`（≠ 计算 key）时可达，实现同时比较 `entry.key` 与计算 `mkey`，两种情形都覆盖。
- **T2**：#1 `toLabel` 走可失败动态 import + 内置回退映射（T1 已交付则实际走真实 `toLabel`，建议固化为强制）；#3 三反引号剥离区分**块级**（行首``` + 可选语言 + 换行 / 行尾```）与**行内**包裹；#6 fallback **链为空**时 `calls`/`failed` 各 +1 并 stderr 打一次中文提示（若判定不应计入，改一行）。
- **T3**：#4 见 P0-4；#8 只解析 JSON body，`application/x-www-form-urlencoded` → `bad_request`（OCS 若发表单编码需加分支）；#9 `/admin/verify` 无鉴权、仅监听本机、未知 key → `bad_request`（非 404）；#10 LRU 新增只读 `flushing` getter（返回写链 Promise，仅测试 await 用）；#11 `server.js` 对 matcher/gate/ai 用动态 import + try/catch，缺失时回退内置最小实现并打 `*_module_missing`——T1/T2 已落地故不再触发，**请裁决是否保留**（保留可让 M1 在无 T2 时仍可跑）。
- **T4**：#4 TXT「`答案：` 后换行才写字母」用块内 `answerPending` 取下一非空行，仍取不到则计入 `skipped`（不 `failed`、不整体失败）。另：**TXT 解析器已知局限**（选项跨行折行无标号续行、表格/图片型题目、解析段与下题混排无空行、填空多空顺序校验）一律计入 `skipped`，不影响退出码。
- **T5**：#2 `accuracy.js --out` **无默认值**（`docs/` 是 T6 领地，工具不擅自写 `docs/accuracy-report.json`），显式传入才落盘、相对路径按 cwd 解析；#4 `wrong_answer`/`invalid_item` 仅作报表 reason 标签，**不注入任何 `Error.code`**（不是 §0 错误码）；#6 bench 装载兼容 `{records:[...]}` 与裸数组（DECISIONS #13），非法条目计入 `skipped` 不抛异常。

## 4. 建议 T6 验收顺序

1. **全量重跑**（先证明合并后仍全绿）：`node --test test/*.test.js test/stubs/t5-*.js`，期望 **267 pass / 0 fail**；若出现时序 flake，改 `--test-concurrency=1` 复跑。
2. **裁决 P0-1 ~ P0-8**（其中 P0-1、P0-2 涉及 `lib/normalize.js`，改动请回 T1 窗口执行；P0-3/P0-4/P0-8 涉及 `server.js`，回 T3 窗口；P0-5/P0-6 回 T2/T5 窗口。**各窗口文件所有权仍受 CONTRACT §10 约束，勿由 T6 直接改**）。
3. **接口追认**：P1-1（cache.json 格式）、P1-3/P1-4（import stdout 超集与 skipped/failed 语义）、P1-7（`setVerified`）、P1-8/P1-9/P1-10（gate/chat 增量与起算点）、P1-11（退出码 2）写入 `docs/CONTRACT.md`；P0-3 的 `bad_request` 补进 `HANDOFF.md §4.2`。
4. **实测归档 §12.6 / §12.7**（把 T5 的 3 项 ⏳ 转 ✅/❌）：
   ```powershell
   node tools/genbank.js --count 50000 --seed 42 --out <T6 指定路径>   # 约 0.9s / 18MB
   node tools/bench.js --file <同上> --json                            # 全量约 21s，rss ≈ 340MB，注意 CI 内存余量
   node tools/accuracy.js --file test/fixtures/accuracy_set.json --out docs/accuracy-report.json   # 需真实 Key 或本地 Ollama；退出码 2 = 环境未就绪
   ```
5. **端到端手测**：`node server.js`（默认 8080）→ `/health`、`/stats`、`POST /api`（命中 L1 / 命中 L2 / suspicious / `image_or_formula` / `queue_full` / AI 降级各一次）→ `POST /admin/verify` → Ctrl+C 优雅退出后核对 `cache.json`、`bank.json`、`bank.json.bak` 完整且 **records 未被假答案污染**；确认 8080 已释放。
6. **导入链路**：`tools/import.js` 四格式各跑一次 + 二次 `--merge` 验幂等（`imported=0`、`duplicates` 为全量）+ `--dry-run` 验 mtime/size 不变 + `--replace` 验 `.bak`；注意**退出码 0 含部分 `failed`，1 才是致命**。
7. **结论写入 `docs/ACCEPTANCE.md`**（T6 独占），并把 41 条歧义的裁决结果逐条回填到本文件第 3 节，形成 M2 收口记录。

## 5. 交付物总清单（所有权无越界）

| 归属 | 文件 |
|---|---|
| T0（既有） | `config.js`、`package.json`、`docs/*`、`HANDOFF.md` |
| T1 | `lib/normalize.js`、`lib/matcher.js`、`test/normalize.test.js`、`test/matcher.test.js` |
| T2 | `lib/prompt.js`、`lib/answer.js`、`lib/queue.js`、`lib/ai/{index,bailian,openai,ollama}.js`、`test/{prompt,answer,queue,ai}.test.js`、`test/stubs/t2-*` |
| T3 | `lib/store.js`、`lib/cache.js`、`server.js`、`test/{store,cache,http}.test.js` |
| T4 | `tools/import.js`、`tools/genbank.js`、`test/import.test.js`、`test/fixtures/sample.{csv,tsv,txt,json}`、`test/stubs/t4-store.js` |
| T5 | `tools/bench.js`、`tools/accuracy.js`、`test/fixtures/accuracy_set.json`、`README.md`、`test/stubs/t5-{selfcheck,sample-bank,readme-smoke}.js` |

五个窗口均声明：未修改 `docs/**`、`HANDOFF.md`、`package.json` 及他人文件；无第三方依赖；`lib/**` 内无 `process.exit()`（CLI 出口只在 `tools/`）；内部错误均带 `err.code ∈ CONTRACT §0` 枚举。

# T1「归一化与匹配」交付报告（供 T6 验收）

> 来源：T1 窗口，2026-11-18。浓缩版；完整报告含 `node --test` 全量原始输出，可让 T1 窗口重发或现场重跑（约 3 秒）。

## 1. 文件清单（均为新增）

- `D:\codex and chat gpt\ocs刷题助手题库搭建\lib\normalize.js`
- `D:\codex and chat gpt\ocs刷题助手题库搭建\lib\matcher.js`
- `D:\codex and chat gpt\ocs刷题助手题库搭建\test\normalize.test.js`
- `D:\codex and chat gpt\ocs刷题助手题库搭建\test\matcher.test.js`

无他人文件改动；未动 `package.json` / `docs/` / `HANDOFF.md`；未创建 `test/stubs/`（纯函数无需打桩）。
`lib/*` 只 import `node:crypto`，不引 `node:fs` / `node:http` / `config.js`；无 `process.exit`、无顶层副作用、无日志输出。

## 2. 验收命令与结果

```
node --test test/normalize.test.js test/matcher.test.js
→ tests 100 / pass 100 / fail 0 / duration_ms ≈ 358
```

单文件独立跑（CONTRACT §11.6）：

| 命令 | 结果 |
|---|---|
| `node --test test/normalize.test.js` | 71/71 全绿 |
| `node --test test/matcher.test.js` | 29/29 全绿 |

测试纯内存生成数据：不落盘、不监听端口、无真实 sleep，进程干净退出。

## 3. DoD 核对（docs/TASKS.md T1 行）——全部 ✅

| DoD 项 | 状态 | 说明 |
|---|---|---|
| 两测试文件全绿 | ✅ | 100/100 |
| normalize 覆盖 §1.1 全 7 步 | ✅ | 题号 `1.` `12、` `(3)` `（4）` `一、` `第5题`；题型 `【单选题】` `[多选题]` `单选题：` `判断题:` |
| 乱序选项同 key | ✅ | makeKey + L1 乱序命中断言 |
| 0.90 边界 | ✅ | 单字改动 scorePair=0.9168，前置断言卡数值后命中 L2 |
| suspicious 丢弃 | ✅ | 双字改动 scorePair=0.8337 ∈ [0.80,0.90)：默认返回 null；`acceptSuspicious:true` 时返回 `suspicious:true` |
| tie-break（DECISIONS #12） | ✅ | 同题干不同选项、显式 key 绕过 L1，断言选中 options 完全一致者 |
| 5000 条合成数据 lookup 平均 < 5ms | ✅ | 200 次混合 L1/L2 查询，`assert(avg < 5)` 卡住（整段实测 183ms 含断言开销） |
| CONTRACT §11.1~§11.8 | ✅ | |

## 4. 契约歧义 → 需 T6 裁决

均已按最保守方式实现；如改判只需调 `lib/normalize.js` 对应常量/正则。

1. **splitOptions 第 4 级**：契约字面「按正则 split 丢弃首段空串」会丢字母标号，与 HANDOFF §8.3 示例 `["A.富强","B.振兴"]` 矛盾，且导致带/不带标号的同题 key 不一致。**现实现**：lookahead `split(/(?=[A-H][.、)）:：])/)` 保留字母。请确认。
2. **`optionCount === 1`**：推断链只覆盖 0 和 >=2。**现实现**：归 `问答`。
3. **`不定项选择题`**：§1.1 剥它的标记，但 §1.4 映射表无关键词 → 走推断，有选项时归 `单选`。**请裁决是否应归 `多选`**（未自行扩张映射）。
4. **`toLabel` 未知输入**：保守返回 `问答题`；已是标签形态（如 `多选题`）原样返回。
5. **`normalize(null/undefined)`**：契约写 `String(s)` 会得 `"null"`，现返回 `''`，避免污染 key。
6. **`lookup(title, options, opts)` 的 `opts`**：契约未定义内容，实现为可覆盖 `acceptSuspicious / fuzzyThreshold / suspiciousThreshold / candidateLimit`，不传则用构造配置。
7. **「候选 < 5 → 全表打分」回退**：均匀随机合成数据下 trigram 召回天然稀疏，会频繁触发全表打分（5000 条约 40ms/次）。实现严格照契约保留回退；性能测试改用聚簇式数据使索引路径生效。**非实现偏差，是数据形态问题**，详见 §5 转达 T5 事项。
8. **tie-break 可达性**：记录不带显式 `key` 时，options-key 相同会先被 L1 命中；tie-break 仅在记录带外部 `key`（≠ 计算 key）时生效。实现同时比较 `entry.key` 与计算的 `mkey`，两种情形都覆盖。

## 5. 需转达其他任务

- **T5（务必）**：`tools/genbank.js` 合成题干请用**聚簇式**（同主题模板派生多条、共享子串），模拟真实题库形态。若用均匀随机文本，trigram 召回 <5 会触发全表打分回退，bench 的 L2 p95 < 50ms 指标失真（5 万条时单次可达 400ms+）。
- **T3**：`new Matcher(config.match)` 只接收 `{fuzzyThreshold, suspiciousThreshold, acceptSuspicious, candidateLimit}` 四字段；回写路径调 `matcher.add(record)`，record 可不带 `key`（内部 `makeKey` 计算）；`remove(key)` 已实现。

## 6. 接口速查（签名以 CONTRACT §1/§2 为准，未扩张）

- `lib/normalize.js`：`normalize` / `splitOptions` / `normalizeOptions` / `makeKey` / `normalizeType` / `toLabel` / `isUnanswerable` / `PUNCT_RE`
- `lib/matcher.js`：`trigrams` / `diceBigram` / `lcsRatio` / `scorePair` / `Matcher`（`build` / `add` / `remove` / `lookupExact` / `lookup` / `size`）


# T2「AI 层与并发闸」交付报告（供 T6 验收）

> 本报告所有数字均来自本轮重跑（2026-11-18，Node 内置 `node:test`，Windows/PowerShell）。
> 生成位置刻意放在 qbank 仓库**之外**，以避免违反 CONTRACT §10 文件所有权矩阵（T2 无报告类文件写权限）。

## 1. 文件清单

新增/修改（绝对路径，全部在 CONTRACT §10 我的所有权范围内）：

```
D:\codex and chat gpt\ocs刷题助手题库搭建\lib\prompt.js
D:\codex and chat gpt\ocs刷题助手题库搭建\lib\answer.js
D:\codex and chat gpt\ocs刷题助手题库搭建\lib\queue.js
D:\codex and chat gpt\ocs刷题助手题库搭建\lib\ai\index.js
D:\codex and chat gpt\ocs刷题助手题库搭建\lib\ai\bailian.js
D:\codex and chat gpt\ocs刷题助手题库搭建\lib\ai\openai.js
D:\codex and chat gpt\ocs刷题助手题库搭建\lib\ai\ollama.js
D:\codex and chat gpt\ocs刷题助手题库搭建\test\prompt.test.js
D:\codex and chat gpt\ocs刷题助手题库搭建\test\answer.test.js
D:\codex and chat gpt\ocs刷题助手题库搭建\test\queue.test.js
D:\codex and chat gpt\ocs刷题助手题库搭建\test\ai.test.js
D:\codex and chat gpt\ocs刷题助手题库搭建\test\stubs\t2-fakeProvider.js
D:\codex and chat gpt\ocs刷题助手题库搭建\test\stubs\t2-fakeLog.js
```

- **他人文件改动：无。** `server.js`(17:55) / `config.js`(17:11) / `lib\normalize.js`(17:30) / `lib\matcher.js`(17:31) / `lib\store.js`(17:46) / `lib\cache.js`(17:46) 的 mtime 均早于我的写入，未被触碰。
- **`package.json`：未改**（mtime 17:09:44）；**`docs/`、`HANDOFF.md`：未改**（mtime 16:11–17:14）。无 `node_modules`、无 `npm install`。
- 全仓回归（非我职责，仅确认无副作用）：`node --test test/*.test.js` → tests 194 / pass 194 / fail 0，连跑 2 次一致。

## 2. 验收命令与结果

命令：`node --test test/prompt.test.js test/answer.test.js test/queue.test.js test/ai.test.js`

结尾统计行原文：

```
ℹ tests 63
ℹ suites 0
ℹ pass 63
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 949.0843
```

单文件独立跑（CONTRACT §11.6）：

| 文件 | tests | pass | fail | duration_ms |
|---|---|---|---|---|
| `test/prompt.test.js` | 7 | 7 | 0 | 117.139 |
| `test/answer.test.js` | 9 | 9 | 0 | 115.4699 |
| `test/queue.test.js` | 13 | 13 | 0 | 565.2336 |
| `test/ai.test.js` | 34 | 34 | 0 | 833.9985 |

隔离纪律落实（grep 自查证据，全部零命中）：

| 自查项 | 命令/模式 | 结果 |
|---|---|---|
| CommonJS | `require\(` | 0 命中（13 个文件） |
| 第三方依赖 | `node_modules` | 0 命中 |
| `process.exit` | `lib/**` 内 `process\.exit` | 0 命中（4 条命中全在注释里，如「不使用 process.exit」） |
| 真实联网/固定端口 | `dashscope\.aliyuncs` / `api\.openai\.com` / `:11434` / `:8080` / `listen(非0)` | 0 命中；唯一 `listen` 调用是 `t2-fakeProvider.js:73 server.listen(0, '127.0.0.1', resolve)` |
| 真实 API Key | `sk-[A-Za-z0-9]+` | 仅 7 处 `sk-xxxxxxxx`（占位），其中 2 处是「日志/错误信息不得泄漏 Key」的反向断言 |
| 落盘 | `from 'node:(fs|os|path)'` | 0 命中 —— T2 全程不读写 `data/`、`logs/`，无需临时目录 |
| interval 残留 | `setInterval` | `lib/queue.js`、`lib/ai/*` 均 0 命中；`queue.js` 只用 `setTimeout` 且 `timer.unref()`（第 80 行）+ settle 时 `clearTimeout`；`ai.test.js` 的 `after()` 关闭全部假 server 并 `destroy()` 所有 socket |
| 真实 sleep | 单个 test 最长耗时 | **173.6ms**（< 200ms）；测试内 `sleep()` 最大值 30ms；假 provider 的 `delayMs: 200/300` 是服务端故意拖延，客户端在 20–40ms 处 abort，从不真的等满 |

`node --test` 正常退出、不挂住（4 个文件独立跑与合并跑均在 1s 内结束）。

## 3. DoD 核对（docs/TASKS.md 第 27 行 T2 条目）

| DoD 条目 | 结论 | 证据（测试名 / 断言） |
|---|---|---|
| 四个测试文件全绿 | ✅ | tests 63 / pass 63 / fail 0 |
| 假 provider 用 `node:http` + `listen(0)`，不联网 | ✅ | `t2-fakeProvider.js` `http.createServer` + `listen(0,'127.0.0.1')`；grep 无真实域名 |
| 覆盖 200 正常响应 | ✅ | 「200 正常响应：拿到 text 并成功 postProcess，请求体符合 HANDOFF §7.2」（校验 url/method/headers/body 字段） |
| 覆盖 400 `DataInspectionFailed` | ✅ | 「HTTP 400 + {code:"DataInspectionFailed"} → 审核降级到下一家」 |
| 覆盖 500 `InternalError.Algo.DataInspectionFailed` | ✅ | 「HTTP 500 + {error:{code:"InternalError.Algo.DataInspectionFailed"}} → 审核降级到下一家」 |
| 覆盖 401 | ✅ | 「HTTP 401 → ai_error 且不重试；单 provider 链直接 chainExhausted」+「HTTP 401 后自动切下一家 provider」 |
| 覆盖 429 指数退避 | ✅ | 「HTTP 429 → 指数退避重试 2 次（共 3 次请求）后换 provider」断言 `requestCount===3`；「429 退避间隔随 retryBaseMs 放大（30ms → 60ms 两档）」 |
| 覆盖超时 abort | ✅ | 「慢响应：AbortController 生效 → ai_timeout（provider 与 fallback 链两层）」+「外部 signal abort」+「已 abort 的 signal 直接失败，不发请求」 |
| 覆盖坏 JSON | ✅ | 「响应体是 HTML / 坏 JSON → ai_error，进程不崩」+「choices 为空 / content 为空 / content 非字符串 → ai_error」 |
| gate 并发 <= 3 | ✅ | 「并发 20 个任务时在途数恒 <= 3，且全部完成」（逐 tick 断言峰值） |
| gate 队列满立即 `queue_full`（不入队不等待） | ✅ | 「queueLimit=5：排到第 6 个立即 reject queue_full，不入队、不等待」（0.44ms 返回）+「concurrency=3/queueLimit=5：第 9 个」+「queueLimit=0」 |
| gate FIFO | ✅ | 「concurrency=1 时严格 FIFO」+「concurrency=3 时入队部分仍按 FIFO 出队」 |
| 退避/超时可注入、无真实 sleep | ✅ | 注入值 `retryBaseMs: 5` / `30`；`timeoutMs` 注入 15–40ms；最长单测 173.6ms |
| 满足 CONTRACT §11（日志纪律/健壮性/接口不改） | ✅ | 审核用例断言 `log.moderation` 参数键集合恰为 `['code','key','provider']`，且 `log.dump()` 不含题干标记串、选项标记串、`sk-xxxxxxxx`；「answer() 永不抛、永不 reject」覆盖畸形入参/畸形配置/provider 抛非 Error；「log 回调抛异常不影响主流程」 |

**❌ 条目：无。**

T2 专属自查点补充确认：

- **审核不重试同 provider**：断言 `bad.requestCount === 1`（三家审核码各测一次）。
- **DECISIONS #4**：`answer.test.js:83-91` —— `normalizeJudge('A')` 无 options → `null`；`options[0]` 含 正确/对/√/是 → A→正确、B→错误；`options[0]` 为否定项 → `null`。`invalid_output` 只作内部码，对外经 `publicReason()` 映射为 `ai_error`（DECISIONS #9）。
- **SYSTEM_PROMPT 逐字**：本轮直接把 `HANDOFF.md` §7.3 的 `[system]` 段与 `SYSTEM_PROMPT` 运行时值逐字符比对，**完全一致**（11 行，含 8 条规则）；`test/prompt.test.js` 另有防回归副本断言。
- **options 为空整行省略**：`prompt.test.js:53-60`，空数组/空串/undefined/全空项四种情况均断言 `!content.includes('选项：')`；title/options 用原文，type 走 `toLabel()`。

## 4. 契约歧义 → 需 T6 裁决

| # | 歧义位置 | 我的保守实现 | 建议裁决方向 |
|---|---|---|---|
| 1 | CONTRACT §5 要求 `type` 用 `toLabel()`，但 `toLabel` 属 T1 `lib/normalize.js` | 可失败动态 import + 内置回退映射，签名与输出不变 | 确认 T1 的 `toLabel` 为唯一权威，回退映射仅作降级；建议 T6 固化「T1 已交付则必须走真实 toLabel」 |
| 2 | §5 前缀剥离正则未含「是/为」，但 HANDOFF §7.4 示例形如「正确答案是 X」 | 在前缀集合后加可选「是/为」，否则残留导致校验失败 | 建议把「是/为」并入契约正则，或在 §5 明确前缀词表以本实现为准 |
| 3 | §5「剥掉三反引号代码块包裹」未区分块级与行内 | 块级按「行首三反引号 + 可选语言标记 + 换行」与「行尾三反引号」成对剥离；行内包裹（答案被三反引号直接夹住）单独剥离 | 建议契约补一句行内形态的处理 |
| 4 | §6 `createGate` 返回未列 `close()` | 额外导出 `close()`（清空队列、reject 剩余项、停止调度），供优雅退出 | 建议纳入契约（纯增量，不影响既有调用方） |
| 5 | §6 未定义 `timeoutMs` 起算点 | 从 task **开始执行**起算，排队时间不计；超时立即释放槽位并 `abort(signal)` | 建议契约明确，避免 T3 在 `/stats` 里把排队耗时误算进 AI 耗时 |
| 6 | §7 未定义「链为空」时的 `calls`/`failed` 计数 | 各 +1 计入，同时 stderr 打一次中文提示 | 建议明确是否计入；若不计入我改一行即可 |
| 7 | §7 `createAI({gate})` 与 server 侧闸门是否叠加未定义 | 给了 `gate` 就在闸门内跑整条 fallback 链；server 若外层已包同一 gate 则幂等（不二次排队） | 建议 T3/T6 统一：**只在一个地方**建 gate 并传进来，勿建两个（否则实际并发 3×3） |
| 8 | §7 `chat()` opts 未列测试注入位 | 支持 `opts.fetchImpl` / `providerCfg.fetchImpl` / `retryBaseMs` / `retryMax`，缺省走契约默认（1s/2s、2 次、`globalThis.fetch`） | 建议把「退避与 fetch 可注入」写进契约，否则 DoD 的「不联网 + 可注入」无法满足 |

## 5. 需转达其他任务

- **T3（server.js）**：① 注入的 `log` 需实现 `moderation(key, code, provider)` / `error(scope, errCode)` / `info(scope, obj)`，AI 层只传 key、错误码、provider 名、耗时，**不会**传题干/选项/答案原文，落盘时请勿自行拼接题目内容；② `/stats` 可直接透传 `ai.stats()`：`{calls, success, failed, byProvider:{<name>:{calls,success,failed,moderation,timeout,ms}}, tokensIn, tokensOut, moderation, queueFull, chainExhausted}`；③ gate 只建一个（见歧义 #7）；④ 优雅退出可调 `gate.drain()`，强制关停调 `gate.close()`。
- **T6（集成）**：确认 `ai.answer({key, type, title, options})` 入参对齐；`options` 支持数组或 `#` 拼接串；失败只返回 `{ok:false, reason}`，`reason ∈ HANDOFF §4.2` 枚举（内部码 `invalid_output` 已映射为 `ai_error`）；`ai.chain` 为已剔除未配置 provider 的实际生效顺序。
- **T1（normalize.js）**：`prompt.js` 依赖 `toLabel` 现有签名，若调整请同步（当前有回退映射，不会崩）。

## 6. 接口速查（以 CONTRACT §5/§6/§7 为准）

```js
// lib/prompt.js
export const SYSTEM_PROMPT                                  // = HANDOFF §7.3 [system] 段逐字（11 行）
export function buildMessages({ type, title, options })     // -> [{role:'system'|'user', content}]
export default { SYSTEM_PROMPT, buildMessages }

// lib/answer.js
export function postProcess(raw, { type, options })         // -> {ok:true, answer, via:'strict'|'fallback'} | {ok:false, code:'invalid_output'}
export function validate(answer, type, options)             // -> boolean
export function normalizeJudge(token, options)              // -> '正确'|'错误'|null
export function cleanRaw(raw)                               // -> string（便利导出，契约未要求）
export default { postProcess, validate, normalizeJudge, cleanRaw }

// lib/queue.js
export function createGate({ concurrency=3, queueLimit=200, timeoutMs=0 })
// -> { run(task, opts)->Promise, stats()->{inflight,queued,completed,failed,rejected,timeouts,startedAt},
//       drain()->Promise, close(), get inflight, get queued, get concurrency, get queueLimit }
export default { createGate }

// lib/ai/{bailian,openai,ollama}.js
export default { name, isConfigured(providerCfg, env), async chat(messages, { providerCfg, signal, timeoutMs, env }) }
//   chat -> { text, model, tokens:{in,out} }；抛错必带 code ∈ 'ai_moderation'|'ai_error'|'ai_timeout'

// lib/ai/index.js
export const MODERATION_CODES   // ['DataInspectionFailed','InvalidParameter.DataInspection','InternalError.Algo.DataInspectionFailed']
export function isModerationError(errOrBody)                // -> boolean
export function createAI({ config, env, log, gate })        // -> { answer(input), stats(), get chain, get enabled }
export default { MODERATION_CODES, isModerationError, createAI }
```

**偏离说明**：契约要求的导出与签名**无偏离**。三处纯增量（不影响既有调用方）：① `answer.cleanRaw`；② `gate.close()` 与 `gate.concurrency/queueLimit` getter；③ `chat()` 的可注入测试参数 `fetchImpl/retryBaseMs/retryMax`（缺省即契约默认值）。`createAI` 额外暴露 `enabled` getter，`answer()` 返回值结构与 §7 完全一致。


# T3「存储、缓存与 HTTP 服务」交付报告（供 T6 验收）


> 环境：Windows / PowerShell / Node v24.21.0 / 全 ESM / 零第三方依赖（package.json 无 dependencies 字段，未改）
> 本报告所有数字均来自刚刚重跑的输出；T1（lib/normalize.js、lib/matcher.js）与 T2（lib/queue.js、lib/ai/*）现已落地，
> server.js **未做任何改动**即自动切到真实模块（手动演示中 L1 命中用的就是 T1 的 `makeKey`）。

## 1. 文件清单

新增/修改（绝对路径，均属 CONTRACT §10 中 T3 独占范围）：

- `D:\codex and chat gpt\ocs刷题助手题库搭建\server.js`
- `D:\codex and chat gpt\ocs刷题助手题库搭建\lib\store.js`
- `D:\codex and chat gpt\ocs刷题助手题库搭建\lib\cache.js`
- `D:\codex and chat gpt\ocs刷题助手题库搭建\test\store.test.js`
- `D:\codex and chat gpt\ocs刷题助手题库搭建\test\cache.test.js`
- `D:\codex and chat gpt\ocs刷题助手题库搭建\test\http.test.js`
- `D:\codex and chat gpt\ocs刷题助手题库搭建\test\stubs\t3-env.js`
- `D:\codex and chat gpt\ocs刷题助手题库搭建\test\stubs\t3-matcher.js`
- `D:\codex and chat gpt\ocs刷题助手题库搭建\test\stubs\t3-gate.js`（本轮新增 `peak` 并发峰值计数）
- `D:\codex and chat gpt\ocs刷题助手题库搭建\test\stubs\t3-ai.js`

他人文件改动：**无**。`config.js`（T0）只读未改；未动 `package.json`、`docs/**`、`HANDOFF.md`、`README.md`、`tools/**`、
`lib/normalize.js`、`lib/matcher.js`、`lib/queue.js`、`lib/ai/**`、`lib/prompt.js`、`lib/answer.js`。
仓库 `data\`、`logs\` 目前仍只有 `.gitkeep`（演示全部指向 `os.tmpdir()`，演示临时目录已删除，tmpdir 下 `qbank-t3-*` 残留数 = 0）。

## 2. 验收命令与结果

命令：`node --test test/store.test.js test/cache.test.js test/http.test.js`

结尾统计行原文（进程退出码 0）：

```
ℹ tests 31
ℹ suites 0
ℹ pass 31
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 986.5281
```

单文件独立跑（CONTRACT §11.6）：

| 命令 | tests | pass | fail | duration_ms | exit |
|---|---|---|---|---|---|
| `node --test test/store.test.js` | 9 | 9 | 0 | 312.2791 | 0 |
| `node --test test/cache.test.js` | 6 | 6 | 0 | 392.4938 | 0 |
| `node --test test/http.test.js` | 16 | 16 | 0 | 1015.3729 | 0 |

违禁项 grep 自查（对象：server.js、lib/store.js、lib/cache.js、3 个测试文件、4 个 t3-* 桩）：

| 检查项 | 命中 |
|---|---|
| `require(` | 0 |
| `node_modules` | 0 |
| 测试中硬编码 8080 / 3000 / 11434 | 2 处，均为**反向断言**：`http.test.js:2` 注释、`http.test.js:46 assert.notEqual(addr.port, 8080)` |
| 测试引用仓库真实 `data/`、`logs/` | 0（一律走 `test/stubs/t3-env.js` 的 `makeTmpEnv()`：`fs.mkdtempSync(os.tmpdir()+'qbank-t3-')` + `loadConfig({cwd:dir, env:{QBANK_DATA_DIR,QBANK_LOGS_DIR,QBANK_PORT:'0'}})` + `resolvePaths(cfg,{cwd:dir})`） |
| `lib/store.js`、`lib/cache.js` 内 `process.exit` | 0（`store.js:11` 仅为“无 process.exit”的注释） |
| 硬编码 API Key | 0 |

隔离纪律：`http.test.js` 只有 `inst.listen(0)` 两处（第 45、270 行），`after` 钩子统一 `await i.close()` + `cleanup(dir)`；
三个测试文件均在 ~1s 内自行退出，无挂住的 interval/handle（autoFlush interval 已 `unref()`，gate 桩 `drain()` 的 interval 命中即 `clearInterval`）。

手动端到端演示（`QBANK_PORT=8080 QBANK_MOCK_AI=1 QBANK_DATA_DIR/QBANK_LOGS_DIR=<tmp>` → `node server.js`，curl 实测）：

- 启动行：`[qbank][server][listening] http://127.0.0.1:8080 ai=mock (MOCK_AI)`
  （无 `matcher_module_missing` / `queue_module_missing` / `ai_module_missing`，证明用的是 T1/T2 真实模块）
- `GET /health` → 200，头含 `Content-Type: application/json; charset=utf-8`、`Access-Control-Allow-Origin: *`、`Cache-Control: no-store`；
  体 `{"code":1,"status":"ok","uptime":24251,"version":"1.0.0","bank":2,"ai":["mock"]}`
- `GET /api?q=…&type=…&options=…`（库内已有条目）→ `{"code":1,"question":"…","answer":"…","source":"local","elapsed":1}`
- `GET /api`（新题）→ `{"code":1,…,"source":"ai","elapsed":1}`；同题再问 → `"source":"cache","elapsed":0`
- `POST /api`（JSON body，中文题干）→ 200 `{"code":1,…,"source":"ai","elapsed":1}`
- `GET /api`（缺 q）→ 200 `{"code":0,"question":"","answer":"","reason":"bad_request","elapsed":0}`
- `POST /api` body 1.1MB → 200 `{"code":0,…,"reason":"bad_request","elapsed":1}`
- `OPTIONS /api` → **204** + `Allow-Methods: GET, POST, OPTIONS`、`Allow-Headers: Content-Type, Authorization, X-Requested-With`、`Max-Age: 86400`
- `GET /nope` → **404** `{"code":0,"question":"","answer":"","reason":"no_match","elapsed":1}`
- `POST /admin/verify {key,verified:true}` → `{"code":1,"key":"6d26208509…","verified":true,"elapsed":5}`；`{}` → `{"code":0,"reason":"bad_request"}`
- `GET /stats` → 结构完全符合 DECISIONS #7：
  `uptime/version/bank{total,verified,bySource{local,ai,import,fuzzy}}/cache{size,hits,misses,evictions,writes}/ai{calls,success,failed,moderation,timeout,queueFull,inflight,queued,tokensIn,tokensOut,byProvider,chain}/match{l1,l2,l2Suspicious,noMatch,imageOrFormula}/elapsed{p50,p95,p99,samples}`
  （实测 `elapsed:{"p50":1,"p95":1,"p99":1,"samples":3}`，固定长度环形采样）

优雅退出实测（第二次演示，独立 tmp 目录，退出码 **0**）：

```
[driver] api code=1 source=ai
[driver] emit SIGINT
SERVER_EXIT_CODE=0
```

退出后落盘核对：`cache.json` → `version 1, entries 1, 首条 key 前 12 位=4396d00fd236, answer 为 string`（完整可回读）；
`bank.json` → `version 1, records 1`；`bank.json.bak` → 已生成，`records 1`。
records 仍为 1 条 = **MOCK AI 的假答案没有写进 bank.json**（只进 cache）。
链路顺序即 `stopAutoFlush → cache.flush → store.persist → gate.drain → server.close → exit(0)`，另有 10s 兜底强退定时器。

**关于 Ctrl+C 的诚实说明**：Windows 上无法向子进程注入真实控制台 Ctrl+C（libuv 直接 TerminateProcess）。
本次先尝试在 PTY 里发 `\x03`：实测无效（发送后 `/health` 仍返回 200、pid 56440 仍监听 8080），故用 `Stop-Process` 结束该实例
（该实例运行期已自然产出 `bank.json.bak` 与 autoflush 的 `cache.json`，是运行期原子写的独立证据）。
随后用 `node --import <driver.mjs> server.js`，让 driver 在进程内 `process.emit('SIGINT')` —— 这与真实 Ctrl+C 走的是
**同一个 Node SIGINT 事件路径和同一个 shutdown 处理器**，退出码 0，落盘完整。T6 若要物理 Ctrl+C 复核，在交互终端直接按即可。
两次演示结束后均验证：`Get-NetTCPConnection -LocalPort 8080 -State Listen` 无结果、`Test-NetConnection 127.0.0.1:8080` = False、
无残留 `node … server.js` 进程，**当前 8080 未被占用**。

T3 专属自查点补充证据：

- 原子写：`store.#writeOnce()` / `cache.#writeOnce()` 均为 `bank.json → .bak` 复制 + `*.tmp` 写入 + `rename`；`persist()` 走 `#writeChain` Promise 链单写队列串行化（DECISIONS #14），有“并发 persist 串行化，文件不损坏”专项测试。
- 去抖：`add` 后 `persistDebounceMs`（默认 1000ms，可注入）合并落盘，测试注入 30ms 验证多次 add 只落一次盘。
- handler 抛错：`http.test.js:251`（store.match 人为抛错）→ 仍 200 + JSON + `code:0`，进程存活；顶层 catch 兜底 `ai_error`（server.js:455）。
- `uncaughtException` / `unhandledRejection`：只打印 `err.code||err.name`（server.js:561），不退出。
- 并发 20 请求：`http.test.js:319` 全 200 JSON、无 ECONNRESET、`/health` 仍 200；本轮**新增断言** `gate.stats().peak >= 1 && <= 3` 与 `completed === 20`，即 AI 实际并发 ≤ 3 已被卡死。
- 加载优先级（DECISIONS #10）：`cache.test.js:116` 先 `store.load` 再 `cache.load`，断言 `cache.has(bankKey) === false`（同 key 脏缓存被丢弃）。丢弃逻辑放在 `createServer` 内，不在 LRU 内部。
- `requireVerified:true` 只作用于 store 层 `get/match`（DECISIONS #6，`store.test.js` 专项）；cache 层不受约束。
- `/api` 九步顺序固定（server.js 管线注释 + 实现顺序）；reason 映射：内部 `invalid_output` → 对外 `ai_error`，`bad_request` 仅用于请求本身非法（缺 q / 坏 JSON / >1MB / verify body 非法），与 DECISIONS #9 一致；所有响应（含 404）都带 `elapsed`（毫秒整数，DECISIONS #8）。
- 日志纪律：`log.moderation` 只写 `时间 + key.slice(0,12) + code + provider`（server.js:39）；`log.error/info` 只写 scope + 错误码；store/cache 的 `#warn` 只写错误码与计数。无题干/选项/答案原文入日志、无真实 Key。

## 3. DoD 核对（docs/TASKS.md T3 行）

| DoD | 结论 | 证据 |
|---|---|---|
| `node --test test/store.test.js test/cache.test.js test/http.test.js` 全绿 | ✅ | 31 tests / 31 pass / 0 fail，exit 0 |
| `node server.js` 起 8080，`/health` `/stats` `/api` 通 | ✅ | 上文 curl 实测，三端点均返回契约结构 |
| `bank.json.bak` 生成 | ✅ | 演示目录 `bank.json.bak` 存在且 `records 1` 可解析 |
| Ctrl+C 后 `cache.json` 完整 | ✅（方式见上） | SIGINT 处理器执行后 exit 0，`cache.json` version 1 / 1 entry / answer 为 string |
| handler 抛错仍返回 `code:0` | ✅ | `http.test.js:251` 断言 200 + JSON + code 0，进程存活 |
| 并发 20 请求无 ECONNRESET | ✅ | `http.test.js:319`，20/20 status 200 + JSON，peak 并发 ≤ 3 |
| 满足 CONTRACT §11 | ✅ | §11.1 端口、§11.2 数据、§11.5 日志、§11.6 单文件可跑、§11.7 健壮性逐条自查（见第 2 节） |

无 ❌ 项。

## 4. 契约歧义 → 需 T6 裁决

1. **HANDOFF §4.2 reason 枚举不含 `bad_request`**，但 CONTRACT §8 与 DECISIONS #9 明确要求对外返回 `bad_request`。保守实现：按 CONTRACT/DECISIONS 返回。建议：T6 把 `bad_request` 补进 HANDOFF §4.2 枚举。
2. **/api 失败时的 HTTP 状态码未定义**。保守实现：除未知路径 404 外一律 **200 + JSON**（含 bad_request / ai_error / queue_full / image_or_formula）。建议：确认 OCS 脚本端是否只看 body；若需要 4xx，裁决后我改一行。
3. **gate 的归属层级**：CONTRACT §7 `createAI({config,env,log,gate})` 已接收 gate，§8 又要求 server 侧限流。保守实现：server 构造唯一 gate 注入 `createAI`，管线里 `ctx.gate.run(() => ctx.ai.answer(...))` 只包一层；实测 T2 的 `createAI` 内部未再自建 gate，无双层限流。建议：契约明确「gate 由 server 注入且 AI 内部不得再包」。
4. **`ai.answer()` 入参形态**：保守传原文 `{key,type,title:q,options:rawOptions}`（`splitOptions` 后的原始选项文本，非归一化结果），type 为中文 label。建议：T6 与 T2 确认 prompt 是否需要归一化后的选项。
5. **`data/cache.json` 文件格式契约未定义**（只定义了 bank.json）。保守实现：`{version:1,updatedAt,entries:{key:{answer,source,type,model?,createdAt}}}`，临时文件 + rename。建议：写入 CONTRACT 以免 T4/T5 误解析。
6. **CONTRACT §3 的 `Store` 签名未列 `setVerified`**，但 DECISIONS #11 与任务要求需要它。保守实现：已提供 `setVerified(key, boolean) -> boolean`（key 不存在返回 false）。建议：补进 §3。
7. **`/stats.ai.queueFull` 口径**：`ai.stats().queueFull` 与 `gate.stats().rejected` 可能重复计数。保守实现：优先取 ai 的值，ai 未提供时才回退 gate.rejected。建议：统一由 gate 单一来源提供。
8. **POST 是否需支持 `application/x-www-form-urlencoded`**：契约只写 JSON body。保守实现：只解析 JSON（实测 form-encoded → `bad_request`）。建议：若 OCS 端会发表单编码，裁决后我加分支。
9. **`/admin/verify` 无鉴权**（契约未提）。保守实现：不加鉴权、仅监听本机；未知 key → `bad_request`（而非 404）。建议：确认未知 key 是否应返回独立 reason。
10. **LRU 新增只读 `flushing` getter**（返回写链 Promise，非契约字段），仅为让测试能 await 落盘、不改动既有签名。建议：T6 认可或要求改名。
11. **模块缺失回退**：server.js 对 matcher/gate/ai 用动态 import + try/catch，缺失时回退内置最小实现并打 `*_module_missing` 错误码。现 T1/T2 已落地，回退分支不再触发；建议 T6 决定是否保留（保留可让 M1 在无 T2 时仍可跑）。

## 5. 需转达其他任务

- **T2**：请确认 `createAI({config,env,log,gate})` 内部不再自建并发闸（歧义 3），并确认 `answer({key,type,title,options})` 收原文选项（歧义 4）。我这边不改 server.js 即可对接，本次演示已用你们真实模块跑通。
- **T1**：无阻塞。`makeKey(title, options)` 与 `Matcher.lookup` 形状与契约一致，L1/L2 命中与 `l2Suspicious` 计数已正常上报到 `/stats.match`。
- **T4**：`bank.json` 顶层为 `{version:1,updatedAt,records:[…]}`，Record 字段顺序严格照 HANDOFF §8.3（`model` 在 `source` 之后、`verified` 之前），`type` 存中文 label，`source='import'`；导入产物请直接写这个结构（`store.load` 也兼容裸数组）。
- **T5**：`store.records()` 返回只读数组引用供 bench 使用；`/stats.elapsed` 为固定长度环形采样的 p50/p95/p99（毫秒整数），bench 若要更高分位精度请告知，我调整采样容量。
- **T6**：以上 11 条歧义请裁决；裁决后凡涉及我文件的改动由我在本窗口执行，不需要你直接改 `server.js` / `lib/store.js` / `lib/cache.js`。

## 6. 接口速查

`lib/store.js`（CONTRACT §3，**无偏离**；`persistDebounceMs` 为额外可选构造参数，仅供测试注入，默认 1000）

```js
export class Store {
  constructor({ bankPath, bakPath, config, matcher, log, persistDebounceMs })
  async load(); get(key); match(title, options); add(record) -> record|null
  setVerified(key, verified) -> boolean          // DECISIONS #11，契约签名未列（见歧义 6）
  async persist() -> Promise<void>               // .bak 复制 + tmp/rename + 单写队列串行
  stats() -> {total,verified,bySource:{local,ai,import,fuzzy},l1Hits,l2Hits,l2Suspicious,noMatch}
  records() -> Record[]                          // 只读引用
}
export default Store;
```

`lib/cache.js`（CONTRACT §4，**无偏离**；仅新增只读 `flushing`，见歧义 10）

```js
export class LRU {
  constructor({ maxEntries=10000, file, flushIntervalMs=30000, log })
  async load(); get(key); set(key,value); has(key); delete(key)
  get size(); get flushing()                      // flushing 为新增只读 getter
  async flush(); stats() -> {size,hits,misses,evictions,writes,flushedAt}
  startAutoFlush()  /* interval.unref() */ ; stopAutoFlush()
}
export default LRU;
```

每 100 次 `set` 强制 flush；满 `maxEntries` 淘汰最久未使用（`get` 刷新热度）。

`server.js`（CONTRACT §8）

```js
export async function createServer(overrides = {})
// overrides: {config, paths, env, log, matcher, store, cache, gate, ai}（全部可注入，测试用）
// 返回 { server, app:{config,paths,log,matcher,store,cache,gate,ai},
//        listen(port=0,host) -> Promise<{address,port}>, close() -> Promise<void> }
export default createServer;
```

路由：`GET|POST /api`、`GET /health`、`GET /stats`、`POST /admin/verify`、`OPTIONS *`、其余 404。
只有 `node server.js` 直接运行时才 `listen(config.port)` 并注册 SIGINT/SIGTERM/uncaughtException/unhandledRejection。
`QBANK_MOCK_AI=1`（`config.mockAi`）启用内置假 AI，假答案只进 cache、不写 bank.json。


# T4「导入工具与数据生成」交付报告（供 T6 验收）

## 1. 文件清单

新增（本任务独占写权限内，绝对路径）：

```
D:\codex and chat gpt\ocs刷题助手题库搭建\tools\import.js
D:\codex and chat gpt\ocs刷题助手题库搭建\tools\genbank.js
D:\codex and chat gpt\ocs刷题助手题库搭建\test\import.test.js
D:\codex and chat gpt\ocs刷题助手题库搭建\test\fixtures\sample.csv   (1200 B)
D:\codex and chat gpt\ocs刷题助手题库搭建\test\fixtures\sample.tsv   (845 B)
D:\codex and chat gpt\ocs刷题助手题库搭建\test\fixtures\sample.txt   (1161 B)
D:\codex and chat gpt\ocs刷题助手题库搭建\test\fixtures\sample.json  (1869 B)
D:\codex and chat gpt\ocs刷题助手题库搭建\test\stubs\t4-store.js     (2129 B，仅隔离 T3 未完成时用)
```

声明：

- **未修改任何他人文件**：`lib/*`、`config.js`、`server.js`、`docs/*`、`HANDOFF.md`、`package.json` 均未改动（`package.json` 现仍无 `dependencies`/`devDependencies`，本次核对原文确认）。
- **仓库 `data/` 干净**：`Get-ChildItem -Recurse data` 仅 `data\.gitkeep`（0 B）。50k 大产物本次全部写入 `%TEMP%\qbank-t4-*`，未落 `data/bench.json`；上一轮生成的 `data/bench.json` 已删除。
- 无 `node_modules`，无第三方包。

## 2. 验收命令与结果

**① 全量测试**（命令：`node --test test/import.test.js`）结尾统计行原文：

```
ℹ tests 34
ℹ suites 0
ℹ pass 34
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 889.5107
```

**② 违禁项 grep**（`Select-String -Path tools/import.js,tools/genbank.js,test/import.test.js,test/stubs/t4-store.js -Pattern "require\(|node_modules|Math\.random"`）：命中 1 行，为 `tools/genbank.js:3` 的注释「禁用 Math.random」，**无实际 `require(`、无 `node_modules`、无 `Math.random()` 调用**。

**③ 四格式导入 + `--merge` 幂等**（`--out` 均指向 `%TEMP%\qbank-t4-dry-pU70cz\bank-<fmt>.json`，全部 exit=0）：

| 格式 | 第 1 次 stdout | 第 2 次（同库再导）stdout |
|---|---|---|
| csv | `{"parsed":9,"imported":7,"skipped":0,"duplicates":1,"failed":1,"elapsed":15}` | `{"parsed":9,"imported":0,"skipped":0,"duplicates":8,"failed":1,"elapsed":13}` |
| tsv | `{"parsed":7,"imported":5,"skipped":0,"duplicates":1,"failed":1,"elapsed":15}` | `{"parsed":7,"imported":0,"skipped":0,"duplicates":6,"failed":1,"elapsed":12}` |
| txt | `{"parsed":8,"imported":7,"skipped":1,"duplicates":1,"failed":0,"elapsed":16}` | `{"parsed":8,"imported":0,"skipped":1,"duplicates":8,"failed":0,"elapsed":13}` |
| json | `{"parsed":8,"imported":5,"skipped":0,"duplicates":1,"failed":2,"elapsed":13}` | `{"parsed":8,"imported":0,"skipped":0,"duplicates":6,"failed":2,"elapsed":12}` |

**④ `--dry-run` 不写盘**（目标 `%TEMP%\qbank-t4-dry-pU70cz\bank.json`）：先 `--merge` 建库，再 `--dry-run`；`mtimeMs 1795009727907.7937 → 1795009727907.7937`、`size 3027 → 3027`（unchanged=true）；对不存在目标 `nope.json` 跑 `--dry-run` 后 `created=false`。

**⑤ `--replace`**：csv 库 7 条 → 用 json fixture `--replace` 后 `records=5`（旧记录消失），`bank-replace.json.bak` 已生成，顶层键 `["version","updatedAt","records"]`，`version=1`，`updatedAt` 为 number。

**⑥ 裸数组兼容（DECISIONS #13）**：`bank-bare.json` 写成裸数组（1 条 `source:'manual'`）后 `--merge` 导入 tsv → `total=6`、`oldKept=true`、文件升级为 `{version,updatedAt,records}`。

**⑦ 错误退出码**（均 exit=1，stderr 单行中文，无堆栈、无题目原文）：

- 文件不存在：`[qbank][import][bad_request] 文件读取失败：<path>（ENOENT）`
- 非法 JSON：`[qbank][import][bad_request] JSON 解析失败（位置 13），请检查文件是否为合法 JSON`

**⑧ genbank 可复现**（`--count 2000 --seed 42`，输出 `%TEMP%\qbank-t4-report-mfaujl\gen-{a,b}.json`）：两次 SHA256 **完全一致** `3F94A112B7C740B2D79D16A0945CCB0DE88E1186FA8AF9D9975BBD3C59BC1592`，各 756315 B（与上一会话同 seed 的 hash 亦相同，跨会话稳定）。

**⑨ genbank 5 万条性能**（写临时目录，非 `data/`）：`--count 50000 --seed 42` → 进程 wall **840 ms**，内部 `generateMs 620 / elapsed 738`，文件 **19006924 B = 18.13 MB**，`records=50000`、`uniqueKeys=50000`，`byType` 单选 24924/多选 12520/判断 7445/填空 2581/问答 2530（49.8/25.0/14.9/5.2/5.1%），`nearDuplicates 2540`（5.08%）。**测试内不生成 5 万条**，测试只用 `--count 2000`。

## 3. DoD 核对（docs/TASKS.md T4 行，逐条）

| DoD | 结果 | 证据 |
|---|---|---|
| `node --test test/import.test.js` 全绿 | ✅ | 34 tests / 34 pass / 0 fail（§2①） |
| `genbank --count 50000` 60s 内产出 | ✅ | wall 840 ms，18.13 MB（§2⑨） |
| 同 seed 逐字节可复现 | ✅ | 两次 SHA256 全等（§2⑧）；`updatedAt` 固定 EPOCH，PRNG 为 mulberry32 |
| 四种 fixture 导入正确 | ✅ | csv/tsv/txt/json 各自 parsed/imported 数字符合 fixture 构造（§2③） |
| duplicates 统计准确 | ✅ | fixture 各含 1 条同 key 重复 → 首跑 duplicates=1；二跑 imported=0、duplicates 为全量（§2③） |
| `--dry-run` 不写盘 | ✅ | mtime/size 不变、缺失目标不创建（§2④） |
| 测试只写 `os.tmpdir()` | ✅ | 全部 `fs.mkdtempSync(os.tmpdir(),'qbank-t4-…')`；`data/` 仅 `.gitkeep`（§1） |
| 满足 CONTRACT §11（端口/数据/日志/健壮性/报告） | ✅ | 不开端口；错误带 `err.code=bad_request`；`lib/**` 无 `process.exit`（CLI 出口在 `tools/`）；stderr 只有路径/错误码/位置，无题干选项答案 |
| 任务级隔离要点：CLI 自测显式 `--out`、大产物不进测试 | ✅ | §2③④⑤⑧⑨ 全部显式 `--out` 到 `qbank-t4-*` 临时目录 |

无 ❌ 项。

## 4. 契约歧义 → 需 T6 裁决

1. **genbank 的 `updatedAt` 时间戳**：CONTRACT §0 要求「时间戳统一 `Date.now()`」，但与「同 seed 逐字节可复现」冲突。保守实现：genbank 产物固定 `updatedAt = 1700000000000`（仅合成数据文件），import 写库仍用 `Date.now()`。建议裁决：明确 bench 数据文件豁免 §0 时间戳规则，或允许 T5 bench 忽略 `updatedAt`。
2. **stdout 摘要字段超集**：CONTRACT §9 只列 `{parsed, imported, skipped, duplicates}`，任务书要求含 `failed/elapsed`。保守实现：输出超集 `{parsed,imported,skipped,duplicates,failed,elapsed}`（前 4 个字段名与语义不变）。建议裁决：把 `failed/elapsed` 追认进 §9。
3. **缺 type 列 + 多字母答案**：`normalizeType` 推断顺序（§1.4）在 `optionCount>=2` 时给 `单选`，会把多字母答案误判为单选并导致答案校验截断。保守实现：仅当 type 列缺失且未传 `--type` 时，若答案含多个字母则判 `多选`；显式 type/`--type` 一律优先。建议裁决：在 §1.4 推断顺序前增加「答案字母数 > 1 → 多选」一条（属 T1 文件，T4 不越权改）。
4. **TXT「答案：」空值续行**：真实 TXT 常见 `答案：` 后换行才写字母。保守实现：块内 `answerPending` 机制，取下一非空行作为答案；仍取不到则该块计入 `skipped`（不 `failed`、不整体失败）。建议裁决：追认为 §11 TXT 容错规则的一部分。
5. **`skipped` 与 `failed` 的语义边界**：契约未区分。保守实现：`skipped` = 整块无法解析/被跳过（TXT 块、缺题干的可疑块）；`failed` = 已解析出候选但归一化/建 Record 阶段抛错（如空题干、非法答案）。二者都不影响退出码 0。建议裁决：写入 §9 注释。
6. **近似重复的判定口径**：genbank 的 `nearDuplicates` 指「与已有题干编辑距离极小/选项乱序」的条数（约 5%），非 `makeKey` 相同；`collisions`（50k 时 1129）指 key 撞车后加确定性后缀保证 `uniqueKeys=count`。建议裁决：T5 bench 统计 L2 命中时以 `nearDuplicates` 为口径，勿把 `collisions` 当重复题。

## 5. 需转达其他任务

- **T1（重要，回应其转达事项）**：genbank **已是聚簇式生成** ✅，无需改造。策略为「主题池 × 子主题池 × 句式模板池 + 共享选项池」派生，非均匀随机文本。刚测数据（`--count 2000 --seed 42`）：`distinctTitles 1982/2000`、题干长度 17~50 字、**出现 ≥5 次的 6-gram 有 2039 个**（全部 6-gram 9876），最热的 8 字前缀被 23 条题干共享（其后 19/14/12/11 条）。因此倒排候选桶是稠密的，matcher「候选 < 5 → 全表打分」回退不会被频繁触发，L2 p95 不会因此失真。
- **T5**：bench 数据请直接用 `node tools/genbank.js --count 50000 --seed 42 --out data/bench.json`（约 0.9s / 18 MB），题型比例 50/25/15/5/5，内置约 5% 近似重复题可验 L2 与 tie-break；**不要**自己造随机文本，否则与上述聚簇特性不一致。`tools/bench.js` 若需要固定 `updatedAt` 语义，见 §4-1。T5 自测样本请用 `test/stubs/t5-*`，`test/fixtures/` 归 T4（其中 `accuracy_set.json` 是 T5 的文件，T4 未触碰）。
- **T3**：无。`tools/import.js` 按 CONTRACT §3/§6 签名使用 `lib/store.js`（读写 bank、`.bak` + 临时文件 rename 原子替换策略与其一致）；测试期用 `test/stubs/t4-store.js` 打桩，不依赖 T3 进度。
- **T2**：无。
- **T6**：请对 §4 的 1~6 条给出裁决；集成时注意 import 的退出码语义（0 成功含部分 `failed`，1 才是致命错误）。

## 6. 接口速查（以 CONTRACT §9 为准）

```
tools/import.js  --file <p> --format csv|tsv|txt|json [--merge|--replace] [--type 单选题]
                 [--dry-run] [--out data/bank.json] [--verbose] [--verified] [--help]
  stdout: 单行 JSON {"parsed":N,"imported":N,"skipped":N,"duplicates":N,"failed":N,"elapsed":ms}
  stderr: [qbank][import][<err.code>] <中文原因>（可含路径/行号/位置，无题目原文）
  exit  : 0 成功（含 skipped/failed 的部分成功）/ 1 失败
  默认  : 未给 --merge/--replace → merge；未给 --format → 按扩展名推断；未给 --out → data/bank.json

tools/genbank.js --count <N> [--out data/bench.json] [--seed 42] [--verbose] [--help]
  stdout: {"count","seed","out","bytes","nearDuplicates","collisions","byType","generateMs","elapsed"}
  产物  : {"version":1,"updatedAt":1700000000000,"records":[...]}；mulberry32 确定性 PRNG
  exit  : 0 / 1
```

偏离说明（均为超集，非破坏性）：① import stdout 多 `failed`/`elapsed`（任务书要求，见 §4-2）；② 多 `--verbose`/`--verified`/`--help` 开关（`--verified` 为任务书要求）；③ genbank 多 `--verbose`/`--help`，stdout 附统计字段；④ genbank `updatedAt` 为固定 EPOCH 而非 `Date.now()`（§4-1）。Record 字段严格照 HANDOFF §8.3，顺序为 `key,title,options,answer,type,source,verified,createdAt`，`source='import'`、`verified=false`（`--verified` 可置 true）、`type` 存 `toLabel()` 后的中文标签（如 `多选题`）；填空/问答 `options` 为 `[]`，判断题恒为 2 个选项（50k 产物实测通过）。

**TXT 解析器已知局限**：仅支持「题型关键字/题号 + `A. B. C. D.` 选项行 + `答案：/参考答案：/正确答案：`」结构；不支持 (1) 选项跨多行折行后无标号的续行、(2) 表格型/图片型题目、(3) 答案解析段落与下一题混排且无空行分隔（依赖「已答 + 新题号」启发式切分，编号缺失时可能并块）、(4) 填空题多空答案的顺序校验（原样归一化保存）。上述情况一律计入 `skipped`，不会导致整体失败或退出码非 0。


# T5「基准、评测与 README」交付报告（供 T6 验收）

> 本次所有数字来自本轮重跑（2026-11-18，Node v24.21.0，PowerShell，仓库无 `.git`）。
> **性能/准确率结论一律标注「待 T6 实测」**；本轮只证明「工具能跑、逻辑正确、文档齐全」。

## 1. 文件清单

新增（我拥有独占写权限的 4 个交付物）：

```
D:\codex and chat gpt\ocs刷题助手题库搭建\tools\bench.js                    24082 B
D:\codex and chat gpt\ocs刷题助手题库搭建\tools\accuracy.js                 46624 B
D:\codex and chat gpt\ocs刷题助手题库搭建\test\fixtures\accuracy_set.json    3271 B
D:\codex and chat gpt\ocs刷题助手题库搭建\README.md                         49602 B
```

自测桩（在我的 `test/stubs/t5-*` 隔离区内）：

```
D:\codex and chat gpt\ocs刷题助手题库搭建\test\stubs\t5-selfcheck.js        55548 B
D:\codex and chat gpt\ocs刷题助手题库搭建\test\stubs\t5-sample-bank.js       5950 B
D:\codex and chat gpt\ocs刷题助手题库搭建\test\stubs\t5-readme-smoke.js      7482 B
```

- **未改动任何他人文件**：`config.js`、`lib/**`、`server.js`、`tools/import.js`、`tools/genbank.js`、`test/*.test.js` 全部只读 import。
- **未动** `package.json`、`docs/**`、`HANDOFF.md`（本轮 0 次写入）。
- **仓库洁净度**：早前一次 bench 试跑曾在 `data/` 落下 `bench.json`(19MB)+`.bak`（已被 `.gitignore` 的 `data/*.json` 忽略），本轮已删除；现 `data/` 与 `logs/` 均只剩 `.gitkeep`。本轮 bench 数据全部生成在 `os.tmpdir()\qbank-t5-*`，跑完 `rmSync` 清空（残留计数 0）。
- `test/fixtures/` 只有我的 `accuracy_set.json`（3271 B < 20 KB）；T4 的 `sample.json/csv/tsv/txt` 是 T4 自己的，我没写也没改。

## 2. 验收命令与结果

隔离纪律：数据生成/读写全走 `os.tmpdir()` 的 `qbank-t5-` 前缀目录；`--mock` 全程不联网；真实链路测试注入桩 `createAI`；服务类自测用 `QBANK_PORT=0` + 临时 DATA/LOGS；bench **不发任何 HTTP**，直接 import 模块（源码中 `8080` 命中 0）。

```powershell
# a) 临时目录小样本（不写仓库 data/）
node tools\genbank.js --count 2000 --seed 42 --out $env:TEMP\qbank-t5-59a7b69d\bench.json   # GEN_EXIT=0
# b) bench 文本模式
node tools\bench.js --file $env:TEMP\qbank-t5-59a7b69d\bench.json --l1 3000 --l2 600 --warmup 50
```

```
记录数=2000（原始 2000，跳过非法 0） 索引条目=2000 构建耗时=44.767ms
trigram 索引：条目=3808 倒排总数=53707 L2 平均候选数=194.21
L1 精确命中   2000   avg 0.0096  p50 0.0085  p95 0.0121  p99 0.0325  max 0.6398  命中率 100.0%  精确/模糊 2000/0
L2 模糊匹配    600   avg 2.1606  p50 2.1857  p95 2.8083  p99 3.0416  max 3.5849  命中率  67.3%  精确/模糊 0/404
内存 rss=68.20MB heapUsed=20.85MB heapTotal=30.28MB
[达标判定 HANDOFF §12.6] L1 avg 0.0096ms < 1ms [OK] | L2 p95 2.8083ms < 50ms [OK] -> PASS      BENCH_EXIT=0
```

```powershell
node tools\bench.js --file <同上> --l1 1000 --l2 200 --warmup 20 --json    # JSON_EXIT=0
```

```
{"records":2000,"trigramEntries":3808,"buildMs":43.539,
 "l1":{"n":1000,"avg":0.0091,"p50":0.0085,"p95":0.0114,"p99":0.02,"max":0.3683,"hit":1},
 "l2":{"n":200,"avg":2.1504,"p50":2.1659,"p95":2.7184,"p99":2.994,"max":3.3607,"hit":0.705,"avgCand":193.42},
 "rssMb":67.11,"heapUsedMb":18.15,"limits":{"l1AvgMs":1,"l2P95Ms":50},"verdict":"PASS"}
```

```powershell
node tools\accuracy.js --mock                                                             # 缺 --file → USAGE + bad_request，EXIT=2
node tools\accuracy.js --mock --file test\fixtures\accuracy_set.json                      # MOCK_EXIT=0
node tools\accuracy.js --mock --mock-accuracy 0.8 --file test\fixtures\accuracy_set.json  # FAIL_EXIT=1
node tools\accuracy.js --file test\fixtures\accuracy_set.json                             # 无 Key → NOKEY_EXIT=2
```

```
题目=20（非法 0） | 总题数 20 | 通过 20 | 失败 0 | 总准确率 100%
分题型准确率：单选题 8/8 | 多选题 5/5 | 判断题 4/4 | 填空题 2/2 | 问答题 1/1（均 100%）
耗时 avg=15.6ms p50=15.6ms p95=20.8ms max=20.9ms | tokens in/out=740/83 | provider 命中：mock 20/20
[达标判定 HANDOFF §12.7] 总准确率 100% >= 85% -> PASS                                  MOCK_EXIT=0
--mock-accuracy 0.8 → 通过16/失败4，总准确率 80%，失败原因分布：ai_error=4 → FAIL       FAIL_EXIT=1
无 Key/ollama 探活失败 → [qbank][accuracy][ai_disabled] 中文提示 + sk-xxxxxxxx 占位     NOKEY_EXIT=2
```

```powershell
node --test test\stubs\t5-selfcheck.js test\stubs\t5-sample-bank.js test\stubs\t5-readme-smoke.js
```

```
ℹ tests 39  ℹ pass 39  ℹ fail 0  ℹ duration_ms 1084.8119        T5_TESTS_EXIT=0
✔ bench: 计时被注入成 10ms/次时判定 FAIL 且退出码 1
✔ bench: 无法执行的情况退出码 2（缺文件 / 未知参数 / --help）
✔ runAccuracy --mock --json：全对 -> 退出码 0，报表不泄露完整题干
✔ runAccuracy --mock-accuracy 0.8：确定性错 4 题 -> 退出码 1
✔ runAccuracy live：缺 Key / 探活失败 / ai.enabled=false / 未知 provider -> 退出码 2 且不联网
```

违禁项 grep（范围：`tools/bench.js`、`tools/accuracy.js`、3 个 t5 桩、`README.md`、fixture）：

| 检查项 | 命中 | 说明 |
|---|---|---|
| `require(` | **0** | 全 ESM |
| `node_modules`（tools+stubs） | **0** | README 里 1 处是「零依赖」说明文字，非依赖 |
| 硬编码 `8080` 发请求（tools+stubs） | **0** | 仅 `t5-readme-smoke.js` 的断言 `port !== 8080`；README 中的 8080 是 server 默认端口的用户文档 |
| 真实 Key `sk-[A-Za-z0-9_-]{10,}`（非 `sk-xxx`） | **0** | 示例一律 `sk-xxxxxxxx` |
| fixture 题干前 12 字出现在 README/tools/桩 | **0** | 报表只打题干前 8 字 + key 前 12 位 |

## 3. DoD 核对（`docs/TASKS.md` T5 行）

| # | DoD | 状态 | 证据 |
|---|---|---|---|
| 1 | bench.js / accuracy.js 能跑完并打印 PASS/FAIL，退出码正确 | ✅ | §2：bench EXIT=0；accuracy 0/1/2 三分支实测 |
| 2 | bench 的 FAIL→退出码 1 分支 | ✅ | `LIMITS` 为冻结常量、无 CLI 放宽口子；用注入计时（10ms/次）在 selfcheck 中断言 `exitCode=1` ✔ |
| 3 | accuracy `--mock` 完全离线（不联网、不需 `DASHSCOPE_API_KEY`） | ✅ | §2 MOCK_EXIT=0；桩测试断言无 fetch 调用 |
| 4 | bench 输出含 L1/L2 的 avg/p50/p95/p99 + rss + §12.6 判定 | ✅ | §2 文本表与 `--json` 字段齐备，另有 buildMs/trigram 条目/avgCandidates |
| 5 | accuracy_set.json 20 题、单选8/多选5/判断4/填空2/问答1、逐题人工确认答案 | ✅ | 脚本核对 `n=20`、`dist={"单选题":8,"多选题":5,"判断题":4,"填空题":2,"问答题":1}`、`answers present for all: true`。确认方式：逐题人工核答 + 反猜设计（单选 A/B/C/D 各 2 题、多选 5 个组合互不相同且含一个双选、判断正误各半），selfcheck 中用断言卡死这些分布 |
| 6 | 逐题输出只打题干前 8 字 + key，不打全文 | ✅ | §2 grep「题干片段外泄 0」+ selfcheck 断言报表截断 |
| 7 | README 覆盖 §12.8 五主题（安装/配置/OCS 对接含 §4.4 配置块/数据导入/故障排查）且无真实 Key | ✅ | 11 节 + 附录；§4.1 逐字给出 OCS 题库 JSON；Key 扫描 0 命中 |
| 8 | 满足 CONTRACT §11（端口/数据/日志/健壮性隔离） | ✅ | 临时目录、`QBANK_PORT=0`、`listen(0)`、`lib` 内无 `process.exit()`、错误带 `err.code`、跑完 39/39 不挂住 |
| 9 | **L1 avg < 1ms 达标结论** | ⏳ 待 T6 实测 | 2000 条小样本 0.0096ms，5 万条正式库需 T6 复跑归档 |
| 10 | **L2 p95 < 50ms 达标结论** | ⏳ 待 T4 聚簇数据确认 + T6 实测 | 见 §5-1：T4 `genbank.js` 已确认为模板聚簇（非均匀随机），小样本 p95=2.81ms；正式结论以 T6 跑 5 万条为准 |
| 11 | **总准确率 ≥ 85% 达标结论** | ⏳ 待 T6 实测 | 需真实 `DASHSCOPE_API_KEY` 或本地 Ollama；本轮只验证报表与判定逻辑 |

## 4. 契约歧义 → 需 T6 裁决

1. **`/health` 不暴露 `ai.enabled`**：`ai.enabled=false` 时 fallback 链仍非空，只有 `answer()` 返回 `ai_disabled`，运维从 `/health` 看不出 AI 被关。保守实现：不改他人文件，README §4.3 把「看 `/stats` 的 `ai.calls` 是否为 0 + 查 `ai.enabled`」写成显式排查步。建议：T6 决定是否给 `/health` 加字段（属接口扩张，我不自行动手）。
2. **`accuracy.js --out` 无默认值**：`docs/` 是 T6 领地，工具擅自写 `docs/accuracy-report.json` 会越权。保守实现：必须显式传 `--out` 才落盘，相对路径按 `cwd` 解析。建议：T6 集成时显式传路径并归档。
3. **退出码 2 的语义未在 CONTRACT §0 定义**：保守实现：无 Key / provider 全不可用 / `ai.enabled=false` / 未知 provider / 缺 `--file` / `--help` → 2，且 stdout 明写「不计为 FAIL」。建议：T6 在 CI 里把 2 归为「环境未就绪」而非红。
4. **`wrong_answer` / `invalid_item` 不是 §0 错误码**：保守实现：仅作为报表 reason 标签，不注入任何 `Error.code`。建议：T6 确认归档报表允许这两个标签。
5. **问答/填空的「答对」判据契约未定义**：保守实现：多选按 `#` 集合完全相等；判断归一化为「正确/错误」；填空逐空归一化相等；问答按「包含要点 **或** bigram Dice ≥ 0.6」。阈值写死并在 README §6.3 公开，避免主观放宽抬高准确率。建议：T6 若要更严，只调阈值不改结构。
6. **bench 的题库装载形态**：按 DECISIONS #13 同时兼容 `{records:[...]}` 与裸数组，非法条目计入 `skipped` 不抛异常（不依赖他人 loader 内部行为）。
7. **限流闸门可能被双重包裹**：`createAI` 内部已有 gate，外层再包会自锁。保守实现：评测只用一层外部并发闸门（`--concurrency`），provider 内部 gate 原样透传。建议：T6 确认集成后仍是单层。
8. **百分位算法未指定**：用线性插值（R type-7），在 README 与 `--json` 字段名中标注口径，避免与他人实现不一致。

## 5. 需转达其他任务

1. **→ T4（关于 T1 转达的聚簇问题，已核查，结论：无需返工，但请确认一件事）**：我读了 `tools/genbank.js`，题干不是均匀随机文本，而是**模板聚簇**生成——`TOPICS`(30) × `SUBTOPICS`(30) × `TITLE_TPL`(9) / `JUDGE_TPL`(4) / `FILL_TPL` 组合，共享大量中文 n-gram。实测证据：2000 条库 trigram 条目 3808、倒排总数 53707、**L2 平均候选数 194.21（逼近 candidateLimit=200 上限）**，说明「候选 < 5 → 全表打分」回退**几乎不触发**，L2 时延未失真。**请 T4 确认 5 万条规模下仍是同一模板池**（若届时为增大 key 唯一性而改成随机串拼接，L2 p95 会失真，需重跑）。在 T4 确认 + T6 实测前，报告中 L2 达标判定一律标注「⏳ 待 T4 聚簇数据 + T6 实测」。
2. **→ T6（集成实测与归档，我无 `docs/` 写权限）**：请跑
   `node tools/genbank.js --count 50000 --seed 42 --out <T6 指定路径>` →
   `node tools/bench.js --file <同上> --json` →
   `node tools/accuracy.js --file test/fixtures/accuracy_set.json --out docs/accuracy-report.json`（需 Key 或 Ollama），并把 §12.6 / §12.7 结论写进 `docs/ACCEPTANCE.md`。5 万条库 bench 全量约 21 s，rss ≈ 340 MB，请确认 CI 内存余量。
3. **→ T6**：裁决 §4-1（`/health` 是否暴露 `ai.enabled`）；若加字段，我同步更新 README §4.3。
4. **→ T6**：`package.json` 已有 `bench` / `accuracy` script（我未修改该文件）；若 T6 改脚本名，请通知我同步 README §2.6 表格。
5. **→ T2/T3（仅告知，无需改动）**：bench 的 L2 查询集是「改 1~2 字 + 截断」的强噪声集合，命中率约 67%~70% 属预期；§12.6 只卡时延，我未擅自把命中率加成验收线。若 T6 想纳入，请另行定义阈值。
6. **→ T6**：全量 13 文件 `node --test` 曾出现 1 次不可复现 flake（疑似并行负载下的时序断言），此后连续多次全绿（267/267）。建议 CI 若复现改用 `--test-concurrency=1`；我不修改他人测试文件。

## 6. 接口速查

**`tools/bench.js`**（直接 import `lib/store`+`lib/matcher`，不发 HTTP）

| 参数 | 默认 | 说明 |
|---|---|---|
| `--file <p>` | 必填 | 题库 JSON，兼容 `{records:[...]}` 与裸数组 |
| `--l1 <n>` | 10000 | L1 精确命中采样数（等步长取样，可复现） |
| `--l2 <n>` | 2000 | L2 近似查询采样数（确定性扰动，强制走模糊） |
| `--warmup <n>` | 200 | 预热次数，不计入统计 |
| `--json` | off | 机器可读输出 |
| `--help` | — | 打印 USAGE |

输出：文本表格（阶段/样本数/avg/p50/p95/p99/max/命中率/精确-模糊）+ 内存 rss/heapUsed/heapTotal + 索引构建耗时 + trigram 条目与倒排总数 + L2 平均候选数 + `[达标判定 HANDOFF §12.6]`；`--json` 顶层键 `bank/index/l1/l2/memory/limits/verdict`。计时 `process.hrtime.bigint()`，分位数 R type-7。
退出码：**0** PASS / **1** FAIL / **2** 无法执行（缺文件、未知参数、`--help`）。
偏离 CONTRACT §9：**无**（阈值 `l1AvgMs:1`、`l2P95Ms:50` 按 §12.6 写死为冻结常量，不提供放宽参数）。

**`tools/accuracy.js`**（走 `lib/ai/index.js` + `lib/queue.js` 真实链路）

| 参数 | 默认 | 说明 |
|---|---|---|
| `--file <p>` | 必填 | 测试集 JSON（CONTRACT §9 结构：`type/title/options/answer`） |
| `--provider <name>` | 配置链 | 覆盖 provider（如 `bailian`/`ollama`） |
| `--concurrency <n>` | 3 | 并发上限（外层闸门，不重复包裹 provider 内部 gate） |
| `--timeout <ms>` | 20000 | 单题超时 |
| `--json` | off | 机器可读输出 |
| `--out <p>` | **无默认** | 显式传入才落盘（相对路径按 cwd 解析） |
| `--mock` | off | 桩 provider 离线跑通报表逻辑（不联网、不花额度） |
| `--mock-accuracy <0~1>` | 1 | 仅配 `--mock`：确定性制造错误，验证 FAIL 分支 |

输出：逐题行（序号/题型/结果/key 前 12 位/题干前 8 字/期望/实际/provider/ms/tokens in-out/reason）+ 汇总（总准确率、分题型准确率、耗时 avg/p50/p95/max、总 tokens、失败原因按 reason 计数、provider 命中分布）+ `[达标判定 HANDOFF §12.7]`。
退出码：**0** 准确率 ≥ 85% / **1** < 85% / **2** 无法评测（无 Key、探活失败、`ai.enabled=false`、未知 provider、缺 `--file`），**2 不计为 FAIL**。
偏离 CONTRACT §9：新增 `--mock` / `--mock-accuracy` 两个离线自测开关（任务书要求，不影响真实链路语义）；`--out` 刻意不设默认值（见 §4-2）。