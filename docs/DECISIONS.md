# 规格补全与矛盾裁决 v1.0（已确认基线，实现时以此为准）

| # | HANDOFF 中的问题 | 裁决 |
|---|---|---|
| 1 | §3 图写 `bailian→ollama→openai`，§10 配置只写 `["bailian","ollama"]` | 以 **config.json 为准**。openai provider 照常实现，默认不进链，改一行配置即可启用。**Patch 8 修订（2026-11-23 用户批准）**：默认链由配置决定，代码无硬编码「主力」；bailian 降格为内置预置之一（见 #15） |
| 2 | §5 归一化顺序自相矛盾：先删标点会导致 `1.`/`【单选题】` 前缀永远无法剥离 | 调整为 NFKC → 去空白 → 去题号 → 去题型标记 → 小写 → 去标点（见 CONTRACT §1.1）。属 bug 修复，不影响对外契约 |
| 3 | `type` 取值域未定义，OCS 可能传中文/英文/空 | 建映射表 + 推断链（CONTRACT §1.4）。AI 返回多字母时按多选校验 |
| 4 | §7.4 把 `A|B` 一律归一为「正确/错误」，但 A 对应哪个依题库而异 | 仅当 `options[0]` 含 `正确/对/√/是` 时才映射 A→正确、B→错误，否则判校验失败（宁可不答） |
| 5 | `options` 分隔符只提到 `#` | 切分优先级 `#` → 换行 → `;/；` → `A.` 标号正则 → 整体（CONTRACT §1.2） |
| 6 | §8.3 `requireVerified:true` 会丢弃未验证 AI 答案，与「同题永不重复调 AI」冲突 | `requireVerified:true` 只约束 `store.get/match`（bank 层）；`cache` 层不受约束，仍可应答未验证条目。默认 `false` |
| 7 | `/stats` 返回结构未定义 | `{uptime,version,bank:{total,verified,bySource},cache:{size,hits,misses,evictions,writes},ai:{calls,success,failed,moderation,timeout,queueFull,inflight,queued,tokensIn,tokensOut,byProvider,chain},match:{l1,l2,l2Suspicious,noMatch,imageOrFormula},elapsed:{p50,p95,p99,samples}}` |
| 8 | §4.2 未命中响应缺 `elapsed` | 所有响应统一带 `elapsed`（毫秒整数）。OCS handler 只读 `code/question/answer`，多字段无害 |
| 9 | reason 枚举缺「模型输出不合规」「无可用 provider」 | 均归 `ai_error`。新增内部码 `invalid_output`（不对外）、对外 `bad_request`（仅请求本身非法，如缺 `q`、body >1MB） |
| 10 | `bank.json` 与 `cache.json` 数据重叠，加载优先级未定义 | bank 权威。启动时先载 bank，再载 cache 并丢弃与 bank 同 key 的条目（防脏缓存盖掉人工修正） |
| 11 | §8.3 要求 `POST /admin/verify`，§14 又说不做管理界面 | 做 **JSON 接口、不做 UI**。`POST /admin/verify {key, verified}` → 改标记 + 落盘（先 .bak）。仅绑 127.0.0.1，不加鉴权 |
| 12 | L2 只按标题打分，同题干不同选项可能误命中 | 候选中若存在 options key 完全相同者，直接优先选它（CONTRACT §2 tie-break） |
| 13 | bank.json 顶层结构未定义 | `{"version":1,"updatedAt":<ms>,"records":[...]}`；`store.load` 与 `import.js` 兼容裸数组 |
| 14 | Windows 下回写与定时 flush 可能交叉写坏文件 | 统一「临时文件 + rename」原子替换 + store 内单写队列；退出钩子强制 flush |
| 15 | AI 层 provider 中立化（Patch 8，2026-11-23 用户批准，见 ACCEPTANCE §7） | OpenAI Chat Completions 兼容为唯一主协议；impl 仅 `'openai'` / `'ollama'`；PRESETS 内置 11 家预置（dashscope/openai/deepseek/kimi/zhipu/siliconflow/openrouter/lmstudio/vllm/xinference/ollama-openai），预置为默认值包可被配置覆盖，任意兼容服务一条配置入链零代码改动；审核签名按 preset（7 家）+ 全局兜底，`isModerationError` 第二参可选；协议开关 maxTokensParam/omitTemperature/extraHeaders/apiKeyHeader/query；stats/日志/err.provider 以实例名为键；未知 impl/preset → 剔除 + 警告一次永不崩溃 |

## 固定基线（PROMPT.md 已决策，不再讨论）
默认模型 `qwen-flash`；百炼端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`；不做 Web UI；
`acceptSuspicious:false`；JSON 文件存储；不做鉴权、只绑 `127.0.0.1`；不支持 xlsx；
代码直接建在项目根目录，不套 `qbank/`；模块体系 **ESM**。

## T6 集成裁决（v1.1，2026-11，详见 docs/ACCEPTANCE.md「裁决记录」）

T1~T5 交付报告提出的 P0-1~P0-8 / P1-1~P1-13 / P2 全部条目已由 T6 按 docs/PROMPT_T6.md
授权统一裁决，结论摘要（完整理由与落地动作见 ACCEPTANCE）：

| 编号 | 裁决摘要 |
|---|---|
| P0-1 | splitOptions 第 4 级改 lookahead 切分，保留字母标号（修 CONTRACT §1.2 措辞）；makeKey 口径不变 |
| P0-2 | ①「不定项(选择题)」归多选 + 导入侧答案多字母推断规则 0 + toLabel 别名表；②多选校验允许单字母 `/^[A-Z](#[A-Z])*$/` |
| P0-3 | /api 一切失败 HTTP 200 + JSON（含 bad_request），保持 T3 实现；HANDOFF §4.2 补丁 2026-11-19 用户批准写回 |
| P0-4 | postProcess ctx 接受短题型/中文标签双形态，options 传原文（不 normalize） |
| P0-5 | 前缀剥离正则长前缀优先 + 可选「是/为」，cleanRaw 导出追认 |
| P0-6 | accuracy_set.json 20 题按 T5 标准逐题人工复核通过（T6 再核一遍，结论见 ACCEPTANCE） |
| P0-7 | 并发闸只留 server 外包一层，createAI 内层删除；gate.stats().peak 供 e2e 断言 |
| P0-8 | /health 的 ai 升级为 {enabled, chain}；HANDOFF 补丁（响应体定义落 §4.1/§4.2）2026-11-19 用户批准写回 |
| P1-1~13 | 全部追认进 CONTRACT v1.1（cache.json 格式、genbank 固定时间戳、import stdout 超集、nearDuplicates/collisions 区分、queueFull 取 gate.rejected、setVerified/flushing、gate.close/peak、超时从执行起算、chat 可注入 fetchImpl/retryBaseMs/retryMax、CLI 退出码 2、bench R type-7、lookup opts 覆盖） |
| P2 | 各任务小项批准现状（含 T3#8 POST 只收 JSON、T3#9 verify 无鉴权、T3#11 删静态装配 fallback、T2#1 prompt 静态 import toLabel）；README 已同步修订 |

本文件与 CONTRACT.md 自 T6 起由「只读」改为「T6 裁决可修订」；HANDOFF.md 仍只读，
对外协议变更一律走 ACCEPTANCE「契约增补」提案，由用户批准（本次两处增补已于 2026-11-19 获批写回 HANDOFF §4.1/§4.2）。

## 验收后新增发现（2026-11-22 侧边栏 §12.2 实测交接）

| 编号 | 发现 | 处置 |
|---|---|---|
| D1 | OCS 配置模板 `"method":"fetch"` 非法（官方 schema method∈{get,post}），客户端红字「不支持的请求方式」 | README §4.1 / ACCEPTANCE §2.2 已修；HANDOFF §4.4 属契约，Patch 3 已于 2026-11-22 获批写回（ACCEPTANCE §7） |
| D2 | OCS 客户端「题库缓存」截胡本地命中重测（结果带标签、服务端 match.l1 不动） | ACCEPTANCE §2.2 清单增补清缓存步骤；README §4.3 第 9 步 |
| D3 | 超星选项混入 spacer.gif 图片占位 URL：不触发 image_or_formula，且致 bailian 35/42 invalid_output（干净题集 100%） | **已修复（2026-11-22 用户批准 Patch 4）**：stripOptionJunk 纳入 normalizeOptions/key 管线 + AI 输入/回写清洗 + 纯图片选项 image_or_formula 短路；HANDOFF §5/§7.6 已写回，回归 295/0（glob）、302/0（全量）（ACCEPTANCE §7/§11） |
| D4 | ollama 未安装时备用链恒失败（预期） | README §3.5 标注可选 |
| D5 | 超星纯文字选项（无 A./B. 标号）诱导 qwen-flash 抄选项文字而非字母，带填空括号的多选题尤甚 → §7.4 校验拒收 invalid_output → 真实页面 Q2–4 红号（复现：无标号→「感觉#知觉」拒收；带标号→「A#B」通过） | **已修复（2026-11-22 用户批准 Patch 5）**：prompt.js optionsText 缺标号按原始位置补 A./B./…（幂等、已有标号保留、空项保留字母槽位），仅作用 prompt 不动 key/存储/匹配，SYSTEM_PROMPT 一字不改；HANDOFF §7.3 / CONTRACT §5 已写回，回归 glob 307/0、全量 314/0（ACCEPTANCE §7 Patch 5/§13） |
| D6 | 超星把 √/× 判断题标成【单选题】，normalizeType 信标签走单选存字母；OCS 单选匹配器对判断性质选项改走判断匹配（isJudgementOptions→resolveJudgement，只认 正确/错误/√/× 不认字母）→ 黄条「答案和选项不匹配」不自动选（真实页面 1.2 第 3 题等 2 条 √/× 记录） | **已修复（2026-11-22 用户批准 Patch 6）**：normalizeType 选项性质 override（两选项皆判断语义词→强制判断，优先于标签；排除裸 A/B）；存量 2 条 √/× 记录修复为 判断题 正确/错误；HANDOFF §4.3 / CONTRACT §1.4 已写回，回归 glob 323/0、全量 330/0（ACCEPTANCE §7 Patch 6/§13） |
| D7 | 超星编辑器把图片占位（spacer.gif/<img>/markdown 图片）也混进**题干**：纯文字题被 isUnanswerable 题干图片标记误短路 image_or_formula（真实页面 PCCS 单选题 0 结果+黄条；/stats imageOrFormula 增量） | **已修复（2026-11-22 用户批准 Patch 7）**：stripOptionJunk 镜像作用于题干（makeKey/isUnanswerable 内部预清洗 + server match/AI/回写/响应 question + prompt 题干）；纯图片题干仍 fail-closed、真看图题规则 7 兜底；存量题干 58/58 零迁移；HANDOFF §5/§7.6、CONTRACT §1.3/§1.5/§5 已写回，回归 glob 338/0、全量 345/0（ACCEPTANCE §7 Patch 7/§13） |
| D8 | 纯图片选项题（如色块单选题）0 结果+黄条：Patch 4 fail-closed 设计行为（isUnanswerable 纯图片选项短路），非缺陷；OCS options 参数已含图片链接，服务端可取图 | **用户裁决 2026-11-22：保持现状，不实施视觉方案**。纯图片选项题继续 code:0 image_or_formula、零 AI；方案（服务端下载选项图 + qwen3-vl-flash + 同校验 fail-closed + 开关，单题成本<1 分）存档 ACCEPTANCE §13，日后可再提案；代码/契约零改动 |

§12.2 据此改判 PASS，HANDOFF §12 八项全部通过；正式部署获用户授权（侧边栏批注「可以」）。
D5（纯文字选项诱导抄文字致 Q2–4 红号）于 2026-11-22 经用户批准 Patch 5 修复（prompt 选项补标号），生产 PID 53392 上线，详见 ACCEPTANCE §13。
D6（判断题被标成单选题致字母答案不匹配）于 2026-11-22 经用户批准 Patch 6 修复（normalizeType 选项性质 override + 存量 √/× 记录修复），详见 ACCEPTANCE §13。
D7（题干图片占位误短路纯文字题）于 2026-11-22 经用户批准 Patch 7 修复（题干清洗镜像 Patch 4 选项口径），生产 PID 22988 上线，详见 ACCEPTANCE §13。
D8（纯图片选项题）于 2026-11-22 经用户裁决保持现状、不实施视觉方案；纯图片选项题继续安全拒答（code:0 image_or_formula、零 AI），方案存档 ACCEPTANCE §13，日后可再提案。
