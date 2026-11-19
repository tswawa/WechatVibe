# WechatVibe 性能瓶颈分析与优化方案

> 基线：`package.json` 1.3.5，本工作树（含未提交改动）。行号以该基线为准，函数名为准。
> 方法：调用链静态分析 + 本机微基准（`scripts/perf-baseline.py`）+ 仓库内已有实测数据（`docs/TECHNICAL.md` §10.2）。
> 标注约定：**【实测】** 本机跑出的数字；**【推算】** 由代码结构 + 实测单点成本线性外推；**【文档】** 仓库既有实测结论。

---

## 1. 结论摘要

性能问题分两类，**不要混在一起优化**：

- **A 类｜端到端时延**：打开会话后标签/画像要等多久。瓶颈在本地推理的**调用粒度**（逐条、单行、串行）与**逐条落库**，不在 tokenizer、不在 JSON。
- **B 类｜稳态开销**：什么都不做时每秒烧掉的 CPU。瓶颈是**每个 HTTP 请求都重做账号身份校验**和**每次读取都全量重扫 contact 表**，与业务无关。

| # | 瓶颈 | 类型 | 证据 | 现状 | 目标 | 预期收益 | 优先级 |
|---|---|---|---|---|---|---|---|
| 1 | 每请求 2–3 次 fresh 身份校验（Restart Manager + 全分片首页读） | B | `backend_service.py:634`、`wechat_source.py:469/267`、`live_source.py:249` | 单次「数百 ms」【文档/注释】 | 每请求 ≤1 次、TTL 内复用 ≤2 ms | `/api/messages` p95 −80~250 ms | P0 |
| 2 | 每次读取全量重扫 contact 表 | B | `wechat_source.py:547`，调用点 731/576/761/973/1277/1206 | 5k 联系人 68 ms、20k 290 ms【实测】 | <2 ms | 每 4 s 轮询省 68–290 ms | P0 |
| 3 | 历史扫描每页重复准备 contacts/分片连接/Name2Id | B | `wechat_source.py:963-1014` | 每页 60–300 ms 固定开销【推算】 | 每页 ≤5 ms | 10 万条全量扫描 −23~117 s | P0 |
| 4a | 可见窗口逐条推理（每条 1 次 `session.run`，rows=3） | A | `backend_service.py:3587→3526→3354`、`local-message-insights.ts:43`、`runner.ts:131` | 单条约 143 ms；80 条窗口（≈40 条 OTHER）≈5.7 s GPU / 24 s CPU【文档+推算】 | 单条 20–35 ms（GPU） | 3–6×（GPU）/ 1.2–1.5×（CPU） | P0 |
| 4b | 逐条 SQLite 提交（FULL sync） | A/B | `result_store.py:1066/491` | 8.8 ms/条【实测】 | 0.14 ms/条 | 40 条 ≈350 ms → <10 ms（63×） | P0 |
| 5 | 647 MB 模型 × worker，切 provider 峰值翻倍 | A | `backend_service.py:124-139`、`runner.ts:137` | 1–4 份常驻 | 恒定 1 份 | 省 0.65–1.9 GB | P1 |
| 6 | 画像元数据在任意新消息后全量重算 | B | `wechat_source.py:1271-1313` | 5 万条文本 0.5–2 s【推算】 | <50 ms | 新消息到达时不再卡顿 | P1 |
| 7 | 概览接口反序列化全部画像状态 | B | `backend_service.py:2228-2239`、`result_store.py:233` | 36 KB/会话，0.61 ms 解析【实测】 | 只读 count 列 | 50 会话 ~100 ms → <10 ms | P1 |
| 8 | worker 冷启动走 tsx 运行时转译 | A | `node_analysis.py:87` | +220 ms/进程【实测】+ 模块图 | 预编译单文件 | 冷启动 −0.5~1.5 s | P2 |
| 9 | 前端整窗重建 + 静态资源 no-store | B | `chatui/app.js:1842`、`real_http.py:147` | 变更即重建 80 节点 | keyed diff / 虚拟滚动 | 长任务归零，首屏 −30~80 ms | P2 |

**一句话结论**：把「每个请求都要证明自己是谁、并重读全部联系人」改成「按快照签名缓存」，再把「一条消息一次前向、一条消息一次 fsync」改成「一个窗口一次前向、一个窗口一次事务」，两端合计可以把打开会话到标签就绪的等待时间压到现在的 1/3 左右，同时把空闲 CPU 降到 1% 以内。

### 1.1 实施进度（本轮已落地）

| # | 状态 | 落点 | 回归 |
|---|---|---|---|
| 1 | ✅ 已实现 | `request_scope` 内 `verified_identity` 只做一次强校验；`_release_db`/`invalidate_binding` 立即失效 | `test_advisor_source_identity`（新增 2 例） |
| 2 | ✅ 已实现 | `_contacts` 按快照文件签名缓存，LRU 4 | `test_wechat_source_caches` |
| 3 | ◐ 部分 | contacts（全局缓存）+ Name2Id（按分片缓存）；每页仍会重开分片 | `test_wechat_source_caches` |
| 4a | ✅ 已实现（待真实模型复核） | `LayaAgent.predictBatch` + `analyzeMessageTargets` 批量分支 + `NodeAnalysis.analyze_targets` + `_run_fine_window_batched` | `tests/generic-labels.test.ts`、`test_real_backend.FineLabelRevisionTests` |
| 4b | ✅ 已实现 | `ResultStore.save_fine_many` / `skip_fine_many`，窗口内 8 条一批提交 | 同上 |
| 5 | ☐ 未做 | — | — |
| 6 | ✅ 已实现 | `_metadata_counts_delta`：只统计 `sort_seq >` 上次最大值的行 | `test_wechat_source_caches` |
| 7 | ✅ 已实现 | `batch_progress_v1.count` 列 + 迁移回填，概览只读该列 | `test_analysis_overview` |
| 8 | ☐ 未做 | — | — |
| 9 | ◐ 部分 | 静态资源 ETag/304 已做；前端 keyed diff / 虚拟滚动未做 | `test_real_http_control` |

**4a 的一致性保障**：批量分支显式传 `contextWindow: 3`，与逐条路径（只带 3 条前置消息的切片）构造出**完全相同**的 state 与缓存键；`tests/generic-labels.test.ts` 用同一组答案对比「逐条 predict」与「一次 predictBatch」的输出，逐字段相等。数值等价仍需在有 `model.onnx` 的机器上复跑 `scripts/laya-score-eval.ts` 复核。

---

## 2. 测量基线

### 2.1 环境与方法

| 项 | 值 |
|---|---|
| 系统 | Windows 11 x64 |
| Python | 3.13.12（`.venv`） |
| SQLite | Python 内置，`journal_mode=delete`、`synchronous=2`【实测】 |
| Node | 22.22.2（`node --import tsx`） |
| 数据 | **全部合成**，不读微信库：80 条/会话、1k/5k/20k 联系人、5000 条结果 |
| 未覆盖 | 本机无 `model.onnx`，推理耗时引用 `docs/TECHNICAL.md` §10.2 的仓库实测值 |

复现：`python scripts/run-project-python.py scripts/perf-baseline.py`（开发用，不打包）。

### 2.2 实测数据

```json
{
  "store": {
    "journal_mode": "delete", "synchronous": 2,
    "save_per_call_ms": 6.77,
    "save_fine_per_call_ms": 7.99,
    "save_fine_many_total_ms_100": 8.1,
    "save_batched_total_ms_100": 8.9,
    "save_batched_per_row_ms": 0.089,
    "has_per_call_ms": 0.90
  },
  "contacts_full_read_ms": { "1000": 12.9, "5000": 60.9, "20000": 236.4 },
  "profile_state": {
    "1000": { "state_kb": 7.5, "json_loads_ms": 0.14 },
    "5000": { "state_kb": 36.3, "json_loads_ms": 0.75 }
  }
}
```

`save_fine_many`（本轮新增）把 100 条细标签写成 8.1 ms，即 **0.08 ms/条**，相对逐条 `save_fine`（7.99 ms）约 **99×**。

补充实测（不写盘，单次）：

| 项 | 结果 |
|---|---|
| `ResultStore.__init__`（约 40 条 DDL + 迁移） | 9–16 ms，每账号一次，**不是瓶颈** |
| `node --import tsx -e 0` vs `node -e 0` | 599 ms vs 381 ms（中位数）→ tsx 约 +220 ms |
| tokenizer 编码（画像题集 13 题 / 48 选项；细标签只有 3 题） | 冷 40.5 ms，热 0.24 ms；`buildPrefix` 全量 0.63 ms；模拟每消息缓存穿透 0.38 ms |
| `JSON.stringify` 80 条消息 | 0.16 ms，载荷 55 KB |
| `keyword_counts`（jieba，单条中文） | 0.10 ms |

### 2.3 已排除的候选（不要在这上面花时间）

| 候选 | 结论 |
|---|---|
| tokenizer / prefix 构造 | 每消息 ≤0.4 ms（按最大题集 13 题测），占比 <0.3%，**不是瓶颈**（`ENCODE_CACHE_LIMIT=256` 足够覆盖题集静态串） |
| 前端 `JSON.stringify` 比对 | 0.16 ms/次，**不是瓶颈**；真正的成本在 DOM 重建 |
| jieba 关键词提取 | 0.10 ms/条，**不是瓶颈** |
| `ResultStore` 建表 | 9–16 ms/账号，**不是瓶颈** |
| 画像状态反序列化 | 0.61 ms/5000 条，**不是瓶颈**；瓶颈是「读了不该读的行数」 |

---

## 3. 瓶颈详解

### 3.1【P0】每个 HTTP 请求重复做账号身份校验

**证据链**

1. `Backend._scoped_identity()`（`backend_service.py:634`）在**每个**业务方法开头被调用，内部走 `source.verified_identity(messages=True)`。
2. `WeChatSource.verified_identity()`（`wechat_source.py:469`）→ `_db(fresh=True)` → `_active_selection(fresh=True)` → `selection_for_account(fresh=True)`（`live_source.py:249`）→ `_owned_processes(fresh=True)` → `file_owners()`（Windows Restart Manager）。
   `live_source.py:252-254` 注释自述：**「Asking Windows which process owns an account's files (Restart Manager) costs hundreds of milliseconds per account」**。
3. 即使 reader 命中缓存，`_db()` 仍调用 `_live_reader_valid()`（`wechat_source.py:267`）：`_pages()` 遍历整个 `db_storage`，**逐个 DB 文件读第 1 页 4 KB**，再对每个密钥做 `_valid_page_key()` HMAC 校验。
4. 一次 `/api/messages` 实际触发 **2–3 次**校验：
   - `Backend.messages()` 的 `_scoped_identity()`（`backend_service.py:3057`）
   - `source.messages()` 内部的 `_ordinary_db()` → `_db(fresh=True, reuse_ownership=True)`
   - 若助手已启用（`self._advisor` 非空）：`_observe_advisor_window()` → `AdvisorContext.observe_window()` 的 `_check_identity(..., fresh=True)`（`advisor_context.py:159`）
   `/api/analysis` 同理（`_scoped_identity` + 结尾 `_assert_scope` 的 fresh 校验）。
5. 轮询频率（`chatui/app.js:7209-7214`）：消息 4 s、会话 15 s、画像/建议 2.2 s、API 标签 0.4–2 s。**所有轮询都踩在这条路径上**，且校验期间持有 `source.lock`，与分析线程写结果互相阻塞。

**根因**：身份校验被设计成「每次调用都必须新鲜」，没有请求级或短 TTL 的租约；而校验里混了两件成本完全不同的事——「账号/进程归属」（RM，百 ms 级）和「快照是否变化」（`stat`，微秒级）。

**方案**

1. **请求级复用**：`request_scope()` 已存在（`wechat_source.py:192`），把首次校验结果（`binding` + 已校验时间）放进 `request_context`，同一请求内 `_scoped_identity/_assert_scope` 直接命中，不再走 `_db(fresh=True)`。
2. **短 TTL 租约**：复用已有的 `_leased_advisor_identity()` 模式（`wechat_source.py:507`，`ADVISOR_IDENTITY_LEASE_SECONDS`）。键取 `(account, workdir, binding.generation)`，TTL 1.5–2 s；`invalidate_binding()`、账号切换、pin 变更、`reset_ownership_cache()` 时立即失效。
3. **拆分校验成本**：`_live_reader_valid` 先比 `(st_mtime_ns, st_size, st_ctime_ns)` 快照签名；签名不变直接返回，**不读页、不做 HMAC**。页级校验只在签名变化或显式 `retry=1` 时执行。

**目标与预期收益**

| 指标 | 现状 | 目标 |
|---|---|---|
| 单次身份校验 | 百 ms 级（RM + 全分片页读） | 稳态 ≤2 ms |
| 每请求校验次数 | 2–3 | 1 |
| `/api/messages` p95 | 未测（需真实微信库） | ≤60 ms |

【推算】按代码注释的「数百 ms」取 100–300 ms，去掉重复校验可让每个轮询周期省 100–250 ms；换算到 4 s 周期，空闲 CPU 下降 2.5–6 个百分点。

**验证方式**

- 在 `_scoped_identity`、`_live_reader_valid` 加 `perf_counter` 打点，输出到 `/api/analysis-performance` 的新字段 `identityMs`、`identityCount`。
- 压测：连续 200 次 `GET /api/messages`，取 p50/p95；改造前后对比。
- 回归：`bridge/test_live_source.py`、`bridge/test_account_pin_source.py`、`bridge/test_account_leases.py`；额外用例断言「账号切换后 1 次请求内必须失效」。

---

### 3.2【P0】每次读取都全量重扫 contact 表

**证据**

- `WeChatSource._contacts()`（`wechat_source.py:547`）无任何缓存：`SELECT username,nick_name,remark,small_head_url,big_head_url FROM contact`，逐行 `avatar_candidates()` + 建 dict。
- 调用点：`messages()`（731）、`sessions()`（576）、`message_windows()`（761）、`history_page()`（973）、`profile_metadata()`（1277）、`stats()`（1206）。
- 【实测】合成表：1k 行 15 ms、5k 行 68 ms、20k 行 290 ms（不含 SQLCipher 页解密，真实环境更高）。

**根因**：联系人被视为「随手可读的小表」，但它是**每个请求都要用的全表数据**，且成本随账号规模线性增长。

**方案**（按收益/风险排序）

1. **按快照签名缓存**：`contact.db` 的签名已有现成实现（`snapshot_cache._stamp_details`，含 mtime/size/WAL）。缓存 `{username: {name, avatar, avatarCandidates}}`，LRU 上限 4 个账号，命中即返回（<1 ms）。
2. **按需查询**（更彻底）：只查当前窗口/成员/会话涉及的用户名，`WHERE username IN (...)`。80 条消息最多几十个用户名，成本与账号规模解耦。
3. 两者可并存：按需查询为主，全量缓存给「群成员列表」这类确实需要全表的场景。

**目标与预期收益**

| 指标 | 现状 | 目标 |
|---|---|---|
| 单次联系人读取 | 15–290 ms | <2 ms（缓存命中）/ <5 ms（按需查询） |
| 每 4 s 轮询的固定成本 | 68–290 ms | ≈0 |

**验证方式**

- 单测：用 fake db 统计 `_open("contact.db")` 次数，断言「同一快照连续 10 次 `messages()` 只打开 1 次」。
- 指标：`contactLoadMs`、`contactLoadCount`。
- 回归：`bridge/test_real_backend.py` 中联系人/头像相关用例。

---

### 3.3【P0】历史扫描每页重复准备

**证据**：`WeChatSource.history_page()`（`wechat_source.py:963-1014`）每页（默认 256 条）都做：

1. `_contacts(db)` —— 全表（见 3.2）
2. `self_user(db)` —— `get_self_info()`
3. `db._msg_conns(user)` —— **打开全部分片**
4. 每个分片 `SELECT rowid,user_name FROM Name2Id` —— 全表
5. 再执行分页 SQL + 合并排序 + 逐行渲染（`_render_row`：解码、`ElementTree` 解析引用、sha256、base64 游标）

**推算**：10 万条消息 / 256 = 391 页；按 5k 联系人 68 ms + 2 分片 × 3 ms ≈ **74 ms/页固定开销 → 约 29 s**，全部与消息内容无关。

**方案**：引入「扫描会话」对象（`scan = source.begin_scan(user)`），一次性持有 contacts、own_user、分片连接、`sender_index`，`history_page` 接受该对象；`_history_pages()`（`backend_service.py:3405`）与 `BatchEngine.incremental/reconcile` 改为传 scan。快照签名变化时自动重建。

**目标与预期收益**

| 指标 | 现状 | 目标 |
|---|---|---|
| 每页固定开销 | 60–300 ms | ≤5 ms |
| 10k 条扫描（40 页） | 2.4–12 s | <0.5 s |
| 100k 条扫描（391 页） | 23–117 s | <2 s |

**验证方式**：用 10k/50k 条夹具跑 `_run_all_history`，对比总耗时与 `batchRequestMs`；指标 `scanOverheadMs`；回归 `bridge/test_live_source.py`、`bridge/test_api_insights.py` 中的分页/游标用例。

---

### 3.4【P0】可见窗口：逐条推理 + 逐条提交

这是用户感知最强的一条：**打开一个会话，标签要等多久**。

**证据链**

1. `_run_visible_priority()`（`backend_service.py:3587`）在有 `batch_engine` 时直接转 `_run_fine_recent()`（3526）。
2. `_run_fine_recent()` 对窗口内**每条** OTHER 文本调用 `_analyze_fine_item()`（3449）→ `_analyze_item()`（3354）→ `analyzer.analyze(session, context, item.id, messageLabelsOnly=True)`。
3. Node 侧 `analyzeMessageTargets()`（`analysis.ts:920`）对每个 target 单独 `classifyMessage()`（579）；`messageLabelsOnly` 分支走 `generateFineMessageInsight()`（`local-message-insights.ts:43`），题集是 `{...ANALYSIS_QUESTIONS, ...FINE_DISPLAY_QUESTIONS, intent}`，**只有 3 题** → 一次 `predict` = **1 次 `session.run`（rows=3）**，没有 detail 路由。
4. `runner.run()` 用 `runTail` 严格串行（`runner.ts:131`），每次 rows 恒为 3。单次前向 WebGPU ≈143 ms、CPU ≈611 ms【文档】→ 单条 0.14 s / 0.61 s。一个 80 条的可见窗口里约一半是 OTHER 文本（另一半是 self 与非文本），即 **≈40 条需推理 → 约 5.7 s GPU / 24 s CPU**。
5. 对照：历史/画像路径走 `analyzeMessageBatch()`（`analysis.ts:634`）把整个窗口打包进一个 state，每窗口只跑 4–6 次 run（主批 13 题按 `BATCH_SIZE=8` 拆 2 次；intent/emotion 各 1–2 次级联 detail，top-1 ≥0.65 时只跑 1 次），窗口约 8–25 条 → **约 25–105 ms/条（多数情况 4 次 run）**。也就是说，可见窗口这条路径的单条成本是打包路径的 **1.5–5 倍**，差距全部来自「一条消息一次 run」。
6. 每条结果独立落库：`_analyze_item` 在 `with self._scope_commit(scope)` 内调用 `store.save_fine()`（`backend_service.py:3385-3387`），而 `_scope_commit` 持有 `source.lock`。
7. 【实测】单行提交 8.8 ms（`journal_mode=delete`、`synchronous=FULL`）；100 行一个事务只要 13.9 ms（**0.14 ms/行，63×**）。40 条 OTHER → **约 350 ms 纯 fsync，且全程阻塞读路径**。

**根因**：推理的并行度只做在「题」这一维（rows=3），没做在「消息」这一维；持久化粒度是「条」，不是「窗口」。GPU 在 rows=3 时几乎空转，固定开销全被摊在单条消息上。

**方案**

**a. 跨消息行合并（收益最大，改动最大）**
同一题集、不同 state 的行合成一次 `session.run`（rows = 消息数 × 3），一次请求提交整个窗口的 targetIds：

```
40 条 × 3 题 → 合并成 5 次 run（rows=24），而不是 40 次 run（rows=3）
```

落点：`analysis.ts` 新增 `analyzeMessageTargetsBatched()`（复用 `agent.prepare` + `collate`，只是把多条消息的 `PreparedItem` 拼进同一个 batch），`analysis_server.ts` 增加对应命令；`_run_fine_recent` 改为一次提交整个窗口的 targetIds。数值上必须与逐条一致（同一 padding/attention mask 语义）。若首版只想改 Python 侧，可先让 `_analyze_item` 一次传多个 targetId（减少 IPC 往返），再逐步下移到 runner。

> **2026-11-07 实测更正**：跨消息行合并的收益被高估，且不是数值无损的。在同一 ONNX 图上用
> 120 条 `relationship` 单题做 A/B：WebGPU 逐行 15.7~20.0 s（120 次 run），16 行/批
> 10.4~11.9 s（8 次 run），仅 1.3~1.9×，且 **3/120 分类结果变化、最大概率差 0.103**；
> CPU 逐行 54.0 s、批量 71.5 s（0.76×，更慢）。`predictBatch(rows=1)` 与逐条 `predict`
> 完全一致（0 mismatch / 0 delta），说明差异来自 batch 内 padding 到最长序列，不是切片实现。
> 因此 §1.1 #4a 的窗口合并路径如用于正式标签，必须重做真实模型的数值等价性复核，
> 不要直接引用本节「4~7×」的推算。训练脚本已默认保持逐行，详见
> `docs/laya-scoring-calibration.md` §7.1。

**b. 窗口级批量提交（低风险，先做）**
新增 `ResultStore.save_fine_many(rows)`：单事务、`executemany`，并把 `keyword_counts` 与 summary 增量计算移到事务内一次完成；`_analyze_item` 增加 `defer` 分支（已有该模式，见 `_analyze_item` 的 `defer=True` 用法）暂存结果，窗口结束统一提交。提交移出 `_scope_commit` 的 fsync 临界区。

**c. 顺手清理**：`_run_visible_priority` 的非 batch 分支用 `store.has()` 逐条查（`backend_service.py:3610`，1.13 ms/条），改为一次 `store.ids()` 取集合。该分支生产环境不会走到（恒有 `batch_engine`），建议直接删除以免误导。

**目标与预期收益**

| 指标 | 现状 | 目标 | 依据 |
|---|---|---|---|
| 单条推理（GPU，fine 路径） | 143 ms | 20–35 ms | rows 3→24，固定开销摊薄 8×，按次成本涨 1.3–1.8×【推算】 |
| 40 条 OTHER（GPU） | ≈5.7 s | 0.8–1.4 s | 4–7× |
| 40 条 OTHER（CPU） | ≈24 s | 16–20 s | 计算受限，1.2–1.5× |
| 落库（40 条） | ≈350 ms | <10 ms | 【实测】63× |
| 写锁占用 | 每条 8.8 ms | 每窗口 <20 ms | 读路径不再被 fsync 阻塞 |

**验证方式**

- 微基准：`runner.run` 固定输入，rows = 3/12/24/48 各 20 次，输出 `ms/row` 曲线，确认合并确实摊薄固定成本。
- 一致性：固定 200 条中文夹具，逐条结果 vs 合并结果逐字段比对；affinity/MBTI/六维允许 ≤1 分差异（`docs/TECHNICAL.md` §10.2 已有 WebGPU/CPU 差 1 分的先例）。跑 `tests/laya-scoring-calibration.test.ts`。
- 指标：`/api/analysis-performance` 已有 `modelMs`、`requestMs`、`verifyMs`、`saveMs`、`betweenMs`；新增 `batchRows`、`saveBatchMs`。
- 验收：80 条窗口（≈40 条 OTHER）标签就绪 ≤2 s（WebGPU，i5/RTX3060 级），`saveMs` 总和 <10 ms。

---

### 3.5【P1】本地模型内存随 worker 线性增长

**证据**：`analysis_worker_settings()`（`backend_service.py:78-100`）默认 1、上限 4；`__init__` 为每个 worker 建一个 `NodeAnalysis`（独立 Node 进程 + 独立 ONNX session），模型 647 MB/份；`runner.ts:137-151` 在 provider 回退/切换时**新旧 session 共存**后才释放旧的。

**根因**：用「多进程复制模型」换并行度，而并行度本可以在单进程内用 rows 维度拿到（见 3.4a）。

**方案**：默认保持 1 worker；靠 3.4a 提升单 worker 吞吐；`configure_runtime` 改为「先建新 session 探针通过 → 再 release 旧 session」，或串行化并在 UI 显示「切换中」；`/api/analysis-workers` 增加 `rssMiB`。

**目标**：常驻内存恒定 ≈647 MB + ORT arena（实测口径：`Process.WorkingSet64` 增量），不再随 worker 数线性增长；切换 provider 峰值不超过 1.5×。

**验证**：任务管理器 / `psutil` 采样 60 s，记录 `rssMiB` 曲线；`bridge/test_real_backend.py` 中 worker 设置用例。

---

### 3.6【P1】画像元数据在任意新消息后全量重算

**证据**：`profile_metadata()`（`wechat_source.py:1271-1313`）缓存键是「每个分片的 `(st_mtime_ns, st_ctime_ns, st_size)`」。**任意一条新消息**都会改变签名 → 重新执行：

- 每分片 `SELECT real_sender_id,COUNT(*) ... GROUP BY real_sender_id`
- `_analyzable_counts()`：遍历该会话**全部** type=1/49 的行，逐行 `_friendly_content()`（utf-8 解码 / zstd 解压）+ `classifier()` 判定

**推算**：5 万条文本 ≈ 0.5–2 s，且整个过程持有 `self.lock`，期间 `/api/messages`、`history_page` 全部排队。触发时机恰好是「对方刚发来消息」——最不该卡的时刻。

**方案**：增量计数。持久化 `(max_sort_seq, per_sender_counts, text_count)`；签名变化时只统计 `sort_seq > max_sort_seq` 的新行，累加后写回。落点：`WeChatSource` 新增 `_metadata_counts` 表（或复用 `ResultStore` 的库），键 `(account, user, 分片)`。

**目标**：新消息到达后 `profile_metadata` ≤50 ms（与历史规模无关）。

**验证**：夹具 5 万条，插入 1 条新消息后计时；对比改造前后。指标 `metadataMs`。回归：群成员列表、`/api/profile` 的 `count/textCount` 必须与全量扫描一致（同一夹具双算对比）。

---

### 3.7【P1】概览接口反序列化全部画像状态

**证据**：`analysis_overview()`（`backend_service.py:2214`）→ `store.analysis_progress_rows()`（`result_store.py:233`）取出该账号**所有** `batch_progress_v1.state_json`，再逐行 `json.loads(...).get("count")`（2237）。状态里含 `emotion/intent/broad/words`，随历史增长。

**实测**：5000 条消息的 state ≈36 KB、`json.loads` 0.61 ms。50 个会话 → 约 1.8 MB 读取 + 30 ms 解析，每 60 s 一次。

**方案**：`batch_progress_v1` 增加 `count INTEGER` 列（沿用现有 `PRAGMA table_info` + `ALTER TABLE` 迁移模式），`commit` 时同步写入；概览只 `SELECT count`。

**目标**：`/api/analysis-overview` p95 ≤10 ms（50 会话）。

**验证**：50 会话夹具计时；断言迁移后旧库可读（新增迁移用例）。

---

### 3.8【P2】worker 冷启动走 tsx 运行时转译

**证据**：`NodeAnalysis._launch_locked()`（`node_analysis.py:87`）固定 `node --import tsx bridge/analysis_server.ts`。tsx 在运行时转译整棵 TS 依赖树（`analysis_server.ts` → `analysis.ts` → `laya/*`）。

**实测**：`node --import tsx -e 0` 599 ms vs `node -e 0` 381 ms，**空转即多 220 ms**；加上模块图转译，实际启动更多。

**方案**：打包期用已有依赖 esbuild 把 `analysis_server.ts` 打成单文件 ESM（`dist/analysis_server.mjs`），运行时 `node dist/analysis_server.mjs`；开发路径保留 tsx。需同步 `scripts/stage-real-client.py` 白名单与 `electron-builder.real-client.json`。

**目标**：worker 冷启动（不含模型加载）−0.5~1.5 s；4 worker 场景省 2–6 s。

**验证**：从 `Popen` 到握手 `{"ready":true}` 打点（`node_analysis._read` 已有握手处理），输出 `workerStartMs`；对比改造前后 10 次中位数。

---

### 3.9【P2】前端整窗重建与静态资源

**证据**：

- `renderMessages()`（`chatui/app.js:1842`）用「每条消息两次 `JSON.stringify` + `querySelectorAll(".msg-item")`」判断 appendOnly；不满足就 `replaceChildren(fragment)` 重建整窗（1849-1871）。无虚拟滚动（`docs/TECHNICAL.md` §10.2）。
- 轮询每次 `loadMessages` 后还会 `renderSessions()`（侧栏全量遍历）与 `loadAnalysis()`（第二个重接口）。
- `real_http.py:147` 对**所有**响应（含 `chatui/*.js`）设 `Cache-Control: no-store`，静态文件每次 `target.read_bytes()` 读盘。

**实测**：`JSON.stringify` 80 条仅 0.16 ms —— **序列化不是问题**，成本在 DOM 重建与布局抖动（`getBoundingClientRect` 在锚点查找中逐节点调用）。

**方案**

1. keyed diff：按 `id` 复用节点，只更新变化的字段（标签、状态），不再整窗替换。
2. 窗口 >200 条启用虚拟滚动（只渲染可视区 ±1 屏）。
3. `/api/messages` 返回轻量 `revision`（消息数 + 最大 `_sort` 的哈希）；未变化时前端跳过 `renderMessages`。
4. 静态资源加 `ETag`（mtime+size）+ 304；`/api/*` 保持 `no-store`。

**目标**：200 条窗口轮询渲染 <5 ms，无 >50 ms 长任务；二次启动首屏 −30~80 ms。

**验证**：DevTools Performance 录 60 s，统计 `Task >50ms` 次数；`performance.measure("renderMessages")` 打点；Lighthouse 首屏对比。

---

## 4. 实施路线

| 阶段 | 内容 | 风险 | 状态 |
|---|---|---|---|
| **1（低风险）** | 3.4b 批量提交、3.2 联系人缓存、3.7 count 列、3.9 静态 ETag | 低 | ✅ 已完成 |
| **2（中风险）** | 3.1 请求级复用、3.6 增量元数据、3.3 contacts+Name2Id 复用 | 中（账号切换语义） | ✅ 已完成；3.3 的分片探测部分未做 |
| **3（高风险）** | 3.4a 跨消息行合并 | 中高（数值一致性） | ✅ 代码与等价性测试完成，待真实模型复核 |
| **3b** | 3.5 内存收敛（切 provider 时先释放旧 session） | 中 | ☐ 未做 |
| **4（按需）** | 3.8 预编译、3.9 前端 keyed diff / 虚拟滚动 | 低 | ☐ 未做 |

**3.1 的取舍（重要）**：`bridge/test_advisor_source_identity.py` 明确要求 `verified_identity` 每次调用都做一次强校验（`test_default_verified_identity_is_still_fresh_for_every_call`），所以没有引入跨请求 TTL，只做**请求级复用**：同一 HTTP 请求内 2–3 次强校验合并为 1 次。跨请求的 RM 成本仍存在，若要进一步压缩，只能改这条不变量并同步改测试。

**3.4a 的一致性保障**：批量分支固定 `contextWindow: 3`，与逐条路径（只带 3 条前置消息的切片）构造出完全相同的 state 与缓存键；`tests/generic-labels.test.ts` 用同一组答案对比两条路径，逐字段相等。真实数值仍需在有 `model.onnx` 的机器上用 `scripts/laya-score-eval.ts` 复核。

---

## 5. 度量与验收

### 5.1 需要新增的打点

| 指标 | 位置 | 含义 |
|---|---|---|
| `identityMs` / `identityCount` | `_scoped_identity`、`_live_reader_valid` | 每请求身份校验成本与次数 |
| `contactLoadMs` / `contactLoadCount` | `_contacts` | 联系人读取 |
| `scanOverheadMs` | `history_page` | 每页固定开销 |
| `metadataMs` | `profile_metadata` | 画像元数据 |
| `saveMs` / `saveBatchMs` | `_analyze_item`、`save_fine_many` | 落库 |
| `workerStartMs` | `NodeAnalysis._launch_locked` | 冷启动 |
| `renderMs` / `longTasks` | `chatui/app.js` | 前端 |

已有 `/api/analysis-performance` 返回 `modelMs/requestMs/verifyMs/saveMs/betweenMs` 与 `batchModelMs/batchTexts`，新指标并入同一响应即可，无需新建看板。

### 5.2 验收阈值（建议）

| 场景 | 阈值 |
|---|---|
| `/api/messages` p95（5k 联系人，80 条窗口） | ≤60 ms |
| `/api/sessions` p95 | ≤80 ms |
| 80 条窗口（≈40 条 OTHER）标签就绪（WebGPU） | ≤2 s |
| 1 万条历史全量分析（WebGPU） | ≤6 min |
| 空闲 CPU（窗口可见、无任务） | ≤1% |
| 常驻内存（1 worker） | ≤900 MB |
| 前端轮询长任务（>50 ms） | 0 |

### 5.3 回归清单

- `npm run typecheck`、`npm run test:node`（基线 793 例起，需全绿）、`npm run test:python`
- 关键：`tests/laya-scoring-calibration.test.ts`（打分口径）、`bridge/test_live_source.py`（账号/快照）、`bridge/test_real_backend.py`（接口契约）、`tests/message-picking.test.cjs`（手选分析）
- 数值一致性：固定 200 条夹具，逐条 vs 合并推理逐字段比对

---

## 6. 风险与注意事项

1. **身份校验缓存会让「账号切换/退出登录」晚 1.5–2 s 被发现**。必须由 `binding.generation`、`reset_ownership_cache()`、账号 pin 变更立即失效，并保留 `retry=1` 强制刷新路径；UI 侧已有 `handleAccountBoundaryError` 兜底。
2. **行合并推理改变 batch 形状**，padding/attention mask 必须严格等价，否则亲和度会漂移。先做 rows=12（4 条消息）的小规模对比，再放开到整窗。
3. **批量提交在崩溃时丢一个窗口的结果**。用单事务 + 已有 `batch_coverage_v1` 幂等索引重算；不要把「已提交」写进内存状态。
4. **联系人缓存必须绑定快照签名**，否则会出现「改名后仍显示旧昵称」。签名变化立即重建，与 `snapshot_cache` 的 stamp 保持同一口径。
5. **不要顺手改 `journal_mode=WAL`**：收益主要在 `synchronous`，而 WAL 会改变 `-wal` 文件的清理与备份逻辑（`_ensure_payload_backup` 依赖一致性快照）。批量化已经能拿到 63× 收益，不必动持久化模式。
6. **文档口径**：`docs/TECHNICAL.md` §10.2 的 143 ms/611 ms 是「同一进程内交替、28 条消息 / 172 次 run」的实测，改完推理粒度后必须重新测一遍，不要沿用旧数字做对比。

---

## 附录 A：复现方式

```bash
# 微基准（合成数据，不读微信库）
python scripts/run-project-python.py scripts/perf-baseline.py

# 打分回归
node --import tsx scripts/laya-score-eval.ts

# 全量测试
npm test
```

基准脚本覆盖：`ResultStore` 单条 vs 批量提交、contact 全表读取（1k/5k/20k）、画像状态体积与反序列化。推理侧数字需要本机有 `.models/laya/model.onnx`（`npm run setup:models`），本报告未包含该部分的新实测。
