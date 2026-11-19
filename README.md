# WechatVibe（nizitao 的个人 fork）

上游仓库：[tswawa/WechatVibe](https://github.com/tswawa/WechatVibe)。

本 fork 在上游 **v1.3.6** 的基础上（`perf/optimize-tokenizer` 已依次合并上游 1.3.0 与 1.3.6），
放进了我们自己提给上游的修复和一套自用改动，方便自己构建、也给朋友用。
上游的功能说明、下载安装、隐私与免责声明请以上游仓库为准。

[![最新版本](https://img.shields.io/github/v/release/tswawa/WechatVibe?label=release)](https://github.com/tswawa/WechatVibe/releases/latest)
[![Release 累计下载量](https://img.shields.io/github/downloads/tswawa/WechatVibe/total?style=flat&logo=github&label=downloads)](https://github.com/tswawa/WechatVibe/releases)
[![GitHub Stars](https://img.shields.io/github/stars/tswawa/WechatVibe?style=flat&logo=github)](https://github.com/tswawa/WechatVibe/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/tswawa/WechatVibe?style=flat&logo=github)](https://github.com/tswawa/WechatVibe/forks)
[![GitHub Issues](https://img.shields.io/github/issues/tswawa/WechatVibe?style=flat&logo=github)](https://github.com/tswawa/WechatVibe/issues)
[![Windows 10/11](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)](#运行要求)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## 我们的改动

### 一、提给上游的 PR

| PR | 内容 | 状态 |
| --- | --- | --- |
| [#13](https://github.com/tswawa/WechatVibe/pull/13) | 逐条情绪 / 意图：宽情绪题（粗粒度 19.7% 到 64.3%）、`caring` / `surprised` 选项（38.9% 到 57.2%）、悬空判断句守卫、schema `generic-v9` 到 `generic-v10`；顺带修掉 [#14](https://github.com/tswawa/WechatVibe/issues/14) 的 API 逐条标签 | **已合并**（只采纳 API 标签部分，见下） |
| [#10](https://github.com/tswawa/WechatVibe/pull/10) | 本地分析多 worker 并行 + 弹性负载调节 | **已合并**（`d5c0fbe`，随 1.2.4 发布，合入后又做了调整） |
| [#18](https://github.com/tswawa/WechatVibe/pull/18) | 服务号 / 系统会话不进会话列表（本机 203 降到 149） | **已合并**（`a9e51b0`） |
| [#19](https://github.com/tswawa/WechatVibe/pull/19) | 一键把全部会话加进侧边栏 | **已合并**（`cd61328`；上游保留「全部添加」，去掉首次启动自动全选，并修掉手动移除的会话又被加回来的问题） |
| [#20](https://github.com/tswawa/WechatVibe/pull/20) | 只读的整账号分析进度 / 耗时接口 | **已合并**（`da3cec4`） |
| [#21](https://github.com/tswawa/WechatVibe/pull/21) | 后台分析全部会话的开关、侧栏总进度与并行档位 | **已合并**（`fcdd150`；上游改成默认关闭，并修了进度显示） |
| [#17](https://github.com/tswawa/WechatVibe/pull/17) | 消息内嵌图片直接显示（点击放大） | 开放；上游表示改动面较大、后续自己做，本 fork 保留该功能 |
| [#22](https://github.com/tswawa/WechatVibe/pull/22) | 单条消息右键「重新生成测评」（只重算这一条并覆盖已保存结果） | 开放；本 fork 已并入 `main` |
| [#23](https://github.com/tswawa/WechatVibe/pull/23) | 每条消息显示选项数 1 / 2 / 3：默认 1 与上游现状逐条一致，选 2 / 3 才列出概率最高的前 N 个候选（各带百分比，与第一名接近的标「相近」）；只影响本地模型路径，不改标签 schema。定位是**给用户放权**，同时算**前几个版本多候选显示的再重构** | 开放；本 fork 已并入 `main` |
| [#31](https://github.com/tswawa/WechatVibe/pull/31) | 修 [#24](https://github.com/tswawa/WechatVibe/issues/24) 的崩溃类问题：进度记录与明细不一致时，尾巴证据的标签不再直接下标，改用 `setdefault` 兜底，整轮分析不会 KeyError 后永久失败；附 5 个复现用例（修复前 4/5 失败） | 开放；**修复分支可单独构建使用**（见下） |

**#13 的采纳情况**（上游在 1.2.3 里手工移植）：

- **采纳**：API 模式逐条标签改用短编号逐条输出（prompt 约 1000 降到 440 字节），这条同时修掉 #14；上游另补上了乱序、重复与流式结果的对应。
- **未采纳（本 fork 保留）**：逐条显示改用宽情绪题、`caring` / `surprised` 选项、标签 schema `generic-v10`。上游 1.2.4 仍未采纳这块。
- **未采纳（已丢弃）**：画像输出的容错解析。上游指出 `I:70` 会被算成偏 E 70%（方向反了），且画像已改为程序统一计分，这段逻辑不再需要。

**#10 按 review 修掉的问题**（已随上游 1.2.4 发布）：

- `subprocess` 从未导入，探测 `nvidia-smi` 一直抛 `NameError` 又被 `except` 吞掉，显卡 / 显存检测实际从未生效；
- 每次采样都新建 `psutil.Process()`，`cpu_percent(interval=None)` 恒为 0，自身占用扣不掉；
- 上限降到 0 时，**已经阻塞在 `tasks.get()` 上**的 worker 仍会取走新任务（现改为取到任务后复查上限，超限就放回队列）；
- 监控线程退出后句柄没清空，账号清除失败后 resume 时弹性模式不会重启。

服务号过滤、会话全选、统计接口与结果库 WAL 已从这个 PR 移出，分别走 #18 / #19 / #20。

### 二、自用改动（已并入 `main`）

上游 1.2.4 采纳了 #10 / #18 / #19 / #20 / #21，这几块**一律改用上游实现**，本 fork 不再维护自用版。
如今跟着 v1.2.4 走的自用改动只剩下面这些（都是上游没有的）：

- **消息内嵌图片**：直接显示、点击放大；图片密钥在后端后台派生并落盘，首次仍需在微信里点开一张图 (→ [#17](https://github.com/tswawa/WechatVibe/pull/17))；
- **聊天页「刷新」按钮**：手动重新读取会话列表、当前会话与画像；
- **标签跟随**：发起一次逐条标签后，短时间轮询几次分析读取，新消息的标签尽早出现；
- **宽情绪题 8 桶**：逐条显示用 `EMOTION_QUESTION`（`caring` 取代 `affectionate`，`surprised` 从 `amused` 拆出），schema 升到 `generic-v10` 以强制刷新旧缓存；
- **悬空判断句扩展**：`我是` / `这是` / `我这是` 这类悬空判断句不出标签。

另外，还在上游走 PR 的两块**也已经并进 `main`**：#22 单条消息右键「重新生成测评」、#23 每条消息显示选项数。它们不是 fork 独占 —— 上游一旦采纳，就按上面同一口径改用上游实现。（#17 内嵌图片虽然也开着 PR，但上游已表示自己另做，所以仍按上一条由本 fork 保留。）

`feat/selfuse-on-1.2.4` 上 `tsc`、Node 测试与 Python 全套通过。

### 三、本轮改动（提交在 `perf/optimize-tokenizer`，开着 [PR #33](https://github.com/tswawa/WechatVibe/pull/33)，未并入 `main`）

下面三块都已提交到分支上：

- **手选若干条消息，只分析它们**：聊天输入框上方新增「选择消息」，进去后每条可分析的消息左侧出现勾选框，勾完点「分析选中」，就只对勾中的这几条做逐条情绪 / 意图分析——**本地 Laya 与 API 模式都支持**。选择期间会暂停「整个消息窗口的自动分析」，退出后恢复；勾选范围限在当前已加载的窗口内（最多 80 条），超出的会在工具条上标出条数。人物画像累计与沟通建议不受影响，仍按整段历史计算。隐私口径不变：手选只是把同一段窗口里被勾中的消息交给原本那条链路——本地模式仍然不出本机，API 模式向上游发送什么仍以上游说明为准，勾选不会扩大或缩小发送范围。
- **修「保存并启用」的两个坑**：这个按钮过去有两种失败方式。一是编辑一条**已保存的** API 配置后点它，会被后端以 400 `invalid model source request` 拒绝、界面显示「启用失败」，而紧挨着的「测试连接」却成功——它把「连接字段」和「配置 ID」塞进了同一个请求，后端规定两者二选一。二是**新建**一条与已有配置同 Base URL、同模型 ID 的配置时，后端按连接命中了旧那条并就地更新，于是列表里不会多出一行，看起来就是「我加了第三个模型，下拉菜单里却没有」。现在这个按钮统一成「先保存（新建则新增一条、编辑则更新那条），再按 ID 切换」，两种情况下都会出现在模型列表里。
- **修 API 画像「已解锁但四维全是空白」**：MBTI 四维只在观察阶段攒够证据后才会由模型给出，而画像卡片此前按「已分析文本数」判断是否解锁，于是停在中途的运行会显示已解锁、四个维度却全是待判断，也没有任何说明。现在卡片按后端真正的门槛（观察账本条数）解锁，锁定时说明还差什么，逐轴证据数也用真实条数而不是固定值，停在队列里的运行会直接说「观察阶段未运行，请重新分析」。

### 四、合并上游 1.3.0（2026-10-10）

把 `upstream/main`（`b35efa5`，1.3.0 发布）合进 `perf/optimize-tokenizer`：分支基线从 v1.2.4 提到 v1.3.0，
[PR #33](https://github.com/tswawa/WechatVibe/pull/33) 也从「冲突」回到可合并。

上游这次带来的（**一律取上游实现**）：**助手仓库 / 聊天助手**（`ui/advisor`、`chatui/advisor*.js`、`docs/advisor.md`、`bridge/advisor_*.py`）；
**「重置分析」按范围**（`/api/analysis-scope/clear`，重置进行中对新任务回 409）；**会话批量移除**（`/api/conversation-selection` 的 `sessions` + `selected:false`，一次最多 1000 个）；
**API 画像观察账本**（`api_portrait_ledger.py`）与跨批次的显示统计继承；**chatui 源码行尾归一化**（`0c67aee` + `.gitattributes` 的 `chatui/*.{html,css,js} text`）；
以及 **Laya 分词优化的上游版** —— 就是我们 PR #26 的那套缓存，上游另加了不可变返回、原文长度上限与显式清理，因此 `electron/laya/{tokenizer,prompt,agent}.ts` 与 `tests/laya-tokenizer.test.ts` 直接取上游。

本 fork 保留的（上游没有，冲突时按功能重贴）：**手选消息**（`targetIds`）与**模型来源多配置**（`/api/model-source/profiles*`、按配置清 Key —— 上游没有多配置这一层）；
**画像与 resume 的落盘加密**（`default_cipher`，上游写明文，`unprotect` 仍能读旧的明文行）；**宽情绪题 8 桶 / `generic-v10`**、消息内嵌图片、「请求分析」按钮（`requestedSessions`）、`/api/model-guidance`、`/api/api-workers`。

这轮冲突解决里值得记下的三点：

1. **chatui 的整文件冲突是行尾噪声**：上游把 chatui 源码归一化成 LF，分叉点却是混合行尾，于是逐行都对不上（`style.css` 整个文件、`index.html` 9 处）。做法是**把 base / ours / theirs 都转成 LF 后再做三方合并**，冲突立刻缩到 1 处（双方各加了一个弹窗，取并集）。
2. **上游把「失效助手运行」「上下文容量变化时丢弃画像错误」写在 `model_source_activate` 里**，而本 fork 三条发布路径都走 `_commit_api_source_locked`，于是这段统一收进那个方法，三条路径一起生效。
3. **两处上游新增测试要按 fork 行为适配**（否则 PR 上会红）：`bridge/test_api_portrait_reconciliation.py` 直接 `json.loads` 读写 `portrait_json` / `resume_json`，而本 fork 这两列是加密的，改成 `default_cipher().loads()/dumps()`；`tests/advisor-runtime.test.ts` 把夹具建在仓库内 `.local/advisor-build/runtime-tests/case-*`，运行时再往下嵌到 **268 字符**，超过 Windows 260 上限且本机没开长路径支持时删不掉、资源管理器会反复弹「永久删除此文件夹？」，改成建在系统临时目录（约 195 字符）。

验证：`npm run typecheck` 干净；`npm run test:node` **595/595**；Python 侧除上游自带的 7 个 `test_advisor_*.py`（在纯净 `upstream/main` 上失败数完全相同，本机环境所致）外全部通过，含两个慢文件（`test_real_backend.py` 94s、`test-start-real-client.py` 79s）。

### 五、潜台词与沟通建议并进助手（`b63fd99`，已推到 [PR #33](https://github.com/tswawa/WechatVibe/pull/33)）

画像页那张「潜台词与沟通建议」卡已移除 —— 连同场景选择、「开始分析」/「重算」、重算反馈对话框和设置里的「分析我自己的对话风格」开关（`analyzeSelfStyle`），`chatui/app.js` 里那一段渲染/轮询代码与 `.guidance-*` / `.feedback-modal-*` 样式一并删除。这份能力现在只从**助手**进入：

- **内置技能 + 内置助手**：新增「潜台词与沟通建议」技能与「沟通参谋」助手（`bridge/advisor_contracts.py`），助手用自己的模型逐条解读潜台词、给局势判断和沟通建议，并给出可直接发出的回复草稿；默认按普通联系人，说明是与领导 / 上级时改用更稳妥、留余地的说法，证据不足时直说不确定。
- **可引用已有结果**：这个会话若曾生成过分析，助手本轮就能在资料里读到它（`api_guidance_latest` 按会话取最新一条 → `guidance_material()` 渲染 → 附在托管资料末尾，占用同一个上下文预算），不必重新花钱分析；没有存量结果且本轮选了该技能时，助手会被告知「尚无结果」并自行分析。
- **注意**：原生成链路 `POST /api/model-guidance` 现在**没有界面入口**（接口、契约、存储与测试都保留，存量结果仍会被助手引用）。如果你想在面板里保留一个「生成 / 重算」按钮，说一声我加上。

回归：`bridge/test_api_guidance.py`（17 例）、`bridge/test_advisor_guidance_reference.py`（5 例）、`tests/api-persona-ui.test.cjs`（48 例）；`npm run typecheck`、`npm run test:node`（595/595）与除上游自带 `test_advisor_*.py` 外的 Python 全量都通过。

### 六、链接不进分析（`c79ba16`，已推到 [PR #33](https://github.com/tswawa/WechatVibe/pull/33)）

聊天里的链接不再参与任何分析：逐条情绪 / 意图标签（本地 Laya 与 API）、沟通建议、API 画像、助手资料都一样 —— 送进模型的文本先去掉链接；一条消息若**只有链接**（或只有链接加标点、只是 `[链接]`/`[文件]` 这类微信占位），就不再作为分析目标，不产生结果也不消耗调用。界面显示的原文、已存结果与画像的来源指纹仍是原文，不受影响。

判定范围刻意收窄：只认 `http://`、`https://`、`www.` 开头的链接（尾部的 `。，` 等标点留给句子），**裸域名**（如 `mp.weixin.qq.com/s/…` 不带协议头）暂不处理，纯标点消息也照旧算内容（`？？？` 这类承载语气）。如果你发现自己转发的链接多数没有协议头、仍被分析，说一声我把裸域名判定加上。

回归：`bridge/test_message_input.py`（规则本身）、`bridge/test_real_backend.py`（本地链路跳过 + 送模型文本无链接）、`bridge/test_api_insights.py`（API 标签目标与 payload、沟通建议 `insufficient`）、`tests/message-picking.test.cjs`（前端判定与手选）。

### 七、右键单条重算（`7e53041`，已推到 [PR #33](https://github.com/tswawa/WechatVibe/pull/33)）

在聊天里右键任意一条消息，弹出的小菜单里是「重新算」：只把**这一条**交给当前模型重新跑一遍，其它消息、分析进度和画像都不动。

- **只看这一条**：已经算过的会重算，上次被跳过（比如当时是纯链接）的也会重新判定一次；相邻消息与其它结果保持原样。
- **两种模型来源都支持**：本地 Laya 与 API 模型各走原有入口（`POST /api/analyze` 与 `/api/model-insights` 的 `targetIds`），所以 API 模式下重算一条只花这一条的调用。
- **不能算的会说明原因**：自己发的、图片、只有链接（见上一节）、纯占位（`[链接]`）等消息，菜单里的按钮是灰的并写明原因；超出当前 80 条尾窗的消息提示「不在最近窗口中」；正在跑分析时提示稍后重试。
- **实现上是先「忘掉」再「算」**：新增 `POST /api/analysis-target/forget` 只删除这一条在当前来源下的已存结果（`ResultStore.clear_message`）。因为两条分析链路都会主动跳过已有结果的消息 —— 少了这一步，重算会静默地什么都不做；这一点由前端测试按**事件顺序**钉住。

回归：`bridge/test_message_recompute.py`（只删这一条：相邻消息 / 另一会话 / 另一来源三组对照 + HTTP 200/400 与坏入参）、`tests/message-context-menu.test.cjs`（菜单接线、禁用原因、请求体、先忘后提交的时序、视图变化后不提交、并发只发一次）。

### 八、模型配置单开一栏（`7e53041`，已推到 [PR #33](https://github.com/tswawa/WechatVibe/pull/33)）

设置弹窗原本只有「通用设置 / 关于」两栏，模型那一整组（模型来源、本地模型与设备、模型文件下载、本地并行数、API 配置与密钥、API 并行数、模型来源状态）和主题、缩放、会话管理、数据目录、账号、分析缓存挤在同一栏里。现在它们单独成栏，侧栏顺序为 **通用设置 / 模型配置 / 关于**。

- 「通用设置」保留：主题外观、界面缩放、后台分析已添加的会话、会话管理、聊天记录路径、账号、分析缓存。
- 从聊天标题栏的模型徽标点「管理配置」，会直接落在「模型配置」栏（不然会聚焦到一个隐藏面板里的输入框）。
- 只是搬位置：行为、接口、本地/API 按 `hidden` 的切换规则都没变。

### 九、助手窗口「切换模型档案」（`87fbdee`，入口位置另有工作树改动，已推到 [PR #33](https://github.com/tswawa/WechatVibe/pull/33)）

聊天助手窗口多了一个「模型」选择条：`87fbdee` 时在标题栏（模板名所在的那一行），工作树里已挪到输入框下方左侧，做成一颗小胶囊。点开是「跟随分析」加上设置里已保存的全部 API 配置档案，当前使用的那项有选中态、点它不会重复发请求；点另一项就只把**助手**切到那条档案，分析模式完全不受影响。

- **只切助手，不动分析**：后端 `POST /api/model-source/select`（上一轮已加）只写配置文档的 `assistantProfileId`，`selectedMode` 与活动 `sourceId` 原样不动 —— 本地分析继续本地跑，API 分析继续用它自己那条档案。切换成功后宿主会重读 `/api/advisor/catalog`，因为军师引擎的「可用 / 未安装」状态跟着助手档案变。**不会**调用 `/api/model-source/activate`。
- **「跟随分析」是回头的路**：菜单第一项固定是「跟随分析」，发的是 `profileId:null`，清掉助手专属档案、让两条线重新读同一个来源；没有 pin 时胶囊文案是「跟随分析 · <分析线当前模型名>」，pin 了就显示档案名，一条档案都没有时显示「未配置模型」。
- **档案列表来自本地配置**：宿主读 `GET /api/model-source`（该接口本就返回 `profiles`、`assistantProfileId` 与分析线当前档案 `api`）下发给 iframe 渲染，iframe 自己不发任何网络请求；切换中胶囊显示「切换中…」并禁用，避免连点。
- **不产生 provider 调用**：列档案与切档案都不连接模型服务，本地模式下渲染菜单同样不触发 model-connectors 请求；未知或已删除的档案返回 400，界面给一句简短提示，菜单保持原来的选中项。
- 隐私口径不变：这里切换的是「助手用哪条已保存配置」，不改变任何消息文本的去向。

回归：`tests/advisor-ui.test.cjs`（菜单渲染与选中态、点击只发一次且 payload 恰为 `{profileId}`（或 `{profileId:null}`）、成功后宿主请求序列固定为 `select → catalog`、失败保持原选中并提示、未知 id 在宿主侧即被拒、空档案时胶囊仍可点并提示去设置添加、切换中显示「切换中…」且禁用）；后端契约仍由 `bridge/test_model_source_select.py`（8 例）钉住。

### 十、助手生成时实时展示执行步骤（`2134572`，已推到 [PR #33](https://github.com/tswawa/WechatVibe/pull/33)）

助手回答前不再是干等：界面上依次显示「正在读取会话资料 → 已读取 N 条消息，正在整理上下文 → 正在调用模型」，压缩较早历史时中间多一条「正在整理较早的聊天记录…」，让人知道它到底卡在哪一步。

- **只报阶段，不泄内容**：步骤里只有阶段名和条数，不含聊天原文、提示词、工具参数，也没有模型推理过程 —— 这块是给「等得心慌」用的，不是给窥屏用的。
- **有上限、有清洗**：最多显示 4 条；标签超长或状态值不在约定枚举里的直接丢弃，重复标签只留一次，避免桥接端异常时把界面撑坏。
- **回答开始就收起**：正文一旦开始流式输出，整块步骤立刻移除，不跟回答抢位置；系统开了 `prefers-reduced-motion` 时不转圈。

回归：`tests/advisor-steps.test.cjs`、`bridge/test_advisor_boundaries.py`。

### 十一、等待 AI 时加转圈（`9db75cf`，已推到 [PR #33](https://github.com/tswawa/WechatVibe/pull/33)）

意图识别 / 逐条标签、人物画像、生成回复选项这三处的状态行，在文字前加了一个 11px 的圆环。以前只有一行静止的「正在分析…」，分不清是在跑还是卡住了。

- **不新增元素、不改文案**：做法是给既有状态节点加一个 `ai-busy` class，由 CSS 画圆环，所以布局和文字一个字都没动。
- **该停就停**：失败态和提示态会显式把这个 class 清掉，不会出现「已经报错了圆环还在转」。
- **减弱动效下不转**：跟随 `prefers-reduced-motion`。

回归：`tests/ai-busy-status.test.cjs`。

### 十二、dev/venv 启动被身份校验误判（`8242ab5`，已推到 [PR #33](https://github.com/tswawa/WechatVibe/pull/33)）

这条修的是自己开发时最烦的一个坑：`start-real-client.py` 原先用「shell pid == 直接父进程」判断自己是不是被桌面端拉起来的，而 venv 里的 `python.exe` 会多起一层解释器，父进程对不上，于是每次 `npm start` 都报 `Desktop startup identity is invalid`，界面上只剩一句「本地服务未就绪」。

- **判断改成看祖先链**：现在要求 shell pid 出现在祖先链上（最多上溯 4 层）。安全意图没变 —— 仍然必须由本应用的 shell 拉起，随便一个进程启不来；打包版走的是原路径，行为不变。
- **失败不再吞输出**：启动失败时把 launcher 的输出写进 `logs/desktop-launch.log`，弹窗里附最后一行。以前只看得到一个通用提示，完全不知道底下报了什么。

验证：`start-real-client.py` 的 48 个端到端用例通过，`test-desktop-main` / `test-real-client-recovery` 退出码 0。

### 十三、与上游的已知分歧

保留自用判定逻辑会带来两处可预期的不一致，下次升级上游时需要留意：

- 情绪题是 **8 个桶**（`caring` 取代 `affectionate`，`surprised` 从 `amused` 拆出），上游是 7 个。
  因此 `tests/api-portrait-classifier.test.ts` 的两处断言按本 fork 的题库调整过（59 改 60、`affectionate` 改成 `caring`）。
- 逐条显示走宽情绪题 `EMOTION_QUESTION`，上游的逐条显示仍走 18 个立场词；标签 schema 本 fork 是 `generic-v10`，上游是 `generic-v9`。

升级上游时的做法（v1.2.4 与 v1.3.0 两轮实际用的）：从目标版本开分支（v1.3.0 这轮直接 `git merge upstream/main`），
上游已经覆盖的功能**直接取上游**，只按功能重贴上面这些 fork 独占块；比对时用 `git diff -w` 过滤行尾噪声，
行尾已经归一化的文件可以先把三方都转成 LF 再合并；最后跑 `tsc`、Node 与 Python 全套。
Python 侧注意 `scripts/run-python-tests.py` 是**串行遇错即停**，要用 `--only` 逐个文件确认其余文件真的跑过。
v1.2.0 上那份原始补丁仍原样存档在 [`selfuse/v1.2.0`](https://github.com/silicon-sbt/WechatVibe/tree/selfuse/v1.2.0) 分支，仅作历史对照，不再维护。

### 十四、可自定义的主题色

设置 → 通用设置里多了一行「主题色」：绿（默认）、蓝、黄、红四个色点，外加「恢复默认」。点色点只改 `body[data-theme-accent]`，按钮、链接、高亮、导航选中态、开关和消息气泡立刻换色，无需刷新；选择写进既有的 `real-ui-settings-1`，旧配置缺这个键时按绿色处理，手改坏了也回落绿色。

- 颜色不是逐个组件改的，而是抽成 `--theme-accent` / `-strong` / `-deep` / `-rgb` / `-contrast` 五个令牌，全表 170 多处引用，原来散落的 `#07c160`、`#398da0`、`rgba(7,193,96,…)` 都已换成 `var()`。
- 令牌与 4 色 × 深浅共 8 组预设放在共享的 `chatui/theme-accent.css`，主窗口 `index.html` 和沙箱窗口 `advisor-frame.html` 都引用它；沙箱窗口刻意不加载 `style.css`，否则会破坏它自己的灰阶配色。
- 历史别名 `--color-green` 必须在 `body` 上重新声明：自定义属性在声明处解析，只写在 `:root` 会固化成默认绿，`body` 上的预设就影响不到它。气泡同理，用 `color-mix()` 和当前底色混合，日夜两套自动适配。
- 助手仓库（`advisor.css` / `advisor-timeline.css`）的按钮、 badge、技能标签、开关、启用卡片描边、历史会话选中态、引用块边框也全部走令牌；主按钮文字用 `--theme-accent-contrast`。沙箱窗口不共享 DOM，主题色由 `ADVISOR_INIT` / `ADVISOR_THEME` 消息带上 accent，主窗口 `body` 的 `data-theme-accent` 变化也会通过 MutationObserver 推过去；旧消息没有该字段时回落绿色。
- 深浅模式各有独立色值（浅色下绿色 `#2a8a5c`、黄色 `#a97b08` 保证白底可读），黄色等亮色配深色文字（`--theme-accent-contrast`）。
- 回归：`tests/theme-accent.test.cjs`（预设齐全、令牌齐全、四个样式表禁止再写死主题色、助手仓库与沙箱窗口接线、默认值/校验/持久化/恢复默认）。

## 可以单独用的修复分支（基于上游 main，不含自用改动）

这两个分支从 `origin/main`（上游）切出，各自只带一个提交、**没有夹带本 fork 的自用改动**，可以直接构建来救急；正式合并仍走上游 PR。

| 分支 | 内容 | 上游状态 |
| --- | --- | --- |
| [`fix/state-tail-keyerror`](https://github.com/silicon-sbt/WechatVibe/tree/fix/state-tail-keyerror) | 修 [#24](https://github.com/tswawa/WechatVibe/issues/24) 的三处 `KeyError`（`batch_state.py` / `profile_state.py` / `result_store.py`）：进度被清、明细还在时不再整轮失败，健康状态数值逐字节不变 | [PR #31](https://github.com/tswawa/WechatVibe/pull/31) 开放 |
| [`fix/key-scan-budget`](https://github.com/silicon-sbt/WechatVibe/tree/fix/key-scan-budget) | 修 [#30](https://github.com/tswawa/WechatVibe/issues/30)：config cipher 扫描预算从 2 GiB / 4 GiB 提到 4 GiB / 8 GiB，微信进程内存涨大后不再「账号永远未就绪」 | 未开 PR —— 留给 issue 作者提，避免撞车 |

用法：`git clone -b <分支> https://github.com/silicon-sbt/WechatVibe.git`，然后按上游 README 构建。两个修复也都已经打在本机现役安装目录里验证过（bridge `result=ready required=5 matched=5`、`/api/health state=ready`）。

## 分支

| 分支 | 内容 |
| --- | --- |
| `main` | 跟随上游 v1.3.0 + 「自用改动」 |
| `perf/optimize-tokenizer` | 本轮分支：手选消息 / 模型来源多配置 / 助手切换模型档案 / MBTI 门槛修 / 链接不进分析 / 右键单条重算 / 助手执行步骤 / AI 等待转圈 / dev-venv 启动修复 + 分词优化，已合并上游 1.3.0（[PR #33](https://github.com/tswawa/WechatVibe/pull/33) 开放） |
| `feat/selfuse-on-1.2.4` | 上一轮升级分支（自用改动搬到 1.2.4） |
| `feat/selfuse-on-1.2.3` | 上一轮升级分支（已并入 `main`，历史） |
| `feat/selfuse-on-1.2.2` | 更早的升级分支（历史） |
| `selfuse/v1.2.0` | v1.2.0 + 旧的原始自用补丁（存档，不再维护） |
| `feat/inline-image` | PR #17 消息内嵌图片（已并入 `main`，PR 仍开放） |
| `feat/message-regenerate` | PR #22 单条消息重新生成（已并入 `main`，PR 开放） |
| `feat/label-option-count` | PR #23 每条消息显示选项数（已并入 `main`，PR 开放） |
| `feat/parallel-analysis-workers` | PR #10（已合并，可归档） |
| `fix/emotion-question-options` | PR #13（已合并，可归档） |
| `feat/service-account-filter` | PR #18（已合并，可归档） |
| `feat/conversation-add-all` | PR #19（已合并，可归档） |
| `feat/analysis-overview` | PR #20（已合并，可归档） |
| `feat/background-sweep-ui` | PR #21（已合并，可归档） |
| `fix/state-tail-keyerror` | PR #31（基于上游 main 的单提交，可单独构建） |
| `fix/key-scan-budget` | #30 的扫描预算修复（基于上游 main 的单提交，未开 PR） |

## 运行要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10/11 x64 |
| 微信 | Windows 微信 **4.x**，已实测 **4.1.15.13**；**不支持 3.x** |

<details>
<summary>本地 Laya 配置参考（只用 API 可以跳过）</summary>

模型约 3.22 亿参数，纯 CPU 即可运行，不需要独立显卡。下表为建议配置，低配设备尚未系统测试。

| 项目 | 建议配置 |
| --- | --- |
| CPU | 4 核及以上 x64 处理器；CPU 推理默认使用 4 线程 |
| 内存 | 8 GB 起步；同时运行微信和其他应用，建议 16 GB 及以上 |
| GPU（可选） | 支持 WebGPU 的显卡和较新的驱动，不兼容时使用 CPU；最低显存要求暂未确定 |
| 磁盘 | 至少预留 4 GB，用于应用、模型下载和安装；聊天缓存和更新备份另算 |
| 模型体积 | 模型包约 599 MB，解压后约 681 MB；文件体积不等于运行时的内存占用 |

首次加载和分析历史消息的速度取决于处理器、内存和聊天量。API 模式不需要下载 Laya，也不需要本地显卡，速度和上下文容量取决于所选的模型服务。

</details>

## 首次使用

1. **登录微信**：使用 Windows 微信 4.x 登录要分析的账号。
2. **启动软件**：双击 `WechatVibe.exe`。账号状态可在「设置 → 管理账号」查看，不用等聊天加载完就能使用界面。
3. **选择模型**：在「设置 → 通用设置」选择模型来源。本地模式下载或选择 Laya 模型；API 模式填写服务地址、API Key 和模型，确认上下文大小，测试连接后保存并启用。
4. **添加会话**：点击左侧搜索框旁的「＋」，或在「设置 → 信息列表」选择联系人或群聊。
5. **查看分析**：打开聊天，点击「意图识别」查看消息标签；进入「人物画像」查看画像，群聊还可以选择具体成员。

### 同一模型的多个 API 来源

同一个模型 ID 可以保存多条 API 配置（例如一条 OpenRouter、一条 NVIDIA NIM），每条独立保存协议、Base URL、API Key 和上下文大小，密钥按配置分别加密，不会互相沿用。

新增来源：在「设置 → 模型配置 → API 接入」点「OpenRouter」或「NVIDIA NIM」自动填入协议与 Base URL，再填自己的 Key 和模型 ID，点「仅保存配置」；重复一次即可为同一模型再加一条。若当时正在编辑已保存的配置，点预设会自动切到「新建配置」，不会覆盖原来源。其他提供方手动填 Base URL 即可。

切换来源：用聊天标题栏或画像页的模型徽标下拉。每条来源显示名称、模型 ID 和**服务域名**，同一模型的不同来源一眼可辨。切换只在新来源探测成功后才落盘，失败时保留原来源；分析缓存按配置 ID 隔离，在途任务被作废重跑，不会把 A 来源的结果写进 B 来源。助手窗口的模型选择条是独立的一条线，只切助手，不影响分析来源。

## 软件更新

在「设置 → 关于 → 当前版本」检查更新，发现新版本后点击「下载并安装」。下载的文件会先校验，安装完成后自动重启；账号数据、分析结果、画像和已下载的模型都会保留。安装失败会自动恢复旧版，更新成功后保留最近一次旧版以便回退；已写入加密分析结果后，回退到不支持该格式的旧版需要兼容性检查和一致性备份。Windows 设置了系统代理时，更新会沿用该代理连接 GitHub。

1.3.6 的改动见[本版更新说明](docs/releases/1.3.6.md)，历次改动见[更新日志](CHANGELOG.md)。

<details>
<summary>从旧版本升级的注意事项</summary>

- **已有的 API 画像**：旧格式画像升级后仍先保留显示。首次点击「更新画像」时需要按新规则重建一次，会重新处理对应历史并产生 API 请求；之后在已保存结果上继续分析新消息。
- **从内置模型的旧版升级**：原来的 Laya 模型会保留，设置中显示为已就绪。
- **1.2.1 首版从目录映射（Junction）启动**：如果更新时提示「更新包或安装位置不可用」，请手动下载最新版，退出软件后覆盖原目录，保留 `resources/client/.local` 和 `resources/client/.models`。
- **从 1.0.4 升级**：旧更新器不支持现在的运行包，需要手动下载。完全退出旧版后，把新包 `win-unpacked` 里的文件覆盖到原软件目录，保留 `resources/client/.local` 和 `resources/client/.models`，不要先删除旧目录。

</details>

## 常见问题

<details>
<summary>一直显示「当前微信账号未就绪」</summary>

- 确认使用的是 Windows 微信 4.x（不支持 3.x）。使用旧版微信时，请先更新微信并重新登录，再启动 WechatVibe。
- 微信数据存放在自定义位置时，在「设置 → 通用设置 → 聊天记录路径」手动选择 `xwechat_files` 或账号目录。
- 仍然无法解决时，运行下面的启动诊断工具，再到 [Issues](https://github.com/tswawa/WechatVibe/issues) 反馈。

</details>

<details>
<summary>启动时提示「本地服务未就绪」或无法打开</summary>

下载 [WechatVibe-diagnose.bat](https://github.com/tswawa/WechatVibe/releases/download/v1.2.4/WechatVibe-diagnose.bat)，放到 `WechatVibe.exe` 所在目录后双击运行。它会检查文件、运行环境和启动错误并生成报告；不启动应用或模型，不读取聊天数据库和 API Key，也不会自动上传。详见[启动诊断说明](docs/startup-diagnostics.md)。

</details>

<details>
<summary>升级后人物画像还是旧的</summary>

旧格式 API 画像会先保留显示。在画像页点击「更新画像」，才会按新规则重建一次；重建期间会标明正在显示旧画像。完成后继续在已保存结果上分析新消息，切换页面或重启软件不会反复重建。

</details>

## 开发

后端按应用服务、微信只读适配器、Node 推理适配器和 SQLite 存储拆分，模块职责、依赖边界和回归命令见[后端架构说明](docs/backend-architecture.md)。

<details>
<summary>源码运行</summary>

需要 Node.js **24.11.1**、Python **3.14** 和 npm。在 PowerShell 中执行：

```powershell
git clone https://github.com/tswawa/WechatVibe.git
cd WechatVibe
npm ci
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --no-deps -r python-requirements.lock.txt
npm start
```

需要本地 Laya 时，可在首次启动前执行 `npm run setup:models`，或进入应用后下载；仅使用 API 时可跳过模型下载。源码方式下载模型约 681 MB，下载后校验 SHA-256。下载器保留 `.part` 文件供断点续传，网络失败最多尝试三次；完整文件通过大小和 SHA-256 校验后才替换旧文件，强制下载失败不会删除已有模型。默认目录为 `.models/laya`，可通过 `LAYA_MODEL_DIR` 或 `--dir` 指定。Python 安装时请按锁文件安装并保留 `--no-deps`。

应用内“下载模型”使用 GitHub 上的独立模型 ZIP，安装到 `resources/client/.local/models/laya`。桌面下载支持断点续传、完整性校验和安装重试：中断后再次下载会复用已收到的部分，服务不支持 Range 时安全重新下载，校验完整后才安装。源码与桌面仍使用各自的下载入口。

1.3.5 已整合贡献者的多模型档案、可控分析范围、单条重算、三个回复选项、多实例及分析结果列加密；功能、数据迁移边界和贡献范围见 [PR 整合版验收说明](docs/pr-integration-acceptance.md)。

开发验收使用 `npm run start:test`，运行当前源码中已整合的完整功能，仅将聊天来源替换为合成会话。首次启动保留本机已配置的助手 Skills 与模型设置；测试聊天、结果和助手历史独立保存，不读取真实微信。详见 [测试客户端](docs/testing.md)。

`npm ci` 完成后会运行 Electron 官方安装器补全桌面运行时；若跳过了安装脚本，启动或构建前执行 `npm run setup:electron`。

Python 脚本优先使用 `WECHATVIBE_PYTHON` 指定的解释器，其次使用当前虚拟环境，再使用项目 `.venv`，避免测试或构建误用系统 Python。便携构建仍要求 Python 3.14 和 Node 24.11.1，可用 `--python-exe` / `--node-exe` 显式指定。`npm run start:service -- --no-open` 可单独启动 bridge；`npm start` 会启动桌面客户端。CPU/GPU 切换位于「设置 → 通用设置」。

</details>

<details>
<summary>本地验证</summary>

```powershell
npm test                 # 类型检查 + Node + 桌面/更新脚本 + Python 回归
npm run test:model       # 真实加载本地 ONNX，执行中文推理（需先下载模型）
npm run test:recovery    # 桌面、服务恢复、账号存储和启动器测试
npm run build:portable   # 构建包含模型和运行环境的便携版
```

</details>

<details>
<summary>构建运行版</summary>

完成上述依赖和模型安装后，在同一个 PowerShell 窗口运行：

```powershell
$env:PATH = "$PWD\.venv\Scripts;$env:PATH"
npm run build:portable
```

构建命令会打印本次独立的产物目录：`.local/portable-builds/build-*/release/win-unpacked/WechatVibe.exe`。整个 `win-unpacked` 目录构成本地运行版，包含模型和运行环境。公开发行采用**无模型标准包 + 独立 Laya 模型包**；`scripts/build-windows-release.py` 默认生成不含模型的标准 ZIP。

</details>

<details>
<summary>修改词库</summary>

当前词库包含 40 个情绪、547 个意图细项、98 个表达方式和 80 个人际需求。同义意图共用 215 个简短显示词，表达方式与人际需求两组词表生成 7,840 个组合。

源文件为 `scripts/analysis-catalog-source.json`、`scripts/intent-display-source.json` 和 `scripts/social-intent-source.json`。修改时保留既有 ID，然后执行：

```powershell
npm run catalog:generate
```

</details>

## 数据与隐私

- **本地模式（默认）**：使用本地 Laya 在本机推理，本地服务只监听回环地址。
- **API 模式（需手动开启）**：消息分析会把当前这批聊天文本和简短的画像参考发送给你配置的模型服务；人物画像会按上下文容量发送所选会话的历史文本，由模型判断后，再由程序计算好感度、MBTI、互动风格和摘要。
- **聊天助手（提交问题后生成）**：独立使用设置中保存的生成式 API 连接。提交问题时，当前会话的相关资料、摘要、选用技能和助手对话会按需要发送给所配置的模型服务；普通分析使用本地 Laya 时，助手仍可能使用 API。
- **保存方式**：聊天副本按微信账号保存，分析结果和画像再按模型来源分开。

使用时请注意：

- 只读取自己有权访问的账号和聊天，不用于获取他人的私人记录。
- 清除账号只删除 WechatVibe 保存的数据，不删除微信原始聊天。
- 软件只分析和展示，不自动发送微信消息，也不提供聊天记录导出功能。
- 不要把聊天数据库、解密密钥、账号缓存或带私人内容的日志上传到仓库、Issue 或交流群。
- 反馈问题前先检查截图和日志，移除不想公开的姓名、账号和对话。

## 免责声明

WechatVibe 面向技术学习、研究及个人聊天复盘。使用前请确认数据来源和使用方式符合适用法律、微信服务协议及相关第三方服务条款。

- **功能与使用边界**：本项目不提供微信聊天记录导出功能，本地缓存用于应用内查看与分析。项目不提倡通过导出、传播、交易或再利用聊天记录侵犯用户隐私、数据权益或微信相关合法权益，也不为此类用途提供支持。
- **数据授权**：仅处理本人合法持有、有权访问和分析的聊天记录。能在设备上看到记录，不代表可以任意公开、传播或用于其他目的；涉及他人信息时，应尊重其隐私和合法权益。不得用于盗取账号、未经授权的监控、跟踪、骚扰或其他违法侵权活动。
- **分析边界**：意图、情绪、好感度和 MBTI 均为模型推测，可能遗漏语境或产生错误。结果不等于对方真实想法，不构成心理诊断、人格定性或官方测评，不应作为作出重大个人决定的唯一依据。
- **第三方服务**：启用 API 后，所选聊天片段和画像摘要会按功能需要发送至你配置的服务商。请自行了解其计费、数据保存与隐私政策；项目无法替第三方承诺数据安全、服务稳定性或分析准确率。
- **运行风险**：微信版本、操作系统、权限和第三方组件变化可能影响读取与运行。请保留重要数据备份；项目不保证持续兼容、数据绝不丢失，也不承诺“零风险”或“不会封号”。
- **许可与担保**：本项目依据 [Apache-2.0](LICENSE) 许可证“按现状”提供。除适用法律要求或另有书面约定外，维护者及贡献者不提供任何明示或默示担保，包括适销性、特定用途适用性及不侵权担保；不承诺分析结果准确、运行持续稳定或适合任何特定使用场景。
- **使用者责任**：使用者应自行判断本项目是否适合其用途，并负责取得账号、聊天数据及第三方服务所需的授权。由使用者自行决定的数据处理方式、服务配置、结果使用，以及自行或委托第三方实施的修改、部署与运营，由相应使用者、开发者或运营者承担其行为及承诺所对应的责任。
- **责任限制**：在适用法律允许的最大范围内，且除另有书面约定外，维护者及贡献者不对因使用或无法使用本项目而产生的直接、间接、附带、特殊或后果性损失承担责任，包括数据丢失、账号受限、业务中断及其他损失。担保与责任限制的具体范围以 [Apache-2.0](LICENSE) 许可证第 7 至第 9 条为准。

WechatVibe 为独立项目，与腾讯、微信没有官方隶属、合作或背书关系。相关名称、商标及第三方组件的权利归各自权利人所有。

## 许可

沿用上游 [Apache-2.0](LICENSE) 许可证。