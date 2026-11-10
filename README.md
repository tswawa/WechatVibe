<div align="center">

<img src="docs/assets/readme/wechatvibe-logo.png" alt="WechatVibe" width="128">

# WechatVibe

微信聊天情感分析客户端<br>
意图识别 · 情绪感知 · 人物画像 · 群聊画像 · 好感度 · MBTI 聊天推测 · 聊天助手

[![最新版本](https://img.shields.io/github/v/release/tswawa/WechatVibe?label=release)](https://github.com/tswawa/WechatVibe/releases/latest)
[![Release 累计下载量](https://img.shields.io/github/downloads/tswawa/WechatVibe/total?style=flat&logo=github&label=downloads)](https://github.com/tswawa/WechatVibe/releases)
[![GitHub Stars](https://img.shields.io/github/stars/tswawa/WechatVibe?style=flat&logo=github)](https://github.com/tswawa/WechatVibe/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/tswawa/WechatVibe?style=flat&logo=github)](https://github.com/tswawa/WechatVibe/forks)
[![GitHub Issues](https://img.shields.io/github/issues/tswawa/WechatVibe?style=flat&logo=github)](https://github.com/tswawa/WechatVibe/issues)
[![Windows 10/11](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)](#运行要求)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[功能介绍](#功能介绍) · [下载安装](#下载安装) · [首次使用](#首次使用) · [常见问题](#常见问题) · [数据与隐私](#数据与隐私) · [免责声明](#免责声明) · [交流与反馈](#交流与反馈)

</div>

WechatVibe 只读读取本机已登录的 Windows 微信，分析聊天中的情绪和意图，并生成人物画像、好感度和 MBTI 推测。聊天助手可以结合当前会话提供交流建议和回复草稿。适合想回看聊天中的情绪变化、了解日常交流方式的用户。

- **本地模型**：使用 [Laya](https://github.com/NandhaKishorM/laya) [多语言 ONNX 模型](https://huggingface.co/mizchi/laya-multilingual-onnx)，在本机完成分析。
- **API 模式**：可接入 Anthropic、Responses、Chat Completions、Gemini 或 Ollama 兼容接口。
- **微信数据读取**：基于 [wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica) 的本地数据库接口，只读获取当前登录账号的会话和消息。

![API 模式下的消息情绪与意图识别](docs/assets/readme/chat-demo.png)

<sub>截图中的聊天和分析结果均为虚构演示数据。</sub>

## 功能介绍

### 消息情绪与意图

在聊天页点击「意图识别」，消息下方会显示情绪和意图两个短标签，例如「开心」「期待」「委屈」，或「分享」「邀约」「求安慰」「婉拒」。

- **结合上下文**：参考近期聊天和已保存的人物画像来判断，不只看单句；纯标点消息也能分析。
- **本地与 API 一致**：两种模式显示方式相同。API 模式的每个标签不超过四个字，使用支持流式返回的接口时会边分析边显示。
- **人物情绪与群聊氛围**：单聊顶部显示聊天对象当前的情绪状态，群聊顶部显示整体氛围。
- **随时开关**：关闭标签后再打开，会恢复已有结果。

### 人物画像

从聊天工具栏或左侧导航进入「人物画像」，在同一页面查看好感度、MBTI 倾向、互动风格和画像摘要。

![人物画像：好感度、MBTI 倾向、互动风格和摘要](docs/assets/readme/profile-demo.png)

- **好感度**：单聊显示好感度数值和等级，随新消息持续更新。
- **MBTI 聊天推测**：按 E/I、S/N、T/F、J/P 四个维度显示倾向。该人物已分析的有效文本满 100 条后解锁，依据不足的维度显示为未确定。
- **互动风格**：六维雷达图，包括表达活力、幽默表达、情绪平和、话题主动、关怀支持和亲近表达。
- **常聊内容**：根据实际分析过的文本展示高频词。
- **统一计分**：API 模式按上下文容量整批判断聊天，好感度、MBTI、雷达和摘要使用与本地 Laya 相同的累计和打分规则。
- **保存与续算**：再次进入时先显示上次的结果，新消息在原有基础上继续分析，切换聊天或重启软件都不会重新分析全部历史；分析中可查看进度和速率。

### 群聊画像

在群聊中进入画像页面，可以在「群整体」和具体成员之间切换。

![群聊整体画像与成员选择](docs/assets/readme/group-profile-demo.png)

- **群整体**：参与人数、消息数量、分析进度、六维互动风格、常见词和群聊摘要。
- **成员画像**：搜索或翻页选择成员，查看该成员的互动风格、摘要和 MBTI 聊天推测。
- **分别保存**：群整体和每个成员各自积累结果，切换时显示对应对象的画像。

### 助手仓库与聊天助手

左侧「助手仓库」管理已启用的助手。在聊天工具栏点击「聊天助手」，会在主窗口右侧打开固定宽度面板，可以结合当前会话询问交流建议、整理聊天内容或拟写回复。回答和草稿不会自动发送到微信。

- **导入助手**：点击「新建助手」，从 GitHub 地址、本地 `SKILL.md`、技能目录或 ZIP 导入。读取预览后可编辑名称、说明、欢迎语和提示词；需要只读适配的资料由用户确认后导入。
- **编辑与技能**：已有助手可以继续编辑，选择或移除所用技能。取消编辑不会改变其他助手的共享资料；重复导入同来源、同版本会复用已有助手，保留其编辑和对话。
- **保存与恢复**：对话、草稿和已生成结果按微信账号、会话、助手分别保存。切换聊天或重开面板显示对应记录；失败可重试，停止时保留已经生成的内容。
- **重置助手对话**：在输入框发送 `/reset`，只重置当前助手在当前会话中的对话，不清除微信记录、消息分析或人物画像。
- **模型要求**：使用设置中保存的生成式 API 或 Ollama 兼容接口，模型需要支持工具调用。本地 Laya 负责消息与画像分析，不用于生成助手回答；聊天分析仍可保持本地模式。
- **只读能力**：助手仅能读取本轮提供的当前会话资料和选用的技能文本，不能发送微信消息、执行命令、修改文件或访问其他会话资料。导入包内的脚本和外部工具能力不会执行。

详细用法见[助手仓库与聊天助手](docs/advisor.md)。

### 聊天记录与账号

软件只读读取本机已登录的微信，支持单聊、群聊、联系人和群头像。图片消息显示为 `[图片]`。

- **按需添加会话**：首次进入只读取会话目录，不加载全部聊天。点击左侧搜索框旁的「＋」，或在「设置 → 信息列表」添加要查看的会话；移出列表不会删除缓存或画像。
- **批量管理**：管理会话时，已添加的项排在前面。勾选后点击「移除所选」，每次最多移除 1000 个会话，只改变列表选择，保留聊天、画像和助手记录。
- **历史记录**：分页查看更早的消息，可按关键词或日期查找，并定位到上下文。
- **聊天记录路径**：自动找不到微信数据时，可在「设置 → 通用设置 → 聊天记录路径」选择 `xwechat_files` 或账号目录，也可以恢复自动发现。选择目录后仍需微信登录并通过账号校验。
- **多账号**：每个微信账号使用独立的数据库，再次登录时复用原有记录。
- **清除账号**：在账号管理中清除某个账号在 WechatVibe 里的聊天副本、分析和画像，不影响微信本身的聊天记录。清除当前账号后软件会退出。

<details>
<summary>截图：选择要查看的会话</summary>

![选择要加入聊天列表的会话](docs/assets/readme/conversations-demo.png)

</details>

### 模型与设置

- **模型来源**：默认使用本地 Laya，也可以接入 API。填写 Base URL、API Key 和上下文大小后，可获取模型列表、测试连接并启用。
- **上下文容量**：API 画像按模型的上下文容量自动分批，装得下就一次处理。完整的画像判断至少需要 12288 tokens 上下文，不足时会提示。
- **分来源保存**：本地和各个 API 模型的结果分开保存，可在设置中分别查看和清除缓存。
- **按会话重置**：聊天工具栏的「重置会话分析」清除当前来源的消息分析和该会话全部画像；画像页的「重置画像」只清当前对象或选中群成员的画像。确认后重新分析，其他会话、其他来源及助手记录保留。
- **运行设置**：浅色/深色主题、界面缩放，以及 CPU/GPU 切换；GPU 不可用时可回退到 CPU。

<details>
<summary>截图：模型设置与缓存管理</summary>

![本地 Laya 下载与运行设备选择](docs/assets/readme/local-model-demo.png)

![API 服务地址、协议、模型与上下文设置](docs/assets/readme/api-settings-demo.png)

![按本地和 API 模型来源分别管理分析缓存](docs/assets/readme/cache-demo.png)

</details>

## 下载安装

1. 从 [Releases](https://github.com/tswawa/WechatVibe/releases/latest) 下载最新的 `WechatVibe-版本号-windows-x64.zip`。这是标准运行包，不含 Laya 模型。
2. 解压后保留整个 `win-unpacked` 目录，双击其中的 `WechatVibe.exe`。
3. 使用本地分析时，在「设置 → 本地部署」下载模型（独立的 `WechatVibe-Laya-model-v1.zip`），或选择已有的模型目录。只用 API 可以跳过这一步。

### 运行要求

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

项目采用 [Apache-2.0](LICENSE)。Laya、模型与第三方依赖的来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

演示头像使用 Lisa Wischofsky 的 [Adventurer](https://www.dicebear.com/styles/adventurer/) 插画，经 DiceBear 组合并调整配色，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)；该素材许可独立于项目代码许可。

## 致谢

<details>
<summary>感谢为本项目提交代码和反馈问题的朋友</summary>

- 感谢 [china-luo](https://github.com/china-luo) 在 [Issue #1](https://github.com/tswawa/WechatVibe/issues/1) 中反馈 Windows 微信 4.1.15.13 的聊天记录读取异常，并提出对非字符串消息类型进行兼容转换的建议。
- 感谢 [Li Xiang](https://github.com/Misaka1008611) 反馈微信数据库密钥不完整、反复读取的问题，并提供排查信息，帮助定位读取兼容性问题。
- 感谢 [luo785859020（小闹一起）](https://github.com/luo785859020) 通过 [PR #3](https://github.com/tswawa/WechatVibe/pull/3) 和 [PR #4](https://github.com/tswawa/WechatVibe/pull/4) 改进源码模型下载、Python 环境选择与验证流程，并完成后端职责分层。
- 感谢 [morticuke](https://github.com/morticuke) 在 [Issue #5](https://github.com/tswawa/WechatVibe/issues/5) 中提供 Windows MIME 映射异常的排查过程和修复建议。
- 感谢 [Dl1447（Geekline）](https://github.com/Dl1447) 通过 [PR #12](https://github.com/tswawa/WechatVibe/pull/12) 修复选中首个会话后无法继续添加会话的问题。
- 感谢 [silicon-sbt](https://github.com/silicon-sbt) 通过 [PR #13](https://github.com/tswawa/WechatVibe/pull/13) 改进 API 消息标签的批量结果对应。
- 感谢 [silicon-sbt](https://github.com/silicon-sbt) 通过 [PR #10](https://github.com/tswawa/WechatVibe/pull/10)、[PR #18](https://github.com/tswawa/WechatVibe/pull/18)、[PR #19](https://github.com/tswawa/WechatVibe/pull/19)、[PR #20](https://github.com/tswawa/WechatVibe/pull/20) 和 [PR #21](https://github.com/tswawa/WechatVibe/pull/21) 加入本地多路并行分析、过滤服务号与系统会话、一键添加全部会话、只读的整账号分析进度与耗时，以及后台分析开关。
- 感谢 [Ch1cken-1145（Ch1cken_#）](https://github.com/Ch1cken-1145) 通过 [PR #16](https://github.com/tswawa/WechatVibe/pull/16) 加入手动设置微信聊天记录路径的功能。
- 感谢 [LianYu-Ya](https://github.com/LianYu-Ya) 在 [Issue #14](https://github.com/tswawa/WechatVibe/issues/14) 中反馈自部署模型批量标签格式错误、只返回一条的问题。
- 感谢 [nizitao](https://github.com/nizitao) 通过 [PR #26](https://github.com/tswawa/WechatVibe/pull/26) 贡献重复分词优化，并在 [PR #33](https://github.com/tswawa/WechatVibe/pull/33) 中继续整理改进建议。本版采用此前 #26 中的编码缓存、共享状态编码及等价文本处理，减少重复分词计算。
- 感谢 [wzzzzzzzh](https://github.com/wzzzzzzzh) 通过 [PR #27](https://github.com/tswawa/WechatVibe/pull/27)、[PR #28](https://github.com/tswawa/WechatVibe/pull/28)、[Issue #30](https://github.com/tswawa/WechatVibe/issues/30) 和 [PR #32](https://github.com/tswawa/WechatVibe/pull/32) 贡献换行整理、账号查询提速及读取诊断。本版以等价实现采用扫描预算调整方案，改善部分较大微信进程因旧预算不足而持续未就绪的问题。
- 感谢 [silicon-sbt](https://github.com/silicon-sbt) 通过 [PR #31](https://github.com/tswawa/WechatVibe/pull/31) 提供累计分析状态异常的定位、最小复现和回归测试，帮助修复情绪证据缺失导致的分析中断，并提供读取问题的独立核对与测试反馈。
- 感谢 [Berge520](https://github.com/Berge520) 通过 [Issue #24](https://github.com/tswawa/WechatVibe/issues/24) 反馈会话管理与分析恢复问题。

当前待验收源码继续接入：感谢 **wzzzzzzzh** 的 [PR #29](https://github.com/tswawa/WechatVibe/pull/29) 账号选择、多实例以及 [PR #34](https://github.com/tswawa/WechatVibe/pull/34) 瞬态重试；感谢 **nizitao** 的 [PR #33](https://github.com/tswawa/WechatVibe/pull/33) 模型档案、手选分析、并发、沟通建议、旧画像证据兼容及列加密；感谢 **silicon-sbt** 的 [PR #22](https://github.com/tswawa/WechatVibe/pull/22) 单条重算、[PR #23](https://github.com/tswawa/WechatVibe/pull/23) 按钮状态和 [PR #13](https://github.com/tswawa/WechatVibe/pull/13) 悬空句修复与质量研究。各功能的后续修复、主线适配及未采用范围记录在 [整合说明](docs/pr-integration-acceptance.md)，不将局部采用写成整 PR 已合并。

</details>

## 赞助

因为本项目的特殊性，永久不接受任何形式的赞助。

## 合作说明

如需使用、修改或再分发本项目，请以本仓库的 [Apache-2.0](LICENSE) 许可证为准；第三方组件遵循各自的许可证。本说明不改变开源许可证已授予的权利。

第三方基于本项目独立开发、分发或运营的衍生版本，由相应开发者或运营者自行负责维护、服务支持及其对外承诺。使用本项目源码不代表与本项目或维护者建立合作关系，也不代表相关衍生版本获得本项目的认可、担保或背书。未经明确授权，不得以本项目或维护者名义对外开展合作或作出承诺。

## 交流与反馈

- 问题反馈：[GitHub Issues](https://github.com/tswawa/WechatVibe/issues)
- QQ 交流群：**921170374**
- 作者：[tswawa](https://github.com/tswawa)
