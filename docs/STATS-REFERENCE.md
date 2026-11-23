# `/stats` 字段参考

本文件是 README §7.2 的全量表格外置（表格内容自 README 原样迁出，未做改写）。获取方式与日常排障见 README §7。

| 字段 | 含义 | 怎么用 |
|---|---|---|
| `uptime` | 进程运行毫秒数 | 突然变小 = 进程重启过 |
| `version` | 版本号 | — |
| `bank.total` / `bank.verified` | 题库总条数 / 已人工验证条数 | 导入后核对数量 |
| `bank.bySource` | 按来源分组的条数（`local` / `ai` / …） | 看 AI 回写了多少条，回写在涨说明链路通 |
| `cache.size` | LRU 当前条数 | 上限 `cache.maxEntries`（默认 10000） |
| `cache.hits` / `misses` | 缓存命中 / 未命中 | 命中率长期为 0 说明重复查询少，属正常 |
| `cache.evictions` | 淘汰次数 | 涨得快可以把 `QBANK_CACHE_MAX_ENTRIES` 调大 |
| `cache.writes` | 缓存写入（`set`）累计次数 | 每满 100 次写入触发一次落盘，另有 `cache.flushIntervalMs`（默认 30s）定时落盘，Ctrl+C 时强制 flush |
| `ai.calls` / `success` / `failed` | AI 调用总数 / 成功 / 失败 | `failed` 持续 = 0 且 `success` 在涨 → 链路健康 |
| `ai.moderation` | 审核拦截次数 | 高 → 内容审核拦截，属预期降级（OCS 跳过该题） |
| `ai.timeout` | 超时次数（来自并发闸） | 高 → 调大 `timeoutMs` 或换快模型 |
| `ai.queueFull` | 队列满拒绝次数 | 高 → 降速率或调大 `queueLimit` |
| `ai.inflight` / `ai.queued` | 正在执行 / 排队中的 AI 任务 | **验收点**：并发 20 个请求时 `inflight` 必须 <= 3 |
| `ai.tokensIn` / `tokensOut` | 累计输入 / 输出 token | 估算花费 |
| `ai.byProvider` | 每个 provider 的调用计数 | 看降级发生在哪一层 |
| `ai.chain` | 当前 provider 链 | 空数组 = 所有新题都答不了 |
| `match.l1` / `match.l2` | L1 / L2 命中次数 | L1 占比越高越省钱越快 |
| `match.l2Suspicious` | 得分 `0.80~0.90` 的疑似候选数 | 被 `acceptSuspicious=false` 丢弃的数量 |
| `match.noMatch` | 彻底没命中次数 | — |
| `match.imageOrFormula` | 图片/公式短路次数 | — |
| `elapsed.p50` / `p95` / `p99` / `samples` | HTTP 端到端耗时分位数（滚动窗口） | 这是**含 AI 的真实耗时**，比 `tools/bench.js` 的纯检索耗时大得多，不要混淆 |
