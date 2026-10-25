# 交接文档：聊天助手「历史会话」功能

> 交接时间：2026-10-24 23:55　|　分支：`perf/optimize-tokenizer`　|　HEAD：`98e012a`
> 下一个 Agent 请先读这份，再读 `.workbuddy-ai/memory/2026-10-24.md` 当日日志（有更细的踩坑记录）。

---

## 1. 一句话目标

用户要的是**历史会话**：在聊天助手里能翻出以前和**当前联系人**聊过的几段对话，点一下就能切回去继续聊。
**不是**「记忆」——之前误实现的「自动把此前对话塞进新上下文」已按要求全部拆掉。

## 2. 用户原话（避免再次理解偏）

1. 「新增一个可以选择历史聊天记录的按钮，并实现该功能。」
2. 「不是选择，是记忆。」
3. 「我说的记忆是指记住之前的聊天记录，而不是让AI记住。」
4. 「我不是要记忆功能，我是要历史会话功能，你再改一下。」

→ 结论：要一个**可浏览、可切换**的会话历史列表；不要 AI 自动提炼、不要自动注入上下文。

## 3. 当前进度

### 3.1 已完成且已入库（commit `c9a14d8`「chore: 同步并发会话的助手与存储改动」）

**存储层** `bridge/advisor_store.py`
- `AccountDatabase.list_threads(user, agent_id, limit=MAX_HISTORY_THREADS)`（约 750 行）：一条 SQL 取每个线程的 `id / created_at_ms / updated_at_ms / message_count / title（首条用户消息）/ preview（末条消息）/ preview_role`，按 `updated_at_ms DESC` 排序。`title`、`preview` 已过 `_open_row` 解密。

**服务层** `bridge/advisor_service.py`
- `threads(account, user, agent_id)`（约 432 行）：返回 `{threads:[{id,title,preview,previewRole,messageCount,createdAtMs,updatedAtMs}]}`，标题/预览走 `single_line(..., 60, True)`。
- `thread(account, user, agent_id, thread_id=None)`：新增可选 `thread_id`；校验通过后按 id 取线程，**归属不符（user/agent 不匹配）一律当不存在**，抛 `thread-unknown`；不传时保持原行为（取最新，没有就新建）。

**HTTP** `bridge/advisor_http.py`
- `GET_PATHS` 增加 `/api/advisor/threads`；`/api/advisor/thread` 增加可选 `threadId` 查询参数。
- `bridge/real_http.py` 无需改（它按 `advisor_http.GET_PATHS` 放行）。

**常量** `bridge/advisor_contracts.py`：`MAX_HISTORY_THREADS = 50`。

### 3.2 已完成但在工作树未提交（`git status` 可见 3 个文件）

| 文件 | 内容 |
|---|---|
| `chatui/advisor-frame.html` | 输入栏左侧新增 `.advisor-history-control`：`#btnHistory`（时钟图标 + 「历史」）+ `#historyMenu` 容器，放在「新建」和模型胶囊之间 |
| `chatui/advisor-frame.js` | `threads/activeThreadId` 状态；`formatThreadTime()`（今天/昨天/月日/年月日）；`renderThreads()`（空态「还没有历史会话」；行内含标题、`时间 · N 条消息`、`助手：`前缀预览；当前行 `is-active` + `aria-current`）；`openHistoryMenu()/closeHistoryMenu()`；按钮点击/方向键/点外部/Escape 关闭；行点击发 `ADVISOR_OPEN_THREAD {threadId}`；开菜单时发 `ADVISOR_HISTORY_REQUEST` 拉最新列表；入站校验 + `ADVISOR_SET_THREADS` 处理；`renderThread` 里线程变化时同步高亮 |
| `chatui/advisor.js` | `loadThread(scope, threadId)` 支持按 id 加载；`openThread(threadId)`（切线程前 `generation++` + `abortCurrentPoll()`，和切换联系人一样先停掉生成）；`loadThreads(scope)`（GET `/api/advisor/threads` → `postToFrame("ADVISOR_SET_THREADS", {threads, activeThreadId})`）；`validThreadSummary()`；`ADVISOR_OPEN_THREAD` 入站白名单 + 分发；`newThread` 成功和 `onSessionChanged` 后刷新列表；`historySerial` 防乱序 |

### 3.3 「记忆」残留清理状态

实现层已删干净（frame html/js/css、host、`advisor_http`、`advisor_service`、`advisor_contracts`、`advisor_store.recent_contact_turns`），全局搜不到 `memoryPreference / MEMORY_TURNS / btnMemory` 的生产代码。
**但测试里还留着 4 处**（见待办第 1 条）。

## 4. 待办（按优先级）

### P0-1　清掉记忆残留测试（现在就是红的）
1. `tests/advisor-ui.test.cjs:94` —— `frame()` 的 id 列表里还有 `"btnMemory", "memoryLabel"`，**把这两个换成 `"btnHistory", "historyMenu"`**。
2. `tests/advisor-ui.test.cjs:650-670` —— 整条 `the memory chip is on by default and travels with the message` 删掉，改写成历史菜单用例（见 P0-3）。
3. `tests/advisor-ui.test.cjs:675` `the host sends the memory flag to the run endpoint` 删掉。
4. `tests/advisor-ui.test.cjs:685` `a non-boolean memory flag is rejected before any request` 删掉。
5. `bridge/test_advisor_store.py:236` `test_recent_contact_turns_carries_other_conversations_only` 删掉（方法已不存在，现在必 ERROR）。

### P0-2　宿主漏了一个消息类型（功能不完整）
`chatui/advisor.js` 的 `validFrameRequest` 的 `allowed` 表里**还没有 `ADVISOR_HISTORY_REQUEST`**，帧一发就被静默丢掉——表现为点「历史」菜单永远是旧数据/空。
需要：`allowed` 加 `ADVISOR_HISTORY_REQUEST: []`，并在分发处加 `else if (type === "ADVISOR_HISTORY_REQUEST") void this.loadThreads();`。

### P0-3　主进程白名单（历史教训：漏了就是静默失败）
`scripts/advisor-companion.cjs` 的 `INBOUND` / `OUTBOUND` 都要加：
- `INBOUND` += `ADVISOR_OPEN_THREAD`、`ADVISOR_HISTORY_REQUEST`
- `OUTBOUND` += `ADVISOR_SET_THREADS`
加完在 `tests/advisor-companion.test.cjs` 里补一条双向用例（照抄 `new conversation crosses the native bridge...` 那条的写法）。

### P0-4　历史菜单的 CSS（一行都没写）
`chatui/advisor.css` 目前没有任何 `.advisor-history-*` 规则，菜单会是未定位的块级元素。参考已有的 `.advisor-model-control` / `.advisor-model-menu` 写法：
- `.advisor-history-control { position: relative; min-width: 0; flex: none; }`
- `.advisor-history-btn` 与 `.advisor-new-thread` 同款胶囊（26px 高、13px 圆角、12px 字），图标 12px 描边
- `.advisor-history-menu`：`position: absolute; bottom: calc(100% + 8px); left: 0; width: 280px; max-height: 320px; overflow: auto;` 加边框/阴影/圆角，亮色主题用白底
- `.advisor-history-row`：块级按钮、左对齐文字、`is-active` 用绿色边或浅绿底；`.advisor-history-title` 单行截断；`.advisor-history-meta` / `.advisor-history-preview` 用 muted 小字号；`.advisor-history-empty` 居中 muted
- 深色主题：跟随 `body.theme-dark` 覆盖（参考 `.advisor-model-menu` 的 dark 分支）

### P1-5　补测试
- **Python**：`bridge/test_advisor_store.py` 加 `list_threads` 用例（多线程排序、title/preview 解密、limit、空列表）；`bridge/test_advisor_service.py` 加 `threads()` 与 `thread(thread_id=...)` 用例（含跨 user/agent 归属拒绝）；`bridge/test_advisor_http.py`（若有）补 GET `/api/advisor/threads`。
- **Node**：`tests/advisor-ui.test.cjs` 加
  - 点「历史」→ 发 `ADVISOR_HISTORY_REQUEST`，菜单渲染出标题/时间/条数/预览，当前会话高亮；
  - 点某行 → 发 `ADVISOR_OPEN_THREAD {threadId}`，非当前行才发；
  - `ADVISOR_SET_THREADS` 非法载荷被拒；
  - 宿主 `openThread` 会带 `threadId` 请求 `/api/advisor/thread` 并同步给帧，且会停掉旧轮询。
- 参考命令见第 6 节。

### P1-6　文档
- `docs/advisor.md`：**删掉**「## 带入此前的对话」整节；把「## 加密落盘」保留；新增「## 历史会话」节（入口位置、列表内容、点回去继续聊、切换会停掉当前生成、按联系人+助手分别记录）。
- `docs/TECHNICAL.md`：删掉「带入此前的对话」那条，换成「历史会话」：`GET /api/advisor/threads`、`thread(thread_id)` 归属校验、`ADVISOR_OPEN_THREAD / ADVISOR_HISTORY_REQUEST / ADVISOR_SET_THREADS` 三层流向、`MAX_HISTORY_THREADS=50`。
- `CHANGELOG.md`「未发布 → 新增」：删掉「带入此前的对话」条目，改成「历史会话」。

### P2-7　可选的产品决策（做之前先问用户）
- 历史列表现在按「账号 + 联系人 + 助手」隔离。用户是否想跨联系人看全部会话？
- 每条历史是否需要「删除」入口（目前只能看和切换）？
- `newThread` 后自动刷新列表那次 GET 是否保留（菜单打开时本来就会刷新，属冗余请求；保留则 P1-5 的用例要一并覆盖）。

## 5. 已定型的实现约定（照这个走，别改歪）

1. **消息四层白名单**：主进程 `scripts/advisor-companion.cjs` 的 `OUTBOUND`/`INBOUND` → 宿主 `chatui/advisor.js` 的 `validFrameRequest().allowed` → 帧内 `advisor-frame.js` 的 `validPayload` → 实际处理分支。漏一层就是静默失败，测试还全绿。
2. **归属校验**：历史会话按 `user + agent_id` 取，`thread(thread_id)` 必须校验 `row["user"]/row["agent_id"]`，否则能翻到别人的会话。
3. **切线程前必须停生成**：`generation++` + `abortCurrentPoll()`，和 `onSessionChanged` 一致。
4. **文本列一律过 `_seal/_open_row`**：`title/preview` 也是密文，忘了 `_open_row` 菜单会显示 `wv1:...`。
5. **帧内 `localStorage`/`document.addEventListener` 在测试桩里是空实现**，新增 DOM 事件处理要容忍（用 `?.`），并且新元素 id 必须登记进 `frame()` 的 id 列表，否则 38 条测试一起红。
6. **行尾**：`chatui/*.js` 会被 Windows 编辑器存成 CRLF 而 Git 索引是 LF（`git status` 干净）。按多行源码模式断言的测试要先 `.replace(/\r\n/g, "\n")`（`tests/ai-busy-status.test.cjs` 已这么改）。
7. **并行会话**：这个工作区有别的 Agent 在改同一批文件（`chatui/app.js`、docs、Start.bat）。动手前 `git status` / `git log --oneline -3`；他们会在整点把工作树一次性提交（`42d0016`、`c9a14d8`、`98e012a` 都是这么来的），你的半成品会被并进去，别指望 `git status` 一直干净。

## 6. 验证命令与当前基线

```bash
# Node（当前 811 例基线；本次改完应 ≥ 811 且全绿）
npm run test:node

# Python：advisor 相关（除已知环境失败外应全绿）
.venv/Scripts/python.exe scripts/run-python-tests.py --only advisor

# 单个文件
node --test tests/advisor-ui.test.cjs tests/advisor-companion.test.cjs
.venv/Scripts/python.exe -u bridge/test_advisor_store.py
```

**当前基线（交接时刻）**：
- `tests/advisor-ui.test.cjs`：76 例，**38 通过 / 38 失败**。失败同源，三个原因：
  1. 35 例 `Cannot read properties of null (reading 'addEventListener')` —— `frame()` id 列表没有 `btnHistory/historyMenu`（P0-1）；
  2. 1 例 `reset command only resets agent thread...` 的 `fetchJson` 桩只 return `{thread, run}`，接不住 `newThread` 里新增的 `/api/advisor/threads` 请求（把返回改成按 url 分流即可）；
  3. 2 例 `服务返回无效数据` —— 同上，桩对 `/api/advisor/threads` 返回了 catalog，宿主判非法后发了 problem。
- `bridge/test_advisor_store.py`：`test_recent_contact_turns_*` 1 例 ERROR（P0-1）。
- 已知与本次无关的环境失败：`test_account_rejects_reparse_components`、`test_account_store.py::test_resolved_alias_still_rejects_reparse_paths`（本机 junction 可穿越，HEAD 上同样失败）。

## 7. 验收标准

1. `npm run test:node` 全绿（≥ 当前用例数）。
2. `.venv/Scripts/python.exe scripts/run-python-tests.py --only advisor` 除两个 junction 环境用例外全绿。
3. 手动：选一个聊过的联系人 → 打开助手 → 点「历史」→ 出现该联系人的历史会话（标题/时间/条数/末条预览）→ 点较早的一条 → 对话区切回那段、可继续发消息 → 当前项高亮 → 点「新建」开新对话 → 历史里出现新的一段。
4. 深色主题下菜单可读（第 4 条 CSS 的 dark 分支）。
5. 加密落盘功能未受影响（`bridge/test_advisor_store_crypto.py` 6 例仍全绿）。
