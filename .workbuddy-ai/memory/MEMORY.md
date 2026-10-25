# 项目长期记忆 — weixinAnalyzer

## 环境 / 网络
- 仓库是 tswawa/WechatVibe 的 fork（origin = nizitao/WechatVibe，upstream = tswawa/WechatVibe）。
- 访问 github.com 必须走本地代理 **127.0.0.1:6864**。shell 默认注入的 `http_proxy=127.0.0.1:2425` 对 github.com 的 CONNECT 会返回 502（但 api.github.com 可用），直连 github.com:443 会超时。
- 因此 git 网络操作要显式覆盖：`http_proxy=http://127.0.0.1:6864 https_proxy=http://127.0.0.1:6864 git push ...`

## 文档 / 测试约定
- `docs/*.md`、README、CHANGELOG 在工作树里是 **CRLF**；`git diff --check` 会把每条新增行报成 trailing whitespace，属正常，不要为此批量转 LF。
- `npm run test:node` 跑 `tests/*.test.ts` + `tests/*.test.cjs`，2026-10-24 基线 **793 例**（补测后 796）；测试文件 61 个（21 TS + 40 CJS）。
- 文档以**当前工作树**为准（常有未提交改动），不要照 HEAD 写；`docs/TECHNICAL.md` 的 §11.5 是快照，落笔前先 `git status`。

## 启动
- `Start.bat` 现在直接调 `node_modules\electron\dist\electron.exe .`，**不要**改回 `npm start`：本机 `npm` 包装层本身要约 4s。
- `Start.bat` 是 UTF-8，cmd 按 936 解析会偶发把中文行拆成命令（几行「不是内部或外部命令」），属既有问题；根治需纯 ASCII 或 GBK。
- 前端校验函数的长度/字段必须对齐后端真实文档结构（如 `ModelSourceStore.public()` 的 `api` **没有 name**），测试夹具要从后端输出抄，自己编字段会把 bug 盖住。
- **行尾陷阱**：`.gitattributes` 只给 `chatui/*.html|css` 定了 `eol=lf`，`chatui/*.js` 会被 Windows 编辑器存成 CRLF 而 Git 索引仍是 LF（`git status` 显示干净）。按多行源码模式断言的测试读到的可能是 CRLF，会随机失败——断言前先 `.replace(/\r\n/g, "\n")`。
- 这个工作区可能有并行会话同时改同一批文件（docs、app.js、Start.bat 等）；动手前 `git status`，不要回滚别人的改动。22:46 有并行会话把整个工作树一次性提交（`42d0016`），改动会被合并进去。
