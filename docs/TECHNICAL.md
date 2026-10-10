# WechatVibe 技术文档（完整版）

> 目标读者：需要在本项目内做功能开发、修bug、扩展或代码审查的工程师与 AI 助手。
> 本文档目标是：**读完后无需再打开任何源文件**，即可准确回答关于本项目的功能、实现细节、边界与扩展方式的问题。
> 代码基线：`package.json` version `1.2.4`，分支 `perf/optimize-tokenizer`（fork 自 `nizitao/WechatVibe`，上游 `tswawa/WechatVibe`）。
> 文档中所有 `路径:行号` 均以该基线为准；行号可能随改动漂移，以函数/符号名为准。
> **当前工作区含未提交改动**：API 沟通建议（guidance）功能已接线并补齐测试，测试体系改为三套并行。本文档已按该状态撰写，差异见 §11.5。

---

## 0. 阅读指引与术语约定

### 0.1 术语表（全文统一）

| 术语 | 含义 | 代码中的名字 |
| --- | --- | --- |
| **bridge** | Python 后端 HTTP 服务进程（回环监听），承载微信只读读取、任务调度、结果存储 | `bridge/chat_server.py` 启动的进程 |
| **launcher** | 启动/复用/停止 bridge 的 Python 脚本 | `scripts/start-real-client.py` |
| **analysis worker / analyzer** | 被 bridge 以子进程拉起的 Node 推理进程，执行本地 Laya 或调用 API | `bridge/analysis_server.ts`（由 `bridge/node_analysis.py` 管理） |
| **Electron 主进程** | 桌面外壳，只负责拉起 launcher 并开窗 | `scripts/desktop-main.cjs` |
| **Electron shell** | 实际窗口进程（BrowserWindow），加载 bridge 提供的本地页面 | `scripts/real-client-shell.cjs` |
| **chatui** | 前端静态页面（原生 JS，无框架无构建） | `chatui/` |
| **本地模式 / local** | 使用本地 Laya ONNX 模型推理 | `sourceId = "local:laya"`，常量 `LOCAL_SOURCE_ID` |
| **API 模式 / api** | 调用外部模型服务推理 | `sourceId` 为 32 位十六进制串 |
| **target / TARGET** | 「被分析方」消息（单聊=对方，群聊=当前选定成员；群整体时只有 OTHER 侧） | 消息的 `side == "other"` 且满足成员过滤 |
| **OTHER / SELF** | 消息归属方向：对方 / 自己 | `side` 字段，取值 `other` / `self` |
| **fine / 消息标签** | 逐条消息的情绪 + 意图短标签 | `fine_results_v1`、`messageLabelsOnly=True` |
| **portrait / 画像** | 好感度、MBTI、雷达六维、摘要、关键词 | `GET /api/profile`、`api_portrait_v1` |
| **subject** | 画像主体：单聊=会话；群聊=群整体（`subject=""`）或某成员（`subject=成员 wxid`） | |
| **scope（作用域）** | 结果隔离键，见 §6.5 | |
| **Laya** | 项目的本地多语言 ONNX 推理模型（3.22 亿参数，Metaspace BPE + 分类头） | `electron/laya/` |
| **classify（分类器）** | Laya 的问题-选项打分模式：每题输出选项概率，不生成自由文本 | `electron/laya/agent.ts` |
| **lane** | analysis_server.ts 内按命令类型划分的并发通道 | |

### 0.2 约定

- 「后端」= bridge（Python）；「推理层」= `electron/`（Node/TS）；「前端」= `chatui/`。
- 「上游微信」指本机已登录的 Windows 微信 4.x 的数据文件；本项目**只读**。
- 本文不重复 `README.md` 的用户操作说明，只描述实现。

---

## 1. 项目概述与核心目标

### 1.1 一句话定义

WechatVibe 是一个 **Windows 桌面 Electron 应用**，只读读取本机已登录的 Windows 微信 4.x 聊天数据，在**本地**（Laya ONNX 模型）或**外部 API**（Anthropic / OpenAI Responses / Chat Completions / Gemini / Ollama 兼容接口）完成聊天内容的情绪与意图识别，并输出人物画像（好感度、MBTI 聊天推测、六维互动风格雷达、常见词、摘要）与群聊画像。

### 1.2 核心目标与设计约束

1. **只读与本地隐私**：不写上游微信任何文件；本地模式只监听回环地址；清除账号只删本项目派生数据。
2. **可离线的确定性体验**：默认路径完全本地，模型可单独下载安装（599 MB ZIP），不依赖外网。
3. **结果可续算**：分析任务基于 SQLite 落库的状态与游标增量推进，切换会话/重启软件不重算历史。
4. **本地与 API 规则一致**：API 模式复用本地的问题树与打分派生函数，产出用同一套公式，保证两种模式结果口径一致。
5. **严格的输入输出契约**：跨进程（HTTP / JSONL）传递的一切结构都有版本号、校验函数与 `outputError` 路径，宁可整体失败也不返回部分或编造结果。

### 1.3 明确不做的事

- 不提供聊天记录导出功能；不自动发送微信消息。
- 不做 OCR、不恢复引用消息原文之外的任何信息（见 `bridge/message_input.py` 的边界声明）。
- 不支持微信 3.x、非 Windows 平台、非 x64。

---

## 2. 运行环境与平台约束

| 项 | 要求 | 代码依据 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 x64 | 大量 `winreg`、`rstrtmgr.dll`、`kernel32`、`st_file_attributes & 0x400` |
| 微信 | Windows 微信 **4.x**（实测 4.1.15.13），不支持 3.x | `native-reader/wr/discovery.py` 依赖 `db_storage` 私有布局 |
| Node.js | 24.11.1（源码运行） | `package.json:9-11` |
| Python | 3.14（正式构建）；本机 3.13 也可跑测试 | `python-requirements.lock.txt` |
| 内存 | 8 GB 起步（模型加载约 647 MB + 每 worker 一份） | `electron/laya/runner.ts:86-88` |
| 磁盘 | ≥4 GB（应用 + 模型），聊天缓存另算 | README |

Python 依赖（锁定，`python-requirements.lock.txt`，安装需 `--no-deps`）：
`cffi`、`comtypes`、`cryptography`、`jieba`、`numpy`、`opencv-python`、`pillow`、`psutil`、`pywin32`、`uiautomation`、`wechatauto-replica==1.2.2.6`、`zstandard`。

Node 依赖：`onnxruntime-node@1.30.0`、`@huggingface/tokenizers@0.2.0`、`openai`、`@anthropic-ai/sdk`、`@google/genai`、`ollama`、`undici`；开发依赖 `electron@44.4.3`、`electron-builder`、`typescript@7`、`tsx`。

---

## 3. 整体架构

### 3.1 进程拓扑

```
┌───────────────────────────────────────────────────────────────────────┐
│ Electron 主进程  scripts/desktop-main.cjs                             │
│  · 设置 userData = <root>/.local/real-client-shell（按安装目录分实例） │
│  · execFile(python, [start-real-client.py, --no-open, --json])        │
│  · 校验 {version:"real-ui-1", url, instanceId(64hex), created}        │
│  · 写回 env: CHATUI_PORT / WECHATVIBE_INSTANCE_ID / _BRIDGE_CREATED  │
│  · require("./real-client-shell.cjs") 打开窗口                        │
└───────────────┬───────────────────────────────────────────────────────┘
                │ 启动/复用
                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ launcher  scripts/start-real-client.py                                 │
│  · Windows 命名互斥锁 Local\HaoGanDuRealClient-<sha256[:24]>            │
│  · 端口：default_port(root)=20000+sha256(root)[:8]%40000，冲突时派生候选 │
│  · 写 .local/real-client-runtime/bridge-<pid>.json（含 control_token，  │
│    用 whoami+icacls 设置当前用户 DACL）                                │
│  · 启动 bridge/chat_server.py；health 校验 version/instanceId/appVersion│
│  · --stop-owned-bridge 只停自己创建且 PID 创建时间匹配的进程           │
└───────────────┬───────────────────────────────────────────────────────┘
                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ bridge（Python，ThreadingHTTPServer，127.0.0.1:<port>）                │
│  ├─ 静态服务 chatui/（含 .js/.mjs 的 MIME 特判）                       │
│  ├─ 业务服务 Backend（单类，3240 行）                                  │
│  ├─ WeChatSource ── 只读适配 wechat_source.py                          │
│  │    └─ snapshot_cache / cache_source / live_source                   │
│  │         └─ wechatauto-replica + native-reader/wr                    │
│  ├─ ResultStore（SQLite：.local/real-client-data/<sha256(account)>.sqlite3）
│  ├─ BatchEngine / BatchStateStore（本地批处理与累计）                  │
│  ├─ ApiTaskCoordinator + ApiAnalyzerPool（API 任务与限流）             │
│  └─ NodeAnalysis × N ── JSONL over stdin/stdout ──► analysis_server.ts │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ 每行一个 JSON
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│ analysis worker（node --import tsx bridge/analysis_server.ts）          │
│  · 懒加载 electron/analysis.ts（本地 Laya）与 electron/model-*.ts（API）│
│  · ONNX Runtime 会话（WebGPU 优先，回退 CPU）                          │
│  · 每个命令最多 10 并发（model:list/test 最多 2）                       │
└───────────────────────────────────────────────────────────────────────┘

前端 chatui/：由 Electron BrowserWindow 加载 http://127.0.0.1:<port>/，
通过 fetch 调 bridge 的 /api/*；通过 preload 暴露的 window.desktopHost
调用 Electron 能力（更新、模型下载、目录选择、复制草稿、退出）。
```

### 3.2 分层与依赖方向

依赖必须自上而下，不得反向：

```
chatui (浏览器 JS)
   │ HTTP /api/*
   ▼
real_http.py（传输层：参数、响应、请求生命周期）
   ▼
backend_service.Backend（应用服务：账号作用域、任务协调、画像派生）
   ├── result_store / batch_state（存储）
   ├── conversation_selection / account_api / history_browser（会话与账号）
   ├── model_source / local_model_source / model_install（模型源）
   ├── node_analysis（推理进程适配）  ──JSONL──► analysis_server.ts
   └── wechat_source（微信只读适配）
            ├── snapshot_cache / cache_source（密文快照与缓存库）
            ├── live_source（密钥获取）
            └── wechatauto-replica / native-reader.wr（底层）

electron/*（推理层，Node ESM/TS，被 analysis_server.ts import）
shared/*.ts（跨层契约，仅被 TS 侧 import；前端未复用，见 §11.3）
```

硬性约束（来自 `docs/backend-architecture.md` 与各模块 docstring）：

- 传输层不做 SQL、不管理模型进程；服务层不读微信原库、不做底层 Node 通信；存储层不调模型、不读微信原库。
- 契约模块（`message_contracts.py` / `portrait_contracts.py` / `guidance_contracts.py` / `backend_contracts.py` 中的纯函数）不得反向依赖服务、存储、进程适配器。
- **导入任何模块都不应启动数据库、模型或网络请求**（`chat_server.py:2`、`node_analysis.py:3`、`api_tasks.py`）。

---

## 4. 目录与模块清单

### 4.1 顶层目录

| 目录/文件 | 作用 |
| --- | --- |
| `bridge/` | Python 后端（62 文件，约 20 240 行，含测试） |
| `electron/` | TS 推理层（33 文件，约 6 094 行），`electron/laya/` 是 vendored + 本地改动的 Laya 运行时 |
| `chatui/` | 前端静态页面（7 文件，约 9 663 行，其中 `app.js` 约 5 800 行、`style.css` 3 187 行） |
| `native-reader/wr/` | 独立编写的微信只读底层库（15 文件，约 3 096 行）：SQLCipher 页解密、只读 SQLite 查询层、发现、快照、WAL 解析、窗口遥测 |
| `shared/` | TS 契约（`contracts.ts` 377 行、`message-input.ts` 237 行） |
| `src/lib/labels.ts` | 标签常量（81 行），供 TS 侧复用 |
| `scripts/` | 桌面壳、启动器、构建/发布、更新、模型下载、目录白名单清单、各类回归测试 |
| `tests/` | Node/TS 与前端逻辑测试（33 文件） |
| `docs/` | `backend-architecture.md`（分层与流程）、`startup-diagnostics.md`、`releases/` |
| `licenses/` `THIRD_PARTY_NOTICES.md` | 第三方许可 |

### 4.2 `bridge/` 模块职责表

| 模块 | 职责 | 不应承担 |
| --- | --- | --- |
| `chat_server.py` (40) | 进程入口：注入消息分类器、启动 HTTP 服务 | 业务逻辑（仅保留 `classify()` 的 XML 启发式） |
| `real_http.py` (~560) | 路由分发、参数校验、静态文件、安全头、control token 校验 | SQL、模型进程 |
| `real_backend.py` | **纯兼容门面**，只 re-export；真实装配在 `real_http.main()` | 任何新增业务 |
| `backend_service.py` (3 240) | `class Backend`：账号作用域、任务注册/优先级/并发、消息标签与画像编排、缓存管理、进度统计、画像派生 | 微信原库读取、底层 Node IO |
| `backend_contracts.py` (276) | 纯契约与派生函数：`MessageWindow`、`ModelSourceUnavailable`、错误码、亲和度/MBTI/情绪派生、画像预算公式 | IO |
| `node_analysis.py` (524) | Node 子进程生命周期、JSONL 请求/响应、流式回调、崩溃恢复、结果校验 | 账号结果库访问 |
| `result_store.py` (~1 400) | SQLite 建表/迁移、所有结果读写事务 | 模型调用、微信读取 |
| `batch_engine.py` (277) | 本地批处理引擎：增量扫描、批次规划、调用推理、提交 | HTTP、界面状态 |
| `batch_state.py` (628) | 批处理状态机：表结构、`_merge` 累计、`_combined_result` 跨片合并、游标幂等校验 | 调度 |
| `profile_state.py` (68) | 增量充分统计量 `empty_state` / `add_result` / `traits_from_state` | IO |
| `profile_signals.py` (90) | 关键词（jieba）、摘要、风格校验 | IO |
| `api_tasks.py` (120) | API 任务注册表、锁、条件变量、运行计数、失效判定 | 业务模型调用、SQL |
| `api_pool.py` (180) | API-only analyzer 池、租约、限流自适应升降 | 业务逻辑 |
| `api_portrait_statistics.py` (252) | API 分片适配：信号校验、`append_batch` 累计、画像派生（无 IO） | 模型请求、DB IO |
| `guidance_contracts.py` (188) | 沟通建议契约（`GUIDANCE_REVISION = "api-guidance-v2"`） | 服务、IO |
| `message_contracts.py` (95) | 消息标签契约：`FINE_LABEL_SCHEMA="generic-v9"`、`API_INSIGHT_REVISION="free-label-v6-compact"` | 服务、存储 |
| `portrait_contracts.py` (83) | 画像契约：`API_PORTRAIT_REVISION="portrait-v2"`、evidence ledger v3、`mbtiBasis` | 服务、存储 |
| `message_input.py` (360) | 消息身份/来源/时间/引用元数据的校验与投影；**模型可见文本的单一来源**（剥离链接与占位，见 §6.11）（纯契约层） | 微信读取、媒体解码、OCR |
| `message_results.py` (108) | Node 单条结果的纯校验（版本、schema、分布、groundedIntent） | IO、调度 |
| `model_source.py` (464) | 多条 API 模型源配置（增删改查/选择）+ Windows DPAPI 加密 API Key 存储 | 调度 |
| `local_model_source.py` (86) | 本地模型目录选择与状态（downloaded / bundled / custom） | — |
| `model_bundle.py` (38) | 模型目录完整性与 pin 校验（基于 `scripts/model-files.json`） | — |
| `model_install.py` (91) | 从 Release ZIP 安装模型到 `.local/models/laya` | — |
| `cache_source.py` (96) | 上游 DB 缓存库封装 | — |
| `snapshot_cache.py` | 密文快照存储与账号清理 | — |
| `live_source.py` (624) | **微信 DB 明文密钥获取**（内存有界扫描 + 缓存），非数据源聚合器 | — |
| `wechat_source.py` (~1 300) | 只读适配：账号身份、会话、消息、历史分页、联系人、头像、媒体 | 分析结果存储、推理调度 |
| `history_browser.py` (249) | 多分片 keyset 归并分页、关键词/日期搜索、游标编解码 | — |
| `conversation_selection.py` (119) | 「信息列表」已选会话集合（独立表，只存 session id） | — |
| `account_store.py` (288) | 账号索引 `accounts.json`、账号派生数据删除 | — |
| `account_api.py` (147) | 账号管理 API 逻辑：列出/清除当前或非当前账号、`exitApp` 决策 | — |
| `data_root_source.py` (127) | 聊天记录根目录：自动发现 + 手动设置 | — |
| `windows_file_owners.py` | Restart Manager 查询文件句柄占用进程（只读） | 关闭/重启任何应用 |
| `instance_identity.py` (11) | `instance_id(root)` 与 `default_port(root)` 的确定性派生 | — |
| `wechat_bridge.py` (~250) | **遗留独立 sidecar 脚本**（JSONL over stdin/stdout），打包进运行包但主链路不使用 | — |
| `test_*.py` (22 文件) | Python 单元/契约回归 | — |

### 4.3 `electron/` 模块职责表

| 模块 | 职责 |
| --- | --- |
| `analysis.ts` (~1 118) | 本地 Laya 模型单例与生命周期（懒加载、加载进度、provider 切换、竞态防护）、内存缓存（各 5 000 条）、三个分析入口 + 批量入口、token 预算守卫 |
| `model-connectors.ts` (636) | 五种 API 协议的网络边界：URL 校验、同源校验、响应体 2 MiB 上限、流式与「假流」兼容、错误归一化（13 种错误码）、模型列表与连通性探测 |
| `api-message-insights.ts` (393) | API 逐句标签：提示词、ID 混淆防护、三级降级解析、标签规范化 |
| `api-insight-stream.ts` (68) | 增量 SSE 文本 → 已完成标签（手写括号栈扫描器） |
| `api-insight-stream` / `api-insights.ts` | 兼容 façade（re-export） |
| `api-guidance.ts` (~400) | **API 沟通建议生成**（潜台词解读 + 场景化建议），已正式接线：`analysis_server.ts` 的 `model:guidance` + `bridge/guidance_contracts.py` + `result_store.api_guidance_*` |
| `api-portrait-classifier.ts` (255) | 一次 API 调用完成 Laya 全问题树（59 题）打分；分数归一化为概率后复用本地路由 |
| `api-portrait-evidence.ts` (287) | 旧 API 画像协议的证据台账（抽取/校验/压缩）——**当前桌面画像路径不调用** |
| `api-portrait.ts` (243) | 旧 API 画像综合与溯源校验——**当前桌面画像路径不调用**，保留兼容 |
| `api-analysis-json.ts` (54) | 共享纯函数：JSON 解码（含容忍单个 ```json 围栏）、短标签校验、精确键集校验 |
| `local-message-insights.ts` (65) | 本地逐句标签的问题构造与答案处理 |
| `laya/runner.ts` (187) | **自写** ONNX 会话：provider 选择、探针批、串行化前向、CPU 回退 |
| `laya/agent.ts` (156) | vendored：一次 `predict` 的完整编排（prepare → 分批 run → 答案格式化） |
| `laya/prompt.ts` (122) | vendored+优化：prefix/state 序列构造、token 预算、collate |
| `laya/tokenizer.ts` (281) | vendored+缓存：Metaspace BPE 编码、自实现 added-token 匹配、FIFO 编码缓存 |
| `laya/questions.ts` / `types.ts` / `pyjson.ts` / `calibration.ts` | vendored：问题校验与渲染、类型、`pyJson` 兼容、softmax 与温度标定 |
| `laya/options.ts` (160) | 自写：情绪/关系/自我质量四组问题定义与权重常量 |
| `laya/catalog.ts` (158) | 自写：情绪/意图三级路由（阈值 0.65）、`INTENT_FAMILIES` 映射 |
| `laya/scoring.ts` (212) | 自写：关系分、亲密度换算、等级、self-quality、下一步建议 |
| `laya/personality.ts` (118) | 自写：MBTI 四维问题（本地版 + API 版）与证据提取 |
| `laya/style.ts` (32) | 自写：表达方式六维问题与证据提取 |
| `laya/context.ts` / `message-batch.ts` / `forecast.ts` | 自写：目标 state 构造、批量打包（码点级续算）、续写预测 |
| `laya/general-intent.ts` / `grounded-intent.ts` | 自写：通用意图候选构造（`generic-v9`）、高精度 grounded 判定 |
| `laya/expression.ts` / `social-intents.ts` / `social-cues.ts` | 自写：表达方式与人际需求路由——**当前无生产调用方（死代码）** |
| `laya/index.ts` (61) | 聚合导出 |

### 4.4 `scripts/` 关键脚本

| 脚本 | 作用 |
| --- | --- |
| `desktop-main.cjs` | Electron 主进程 |
| `real-client-shell.cjs` | BrowserWindow、BrowserView、菜单、更新控制器装配 |
| `real-client-preload.cjs` | `contextBridge` 暴露 `window.desktopHost`（17 个 API）+ 事件桥 + 外链白名单 |
| `real-client-recovery.cjs` | bridge 崩溃后的自动恢复/重启 |
| `real-client-update*.cjs` / `real-client-update-extract.py` | 更新：拉取 Release → 校验清单 → Ed25519 验签 → SHA256 校验 → 解压 → 安装 → 回滚 |
| `update-signing.pub` | Ed25519 公钥（私钥只在发布端） |
| `start-real-client.py` / `start-real-client.cmd` | launcher |
| `project_python.py` / `run-project-python.py` / `run-python-tests.py` | Python 解释器选择（`WECHATVIBE_PYTHON` → 当前 venv → `.venv`）与 Python 测试分组并行执行 |
| `run-all-tests.cjs` | **测试总入口**：先 typecheck，再并行拉起 node / scripts / python 三套，最后按耗时排序汇总 |
| `run-node-script-tests.cjs` | 桌面/更新/启动器脚本测试（`npm run test:scripts` 的实现） |
| `stage-real-client.py` | **运行包文件白名单**（见 §4.5） |
| `build-portable-clean.py` / `build-windows-release.py` / `build-model-asset.py` / `build-update-manifest.cjs` | 构建发布 |
| `setup-models.ts` | 源码模式从固定 Hugging Face revision 下载模型（支持 `.part` + Range 续传 + 三次重试） |
| `model-asset.json` / `model-files.json` | 桌面下载用的模型 ZIP 元数据 / 模型内部文件 pin（大小 + SHA-256） |
| `build-analysis-catalog.mjs` / `analysis-catalog-source.json` / `intent-display-source.json` / `social-intent-source.json` / `social-intent-catalog.mjs` | 词库生成链 |
| `export-label-library.py` | 导出词库文本 |
| `diagnose-startup.bat` | 启动诊断（不读数据库、不读 API Key、不上传） |
| `test-*.{cjs,py}` / `run-node-script-tests.cjs` | 脚本层回归 |

### 4.5 运行包白名单（新增运行模块必须登记）

`scripts/stage-real-client.py` 用显式清单定义可发布文件，缺一即构建失败：

- `SCRIPTS`（16 项）、`BRIDGE`（43 项，含 `analysis_server.ts`、`api_pool.py`、`guidance_contracts.py`）、`NATIVE_READER`（`wr/` 16 项）、`LAYA`（24 项）、`PUBLIC_FILES`（chatui 全部 + `electron/*.ts` 若干含 `api-guidance.ts` + `shared/*.ts` + `src/lib/labels.ts`）。
- 模型文件由 `scripts/model-files.json` pin 定义（`MODEL_FILES` 6 项：`model.onnx`、`onnx_config.json`、`rl_agent_config.json`、`README.md`、`tokenizer/tokenizer.json`、`tokenizer/tokenizer_config.json`），staging 时逐个校验大小与 SHA-256。
- staging 拒绝符号链接 / junction / 大小写冲突 / 意外目录；每个文件复制前后各校验一次哈希。

> **修改提醒**：新增 `bridge/*.py`、`electron/laya/*.ts`、`native-reader/wr/*.py`、`chatui/*` 文件后，必须同步更新 `stage-real-client.py` 的对应元组，否则便携构建直接失败。

### 4.6 构建与运行产物

- 开发：`npm start` = `electron .` → `desktop-main.cjs`。
- 便携构建：`npm run build:portable` → `.local/portable-builds/build-*/release/win-unpacked/WechatVibe.exe`（含模型与运行时）。
- 公开发布：`scripts/build-windows-release.py` 生成**不含模型**的标准 ZIP + 独立模型 ZIP（`WechatVibe-Laya-model-v1.zip`，599 362 786 字节，SHA-256 `abdd8bc3…24c4af`）。
- electron-builder 配置 `electron-builder.real-client.json`：`appId com.local.wechatvibe.real-client`、`productName WechatVibe`、`win.target=dir`、`executableName=WechatVibe`；`files` 只含 11 个 `scripts/*.cjs` + `package.json`；`extraResources` 把 stage 目录放到 `resources/client`，node_modules 放到 `resources/client/node_modules`。

---

## 5. 关键数据结构与接口

### 5.1 Node 分析进程 JSONL 协议

**传输**：bridge 以 `subprocess.Popen(["node","--import","tsx","bridge/analysis_server.ts", ...])` 启动，stdin/stdout 逐行 JSON（`text=True, encoding="utf-8", bufsize=1`），stderr 丢弃，`CREATE_NO_WINDOW`。
额外参数：`--provider cpu|gpu`（本地）或 `--api-only`（API 专用 worker）。
环境：注入 `LAYA_MODEL_DIR = local_model_source.status()["path"]`。

**请求**：`{"id": <int 自增>, "cmd": <string>, ...参数}`。

**响应**：
- 启动握手：`{"ready": true, "model": <ModelStatus>, "analysisVersion": "...", "apiPortraitVersion": "..."}`（无 id）。
- 正常：`{"id": N, "cmd": ..., "analysisVersion": "...", ...payload}`。
- 流式增量：`{"id": N, "streamDelta": "..."}`（**不带最终结果**，不能视为完成）。
- 错误：`{"id": N, "cmd": ..., "analysisVersion": "...", "error": "<code-or-message>"}`。
- 带模型状态的响应可含 `modelStatus` / `model`（本地 worker 才会更新状态）。

**命令清单**（`bridge/analysis_server.ts:564-720`）：

| cmd | 参数 | 返回 | 限制 |
| --- | --- | --- | --- |
| `configure-model-dir` | `modelDir`（绝对路径 ≤4096） | `modelStatus` | 非 api-only |
| `configure-runtime` | `provider` | `modelStatus` | 非 api-only |
| `prepare` | — | `model` | — |
| `status` | — | `status` | — |
| `targets` | 见 `analysis.analyzeMessageTargets` | 分析结果 | 非 api-only |
| `custom-targets` | 同上 + questions | 原始答案 | 非 api-only |
| `batch` | `messages[]`,`context[]` | `{result, consumed, contextTrimmed, targetSide, durationMs, batchVersion}` | 非 api-only |
| `forecast` | 草稿 + 上下文 | 续写预测 | 非 api-only |
| `observe`（默认） | `text` | 观察文本分析 | — |
| `model:list` | `protocol`,`baseUrl`,`apiKey` | `{models[], supported}` | api-only 探测并发 ≤2 |
| `model:test` | + `model` | `{ok, latencyMs}` | 同上 |
| `model:generate` | + `system`,`prompt`,`maxOutputTokens`(1..2048) | `{text, usage}` | — |
| `model:insights` | `messages[]`,`targetIds[]`,`contextTokens` | `{insights[], usage}`，支持流式 | — |
| `model:guidance` | `messages[]`,`targetIds[]`,`scenario`,`analyzeSelf`,`contextTokens`,`otherPortrait?`,`selfSummary?`,`feedback?` | `{guidance, guidanceVersion, usage, responseId}` | — |
| `model:portrait` | `phase:"classify"`,`messages[]`,`contextTokens` | `{result, usage}` | — |
| `model:portrait` | 其他 phase | 兼容路径（当前不用） | — |
| `model:portrait-axes` | — | 兼容路径（当前不用） | — |

**并发与超时**：
- lane 上限：API 生成类命令 `active < 10`，队列 ≤20，等待 >10 s 直接返回 `rate-limit`；`model:list/test` 探测并发 ≤2。
- Python 侧响应超时：`model:list` 16 s、`model:test` 18 s、`model:portrait?phase=classify` 270 s、`model:guidance` 240 s、其他 180 s；worker 启动等待 120 s（api-only 探测 12 s）；`analysis_version` 探测子命令 20 s。
- 版本一致性强检：每次响应的 `analysisVersion` 必须等于本地缓存的版本，否则报 `analysis version changed; restart service`。
- 过期请求 id 集合上限 256；超时后回复被丢弃，**但子进程仍在跑那条推理**（本地路径无取消）。

### 5.2 HTTP API 清单

统一约定：全部返回**顶层 JSON 对象**（`/api/health` 除外，其状态在 `data` 字段）；响应头固定 `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`；JSON 使用 `ensure_ascii=False`。POST 要求 `Content-Type: application/json; charset=utf-8`、`Content-Length ≤ 65536`、body 为不含 `texts` 键的对象。

**GET**

| 路径 | 关键查询参数 | 响应要点 |
| --- | --- | --- |
| `/api/health` | — | `{ok, data:{state,account?,error?}, model:{state,provider?,error?}, version:"real-ui-1", instanceId, appVersion}` |
| `/api/runtime` | — | `{requestedProvider, modelProvider, status}` |
| `/api/local-model` | — | `{state, source, path, labels?}` |
| `/api/data-root` | — | `{state: unset\|ready\|missing\|invalid, path, exists, accounts}` |
| `/api/model-source` | — | `{mode, api:{id,protocol,baseUrl,model,contextTokens,hasKey}\|null, profiles:[{id,name,label,protocol,baseUrl,model,contextTokens,hasKey}], label, sourceId, status}` |
| `/api/model-insights` | `user`, `ids` | `{job, results, acceptedIds, insightErrors, suspended?}` |
| `/api/model-portrait` | `user`,`member?` | `{portrait, nativeProfile, job, available, inventoryReady, progress, needsRebuild, rebuilding, suspended?}` |
| `/api/model-guidance` | `user`,`member?` | `{guidance, job, suspended?}` |
| `/api/analysis-cache` | — | `{account, sources:[{sourceId,kind,label,protocol,messageCount,portraitCount,suspended}]}` |
| `/api/sessions` | — | `{self:{username,name,avatar,avatarCandidates}, sessions[], account, messagesReady}` |
| `/api/conversation-selection` | — | `{account, initialized, selectedSessions[]}` |
| `/api/analysis-workers` | — | `{workers, max:4, elastic, limit, active, …, load_sample}` |
| `/api/api-workers` | — | `{workers, max, limit, active, spawned, rateLimitStreak, downshifts}` |
| `/api/analysis-overview` | — | `{account, totals:{conversations,…}}`（仅统计**已添加**会话） |
| `/api/analysis-performance` | — | `{account, totals, conversations}` |
| `/api/accounts` | — | `{accounts:[{accountId,wechatId,nickname,current,bytes}], currentAccountId}` |
| `/api/messages` | `user`,`limit`(≤500，默认 80) | `{messages[], account, hasMoreBefore?}` |
| `/api/history` | `account,user,before\|around,limit`(≤200) | `{messages[], hasMoreBefore, hasMoreAfter, nextCursor, oldestCursor, newestCursor, focusId}` |
| `/api/history/search` | `account,user,q,date,before,limit`(≤100) | `{messages[], hasMore, nextCursor, found}` |
| `/api/analysis` | `user`,`focus` | `{results, job, affinity, affinityCount, modelState, modelProvider, analysisVersion, mood, performance, analysisUnit, account}`（结果**剔除 score**） |
| `/api/profile` | `user`,`member?`,`retry=1` | `{analysisUnit, contact, members, mbti, affinity, mood, traits, keywords, summary, dataStatus, …}` |
| `/api/media` | `user`,`id`(64 hex) | 图片字节；失败 404 `{error, reason}` |

**POST**

| 路径 | 请求体 | 说明 |
| --- | --- | --- |
| `/api/control/shutdown` | 无 body（`Content-Length: 0`）+ 头 `X-WechatVibe-Control-Token` | 202 `{stopping:true}`；唯一需要令牌的端点 |
| `/api/analyze` | `{account,user,mode:recent\|history\|incremental,limit,targetIds?}` | 202 `{job}`；recent ≤80、history ≤5000 或 `"all"`；`targetIds` 只允许配 `mode:"recent"`，只分析列出的消息（见 §6.2 / §12.14） |
| `/api/messages/batch` | `{account, users[1..64]}` | 多会话窗口 |
| `/api/predict-reply` | `{user,account,requestId,draft≤2000,expectedLastMessageId?,member?}` | 续写预测；错误 409/422 |
| `/api/runtime` | `{provider}` | 切 CPU/GPU |
| `/api/local-model` | `{path}` | 指定本地模型目录 |
| `/api/data-root` / `/api/data-root/clear` | `{path}` / `{}` | 设置/恢复自动发现 |
| `/api/conversation-selection` | `{expectedAccount,session,selected}` 或 `{expectedAccount,all:true}` | 乐观并发校验 |
| `/api/analysis-workers` | `{workers?:1..4, elastic?}` | 落盘 `analysis-workers.json` |
| `/api/api-workers` | `{workers?:1..4}` | 落盘 `api-workers.json` |
| `/api/analysis-cache/clear` / `/resume` | `{account,sourceId}` | 清/恢复某来源缓存 |
| `/api/model-insights` | `{account,user,limit≤500,targetIds?,around?}` | 202 任务 |
| `/api/model-portrait` | `{account,user,member?,refreshAxes?}` | 202 任务（先注册 job 再准备，全历史扫描可能数分钟） |
| `/api/model-guidance` | `{account,user,member?,scenario,analyzeSelf,feedback}` | 202 任务 |
| `/api/model-source/list` \| `test` \| `activate` \| `clear-key` | `{protocol,baseUrl,apiKey,model?,contextTokens?}` | 模型发现/探测/启用/清 key |
| `/api/model-source/profiles` | `{profileId?,name?,protocol,baseUrl,apiKey?,model,contextTokens}` | 新建或更新一条 API 配置（**不切换**当前对话）；`activate` 额外接受 `name`/`profileId` 以便「保存并启用」同时落盘 |
| `/api/model-source/profiles/delete` | `{profileId}` | 删除一条 API 配置；删掉正在使用的那条会切回本地模型 |

`activate` 的三种入参互斥：`{mode:"local"}`、`{mode:"api",profileId}`（切换到已保存配置，**跳过探测**，因此是瞬时的）、`{mode:"api",...连接字段}`（必要时先探测再落盘）。带 `profileId` 时只允许 `mode`+`profileId` 两个键。

因此设置页的「保存并启用」**总是两次调用**：先 `POST /api/model-source/profiles` 落盘（新建追加一条、带 `profileId` 则就地更新，必要时探测），再用 `{mode:"api",profileId}` 切换。把连接字段直接发给 `activate` 有两个后果：带 `profileId` 的混合请求会被判成 400 `invalid model source request`（历史现象：「测试连接」成功后点「保存并启用」报「启用失败」）；不带 `profileId` 时会命中已有连接并就地更新，**不会新增一条**（历史现象：「加了新配置，但模型下拉菜单里没有」）。详见 §12.13。

`/api/model-source/*` 的响应统一是 `public()` 形状（下表最后一列），`profiles` 与 `label` 供设置页与标题栏徽标使用。

**DELETE**：`/api/accounts/{accountId}` → `{deleted,current,exitApp}`；409 `account-busy`、404、400、503。`exitApp=true` 时 bridge 异步关服。

### 5.3 SQLite 存储结构

每个微信账号一个库：`.local/real-client-data/<sha256(account)>.sqlite3`（`result_store.py:27-32`）。
连接：`sqlite3.connect(path, timeout=15)`，默认隔离级别（`with conn` 自动 commit），写入路径使用 `BEGIN IMMEDIATE`。

| 表 | 主键 | 用途 |
| --- | --- | --- |
| `results_v2` | (account, session, id, version) | 逐条分析结果 + `score`（仅 other 侧）；`version` = analysisVersion |
| `analysis_skips` | (account, session, id, version) | 跳过记录（`{state:"skipped",reason}`），如 `ObservedTextTooLongError` |
| `fine_results_v1` | (account, session, id, version) | 细粒度消息标签结果（独立于 `results_v2`） |
| `fine_skips_v1` | (account, session, id, version) | 标签跳过记录 |
| `api_insights_v1` | (account, session, **source_id**, id) | API 消息标签结果 |
| `api_portrait_v1` | (account, session, **source_id**, **subject**) | API 画像：`highwater_json/after_json/fingerprint/available_json/plan_json/batch_index/complete/processed/processed_chars/portrait_json/resume_json` |
| `api_history_inventory_v1` | (account, session, subject) | 文本总量快照（与模型来源无关，可跨来源复用） |
| `api_guidance_v1` | (account, session, source_id, subject) | 沟通建议整行覆盖（`revision/scenario/analyze_self/payload_json/updated_at`）；读取时 `valid_guidance` 校验，**损坏行直接删除并返回 None**（表现为「待分析」），绝不展示未校验内容；随来源清除 |
| `api_source_meta_v1` | (account, source_id) | 已注册 API 来源的 protocol/model |
| `analysis_cache_suspended_v1` | (account, source_id) | 被手动挂起的来源 |
| `progress_v1` | (account, session, version) | legacy 扫描进度与累计 |
| `summary_v1` | (account, session, version) | legacy 汇总快照 |
| `profile_tokens_v1` / `profile_tokens_ready_v1` / `profile_state_v1` | (account, session, version[, subject]) | legacy 画像累计状态与词频证据 |
| `batch_progress_v1` | (account, session, base_version, subject, batch_version) | 批处理游标（`cursor_*`、`char_offset`、`context_json`、`state_json`、`complete`、`legacy_max_rowid`） |
| `batch_runs_v1` | 同上 + `batch_id` | 单次批推理：`fingerprint`、`consumed_json`、`result_json`、`target_count`、`new_target_count` |
| `batch_coverage_v1` | 同上 + `message_id` | 覆盖索引：`batch_id`、`counted`、位置三元组、`score`、`mood_json` |
| `batch_fragments_v1` | 同上 + (message_id, start_offset) | 长消息分片消费记录 |
| `quoted_backfill_v1` | (account, session, base_version, subject, backfill_version) | 引用补齐游标（`ceiling_*` / `cursor_*`） |
| `conversation_selection_meta_v1` / `conversation_selection_v1` | (account) / (account, session) | 「信息列表」已选会话 |

索引：`fine_results_recent_v1` / `fine_skips_recent_v1` / `api_insights_recent_v1`（`sort_seq DESC, shard DESC, local_id DESC`）、`results_order_v1`、`results_scored_order_v1`（partial index：`side='other' AND score IS NOT NULL`）、`batch_coverage_recent_v1`、`results_profile_delta_v1`、`results_member_delta_v1`。

迁移方式：无版本号表，靠 `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 检查后 `ALTER TABLE ADD COLUMN`（例：`api_portrait_v1.resume_json`，并容忍并发首次打开的竞态）。

### 5.4 位置三元组（position）

贯穿全系统的消息位置标识：`[sort_seq: int, shard: str, local_id: int]`，其中 `shard` 必须匹配 `message__message_\d+\.db`（`batch_state.py:23`）。跨批次排序、游标推进、幂等校验全部基于它。

消息稳定 id：`message_id = sha256(json([account, user, shard, local_id, sort_seq, server_id]))`（`wechat_source.py:107-110`）。

图片稳定 id：64 位十六进制，由 `/api/media` 的签发机制约束（见 §7.6）。

### 5.5 `empty_state()` —— 画像累计状态的结构契约

`bridge/profile_state.py:5-11` 定义 17 个键，被 `batch_state._state()` 与 `api_portrait_statistics.valid_statistics()` 当作结构契约：

```
count, targetCount, scoreCount, scoreSum, scoreWeighted,
moodCount, mood{raw:{label,sum,weighted}}, latest,
emotion{}, intent{}, broad{}, words{},
styleCount, style{6 维}, axes{EI,SN,TF,JP: [left,right,evidence,insufficient]}, supported
```

### 5.6 作用域（scope）键

结果隔离由四类键共同决定，任一变化即产生全新结果（旧结果保留但不被复用）：

| 维度 | 取值 | 出现位置 |
| --- | --- | --- |
| 账号 | `account`（= 账号目录名，`wxid_xxx_1234`）+ `workdir` 解析后路径 | 所有表主键、`Backend._scoped_identity()` |
| 模型来源 | `sourceId`：`"local:laya"` 或 32 位 hex | `api_insights_v1`、`api_portrait_v1`、`api_guidance_v1` |
| 分析版本 | `analysisVersion`（Node 侧 `ANALYSIS_VERSION`，含 catalog 版本） | `results_v2`、`batch_*` 的 `base_version` |
| 契约修订 | `free-label-v6-compact` / `portrait-v2` / `api-guidance-v2` | 拼成 `scope = sourceId + ":" + REVISION` |
| 批次版本 | `message-batch-v1` | `batch_*` 主键 |
| 分类器版本 | `apiPortraitVersion`（Node 侧） | `resume_json.portraitStatistics.classifierVersion` |
| 画像主体 | `subject`（群成员 wxid 或 ""） | `api_portrait_v1`、`profile_state_v1`、`batch_*` |

### 5.7 前端视图状态

`chatui/view-state.js` 提供 `ViewState.create(domain)`，四个域：`chat` / `labels` / `portrait` / `settings`。
`set(key, value)` 有字段白名单校验；`advance(key)` 只增不减；`reset(...)` **禁止重置请求计数器**（防竞态）。
前端本地持久化仅 5 个设置项（`localStorage["real-ui-settings-1"]`：`theme/zoom/intent/backgroundAnalyze/analyzeSelfStyle`）+ 已读水位 + 画像展示快照。

`chat` 域另有两个「选择消息」态字段：`messagePicking`（是否处于手选态）与 `selectedMessageIds`（勾选的消息 id 集合）。二者不落盘，只活在当前会话窗口内，见 §12.14。

---

## 6. 主要业务流程与调用链路

### 6.1 启动链路

```
npm start / WechatVibe.exe
 → desktop-main.cjs：设 userData、解析 python/node 解释器、删除继承的 CHATUI_PORT
 → execFile(start-real-client.py --no-open --json)
     → launch_mutex（Windows 命名互斥，30 s）
     → health(GET /api/health)：version/instanceId/appVersion 三者匹配才算 ready
     → 端口选择：saved-port.json → 占用探测 → 128 个派生候选（写 selected-port.json）
     → 启动 chat_server.py，写 bridge-<pid>.json（含 created_filetime + control_token，DACL 保护）
     → 轮询 health 直到 ready（START_TIMEOUT=20 s）
 → desktop-main 解析 JSON，注入 env，加载 real-client-shell.cjs
 → BrowserWindow 打开 http://127.0.0.1:<port>/
 → 前端 startInitialLoad()：/api/health → /api/sessions → /api/messages 三步启动遮罩
 → 账号校验通过 → 解锁 UI（account / sessions / messages 三个 step）
```

失败处理：launcher 启动失败会主动停止自己创建并记录在案的 bridge（仅按 PID 创建时间 + 镜像路径 + argv + instanceId + control token 校验，绝不按进程名或端口 sweep）；Electron 初始化失败时只关闭本次创建的 bridge（`bridgeCreated` 标志）；复用已有服务时不会把它当成本次新建去关闭。

### 6.2 本地消息标签 / 画像分析链路（主路径）

```
POST /api/analyze {account,user,mode}
 → real_http.do_POST → Backend.start()
     · 校验账号作用域（_scoped_identity + _assert_scope）
     · cache_suspended(local) → 直接返回 suspended
     · version = analyzer.analysis_version()
     · job key = (account, store.path, user, version)
     · 已存在任务 → 改需求不重启（扩 limit / 切 incremental / 加入 recheck 集合）
     · 新建 job 入 self.jobs，_enqueue((key,mode,limit,store,job,scope))
 → worker 线程（threading.local 绑定 worker index）
     · load_condition 上等待 index < worker_limit（elastic 模式动态）
     · 非阻塞取会话级 key lock（拿不到就重新入队 + sleep 0.02）
     · _run_one → _run_incremental
         · _run_quoted_backfill（引用文本补齐，冻结前缀内游标）
         → BatchEngine.incremental(user)
             · ensure() 载入/播种 batch_progress_v1
             · highwater = source.history_highwater(user)
             · 循环：history_page(...) → 跳过已完成 → 打包
                 → BatchEngine.infer()
                     · NodeAnalysis.analyze_batch(session, messages, context≤3)
                         → JSONL {"cmd":"batch"} → analysis_server.ts
                             → laya/agent.predict → packMessageBatch → ONNX 前向
                     · 消费 consumed[]，生成 record
                     · batch_id = sha256([account,user,version,subject,BATCH_VERSION,consumed摘要])
                     · BatchStateStore.commit()：BEGIN IMMEDIATE + 幂等校验 + _merge/_combined_result
             · mark_complete()
 → GET /api/analysis?user=
     · results（results_v2 + fine_view，剔除 score）
     · affinity = affinity_from_progress(state)、mood、performance、job 进度
```

**优先级与并发**：
- 任务优先级 `0..3`：`recent-window`/交互式且已聚焦 → 0；`recent-window`/交互式未聚焦 → 1；其余聚焦 → 2；`batch-subject` 聚焦 → 2；其余 → 3。
- `_focus()` 切换焦点时**原地重排 PriorityQueue**（`heapq.heapify`），不重启迭代器。
- 同一会话串行（key lock），不同会话并行。
- `worker_limit = 1 if not elastic else worker_count`，`worker_count ∈ [1,4]`（默认 1）。
- **elastic 模式**：`_load_monitor` 每 30 s 采样 psutil（CPU/内存）+ `nvidia-smi`（GPU/显存，timeout 5 s），连续 2 个 busy 样本降到 0，连续 2 个 calm 样本升 1；自身负载被扣除，只按「其他程序」节流。阈值：busy CPU 85 / MEM 90 / GPU 85 / 空闲显存 2048 MiB；calm CPU 55 / MEM 80 / GPU 55 / 空闲显存 3072 MiB；显存 < 1024 MiB 或 GPU ≥95 % 直接降到 0。

**手选消息（`targetIds`）**：`mode:"recent"` 可附带 `targetIds`，只分析列出的那些消息（界面上是「选择消息」工具条，见 §12.14）。

- 校验在**入队前**（`Backend.start` → `_resolve_selected_targets`）：id 必须是 1..`limit` 个唯一字符串，且能在 `source.messages(user, limit+3)` 的**尾部 `limit` 条**（即 `/api/messages` 交给界面的同一个窗口）里按 `side=="other" && kind=="text" && text.strip()` 找到。窗口外的 id 回 400 `analysis target is no longer in the current window`，格式非法回 400 `invalid analysis targets`，不会留下「排队成功但永不分析」的任务。
- 调度复用 `recent-windows` 状态：`_schedule_recent(selected=…)` 把 id 并入 `state["selected"]`；下一趟迭代器由 `_run_selected_targets` 承担（有 `batch_engine` 时走 `_analyze_fine_item` 的 fine 路径，否则走单条画像路径），上下文取该消息前 3 条，`total/processed` 只统计选中的条数。
- 该集合在创建迭代器时被 `pop`，因此**紧接着的自动窗口扫描不会被历史选择收窄**（否则用户退出选择态后新消息再也不打标签）。
- 前端把 `limit` 收敛为 `max(1, min(80, 已加载条数 - 最早被选位置))`，超出尾窗的 id 提交前就被丢弃并在工具条上提示；两条提交路径都复用既有函数（本地 `analyzeRecent`、API `submitApiInsightJob`），不新增端点。

### 6.3 API 消息标签链路

```
POST /api/model-insights {account,user,limit,targetIds?,around?}
 → Backend.start_model_insights()
     · 校验 limit/targetIds/around；二次 _scoped_identity + api_lock 复核 mode/source_id
     · 窗口：around ? browse_history(limit=500) : source.messages(user,500)
     · eligible = side=="other" && kind=="text" && text.strip()
     · selected = eligible[-limit:] 或按 targetIds 顺序
     · known = store.api_insight_known(...)；pending = selected - known
     · wire：batch_window 带全部历史；只有 pending 的 id 挂 inputMeta
     · job 注册进 api_tasks.insight_jobs[key=(account,user,source_id)]，api_tasks.begin() 起线程
     · 无 pending → 立即 done
 → 线程 _run_model_insights()，最多 API_INSIGHT_RETRY_MAX+1 = 6 次尝试
     · ApiAnalyzerPool.lease(timeout=180)  ← 池化租约保证并发上限
     · NodeAnalysis.model_insights(..., on_delta=回调)
         → analysis_server.ts "model:insights"
             → api-message-insights.analyzeApiInsights（stream=true）
                 → model-connectors（Responses / Chat Completions 支持真流式）
                 → api-insight-stream 增量解析 → streamDelta 回传
     · on_delta：在 api_lock 内校验 job 身份后整体重写 job["partialText"]（流式临时显示）
     · 最终响应：normalize_api_insight → 完整性检查 → store.save_api_insights
     · 错误分类：timeout/network/rate-limit 可重试（间隔 2 s）；格式类错误立即失败
     · rate-limit → api_pool.note_rate_limited()（连续 2 次 → limit-1；连续 8 次成功 → limit+1）
 → GET /api/model-insights?user=&ids=  ← 前端轮询（400 ms 起指数退避到 2 s）
     · 返回 job（含 partialText 流式中间态）+ 已确认 results
```

关键保证：`partialText` **只存在于内存 job，绝不写 SQLite**；每次重试前清空；`job_identity` 用对象身份而非 key 判断，A→B→A 场景下旧 job 的迟到响应会被判失效。

### 6.4 API 画像链路

```
POST /api/model-portrait {account,user,member?}
 → Backend.start_model_portrait()：先注册 job（phase="preparing"），再准备
 → _run_model_portrait → _run_model_portrait_scoped
     → _prepare_model_portrait()
         · classifier_version = api_portrait_analyzer.portrait_version()
         · rebuild = 已有统计但 valid_statistics(…, classifier_version) 为假 → 丢弃旧游标/账本（保留展示画像）
         · highwater == 已有 highwater → 直接 done（无变化不调模型）
         · 冻结历史 _api_portrait_history(page_size=1000)
             · 每行 → evidence JSON [id, side, senderId(sha256 前16), kind, text]
             · 双摘要：full_digest（全量）/ delta_digest（after 之后）
             · 长消息按 API_PORTRAIT_PIECE_CHARS=800 切片（携带 _pieceIndex/_last/_rowIndex/_sort/_before）
             · 字节预算超限时只保留计数（纯 inventory）
             · tail hash 链 api_portrait_tail_hashes() 用于续算锚点校验
         · 预算换算 api_portrait_wire_chars(ctx, reserved=10240)
               = min(600000, max(1024, (ctx-10240)*55//100))；ctx<12288 → context-too-long
         · 切批 api_portrait_plan(pieces, wire_chars)（单批 ≤20000 片，总批数 ≤4096）
         · fast_resume 校验 7 项（batchIndex/pieceOffset/tailHash/skipPieces/after/partialSort…）
         · inventory 快照复用最多等待 30 s
     → for batch:
         · 仅当批内有 target 且文本非空才调 classify_portrait_batch（纯背景批不花钱）
             → analysis_server.ts "model:portrait" phase=classify
                 → api-portrait-classifier.classifyApiPortraitBatch
                     · 一次调用回答 59 题（14 基础 + 情绪细分 + 意图 group/detail）
                     · 返回 {"answers":{qid:{label:0-100}}}，程序归一化为概率
                     · routedAnswers：喂给本地 routeIntent/routeEmotion（阈值 0.65、条件加权完全一致）
                     · 不发送输出上限（Anthropic 例外，最多 32768）；超时 240 s
         · api_portrait_statistics.validate_batch_signal() ← 唯一的付费重试边界
         · api_portrait_statistics.append_batch() → 复用 batch_state._merge / _combined_result
         · api_portrait_checkpoint(resume={portraitStatistics, portraitContext, batchIndex, tailHash…})
             与游标在同一事务原子提交
         · job 更新 rateTextsPerSecond、processedTargetTexts…
 → GET /api/model-portrait
     · profile_from_statistics()（复用本地派生函数）→ nativeProfile
     · needsRebuild：分类器版本漂移且已有画像 → 提示用户点「更新画像」
```

**续算机制**：进度锚点由 `api_portrait_resume_anchor(piece, piece_offset, batch_index, tails)` 生成（`after = _sort if _last else _before`；`skipPieces`、`tailHash`）。恢复时重新扫描历史并校验 `tailHash`、`scan_fingerprint`、`API_PORTRAIT_COUNT_KEYS`，任一不符即判定源变更并从 `after` 之后增量续算。历史源缩减（`current_highwater < existing.highwater` 且未完成）报 `unfinished portrait source changed`。

**API 画像的硬门槛**：`contextTokens ≥ 12288`（`MIN_CONTEXT + RESERVED(10240) + 2048`）；不足时前端显示提示并禁用画像；完整画像需要 59 题全部作答。

### 6.5 沟通建议（guidance）链路

`POST /api/model-guidance {account, user, member?, scenario, analyzeSelf, feedback?}`
（`scenario` ∈ `general | leader`，默认 `general`；`analyzeSelf` 默认 false；键集合受白名单约束）

```
POST /api/model-guidance
 → Backend.start_guidance()
     · 注册 api_tasks.guidance_jobs[key=(account,user,source_id,subject)]，api_tasks.begin() 起线程
     · 窗口 = source.messages(user, 160) 倒序累计至 24 000 字符
     · eligible = side=="other" 且非空 且 ≤ MAX_SUBTEXTS(12)；群成员场景需 senderId == member
     · eligible 为空 → 直接返回 {id:null, status:"insufficient"}（不花钱）
 → 线程 _run_guidance()（重试 API_MODEL_RETRY_MAX=10 / 5 s；rate-limit → api_pool.note_rate_limited()）
     · 组装 payload：otherPortrait（对方画像摘要）+ selfSummary（自身风格摘要），
       两者取自消息标签使用的同一份 portrait summary，保证建议与画像卡不会描述同一个人 differently
     · 前端把消息 ID 换成提示词内短别名（g1,g2,…），真实 ID 只存在于程序内部
     · NodeAnalysis.model_guidance() → JSONL {"cmd":"model:guidance"}
         → electron/api-guidance.analyzeApiGuidance（GUIDANCE_VERSION="api-guidance-v2"，
           GUIDANCE_MIN_CONTEXT=8192，GUIDANCE_TIMEOUT_MS=180000）
     · 双重校验：Node 侧已规范化 → Python 侧再验一次
         ① response.guidanceVersion == GUIDANCE_REVISION，否则 guidance-version-invalid
         ② valid_guidance(guidance)，否则 invalid-guidance
         ③ subtexts 的 id 必须互不重复且 ⊆ target_ids（未知编号不转交给别的目标）
 → store.api_guidance_save(scope=source_id+":"+GUIDANCE_REVISION, subject, guidance) 整份替换
 → GET /api/model-guidance（画像页卡片已移除，见下；接口保留给存量结果、测试与直接调用）
```

**场景语义**：`general`（普通联系人）/ `leader`（与领导、上级）——后者要求保留对方面子、先接住责任再谈条件、不做无边界退让。

**`feedback` 字段**：`POST /api/model-guidance` 仍接受 `feedback`（≤400 字）→ 提示词明确它是**用户本人写的修正要求而非聊天内容**，并要求在与聊天证据冲突时**以证据为准**。它原先由画像页的「重算」对话框（`#btnRecomputeGuidance` + `#feedbackModal`）收集，该界面已随卡片一并移除（见下），现在只有测试与直接调用会用到它。

**契约保证**：解读与建议来自**同一次 provider turn**，因此一起校验——不可能出现「存储的解读与旁边建议互相矛盾」；`analyzeSelf=false` 时 `forSelf` 必须为 `null`（缺失自我段绝不能被渲染成「没有问题」），多余的自我段属契约违规。任务自身有独立注册表，切换模型来源时与其它模型任务一同失效（`api_tasks.invalidate_models` / `invalidate_source` 都会清 `guidance_jobs`）。

**现在谁在用这份能力**：画像页的 `#guidanceCard` 已移除 —— 连同 `#selectGuidanceScenario`、`#btnRunGuidance`、`#btnRecomputeGuidance`、`#feedbackModal` 与设置里的「分析我自己的对话风格」开关（`analyzeSelfStyle`），`chatui/app.js` 里那一整段渲染/轮询/提交代码和对应样式也已删除。潜台词与沟通建议只从**助手**侧进入，两条路一起用：

- **助手自己生成**：内置技能 `builtin-skill:guidance`（「潜台词与沟通建议」）+ 内置助手 `builtin:guidance`（「沟通参谋」），定义在 `bridge/advisor_contracts.py`；助手用自己的模型与托管资料产出解读与建议。因此 `POST /api/model-guidance` 目前**没有界面入口**。
- **引用存量结果**：`result_store.api_guidance_latest(account, user)` 按会话取最新一条（不限模型来源；会话级 `subject` 优先于成员级；坏行直接删掉），`guidance_contracts.guidance_material(saved)` 把它渲染成一段参考文字，`advisor_service._guidance_material()` 附在托管资料末尾并从**同一 token 预算**里扣除。没有存量结果**且本轮选了该技能**时，改附一行 `GUIDANCE_MISSING_NOTE`，让助手直接分析当前会话。

### 6.6 会话添加与「信息列表」

```
GET /api/sessions                     → 会话目录（不含消息）
POST /api/conversation-selection {expectedAccount, session, selected}
     · 乐观并发：读/写/写后三次复核当前账号
     · selected=true 必须存在于 source.sessions()
POST /api/conversation-selection {expectedAccount, all:true}  → 一键添加全部
```
移除会话**不删除**缓存或画像；`/api/analysis-overview` 只统计已添加会话。

### 6.7 账号切换与清除

- **多账号**：每个账号独立 SQLite（文件名 = sha256(account)）；切换账号触发前端 `resetAccountView`，后端 `_assert_scope` 在每次读操作后复核，变化即 `AccountChangedError` → HTTP 409。
- **清除当前账号**：`pause_for_account_clear`（closing=True → 取消 API 源工作 → 等 API 空闲 200 s → 停 worker → 等在途请求归零 200 s）→ 写 `no-auto-recovery.json` → 删除派生数据（≤180 s）→ `backend.shutdown()` → 响应 `exitApp=true` → 关服；启动器因该标记**拒绝自动恢复**。
- **清除非当前账号**：每 0.5 s 复查该账号是否变成当前账号 / 是否有 running/queued 任务，冲突抛 `AccountConflict`（409）。删除范围：结果 `.sqlite3`（含 `-journal/-wal/-shm`）、稳定密钥文件、快照目录树；**从不触碰微信源文件**；每个文件删除前重跑路径安全校验（拒绝 symlink / `FILE_ATTRIBUTE_REPARSE_POINT` / junction，逐级向上验证根路径）。

### 6.8 模型下载与安装

两条入口，能力不同：
1. **应用内下载**（`real-client-model.cjs` + `bridge/model_install.py`）：读取 `scripts/model-asset.json`（固定 URL + 字节数 + SHA-256）→ 下载到 `.local/model-downloads/` → 校验大小与 SHA-256 → 交给自带 Python `model_install.py` 解压：ZIP 内必须恰好是 `laya/` 下 6 个 pin 文件、逐个校验大小与 SHA-256、解压到临时目录后 `os.rename` 就位；失败清理临时目录。安装到 `.local/models/laya`。**不保留断点续传**。
2. **源码模式**（`npm run setup:models`，`scripts/setup-models.ts`）：从固定 Hugging Face revision 逐文件下载，保留 `.part`、支持 Range 续传、失败最多三次；默认目录 `.models/laya`，可用 `LAYA_MODEL_DIR` 或 `--dir` 覆盖。

模型目录优先级（`electron/analysis.ts:248-258`）：`configureModelDir` 覆盖 > `LAYA_MODEL_DIR` > `process.resourcesPath/models/laya`（仅打包且非 defaultApp）> `cwd/.models/laya`。选择结果持久化在 `.local/real-client-runtime/local-model-source.json`（`{schema:1,path}`），跨更新保留。

### 6.9 应用更新链路

```
前端 checkForUpdates → ipc → real-client-update*.cjs
 → 拉取 GitHub Release（沿用系统代理）
 → 资产必须包含：update-manifest.json / update-manifest.sig / <zip> / SHA256SUMS.txt
 → 校验清单 schema {schema:1,product,version,platform:"win32",arch:"x64",layout:"win-unpacked",dataSchema:"real-client-v1",archive:{name,size,sha256}}
 → Ed25519 验签（公钥 scripts/update-signing.pub，私钥只在发布端）
 → 校验 SHA256SUMS.txt 与 zip 大小/哈希
 → 保留用户数据与模型（.local/**、.models/**、.local/models/laya）
 → 解压 → 安装 → 重启；失败自动恢复旧版；成功后可回滚到上一版（仅保留最近一次）
```
模型 ZIP 与应用更新是两条独立链路；更新过程不触碰已下载模型。

### 6.10 图片与媒体

```
历史/消息分页时：仅 local_type==3 的图片写入 source.issued_images（LRU，MAX_ISSUED_IMAGES=2048）
GET /api/media?user=&id=  → 校验签发与身份 → 返回 PNG 字节
未签发/身份不符 → 404 {error:"media unavailable", reason: invalid-id|not-issued|identity-mismatch|…}
```
即「必须先在某一页看到过该图片，才能取到图」；深链接或刷新后 404 属设计内行为。

---

### 6.11 链接与占位不进分析

一条消息里的链接**不进模型**：分析的是消息本身，URL 是噪声；API 模式下它还是不该外发的内容。规则只有一处来源 —— `bridge/message_input.py`：

- `strip_links(text)`：去掉 `http(s)://…` 与 `www.…` 开头的连续字符（到空白为止，**尾部的 `。，` 等标点留给句子**）。**裸域名（如 `mp.weixin.qq.com/s/…`）不去**：太容易误伤正常文本，需要时再单独放开。
- `analysis_text(text)`：`strip_links` 之后再判断「整条是否只是微信占位名」（`[链接]`/`[文件]`/`[音乐]`… 白名单见 `PLACEHOLDER_NAMES`）→ 是则返回 `""`。占位消息多数已被 `chat_server.classify` 归为 `kind == "other"`（`<appmsg>` 会取标题归 other），所以这条主要是兜底。
- `has_analysis_content(text)`：`analysis_text` 之后还有非空白内容才算「可分析」。**纯标点仍算内容**（`？？？` 承载语气，与既定规则一致）；唯一被排除的是「去掉链接后只剩标点」的整条链接消息。

落点（模型侧一律拿 `analysis_text` 的结果，界面与已存结果保持原文）：

| 链路 | 判定 / 剥离位置 |
| --- | --- |
| 投影层（本地标签、API 标签、助手资料） | `message_input.prepare_item` / `to_wire`：返回副本的 `text` 就是模型可见文本 |
| 本地逐条标签目标 | `_run_visible_priority`、`_run_fine_recent`、`_run_selected_targets`、`_resolve_selected_targets`（手选 400 也走同一判定）、`batch_engine.text_items`、`result_store.advance` 的 `eligible_count` |
| API 逐条标签 | `start_model_insights` 的 `eligible` + 手工组装的 wire |
| 沟通建议 | `start_guidance` 的窗口（`analysis_text` 后为空即整条丢弃）与 `eligible` |
| API 画像 | `_api_portrait_history`：片段 `text` 用 `analysis_text`；**digest 仍取原文**（改链接仍算来源变化），只含链接的消息不再是 target、也不产生片段 |
| 预测回复 | 窗口内每条消息都保留（草稿回复的是最后一条），但 `context` 里的文本已剥离链接 |
| 前端「可分析」判定 | `chatui/app.js` 的 `hasAnalyzableText`（`stripMessageLinks` / `messageAnalysisText`）—— `fineWindow` 候选、`pickableMessage`、`apiInsightCandidates` |

前端那份是**同规则的复刻**（跨端常量在本项目一贯如此），改动时两边一起改（见 §12.15）。注意 `updateLabel` / `updateApiInsightLabel` 里的 `eligible` 还管**已存标签的渲染**，不参与这里的收窄 —— 否则旧结果会突然消失。

## 7. 核心算法与业务逻辑

### 7.1 Laya 推理链路（本地）

```
LayaAgent.predict(state, questions)
 ├ prepare: stateIds = encode(serializeState(state))        ← 同一 state 只编码一次（本地优化）
 │           for each question: buildSequence(...) → 校验选项数是否超预算
 └ for chunk in chunks(batchSize=8): runner.run(collate(chunk, padId)) → formatAnswers
```
- `serializeState`：字符串原样，否则 `pyJson`；**一次推理只有一个 state**（target-first 文本或 forecast 对象）。
- `buildPrefix`：`[CLS] <type> question: <instructions> [SEP] ([MASK] opt0 [MASK] opt1 …) [SEP]`；每选项 `maskId + encode(" "+opt)[:48]`；预算不足时二次压缩（每选项下限 4，head 下限 8）。
- `buildSequence`：state **右截断**到剩余预算，末尾补 `[SEP]`，整体再截断；`markers` 过滤越界项。
- 张量：`input_ids`/`attention_mask` int64、`marker_pos` int64、`marker_mask` **bool**、`qtype` int64。
- 输出：`logits`（每个 MASK 一行）+ `act_logits`（动作概率，取第 0 位）。
- 答案解码：`choice` 取 argmax；`score` 取 `Σ i·p_i`；`noul` 取 `p[1]`；confidence = `1 − H(p)/log(k)`。
- 温度标定：`z = logits / max(1e-3, temperature[qtype 或 temperature_by_options[bucket]])`。
- **批量大小**：生产用 `BATCH_SIZE = 8`（基准：WebGPU batch 8 ≈ 91 decisions/s，14 题画像集在 8 达峰 ~106/s，16 反而回退；CPU 恒定 ~11.6/s）。
- **provider**：`auto`（默认，Windows 优先 WebGPU，回退 CPU）/ `cpu`；创建后跑一次探针批（rows=2,length=8,markers=3）验证；运行期 WebGPU 抛错且允许回退时，重建 CPU 会话并重跑同一批。
- **并发**：JSONL 主循环串行 + `runner.run` 串行 + `predict` 串行 → **本地并发恒为 1**。14 题 OTHER 消息还要叠加 `routeIntent`/`routeEmotion` 的多次 detail 前向。
- **tokenizer**：Metaspace BPE（`@huggingface/tokenizers`），自实现 added-token 两阶段匹配（lstrip/rstrip 按 Unicode `White_Space` 扩展），编码结果 FIFO 缓存 256 条（超长 4096 id 不缓存）。
- 缓存键：`sha256(ANALYSIS_VERSION + sessionId + msg.id + side + text + 前 6 条上下文 [+ portrait] [+ "message-labels-only"+schema])`；缓存条目各 5 000；`cacheEpoch` 保证 reset 之后的迟到结果不污染缓存。

### 7.2 分析路由（阈值 0.65）

- **情绪**：`EMOTION_QUESTION` 先在 7 个 bucket（`happy/affectionate/neutral/amused/sad/anxious/angry`，共 40 叶）中选；`max(prob) ≥ 0.65` 取 1 个 bucket，否则 2 个；再 `emotionDetailQuestion(bucket)` 二阶段细分（18 个中文具体词）。叶分数 = `parentP × conditional`。
- **意图**：`INTENT_GROUP_QUESTION` 在 12 个 family 上判定，`0.65` 阈值选 1-2 个 family → group 取 top2 → `leafQuestion` 细分（547 个叶 id，命名 `${group}_${slug}`）。
- **表达方式 / 人际需求**：三级路由实现完整（`routeExpression` / `routeSocialIntent`，含表达×需求联合题），但**当前无生产调用方**。

### 7.3 逐条消息得分与亲密度

```
messageScore = clamp(Σ P(relationship) × RELATIONSHIP_WEIGHT, −1, 1)
RELATIONSHIP_WEIGHT = { romantic: 1.0, warm: 0.55, neutral: 0.0, distant: −0.45, rejecting: −1.0 }
```
**情绪不参与关系分**（设计上只用关系信号）。

亲密度（生产路径 `affinity_from_progress`）：
```
count = scoreCount
count == 1 → weighted = scoreSum
else      → weighted = (0.5*scoreSum + 0.5*scoreWeighted/(count-1)) / (0.75*count)
affinity  = round(50 + 50 * clamp(weighted, −1, 1))
```
其中 `scoreWeighted` 是**线性递推加权和**（rank = 0,1,2,…,n−1），与逐条追加等价。`count == 0 → None`；群整体返回 None。

等级：`gradeFor(affinity)`：S≥85、A≥70、B≥58、C≥45、D≥32、否则 E。
前端展示：5 级心轨 `素昧平生 / 泛泛之交 / 初识相知 / 友善默契 / 亲密无间`，`level = min(5, floor(score/20)+1)`。

`selfQualityScore`（关系质量）：`SELF_QUALITY_WEIGHT = {connected:1.0, empathic:0.9, off topic:0.3, pressuring:0.15, offensive:0.0}`，等级 SSS≥0.90 / SS≥0.80 / S≥0.68 / A≥0.55 / B≥0.42 / C≥0.28 / D。

`nextStepFor`（下一步建议）：固定句选择器，优先级 = 自我行为问题 → 拒绝 → 疏远 → 意图类（求安慰/给安慰/调情/做计划/提问）→ romantic → 默认；**故意不使用 affinity**。

### 7.4 批处理累计（`batch_state._merge`）

同一批 N 条 target 共享一次模型判断时，用闭式公式一次算完，与逐条调用数学等价：

- `count += N`；`targetCount += N`
- 分布：`state[field][label] += N × probability`（**质量累加，不是概率平均**）
- 关键词：`words[word] += count`（整数计数）
- 关系分：`scoreSum += N×score`；`scoreWeighted += (N×rank + N(N−1)/2) × score`，其中 `rank = scoreCount − len(tail_scores)`；再补 `sum(tail_scores) × N`（乱序回填）
- 情绪 mood：同样用 `rank_sum = N×rank + N(N−1)/2` 闭式加权；主情绪以 `rawLabel` 归并（跨版本稳定）
- 风格六维：`style[key] += N × value`
- MBTI 四轴：`insufficient ≥ max(left, right)` → 只累加 `insufficient`；否则累加 left/right 质量并置 `supported = True`
- **群整体（`is_group and not subject`）在累计情绪/意图后直接返回**——整群可混合情绪/意图，但没有群体 MBTI

`_combined_result(fragments)`：跨批长消息分片按长度加权合并（emotion/intent/broad 按 rawLabel 聚合质量；score 仅当所有片都是有限数；styleEvidence / personalityEvidence 仅当所有片键集完整）。

### 7.5 MBTI 推导

```
MIN_PERSONALITY_MESSAGES = 100   # 解锁所需有效文本条数
MIN_AXIS_EVIDENCE        = 30    # 每轴所需证据条数
MIN_AXIS_MARGIN          = 0.2   # 两侧份额差值下限
```
每轴：`left_share = left/(left+right)`（需 `evidence ≥ 30` 且 mass>0）；若 `left_share` 为空或 `|left_share − right_share| < 0.2` → 该轴 `None`（未确定）。
`inferred_type` 仅在 `eligible ≥ 100` 且四轴全部确定时给出。
状态：`estimated`（有类型）/ `insufficient`（<100 条）/ `partial`（够 100 条但有轴未定）。
附加信息：`basis:"chat-inference"`、`theory:"MBTI preferences"`、每轴证据数、`sources`（myersbriggs.org / themyersbriggs.com）。
**群整体不生成个人 MBTI**；群成员画像正常生成。

模型侧（`personality.personalityEvidenceFromAnswers`）：先过 **scope 门槛**（"sender states a recurring personal preference" 概率 > "no enduring preference stated"），否则整体弃权；每维返回 `{left, right, insufficient}` 三元分布，**不产出 MBTI 字母**。

**两套题面（有意设计，非重复代码）**：

| | `PERSONALITY_QUESTIONS`（本地 Laya） | `API_PERSONALITY_QUESTIONS`（API 分类器） |
| --- | --- | --- |
| 版本串 | `MBTI_QUESTION_VERSION = "mbti-chat-evidence-v3"` | `API_MBTI_QUESTION_VERSION = "mbti-api-context-v2"` |
| scope 题判定 | 仅接受「本人明确说出偏好」 | 「本人明确说出，**或在整批消息里反复表现出同一倾向**」；判定的是**存在性**——任一轴有反复模式即选是 |
| 选项标签 | `[不足, 左极, 右极]` | **完全相同**（因此共享转换函数与已落库的 evidence 契约不变） |

原因：聊天记录里极少出现教科书式的自我描述，坚持「必须明说」会让所有轴永久未定。API 题面每轴都指明要看什么（谁发起话题、自愿带来什么信息、争执时给出的理由、计划如何收口），并明确排除角色责任、话题类型与单次情绪。
**版本隔离**：`API_MBTI_QUESTION_VERSION` 只进入 `API_PORTRAIT_CLASSIFIER_VERSION`，因此版本变化只会让 **API 画像**标记为 `needsRebuild`，**本地 Laya 画像缓存不受影响**。

### 7.6 雷达六维与摘要

`STYLE_LABELS`（六维）：`socialEnergy 表达活力`、`humor 幽默表达`、`composure 情绪平和`、`initiative 话题主动`、`care 关怀支持`、`affection 亲近表达`。

```
traits_from_state: val = round(100 × style[key] / styleCount)  → 附 key/label/val/sampleCount
```
`styleCount == 0 → []`。

关键词：`jieba.lcut`（缺失则正则降级）→ 过滤停用词（18 个）→ 只保留 `^[\u4e00-\u9fff]{2,8}$` 或 `^[a-z]{3,24}$` → 按 `(-count, word)` 排序取前 6 且 `count ≥ 2`。

摘要（`summary_from_aggregate`）：
```
已分析 {count} 条{该联系人|群内成员}消息，
常见交流意图为 {top broad}，
情绪信号以 {mood.label} 为主，
常见用词有 {top3 词}。
```
（各段按可用性省略；群整体用「群内成员」，单聊用「该联系人」。）

情绪（`mood_from_progress`）：与亲密度同构的加权（和 0.5 + 递推加权和 0.5），返回 `{label, rawLabel, kaomoji, sampleCount, scope:"analyzed-history"}`；`MOODS` 7 种情绪各配颜文字。

### 7.7 批次打包与码点级续算（`message-batch.ts`）

```
packMessageBatch(messages, budget)
 · 对每条消息二分查找可容纳的码点数，再线性回退最多 32 个码点以利用 BPE 合并
 · 不允许后面的消息越过被部分消费的消息
 · 背景上下文从最老开始丢弃，置 contextTrimmed
 · 单码点都放不下 → MessageBatchInputError
```
`BatchMessage.offset` 记录已消费码点；Python 侧严格校验 `consumed` 覆盖性与分片连续性（`startOffset` 必须等于已存 `MAX(end_offset)`）。

### 7.8 API 画像的分数归一化与路由复用

模型只返回每题的**相对权重**（0-100 整数），程序：
1. `normalizedAnswer`：键先精确匹配、再去空格小写折叠匹配；也接受与标签等长的数组按位置对应；**只统计 > 0 的权重**；归一化成概率；`act_probability = 1`。
2. `answerFor`：**基础问题缺失即 `outputError`**；条件分支缺失或全 0 → 返回 `null`（跳过该分支，不改用模型另选的分支，也不把缺项补 0）。
3. `routedAnswers`：把归一化后的答案喂给**本地真实**的 `routeIntent` / `routeEmotion`，因此阈值、条件加权、排序与本地模式完全一致。
4. 群聊（`subjectKind === "group"`）时 `personalityEvidence = null`。

**MBTI 分类规则（`api-portrait-classifier.ts` 的 `rules`，API 题面专用）**：
- 把整批当作**一份累积记录**读：优先采信明说的偏好，否则从跨话题、跨情境的重复行为推断；普通计划、单次回复、一次性情绪仍不构成偏好；**绝不默认选第一极**。
- **区分信号与情境**：在场的人、话题、关系、发送者角色（工作/闲聊/群聊）能解释消息的大部分，只有剥离这些解释后仍成立的部分才计分。必需的工作回复、对客户的回复、对上级的回复**不是**偏好。
- **考虑反例**：某轴在部分情境有支撑、部分没有时，该轴由「无偏好」选项胜出。
- **权重分摊而非表态**：证据混合时把权重摊到两个极，而不是硬选一个；**只有整批都成立的偏好才给 80 分以上**；四轴独立判断，可用同一次回答的一致读法。

**提示词必须与消费端的三道机制对齐**（`mbti-api-context-v2` 的改动依据，`rules` 与题面都按此重写）：

| 机制 | 代码位置 | 对打分的含义 |
| --- | --- | --- |
| scope 是四轴总闸 | `personalityEvidenceFromAnswers` | 「有偏好」权重必须**严格大于**「无偏好」，否则整个 `personalityEvidence=null`，本批四轴**全部**记为证据不足且永不累积。因此只要任一轴有反复模式就应选是，不能因多数消息平淡而弃权 |
| `insufficient` 是悬崖门控 | `batch_state._merge` | `insufficient >= max(左, 右)` 时该轴只累加「证据不足」计数，**不做任何比例累积**——它是整轴作废开关，不是稀释项。混合证据要摊在**两个极之间**，摊给「无偏好」会直接毒化该轴 |
| 差值门槛 | `mbti_from_totals` | `leftShare = 左/(左+右)`，`abs(leftShare-rightShare) < 0.2` 即判未定。50/50 必然报未知，因此证据确实指向某极时应给出约 **60/40 或更强**的倾斜 |

因此 API 画像的 MBTI 判定比本地更宽松，但通过 0.2 差值、30 条证据、100 条解锁三道本地门槛后收敛到同一口径。

因此 **API 模式不生成好感度总分、雷达总分、人格字母或自由画像**；好感度/MBTI/雷达/摘要全部由本地累计函数从同一份统计量派生（`profile_from_statistics`），`mbti` 门槛与本地完全一致（100 条 / 30 证据 / 0.2 差值），未新增 API 专属门槛。

### 7.9 API 消息标签的 ID 混淆防护

真实消息 id 在提示词中全部替换为 `t1,t2,…` 别名；`resolveId` 同时接受原 id、别名与 `t<数字>`；若「直接匹配」与「数字匹配」指向不同属主则返回空串判为冲突。
解析三级降级：① 整体 JSON → 扫描所有平衡括号片段逐个 parse；② 接受数组 / `{items}` / `{results}` / 单对象；③ 回退到 `编号/情感/意图` 文本块；再退到无编号顺序对齐（**必须数量完全匹配**才采用）。
`conflicting` 或任一 eligible id 缺失 → 整体 `outputError`，**绝不返回部分结果或编造**。标签统一「前 1-4 个汉字」；「无/暂无/未知/none/null/-」归一为空串。

### 7.10 词库（分析目录）生成链

```
scripts/analysis-catalog-source.json   （emotions / intentGroups / expressionFamilies / expressionGroups / expressions / expressionFaceBuckets）
scripts/social-intent-source.json      → compileSocialIntents
scripts/intent-display-source.json     （前端显示名 + legacyAliases）
        │  npm run catalog:generate（scripts/build-analysis-catalog.mjs）
        ▼
chatui/data/analysis-catalog.json（构建期被 electron/*.ts 静态 import，运行时无文件 IO）
```
当前规模：40 情绪、547 意图叶、98 表达方式、80 人际需求；同义意图共用 215 个简短显示词；表达方式 × 人际需求生成 7 840 个组合。
校验规则：intent 叶 id = `${group.id}_${slug}`；**intents 数量必须 ≥ 500**；每个 family 只能挂 1-4 个 group；display group 数必须一致；模型源中的 family→group 映射**不被校验**（可能引用不存在的 group，只在运行时崩溃）。

修改词库必须保留既有 ID，然后执行 `npm run catalog:generate`（会改变 `catalog.version`，进而改变 `ANALYSIS_VERSION`，**旧分析结果将不被复用**）。

---

## 8. 配置项与环境依赖

### 8.1 环境变量

| 变量 | 读取位置 | 作用 |
| --- | --- | --- |
| `WECHATVIBE_PYTHON` | `desktop-main.cjs:12,40,69`；`project_python.py:11`；`start-real-client.py:32` | 指定 Python 解释器 |
| `WECHATVIBE_NODE` | `desktop-main.cjs:14,70` | 指定 Node |
| `WECHATVIBE_CLIENT_ROOT` | `desktop-main.cjs:40,68` | 客户端根目录 |
| `CHATUI_PORT` | `real_http.py:441`；`start-real-client.py:343,791` | bridge 监听端口（桌面启动前会主动 delete 以重新派生） |
| `WECHATVIBE_CONTROL_TOKEN` | `real_http.py:437`（**pop 出环境**）；`start-real-client.py:47,344` | shutdown 令牌 |
| `WECHATVIBE_INSTANCE_ID` / `_BRIDGE_CREATED` | `desktop-main.cjs:92-93` | 启动身份传递 |
| `WECHATVIBE_DATA_ROOT` | `data_root_source.py:12`；`wr/discovery.py:47` | 聊天记录根目录提示/覆盖 |
| `WECHATVIBE_ANALYSIS_WORKERS` | `backend_service.py:82` | 本地分析并发（1..4） |
| `WECHATVIBE_API_WORKERS` | `api_pool.py:43` | API 池并发（1..4） |
| `LAYA_MODEL_DIR` | `electron/analysis.ts:249`；`node_analysis.py:85`；`setup-models.ts:87` | 本地模型目录 |
| `WECHATAUTO_KEYS_DIR` | `account_store.py:81` | 稳定密钥目录 |
| `WECHATVIBE_UPDATE_*` | `real-client-preload.cjs:45-46` | 更新校验模式注入 |
| `APPDATA` / `LOCALAPPDATA` / `USERPROFILE` / `SystemRoot` | `wr/discovery.py:229+`；`account_store.py:82`；`start-real-client.py:253` | 系统路径 |

### 8.2 运行时配置文件

| 路径 | 内容 |
| --- | --- |
| `.local/real-client-data/accounts.json` | `{version:1, accounts:[{accountId, account, workdir, wechatId, nickname}]}`，按 accountId 排序，临时文件 + `os.replace` 原子写 |
| `.local/real-client-data/<sha256(account)>.sqlite3` | 全部结果与进度 |
| `.local/real-client-runtime/api-model-source.json` | `{version:2, sourceId, selectedMode, profiles:[{id,name,protocol,baseUrl,model,contextTokens,encryptedKey}], sourceIds{fingerprint→id}}`；`version:1` 的单个 `api` 对象读取时自动迁移为 `profiles` 的第一项 |</new_string>
| `.local/real-client-runtime/local-model-source.json` | `{schema:1, path}`（legacy: `model-source.json`） |
| `.local/real-client-runtime/inference-settings.json` | `{"provider":"cpu"|"gpu"}`，默认 `gpu` |
| `.local/real-client-runtime/analysis-workers.json` | `{workers, elastic}` |
| `.local/real-client-runtime/api-workers.json` | `{workers}` |
| `.local/real-client-runtime/wechat-data-root.json` | `{schema:1, path\|null}` |
| `.local/real-client-runtime/no-auto-recovery.json` | 清除当前账号后的禁止自动恢复标记 |
| `.local/real-client-runtime/selected-port.json` | `{schema:1, instanceId, port}` |
| `.local/real-client-runtime/bridge-<pid>.json` | `{pid, port, instance_id, log, started_at, created_filetime, control_token}`（DACL 保护） |
| `.local/real-client-runtime/bridge-<stamp>-<pid>.log` | bridge 日志 |
| `.local/real-client-runtime/real-client-shell/` | Electron userData |
| `.local/models/laya` | 应用内下载的模型 |
| `.local/model-downloads/` | 模型 ZIP 暂存 |
| `.local/portable-builds/build-*/` | 便携构建产物 |
| `%LOCALAPPDATA%/wechatauto_keys/<account>.json` | 上游 DB 稳定密钥 |

### 8.3 关键常量与阈值

**本地推理**：`BATCH_SIZE=8`、`MAX_CACHE_ENTRIES=5000`、`DEFAULT_INTRA_OP_THREADS=4`、`interOpNumThreads=1`、`executionMode=sequential`、`graphOptimizationLevel="all"`、`MAX_PORTRAIT_CONTEXT_CODEPOINTS=120`、`MAX_PORTRAIT_CONTEXT_TOKENS=40`、`MAX_OBSERVED_CHARS=4000`、`FINE_HINT_MESSAGES=3`、`FINE_HINT_CODEPOINTS=240`、`DEFAULT_CONTEXT_WINDOW=6`、`MAX_FORECAST_CONTEXT_MESSAGES=8`、`MAX_OPTIONS=10/MIN_OPTIONS=8`、`ENCODE_CACHE_LIMIT=256`、`ENCODE_CACHE_MAX_IDS=4096`、每选项 48 token / head 下限 8 / 选项下限 4。

**网络**：`MAX_RESPONSE_BYTES=2 MiB`、`MAX_PROMPT_BYTES=3 MiB`、`MAX_MODELS=200`、`LIST_TIMEOUT_MS=12 s`、生成请求默认不设超时（交给 provider）、所有 SDK `maxRetries=0`、同源校验 + `redirect:"error"`。

**API 画像**：`API_PORTRAIT_MAX_WIRE_CHARS=600 000`、`API_PORTRAIT_BATCH_ITEMS=20 000`、`API_PORTRAIT_MAX_BATCHES=4096`、`API_PORTRAIT_PIECE_CHARS=800`、`reserved_tokens=10 240`、最低上下文 12 288、分类器超时 240 s、`OUTPUT_TOKENS=32 768`（仅 Anthropic）、`PROMPT_TOKENS=8 192`。

**重试**：消息标签 `API_INSIGHT_RETRY_MAX=5` / 间隔 2 s / 可重试 `{timeout, network, rate-limit}`；画像与建议 `API_MODEL_RETRY_MAX=10` / 5 s，格式类错误 `API_PORTRAIT_FORMAT_RETRY_MAX=2`。

**HTTP 限额**：body 64 KiB；`messages` limit ≤500；`history` ≤200；`history/search` ≤100；`analyze recent` ≤80；`analyze history` ≤5000；`model-insights` ≤500；`user` ≤256；`requestId` ≤128；`draft` ≤2000；`users` 1..64；`MAX_IMAGE_BYTES=8 MiB`；`MAX_ISSUED_IMAGES=2048`。

**并发**：本地 worker 1..4（默认 1）；API 池 1..4（默认 1）；Node lane 10（探测 2）；队列 20；排队 >10 s 返回 rate-limit；API 池租约等待 180 s；本地 worker 停止等待 200 s；清账号等待 in-flight 归零 200 s。

**两种并行度的降档机制不同（重要）**：

| | 本地分析并行数 | API 分析并行数 |
| --- | --- | --- |
| 生效方式 | 多开本地 Laya worker 进程（各约 647 MB） | 从池中租用 API-only analyzer（不加载模型） |
| 上限来源 | 本机资源 | 接口方限流 |
| 自动调节 | **「跟随负载」**（`elastic`）：按 psutil CPU/内存 + `nvidia-smi` GPU/显存采样节流 | **无跟随负载**；靠接口限流自适应：连续 2 次 `rate-limit` → `limit-1`，连续 8 次成功 → `limit+1`（不超过设定上限） |
| 界面 | 设置 → `#workerLimitValue` + `#btnToggleElasticWorkers` | 设置 → `#apiWorkerValue`（无 elastic 开关） |
| 并行粒度 | 按会话（会话级 key lock） | 按会话（同一 key 重复请求返回正在运行的 job） |

设置项持久化：本地 → `.local/real-client-runtime/analysis-workers.json`；API → `.local/real-client-runtime/api-workers.json`。

---

## 9. 外部服务与第三方集成

| 集成 | 用途 | 边界与降级 |
| --- | --- | --- |
| **Laya ONNX 模型**（`mizchi/laya-multilingual-onnx`） | 本地情绪/意图/关系/MBTI/风格判断 | ~647 MB ONNX；WebGPU→CPU 自动回退；探针批失败即换 provider |
| **Hugging Face tokenizers**（`@huggingface/tokenizers`） | Metaspace BPE 分词 | 与 Rust 版有两处已知行为分歧（lstrip 截断、空白判定），代码内自行实现规避；升级依赖需重测 |
| **onnxruntime-node 1.30.0** | 推理执行 | Windows 包仅含 CPU + DirectML，**无 CUDA**；DirectML 因算子不支持不可用；WebGPU 为默认路径 |
| **wechatauto-replica 1.2.2.6** | 上游微信 DB 打开/查询 | 只读依赖；密钥获取由本项目 `live_source.py` 承担 |
| **Anthropic SDK** | Messages API | 不支持流式；强制 `max_tokens`（画像场景最多 32 768） |
| **OpenAI SDK** | Responses + Chat Completions | 支持真流式；jsonMode；单次非流式回退 |
| **Google GenAI SDK** | Gemini | 不支持流式；`apiVersion:""` |
| **Ollama SDK** | 本地 Ollama | 不支持流式；无 key 时不加 Authorization |
| **DeepSeek**（特例） | 官方 Responses API | jsonMode 时附加 `reasoning:{effort:"none"}`（默认 thinking 会吃满输出上限） |
| **GitHub Releases** | 应用更新 + 模型 ZIP 下载 | 沿用 Windows 系统代理；Ed25519 验签 + SHA256 |
| **Hugging Face** | 源码模式模型下载 | 固定 revision |
| **Windows Restart Manager**（`rstrtmgr.dll`） | 查询文件句柄占用进程 | 只读，不关闭/重启任何进程 |
| **Windows DPAPI**（`win32crypt`） | 加密存储 API Key | 用户级加密 |
| **微信进程内存扫描** | 提取 DB 配置 cipher key | 有界扫描（30 s / 4 GiB 上限），密钥默认不落盘 |
| **jieba** | 中文分词（关键词） | 懒导入，缺失时降级为正则 |

**隐私边界**：本地模式全程本机；API 模式会把当前批聊天文本 + 简短画像参考发送到用户配置的模型服务；API 画像会按上下文容量发送所选会话的历史文本。前端**不传 API Key**（由后端从 DPAPI 存储解析后直接用于 Node 请求）。

---

## 10. 已知限制

### 10.1 功能与兼容性

- 仅 Windows 10/11 x64；仅微信 4.x（依赖 `db_storage`、`message__message_\d+\.db`、`Msg_<32hex>`、`SessionTable` 必需列、`Name2Id` 等私有布局）。微信升级即断。
- 不支持微信 3.x；不支持非 x64；不支持非 Windows。
- 时区硬编码 `Asia/Shanghai`（`history_browser.py:57`），跨时区日期搜索会错位。
- 图片消息只显示 `[图片]`；无 OCR、无动图/语音/视频内容分析。
- 回复预测 UI 已从 DOM 移除，仅残留后端 `/api/predict-reply`。
- API 画像要求 `contextTokens ≥ 12288`；完整画像需模型能回答 59 题（thinking 模型思考 token 计入同一输出上限）。
- API 消息标签每标签 ≤4 个汉字、最多 1 情绪 + 1 意图；API 模式**不生成**好感度总分/雷达总分/MBTI 字母/自由画像文本。
- 搜索在 Python 层做 `casefold` 子串过滤（`SEARCH_SCAN_LIMIT=2048`、有命中时 `early_match_scan=256`），命中稀疏可能漏结果，无法用 FTS 加速。
- `/api/media` 需先在某一页看到过该图片（LRU 签发，上限 2048）。

### 10.2 性能

- 本地推理并发恒为 1；14 题 OTHER 消息还要多次 detail 前向。实测（同一进程内交替，28 条中文消息 / 172 次 session.run）：**WebGPU ≈ 143 ms/次（24.8 s 总计），CPU ≈ 611 ms/次（105.3 s 总计），WebGPU 快约 4.3 倍**。CPU 与 WebGPU 输出 affinity 存在 1 个点差异（36 vs 35），属正常浮点差异。剩余提速手段只有 int8 量化模型。
- WebGPU EP 会忽略 `intraOpNumThreads`，调线程数对默认路径无影响。
- 切换 provider 时新旧两个 ONNX session 会短暂共存 → 峰值内存翻倍；模型本身约 647 MB/进程。
- 前端 `renderMessages` 的 appendOnly 判定是 O(n²)；画像卡片每次全量 `replaceChildren` 重建 SVG（靠 signature memo 缓解）；无虚拟滚动。
- 常驻轮询：消息 4 s、会话 15 s、全账号分析 20 s（→10 min 间隔）、总览 8 s（→60 s）、worker 设置 9 s、API 标签 0.4-2 s 退避、画像/建议 2.2 s；`document.hidden` 是唯一节流手段。

### 10.3 安全

- 除 `POST /api/control/shutdown`（64 hex control token + 回环来源 + `Content-Length:0` + 常量时间比较）外，**所有 API 无凭据**；`Host`/`Origin`/路径前缀三件套只能挡网页型 CSRF，挡不住本机其他进程。`instanceId` 只出不进。
- 静态服务无 CSP / 无 ETag / 无 X-Frame-Options；路径校验依赖 `resolve()` + `is_relative_to`，Windows 上存在「校验后替换为 junction」的 TOCTOU 窗口。
- 错误体可能回传内部异常类型与文本（`503 {error: type(exc).__name__, message: str(exc)[:200]}`）。
- 前端 0 处 `innerHTML`（全部 `textContent`），但 `<a href>` 注入面（Release 链接、MBTI 来源）与无 CSP meta 仍是残余风险；preload 有外链白名单但不阻止非白名单 URL 跳转。

---

## 11. 技术债清单

### 11.1 架构层

1. **双实现并存**：legacy 逐条分析路径（`_run_fine_recent` / `_run_visible_priority` / `_run_incremental` 的 legacy 分支 / `_run_all_history` / `_run_finite_history`）与 `BatchEngine` 路径一一对应，分叉点靠 `if self.batch_engine` 与 `callable(getattr(analyzer,"analyze_batch",None))`。删除 legacy 需要先确认无测试依赖。
2. **死代码 / 未接线模块**：`electron/laya/expression.ts`（`routeExpression`）、`social-intents.ts`（`routeSocialIntent`）；`analysis.ts` 的 `expression` / `playfulIntent` 字段恒为 `[]`（DTO、Python 校验、UI 链路仍在）。
3. **兼容路径残留**：`electron/api-portrait.ts` 与 `api-portrait-evidence.ts`（旧自由文本画像协议）当前不被桌面画像调用；`valid_api_portrait` / `empty_api_portrait`（11 字段自由文本）只作为展示快照残留；`wechat_bridge.py` 是未被主链路使用的独立 sidecar。
4. **`real_backend.py` 是纯 re-export 门面**，仍在 import 图里，易被误用为装配点（真实装配在 `real_http.main()`）。
5. **`model_source_revision` 是死状态**（`backend_service.py:161`）：实际取消判定走 `active_model_source_id` + job 对象身份（`api_tasks.py:15-16` 明确记录了这个决定）。
6. **私有 API 耦合**：`_focus()` 原地重排 `PriorityQueue` 依赖 CPython 内部 `.queue`/`.mutex` 结构。
7. **私有跨模块导入**：`account_api.py` 导入 `account_store` 的 `_check_root/_regular`；`conversation_selection.py` 导入 `_safe_account/account_id/_check_root/_regular`。
8. **单文件巨型服务**：`backend_service.py` 3 240 行混合调度、批处理、预测、API 池、画像、缓存、账号作用域。
9. **前端单文件**：`chatui/app.js` 约 5 800 行未模块化；状态默认值在 `view-state.js` 与 `app.js:108-173` 双写；多处动态字段绕过 `state.set` 白名单。
10. **`shared/*.ts` 未被前端复用**：`chatui/` 0 处引用；前端把契约知识复制进 `app.js`（`CURRENT_LABEL_SCHEMA`、`GENERIC_INTENT_LABELS`、`GROUNDED_EVIDENCE`、颜文字 bank），任何 label schema 变更需同时改 `app.js` + `src/lib/labels.ts` + `electron/laya/*`，**无编译期保障**。
11. **`chat_server.py` 混入业务逻辑**：`classify()` 的 XML 嗅探启发式（`<img`/`<voicemsg`/`<appmsg`）易被构造内容误导。
12. **生产目录混放 22 个 `test_*.py`**。

### 11.2 一致性 / 校验重复

- 三层重复校验：传输层（`integer`/`user_value`/`request_id_value`）、服务层（各方法）、契约层（`*_contracts.py`）；上限偶有不一致（如 `model-insights` GET 的 `ids` 无长度限制，POST 的 `targetIds` 有）。
- `MAX_ANALYSIS_WORKERS=4` 在 `real_http.py:277` 以字面量 `4` 重复。
- `message_windows(users, 80, …)` 硬编码 80，未走 `backend_contracts` 常量。
- 传输层与服务层上限偶有差异，未来新增路由需双改。

### 11.3 算法 / 模型层

1. **双份 MBTI 题面**（`personality.ts`）：本地版要求「本人明说偏好」，API 版允许「跨话题重复表现出的倾向」，选项标签相同、转换函数共享，靠 `MBTI_QUESTION_VERSION` / `API_MBTI_QUESTION_VERSION` 两个版本号隔离（见 §7.5）。属**有意设计**，但两套题面需同步维护，且语义差异依赖分类器规则而非代码强制。
2. **`INTENT_FAMILIES` 手写映射**与 catalog 的 `intentGroups` 并行维护，构建脚本**不校验** family→group 映射。
3. **tokenizer 与 `@huggingface/tokenizers@0.2.0` 强耦合**：文件头明确「升级依赖后必须重新检查两处分歧」；rstrip 边界比 Rust 更窄。
4. **prompt 预算可被突破**：`head` 下限 8 意味着多选项问题下 prefix 可能超 `head_max_len`；批处理用 `max_len − head_max_len − 4` 保守预留，该 4 是经验常数。
5. **`analysis.ts` 静默丢弃超长 `portraitContext`**（>40 token）——调用方无感知，画像先验突然消失。
6. **`model-connectors` 无重试**：所有 SDK `maxRetries=0`；429 直接变 `rate-limit` 交给上层；`output-truncated` 无自动续写。
7. **`api-portrait.ts:214` 硬编码 `contextTokens=32768`**（兼容 façade，易被误用）。
8. **`analysis_server.ts` 探测并发上限 2 与生成类 10 两处判断耦合**，排队 `setTimeout(10s)` 从入队起算而非等待起算。
9. **本地推理无超时无取消**：超时靠 Python 侧 180/270 s deadline 兜底，超时后子进程仍在跑那条推理。
10. **`_key_lock` 表无清理**：随会话数单调增长。
11. **`ApiAnalyzerPool.close_extras` 吞掉所有异常**；多处 `str(exc)[:200]` 截断。

### 11.4 数据 / 兼容层

1. **schema 无版本号表**：靠 `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` + `ALTER TABLE`；`conversation_selection` 表半缺失时抛 `SelectionCorrupt` 而**不自动修复**（刻意为之）。
2. **legacy 升级路径并存**：`_prepare_model_portrait` 的 `legacy_resume`、`valid_resume` 7 项条件、`processedTargetTextCount` 缺失时的两种补算路径。
3. **legacy API 增量数据不完整**：老 delta 行缺 full inventory 时 `messageCount/totalChars/pieceCount` 只能置 `None`，等「一次迁移扫描」。
4. **`fine` 路径的关系分约束被标注为待修订**（`message_results.py:111-115`：legacy fine 结果仍要求 other 侧有界关系分，留待语义批次处理）。
5. **群整体自己的消息**在批处理与 API 统计中都只增加 `count`（不计入 target、不产生证据）——两处规则一致但重复实现。
6. `analysis_version` 探测子命令 20 s；启动等待 120 s；模型切换 180 s——超时值分散且无统一预算管理。

### 11.5 工作区当前状态（重要）

**本节是快照，落笔前必须用 `git status` 复核，不要照抄上一版。**

截至 2026-10-07：API 沟通建议、API worker 池、并行测试体系、多档案模型来源、分析请求名单与结果落盘加密都已提交（`b2e6006`、`5c8c9a1`、`5cf5783`、`336d8c8` 等），`scripts/stage-real-client.py` 白名单与 `package.json` 的并行测试入口均已就位。此后又落了四块互相独立的工作（分四个提交）：

1. **手选消息分析**：`/api/analyze` 接受 `targetIds`，界面「选择消息」只分析勾中的几条 —— 见 §6.2 与 §12.14。
2. **修复「保存并启用」的两个坑**：`activate` 带 `profileId` 时不接受连接字段（否则 400「启用失败」），而它的连接字段形式又会命中已有连接就地更新（否则「加了新配置但下拉菜单里没有」）；前端因此统一成「先 `/api/model-source/profiles` 落盘、再按 id 切换」—— 见 §5.2 与 §12.13。
3. **API 画像 MBTI 观察门槛**：卡片按观察账本 `available.mbtiEvidenceCount` 解锁、逐轴证据数取 `mbtiBasis.evidenceCount`（原先硬编码 1）、失速任务不再显示「正在准备」；`bridge/result_store.py` 的 `api_portrait_get` 负责暴露该计数，`electron/laya/personality.ts` 与 `electron/api-portrait-classifier.ts` 的 API 题面升到 `mbti-api-context-v2`（见 §7.5）。

4. **压缩四条分析提示词**（`8b48c2f`）：逐条标签 / 沟通建议 / 观察提取 / 画像合成四条 system 提示词保持 schema 与判定语义不变，只合并重复规则、显式写死粒度与长度上限；`electron/api-portrait.ts` 顺带删掉调用点里重复的 schema/长度说明。版本串随之升到 `free-label-v6-compact`、`api-guidance-v2`（TS + Python + `chatui/app.js` 两处副本；卡片移除后前端那份已删除）、`api-laya-portrait-v3`（三处闸门的位置见 §5 的 `*_contracts.py` 清单与 scope 表）。

**2026-10-10 追加**：

5. **合并上游 1.3.0**（`50314a0`）：把 `upstream/main`（`b35efa5`，助手仓库 / 聊天助手那一版）合进本分支，基线从 v1.2.4 提到 v1.3.0；冲突解决要点与验证结论见 README 的「合并上游 1.3.0」一节。
6. **潜台词与沟通建议并入助手**：新增内置技能 `builtin-skill:guidance` 与内置助手 `builtin:guidance`（`bridge/advisor_contracts.py`），助手可引用存量结果（`result_store.api_guidance_latest` → `guidance_contracts.guidance_material` → `advisor_service._guidance_material`，占同一 token 预算），画像页 `#guidanceCard` 及其控制、`analyzeSelfStyle` 开关与相关样式、脚本全部移除 —— 见 §6.5 与 §12.11。
7. **链接不进分析**：`bridge/message_input.py` 新增 `strip_links` / `analysis_text` / `has_analysis_content`（只去 `http(s)://` 与 `www.` 开头的链接，**裸域名与纯标点照旧**），所有送模型的文本经 `prepare_item` / `to_wire` 剥离，四条链路（本地标签、API 标签、沟通建议、画像）与批处理引擎的「可分析」判定统一改用它；前端 `chatui/app.js` 复刻同一规则（`hasAnalyzableText`）。界面原文、已存结果与画像 digest 仍是原文 —— 见 §6.11 与 §12.15。

核对过的一致性状态（截至 2026-10-10）：

- 三块的回归都在：`tests/message-picking.test.cjs`、`tests/model-source-settings.test.cjs`、`tests/api-mbti-gate.test.cjs`、`bridge/test_model_source.py`、`bridge/test_real_backend.py`；`tests/api-persona-ui.test.cjs` 的 MBTI 夹具已改为提供 `mbtiEvidenceCount` 与 `mbtiBasis`。
- `npm run typecheck` 干净、`npm run test:node` **596/596**；Python 侧除上游自带的 14 个 `test_advisor_*.py`（在纯净 `upstream/main` 上失败数完全相同，本机环境所致）外，43 个文件全过（含两个慢文件）。
- 新增运行时模块已在打包白名单里：`bridge/api_pool.py`、`bridge/guidance_contracts.py`（本 fork）与上游带来的 `bridge/advisor_*.py`、`bridge/api_portrait_ledger.py`，`scripts/stage-real-client.py` 已含这些名字。
- tokenizer 性能优化（`f83513a` / `959b4e0`）已随上游 1.3.0 收编，本分支现取上游实现。

发布前仍须走 §12.10 的更新流程与 §13 的全量回归。

---

## 12. 常见修改场景与影响范围

### 12.1 修改分析词库（情绪/意图/表达方式/人际需求）

- 源：`scripts/analysis-catalog-source.json`、`intent-display-source.json`、`social-intent-source.json`。
- **必须保留既有 ID**；执行 `npm run catalog:generate` 重新生成 `chatui/data/analysis-catalog.json`。
- 影响面：`electron/laya/catalog.ts`（路由）、`options.ts`（问题定义与选项数，可能触碰 `head_max_len` 预算校验 `predictChecked`）、`electron/laya/*` 的模型输入变化 → `ANALYSIS_VERSION` 变化 → **全部分析结果失效重算**；`chatui/app.js` 的 `GENERIC_INTENT_LABELS`（显示名兜底）与 `chatui/kaomoji.js` 的 `bank`（情绪→颜文字映射，缺任一项即**整表拒绝**并静默降级）。
- 注意：`build-analysis-catalog.mjs` 要求 intents ≥ 500、每 family 1-4 个 group；family→group 映射不做校验。

### 12.2 修改打分/派生规则（好感度、MBTI、雷达、摘要、关键词）

- 好感度：`backend_contracts.affinity_from_progress`（生产路径）+ `electron/laya/scoring.ts:affinityFromScores`（推理层等价实现）。**两处需同步**，否则本地与 API 模式口径不一致。
- MBTI：`backend_contracts.mbti_from_totals`（阈值 `MIN_PERSONALITY_MESSAGES=100` / `MIN_AXIS_EVIDENCE=30` / `MIN_AXIS_MARGIN=0.2`）+ `electron/laya/personality.ts` 的问题与证据提取。
- 雷达/摘要/关键词：`profile_state.traits_from_state`、`profile_signals.py`、`backend_contracts`。
- 影响面：改变统计口径时应递增相应版本（`FINE_LABEL_SCHEMA` / `BATCH_VERSION` / portrait 修订），否则新旧结果会混算；`batch_state._state()` 的结构契约（`empty_state()` 键集）一旦变更，`api_portrait_statistics.valid_statistics` 与历史 `state_json` 会全部判不合法。

### 12.3 新增一个 API 供应商协议

- 改 `electron/model-connectors.ts`：`PROTOCOLS` 白名单、`validateModelConfig`、`guardedFetch` 的流式分支、错误归一化映射。
- 改 `bridge/model_source.py` 的 `PROTOCOLS` 与 `connection_values` 校验。
- 改 `chatui/app.js` 的 `MODEL_SOURCE_PROTOCOLS` 与 `index.html` 的 `<select id="selectApiProtocol">` 选项。
- 改 `scripts/real-client-preload.cjs`/壳层（若该供应商需特殊配置）。
- 注意：分类器刻意**不发送输出上限**（除 Anthropic），若新协议必须 `max_tokens`，需在 `api-portrait-classifier.ts:124-127` 加入按上下文预算的计算分支。
- 前后端各有一份协议白名单（`bridge/model_source.py:PROTOCOLS` 与 `chatui/app.js:MODEL_SOURCE_PROTOCOLS`），漏改一侧的表现是「设置页能选但保存报 400」或反之。

### 12.4 新增一个 Node 命令（推理能力）

以已上线的 `model:guidance` 为参照模板（同样的一次 provider turn + 双重校验 + 独立注册表模式）：

1. `electron/` 实现函数并从 `electron/laya/index.ts` 或直接导出。
2. `bridge/analysis_server.ts` 加 `cmd` 分支（注意 lane 归类：是否属于 `isApiGenerationCommand`、是否受 api-only 限制、是否需要 `analysisVersion` 一致性）。
3. `bridge/node_analysis.py` 加包装方法（`_request` 超时表需同步；流式命令需 `on_stream_delta`）。
4. 若涉及新结果形态：`bridge/message_results.py` 或新契约模块加校验；`bridge/result_store.py` 加表/接口；`bridge/backend_contracts.py` 加错误码。
5. 若产生新持久化结果：递增对应 REVISION，否则旧结果会被误复用。

### 12.5 新增一个 HTTP 端点

- `bridge/real_http.py`：GET 在 `_do_GET` 的 if 链加分支；POST 需同时加进 `_do_POST` 的白名单元组与分支；DELETE 在 `_do_DELETE` 的前缀判断。
- 传输层校验（`integer`/`user_value`/`request_id_value`）+ 服务层校验**都要写**（两层都要做，不可只写一层）。
- GET/POST 需包裹 `backend.request_lease()` 与 `source.request_scope()`，`RuntimeError` → 503 `bridge-closing`（DELETE 目前的实现未包裹，属已知不一致）。
- 前端在 `chatui/app.js` 加调用点（用统一 `api()` 封装，注意 503 的 `error.code` 解析）。
- 若返回新字段且下划线开头会被过滤，注意 `job` 对象的 `_` 前缀私有字段约定。

### 12.6 修改存储结构

- 在 `ResultStore.__init__` 的 `BEGIN IMMEDIATE` 块内加 `CREATE TABLE IF NOT EXISTS` / `PRAGMA table_info` + `ALTER TABLE`（必须容忍并发首次打开）。
- `batch_state.py` 的表由 `BatchStateStore.__init__` 独立创建（同一物理库文件）。
- **改主键/作用域键 = 结果全失效**；`conversation_selection*` 表缺失/半缺失会抛 `SelectionCorrupt` 而不自动修复。
- 迁移后需同步更新 `bridge/test_real_backend.py`（约 2 900 行）等契约测试。

### 12.7 新增/修改运行文件

- 更新 `scripts/stage-real-client.py` 的 `SCRIPTS` / `BRIDGE` / `NATIVE_READER` / `LAYA` / `PUBLIC_FILES` 之一，否则便携构建失败。
- 运行时依赖导入在隔离目录验证，避免源码目录掩盖漏打包文件。
- 模型文件改动必须同步 `scripts/model-files.json`（大小 + SHA-256）与 `stage-real-client.py` 的 `MODEL_FILES`。

### 12.8 修改启动/端口/身份逻辑

- `bridge/instance_identity.py`（`instance_id` / `default_port`）、`scripts/start-real-client.py`（互斥、端口候选、控制记录、所有权校验）、`scripts/desktop-main.cjs`（env 注入与结果校验）。
- **安全约束不可放松**：清理进程必须按 PID 创建时间 + 镜像路径 + argv + `instance_id` + control token 校验；绝不按进程名或端口 sweep；控制记录写前必须用 `whoami`+`icacls` 设置当前用户 DACL；运行时目录逐级向上拒绝 symlink / reparse point / junction。

### 12.9 修改前端展示

- `chatui/app.js` 按功能簇定位（见 §4.3 报告中的模块划分）；画像/标签渲染都有 signature memo，改动数据结构需同步签名函数，否则不会重绘。
- 渲染一律用 `element()` + `textContent`（**不要引入 innerHTML**）。
- 前端硬编码常量（好感度等级名、MBTI 门槛、12288 上下文、缓存限额）集中在各函数顶部，修改需同步后端常量。

### 12.10 修改更新流程

- `scripts/build-update-manifest.cjs`（生成清单）、`scripts/real-client-update*.cjs`（拉取/验签/解压/安装/回滚）、`scripts/real-client-update-extract.py`、`scripts/update-signing.pub`。
- 清单 schema：`{schema:1, product, version, platform:"win32", arch:"x64", layout:"win-unpacked", dataSchema:"real-client-v1", archive:{name,size,sha256}}`；签名算法 Ed25519（`crypto.sign(null, manifestBytes, privateKey)`）。
- 必须保留 `.local/**` 与 `.models/**`（用户数据与模型）。

### 12.11 修改沟通建议（guidance）

跨 6 个文件的联动改动，**必须同步**否则会出现「提示词改了但契约没改」或反之：

| 层 | 文件 | 改什么 |
| --- | --- | --- |
| 推理 | `electron/api-guidance.ts` | 提示词、`GUIDANCE_VERSION`、各项上限常量 |
| 契约 | `bridge/guidance_contracts.py` | `GUIDANCE_REVISION`、场景/状态枚举、字段长度上限、`valid_guidance` / `normalize_guidance` |
| 契约 | `electron/api-guidance.ts` 的 `GUIDANCE_VERSION` | **必须与 Python 侧 `GUIDANCE_REVISION` 一致**，否则 `node_analysis.model_guidance()` 抛 `guidance-version-invalid` |
| 服务 | `bridge/node_analysis.py` | 响应字段白名单与三重复核（版本、`valid_guidance`、id 归属） |
| 服务 | `bridge/backend_service.py` | 窗口构造、eligible 筛选、重试、落库 |
| 存储 | `bridge/result_store.py` | `api_guidance_v1` 的读写（读取校验失败即删行），以及 `api_guidance_latest` 的「按会话取最新」 |
| 助手 | `bridge/advisor_contracts.py` | 内置技能 `builtin-skill:guidance` 与内置助手 `builtin:guidance`（「沟通参谋」）的正文与开关常量 `GUIDANCE_SKILL_ID` |
| 助手 | `bridge/advisor_service.py` + `guidance_contracts.guidance_material()` | 参考资料：渲染存量结果、`GUIDANCE_MISSING_NOTE`，并从同一 token 预算扣除 |
| 界面 | —— | 画像页那张卡（`#guidanceCard`、场景选择、开始分析/重算、反馈对话框、`analyzeSelfStyle` 开关、`chatui/style.css` 的 `.guidance-*`/`.feedback-modal-*`）**已删除**。要改用户可见的部分，改的是助手侧：`chatui/advisor*.js`、`docs/advisor.md` |

改动后建议用 `tests/api-guidance.test.ts` + `bridge/test_api_guidance.py` 双侧回归，助手侧另跑 `bridge/test_advisor_guidance_reference.py`；作用域串 `source_id:GUIDANCE_REVISION` 变了就等于换了一批结果（旧结果保留但不被复用）。

### 12.12 修改并行度 / 弹性策略

- 本地：`backend_service.py` 的 `_load_monitor` / `_apply_load_sample` / `_set_worker_limit` 与阈值常量组（`ELASTIC_*`）；改完后用 `GET /api/analysis-workers` 的 `load_sample` 观察采样是否合理。**降档为 0 时会关闭模型进程让出 GPU**，不是单纯拒绝调度。
- API：`bridge/api_pool.py` 的 `note_rate_limited` / `note_success` 与 `API_RATE_LIMIT_STREAK=2` / `API_RATE_LIMIT_RECOVER=8`；注意 `configure(workers)` 会**同时解除此前的降档**，容易被误判为「设置没生效」。
- 两者的上限都必须同步 `real_http.py` 的字面量校验与 `MAX_ANALYSIS_WORKERS` / `MAX_API_WORKERS`（见 §11.2 第 5 条）。

### 12.13 修改多 API 配置档案（model profiles）

用户可保存任意多条 API 配置（上限 `MAX_PROFILES = 20`），并在聊天标题栏的模型徽标下拉菜单里一键切换当前对话使用的模型。

- **身份**：`profiles[].id` 是 32 位 hex，直接沿用旧的 `sourceId` 语义，因此 SQLite 里所有 `(account, user, source_id)` 作用域的缓存天然按档案隔离，切换档案不会串用旧结果。
- **指纹**：`sourceIds{fingerprint→id}`，`fingerprint = sha256(["api-source-v1", protocol, baseUrl, model])`。**一条档案只拥有一个指纹**——`_upsert_profile` 在改写它的 protocol/baseUrl/model 之前会先清掉旧指纹，`_read` 的「指纹值互不重复」不变量才始终成立（否则整份配置会被判损坏）。
- **落盘与选择是两件独立的事**：`save_profile` 只增删改档案，不动 `selectedMode`/`sourceId`；`select_profile` 只改选择。`model_source_activate` 的顺序是「探测 → `save_profile` → `select_profile` → 发布内存态」，不能颠倒：先落盘选择再探测会让一次失败的探测把来源留在坏配置上。
- **「保存并启用」永远是两步**：`chatui/app.js:saveApiProfileDraft(activate)` 先发 `/api/model-source/profiles`（新建则追加一条，带 `profileId` 则就地更新），拿到响应里的 `profile` 后再发 `{mode:"api",profileId}` 切换。不能省掉第一步，原因有两条：
  1. `activate` 带 `profileId` 时不允许再带连接字段（`model_source_activate` 的 `set(request) != {"mode","profileId"}` 判定），混合请求是 400 —— 表现为「测试连接成功但保存并启用失败」；
  2. `activate` 的**连接字段形式**会按 protocol/baseUrl/model 命中已有档案并**就地更新**（`profile_for_endpoint`，注释说明是「不堆积重复项」），所以用它新增一条「同 Base URL + 同模型 ID」的配置时不会多出一行 —— 表现为「加了新配置但模型下拉菜单里没有」。而 `/api/model-source/profiles` 对没有 `profileId` 的请求总是追加。
  代价不变：连接字段只出现一次，所以探测次数与单请求形式相同，只多一次本地请求。契约由 `bridge/test_model_source.py` 的 `test_activate_matches_an_existing_connection_instead_of_adding_one` / `test_activate_rejects_connection_fields_next_to_a_profile_id` 与 `tests/model-source-settings.test.cjs` 的用例钉住。
- **密钥沿用**：`resolve_key(protocol, baseUrl, None)` 遍历所有档案，找**协议与 host/path 完全一致**的那条（活动档案优先）。`_upsert_profile` 只在 protocol 与 baseUrl 都未改变时才复用旧密钥，因此「留空沿用已保存密钥」不会把 A 站的密钥带到 B 站。
- **删除活动档案必须回落本地**：`model_source_profile_delete` 发现删掉的正是 `sourceId` 时，要把 `active_*` 复位为 `LOCAL_SOURCE_ID` 并调 `_cancel_api_source_work_locked()`，否则 worker 会继续指向一份已不存在的配置。
- **版本迁移**：`version:1` 的单个 `api` 对象在 `_decode_profiles` 中变成 `profiles` 的第一项，并沿用原 `sourceId`（历史缓存键因此不变），下次写入即升级为 `version:2`。

**改动清单**：`bridge/model_source.py`（存储与校验）→ `backend_service.py` 的 `model_source_activate` / `model_source_profile_save` / `model_source_profile_delete` / `model_source_clear_key`（语义与原子性）→ `bridge/real_http.py`（路由白名单 + 分支）→ `chatui/index.html`（`#selectApiProfile`、`#inputApiProfileName`、`#modelBadge*`、`#apiProfileDeleteConfirm`）→ `chatui/app.js`（`modelProfiles()`、`resolveEditedProfileId()`、`postApiModelSource()`、`renderModelBadgeMenu()`）。前端仍禁止 innerHTML，菜单项用 `document.createElement` 逐个构造；删除沿用账号管理的「二次确认」交互而非 `window.confirm`。

### 12.14 修改「选择消息」分析（手选若干条只分析它们）

界面上：聊天工具条 `#btnPickMessages`（文案在「选择消息」与「退出选择」之间切换）→ `chatui/index.html` 的 `#pickBar`（`#btnPickAll` / `#btnPickClear` / `#btnPickAnalyze` / `#btnPickCancel`）。

- **前端状态**：`chatState.messagePicking` + `chatState.selectedMessageIds`（`chatui/view-state.js` 的 chat 域）。每行可分析消息由 `attachPickControl` 挂上 `.msg-pick` 复选框并标 `.pickable`，容器加 `.pick-mode` 才显示 —— 进入/退出选择态**不重渲染消息列表**，只切类名 + `syncPickControls()`。
- **两条提交路径都只带选中 id**：本地 `submitPickedMessages` → `analyzeRecent(…, targetIds)` → `POST /api/analyze {mode:"recent",limit,targetIds}`；API `submitPickedApiInsights` → `submitApiInsightJob`（后端本来就接受 `targetIds`）。API 侧若已有 `queued/running` 任务，后端会把新请求答成那个运行中的任务，所以前端直接提示「会在其中一并完成」而不是假装已排队。
- **必须保留的三处抑制**：`scheduleRecent` 与 `ensureApiInsights` 在选择态下直接返回；`submitManualRecent`（「意图识别」按钮，也是 `manualRecentDeferred` 的续投入口）改为委托 `submitPickedMessages`。漏掉任意一处，手选都会被整窗分析盖过去（API 模式还多花钱）。
- **窗口契约**：前端 `pickedWindow()` 用 `limit = max(1, min(80, 已加载条数 - 最早被选位置))`、候选只取尾窗内的选中项，`#pickBarCount` 会提示「N 条超出当前窗口」；后端再校验一次（§6.2）。
- **选择态生命周期**：切换会话（`switchSession`）、账号重置（`resetAccountView`）、进入历史视图（`enterHistoryView`）都会退出并清空选择；退出选择态本身也会清空（选择属于当时那个窗口）。
- **范围边界**：手选只产出逐条消息标签（本地 `fine_results_v1` / API `api_insights_v1`），不改画像累计与沟通建议；后台「分析已添加的会话」开关（`incremental` / 全程扫描）不受影响，要不要一起关是用户的设置，不是本功能能替用户决定的。
- **回归**：`tests/message-picking.test.cjs`（前端行为 + 三处抑制的接线）、`bridge/test_real_backend.py` 的 `test_http_analyze_accepts_hand_picked_targets`（HTTP 边界 202/400）、`test_selected_targets_analyse_only_the_picked_ids` / `test_selected_targets_outside_the_window_are_rejected_before_queueing` / `test_selection_does_not_narrow_the_next_window_run`。

---

## 13. 测试与验证

| 命令 | 覆盖内容 |
| --- | --- |
| `npm test` | `node scripts/run-all-tests.cjs`：**先 typecheck，再三套测试并行**（node / scripts / python），输出按耗时排序的汇总；全部通过打印 `ALL_SUITES_PASSED` |
| `npm run test:quick` | 同上但 `--skip-typecheck --only=node,scripts`，用于只改了运行路径时 |
| `npm run test:serial` | 原串行链：`typecheck` → `test:node` → `test:scripts` → `test:python` |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.electron.json`（只含 `electron/**` 与 `shared/**`） |
| `npm run test:node` | 33 个 TS/CJS 测试：分词器、模型连接器、分类器、契约、UI 逻辑 |
| `npm run test:python` | `scripts/run-python-tests.py`：三组（`bridge` / `scripts` / `native-reader`）**并行**、组内文件串行（多个 bridge 测试共用项目 `.local` 目录，并行会互相竞争）；某组失败不掩盖其他组结果，全部通过打印 `ALL_PYTHON_TESTS_PASSED` |
| `npm run test:scripts` | `scripts/run-node-script-tests.cjs`（桌面/更新/启动器脚本） |
| `npm run test:model` | `tsx scripts/test-model.ts`，真实加载 ONNX 跑中文推理；**需先下载模型**，并设 `LAYA_MODEL_DIR` 指向已安装客户端的模型目录（如 `D:\program\wechat\win-unpacked\resources\client\.local\models\laya`）；基线输出 affinity 73 |
| `npm run test:recovery` | 桌面、服务恢复、账号存储、启动器 |
| `npm run build:portable` | 完整便携构建 |
| `python scripts/run-project-python.py scripts/test-start-real-client.py` | launcher 单元测试 |

本地环境注意：README 要求 Python 3.14，但本机只有 3.13；用 `py -3.13 -m venv .venv` + `pip install --no-deps -r python-requirements.lock.txt`，运行时设 `WECHATVIBE_PYTHON` 指向该解释器。

合成测试覆盖账号作用域、任务失效、流式标签、纯标点、启动失败回收、静态 MIME、更新保留模型等路径；**它们不能替代真实服务商或用户设备的验收**。

手选消息的范围与守卫由 `tests/message-picking.test.cjs`（前端行为 + `scheduleRecent`/`ensureApiInsights`/`submitManualRecent` 三处抑制的接线）与 `bridge/test_real_backend.py` 的 `test_http_analyze_accepts_hand_picked_targets` + 三个 `test_selected_targets_*` / `test_selection_does_not_narrow_the_next_window_run` 钉住（后者已用「关掉守卫」验证过确实会失败）。

链接不进分析（§6.11）由四处钉住：`bridge/test_message_input.py` 的 `LinkAndPlaceholderTests`（纯规则：只去协议/www、保留尾部标点、裸域名不动、占位与纯标点的边界、投影副本与 `to_wire`）、`bridge/test_real_backend.py:test_a_message_that_is_only_a_link_is_not_analysed`（本地：链路目标跳过 + 送给模型的文本无链接）、`bridge/test_api_insights.py` 的 `test_a_message_that_is_only_a_link_is_not_a_target_or_sent` 与 `test_guidance_is_insufficient_when_the_window_only_holds_a_link`（API 标签目标与 payload、沟通建议 `insufficient`）、`tests/message-picking.test.cjs` 的 `keeps a message that is only a link out of every analysis path`（前端判定 + 手选）。把 `has_analysis_content` 改回旧行为可确认这四处确实会失败。

---

### 12.15 修改「链接是否参与分析」

两侧要一起改（规则同源，前端是复刻）：

| 层 | 文件 | 改什么 |
| --- | --- | --- |
| 规则（权威） | `bridge/message_input.py` | `LINK_PATTERN` / `LINK_TAIL` / `PLACEHOLDER_NAMES`，`strip_links` / `analysis_text` / `has_analysis_content` |
| 规则（前端复刻） | `chatui/app.js` | `MESSAGE_LINK_PATTERN` / `MESSAGE_LINK_TAIL` / `MESSAGE_PLACEHOLDERS`，`stripMessageLinks` / `messageAnalysisText` / `hasAnalyzableText` |
| 落点 | 见 §6.11 的表 | 新增分析链路时，记得同时改「要不要设为目标」与「送模型的文本」 |

回归：`bridge/test_message_input.py`（纯规则）、`bridge/test_real_backend.py`（本地：目标跳过 + 送模型的文本无链接）、`bridge/test_api_insights.py`（API 标签的目标与 payload、沟通建议 `insufficient`）、`tests/message-picking.test.cjs`（前端判定 + 手选不提供链接消息）。把 `has_analysis_content` 改回旧行为，这几处都会失败 —— 可用来确认测试真的咬得住。

两个刻意的边界：**纯标点仍算内容**（语气）；摘要/指纹类 digest 仍取**原文**，否则改一条链接不会被识别为来源变化。

## 14. 快速索引：按问题查文件

| 问题 | 去哪看 |
| --- | --- |
| 路由/参数/静态文件/安全头 | `bridge/real_http.py` |
| 任务调度、优先级、并发、画像编排 | `bridge/backend_service.py` |
| 累计与打分数学 | `bridge/batch_state.py`、`bridge/profile_state.py`、`bridge/backend_contracts.py`、`bridge/api_portrait_statistics.py` |
| 派生（好感度/MBTI/雷达/摘要/关键词） | `bridge/backend_contracts.py`、`bridge/profile_signals.py`、`bridge/profile_state.py` |
| SQLite 表结构 | `bridge/result_store.py:39-127`、`bridge/batch_state.py:238-286` |
| HTTP 请求/响应协议 | `bridge/node_analysis.py`、`bridge/analysis_server.ts` |
| 本地模型管理 | `electron/analysis.ts`、`bridge/local_model_source.py`、`bridge/model_bundle.py` |
| ONNX 会话与 provider | `electron/laya/runner.ts` |
| 分词 | `electron/laya/tokenizer.ts` |
| 序列构造与 token 预算 | `electron/laya/prompt.ts`、`electron/analysis.ts:527-559` |
| 路由与阈值 | `electron/laya/catalog.ts`、`expression.ts` |
| 网络与协议兼容 | `electron/model-connectors.ts` |
| API 标签提示词与解析 | `electron/api-message-insights.ts`、`api-insight-stream.ts`、`api-analysis-json.ts` |
| API 画像分类器 | `electron/api-portrait-classifier.ts` |
| 沟通建议（生成链路，现无界面入口） | `electron/api-guidance.ts`、`bridge/guidance_contracts.py`、`bridge/backend_service.py`（`start_guidance`/`_run_guidance`） |
| 沟通建议（在助手里用） | `bridge/advisor_contracts.py`（内置技能/助手）、`bridge/advisor_service.py`（参考资料）、`bridge/guidance_contracts.py:guidance_material()` |
| 助手（仓库 / 会话 / 托管资料 / 引擎） | `bridge/advisor_service.py`、`advisor_context.py`、`advisor_store.py`、`advisor_runtime.py`、`advisor_http.py`、`chatui/advisor*.js`、`ui/advisor/*` |
| 并行度与降档 | `bridge/api_pool.py`、`backend_service.py`（`_load_monitor`/`_apply_load_sample`） |
| 微信数据读取 | `bridge/wechat_source.py`、`bridge/history_browser.py` |
| 密钥获取 | `bridge/live_source.py`、`native-reader/wr/crypto.py` |
| 账号与缓存管理 | `bridge/account_store.py`、`bridge/account_api.py`、`bridge/result_store.py` |
| 模型下载安装 | `bridge/model_install.py`、`scripts/setup-models.ts`、`scripts/model-asset.json`、`scripts/model-files.json` |
| 词库生成 | `scripts/build-analysis-catalog.mjs` + 三个 source json |
| 前端 | `chatui/app.js`、`chatui/view-state.js`、`chatui/message-insight-adapters.js`、`chatui/message-labels.js` |
| 启动/进程身份 | `scripts/start-real-client.py`、`scripts/desktop-main.cjs`、`bridge/instance_identity.py` |
| 应用更新 | `scripts/real-client-update*.cjs`、`scripts/update-signing.pub` |
| 打包白名单 | `scripts/stage-real-client.py` |
| 分层约定（权威） | `docs/backend-architecture.md` |
| 手选消息的分析范围 | `chatui/app.js`（`pickableMessage`/`pickedWindow`/`submitPickedMessages`）、`bridge/backend_service.py`（`_resolve_selected_targets`/`_run_selected_targets`）、`bridge/real_http.py`（`/api/analyze` 的 `targetIds`） |