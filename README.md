# WechatVibe

微信聊天情感分析客户端，支持意图识别、情绪感知、人物画像、群聊画像、好感度分析和 MBTI 聊天推测。

- **分析模型**：[Laya](https://github.com/NandhaKishorM/laya)，用于聊天情绪和意图分析，采用 [mizchi 的多语言 ONNX 版本](https://huggingface.co/mizchi/laya-multilingual-onnx)。
- **微信数据读取**：基于 [wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)，读取微信本地会话和聊天记录。

项目适合想回看聊天中的情绪变化、了解日常交流方式的用户。单聊中可查看对方消息的情绪、意图和人物画像；群聊中可查看整体氛围、互动特点及成员画像。

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[功能介绍](#功能介绍) · [下载安装](#下载安装) · [首次使用](#首次使用) · [更多截图](#更多截图) · [源码运行](#源码运行) · [数据与隐私](#数据与隐私) · [交流与建议](#交流与建议)

![消息情绪与意图识别](docs/assets/readme/chat-demo.png)

## 功能介绍

### 意图识别

在聊天界面打开「意图识别」，对方消息下方会显示可能的交流意图，例如分享、邀约、试探、求安慰、敷衍或婉拒。

- **多个候选**：每条已分析的消息最多显示三个意图候选及其概率。
- **结合上下文**：结合近期聊天和已保存的人物画像，识别当前消息的交流意图。
- **简短标签**：相近细项统一显示为分享、承诺、协商等常用词。
- **随时开关**：关闭或显示消息标签，重新打开时恢复已有结果。

### 情绪感知

开启「意图识别」后，消息下方同时显示情绪候选和颜文字。

- **消息情绪**：显示开心、期待、委屈、生气、累了等情绪候选，每行最多三个，并保留各自的概率。
- **颜文字**：为主要情绪配上颜文字，直接放在消息分析行中。
- **人物情绪**：单聊顶部展示当前聊天对象的情绪状态。
- **群聊氛围**：群聊顶部展示整体氛围，和具体成员的消息情绪分开查看。

### 人物画像

从聊天工具栏或左侧导航进入「人物画像」，查看当前聊天对象的分析结果。

- **互动风格**：六维雷达展示表达活力、幽默表达、情绪平和、话题主动、关怀支持和亲近表达，图表各顶点有对应名称。
- **画像摘要**：汇总已分析聊天中的互动特点，和雷达图、高频词放在同一页面。
- **高频词**：保留六个常见词，方便回看对方常聊什么。
- **分析进度**：显示已分析文本数和当前状态，处理中可查看速率。
- **保存与续算**：再次进入时先显示上次保存的画像，新消息在原有结果上继续更新。

### MBTI 聊天推测

人物画像中的 MBTI 按 E/I、S/N、T/F、J/P 四个维度展示倾向。该人物积累到 100 条有效文本后，可点击「解锁人格」查看；证据不足的维度保留未确定状态。

### 好感度分析

单聊人物画像中显示好感度数值和等级，和互动风格、画像摘要一起查看。已有结果会保留，后续随新消息分析更新。

### 群聊画像

打开群聊后进入画像页面，可以在「群整体」和具体成员之间切换。

- **群整体**：查看参与人数、消息与文本数量、分析进度、六维互动风格、常见词和群聊摘要。
- **成员画像**：从「选择成员」中搜索或翻页选择对象，每页六人，查看该成员的互动风格、摘要和 MBTI 聊天推测。
- **分别保存**：群整体与每个成员分别积累结果，切换时显示对应对象的画像。
- **群聊氛围**：在聊天页查看整体情绪，在消息下方查看各个发言者的情绪与意图。

### 聊天记录与账号管理

软件从本机已登录微信读取会话，支持单聊、群聊、联系人和群头像。聊天中的图片消息显示为 `[图片]`。

- **历史记录**：分页查看更早的消息，按关键词或日期查找，并定位到对应上下文。
- **账号数据库**：按真实微信账号分别保存数据；新账号创建独立数据库，已有账号复用原来的记录。
- **账号清除**：在账号管理中选择要清除的账号，删除它在 WechatVibe 内的聊天副本、分析、画像和相关缓存。
- **退出规则**：清除当前账号成功后退出软件；清除其他账号保持当前软件运行。

### 增量分析与运行设置

画像分析会逐步处理本地可用的历史消息，保存结果和进度。之后把新增消息收成一批，处理后与已有画像合并，不因切换聊天或重启软件重新分析全部历史。

通用设置提供浅色/深色主题、界面缩放和 CPU/GPU 运行选项；GPU 不可用时支持回退到 CPU。

## 更多截图

### 群成员画像

![群成员画像](docs/assets/readme/profile-demo.png)

## 下载安装

当前版本为 **[WechatVibe 0.1.0](https://github.com/tswawa/WechatVibe/releases/tag/v0.1.0)**。

| 文件 | 用途 |
| --- | --- |
| [WechatVibe-0.1.0-windows-x64.zip](https://github.com/tswawa/WechatVibe/releases/download/v0.1.0/WechatVibe-0.1.0-windows-x64.zip) | Windows 运行版，包含模型和运行环境。 |
| [WechatVibe-0.1.0-source.zip](https://github.com/tswawa/WechatVibe/releases/download/v0.1.0/WechatVibe-0.1.0-source.zip) | 干净源码，用于查看、修改或自行构建。 |

支持 Windows 10/11 x64。运行时请保留整个解压目录。

## 首次使用

1. **登录微信**：在本机微信客户端登录要分析的账号。
2. **启动软件**：解压运行包，双击 `WechatVibe.exe`，等待本地初始化完成。
3. **打开聊天**：选择联系人或群聊，点击「意图识别」查看消息分析。
4. **查看画像**：进入「人物画像」；群聊可继续选择具体成员。已经保存的结果会先显示，新消息继续更新。

## 源码运行

需要 Node.js **24.11.1**、Python **3.14** 和 npm。在 PowerShell 中执行：

```powershell
git clone https://github.com/tswawa/WechatVibe.git
cd WechatVibe
npm ci
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --no-deps -r python-requirements.lock.txt
npm run setup:models
npm start
```

模型首次下载约 680 MB，下载后校验 SHA-256。Python 安装时请按锁文件安装并保留 `--no-deps`。

### 构建运行版

完成上述依赖和模型安装后，在同一个 PowerShell 窗口运行：

```powershell
$env:PATH = "$PWD\.venv\Scripts;$env:PATH"
npm run build:portable
```

产物位于 `release-real-client/win-unpacked/WechatVibe.exe`。整个 `win-unpacked` 目录构成运行版，包含模型和运行环境。

### 修改词库

当前词库包含 40 个情绪、547 个意图细项、98 个表达方式和 80 个人际需求。同义意图共用 215 个简短显示词，表达方式与人际需求两组词表生成 7,840 个组合。

源文件为 `scripts/analysis-catalog-source.json`、`scripts/intent-display-source.json` 和 `scripts/social-intent-source.json`。修改时保留既有 ID，然后执行：

```powershell
npm run catalog:generate
```

## 数据与隐私

模型推理在本机完成，本地服务只监听回环地址。聊天副本、分析结果和画像按账号保存。

- 只读取自己有权访问的账号和聊天，不用于获取他人的私人记录。
- 清除账号只删除 WechatVibe 保存的数据，不删除微信原始聊天。
- 软件只分析和展示，草稿仅供复制，不自动发送微信消息。
- 不要把聊天数据库、解密密钥、账号缓存或带私人内容的日志上传到仓库、Issue 或交流群。
- 反馈问题前先检查截图和日志，移除不想公开的姓名、账号和对话。

## 免责声明

意图、情绪、好感度和 MBTI 都是模型推测，可能判断错误，仅用于娱乐和个人复盘，不等于对方真实想法、心理诊断或官方测评结果。

微信版本更新可能影响读取兼容性，项目不承诺“零风险”或“不会封号”。WechatVibe 为独立项目，与腾讯、微信没有官方隶属或背书关系。

## 交流与建议

QQ 交流群：**921170374**

<img src="docs/assets/readme/community-qq.jpg" alt="WechatVibe QQ 交流群二维码" width="320">

作者：[tswawa](https://github.com/tswawa) · 问题反馈：[GitHub Issues](https://github.com/tswawa/WechatVibe/issues)

## 许可与致谢

项目采用 [Apache-2.0](LICENSE)。Laya、模型与第三方依赖的来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

演示头像使用 Lisa Wischofsky 的 [Adventurer](https://www.dicebear.com/styles/adventurer/) 插画，经 DiceBear 组合并调整配色，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)；该素材许可独立于项目代码许可。
