# qbank T6 集成与验收报告（ACCEPTANCE）

- 任务：T6「集成与验收」（里程碑 M5 收口），任务书 `docs/PROMPT_T6.md`
- 环境：Windows + PowerShell，Node v24.21.0，零第三方依赖，ESM，无 .git / 无 node_modules
- 日期：2026-11-19（演示跨 11-18/11-19 两日，日志时间戳为 UTC）
- 测试基线：T1~T5 交付 267 pass / 0 fail → T6 收口 **285 pass / 0 fail**（glob 口径）/ **292 pass / 0 fail**（`node --test` 自动发现口径，多 7 条 stub 自检）；2026-11-22 D3 修复再增 10 条 → glob **295/0**、全量 **302/0**
- 权限纪律：`HANDOFF.md` 两处契约增补经用户批准（2026-11-19 注解「批准」）后写回 §4.1/§4.2（见「契约增补」）；未放宽任何 §12 判据；
  全部跨任务改动见「变更表」；真实 AI 调用发生在 §12.3（本地假 provider，零联网）与 §12.7（用户提供 Key，20 题 qwen-flash，
  两次独立评测均 20/20=100%，tokens 合计 5241/次，花费几分钱以内；Key 仅注入子进程环境变量，未落盘入库）。
- 补记（2026-11-22）：§12.2 经侧边栏浏览器实测改判 **PASS**（证据见 §2.2），HANDOFF §12 八项全部通过；
  新增发现 D1~D4 处置见 §2.2/§11；HANDOFF §4.4 契约补丁（Patch 3）2026-11-22 获批写回。正式部署已获用户授权（侧边栏批注「可以」）。
  另修复 `test/stubs/t5-readme-smoke.js` 环境隔离缺口（宿主机用户级持久 Key 致「缺 Key」场景误报，剔除后断言语义不变），
  复跑基线 **285/0**、全量 **292/0**（变更表第 28 行）。
  另 2026-11-22 按用户批准 Patch 4 修复 D3（选项图片占位杂质清洗 + 纯图片选项拦截，HANDOFF §5/§7.6 写回），
  新增 10 条用例，基线 glob **295/0**、全量 **302/0**（变更表第 30~33 行）。

---

## 1. 验收结果总表（HANDOFF §12.1~12.8）

| # | 验收项 | 判据 | 结果 | 证据 |
|---|---|---|---|---|
| 12.1 | 启动 + /health | 无报错、HTTP 200 | **PASS** | §2.1 原始输出 |
| 12.2 | OCS 粘贴配置实测 | 浏览器搜题填答 | **PASS**（2026-11-22 侧边栏实测） | §2.2 /stats 快照 + 4 张截图（docs/evidence/） |
| 12.3 | 新题走 AI + 回写 + 二次零 AI 调用 | bank 新增 source:ai；ai.calls delta=0；二次 source:local | **PASS** | §2.3 原始输出 |
| 12.4 | 并发 20 | 不崩、inflight 峰值<=3、其余排队/queue_full | **PASS** | §2.4 原始输出（峰值=3，20/20 HTTP 200） |
| 12.5 | 四种异常 | code:0 且进程存活（同运行二次请求可应答） | **PASS**（a/b/c/d 全过） | §2.5 四段原始输出 |
| 12.6 | bench 5 万条 | L1 avg < 1ms、L2 p95 < 50ms | **PASS**（0.0087ms / 13.6925ms） | §2.6 原始输出 |
| 12.7 | accuracy 20 题 | 真实准确率 >= 85% | **PASS（真实 100%，20/20，两次独立评测）** | §2.7（用户提供 Key，bailian qwen-flash）+ docs/accuracy-report.json |
| 12.8 | README 五主题 | 照着做能跑通 | **PASS**（修复 8 处后复测通过） | §2.8 + 变更表 |

阻断性缺陷：**0**（无 500、无未捕获异常、无连接重置、无进程退出）。
集成期发现并修复的缺陷共 4 类：README §2.4 顺序错误（§2.8）、`node --test test/` 目录参数在 Node 24 失效（§3.3）、
listen(0) 随机命中 fetch bad port 导致测试随机假失败（§3.2，根因修复）、OCS 配置模板 `method:"fetch"` 笔误
（D1，§12.2 侧边栏实测发现；README/ACCEPTANCE 已修，HANDOFF §4.4 补丁 Patch 3 于 2026-11-22 获批写回）。

---

## 2. HANDOFF §12 逐条实测（原始命令 + 原始输出）

> 演示由一次性 PowerShell 辅助脚本驱动（t6-*.ps1 / t6-fake.mjs / t6-concurrent.mjs，收尾已全部删除），
> 下文给出等价的可复现命令要点；输出为脚本捕获的**原样文本**（未删改）。
> 除 §12.1/12.2/12.3/12.4/12.5/12.8 的真实启动演示外，其余测试一律 listen(0) + os.tmpdir()。
> 每段演示结束后 8080 均确认释放（输出里的 `8080 released: True`）。

### 2.1 §12.1 启动 + /health —— PASS

命令要点：

```powershell
node server.js        # 仓库根目录直接启动（无 Key 环境：bailian 被剔除，链=ollama）
curl.exe http://127.0.0.1:8080/health
# 测完立即结束进程，释放 8080
```

原始输出：

```text
GET /health -> HTTP 200
{"code":1,"status":"ok","uptime":1789,"version":"1.0.0","bank":0,"ai":{"enabled":true,"chain":["ollama"]}}
8080 released: True
--- server stderr ---
[qbank][config][no_key_bailian] provider "bailian" 需要环境变量 DASHSCOPE_API_KEY，当前未设置，已从 fallback 链剔除。设置方式：复制 .env.example 为 .env 并填入，或先执行 $env:DASHSCOPE_API_KEY="你的Key" 再启动。
[qbank][store][bank_missing] 内部错误
[qbank][server][listening] http://127.0.0.1:8080 ai=ollama
```

说明：stderr 三行均为**预期内的中文提示/日志**（no_key_bailian 配置提示、bank_missing 首次建库提示、listening），
不是报错；进程正常监听。`ai:{enabled,chain}` 为 P0-8 裁决新增的附加字段（契约增补 Patch 2）。

### 2.2 §12.2 OCS 对接 —— PASS（2026-11-22 侧边栏浏览器实测闭环）

**可直接粘贴的 OCS 题库配置**（D1 修正版，侧边栏实测可用；HANDOFF §4.4 原文 `method:"fetch"` 为笔误，契约补丁见 §7 Patch 3，**2026-11-22 已批准写回**）：

```json
[{"name":"本地混合题库","url":"http://127.0.0.1:8080/api?q=${title}&type=${type}&options=${options}","method":"get","type":"fetch","contentType":"json","headers":{},"handler":"return (res)=> res.code===1 ? [res.question,res.answer] : undefined"}]
```

**预期看到什么（核对清单）**：

1. **先导入题库，再启动服务**（顺序重要，见 §2.8 的 A/B 实测）：
   `node tools/import.js --file test/fixtures/sample.csv --format csv --merge` → `node server.js`。
2. OCS 设置 → 题库配置 → 粘贴上面 JSON → 保存。
3. 刷新网课页面，**先清 OCS 客户端缓存（见第 7 步）再重点击题号**，遇到**库里已有的题**：OCS 应自动填答，服务端 `/stats` 的 `match.l1` 增长，
   响应 `source:"local"`（可用 `curl.exe "http://127.0.0.1:8080/api?q=<题干>&type=<题型>&options=<选项>"` 复核）。
4. 遇到**库里没有的新题**：走 AI（需 DASHSCOPE_API_KEY 或本地 Ollama），响应 `source:"ai"`，
   `data/bank.json` 新增一条 `source:"ai"` 记录；同题第二次请求 `source:"local"` 且 `ai.calls` 不增长。
5. 含图片/公式的题：返回 `code:0, reason:"image_or_formula"`，OCS 不填答（预期行为，宁可不答不错答）。
6. 全程服务端不应出现 500 / 进程退出；`/health` 始终 200。
7. **清 OCS 客户端缓存（重测本地命中前必做，D2）**：OCS 设置 → 通用 → 拓展应用 → 题库缓存 → **清空题库缓存**，
   然后**重新点击题号**触发搜题。否则 OCS 直接用客户端缓存截胡（结果带「题库缓存」标签），
   服务端 `match.l1` 不动，会被误判成「服务端没命中」。
8. **本地命中判定口径**：`/stats` `match.l1` 增量 **且** OCS 结果**无**「题库缓存」标签，两者同时满足才算服务端命中；
   自动填答 = 页面选项进入选中态。

**状态：PASS —— 2026-11-22 侧边栏浏览器实测交接（用户在 OCS 客户端完成；验收期仓库零改动）**

实测环境：临时隔离目录 `%TEMP%\qbank-verify`（`QBANK_DATA_DIR`/`QBANK_LOGS_DIR` 指向该目录，测毕已删）；
临时服务连续运行约 25 分钟（PID 28740，测毕已停、8080 已释放）；Key 为主线程用户提供的那把（仅环境变量注入）。

**最后一次 /stats 快照（清理前读取）**：

| 指标 | 值 | 解读 |
|---|---|---|
| bank.total | 14 | import 7 + AI 回写 7 |
| match.l1 | 2 | 1 次 curl 复核 + 1 次 OCS 浏览器真实本地命中 |
| match.noMatch | 45 | 新题走 AI 管线（预期） |
| match.imageOrFormula | 3 | 1 次 curl + 2 次 OCS 真实带图题被拦（fail-closed 正确） |
| cache.hits | 0 | 缓存层未命中（预期） |
| ai.calls | 77 | bailian 42（7 成功 / 35 invalid_output）+ ollama 35 全失败（本机未安装，预期） |

- `/health` 全程 200，无 500、无崩溃、无连接重置；
- 真实页面 bailian 35/42 的 invalid_output 源于超星选项文字混入编辑器图片占位链接（spacer.gif），
  见 §11 P1 单（D3，2026-11-22 已按 Patch 4 修复）；对照 §12.7 干净题集 100% —— 服务 fail-closed 行为本身正确，非 §12.2 阻塞项；
- 费用：qwen-flash 累计输入约万级 token，分币量级。

**浏览器截图（4 张，归档于 `docs/evidence/`）**：

| # | 文件 | 证明什么 |
|---|---|---|
| ① | [ocs-12.2-01-config-rejected.png](evidence/ocs-12.2-01-config-rejected.png) | 红字「不支持的请求方式」= 旧配置 `method:"fetch"` 被 OCS 客户端拒绝（D1 直接证据） |
| ② | [ocs-12.2-02-connected-zero-result.png](evidence/ocs-12.2-02-connected-zero-result.png) | 修正配置后连通：0 结果 + 黄条「答案选项不匹配」（新题不在库，预期） |
| ③ | [ocs-12.2-03-ocs-client-cache-hit.png](evidence/ocs-12.2-03-ocs-client-cache-hit.png) | 1 结果 + 「题库缓存」标签 + 选项 A 自动选中 = **OCS 客户端缓存**命中（非服务端，D2 直接证据） |
| ④ | [ocs-12.2-04-server-local-hit.png](evidence/ocs-12.2-04-server-local-hit.png) | 清 OCS 缓存后重搜：1 结果无缓存标签 + A 自动选中 = **服务端本地命中闭环**；顶部蓝条「将等待3秒后保存或提交」 |

**本地命中判定口径（复测/部署陪跑用）**：`/stats` `match.l1` 增量 **且** 结果无「题库缓存」标签；
自动填答 = 页面选项进入选中态。图片/公式题：`/api` 返回 `code:0 reason:image_or_formula`，OCS 显示 0 结果。

**本次实测发现（D1~D4，处置见 §11 / 变更表）**：
- D1 配置模板 `"method":"fetch"` 笔误（官方 schema：`method∈{get,post}`、`type∈{fetch,GM_xmlhttpRequest}`、`contentType∈{json,text}`，
  <https://docs.ocsjs.com/docs/other/api>）；README §4.1 与本节已修；HANDOFF §4.4 属接口契约，补丁见 §7 Patch 3（**2026-11-22 已批准写回**）；
- D2 OCS 客户端缓存截胡本地命中重测 → 上方清单增补第 7/8 步；
- D3 选项图片占位 URL 干扰 AI 输出（35/42 invalid_output）→ §11 P1 单，**2026-11-22 已按 Patch 4 修复**（§7）；
- D4 ollama 备用链本机未安装时恒失败（预期）→ README §3.5 标注「可选」。

**用户侧已知风险（侧边栏已告知，无需服务端动作）**：OCS 自动提交可能已把 1.2 页答案（含未答出的填空题）
保存/提交到超星，由用户自行查看状态与重做机会。

### 2.3 §12.3 新题走 AI → 回写 bank.json → 二次请求零 AI 调用 —— PASS

命令要点（假 provider 由 `test/stubs/t2-fakeProvider.js` 起在 listen(0)，ok 模式；**零真实联网、零花费**）：

```powershell
# 1) 起本地假 provider（ok 模式），记下其 baseUrl
# 2) 覆盖环境变量后启动服务（不改 config.json）：
$env:QBANK_BAILIAN_BASE_URL = "<假provider baseUrl>"
$env:DASHSCOPE_API_KEY = "sk-xxxxxxxx"     # 占位 Key，只发给本地假 provider
$env:QBANK_AI_FALLBACK = "bailian"
node server.js
# 3) POST /api 同一道新题两次，期间 GET /stats 比对 ai.calls，并查看 data/bank.json
```

原始输出：

```text
InvalidOperation: C:\Users\<user>\AppData\Local\Temp\t6-12-3.ps1:6
Line |
   6 |  … $fakeOut) { $c = ([string](Get-Content $fakeOut -Raw -ErrorAction Sil …
     |                ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     | You cannot call a method on a null-valued expression.

fake provider: http://127.0.0.1:4414
before ai.calls=0
first response: {"code":1,"question":"中国梦的本质内涵是什么","answer":"A#B","source":"ai","elapsed":30}
mid ai.calls=1 (首次请求后)
--- data/bank.json (回写证据) ---
{"version":1,"updatedAt":1795017916950,"records":[{"key":"d0f1f4cbfea7dcbbf2e7b0609e5fd808647538270afa7fbf2af1846a7a5d96b0","title":"中国梦的本质内涵是什么","options":["A.富强","B.振兴"],"answer":"A#B","type":"多选题","source":"ai","model":"stub-model","verified":false,"createdAt":1795017915941}]}
second response: {"code":1,"question":"中国梦的本质内涵是什么","answer":"A#B","source":"local","elapsed":0}
after ai.calls=1 二次请求前后 delta=0
8080 released: True
```

> 注：开头 4 行 `InvalidOperation` 是辅助脚本轮询假 provider 输出文件时的**竞态噪声**
> （文件尚未写入时读了一次空值），随后轮询成功（`fake provider: http://127.0.0.1:4414`），
> 与服务本体无关，按「原始输出不删改」纪律保留。

判定：
- 首次请求 `source:"ai"`、`answer:"A#B"`（假 provider 按脚本应答，管线后处理/校验通过）；
- `data/bank.json` 新增一条 `source:"ai", model:"stub-model", verified:false` 记录（回写证据，key 为 makeKey 口径）；
- 二次请求 `source:"local"`、`elapsed:0`，`ai.calls` 前后 **delta=0**（1→1）——零新增 AI 调用，判据满足。
- 演示后 data/ 已恢复 .gitkeep 干净状态（§12 清理记录）。

### 2.4 §12.4 并发 20 请求 —— PASS

命令要点：假 provider ok 模式 + `QBANK_BAILIAN_BASE_URL` 覆盖；默认 `concurrency=3, queueLimit=200`；
用 Node 脚本同时发出 20 个**互不相同的新题** POST /api，期间高频采样 `/stats` 的 `ai.inflight`。

原始输出：

```text
fake provider: http://127.0.0.1:4251
HTTP200=20/20 分布={"code1":20} 总耗时ms=67
采样到的 ai.inflight 峰值=3 (判据 <=3)
结束后 stats.ai={"calls":20,"inflight":0,"queued":0,"queueFull":0}
并发后 /health HTTP=200
8080 released: True
```

判定：20/20 HTTP 200 且全部 `code:1`；采样到的 `ai.inflight` 峰值=3（<=3）；
20 个请求全部被处理（calls=20），超出 3 的部分**排队**（默认 queueLimit=200 足够，queueFull=0，
符合「其余排队**或** queue_full」）；结束后 inflight/queued 归零，/health 仍 200，进程存活。
`queue_full` 分支另在 test/e2e.test.js 用调小 queueLimit 的方式确定性覆盖（§3.1 第 5 条）。

### 2.5 §12.5 四种异常 —— PASS（a/b/c/d 全部 code:0 且进程存活）

每段都在**同一次运行**里连发第二个请求验证进程没退出，并以 /health 200 收尾。

#### 2.5a 断网/DNS 失败 —— PASS

命令要点：`$env:QBANK_BAILIAN_BASE_URL="https://qbank-t6-nonexistent.invalid/v1"`（环境变量覆盖，不改 config.json）
+ `DASHSCOPE_API_KEY=sk-invalid` + `QBANK_AI_FALLBACK=bailian`，`node server.js`，POST 新题两次。

```text
dns-fail response: {"code":0,"question":"","answer":"","reason":"ai_error","elapsed":23}
second response(进程存活即有应答): {"code":0,"question":"","answer":"","reason":"ai_error","elapsed":2}
health after: HTTP 200
8080 released: True
```

#### 2.5b 401 无效 Key —— PASS

命令要点：假 provider **401 模式**（每次请求都回 401 InvalidApiKey）+ `DASHSCOPE_API_KEY=sk-invalid`
+ `QBANK_BAILIAN_BASE_URL=<假provider>` + `QBANK_AI_FALLBACK=bailian`。

```text
fake provider: http://127.0.0.1:6173
401 response: {"code":0,"question":"","answer":"","reason":"ai_error","elapsed":29}
second response: {"code":0,"question":"","answer":"","reason":"ai_error","elapsed":3}
health after: HTTP 200
8080 released: True
```

判定：401 不重试、单 provider 链直接 chainExhausted → `ai_error`；第二请求仍应答（进程存活）。

#### 2.5c DataInspectionFailed 审核拦截 —— PASS（本地假 provider 模拟，未真实触发审核）

命令要点：假 provider **moderation 模式**（仅首次请求回 400 `DataInspectionFailed`，之后正常）+
`QBANK_AI_FALLBACK=bailian`（单链，降级无下一家 → `ai_moderation`）。

```text
fake provider: http://127.0.0.1:6179
moderation response: {"code":0,"question":"","answer":"","reason":"ai_moderation","elapsed":39}
second response: {"code":1,"question":"审核拦截后的正常题目","answer":"A#B","source":"ai","elapsed":5}
health after: HTTP 200
--- logs/moderation.log ---
2026-11-18T16:04:33.117Z key=46ff3ceb21a5 code=DataInspectionFailed provider=bailian

日志含题干原文: False
8080 released: True
```

判定：首次 `code:0, reason:"ai_moderation"`；`logs/moderation.log` 恰好一行，
只含 时间戳/key前12位/错误码/provider 名，**不含题干原文**（脚本断言 `日志含题干原文: False`）；
第二个正常请求 `code:1, source:"ai"`（进程存活且功能恢复）。

#### 2.5d 请求超时 —— PASS

命令要点：假 provider **timeout 模式**（首次请求挂住 30s 不响应）+ `$env:QBANK_TIMEOUT_MS="2000"`。

```text
fake provider: http://127.0.0.1:6185
timeout response: {"code":0,"question":"","answer":"","reason":"ai_timeout","elapsed":2016} 耗时ms=2027
second response: {"code":1,"question":"超时后的正常题目","answer":"A#B","source":"ai","elapsed":16}
health after: HTTP 200
8080 released: True
```

判定：`ai_timeout` 且 elapsed≈2016ms（从 task 开始执行起算，P1-9 口径）；
第二个正常请求 `code:1`（进程存活）；/health 200。

### 2.6 §12.6 性能 bench（5 万条全量）—— PASS

原始命令（与任务书一致；产物写 `$env:TEMP`，**不进仓库 data/**，测完已删）：

```powershell
node tools/genbank.js --count 50000 --seed 42 --out $env:TEMP\qbank-bench.json
node tools/bench.js --file $env:TEMP\qbank-bench.json --json
```

genbank 原始输出（exit 0）：

```text
{"count":50000,"seed":42,"out":"C:\\Users\\<user>\\AppData\\Local\\Temp\\qbank-bench.json","bytes":19006924,"nearDuplicates":2540,"collisions":1129,"byType":{"单选题":24924,"多选题":12520,"判断题":7445,"填空题":2581,"问答题":2530},"generateMs":630,"elapsed":758}
```

bench 原始输出（exit 0，完整 JSON）：

```json
{
  "tool": "bench",
  "schemaVersion": 1,
  "generatedAt": 1795017942383,
  "node": "v24.21.0",
  "file": "C:\\Users\\<user>\\AppData\\Local\\Temp\\qbank-bench.json",
  "args": {
    "l1": 10000,
    "l2": 2000,
    "warmup": 200,
    "requestedL1": 10000,
    "requestedL2": 2000
  },
  "bank": {
    "records": 50000,
    "total": 50000,
    "skipped": 0
  },
  "index": {
    "buildMs": 1139.499,
    "size": 50000,
    "trigramEntries": 11109,
    "trigramPostings": 1338504,
    "matchConfig": {
      "fuzzyThreshold": 0.9,
      "suspiciousThreshold": 0.8,
      "acceptSuspicious": false,
      "candidateLimit": 200
    }
  },
  "l1": {
    "samples": 10000,
    "avgMs": 0.0087,
    "minMs": 0.0031,
    "p50Ms": 0.0082,
    "p95Ms": 0.0113,
    "p99Ms": 0.0307,
    "maxMs": 0.1903,
    "totalMs": 87.014,
    "hitRate": 1,
    "exactHits": 10000,
    "fuzzyFallback": 0,
    "misses": 0
  },
  "l2": {
    "samples": 2000,
    "avgMs": 8.4066,
    "minMs": 1.7131,
    "p50Ms": 8.2931,
    "p95Ms": 13.6925,
    "p99Ms": 15.5158,
    "maxMs": 19.3774,
    "totalMs": 16813.273,
    "hitRate": 0.6715,
    "exactHits": 0,
    "fuzzyFallback": 1343,
    "misses": 657,
    "suspicious": 0,
    "avgCandidates": 200,
    "l1Collisions": 0
  },
  "memory": {
    "rssBytes": 360984576,
    "heapUsedBytes": 186201160,
    "heapTotalBytes": 307699712,
    "rssMb": 344.26,
    "heapUsedMb": 177.58,
    "heapTotalMb": 293.45
  },
  "limits": {
    "l1AvgMs": 1,
    "l2P95Ms": 50
  },
  "verdict": {
    "pass": true,
    "status": "PASS",
    "l1": {
      "metric": "avg",
      "limitMs": 1,
      "valueMs": 0.0087,
      "samples": 10000,
      "pass": true
    },
    "l2": {
      "metric": "p95",
      "limitMs": 50,
      "valueMs": 13.6925,
      "samples": 2000,
      "pass": true
    },
    "note": ""
  }
}
```

判定（判据未放宽）：
- **L1 avg = 0.0087ms < 1ms**（10000 采样，hitRate=1）→ PASS；
- **L2 p95 = 13.6925ms < 50ms**（2000 采样，hitRate=0.6715，fuzzyFallback=1343，avgCandidates=200）→ PASS；
- rss ≈ 344.26MB，与 T5 预估（≈340MB）一致；索引构建 1139ms；
- L2 命中口径以 `nearDuplicates=2540` 为准（P1-5），`collisions=1129` 为同 key 不同题、不算重复题；
- 分位数口径 R type-7（P1-12）。
- 对比 T5 的 2000 条小样本（L1 0.0096ms / L2 p95 2.81ms）：5 万条下 L1 基本持平、L2 p95 升至 13.69ms，仍远低于 50ms 判据。

### 2.7 §12.7 准确率（20 题）—— PASS（真实 100%，20/20）

**第一步：离线 mock 验报表逻辑（不联网、零花费）**

```powershell
node tools/accuracy.js --file test/fixtures/accuracy_set.json --mock
```

原始输出（exit 0）：

```text
[qbank][config][no_key_bailian] provider "bailian" 需要环境变量 DASHSCOPE_API_KEY，当前未设置，已从 fallback 链剔除。设置方式：复制 .env.example 为 .env 并填入，或先执行 $env:DASHSCOPE_API_KEY="你的Key" 再启动。
[qbank][accuracy] 测试集=test/fixtures/accuracy_set.json 模式=mock 题目=20（非法 0）
[qbank][accuracy] provider 链=mock 并发=3 单题超时=20000ms 判定阈值=85%
[qbank][accuracy] mock 模式：桩 provider 离线应答，不联网、不消耗真实额度

   #题型      结果  key(12)       题干(前8字)         期望            实际            provider        ms tokens     备注          
----------------------------------------------------------------------------------------------------------------------------------
  01单选题    PASS  0b82c6949060  在计算机中，1 …     A               A               mock            18      37/5  letters       
  02单选题    PASS  3c6293ebae46  下列 HTML …         B               B               mock            19      37/3  letters       
  03单选题    PASS  d81159bab015  函数 f(x) …         C               C               mock            19      37/2  letters       
  04单选题    PASS  385cc0c8047a  光在真空中的传播…   D               D               mock            15      37/3  letters       
  05单选题    PASS  83e99199d9dd  下列物质中，属于…   A               A               mock            15      37/3  letters       
  06单选题    PASS  3e223be9a18c  按质量计算，人体…   C               C               mock            15      37/3  letters       
  07单选题    PASS  2c79fd48f403  中国古典小说《红…   B               B               mock            15      37/2  letters       
  08单选题    PASS  f6db22b2b20a  OSI 参考模型…       D               D               mock            15      37/4  letters       
  09多选题    PASS  36a4291c940c  下列设备中，属于…   A#C#D           A#C#D           mock            15      37/3  letters       
  10多选题    PASS  1f77f2a9c3b2  下列能源中，属于…   A#B#D           A#B#D           mock            16      37/6  letters       
  11多选题    PASS  69bad884b1b0  下列数据结构中，…   B#C#D           B#C#D           mock            16      37/6  letters       
  12多选题    PASS  21774fbf7acf  下列成果中，属于…   A#B#C           A#B#C           mock            16      37/2  letters       
  13多选题    PASS  a6d80edf0ac3  下列网络协议中，…   A#C             A#C             mock            15      37/4  letters       
  14判断题    PASS  1dc1e6d053db  HTTP 协议默…        正确            正确            mock            15      37/6  judge         
  15判断题    PASS  b673d74a829b  二进制数 101…       正确            正确            mock            15      37/5  judge         
  16判断题    PASS  f52fce5608c4  地球是太阳系中体…   错误            错误            mock            16      37/4  judge         
  17判断题    PASS  c530c78fd5d3  HTML 是一种…        错误            错误            mock            16      37/6  judge         
  18填空题    PASS  c2782fb7dbd4  在 Python…          def             def             mock            16      37/6  blanks        
  19填空题    PASS  0107d2066039  十进制数 25 …       11001           11001           mock            16      37/5  blanks        
  20问答题    PASS  b620756b81e2  OSI 参考模型…       物理层、数据…   物理层、数据…   mock            16      37/5  exact         

---- 汇总 ----
总题数 20 | 通过 20 | 失败 0 | 总准确率 100%
分题型准确率：单选题 8/8 (100%) | 多选题 5/5 (100%) | 判断题 4/4 (100%) | 填空题 2/2 (100%) | 问答题 1/1 (100%)
耗时 avg=15.9ms p50=15.6ms p95=18.8ms max=18.9ms | tokens in/out=740/83（合计 823）
失败原因分布：（无失败）
provider 命中：mock 20/20

[达标判定 HANDOFF §12.7] 总准确率 100% >= 85% -> PASS
```

判定：报表逻辑全链路可用——20/20 PASS、分题型统计、tokens 计量（in/out=740/83，合计 823）、
§12.7 判定行格式正确。mock 的 100% 只证明**报表与判题管线**正确，**不代表真实 AI 准确率**。

**第二步：真实评测首跑 —— BLOCKED(env)（当时未配 Key，退出码 2，不计 FAIL；历史记录，复跑见第三步）**

```powershell
node tools/accuracy.js --file test/fixtures/accuracy_set.json --out docs/accuracy-report.json --concurrency 3
```

原始输出（exit 2）：

```text
[qbank][config][no_key_bailian] provider "bailian" 需要环境变量 DASHSCOPE_API_KEY，当前未设置，已从 fallback 链剔除。设置方式：复制 .env.example 为 .env 并填入，或先执行 $env:DASHSCOPE_API_KEY="你的Key" 再启动。
[qbank][accuracy][ai_disabled] 没有可用的 AI provider（已探活但连不上：ollama），评测无法执行。
退出码 2（不计为 FAIL）。请任选一种方式配置后重试：
  1) 阿里云百炼（主力）：复制 .env.example 为 .env，填入 DASHSCOPE_API_KEY=sk-xxxxxxxx
     申请入口：https://bailian.console.aliyun.com/ -> 右上角「API-KEY」管理
     PowerShell 临时设置：$env:DASHSCOPE_API_KEY="sk-xxxxxxxx"
     bash/zsh 临时设置：  export DASHSCOPE_API_KEY=sk-xxxxxxxx
  2) Ollama 本地模型（免 Key、免审核）：先 ollama serve，再 ollama pull qwen2.5:7b
     确认 http://127.0.0.1:11434/api/tags 能打开（本工具会先探活，连不上就报本提示）
     然后：node tools/accuracy.js --file <测试集> --provider ollama
  3) 只想验证报表逻辑：加 --mock 离线跑通（不联网、不消耗额度）
```

- 环境无 `DASHSCOPE_API_KEY`，本机亦无 Ollama（探活 11434 失败）→ 按 P1-11 裁决退出码 **2 = 环境未就绪**；
- 首跑未生成 `docs/accuracy-report.json`（--out 显式传入才落盘，P2/T5#2；无数据不写文件）；
- 判据 >= 85% 保持不动；测试集分母已人工逐题复核（P0-6，见 §8），20 题 answer 全部正确。
- **本步为历史记录**：用户 2026-11-19 提供 Key 后已复跑通过（第三步），§12.7 最终判定 **PASS**。

**第三步：复跑 —— 用户提供 Key（2026-11-19）—— PASS（真实 100%，20/20）**

用户在对话中提供 `DASHSCOPE_API_KEY`。Key 仅注入本次评测子进程的环境变量，未写入仓库任何文件、
未持久化到 .env；临时运行脚本跑完即删，全仓库扫描 Key 原文与其特征前缀均 0 命中（§9/§12）。

```powershell
$env:DASHSCOPE_API_KEY="<用户提供，仅环境变量>"
node tools/accuracy.js --file test/fixtures/accuracy_set.json --out docs/accuracy-report.json --concurrency 3
```

原始输出（exit 0）：

```text
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":415,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":417,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":479,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":227,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":220,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":287,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":234,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":296,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":306,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":245,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":350,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":351,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":226,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":300,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":320,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":214,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":226,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":226,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":287,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":392,"via":"strict","model":"qwen-flash"}
[qbank][accuracy] 测试集=test/fixtures/accuracy_set.json 模式=live 题目=20（非法 0）
[qbank][accuracy] provider 链=bailian -> ollama 并发=3 单题超时=20000ms 判定阈值=85%

   #题型      结果  key(12)       题干(前8字)         期望            实际            provider        ms tokens     备注          
----------------------------------------------------------------------------------------------------------------------------------
  01单选题    PASS  0b82c6949060  在计算机中，1 …     A               A               bailian        480     273/1  letters       
  02单选题    PASS  3c6293ebae46  下列 HTML …         B               B               bailian        416     257/1  letters       
  03单选题    PASS  d81159bab015  函数 f(x) …         C               C               bailian        418     268/1  letters       
  04单选题    PASS  385cc0c8047a  光在真空中的传播…   D               D               bailian        227     285/1  letters       
  05单选题    PASS  83e99199d9dd  下列物质中，属于…   A               A               bailian        287     262/1  letters       
  06单选题    PASS  3e223be9a18c  按质量计算，人体…   C               C               bailian        219     259/1  letters       
  07单选题    PASS  2c79fd48f403  中国古典小说《红…   B               B               bailian        306     266/1  letters       
  08单选题    PASS  f6db22b2b20a  OSI 参考模型…       D               D               bailian        296     266/1  letters       
  09多选题    PASS  36a4291c940c  下列设备中，属于…   A#C#D           A#C#D           bailian        234     260/5  letters       
  10多选题    PASS  1f77f2a9c3b2  下列能源中，属于…   A#B#D           A#B#D           bailian        350     260/5  letters       
  11多选题    PASS  69bad884b1b0  下列数据结构中，…   B#C#D           B#C#D           bailian        245     265/5  letters       
  12多选题    PASS  21774fbf7acf  下列成果中，属于…   A#B#C           A#B#C           bailian        351     264/5  letters       
  13多选题    PASS  a6d80edf0ac3  下列网络协议中，…   A#C             A#C             bailian        226     258/3  letters       
  14判断题    PASS  1dc1e6d053db  HTTP 协议默…        正确            正确            bailian        300     252/1  judge         
  15判断题    PASS  b673d74a829b  二进制数 101…       正确            正确            bailian        320     262/1  judge         
  16判断题    PASS  f52fce5608c4  地球是太阳系中体…   错误            错误            bailian        214     248/1  judge         
  17判断题    PASS  c530c78fd5d3  HTML 是一种…        错误            错误            bailian        226     246/1  judge         
  18填空题    PASS  c2782fb7dbd4  在 Python…          def             def             bailian        226     245/1  blanks        
  19填空题    PASS  0107d2066039  十进制数 25 …       11001           11001           bailian        287     250/5  blanks        
  20问答题    PASS  b620756b81e2  OSI 参考模型…       物理层、数据…   物理层#数据链…  bailian        392    244/10  fuzzy         

---- 汇总 ----
总题数 20 | 通过 20 | 失败 0 | 总准确率 100%
分题型准确率：单选题 8/8 (100%) | 多选题 5/5 (100%) | 判断题 4/4 (100%) | 填空题 2/2 (100%) | 问答题 1/1 (100%)
耗时 avg=301ms p50=291.8ms p95=420.6ms max=479.8ms | tokens in/out=5190/51（合计 5241）
失败原因分布：（无失败）
provider 命中：bailian 20/20

[达标判定 HANDOFF §12.7] 总准确率 100% >= 85% -> PASS
[qbank][accuracy] 机器可读报表已写入：D:\codex and chat gpt\ocs刷题助手题库搭建\docs\accuracy-report.json
```

判定：**20/20 PASS，总准确率 100% >= 85% → PASS**。
- provider：bailian（qwen-flash）20/20，ollama 未启用；tokens in/out=5190/51（合计 5241），花费几分钱以内；
- 耗时 avg=301ms p95=420.6ms max=479.8ms（单题超时 20000ms，无超时、无审核拦截）；
- Q20 问答题：模型返回 `物理层#数据链路层#网络层`（分隔符与期望「物理层、数据链路层、网络层」不同），
  经 `fuzzy` 方法判 PASS —— 这是 T5 设计的多方法判分管线（letters/judge/blanks/exact/fuzzy）正常生效，非判据放宽；
- 机器可读报表写入 `docs/accuracy-report.json`（verdict PASS；隐私字段仅 key12/titlePrefix，无完整题干、无 Key）。

**第四步：reason 字段瑕疵修复 + 确认复跑（2026-11-19）—— PASS（真实 100%，20/20）**

首跑报表发现一处纯展示瑕疵：`pass:true` 行的 JSON `reason` 字段残留 `emptyRow` 默认值 `ai_error`
（tools/accuracy.js worker 判分后只在失败时覆写 reason；文本表、summary.reasons、verdict 均正确，不影响判定）。
修复：判分后 `row.reason = row.pass ? '' : REPORT_REASONS.WRONG_ANSWER`（变更表 #19），
并在 test/stubs/t5-selfcheck.js 的 mock 全对用例中新增回归断言「pass 行 reason 必须为空」（变更表 #20）。
修复后全量测试 285/0（glob）与 292/0（自动发现）复跑通过，再以同一 Key 复跑真实评测确认：

```text
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":480,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":508,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":534,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":228,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":242,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":326,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":207,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":285,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":256,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":319,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":315,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":355,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":215,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":284,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":238,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":303,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":282,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":239,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":280,"via":"strict","model":"qwen-flash"}
[qbank][accuracy][info] scope=bailian {"ok":true,"ms":352,"via":"strict","model":"qwen-flash"}
[qbank][accuracy] 测试集=test/fixtures/accuracy_set.json 模式=live 题目=20（非法 0）
[qbank][accuracy] provider 链=bailian -> ollama 并发=3 单题超时=20000ms 判定阈值=85%

   #题型      结果  key(12)       题干(前8字)         期望            实际            provider        ms tokens     备注          
----------------------------------------------------------------------------------------------------------------------------------
  01单选题    PASS  0b82c6949060  在计算机中，1 …     A               A               bailian        509     273/1  letters       
  02单选题    PASS  3c6293ebae46  下列 HTML …         B               B               bailian        534     257/1  letters       
  03单选题    PASS  d81159bab015  函数 f(x) …         C               C               bailian        481     268/1  letters       
  04单选题    PASS  385cc0c8047a  光在真空中的传播…   D               D               bailian        229     285/1  letters       
  05单选题    PASS  83e99199d9dd  下列物质中，属于…   A               A               bailian        327     262/1  letters       
  06单选题    PASS  3e223be9a18c  按质量计算，人体…   C               C               bailian        242     259/1  letters       
  07单选题    PASS  2c79fd48f403  中国古典小说《红…   B               B               bailian        285     266/1  letters       
  08单选题    PASS  f6db22b2b20a  OSI 参考模型…       D               D               bailian        207     266/1  letters       
  09多选题    PASS  36a4291c940c  下列设备中，属于…   A#C#D           A#C#D           bailian        256     260/5  letters       
  10多选题    PASS  1f77f2a9c3b2  下列能源中，属于…   A#B#D           A#B#D           bailian        319     260/5  letters       
  11多选题    PASS  69bad884b1b0  下列数据结构中，…   B#C#D           B#C#D           bailian        315     265/5  letters       
  12多选题    PASS  21774fbf7acf  下列成果中，属于…   A#B#C           A#B#C           bailian        355     264/5  letters       
  13多选题    PASS  a6d80edf0ac3  下列网络协议中，…   A#C             A#C             bailian        215     258/3  letters       
  14判断题    PASS  1dc1e6d053db  HTTP 协议默…        正确            正确            bailian        284     252/1  judge         
  15判断题    PASS  b673d74a829b  二进制数 101…       正确            正确            bailian        238     262/1  judge         
  16判断题    PASS  f52fce5608c4  地球是太阳系中体…   错误            错误            bailian        303     248/1  judge         
  17判断题    PASS  c530c78fd5d3  HTML 是一种…        错误            错误            bailian        282     246/1  judge         
  18填空题    PASS  c2782fb7dbd4  在 Python…          def             def             bailian        239     245/1  blanks        
  19填空题    PASS  0107d2066039  十进制数 25 …       11001           11001           bailian        281     250/5  blanks        
  20问答题    PASS  b620756b81e2  OSI 参考模型…       物理层、数据…   物理层#数据链…  bailian        353    244/10  fuzzy         

---- 汇总 ----
总题数 20 | 通过 20 | 失败 0 | 总准确率 100%
分题型准确率：单选题 8/8 (100%) | 多选题 5/5 (100%) | 判断题 4/4 (100%) | 填空题 2/2 (100%) | 问答题 1/1 (100%)
耗时 avg=312.5ms p50=284.6ms p95=509.8ms max=533.7ms | tokens in/out=5190/51（合计 5241）
失败原因分布：（无失败）
provider 命中：bailian 20/20

[达标判定 HANDOFF §12.7] 总准确率 100% >= 85% -> PASS
[qbank][accuracy] 机器可读报表已写入：D:\codex and chat gpt\ocs刷题助手题库搭建\docs\accuracy-report.json
```

判定：**20/20 PASS，100% >= 85% → PASS**（与首跑一致，两次独立评测互为稳定性佐证）。
- tokens in/out=5190/51（合计 5241）；耗时 avg=312.5ms p95=509.8ms max=533.7ms；Q20 仍经 `fuzzy` 判 PASS；
- 最终交付物 `docs/accuracy-report.json` 由本次（修复后）评测生成：pass 行 reason 已全部为空，
  verdict `{pass:true, status:"PASS", valuePct:100, total:20}`，summary.reasons={}，aiStats 20/20 成功；
- 首跑报表 JSON 已被本次覆盖，其完整原始输出存档于上方第三步，两次判定结论一致。

### 2.8 §12.8 README 覆盖度（安装/配置/OCS 对接/数据导入/故障排查）—— PASS（修复后复测）

逐节实测结果（五节全部「照着做能跑通」，跑不通的地方已直接修 README）：

| README 节 | 主题 | 实测方式 | 结果 |
|---|---|---|---|
| §2 安装/快速开始 | 安装 | 零依赖直接 `node server.js`；**发现 §2.4 顺序错误并修复**（见下方 A/B 实测） | PASS |
| §3 配置 | 配置 | 全部演示用环境变量覆盖（QBANK_BAILIAN_BASE_URL / TIMEOUT_MS / AI_FALLBACK / AI_ENABLED / MOCK_AI），.env.example 与 §3 表逐项核对 | PASS |
| §4 OCS 对接 | OCS 对接 | §4.3 步骤 1/6/8 措辞修正（health 形状、空链语义、requireVerified 层级）；粘贴版 JSON 见 §2.2 | PASS（浏览器侧原 BLOCKED(user)，2026-11-22 实测改判 PASS，见 §2.2） |
| §5 数据导入 | 数据导入 | `node tools/import.js --file <csv> --format csv --merge` 实测；题型说明修正（不定项→多选等） | PASS |
| §7 故障排查 | 故障排查 | §7.1 no_match/ai_disabled/bad_request 三行修正；§7.6 表单编码行、ai.chain 修正、**新增「运行中导入不热生效需重启」行** | PASS |

**关键缺陷：README §2.4 原顺序「先起服务、后导入」照做跑不通。**
根因：server 启动时一次性装载 bank.json，运行中导入**不会热生效**。A/B 对照实测：

A) 按 README 原顺序（先起服务后导入）——查询落空走 AI，本地库为空：

```text
=== A) README 原顺序：先起服务，后导入 ===
--- 1) health ---
{"code":1,"status":"ok","uptime":1507,"version":"1.0.0","bank":0,"ai":{"enabled":true,"chain":["ollama"]}}

--- 2) import ---
[qbank][config][no_key_bailian] provider "bailian" 需要环境变量 DASHSCOPE_API_KEY，当前未设置，已从 fallback 链剔除。设置方式：复制 .env.example 为 .env 并填入，或先执行 $env:DASHSCOPE_API_KEY="你的Key" 再启动。
[qbank][import][bank_missing] scope=store
{"parsed":1,"imported":1,"skipped":0,"duplicates":0,"failed":0,"elapsed":14}
import exit=0
--- 3) query ---
{"code":0,"question":"","answer":"","reason":"ai_error","elapsed":15}

--- 4) stats(match/ai) ---
match={"l1":0,"l2":0,"l2Suspicious":0,"noMatch":1,"imageOrFormula":0} ai.calls=1 bank.total=0
```

B) 修正顺序（先导入后起服务）——L1 命中、零 AI 调用：

```text
=== B) 修正顺序：先导入，后起服务 ===
--- 1) import ---
[qbank][config][no_key_bailian] provider "bailian" 需要环境变量 DASHSCOPE_API_KEY，当前未设置，已从 fallback 链剔除。设置方式：复制 .env.example 为 .env 并填入，或先执行 $env:DASHSCOPE_API_KEY="你的Key" 再启动。
[qbank][import][bank_missing] scope=store
{"parsed":1,"imported":1,"skipped":0,"duplicates":0,"failed":0,"elapsed":14}
import exit=0
--- 2) health ---
{"code":1,"status":"ok","uptime":1483,"version":"1.0.0","bank":1,"ai":{"enabled":true,"chain":["ollama"]}}

--- 3) query ---
{"code":1,"question":"示例题干：甲等于多少","answer":"B","source":"local","elapsed":2}

--- 4) stats(match/ai) ---
match={"l1":1,"l2":0,"l2Suspicious":0,"noMatch":0,"imageOrFormula":0} ai.calls=0 bank.total=1
8080 released: True
```

修复动作：README §2.4 改为**先导入后启动**（§4.2 的步骤引用同步 3→4），§7.6 新增
「运行中导入不热生效，需重启服务」故障行。复测即上面 B 段：`code:1, source:"local"`、match.l1=1、ai.calls=0、bank.total=1。
（「导入热加载」列为遗留增强项，见 §11，不改变当前验收结论。）

**README 其余修正清单**（全部记入变更表）：
1. §1 管线原因列表删去 no_match（no_match 仅用于 404，P0-3）；
2. §2.3 示例链 `ai=bailian->ollama` 与默认配置一致化；
3. §4.3 步骤 1 health 响应形状补 `ai:{enabled,chain}`（P0-8）；步骤 6 空链→ai_error（不是 ai_disabled）；
   步骤 8 requireVerified 是 bank 层过滤、cache 不受约束（DECISIONS #6）；
4. §5.2 题型说明：不定项→多选、多字母答案推断、单字母多选合法（P0-2）；
5. §7.1 三行错误码语义修正（no_match 仅 404；空链≠ai_disabled；非 JSON/表单 body→bad_request）；
6. §7.6 表单编码说明（P2/T3#8）+ ai.chain 字段修正 + 新增「导入需重启」行；
7. §6.3 增补 T6 复核说明；§9.2 验收状态更新为本报告结论（含 bench 复测数字）；
8. 测试命令修正：`npm test`/`node --test test/` → `node --test`（292）与 glob（285）两种写法 + Node 24 目录参数警告（§3.3）。

---

## 3. 全量测试与集成

### 3.1 测试统计（基线 267 → 285 / 292，只增不减）

```powershell
node --test test/*.test.js test/stubs/t5-*.js   # 与 T1~T5 基线同口径
node --test                                   # 自动发现（含全部 stub 自检）
```

glob 口径结尾统计（原始输出）：

```text
✔ renderNoProviderHint / USAGE：退出码语义与占位 Key 纪律 (0.2087ms)
ℹ tests 285
ℹ suites 22
ℹ pass 285
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1439.7452
```

自动发现口径结尾统计（原始输出）：

```text
✔ renderNoProviderHint / USAGE：退出码语义与占位 Key 纪律 (0.2155ms)
ℹ tests 292
ℹ suites 22
ℹ pass 292
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1518.5773
```

- 292 - 285 = 7：自动发现额外执行 7 个 stub 文件的自检用例
  （t2-fakeLog / t2-fakeProvider / t3-ai / t3-env / t3-gate / t3-matcher / t4-store，各 1 条）。
- 285 - 267 = 18：**test/e2e.test.js 新增 11 条** + 既有文件新增 7 条断言用例
  （P0-2 题型推断/单字母多选、P0-5 前缀剥离、P0-7 单层闸、P0-8 health 形状、P1-6 queueFull 单一来源等）。
  未删除、未跳过任何既有用例，未放宽任何断言。
- 新增 e2e 11 条（全部 listen(0) + os.tmpdir()，真实 Matcher/Gate/AI 全链路，仅 baseUrl 指向本地假 provider）：

```text
✔ e2e: L1 命中 local / L2 命中 fuzzy / suspicious 被丢弃走 AI / 图片公式短路 (118.7076ms)
✔ e2e: AI 成功 → 回写 bank.json(source:ai) → 二次请求走 L1 且 ai.calls 不增长 (39.1145ms)
✔ e2e: AI 全链失败(401) → code:0 ai_error，进程存活且后续请求正常 (15.0901ms)
✔ e2e: DataInspectionFailed → ai_moderation 降级；moderation.log 只含 key/码/provider，不含题目原文 (20.9376ms)
✔ e2e: 20 并发 → 全部 200 JSON；gate.stats().peak<=3；超出 queue_full；/stats.ai.queueFull 取 gate.rejected (305.0528ms)
✔ e2e: gate 超时(QBANK_TIMEOUT_MS=500, provider 挂 1500ms) → ai_timeout，进程存活 (519.8227ms)
✔ e2e: /admin/verify 标记落盘；未知 key 与非法 body → bad_request (29.3321ms)
✔ e2e: 顶层异常 → 200 + ai_error（绝不 500）；bad_request 分支；进程存活 (13.2378ms)
✔ e2e: 优雅退出 close() → bank/cache/bak 均可再载入、端口释放、重复 close 幂等 (26.8687ms)
✔ e2e: requireVerified=true → bank 层过滤未验证记录；cache 层不受约束；核验后走 L1 (22.6435ms)
✔ e2e: /health ai={enabled,chain}；QBANK_AI_ENABLED=0 → enabled:false + ai_disabled (20.3804ms)
```

> e2e 与任务书的一处口径偏差：任务书示例写「suspicious 被丢弃(code:0, no_match)」，
> 但按 P0-3 裁决 no_match 仅用于 404；acceptSuspicious=false 时 suspicious 命中被丢弃后
> **继续走 AI 管线**（AI 可用→code:1；空链→ai_error；AI_ENABLED=0→ai_disabled）。
> e2e 按裁决后的语义断言，已在「偏差表」登记。

### 3.2 时序 flake —— 根因修复（不是复跑掩盖）

集成期 glob 口径偶发失败：`test/ai.test.js:225` 断言 `srv.requestCount === 1` 实际为 0
（401 用例里假 provider 一个请求都没收到，但 ai.answer 已返回 ai_error）。

**根因**：OS 给 `listen(0)` 随机分配的端口若命中 **fetch 规范的 bad port 表**
（6000/6666/6667/6668/6669/5060/5061/6566/6697/10080 等，Windows 临时端口范围 49152~65535 内约 11 个），
undici fetch 直接抛 `TypeError: fetch failed (cause: bad port)`，请求根本到不了假 provider。
全量测试每轮起上百个随机端口服务，命中概率约百分之几 → 偶发假失败。机制验证（原始输出）：

```text
fetch error: TypeError "fetch failed" | cause: bad port
fetch error: TypeError "fetch failed" | cause: bad port
fetch ok 200
```

（6666/6000 为 bad port，49200 正常端口对照 200。）

**修复**（不放宽任何断言）：
- `server.js listen()`：port===0 模式下命中 bad port 自动 close 重绑（<=32 次）；生产固定 8080 不受影响；
- `test/stubs/t2-fakeProvider.js listen()`：同样重绑守卫，并导出 `FETCH_BAD_PORTS` 清单；
- `test/e2e.test.js`：boot 增加回归断言「随机端口不得命中 fetch bad port」。

**复测**：修复后 glob 连跑 3 轮、自动发现连跑 2 轮，全部 0 fail（285/285/285/292/292），
无需动用任务书的 `--test-concurrency=1` 兜底。上方 §3.1 统计即修复后最终代码的输出。

### 3.3 `node --test test/`（目录参数）在 Node 24 失效 —— 文档/脚本修正

TASKS.md T6 DoD 与旧 README 写的 `node --test test/` 在 Node v24.21.0 实测报 MODULE_NOT_FOUND
（目录被当模块加载）。原始输出：

```text
node:internal/modules/cjs/loader:1568
  throw err;
  ^

Error: Cannot find module 'D:\codex and chat gpt\ocs刷题助手题库搭建\test'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)
    at wrapResolveFilename (node:internal/modules/cjs/loader:1118:27)
    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1142:10)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1169:12)
    at Module._load (node:internal/modules/cjs/loader:1341:5)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)
    at node:internal/main/run_main_module:33:47 {
  code: 'MODULE_NOT_FOUND',
  requireStack: []
}

Node.js v24.21.0
✖ test (73.6619ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 81.3041

✖ failing tests:

test at test:1:1
✖ test (73.6619ms)
  'test failed'
```

处置：不改 TASKS.md（只读）；README/package.json/CONTRACT 的测试命令统一改为
`node --test`（292）或 glob（285），两者与 DoD「全绿」语义等价，等价性在此登记。
`package.json` 的 `"test": "node --test"` 修正后 `npm test` 亦可用（零依赖，不触发安装）。

---

## 4. 裁决记录（T1-T5-REPORTS §3 全部条目：P0×8 + P1×13 + P2×17）

裁决基线来自 docs/PROMPT_T6.md，T6 已逐条对照源码独立复核；全部采纳基线（无驳回），
其中两条按基线要求做了额外动作（P0-6 人工复核、P1-9 附带检查）。落地后契约文本 = docs/CONTRACT.md **v1.1**。

### 4.1 P0-1 ~ P0-8

| 编号 | 裁决 | 理由 | 落地动作 | 影响对外协议 / 全库 key |
|---|---|---|---|---|
| P0-1 splitOptions 保留字母标号 | **采纳** T1 lookahead 实现 | HANDOFF §8.3 示例带标号；makeKey 口径必须与示例一致 | T1 已实现，T6 仅修 CONTRACT §1.2 第 4 级措辞（删「丢弃首段空串」错误表述）；当前 bank 为空**无需重建**；**若已有生产数据则需重建索引并清缓存** | key 口径（潜在影响全库 key；当前库空，无实际影响） |
| P0-2 题型归属两处缺口 | **采纳** ①②③ 全改 | 不定项可能单答案；两窗口口径必须统一 | ① lib/normalize.js 推断链最前插「答案字母数>1→多选」（ctx.answer 由 import 传入；server 无答案保持原推断）+「不定项选择题→多选」+ toLabel 别名；② lib/answer.js MULTI_RE 放宽 `^[A-Z](#[A-Z])*$`（仍去重+升序）；③ tools/import.js 兜底改调 normalizeType；CONTRACT §1.4/§5 + README 题型表同步 | 影响新导入数据的 type/key；当前库空，无存量影响 |
| P0-3 bad_request 与 HTTP 状态码 | **采纳** T3 现状 | OCS handler 只读 body.code，4xx 反触发 fetch 异常分支 | 保持「除未知路径 404 外 /api 一律 200+JSON」；bad_request 写入 CONTRACT §8 + README §7.1；**HANDOFF §4.2 Patch 1 已批准写回（2026-11-19）** | 对外协议（reason 枚举+状态码策略，用户批准写回 HANDOFF） |
| P0-4 ai.answer() 入参 | **采纳** T3 现状 | prompt 需可读文本，归一化丢标点/大小写 | 传原文选项（splitOptions 后未归一化）+ 中文 label 题型；CONTRACT §5/§7 签名注释固化 | 否 |
| P0-5 前缀剥离正则 | **采纳** T2 正则 | 覆盖「答案/正确答案/参考答案/应选…」等前缀 | lib/answer.js PREFIX_RE  longest-first；补测试「正确答案是 A#C」「答案应为 B」；CONTRACT §5 更新 | 否 |
| P0-6 问答/填空判对口径 | **采纳** T5 口径 + **人工复核完成** | 判据是 §12.7 的分母，必须先验答案 | 多选 # 集合全等 / 判断归一 / 填空逐空 / 问答包含要点或 bigram Dice>=0.6（阈值写死且 README 公开）；20 题 answer 逐题复核**全部正确**（§8） | 否 |
| P0-7 gate 单层 | **采纳** 追认 | 双层闸会把并发压到 1 并重复计数 | gate 由 server 创建且只建一个，注入 createAI；lib/ai/index.js 删除内层闸；CONTRACT §6/§7/§8；e2e 断言 gate.stats().peak<=3（§2.4 实测峰值=3） | 否 |
| P0-8 /health 暴露 ai.enabled | **采纳** 附加字段 | 不删不改现有字段，OCS 不读 /health | /health 增加 `ai:{enabled,chain}`；README §4.3 + CONTRACT §8；e2e 覆盖形状与 AI_ENABLED=0；**HANDOFF Patch 2 已批准写回（2026-11-19）** | 对外协议（附加字段，无破坏，用户批准写回 HANDOFF） |

### 4.2 P1-1 ~ P1-13（全部追认进 CONTRACT v1.1）

| 编号 | 裁决 | 落地动作 | 影响对外协议 / 全库 key |
|---|---|---|---|
| P1-1 cache.json 格式 | 追认 | CONTRACT §4 写入 `{version:1,updatedAt,entries:{key:{answer,source,type,model?,createdAt}}}` | 否（磁盘格式） |
| P1-2 genbank 固定 updatedAt | 追认（豁免） | CONTRACT §0 加豁免行：**仅合成 bench 数据**豁免 Date.now() 约定；import.js 写库仍用 Date.now() | 否 |
| P1-3 import stdout 超集 | 追认 | CONTRACT §9 写入 `{parsed,imported,skipped,duplicates,failed,elapsed}` | 否（CLI） |
| P1-4 skipped/failed 语义 | 追认 | CONTRACT §9：可解析但不合规范→skipped；解析失败→failed；均不改变退出码 0 | 否 |
| P1-5 bench L2 命中口径 | 追认 | CONTRACT §9 备注：以 nearDuplicates 为准，collisions 不算重复题 | 否 |
| P1-6 queueFull 重复计数 | 追认 + **动作** | 单一来源 = gate.stats().rejected；server.js /stats.ai.queueFull 直取之，ai.stats().queueFull 仅 fallback；e2e 补断言（§3.1 第 5 条） | 否（/stats 数值口径） |
| P1-7 Store.setVerified | 追认 | CONTRACT §3 补 `setVerified(key, boolean) -> boolean` | 否 |
| P1-8 gate.close() | 追认 | CONTRACT §6 补 close()（清 interval，node --test 不挂住） | 否 |
| P1-9 timeoutMs 起算点 | 追认 + **附带检查通过** | CONTRACT §6：从 task 开始执行起算（排队不计）；检查 /stats AI 耗时：byProvider.ms 的 t0 在 runChain 内、出队之后 → **未含排队时间** ✓ | 否 |
| P1-10 chat() 测试注入位 | 追认 | CONTRACT §7：opts 支持 fetchImpl/retryBaseMs/retryMax | 否 |
| P1-11 CLI 退出码 2 | 追认 | CONTRACT §0/§9：2 = 环境未就绪（不计 FAIL）；§2.7 实测 exit 2 | 否 |
| P1-12 分位数口径 | 追认 | CONTRACT §9：R type-7 | 否 |
| P1-13 lookup opts 覆盖 | 追认 | CONTRACT §2：`Matcher.lookup(title, options, opts)` opts 可覆盖 fuzzyThreshold/suspiciousThreshold/acceptSuspicious/candidateLimit | 否 |

### 4.3 P2 全部条目（保守实现确认）

| 编号 | 裁决 | 理由 / 落地动作 | 影响对外协议 / 全库 key |
|---|---|---|---|
| T1#2 optionCount===1→问答 | 认可，无需改动 | 与 HANDOFF 题型推断一致 | 否 |
| T1#4 toLabel 未知输入→问答题 | 认可，无需改动 | 已是标签形态则原样返回，幂等 | 否 |
| T1#5 normalize(null/undefined)→'' | 认可，无需改动 | 防 "null" 污染 key | 否（保 key 口径） |
| T1#7 候选<5 全表打分回退 | 认可，无需改动 | 严格照契约保留；聚簇数据已消解性能问题 | 否 |
| T1#8 tie-break 双 key 比较 | 认可，无需改动 | entry.key 与计算 mkey 两种情形都覆盖 | 否 |
| T2#1 toLabel 动态 import+回退 | 认可 + **动作** | lib/prompt.js 固化为强制静态 import，删除 FALLBACK_LABELS 死代码（回退会掩盖接线错误） | 否 |
| T2#3 三反引号块级/行内区分 | 认可，无需改动 | 块级（行首```+可选语言+换行/行尾```）与行内包裹分别处理 | 否 |
| T2#6 空链 calls/failed 各+1 | 认可，无需改动 | 空链计一次失败 + stderr 中文提示一次；语义合理（请求确实失败了） | 否 |
| T3#4 ai.answer 入参 | 见 P0-4 | 同 P0-4 | 否 |
| T3#8 仅 JSON body | 认可 + 文档动作 | 表单编码→bad_request；README §7.6 加说明；**若用户实测 OCS 发表单编码需回来加分支**（遗留 §11） | 对外行为已定（bad_request），无协议变更 |
| T3#9 /admin/verify 无鉴权 | 认可，无需改动 | 仅绑 127.0.0.1；未知 key→bad_request（非 404）；公网部署必须加 token（HANDOFF §14.5 已提示） | 否 |
| T3#10 LRU.flushing getter | 认可，追认 | 只读 getter 返回写链 Promise，仅测试 await 用；CONTRACT §4 | 否 |
| T3#11 动态 import+缺失回退 | **删除回退分支** | T1/T2 已落地，静默回退会让 e2e 假通过；server.js 改静态 import，删全部 *_module_missing 分支；重跑 test/http.test.js 全绿（未依赖回退分支，无需改桩） | 否（集成可靠性） |
| T4#4 TXT answerPending | 认可，无需改动 | 「答案：」后换行取下一非空行；取不到计 skipped；TXT 解析器已知局限一律 skipped 不影响退出码 | 否 |
| T5#2 accuracy --out 无默认值 | 认可，无需改动 | docs/ 是 T6 领地；显式传入才落盘（§2.7 实证：exit 2 时未生成报告） | 否 |
| T5#4 wrong_answer/invalid_item | 认可，无需改动 | 仅报表 reason 标签，不注入 Error.code（不是 §0 错误码） | 否 |
| T5#6 bench 装载兼容 | 认可，无需改动 | {records:[...]} 与裸数组都收（DECISIONS #13）；非法条目计 skipped 不抛 | 否 |

---

## 5. 变更表（全部跨任务改动，含依据与影响面）

> 所有权标注 = 文件原任务。T6 依据 PROMPT_T6 集成期权限修改；HANDOFF.md 零改动。

| # | 文件（所有权） | 改了什么 | 依据 | 影响面 |
|---|---|---|---|---|
| 1 | lib/normalize.js（T1） | 推断链最前插 rule0「答案字母数>1→多选」（ctx.answer 入参）；不定项选择题→多选；toLabel 别名补全 | P0-2① | 新导入 type/key 口径；server 侧无答案不受影响 |
| 2 | lib/answer.js（T2） | MULTI_RE 放宽单字母（仍去重+升序）；PREFIX_RE longest-first；导出 cleanRaw | P0-2② / P0-5 / P0-4 | AI 输出后处理 |
| 3 | lib/prompt.js（T2） | toLabel 改静态 import；删 FALLBACK_LABELS 死代码 | P2/T2#1 | 接线可靠性 |
| 4 | lib/ai/index.js（T2） | 删内层并发闸（单层闸）；新增 enabled getter | P0-7 / P0-8 | 并发口径、/health |
| 5 | lib/queue.js（T2） | stats 增加 peak（历史最大 inflight） | P0-7 | 可观测性 |
| 6 | tools/import.js（T4） | resolveShortType 兜底改调 normalizeType（传 ctx.answer） | P0-2③ | 导入口径统一 |
| 7 | server.js（T3） | matcher/gate/ai 静态 import，删全部缺失回退分支；/health 增 ai:{enabled,chain}；/stats.ai.queueFull=gate.stats().rejected；gate 单层包 AI | P2/T3#11 / P0-8 / P1-6 / P0-7 | /health 附加字段（Patch 2）、/stats 口径 |
| 8 | test/ai.test.js、test/answer.test.js、test/normalize.test.js、test/import.test.js、test/http.test.js（T2/T1/T4/T3） | 新增 7 条断言用例（单字母多选、前缀剥离、rule0 推断、单层闸、health 形状、queueFull 单一来源等） | P0-2/5/7/8 / P1-6 | 测试数 267→274（+7） |
| 9 | test/stubs/t5-readme-smoke.js（T5） | health 断言适配 ai.chain | P0-8 | README 冒烟 |
| 10 | test/e2e.test.js（**T6 新增**） | 11 条全链路 e2e（真实 Matcher/Gate/AI + 本地假 provider） | PROMPT_T6 第三步 | 测试数 →285（+11） |
| 11 | README.md（T5） | §2.8 所列 8 处修正（§2.4 顺序、题型表、错误码行、health 形状、测试命令、§9.2 状态等） | P0-2/3/8 / §12.8 | 文档可复现性 |
| 12 | docs/CONTRACT.md（共享） | 升 v1.1：P0/P1/P2 裁决全部追认进正文（§0/1/2/3/4/5/6/7/8/9/10） | 全部裁决 | 模块契约文本 |
| 13 | docs/DECISIONS.md（共享） | 追加「T6 集成裁决」节（P0 摘要表 + P1/P2 追认 + 所有权说明） | 全部裁决 | 裁决存档 |
| 14 | package.json（T0） | "test": "node --test test/" → "node --test" | §3.3 | npm test 可用 |
| 15 | server.js（T3） | listen(0) 命中 fetch bad port 自动重绑（仅随机端口模式） | §3.2 flake 根因 | 测试基础设施；生产 8080 不受影响 |
| 16 | test/stubs/t2-fakeProvider.js（T2） | listen 重绑守卫；导出 FETCH_BAD_PORTS | §3.2 | 测试基础设施 |
| 17 | test/e2e.test.js（T6） | boot 增 bad-port 回归断言 | §3.2 | 断言加固 |
| 18 | docs/ACCEPTANCE.md（**T6 新增**） | 本报告 | 任务书 | 交付物 |
| 19 | tools/accuracy.js（T5） | 判分后 pass 行清空 reason（修复 emptyRow 默认 ai_error 残留进 pass:true 行的展示瑕疵） | §2.7 第四步 | 报表 JSON 字段；verdict/summary 不变 |
| 20 | test/stubs/t5-selfcheck.js（T5） | mock 全对用例新增回归断言：pass 行 reason==='' | §2.7 第四步 | 自检加固 |
| 21 | HANDOFF.md（T0，**用户批准后写回**） | §4.2 reason 枚举 + bad_request / HTTP 200+JSON 策略 / no_match 仅 404；§4.1 /health 响应体定义（Patch 1/2，标注「2026-11-19 用户批准」） | 用户批准注解 / P0-3 / P0-8 | 对外契约文本，纯增补无破坏 |
| 22 | docs/accuracy-report.json（**T6 新增**） | §12.7 真实评测机器可读报表（修复后确认复跑生成，verdict PASS 20/20=100%） | §2.7 第三/四步 | 交付物；仅隐私安全字段 |
| 23 | README.md §9.2 / docs/CONTRACT.md / docs/DECISIONS.md | 验收状态与批准状态注记更新（第 7 项真实 PASS；两处增补已写回） | §2.7 / 用户批准注解 | 文档状态同步 |
| 24 | README.md §4.1/§4.3/§3.5/§9.2/§10 | D1 配置修正（method:get + contentType:json + schema 说明）；D2 清缓存排查步骤；D4 ollama 标注可选；§9.2 八项全 PASS；§10 增补图片占位 URL 局限 | §2.2 侧边栏实测（D1/D2/D4） | 文档可复现性 |
| 25 | docs/ACCEPTANCE.md §2.2 等 | §12.2 改判 PASS + /stats 快照 + 截图归档 + D1~D4 记录；总表/DoD/遗留同步 | 侧边栏交接（2026-11-22） | 验收报告 |
| 26 | docs/evidence/（**T6 新增**） | §12.2 浏览器实测截图 4 张（自 %TEMP% clipboard 归档） | §2.2 | 验收证据 |
| 27 | docs/DECISIONS.md | 追加「验收后新增发现 D1~D4」注记（D3 立 P1 单，Patch 3 当时待批，获批写回见第 29 行） | 侧边栏交接 | 裁决存档 |
| 28 | test/stubs/t5-readme-smoke.js | 环境隔离修正：子进程 env 显式剔除 DASHSCOPE_API_KEY / OPENAI_API_KEY（宿主机用户级环境变量持久设置了 Key，致「缺 Key」场景误报失败）；断言语义不变 | 2026-11-22 复跑发现误报 → 修复后 285/0、292/0 | 测试可复现性 |
| 29 | HANDOFF.md §4.4（**契约补丁 Patch 3**） | method:get + type:fetch + contentType:json（D1 修正版模板），标注「2026-11-22 用户批准」；ACCEPTANCE §7/头部/§2.2 与 DECISIONS D1 行状态同步 | 用户 2026-11-22 批准（主线程对话「批准」） | 契约修正 |
| 30 | lib/normalize.js + lib/prompt.js + server.js（**D3 修复 / Patch 4 实现**） | 新增 stripOptionJunk（markdown 图片 / <img> / 图片资源 URL / 常见占位文件名）；纳入 normalizeOptions/makeKey 管线、AI 输入与回写清洗；isUnanswerable 激活 options 参数，纯图片选项整题 image_or_formula 短路 | 用户 2026-11-22 批准 Patch 4 | 缺陷修复（fail-closed 扩展） |
| 31 | HANDOFF.md §5/§7.6 + docs/CONTRACT.md §1.3/§1.5/§5（**契约补丁 Patch 4 写回**） | 选项清洗口径与纯图片选项拦截写入契约，标注「2026-11-22 用户批准」；/api 签名、code/reason 枚举、OCS 配置均不变 | 用户 2026-11-22 批准（主线程对话「批准」） | 契约增补 |
| 32 | test/d3-option-junk.test.js（新增）+ test/e2e.test.js（追加） | 9 条单元用例（清洗模式/幂等/边界/纯图片判定）+ 1 条全链路用例（脏选项→干净 prompt→干净回写→脏/净/乱序重查全 L1 零 AI） | D3 回归防护 | 测试 |
| 33 | README §10 第 10 条 / docs/DECISIONS.md D3 行 / ACCEPTANCE 状态同步 | D3 由「P1 待修」改判「已修复」；§11 P1 单关闭；基线更新 glob 295/0、全量 302/0 | 文档一致性 | 文档 |
| 34 | lib/prompt.js（**D5 修复 / Patch 5 实现**） | optionsText 缺标号选项按原始位置补 A./B./…（已有标号保留、幂等、空项保留字母槽位、>26 防御）；先 stripOptionJunk 再补；仅作用 prompt，不动 key/存储/匹配，SYSTEM_PROMPT 不改 | 用户 2026-11-22 批准 Patch 5 | 缺陷修复 |
| 35 | HANDOFF.md §7.3 + docs/CONTRACT.md §5（**契约补丁 Patch 5 写回**） | 选项补标号口径写入契约，标注「2026-11-22 用户批准」；/api 签名、code/reason 枚举、OCS 配置、§7.4 校验链均不变 | 用户 2026-11-22 批准（主线程对话「批准」） | 契约增补 |
| 36 | test/patch5-option-letter.test.js（新增） | 12 条单元用例（纯文字数组/字符串补标号、已带标号幂等、多种分隔符、混合、空项槽位、判断、单选、叠加 Patch 4、空选项省略、SYSTEM_PROMPT 防回归、>26 防御） | D5 回归防护 | 测试 |
| 37 | README §10 第 11 条 / docs/DECISIONS.md D5 行 / ACCEPTANCE §7/§11/§13 状态同步 | D5 记录为已修复；基线更新 glob 307/0、全量 314/0；生产重启与真实页面验证见 §13 | 文档一致性 | 文档 |
| 38 | lib/normalize.js（**D6 修复 / Patch 6 实现**） | normalizeType 选项性质 override：恰好两选项且剥 A. 前缀后皆判断语义词（√/×/正确/错误/对/错/是/否/T/F/true/false，排除裸 A/B）→ 强制判断，优先于标签关键词；其余逻辑零改动 | 用户 2026-11-22 批准 Patch 6 | 缺陷修复 |
| 39 | HANDOFF.md §4.3 + docs/CONTRACT.md §1.4（**契约补丁 Patch 6 写回**） | 选项性质 override 口径与优先级写入契约，标注「2026-11-22 用户批准」；/api 签名、code/reason 枚举、OCS 配置、答案格式表、§7.4 校验链均不变 | 用户 2026-11-22 批准（主线程对话「批准」） | 契约增补 |
| 40 | test/patch6-judge-override.test.js（新增）+ data/bank.json 存量修复 | 16 条单元用例（override 命中/词集/前缀/串形态/标签优先级/裸 A/B 排除/双条件/单选项/判断校验联动/单选校验不变/SYSTEM_PROMPT 防回归/管线联动）；存量 2 条 √/× 记录 单选题 A/B → 判断题 正确/错误（停服修改后重启） | D6 回归防护 + 数据修复 | 测试/数据 |
| 41 | README §10 第 12 条 / docs/DECISIONS.md D6 行 / ACCEPTANCE §7/§11/§13 状态同步 | D6 记录为已修复；基线更新 glob 323/0、全量 330/0；生产重启与真实页面验证见 §13 | 文档一致性 | 文档 |
| 42 | lib/normalize.js + server.js + lib/prompt.js（**D7 修复 / Patch 7 实现**） | stripOptionJunk 镜像作用于题干：makeKey/isUnanswerable 内部预清洗；server match/AI/回写/响应 question 用清洗后题干；buildMessages 题干清洗；纯图片题干仍 fail-closed，SYSTEM_PROMPT 一字不改 | 用户 2026-11-22 批准 Patch 7 | 缺陷修复 |
| 43 | HANDOFF.md §5/§7.6 + docs/CONTRACT.md §1.3/§1.5/§5（**契约补丁 Patch 7 写回**） | 题干清洗口径写入契约，标注「2026-11-22 用户批准」；/api 签名、code/reason 枚举、OCS 配置、§7.4 校验链均不变 | 用户 2026-11-22 批准（主线程对话「批准」） | 契约增补 |
| 44 | test/patch7-title-junk.test.js（新增）+ normalize/d3/e2e/http 旧断言按新契约同步 | 14 条单元用例（四形态杂质/纯图片 fail-closed/混合送 AI/LaTeX 不变/Patch 4 不回归/key 零迁移/双杂质/防御/prompt 清洗/SYSTEM_PROMPT 防回归）；旧断言改混合题干不短路、纯图片题干 fixture 保留短路原意 | D7 回归防护 | 测试 |
| 45 | README §10 第 13 条 / docs/DECISIONS.md D7 行 / ACCEPTANCE §7/§11/§13 状态同步 | D7 记录为已修复；基线更新 glob 338/0、全量 345/0；生产重启与真实页面验证见 §13 | 文档一致性 | 文档 |
| 46 | lib/ai/presets.js（新增）+ openai.js / bailian.js / ollama.js / index.js（T2） | Patch 8 provider 中立化：PRESETS 11 家 + MODERATION_SIGNATURES 7 家 + resolveInstance；openai 通用体（协议开关 + 实例级签名 + 200 content_filter + providerName）；bailian 改薄壳；ollama 支持 providerName；REGISTRY={openai,ollama} | 用户 2026-11-23 批准 Patch 8（prompt §2） | AI 层；对外契约不变 |
| 47 | config.js（T0 所有权，**越权必要性**：loadConfig 原重建 providers 只留三内置键，会丢自定义实例名） | 保留任意实例名 provider 条目（三内置名仍合并 DEFAULTS）；pruneFallback 先 resolveInstance 再按生效配置检查（preset 感知剔除；缺 Key 警告含环境变量名） | Patch 8 实例层要求自定义实例名经 loadConfig 存活 | 配置加载；旧配置行为逐字不变 |
| 48 | test/patch8-provider-neutral.test.js（新增） | 23 条 stub 用例（preset/impl 解析与旧配置兼容/请求形状/协议开关/各家审核签名与切链/429 退避/超时/空 content/未知 impl/preset 防御/多实例链顺序与 stats 命名） | Patch 8 回归防护 | 测试数 glob 338→361、全量 345→368 |
| 49 | HANDOFF §7.1/§7.2/§7.5/§9/§10 + CONTRACT §7 + DECISIONS #1/#15 + README §3/§10 第 14 条 + ACCEPTANCE §7/§13（**用户批准后写回**） | Patch 8 契约文本写回，标注「2026-11-23 用户批准」；§4 对外契约逐字未动；基线更新 glob 361/0、全量 368/0 | 用户 2026-11-23 批准（任务 prompt §2） | 契约增补/文档 |

---

## 6. 偏差表（静态一致性检查：跨模块 import 实际签名 vs CONTRACT）

检查方式：逐一列出 server.js / tools/*.js / test/*.js 对 lib/* 与 config.js 的 import 及调用点，
与（裁决后的）CONTRACT v1.1 对照。**结论：全部契约签名在实现中存在且一致，无缺失、无签名漂移。**

| 类别 | 条目 | 处置 |
|---|---|---|
| 契约签名核对 | normalize/splitOptions/normalizeOptions/normalizeType/makeKey/isUnanswerable/toLabel（§1）；Matcher.lookup(title,options,opts)（§2）；Store.get/match/setVerified/persist/flushing（§3）；LRU.get/set/flush/flushing（§4）；answer.cleanRaw/validate（§5）；createGate.run/stats/close/peak（§6）；createAI.answer/stats/enabled、chat(opts)（§7）；createServer(overrides).listen/close（§8） | 全部一致 ✓ |
| 实现多出的导出（原契约未写） | answer.cleanRaw；config.DEFAULTS / apiKeyFor；gate.close/peak/concurrency/queueLimit；Store.setVerified/flushing；LRU.flushing；Matcher._candidates（内部） | 全部追认进 CONTRACT v1.1 对应小节（P1-7/8/10/13、P0-4/7、T3#10） |
| 契约文本偏差 | CONTRACT §1.2 第 4 级「丢弃首段空串」错误表述 | 已修（P0-1，lookahead 实现不动） |
| 文档偏差 | README §2.4 先起服务后导入（照做跑不通） | 已修 + A/B 复测（§2.8） |
| 命令偏差 | TASKS.md/旧 README `node --test test/` 在 Node 24 失效 | README/package.json/CONTRACT 已修；TASKS.md 只读，等价性登记于 §3.3 |
| e2e 规格偏差 | 任务书示例「suspicious→code:0,no_match」与裁决后语义不符 | 按 P0-3 语义断言：suspicious 丢弃→走 AI（code:1 / ai_error / ai_disabled）；no_match 仅 404 |
| 实现偏差 | 无 | 未发现需要「以契约为准修实现」的签名级偏差 |

---

## 7. 契约增补（HANDOFF.md 补丁 —— Patch 1/2/3/4/5/6/7/8 均已批准写回）

> 依据 PROMPT.md「禁止未经确认就改 HANDOFF.md 里定义的接口契约」。Patch 1/2 为实现已落地、
> 对外无破坏的增补，**用户 2026-11-19 以注解「批准」确认，已写回 HANDOFF.md §4.1/§4.2**
> （两处均标注「2026-11-19 用户批准」）；Patch 3 为文档笔误修正，**用户 2026-11-22 批准，已写回 HANDOFF.md §4.4**
> （标注「2026-11-22 用户批准」）。Patch 4 为 D3 选项清洗契约增补，**用户 2026-11-22 批准（主线程「批准」），已写回 HANDOFF.md §5/§7.6**（标注「2026-11-22 用户批准」）；提案文本保留存档。Patch 5 为 D5 选项补标号契约增补，**用户 2026-11-22 批准（主线程「批准」），已写回 HANDOFF.md §7.3**（标注「2026-11-22 用户批准」）；提案文本保留存档。注：HANDOFF §4.3 是「答案格式」，
> /health 的响应体定义落在 §4.1/§4.2。Patch 6 为 D6 判断 override 契约增补，**用户 2026-11-22 批准，已写回 HANDOFF.md §4.3 / CONTRACT §1.4**；
> Patch 7 为 D7 题干清洗契约增补，**用户 2026-11-22 批准（主线程「批准」），已写回 HANDOFF.md §5/§7.6 / CONTRACT §1.3/§1.5/§5**（标注「2026-11-22 用户批准」）；提案文本保留存档。
> Patch 8 为 AI 层 provider 中立化契约增补，**用户 2026-11-23 批准（任务 prompt §2 已批准决策清单），已写回 HANDOFF §7.1/§7.2/§7.5/§9/§10 / CONTRACT §7 / DECISIONS #1 修订+#15 / README §3**（标注「2026-11-23 用户批准」）；提案文本保留存档。对外 §4 契约（请求/响应/答案格式/OCS 配置模板）逐字未动，OCS 端零感知。

### Patch 1（HANDOFF §4.2）：reason 枚举 + HTTP 状态策略

建议增补文本：

> reason 枚举增加 `bad_request`：仅用于**请求本身非法**（缺 q、POST body 超过 1MB、
> body 不是 JSON 对象、/admin/verify 参数非法）。
> HTTP 状态策略：除未知路径返回 404 外，`/api` 一律返回 **HTTP 200 + JSON**
> （OCS handler 只读 body 的 code，4xx 会触发 fetch 异常分支）。
> `no_match` 仅用于 404 场景；/api 未命中本地库时继续走 AI 管线，不返回 no_match。

依据：P0-3。影响：纯增补，现有 OCS 配置与 handler 不受影响。

### Patch 2（HANDOFF §4.1/§4.2）：/health 响应体定义

建议增补文本：

> `GET /health` 返回 200，响应体：
> `{code:1, status:"ok", uptime:<ms>, version:"1.0.0", bank:<题库条数>, ai:{enabled:<bool>, chain:[<provider>...]}}`。
> `ai` 为附加字段（enabled=AI 总开关；chain=探活后的实际 provider 链），OCS 不读 /health，无破坏。

依据：P0-8。影响：纯增补字段；README §4.3 与 CONTRACT §8 已同步。

### Patch 3（HANDOFF §4.4）：OCS 配置模板 method 字段修正 —— **已批准写回（2026-11-22 用户批准）**

现状：HANDOFF §4.4 模板 `"method": "fetch"` 非法。OCS 官方 schema（<https://docs.ocsjs.com/docs/other/api>）：
`method ∈ {get, post}`；`type ∈ {fetch, GM_xmlhttpRequest}`；`contentType ∈ {json, text}`。
旧模板被 OCS 客户端拒绝（红字「不支持的请求方式」，§2.2 截图①），是用户实测卡住的直接原因（D1）。

修正文本（侧边栏实测可用；README §4.1 与本文件 §2.2 已先行修正，HANDOFF §4.4 于 2026-11-22 写回）：

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

依据：D1（§2.2 截图①②④实证）。影响：纯文档修正，服务端行为不变（GET /api 本就支持）。
HANDOFF §4.4 属接口契约文本，用户 2026-11-22 批准，**已写回并标注批准日期**。

### Patch 4（HANDOFF §5/§7.6）：选项图片占位杂质清洗 + 纯图片选项短路激活 —— **已批准写回（2026-11-22 用户批准；HANDOFF §5/§7.6 + CONTRACT §1.3/§1.5/§5 已同步）**

背景：D3（§2.2/§11）。超星编辑器在选项文字里混入图片占位 URL（如 `https://mooc1.chaoxing.com/.../spacer.gif`）：
a) 纯 URL 占位不触发 image_or_formula（§7.6 只看题干）；b) 杂质干扰 AI 输出格式，真实页面 bailian 35/42 invalid_output（干净题集 100%）。

建议增补文本：

> 1. **选项清洗（新增纯函数 `stripOptionJunk(s)`，lib/normalize.js 导出）**：剥离 markdown 图片 `![...](...)`、
> `<img ...>` 标签、http/https/协议相对前缀的图片资源 URL（png/jpg/jpeg/gif/webp/bmp/svg，含查询串，
> 遇 `#` 截断以保护选项分隔符）、常见裸占位文件名（spacer/blank/pixel/transparent/loading/dot/clear 的 .gif/.png，大小写不敏感）；
> 剥离后连续空白折叠为单空格并 trim。幂等、永不抛（异常返回原串，退化为清洗前行为）。
> **非图片 URL 与普通文本不动**（保守，避免误伤合法选项内容）。
> 2. **key 管线纳入（HANDOFF §5）**：`normalizeOptions` 每项先经 `stripOptionJunk` 再 normalize；key 公式本身不变，
> 仅选项输入预清洗。makeKey/L1/L2 tie-break/import 去重天然一致。空库期零迁移；如有历史库，旧 key 退化为 L2 题干相似命中，不丢失。
> 3. **AI 输入与回写清洗**：server /api 的类型推断、AI prompt、回写存储均用清洗后选项（bank 记录不再含杂质 URL）；
> `prompt.js` optionsText 同样经 `stripOptionJunk`（保护 accuracy/bench 等直接调用方）。**SYSTEM_PROMPT 一字不改**（HANDOFF §7.3 逐字契约）。
> 4. **isUnanswerable 保留 options 入参激活（HANDOFF §7.6「判定只看题干」增补）**：任一选项为「纯图片占位」
> （剥除杂质后去掉 A. 标号再 normalize 为空）→ 整题判 image_or_formula 短路（fail-closed，与 SYSTEM_PROMPT 规则 7「需要看图」语义一致）；
> 「文字+杂质」混合选项不短路，走正常清洗。题干判定规则不变。

依据：D3（侧边栏实测 35/42 + spacer.gif 样例；§11 P1 单）。影响：消除 D3 两项缺陷；对外响应形状/reason 枚举/OCS 配置均不变；
fail-closed 纪律不变（且扩展到纯图片选项）。同步修订：CONTRACT §1.3/§1.5/§5、README §10、DECISIONS D3 行。同步修订已于 2026-11-22 全部落地；回归测试 295/0（glob）、302/0（全量），新增 10 条 D3 用例，既有 292 条零回归。

---

### Patch 5（HANDOFF §7.3）：送 AI 选项缺标号时按位置补 A./B./… —— **已批准写回（2026-11-22 用户批准；HANDOFF §7.3 + CONTRACT §5 已同步）**

背景：D5（§13）。超星常传纯文字选项（无 `A.`/`B.` 标号，如 bank 记录 options=["手","眼","脑","嘴"]）。对带填空括号的
多选题，qwen-flash 会把选项文字当答案抄出来（如「感觉#知觉」）而非输出字母；§7.4 校验只认字母（多选 `/^[A-Z](#[A-Z])*$/`），
判 invalid_output → fail-closed code:0 → 真实页面 Q2–4 红号（Q1 内容恰好回字母故命中）。

复现（2026-11-22，用户 Key，临时脚本跑完即删，分币量级）：同一题干「色彩：色是指…（ ）；彩则指…（ ）。」
- 选项无标号 `感觉#知觉#认识#理解` → 模型原始输出 `感觉#知觉` → postProcess invalid_output；
- 选项带标号 `A.感觉#B.知觉#C.认识#D.理解` → 模型原始输出 `A#B` → postProcess 通过。

建议增补文本：

> **选项补标号（lib/prompt.js optionsText，仅作用 prompt）**：送 AI 前，选项各项若缺字母标号，按**原始位置**补
> `A.`/`B.`/…（`String.fromCharCode(65+i)`）；已带标号（`A.`/`A、`/`A)`/`A）`/`A:`/`A：`/`A␠`/单字母）原样保留；
> 空项跳过但保留其字母槽位（字母与页面选项位置对齐）；超过 26 项不再补（防御）。幂等。先经 stripOptionJunk（Patch 4）
> 清洗再补标号。**不影响 key/存储/匹配**（server 仍用 cleanOptions 原文回写、makeKey 用原始 optionsParam）；
> **SYSTEM_PROMPT 一字不改**（HANDOFF §7.3 逐字契约）；§7.4 后处理校验链不变。

依据：D5（真实页面 Q2–4 红号 + 无标号/带标号对照复现）。影响：消除「纯文字选项诱导抄文字→格式拒收」；对外响应形状/
reason 枚举/OCS 配置均不变；fail-closed 纪律不变（仍只接受字母，补标号是让模型产出字母而非放宽校验）。
同步修订：CONTRACT §5、HANDOFF §7.3、README §10 第 11 条、DECISIONS D5 行。回归测试 glob 307/0、全量 314/0
（新增 12 条 Patch 5 用例 test/patch5-option-letter.test.js，既有 302 条零回归）。
诚实备注：补标号解决「格式被拒」，模型对个别题仍可能答错（AI 回写默认未校验，可人工纠正）；Q1 存量答案 A#C（手#脑）
疑似应为 B#C（眼#脑），待真实选项确认后纠正。

### Patch 6（HANDOFF §4.3 / CONTRACT §1.4）：判断题选项性质 override（√/× 被标成单选题） —— **已批准写回（2026-11-22 用户批准；HANDOFF §4.3 + CONTRACT §1.4 已同步）**

背景：D6。真实页面 1.2 第 3 题【单选题】「人类对明暗感觉更敏锐」选项 A √ / B ×，题库回写 单选题 A，
OCS 黄条「给出的答案和选项不匹配」不自动选。OCS 源码（ocsjs 5.0，packages/core/src/core/worker/question.resolver.ts
+ resolvers/judgement.ts）证实：单选匹配器见两选项具判断性质（isJudgementOptions）即改走 resolveJudgement，
只认 是/对/正确/√/true/T/yes/1 与 非/否/错/错误/×/X/false/F/no/0 等语义词，**不认字母 A/B** → 字母答案必 finish:false。
根因在我方 normalizeType 信 OCS 标签（单选题）优先，inferType 的 √/×→判断 推断被短路。

提案（用户 2026-11-22 主线程「批准」）：normalizeType 在标签匹配前加选项性质 override——optionCount===2 且
选项恰 2 项、剥 OPTION_LEAD_RE 前缀后皆命中 JUDGE_OVERRIDE_RE=/^(?:正确|错误|对|错|是|否|√|×|T|F|true|false)$/i
→ 返回 判断。排除裸 A/B（防误伤真单选）；与 OCS CORRECT/INCORRECT_WORDS 性质对齐。判断管线零改动：
SYSTEM_PROMPT 规则 4 只输出 正确/错误，postProcess 判断分支归一 正确/错误（A/B 经 options[0] 映射，DECISIONS #4）。
存量 2 条 √/× 记录（ecb2d2aa… 单选题 A、92d4b9d4… 单选题 B）停服修复为 判断题 正确/错误。

依据：OCS 官方源码 + 真实页面截图 + bank 记录。影响：对外响应形状/reason 枚举/OCS 配置不变；
答案格式表不变；fail-closed 不变。同步修订：CONTRACT §1.4、HANDOFF §4.3、README §10 第 12 条、DECISIONS D6 行。
回归测试 glob 323/0、全量 330/0（新增 16 条 Patch 6 用例 test/patch6-judge-override.test.js，既有 314 条零回归）。
诚实备注：override 只覆盖「两选项皆判断语义词」形态；三选项及以上或混合文本仍按标签/推断链处理。

### Patch 7（HANDOFF §5/§7.6 / CONTRACT §1.3/§1.5/§5）：题干图片占位杂质清洗（镜像 Patch 4 选项口径） —— **已批准写回（2026-11-22 用户批准；HANDOFF §5/§7.6 + CONTRACT §1.3/§1.5/§5 已同步）**

背景：D7。真实页面「色彩表色体系」测验 Q1【单选题】PCCS 色调题，题干本身纯文字但超星编辑器在题干混入
图片占位（OCS 卡片碎图图标），isUnanswerable 按原始题干图片标记判定 → code:0 image_or_formula →
OCS 0 结果+黄条（/stats imageOrFormula 增量）。Patch 4 只清洗选项，题干仍按原文判定。
实证：`<img>`/裸 URL/markdown 图片三形态皆命中；清洗后 isUnanswerable=false；纯图片题干清洗后仍被拒。

提案（用户 2026-11-22 主线程「批准」）：stripOptionJunk 镜像作用于题干——makeKey/isUnanswerable 内部预清洗；
server match/AI 输入/回写 rec.title/响应 question 统一清洗后题干；buildMessages 题干清洗。
SYSTEM_PROMPT 与 §7.4 校验链一字不改。安全网：纯图片题干清洗后为空仍经长度 < 4 fail-closed；
真·看图题（文字+图）送 AI 后由规则 7 UNKNOWN 兜底，不瞎答。幂等、干净题干零迁移
（存量 58/58 题干皆为空操作）；PCCS 题从未回写，无需修 bank。

依据：真实页面截图 + /stats + 纯函数实证。影响：对外响应形状/reason 枚举/OCS 配置不变；fail-closed 不变。
同步修订：CONTRACT §1.3/§1.5/§5、HANDOFF §5/§7.6、README §10 第 13 条、DECISIONS D7 行。
回归测试 glob 338/0、全量 345/0（新增 14 条 Patch 7 用例 test/patch7-title-junk.test.js + normalize 拆分 1 条，既有零回归；
d3/e2e/http/normalize 旧断言按新契约同步：混合题干不短路、纯图片题干 fixture 保留短路原意）。
诚实备注：清洗只剥图片类杂质（example.png 等非占位白名单裸文件名仍保守短路）；
1 条 Patch 4 前遗留脏选项记录（253b9c27…）维持 Patch 4 裁决「旧 key 退化为 L2 题干相似命中」，与 Patch 7 无关。

### Patch 8（HANDOFF §7.1/§7.2/§7.5/§10 / CONTRACT §7）：AI 层 provider 中立化（兼容市面 API）一期 —— **已批准写回（2026-11-23 用户批准；HANDOFF §7.1/§7.2/§7.5/§9/§10 + CONTRACT §7 + DECISIONS #1 修订/#15 + README §3 已同步）**

背景：原 `lib/ai/index.js` 内部 REGISTRY={bailian,openai,ollama} 以 provider 名为键，bailian.js 与 openai.js 为同构 OpenAI 兼容客户端；
HANDOFF §7.2 标题称百炼「主力」，DECISIONS #1 虽以 config 为准但代码仍硬编码三名注册表；接入新厂商需要改代码。
用户决策（2026-11-23 侧会话批注「可以」+「帮我写个prompt，我新开会话改进」；**批准来源 = 任务 prompt §2**）：AI 层 provider 中立，
OpenAI Chat Completions 兼容为唯一主协议，百炼降格为内置预置之一，链上成员/顺序/各家 baseUrl/model/Key 环境变量名全部由 config.json 决定。

提案（6 点，均在 prompt §2/§3 批准清单内）：
1. **impl 收敛**：保留 lib/ai/openai.js 为通用体；bailian.js 改薄预置壳（chat 委托 openai，只补参数默认 qwen-flash/0/64 + preset:'dashscope'，
   **不补 baseUrl/apiKeyEnv**——缺 baseUrl 仍抛 ai_error，绝不隐式联网）。保留薄壳而非删除的理由：test/ai.test.js 直接 import bailian.js，
   且旧契约「缺 baseUrl 不得联网」须逐字保留；路由层不再经过本壳。impl 种类仅 'openai' 与 'ollama'，REGISTRY={openai,ollama}。
2. **实例层 + 预置表**：config.providers 每条可选新增 impl/preset；lib/ai/presets.js（新增）导出 PRESETS 11 家
   （dashscope/openai/deepseek/kimi/zhipu/siliconflow/openrouter/lmstudio/vllm/xinference/ollama-openai；baseUrl/model 按厂商官方文档核对，来源注于文件注释）
   + resolveInstance(name,rawCfg)（预置默认 ← raw 覆盖；两字段缺省时按名字推断：bailian→dashscope、openai→openai、ollama→ollama impl 不补默认值、其他→openai 无预置）。
   fallback 可列任意实例名；旧配置行为逐字不变。
3. **审核签名表**：MODERATION_SIGNATURES 覆盖 7 家（dashscope/openai/deepseek/kimi/zhipu/siliconflow/openrouter）codes/keywords/finishReasons；
   isModerationError(errOrBody, signature?) 第二参可选（preset 名或 {codes,keywords}），单参行为逐字不变；
   openai 通用体增协议级审核：HTTP 200 finish_reason==='content_filter'（在 content 校验之前判定，DeepSeek 拒答时 content 为空），预置 finishReasons 可追加（zhipu 'sensitive'）。
   全局兜底（DataInspectionFailed 族三码 + 400|500 'data inspection'）恒生效；认不出的 400 仍 ai_error fail-closed 切下一家。
4. **协议差异开关**（全可选）：maxTokensParam('max_tokens' 或 'max_completion_tokens') / omitTemperature / extraHeaders(对象) /
   apiKeyHeader(默认 Authorization Bearer；自定义头名发裸 Key) / query(对象，为 Azure api-version 留口)。无 Key 不发鉴权头。
5. **实例名键控**：stats/byProvider、日志、err.provider、/health ai.chain 一律实例名（现有动态逻辑不变，验证通过）。
6. **配置防御**：未知 impl/preset、impl/preset 冲突 → 该实例剔除 + stderr 警告一次（只含实例名/错误码，进程内按 code+名去重），永不崩溃；
   loadConfig 保留任意实例名条目（三内置名仍合并 DEFAULTS）；pruneFallback 先 resolveInstance 再按生效配置检查（裸 preset 实例不误剔；缺 Key 按生效 apiKeyEnv 判定；本地预置免 Key）。

依据：任务 prompt §2 已批准决策 A/B/C + §3 一期范围（用户 2026-11-23 批准）。二期（Azure/Anthropic/Gemini 原生适配器）不做、另提案。
影响：对外 HANDOFF §4 / README §4 契约逐字不变（OCS 端零感知）；零第三方依赖（package.json 无 dependencies）；Key 只走环境变量（文档/测试仅 sk-xxxxxxxx 占位）；
answer() 永不抛、postProcess fail-closed 不变、lib 无 process.exit、顶层无 I/O、只绑 127.0.0.1 均不变。
同步修订：HANDOFF §7.1（provider 中立条款）/ §7.2（标题按批准 2.B 改「OpenAI 兼容 Provider（通用实现，百炼/DeepSeek/Kimi/… 均为预置）」+ 协议开关）/
§7.5（审核签名增补）/ §9（目录树补 presets.js）/ §10（providers 新字段表 + 名字推断规则）；CONTRACT §7（REGISTRY impl 化 / presets.js 契约 / isModerationError 第二参 / 配置 schema）；
DECISIONS #1 修订 + 新增 #15；README §3.1/§3.2（字段与环境变量表）/ §3.4（Key 申请按厂商列举）/ §3.5（ollama 可选标注保留）/ 新增 §3.6（一条配置接任意兼容厂商）/ §10 第 14 条（accuracy.js 局限）。
回归测试 glob 361/0、全量 368/0（新增 23 条 Patch 8 用例 test/patch8-provider-neutral.test.js，既有 338/345 条零回归）。
隔离冒烟 6/6 PASS（零联网、零成本、全 stub）：三实例链 ds-a(deepseek 预置,400 Content Exists Risk)→kimi-b(kimi 预置,401)→local-c(lmstudio 预置,成功)
fallback 顺序正确各 1 次请求；/health chain 与 /stats byProvider 以实例名为键；AI 答案回写隔离 bank.json（title 字段）；隔离 logs 不含题干/选项/Key；
旧配置 chain=[bailian,ollama] 请求形状/鉴权与旧版逐字一致。生产（PID 22988 @127.0.0.1:8080）未重启、config/data/logs 未动（交付时点状态；当日晚间已重启上线，见 §13 2026-11-23 补记，新 PID 45484）。
诚实备注：siliconflow 官方文档未公布专用审核码，采用关键词签名（代理 DeepSeek 透传文案）+ finish_reason 兜底；openrouter 默认 model 取 deepseek/deepseek-chat（聚合网关，model 可覆盖为任意上游）；
本地预置 model:'local-model' 为占位，须覆盖为实际加载/部署模型名；tools/accuracy.js resolveChain 直查 baseUrl 不感知 preset（一期范围外已知局限，见 README §10 第 14 条）；
真实 Key 冒烟/评测未执行（花钱须用户另行批准），本次交付全 stub。

---

## 8. P0-6 复核结论：accuracy_set.json 20 题 answer 逐题人工复核

复核方式：T6 独立于 T5，逐题用学科知识验证 answer 字段（不依赖 AI）。**结论：20/20 全部正确**，
题型分布 单选8/多选5/判断4/填空2/问答1 与 DoD 一致。该测试集作为 §12.7 的分母有效。

| # | 题型 | 题干（缩略） | 期望答案 | 复核依据 | 结论 |
|---|---|---|---|---|---|
| 01 | 单选 | 1 KB 等于多少字节 | A | 1KB=1024B（A.1024） | ✓ |
| 02 | 单选 | 创建超链接的 HTML 标签 | B | <a>（B.a） | ✓ |
| 03 | 单选 | f(x)=x^2 在 x=2 的导数 | C | f'(x)=2x, f'(2)=4（C.4） | ✓ |
| 04 | 单选 | 光在真空中的速度 | D | 3×10^8 m/s（D） | ✓ |
| 05 | 单选 | 属于电解质的物质 | A | NaCl 水溶液导电；蔗糖/乙醇/葡萄糖非电解质 | ✓ |
| 06 | 单选 | 人体质量占比最多的元素 | C | 氧约 65%（C.氧） | ✓ |
| 07 | 单选 | 《红楼梦》作者 | B | 曹雪芹（B） | ✓ |
| 08 | 单选 | OSI 参考模型层数 | D | 7 层（D） | ✓ |
| 09 | 多选 | 输入设备 | A#C#D | 键盘/鼠标/扫描仪；打印机是输出设备 | ✓ |
| 10 | 多选 | 可再生能源 | A#B#D | 太阳能/风能/水能；煤炭不可再生 | ✓ |
| 11 | 多选 | 线性结构 | B#C#D | 栈/队列/线性表；二叉树是非线性 | ✓ |
| 12 | 多选 | 四大发明 | A#B#C | 造纸术/印刷术/火药（第四是指南针）；地动仪不是 | ✓ |
| 13 | 多选 | 传输层协议 | A#C | TCP/UDP；IP 网络层、HTTP 应用层 | ✓ |
| 14 | 判断 | HTTP 默认端口 80 | 正确 | RFC 标准端口 80 | ✓ |
| 15 | 判断 | 1010₂ = 10₁₀ | 正确 | 8+2=10 | ✓ |
| 16 | 判断 | 地球是太阳系体积最大行星 | 错误 | 最大是木星 | ✓ |
| 17 | 判断 | HTML 是程序设计语言 | 错误 | HTML 是标记语言 | ✓ |
| 18 | 填空 | Python 定义函数关键字 | def | def | ✓ |
| 19 | 填空 | 25 转二进制 | 11001 | 16+8+1=25 | ✓ |
| 20 | 问答 | OSI 自下而上前三层 | 物理层、数据链路层、网络层 | 顺序与名称均正确 | ✓ |

判对口径（采纳 T5，阈值未动）：多选 # 集合全等；判断归一「正确/错误」；填空逐空相等；
问答「包含要点 或 bigram Dice >= 0.6」，0.6 写死且 README 公开。

---

## 9. 安全与健壮性复查（命令验证，原始输出）

检查脚本（t6-security.mjs，收尾已删）覆盖任务书第五步全部 6 项；探针题干 =
test/fixtures/sample.csv 第一条「中国梦的本质内涵是什么」。原始输出：

```text
[1] 硬编码真实 Key 扫描（排除 sk-xxxxxxxx/sk-invalid 等占位）: 0 命中 OK
[2] package.json dependencies=undefined devDependencies=undefined -> OK
[3] node_modules 存在: false -> OK
[4] lib/** 共 11 个 js：process.exit/require/module.exports 命中 0 -> OK
[5] 探针题干（sample.csv 第一条，长度 14）: 中国梦的本质…（全文只在本输出出现一次用于说明，下方只报命中文件）
    logs/ 文件数=0 含题干原文的文件=0 -> OK
    源码日志语句含 sample.csv 题干: 0 -> OK
[6] .gitignore 覆盖 [".env","data/*.json","data/*.bak","logs/*.log"] 缺失=[] -> OK
--- .gitignore 原文 ---
# 依赖与密钥
node_modules/
.env
.env.local
*.pem

# 运行时数据（题库可能很大且含 AI 生成内容，不入库）
data/*.json
data/*.bak
data/*.tmp
logs/*.log
!data/.gitkeep
!logs/.gitkeep
!test/fixtures/*.json

# 临时文件与编辑器
*.tmp
*.log
.DS_Store
Thumbs.db
.idea/
.vscode/

SECURITY SUMMARY: 全部 OK
```

等价手工命令（可复核）：

```powershell
# 硬编码 Key（排除占位 sk-xxxxxxxx / sk-invalid）：全仓库源码 0 命中
Get-ChildItem -Recurse -Include *.js,*.json,*.md -File | Select-String -Pattern 'sk-[A-Za-z0-9]{16,}'
# 零依赖 / 无 node_modules / lib 全程 ESM 且无 process.exit
Get-Content package.json   # 无 dependencies/devDependencies
Test-Path node_modules     # False
Get-ChildItem lib -Recurse -Filter *.js | Select-String -Pattern 'process\.exit\(|require\(|module\.exports'
# 题干原文不入日志：以 sample.csv 第一条题干 grep 源码日志语句与 logs/
Get-ChildItem logs -File   # 验收后为空（仅 .gitkeep）
```

结论：无硬编码真实 Key；零依赖；lib/** 无 process.exit / require / module.exports；
日志只含 key 前 12 位/错误码/计数/耗时/provider 名（§2.5c 实证 moderation.log 不含题干）；
.gitignore 覆盖 .env / data/*.json / data/*.bak / logs/*.log。**全部 OK**。

---

## 10. DoD 核对

**docs/TASKS.md T6 行**：

| DoD 条目 | 状态 | 证据 |
|---|---|---|
| `node --test test/` 全绿 | ✅（等价命令） | Node 24 目录参数失效（§3.3 原始输出）；`node --test` 292 pass/0 fail、glob 285 pass/0 fail（§3.1），语义等价 |
| HANDOFF §12 的 1~7 项逐条实测，原始输出贴进 docs/ACCEPTANCE.md | ✅ | §2.1~2.7 全部原始命令+输出；第 2 项 2026-11-22 侧边栏浏览器实测 PASS（§2.2）、第 7 项真实评测 PASS（100%，两次复跑） |
| 全仓库 grep 无硬编码 Key、无题目原文入日志、package.json 无 dependencies | ✅ | §9 原始输出，全部 OK |

**HANDOFF §12.1~12.8**：1 ✅ / 2 ✅（侧边栏实测） / 3 ✅ / 4 ✅ / 5 ✅(a-d) / 6 ✅ / 7 ✅（真实 100%，20/20） / 8 ✅ —— **八项全部通过**。
（第 8 项虽不在 TASKS T6 行的「1~7」里，任务书第四步仍要求实测，已完成，见 §2.8。）

**PROMPT_T6 交付物**：docs/ACCEPTANCE.md ✅（本文件）/ test/e2e.test.js ✅（11 条）/
docs/CONTRACT.md v1.1 ✅（追认 P1 及全部裁决）/ README.md 更新 ✅ / docs/accuracy-report.json ✅（真实评测生成，verdict PASS，§2.7）。

---

## 11. 遗留问题（按优先级）

| 优先级 | 问题 | 建议动作 |
|---|---|---|
| P3（D4） | ollama 备用链本机未安装时恒连接失败（预期行为） | README §3.5 已标注「可选」；无需代码改动 |
| P2 | OCS 若实际发送表单编码 body | 回来给 server.js 加 x-www-form-urlencoded 解析分支（T3#8；README §7.6 已留说明） |
| P2 | 若未来已有生产 bank 数据 | P0-1/P0-2 口径变更后需重建索引并清缓存（当前库空，无影响；裁决已注明） |
| P2（增强） | 运行中导入不热生效 | 重启服务即可（README 已注明）；热加载可作后续增强，不阻塞交付 |
| P3 | TXT 解析器已知局限（T4#4） | 折行/表格/混排题计 skipped 的语义已文档化；如需增强另立任务 |
| P3 | 公网部署安全 | 当前仅绑 127.0.0.1；公网必须加 token（HANDOFF §14.5），/admin/verify 无鉴权只在本机语义下成立 |

已关闭（集成期发现并修复）：listen(0) bad-port flake（§3.2 根因修复）；`node --test test/` 命令失效（§3.3）；
README §2.4 顺序错误（§2.8 A/B 复测）；§12.7 真实准确率（用户提供 Key 后两次评测均 100% PASS，§2.7）；
HANDOFF.md 两处契约增补（用户 2026-11-19 批准并写回，§7）；accuracy 报表 pass 行 reason 残留 ai_error
（展示瑕疵，已修复 + 回归断言 + 确认复跑，§2.7 第四步、变更表 #19/#20）；§12.2 OCS 浏览器实测
（2026-11-22 侧边栏 PASS，§2.2）；D1 配置模板 method 笔误（README/ACCEPTANCE 已修，HANDOFF Patch 3 于 2026-11-22 获批写回）；
D2 清缓存步骤缺口（§2.2 清单第 7/8 步 + README §4.3 第 9 步）；
D3 选项图片占位杂质（2026-11-22 按用户批准 Patch 4 修复：stripOptionJunk 清洗管线 + 纯图片选项 image_or_formula 短路，HANDOFF §5/§7.6 已写回，回归 295/0 glob、302/0 全量）；
D5 纯文字选项诱导抄文字（2026-11-22 按用户批准 Patch 5 修复：prompt 选项缺标号按位置补 A./B./…，HANDOFF §7.3 已写回，回归 307/0 glob、314/0 全量）。
D6 判断题被超星标成单选题致字母答案不匹配（2026-11-22 按用户批准 Patch 6 修复：normalizeType 选项性质 override + 存量 √/× 记录修复，HANDOFF §4.3 已写回，回归 323/0 glob、330/0 全量）。
D7 题干图片占位误短路纯文字题（2026-11-22 按用户批准 Patch 7 修复：stripOptionJunk 镜像作用于题干 + server/prompt 全链路清洗，HANDOFF §5/§7.6 已写回，回归 338/0 glob、345/0 全量）。

**验收缺口：无。** HANDOFF §12 八项全部通过（§12.2 于 2026-11-22 侧边栏实测闭环）。
剩余均为增强/环境项：P2/P3 见上表（P1 D3、D5、D6、D7 已于 2026-11-22 修复关闭）。

---

## 12. 清理记录（收尾状态）

- `data/` 与 `logs/` 恢复为**仅 .gitkeep**（§12.3/12.5/12.8 演示留下的 bank.json/cache.json/moderation.log 等已删）；
- 临时产物全部删除：`$env:TEMP\qbank-bench.json`（19MB）及其 .bak、qbank-t5-bench-2000.json、qbank-demo.csv、
  qbank-probe/、qbank-t4-*/qbank-t5-* 旧临时目录、全部 t6-* 辅助脚本与捕获文件（内容已原样归档进本文件）；
- 仓库内 T6 临时计数器 `.t6-edits.json` 已删；
- 8080 端口无 node 进程残留（`Get-NetTCPConnection -LocalPort 8080` 计数 0）；
- `docs/accuracy-report.json` **已生成并保留**（T6 交付物，修复后确认复跑生成，verdict PASS；首跑 JSON 被覆盖，原始输出存档于 §2.7）；
- 真实评测 Key 纪律：Key 仅注入子进程环境变量；临时运行脚本（t6-acc-run*.ps1）跑完即删；
  全仓库 65 个文本文件扫描 Key 原文与其特征前缀 **0 命中**（收尾复扫；2026-11-22 部署前复扫亦 0 命中）。
  另：宿主机 Windows 用户级环境变量已持久设置该 Key（仓库外，侧边栏部署准备所留），正式服务经环境继承使用，重启后仍可用；
- 测试临时目录（os.tmpdir() 下 qbank-t6-*）由各测试 after() 自行清理；
- 侧边栏 §12.2 实测（2026-11-22 交接）：临时隔离目录 `%TEMP%\qbank-verify` 已删、临时服务（PID 28740）已停、8080 释放；
  验收期仓库 data/、logs/ 保持仅 .gitkeep（实测数据全部写临时目录）；
- §12.2 浏览器截图 4 张自 `%TEMP%` clipboard 文件归档至 `docs/evidence/`（原件留在临时目录，随系统清理）；
- 正式部署（用户已授权，侧边栏批注「可以」）开始后 data/bank.json 属产品正常数据，不再受验收期 .gitkeep 纪律约束
  （README §11 隐私纪律仍适用）。

## 13. 验收后部署与 D3/D5/D6/D7 修复记录（2026-11-22）+ Patch 8 provider 中立化（2026-11-23）

- **部署模式**：用户无存量题库文件 → 空库起步、AI 回写积累（新题首查走 bailian qwen-flash 秒级，答案自动写入
  `data/bank.json`；同题重查本地 L1/L2 命中零 AI）。正式部署已获用户授权（侧边栏批注「可以」）。
- **D3 修复（Patch 4）**：`stripOptionJunk` 清洗管线（key/AI 输入/回写）+ 纯图片选项 `image_or_formula` 短路；
  实现于 lib/normalize.js、lib/prompt.js、server.js；HANDOFF §5/§7.6 写回、CONTRACT §1.3/§1.5/§5 同步（变更表第 30~33 行）。
- **回归**：glob `node --test test/*.test.js test/stubs/t5-*.js` **295/0**；全量 `node --test` **302/0**（新增 10 条 D3 用例，既有 292 条零回归）。
- **真实 AI 冒烟**（2026-11-22，临时隔离 `%TEMP%\qbank-d3-smoke-*`，脚本跑完即删，仅 1 次真实调用、分币量级）：
  演示题干 + 含 spacer.gif 杂质四选项（裸 URL/markdown 图片/`<img>`/带查询串 URL）→ bailian qwen-flash **331ms 成功**，
  code:1 source:ai answer:A（修复前此类杂质常致 invalid_output）；脏选项重查 → source:local、match.l1=1、ai.calls 增量 0；
  干净选项查同题 → 同样 L1（key 口径一致）；回写记录 options 为干净文本；纯图片占位选项 → code:0 reason:image_or_formula、零 AI。**SMOKE PASS**。
- **生产重启**：旧进程 PID 49832（修复前代码）已停；新进程 **PID 44584**（修复后代码）监听 127.0.0.1:8080，
  /health code:1、ai 链 bailian+ollama，Key 经用户级环境变量继承（未落盘入库）。
- **存量 bank**：重启时 bank 已有 4 条 AI 回写记录（重启前用户真实使用产生）。其中 1 条单选题由旧代码写入、
  选项含占位 URL → 按 Patch 4 裁决「零迁移，旧 key 退化为 L2 题干相似命中」，已临时隔离验证（AI 禁用）：
  以原始脏选项重查该题 → **source:fuzzy、答案一致、零 AI 调用**（LEGACY L2 PASS）。其余 3 条口径干净，不受影响。
- **OCS 配置**：用 D1 修正版模板（HANDOFF §4.4 Patch 3 / README §4.1）；重测本地命中前务必清 OCS 客户端题库缓存（§2.2 清单第 7/8 步）。
- **D5 修复（Patch 5）**：lib/prompt.js optionsText 缺标号选项按原始位置补 A./B./…（幂等、已有标号保留、空项保留字母槽位、>26 防御），
  仅作用 prompt，不动 key/存储/匹配，SYSTEM_PROMPT 与 §7.4 校验链不改；HANDOFF §7.3 / CONTRACT §5 写回（变更表第 34~37 行）。
- **回归**：glob `node --test test/*.test.js test/stubs/t5-*.js` **307/0**；全量 `node --test` **314/0**（新增 12 条 Patch 5 用例，既有 302 条零回归）。
- **服务端全链路冒烟**（2026-11-22，占位题干「光合作用/呼吸作用场所」+ 纯文字四选项，1 次真实调用、分币量级）：
  修复前此形态（无标号 + 填空括号多选）必致 invalid_output；修复后 **code:1 source:ai answer:A#B**（叶绿体#线粒体，正确），
  bailian 1/1 成功 458ms。冒烟产生的占位回写记录已从生产 bank 移除、cache 清空，题库恢复 4 条真实记录。**SMOKE PASS**。
- **Q1 存量错答纠正**：bank 第 1 条（颜色是通过…）原 AI 答案 A#C（手#脑）经学科复核纠正为 **B#C（眼#脑）**，verified:true。
- **生产重启**：Patch 5 代码上线，新进程 **PID 53392** 监听 127.0.0.1:8080，/health code:1、bank 4、ai 链 bailian+ollama，
  Key 经用户级环境变量继承（未落盘入库）；stderr 捕获于 %TEMP%\qbank-prod-stderr.log。
- **真实页面验证（待用户）**：请刷新课程页或重点击题号 2/3/4（先清 OCS 客户端题库缓存，§2.2 第 7/8 步），
  预期 Q2–4 由红号转为答出（source:ai 回写）；Q1 重查命中本地 B#C。

- **D6 修复（Patch 6）**：lib/normalize.js normalizeType 选项性质 override（恰好两选项且剥 A. 前缀后皆判断语义词
  → 强制判断，优先于标签；JUDGE_OVERRIDE_RE 排除裸 A/B）；判断管线/SYSTEM_PROMPT/§7.4/key/存储零改动；
  HANDOFF §4.3 / CONTRACT §1.4 写回（变更表第 38~41 行）。
- **回归**：glob `node --test test/*.test.js test/stubs/t5-*.js` **323/0**；全量 `node --test test/*.test.js test/stubs/*.js` **330/0**（新增 16 条 Patch 6 用例，既有 314 条零回归）。
- **隔离冒烟**（2026-11-22，QBANK_PORT=8091 + 临时 data/logs，1 次真实调用、分币量级）：占位题干「水由氢氧元素组成」+
  `type=单选题&options=√#×` → **code:1 answer:正确 source:ai**（bailian 366ms 一次成功）；重查 → source:local、match.l1=1；
  回写记录 **type:判断题 answer:正确**。修复前同形态必存字母 A 致 OCS 不匹配。**SMOKE PASS**。临时目录/脚本已清理。
- **存量 bank 修复**：停服后 2 条 √/× 记录 单选题 A（ecb2d2aa…）→ **判断题 正确**、单选题 B（92d4b9d4…）→ **判断题 错误**；
  离线纯函数校验 makeKey(title,'√#×')===key 两条均 true（重点击必 L1 本地命中，零 AI）。
- **生产重启**：旧进程 PID 53392 已停；新进程 **PID 57772** 监听 127.0.0.1:8080，/health code:1、bank 17、
  ai 链 bailian+ollama，Key 经用户级环境变量继承（未落盘入库）；stderr 捕获于 %TEMP%\qbank-prod-stderr.log。
- **真实页面验证（用户确认 PASS，2026-11-22）**：清缓存重点击后两道判断题（人类对明暗感觉更敏锐 / MUNSELL 红蓝强度）
  答案显示 正确/错误、自动选中 √/×、黄条消失（用户侧边栏截图确认「验证没问题」）；Patch 6 闭环。

- **D7 修复（Patch 7）**：超星编辑器把 spacer.gif 等图片占位也混进**题干**（OCS 卡片出现碎图图标），纯文字题被
  `isUnanswerable` 按图片题短路（code:0 image_or_formula，0 结果+黄条）。修复将 Patch 4 的 `stripOptionJunk` 镜像作用于题干：
  lib/normalize.js `makeKey`/`isUnanswerable`、server.js 全链路（key/匹配/图片判定/送 AI/回写/缓存命中展示）、lib/prompt.js buildMessages
  统一改用清洗后题干；纯图片题干清洗后仍拦截（fail-closed），rawOptions 保持原样供纯图片选项判定。详见变更表 42~45 行。
- **回归**：glob `node --test test/*.test.js test/stubs/t5-*.js` **338/0**；全量 `node --test test/*.test.js test/stubs/*.js` **345/0**
  （新增 14 条 Patch 7 用例，既有 1 条图片标记用例按新契约拆为两条，其余零回归）。
- **隔离冒烟**（2026-11-22，QBANK_PORT=8091 + 临时 data/logs，1 次真实调用、分币量级）：占位题干混入编辑器图片占位 →
  **code:1 answer:A source:ai**（bailian 342ms 一次成功），返回 question 为清洗后纯文字；重查与干净题干查询 → source:local、match.l1=2；
  纯图片题干 → image_or_formula 且零 AI 调用；回写记录题干干净。**SMOKE PASS**。临时目录/脚本已清理。
- **存量 bank**：58/58 条记录题干均无图片杂质，`stripOptionJunk` 全为 no-op → **零迁移**；1 条 Patch 4 之前的脏**选项**记录（253b9c27…）
  key 与新管线不一致，维持 Patch 4 裁决（L2 降级重查），与 D7 无关、不修复。
- **生产重启**：旧进程 PID 57772 已停；新进程 **PID 22988** 监听 127.0.0.1:8080，/health code:1、bank 58、
  ai 链 bailian+ollama，Key 经用户级环境变量继承（未落盘入库）；stderr 捕获于 %TEMP%\qbank-prod-stderr.log。
- **真实页面验证（用户确认 PASS，2026-11-22）**：清缓存重点击「色彩表色体系」Q1（PCCS 色调题）后答案显示+选项自动选中、
  黄条与卡片碎图图标消失（用户主线程批注「这个没问题」确认）；Patch 7 闭环。

- **D8 观察与裁决（2026-11-22，不实施）**：纯图片选项题（色块单选题，用户截图）0 结果+黄条，诊断为 Patch 4 fail-closed 设计行为
  （`isUnanswerable` 纯图片选项短路，server.js 第 6 步），非缺陷；OCS options 参数含图片链接，服务端可取图。曾提视觉方案：
  仅放开纯图片选项（题干图/公式拒答不变），服务端下载选项图（限张数/大小/超时）送 qwen3-vl-flash（复用现有 Key，
  输入 0.15 元/百万 token，单题<1 分），同 postProcess 校验、任一失败仍 image_or_formula，成功照常回写，QBANK_VISION_ENABLED 开关；
  因涉 HANDOFF §5/§7.6、CONTRACT §1.5 契约表述变更，按纪律提请批准。**用户裁决：保持现状，不实施**。代码/契约/配置零改动，
  生产 PID 22988 续跑（bank 59）。风险随方案存档：图片链接会话参数致 key 漂移（偶尔重复看图）；OCS 对图片选项自动点选未实测
  （最坏卡片显示字母手动点）；回写选项文本为空占位。方案存档于此，日后可再提案。

- **1.7.4 绿色 Q1 瞬时拒答与重试回写（2026-11-22，运维观察，零代码改动）**：该节绿色地位单选题 OCS 真实请求首跑
  bailian 输出不合规 → invalid_output → ollama 备用链本机未安装失败 → code:0 ai_error（OCS 显示 0 结果+黄条，
  fail-closed 正确行为，非缺陷；黄条为客户端对 code:0 的措辞）。同参数重试 bailian 一次成功（481ms）答案 **B** 回写
  （key 7fecbd07…，verified:false，bank 59→60）。双格式实测复核：无标号选项 → source:local（L1 精确，match.l1+1）；
  带 A. 标号选项 → source:fuzzy（L2 题干满分兜底，match.l2+1）；两者均返回 B、零新增 AI 调用。同节另两题
  （诗句题 / 环保 LOGO 题）本会话 OCS 真实请求均 L1 命中且库内选项为无标号纯文本，证 OCS 发送纯文本选项，
  清缓存重点击 Q1 必本地命中。B 为 AI 答案未核对标准答案（公网检索无该题答案键），若平台判错按 Patch 5 先例
  离线纠正 + verified:true。生产 PID 22988 续跑，未重启。

- **Patch 8 provider 中立化一期（2026-11-23，用户批准来源 = 任务 prompt §2；代码+测试+文档已写回，生产未动）**：
  实施文件：lib/ai/presets.js（新增）、lib/ai/openai.js（通用体）、lib/ai/bailian.js（薄壳）、lib/ai/ollama.js（providerName）、
  lib/ai/index.js（REGISTRY={openai,ollama} + 实例解析 + isModerationError 第二参）、config.js（保留任意实例名 + preset 感知剔除）；
  server.js / package.json / 生产 config.json 未动。详见变更表 46~49 行与 §7 Patch 8。
- **回归**：glob `node --test test/*.test.js test/stubs/t5-*.js` **361/0**；全量 `node --test test/*.test.js test/stubs/*.js` **368/0**
  （新增 23 条 Patch 8 用例 test/patch8-provider-neutral.test.js，既有 338/345 条零回归；文档写回后复跑同结果）。
- **隔离冒烟 6/6 PASS**（2026-11-23，零联网、零成本、全 stub；createServer({config,paths,env}) 注入 + loadConfig({cwd:临时目录,env,loadDotEnv:false}) +
  QBANK_PORT='0' listen(0) 随机端口；data/logs 全部在 %TEMP% 临时目录，脚本跑完即删）：
  A1 三实例链 ds-a(deepseek 预置,400 'Content Exists Risk' 审核)→kimi-b(kimi 预置,401)→local-c(lmstudio 预置,成功) fallback 顺序正确各 1 次请求；
  A2 /health ai.chain=["ds-a","kimi-b","local-c"]（实例名）；A3 /stats byProvider 以实例名为键，moderation/failed/success 计数正确；
  A4 AI 答案回写隔离 bank.json（title 字段，1 条记录）；A5 隔离 logs 目录全部文件不含题干/选项/Key；
  B1 旧配置 chain=[bailian,ollama] 请求形状/鉴权与旧版逐字一致，byProvider.bailian 计数正确（QBANK_BAILIAN_BASE_URL 指假 provider，零真实调用）。
- **生产未动声明**：生产 PID 22988 @127.0.0.1:8080 全程续跑（本会话两次 /health 核实：code:1、bank 115、ai.chain=["bailian","ollama"]）；
  未重启、未改生产 config.json / data/ / logs/。Patch 8 代码已入库，**何时重启生产加载由用户决定**（旧进程内存中仍是旧代码，行为不变）。
- **真实 Key 冒烟/评测未执行**（花钱须用户另行批准），本次交付全 stub（fetchImpl 注入）。

- **Patch 8 生产上线（2026-11-23 21:41，用户本人执行重启，侧线程指导+只读验证；「重启生产加载 Patch 8」待办闭环）**：
  旧进程 PID 22988（2026-11-22 20:22:44 启动）经 `Stop-Process -Id 22988` 停止——Windows 下为强杀，SIGINT/SIGTERM 优雅退出钩子未执行；
  因题库写入为临时文件+原子改名且有 bank.json.bak 兜底，数据无损（最坏丢约 1.3s 未落盘写回）。新进程 **PID 45484** 于 **2026-11-23 21:41:49** 启动
  （Start-Process `D:\node.js\node.exe` -ArgumentList `server.js` -WorkingDirectory 项目根 -WindowStyle Hidden，日志落盘 %TEMP%\qbank-prod-stderr.log / qbank-prod-stdout.log）。
  重启后验证四项全过：① /health code:1、status ok、bank **115 与重启前一致无损**、ai.enabled=true、chain=["bailian","ollama"]、uptime 归零 → 新进程接管；
  ② stderr 日志仅一行 `[qbank][server][listening] http://127.0.0.1:8080 ai=bailian->ollama`，无 no_key_bailian 警告、无报错 → 用户级环境变量 DASHSCOPE_API_KEY 继承正常；
  ③ config.json 未做任何改动（Patch 8 向后兼容，旧配置原样可用）；④ 主线程只读复核同结果（Get-CimInstance 确认 PID 45484 / 2026-11-23 21:41:49 / `"D:\node.js\node.exe" server.js`）。
  **Patch 8 代码已在生产生效**。运维先例：Windows 下 Stop-Process 强杀可接受（原子写+.bak 兜底）；挑无人刷题的空闲窗口，中断约 1–2 秒；
  今后重启先重新定位 PID（勿误杀 Adobe 的 node.exe）：`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*D:\node.js\node.exe*server.js*' }`；
  生产日志固定 %TEMP%\qbank-prod-stderr.log 与 qbank-prod-stdout.log。显示提示：PowerShell 5.1 下 /health 的 ai 字段默认折叠为 @{enabled=True; chain=System.Object[]} 属正常显示而非异常，
  展开用 `Invoke-RestMethod http://127.0.0.1:8080/health | ConvertTo-Json -Depth 5`。后续可选项等用户指示：按 README §3.6 启用新 provider（改 config 后需再重启一次才生效）、
  真实 Key 冒烟（花钱，非必需）、题库本地命中题免费冒烟。

—— T6 集成与验收 完（2026-11-22 补记：§12.2 闭环，八项全过；D3 按 Patch 4、D5 按 Patch 5、D6 按 Patch 6、D7 按 Patch 7 修复并重启生产部署，见 §13；2026-11-23 补记：Patch 8 provider 中立化一期实施完毕并于当日 21:41 重启上线，生产 PID 45484，见 §13） ——
