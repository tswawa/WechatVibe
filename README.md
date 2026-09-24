# WechatVibe

Windows 微信聊天分析工具。在本地浏览单聊和群聊，用 Laya 分析消息的情绪、意图和互动特点，逐步整理人物与群聊画像。

模型在本机运行，无需填写云端 API Key。软件使用独立窗口，不会发送微信消息。

[功能](#功能) · [下载安装](#下载安装) · [源码运行](#源码运行) · [安全与免责声明](#安全与免责声明) · [交流群](#交流群)

![WechatVibe 聊天界面](docs/assets/readme/chat-demo.png)

图中的人物名、对话和数值均为虚构演示，使用插画头像，不代表模型实测结果。

## 功能

### 聊天与消息分析

- 同步本机已登录微信的会话，支持单聊、群聊、联系人头像和未读提示。
- 在消息下方显示情绪、意图及其候选概率，每行最多三个候选，搭配颜文字。可以随时关闭或重新显示标签。
- 标签用日常短词，例如分享、试探、承诺、撒娇、傲娇、吃醋、求饶。
- 单聊顶部显示人物情绪，群聊顶部显示聊天氛围。
- 聊天图片显示为 `[图片]`，保留联系人和群聊头像。

意图判断会参考已经保存的人物画像摘要，再结合当前消息和近期聊天。没有画像时先依据聊天内容分析；消息正文优先，MBTI 类型不会被当作一句话的意图。

### 人物与群聊画像

达到 100 条文本的门槛后，可以解锁人物画像，查看六维互动雷达、画像摘要、六个高频词和 MBTI 四维倾向。MBTI 来自聊天推测，不是官方量表测试。

群聊支持整体画像，也可以切换到具体成员。成员分别积累自己的分析结果，群聊整体不标注 MBTI 类型。

![WechatVibe 人物画像](docs/assets/readme/profile-demo.png)

上图同样使用虚构演示数据。

### 看看对方可能怎么接

点击预测按钮，查看对方下一次回应的三个可能意图。输入回复草稿后，也可以把草稿作为预测的参考。

这里预测的是回应方向，例如继续追问、讨论安排或用玩笑回应，不会生成对方下一句的原话。输入框里的草稿可以复制，是否发到微信由你决定。

### 历史记录、账号与运行设置

| 功能 | 使用方式 |
| --- | --- |
| 聊天记录 | 分页浏览历史，按关键词或日期查找，并定位到对应消息。 |
| 账号管理 | 按真实微信账号保存数据，新账号使用独立数据库，已用账号复用原来的记录。 |
| 清除账号 | 清除所选账号在本软件中的聊天副本、分析结果、画像和相关缓存。清除当前账号成功后退出软件，清除其他账号保持运行。 |
| 外观 | 支持浅色和深色模式。 |
| 推理设备 | 可选择 CPU 或 GPU；GPU 不可用时支持回退到 CPU。 |

### 已经算过的，接着用

首次分析会逐步读取本地可用的历史消息，建立画像基线。之后把新增消息收成一批，处理后与已经保存的结果合并。切换聊天或重新打开软件会继续使用原来的结果，不会因为重进界面就重算全部历史。

首次处理很长的聊天记录仍需要时间，速度取决于电脑和文本量。消息浏览、历史查找和画像后台分析是不同的工作，不需要等全部历史分析完才看聊天。

## 下载安装

当前版本：**[WechatVibe 0.1.0](https://github.com/tswawa/WechatVibe/releases/tag/v0.1.0)**。

| 文件 | 用途 |
| --- | --- |
| [WechatVibe-0.1.0-windows-x64.zip](https://github.com/tswawa/WechatVibe/releases/download/v0.1.0/WechatVibe-0.1.0-windows-x64.zip) | Windows 运行版，包含模型与运行环境。 |
| [WechatVibe-0.1.0-source.zip](https://github.com/tswawa/WechatVibe/releases/download/v0.1.0/WechatVibe-0.1.0-source.zip) | 干净源码，用于查看、修改或自行构建。 |

1. 解压 Windows 运行包，保留整个文件夹。
2. 在微信客户端登录账号。
3. 双击 `WechatVibe.exe`，等待首次本地初始化完成。

支持 Windows 10/11 x64，读取兼容性取决于本机微信版本。当前不支持 QQ 客户端接入。

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

先登录微信，再启动 WechatVibe。模型首次下载约 680 MB，下载脚本固定模型版本并校验 SHA-256。Python 安装命令请保留 `--no-deps`：锁文件只包含当前读取链所需的依赖，不安装未使用的 OCR 和媒体处理可选包。

## 构建运行版

完成上述依赖和模型安装后，在同一个 PowerShell 窗口运行：

```powershell
$env:PATH = "$PWD\.venv\Scripts;$env:PATH"
npm run build:portable
```

产物在 `release-real-client/win-unpacked/WechatVibe.exe`。它包含模型和运行环境，使用时双击 EXE 即可。请保留整个 `win-unpacked` 文件夹，不能只复制 EXE。

## 词库

目前有 40 个情绪、547 个意图细项、98 个表达方式和 80 个人际需求。同义意图共用 215 个简短显示词。7,840 个表达与需求组合只是组合词表，不是同等数量的独立训练类别或人工样本。

词库源文件是 `scripts/analysis-catalog-source.json`、`scripts/intent-display-source.json` 和 `scripts/social-intent-source.json`。修改时保留既有 ID，然后重新生成：

```powershell
npm run catalog:generate
```

## 安全与免责声明

- 只处理自己有权访问的账号和聊天。不要用它读取他人账号，或分析未经授权的私人记录。
- 默认在本地推理，本地服务仅监听回环地址。账号清除只影响 WechatVibe 保存的数据，不删除微信原始聊天记录。
- 不要把聊天数据库、解密密钥、账号缓存或含私人内容的日志上传到仓库、Issue 或交流群。反馈问题前先检查截图和日志。
- 情绪、好感度、意图和 MBTI 都可能判断错误，只适合娱乐和个人复盘，不等于对方真实想法、心理诊断或官方测评结果。
- 微信更新可能影响读取兼容性，项目不承诺“零风险”或“不会封号”。WechatVibe 是独立项目，与腾讯、微信没有官方隶属或背书关系。

## 交流群

QQ 群：**921170374**

<img src="docs/assets/readme/community-qq.jpg" alt="WechatVibe QQ 交流群二维码" width="320">

作者：[tswawa](https://github.com/tswawa) · 仓库：[WechatVibe](https://github.com/tswawa/WechatVibe)

## 许可与致谢

项目采用 [Apache-2.0](LICENSE)。Laya、模型与第三方依赖的来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

演示头像使用 Lisa Wischofsky 的 [Adventurer](https://www.dicebear.com/styles/adventurer/) 插画，经 DiceBear 组合并调整配色，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)；该素材许可独立于项目代码许可。
