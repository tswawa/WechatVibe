# 接手指南：给下一位 AI

> 基线：2026-11-19，分支 `perf/optimize-tokenizer`，HEAD 为本轮 MBTI v3 提交，PR #33 开放。
> 本文是**行动指南**：告诉你现在是什么状态、先做什么、哪些坑不能踩。
> 实现细节看 [`TECHNICAL.md`](TECHNICAL.md)（1383 行，读完无需再翻源码）；后端分层看 [`backend-architecture.md`](backend-architecture.md)；验收口径看 [`pr-integration-acceptance.md`](pr-integration-acceptance.md)。本文不重复它们。

## 1. 三十秒现状

| 项 | 值 |
| --- | --- |
| 项目 | WechatVibe，Windows 桌面 Electron 应用，**只读**本机微信 4.x 聊天，本地/API 双模式分析 |
| 当前分支 | `perf/optimize-tokenizer`（fork `nizitao/WechatVibe`，上游 `tswawa/WechatVibe`） |
| PR 状态 | [#33](https://github.com/tswawa/WechatVibe/pull/33) OPEN，head = HEAD，MERGEABLE/CLEAN |
| 版本 | `package.json` 1.3.6；「未发布」段见 `CHANGELOG.md` 顶部，含本分支全部增量 |
| 工作区 | 干净（2026-11-19 末）；无合并冲突 |
| 测试 | node/scripts/Python 套件此前全绿；本机当前 Python 全量受 safe-delete guard 抖动（非断言失败），相关文件单跑通过 |
| 模型 | 本地 Laya ONNX（3.22 亿参数）+ 2 个独立训练的小分类器（关系 v3、MBTI v3） |

**最重要的一条**：项目有很多 AI 会话的累积改动。永远先看 `git status`、`git diff` 和 `CHANGELOG.md`「未发布」段，**不要整体 stash / reset / 回滚**。

## 2. 先做这五件事

1. `git status --short && git log --oneline -8` —— 确认工作区与最近提交。
2. 读 `CHANGELOG.md`「未发布」段（约 20 条）—— 本分支相对上游的全部改动。
3. `npm run typecheck` —— 基线必须干净（约 5 秒）。
4. `npm test` —— 全套并行跑，约 8 分钟；只改一类文件时可用 `npm run test:quick`。
5. 明确任务边界再动手：**改 UI / 改推理链 / 改模型 / 解冲突** 是四种不同风险等级。

## 3. 架构速览（五层）

```
chatui/                  原生 JS 前端，无框架无构建（app.js 7400+ 行）
   ↕ HTTP /api/*         静态页由 bridge 提供
scripts/real-client-shell.cjs   Electron 窗口进程（BrowserWindow）
   ↕ launcher
bridge/*.py               Python 后端：HTTP、账号作用域、任务调度、SQLite 结果
   ↕ node_analysis.py
electron/*.ts             推理层：本地 Laya / API 连接器 / 分类与聚合
   ↕
electron/laya/*           本地 ONNX 推理 + 2 个训练小模型 + 线程调优
```

| 你的任务 | 入口文件 | 不要碰 |
| --- | --- | --- |
| 前端交互 / 展示 | `chatui/index.html`、`app.js`、`style.css` | bridge SQL、推理版本 |
| HTTP 接口 | `bridge/real_http.py`（路由）+ `backend_service.py`（业务） | 在路由里写 SQL |
| 分析结果 / 画像 | `bridge/result_store.py`、`profile_state.py`、`backend_contracts.py` | TS/Python 只改一边 |
| 本地推理 | `electron/analysis.ts`、`laya/agent.ts` | 结果持久化 |
| 训练模型 | `scripts/train-*.py` + `electron/laya/*-linear.ts` + 对应 JSON | test 集合（见 §5） |

术语（target / OTHER / fine / portrait / scope / lane）见 `TECHNICAL.md` §0.1。

## 4. 运行环境与命令

| 项 | 值 |
| --- | --- |
| Node | 22.22.2 实测可用（`package.json` 声明 24.11.1，不影响） |
| Python | `.venv/Scripts/python.exe`，3.13.0；跑 Python 一律用这个解释器 |
| 模型目录 | `.local/models/laya`，版本 `laya-multilingual-onnx@d9d003d` |
| GPU | WebGPU 可用；DirectML / CUDA 不可用（Windows Node 绑定限制） |
| 启动 | `npm start`（真实数据）/ `npm run start:test`（合成数据，不碰真实聊天） |

```bash
# 全量
npm test                     # typecheck + node + scripts + python 并行
npm run test:quick           # 跳过 typecheck，只跑 node + scripts
npm run typecheck

# 定向
node --import tsx --test tests/<name>.test.ts
.venv/Scripts/python.exe bridge/test_<name>.py

# 模型训练与闸门（详见 §5）
npm run train:relationship-linear
.venv/Scripts/python.exe scripts/train-relationship-linear.py --check
npm run train:mbti-linear
.venv/Scripts/python.exe scripts/train-mbti-linear.py --check
LAYA_MODEL_DIR=/d/project/weixinAnalyzer/.local/models/laya npm run test:model
```

**仓库用 CRLF**：`git diff --check` 要加 `-c core.whitespace=cr-at-eol`，否则新增行全被误报为尾随空白。

## 5. 训练模型：现状与铁律

两个独立小分类器在**本地分析链**里工作，均已接入、版本纳入 `ANALYSIS_VERSION`（模型一变旧缓存自动重建）。**API 画像链仍走固定题面，不使用它们**——这是刻意架构，不要"统一"。

| 模型 | 版本 | test | 产物 / 推理 / 训练 |
| --- | --- | --- | --- |
| 关系分类 | `relationship-linear-v3-17bc5623` | 317/350 = 90.57%，r9 盲测 92% | `electron/laya/relationship-linear-model.json` / `.ts` / `scripts/train-relationship-linear.py` |
| MBTI 证据 | `mbti-linear-v3-d5e77a1f` | 93/96 = 96.88% | `electron/laya/mbti-linear-model.json` / `.ts` / `scripts/train-mbti-linear.py` |

完整方法学与历史见 `docs/laya-relationship-linear.md`、`docs/laya-mbti-linear.md`、总入口 `docs/laya-training-handoff.md`。

### 铁律（违反会毁掉评估可信度）

1. **test 只做一次性闸门**。看过 test 结果后不得再改特征/参数重试；要迭代就另起全新盲测批次。
2. **选型只用 train CV + validation**；validation 拟合温度时不改 argmax。
3. **语料变更必跑近重复检查**：既要字符二元组 Jaccard < 0.65，也要 `SequenceMatcher` < 0.75。"左右换字"的句式 Jaccard 低但 SeqMatcher 可达 0.9，仍是泄漏。
4. **TS 与 Python 必须数值一致**。契约测试会逐条比对整个 test 集；只改一边必挂。MBTI 的 cue 是轴隔离的，TS 要按轴分别加（共享 n-gram 算一次 + 每轴 `@` cue）。
5. **合成语料指标 ≠ 真实聊天准确率**。汇报时必须区分。
6. **不要微调 `model.onnx`**——仓库没有训练图/优化器/权重导出工程。

**备份可回滚**：`.local/v2-backup/`、`.local/v3-backup/`（关系），`.local/mbti-v1-backup/`（MBTI）。

**下一步真正瓶颈**：合成语料已到词面天花板（关系 v4 试过，validation 只 +1/136，属噪声）。突破需要用户明确授权的真实会话标注集（200+ 条，人工标 5 类关系），按 60/20/20 隔离。**未授权前不要读取或保存用户聊天原文**。

## 6. 本分支已交付的功能（PR #33）

按提交顺序：

| 提交 | 内容 |
| --- | --- |
| `634a2b1` | 合并上游 1.3.0（README 徽标冲突取并集） |
| `405cdc8` | 会话报告导出：自包含 HTML，数据取屏幕已加载内容，本地拼装 + IPC 写盘 |
| `9e0250b` | 画像页「关系倾向」卡：聚合逐条关系判定，群聊隐藏 |
| `82024a5` | 关系分类器 v3（拒绝侧结构特征） |
| `bd9ceda` | MBTI 分类器 v2（轴特定 cue） |
| 本轮 HEAD | MBTI 分类器 v3（扩 train 72 行 + r3 盲测 24 行） |

更早的改动（主题色、助手执行步骤、加密落盘、本地标签修复等）见 `CHANGELOG.md`「未发布」段。PR 评论逐条说明了功能与验证，勿重复发同样的评论。

## 7. 常见坑（都踩过）

| 坑 | 症状 | 解法 |
| --- | --- | --- |
| 代理 `127.0.0.1:5041` 间歇挂掉 | git push 报 schannel 握手失败 / HTTP2 framing / CONNECT 502 | 先 `curl -x` 与直连对比；直连通就摘代理：`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy git -c http.sslBackend=openssl push`；用只读 `gh api` 核对远端 SHA，别重推 |
| `gh api` 可用但 git 不行 | 两者网络栈不同 | gh 只用于读状态 / 发评论，push 仍走 git |
| `"type":"module"` 下 UMD 模块 | `require("./chatui/report.js")` 返回空对象 | 浏览器挂命名空间 `window.Report`；测试用 vm 沙箱读 `module.exports` |
| 画像/标签取数 | 直接调 `/api/profile` 会触发新一轮分析 | 导出/展示类功能只读 `labelState.results`、`cachedProfileFor()`，不要产生新任务 |
| Electron 测试渲染 | 环境变量 `ELECTRON_RUN_AS_NODE` 导致 Electron 当 Node 跑 | `env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe ...` |
| 动画 / 大 pptx | 属跨项目记忆，不在本仓库 | 见用户级 MEMORY.md，勿在本项目尝试手写 `<p:timing>` |

## 8. 协作与交付约定

- 用户偏好：**极简、结构化、中文、无 emoji**；先给结论，再给必要上下文。
- 改完必须验证：定向测试 + `npm run typecheck`；功能改动跑全套 `npm test`。
- 交付时说清：改了哪些文件、验证结果、是否提交/推送、PR 状态。
- 提交/推送/发 PR 评论属于外部操作——**用户确认后再做**；一次推送失败先诊断网络，不要盲目重试。
- 每次实质工作后往 `.workbuddy/memory/YYYY-MM-DD.md` 追加日志（append-only）。该目录被 `.gitignore` 忽略，不是缓存，不要删。

## 9. 下一步候选

按优先级，供接手时选：

1. **真实标注集**（P0）：需用户授权 + 人工标注，是关系模型突破 90% 的唯一可靠路径。
2. **PR #33 合并**：当前 MERGEABLE/CLEAN；合并前在 upstream 侧确认冲突状态。
3. **UI 露面的后续**：关系倾向卡已上线；可考虑把 MBTI 四轴证据、评分置信度也做轻量展示（只读已加载数据）。
4. **性能**：`docs/performance-analysis.md` 与 `npm run benchmark:laya-threads`；线程缓存已收敛到 4，改判定要升 `TUNING_VERSION`。
5. **MBTI v4**：v3 已 96.88%，test 96 条粒度 1.0%；继续前先确认 val/test 是否还有空间，避免重蹈关系 v4 的噪声覆辙。
