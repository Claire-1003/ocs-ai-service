# 并行任务拆分 v1.1

> v1.1 变更：把「并行隔离约束」升级为强制条款，全文见 `docs/CONTRACT.md §11`。
> 每个窗口的 prompt 必须以 `docs/PROMPT_PREFIX.md` 的内容开头。

## 依赖图

```
T0 骨架/配置 (串行, 已完成 ✅)
   |
   +---> T1 归一化+匹配       ----\
   +---> T2 AI层+并发闸        -----+---> T6 集成与验收 (串行)
   +---> T3 存储+缓存+HTTP    -----/            |
   +---> T4 导入+数据生成      ----> (为 T5/T6 供数据)
   +---> T5 bench+accuracy+README (可先写, 达标数字要等 T6)
```

T1~T5 写权限完全不重叠（CONTRACT §10），可同时开 5 个窗口。
里程碑映射：T0+T3 ≈ M1，T1 ≈ M2，T2 ≈ M3，T3+T4 ≈ M4，T5+T6 ≈ M5。

## 各任务完成定义（DoD）

| 任务 | DoD |
|---|---|
| T0 ✅ | `loadConfig()` 输出 port 8080；缺 `DASHSCOPE_API_KEY` 时剔除 bailian 且打印中文提示、进程不崩；`.env` 解析生效且真实环境变量优先；坏/缺 `config.json` 回退默认值；返回对象深冻结；`resolvePaths` 六条路径正确；`.gitignore` 含 `.env` 与 `data/*.json`；目录 `data logs lib lib/ai tools test test/fixtures docs` 齐备 |
| T1 | `node --test test/normalize.test.js test/matcher.test.js` 全绿；normalize 覆盖 §1.1 全 7 步 + 题号/题型剥离；matcher 覆盖乱序选项同 key、0.90 边界、suspicious 丢弃、tie-break；5000 条合成数据下 `lookup` 平均 < 5ms；满足 CONTRACT §11.1~§11.8 |
| T2 | `node --test test/prompt.test.js test/answer.test.js test/queue.test.js test/ai.test.js` 全绿；用 `listen(0)` 的本地假 provider 覆盖 200 / 400 DataInspectionFailed / 500 InternalError.Algo.DataInspectionFailed / 401 / 429 退避 / 超时 abort / 坏 JSON；gate 覆盖并发<=3、队列满 queue_full、FIFO；退避间隔可注入、无真实 sleep；满足 CONTRACT §11 |
| T3 | `node --test test/store.test.js test/cache.test.js test/http.test.js` 全绿；`node server.js` 起 8080，`/health` `/stats` `/api` 通；`bank.json.bak` 生成；Ctrl+C 后 `cache.json` 完整；handler 抛错仍返回 `code:0`；并发 20 请求无 ECONNRESET；满足 CONTRACT §11 |
| T4 | `node --test test/import.test.js` 全绿；`tools/genbank.js --count 50000` 60s 内产出且同 seed 逐字节可复现；四种 fixture 导入正确、duplicates 统计准确；`--dry-run` 不写盘；测试只写 `os.tmpdir()`；满足 CONTRACT §11 |
| T5 | `tools/bench.js` 与 `tools/accuracy.js` 能跑完并打印 PASS/FAIL 与正确退出码；`accuracy.js --mock` 可离线自测；`accuracy_set.json` 20 题（单选8/多选5/判断4/填空2/问答1）且答案逐题人工确认；README 覆盖 §12.8 全部 5 主题且无真实 Key；满足 CONTRACT §11 |
| T6 | `node --test test/` 全绿；HANDOFF §12 的 1~7 项逐条实测，原始输出贴进 `docs/ACCEPTANCE.md`；全仓库 grep 确认无硬编码 Key、无题目原文入日志、`package.json` 无 `dependencies` |

## 各任务的隔离要点（CONTRACT §11 的任务级补充）

| 任务 | 特别注意事项 |
|---|---|
| T1 | 纯函数模块，**不得** import `fs`/`http`/`config.js`；matcher 配置走构造函数入参。测试数据在内存里生成，不落盘 |
| T2 | 假 provider 用 `node:http` + `listen(0)`；**严禁**真实联网调 dashscope/openai；退避与超时时间必须做成可注入参数（如 `retryBaseMs`），测试里传 10ms 级；`gate` 的 interval 必须可清理，否则 `node --test` 挂住 |
| T3 | 唯一会真的监听端口的任务，测试一律 `listen(0)`；`data`/`logs` 路径通过 `loadConfig({cwd,env:{QBANK_DATA_DIR,QBANK_LOGS_DIR}})` + `resolvePaths` 注入到临时目录；手动演示 `node server.js` 时用完必须 Ctrl+C 关掉，避免占住 8080 影响别的窗口 |
| T4 | 所有导入测试显式传 `--out` 到临时目录；`genbank` 的 5 万条大文件**不要**在测试里生成（测试用 `--count 2000`），大产物只在 T5/T6 手动跑 |
| T5 | 现在写代码、T6 才跑真数据；自测用 `test/fixtures/sample.json`（T4 产出，可能还不存在 → 自己造一个 20 条的小样本放 `test/stubs/`，**不要**写进 `test/fixtures/`，那是 T4 的地盘） |
| T6 | 唯一可跨文件改动的窗口；改动前先出「偏差表」，以 CONTRACT 为准修实现方，不修契约 |

## 交付报告格式
见 `docs/CONTRACT.md §11.8`，五个小节一个都不能少。
