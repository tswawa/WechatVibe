# WechatVibe（nizitao 的个人 fork）

上游仓库：[tswawa/WechatVibe](https://github.com/tswawa/WechatVibe)。

本 fork 在上游 **v1.3.0** 的基础上（`perf/optimize-tokenizer` 已把上游 1.3.0 合并进来），
放进了我们自己提给上游的修复和一套自用改动，方便自己构建、也给朋友用。
上游的功能说明、下载安装、隐私与免责声明请以上游仓库为准。

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

### 五、潜台词与沟通建议并进助手（工作区未提交）

画像页那张「潜台词与沟通建议」卡已移除 —— 连同场景选择、「开始分析」/「重算」、重算反馈对话框和设置里的「分析我自己的对话风格」开关（`analyzeSelfStyle`），`chatui/app.js` 里那一段渲染/轮询代码与 `.guidance-*` / `.feedback-modal-*` 样式一并删除。这份能力现在只从**助手**进入：

- **内置技能 + 内置助手**：新增「潜台词与沟通建议」技能与「沟通参谋」助手（`bridge/advisor_contracts.py`），助手用自己的模型逐条解读潜台词、给局势判断和沟通建议，并给出可直接发出的回复草稿；默认按普通联系人，说明是与领导 / 上级时改用更稳妥、留余地的说法，证据不足时直说不确定。
- **可引用已有结果**：这个会话若曾生成过分析，助手本轮就能在资料里读到它（`api_guidance_latest` 按会话取最新一条 → `guidance_material()` 渲染 → 附在托管资料末尾，占用同一个上下文预算），不必重新花钱分析；没有存量结果且本轮选了该技能时，助手会被告知「尚无结果」并自行分析。
- **注意**：原生成链路 `POST /api/model-guidance` 现在**没有界面入口**（接口、契约、存储与测试都保留，存量结果仍会被助手引用）。如果你想在面板里保留一个「生成 / 重算」按钮，说一声我加上。

回归：`bridge/test_api_guidance.py`（17 例）、`bridge/test_advisor_guidance_reference.py`（5 例）、`tests/api-persona-ui.test.cjs`（48 例）；`npm run typecheck`、`npm run test:node`（595/595）与除上游自带 `test_advisor_*.py` 外的 Python 全量都通过。

### 六、链接不进分析（工作区未提交）

聊天里的链接不再参与任何分析：逐条情绪 / 意图标签（本地 Laya 与 API）、沟通建议、API 画像、助手资料都一样 —— 送进模型的文本先去掉链接；一条消息若**只有链接**（或只有链接加标点、只是 `[链接]`/`[文件]` 这类微信占位），就不再作为分析目标，不产生结果也不消耗调用。界面显示的原文、已存结果与画像的来源指纹仍是原文，不受影响。

判定范围刻意收窄：只认 `http://`、`https://`、`www.` 开头的链接（尾部的 `。，` 等标点留给句子），**裸域名**（如 `mp.weixin.qq.com/s/…` 不带协议头）暂不处理，纯标点消息也照旧算内容（`？？？` 这类承载语气）。如果你发现自己转发的链接多数没有协议头、仍被分析，说一声我把裸域名判定加上。

回归：`bridge/test_message_input.py`（规则本身）、`bridge/test_real_backend.py`（本地链路跳过 + 送模型文本无链接）、`bridge/test_api_insights.py`（API 标签目标与 payload、沟通建议 `insufficient`）、`tests/message-picking.test.cjs`（前端判定与手选）。

### 七、与上游的已知分歧

保留自用判定逻辑会带来两处可预期的不一致，下次升级上游时需要留意：

- 情绪题是 **8 个桶**（`caring` 取代 `affectionate`，`surprised` 从 `amused` 拆出），上游是 7 个。
  因此 `tests/api-portrait-classifier.test.ts` 的两处断言按本 fork 的题库调整过（59 改 60、`affectionate` 改成 `caring`）。
- 逐条显示走宽情绪题 `EMOTION_QUESTION`，上游的逐条显示仍走 18 个立场词；标签 schema 本 fork 是 `generic-v10`，上游是 `generic-v9`。

升级上游时的做法（v1.2.4 与 v1.3.0 两轮实际用的）：从目标版本开分支（v1.3.0 这轮直接 `git merge upstream/main`），
上游已经覆盖的功能**直接取上游**，只按功能重贴上面这些 fork 独占块；比对时用 `git diff -w` 过滤行尾噪声，
行尾已经归一化的文件可以先把三方都转成 LF 再合并；最后跑 `tsc`、Node 与 Python 全套。
Python 侧注意 `scripts/run-python-tests.py` 是**串行遇错即停**，要用 `--only` 逐个文件确认其余文件真的跑过。
v1.2.0 上那份原始补丁仍原样存档在 [`selfuse/v1.2.0`](https://github.com/silicon-sbt/WechatVibe/tree/selfuse/v1.2.0) 分支，仅作历史对照，不再维护。

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
| `perf/optimize-tokenizer` | 本轮分支：手选消息 / 模型来源多配置 / MBTI 门槛修 + 分词优化，已合并上游 1.3.0（[PR #33](https://github.com/tswawa/WechatVibe/pull/33) 开放） |
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

## 许可

沿用上游 [Apache-2.0](LICENSE) 许可证。