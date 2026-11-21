# MAP — WechatVibe 全量 Rust 化

目标：把 `D:\project\weixinAnalyzer`（Electron + Python 桌面客户端）整体迁到 Rust，
原始代码保留作参考，直到 `app lift` 完成、行为由录制用例证明。

迁移工具：`rust-anything` 2.1.0。本文件是**计划与认领**；`PORT_MAP.md`（`rust-anything map --write`）
才是**实测状态**。两者不一致时以 PORT_MAP 的测量为准，回来修本文件。

## 规模（analyze 实测）

| 语言 | 源文件 | 行数 | 单元 |
| --- | ---: | ---: | ---: |
| TS/JS | 95 | 27,274 | 9 |
| Python | 94 | 29,874 | 3 |

`analyze` 一次只认一种语言，所以两份报告都要看：`rust/analyze/ts-js.md`、`rust/analyze/python.md`。

## 单元状态

`native-reader/wr/` 下面按文件拆成了独立 crate，逐个证明。合计 6 个 bridge crate（4,062 条录制用例）+ 8 个独立 crate（201 金标准 + 30 双目录差分 + 26 discovery 差分 + 22 解密差分 + 21 服务层差分 + 12 单元测试）全绿。

| # | 单元 | 语言 | 行数 | crate | 状态 |
| ---: | --- | --- | ---: | --- | --- |
| 1 | `wr/crypto.py` | Python | 144 | `rust/wr-crypto-rs` | **done** gate 通过，1172/1172 |
| 2 | `wr/wal.py` | Python | 147 | `rust/wr-wal-rs` | **done** gate 通过，621/621 |
| 3 | `wr/png_encode.py` | Python | 47 | `rust/wr-png_encode-rs` | **done** gate 通过，232/232 |
| 4 | `wr/protocol.py` | Python | 65 | `rust/wr-protocol-rs` | **done** gate 通过，692/692（`read_request`/`write_message` 保留 Python） |
| 5 | `wr/snapshot.py` | Python | 155 | `rust/wr-snapshot-rs` | **done** 双目录差分 30/30（22 响应 + 8 文件），`cargo test` 2/2 |
| 6 | `wr/fixture.py` | Python | 70 | `rust/wr-fixture-rs` | **done** gate 通过，224/224（只读，testdata 目录随 crate 提交） |
| 7 | `wr/database.py`（自由函数） | Python | 571 | `rust/wr-database-rs` | **done** gate 通过，1121/1121 |
| 7b | `wr/database.py` → `SqliteShard` + `ContactStore` | Python | 495 | `rust/wr-query-rs` | **done** 201/201 金标准操作，`cargo test` 固化 |
| 8 | `wr/discovery.py`（路径/配置部分） | Python | ~240 | `rust/wr-discovery-rs` | **done** 26/26 差分；进程扫描与内存扫描未移植 |
| 8b | `wr/discovery.py`（进程/内存扫描） | Python | ~248 | — | open —— ctypes/Win32，依赖活进程 |
| 9 | `wr/window.py` 几何部分 + Win32 进程发现 | Python | ~500 | `rust/wr-win32-rs` | **done** 6 项单元测试；Win32 读取活状态，无法差分（ADR-017） |
| 9b | `window_capture.py` / `window_uia.py` 模型 | Python | ~500 | `rust/wr-win32-rs` | **done** —— GDI 截图 + UIA COM 遍历（有界），无等价证明；控制类型报数字 id 而非名字 |
| 10d | `NativeService` live 连接 | Python | ~180 | `rust/wr-native-rs` | **done** —— 进程内存密钥候选 + 分片解密 + store 构建，无等价证明 |
| 10 | `wr/service.py`（解密热循环 + 自由函数） | Python | ~140 | `rust/wr-service-core-rs` | **done** 22/22 差分；`NativeService` 类仍留在 Python |
| 10b | `wr/service.py` → `NativeService`（fixture 模式） | Python | ~350 | `rust/wr-native-rs` | **done** 21/21 差分（含 read_incremental）；live 模式未移植 |
| 10c | `wr/service.py` → `NativeService`（live 模式） | Python | ~313 | — | open —— 依赖活进程与窗口 |
| 11 | `bridge/message_contracts.py` | Python | 94 | `rust/bridge-message-contracts-rs` | **done** gate 通过，59/59 |
| 11a | `bridge/message_results.py` | Python | 147 | `rust/bridge-message-results-rs` | **done** gate 通过，446/446 |
| 11b | `bridge/profile_signals.py` | Python | 92 | `rust/bridge-profile-signals-rs` | **done** 595/595；gate 仅 size 启发式失败（5.3x，因逐条复刻 Python 容器/异常语义） |
| 11c | `bridge/` 其余 | Python | ~20,600 | — | open |
| 12 | `electron/laya/` | TS | 3,462 | — | open |
| 13 | `electron/` | TS | 4,527 | — | open |
| 14 | `shared/` + `src/lib/` | TS | 698 | — | open |
| 15 | `chatui/` | JS | 10,127 | — | open（UI，最终随 Tauri 外壳处理） |
| 16 | `ui/advisor/`、`ui/advisor/vendor/opencode/` | JS | 333 | — | open（UI，同上） |
| — | `scripts/` | TS+Py | 13,237 | — | **out of scope**（ADR-003） |

## 已认领

无。

## 上个会话的结论（必读）

`bench` 对单元 1 的判定是**不要按当前形态上线**：8 个函数里只有 2 个提速，整体 0.37x。
原因是每次调用都要过 JSON 桥，而单个函数只做 4 KB 的活。
见 ADR-006 —— 想拿性能必须**把调用方一起 port**，让一次调用做完整一个分片的解密。
单元 2~4 同样只是"可证明正确的构件"，性能收益要等 `service.py` 整体落地后才成立。

## 已知工具限制（不要被它们误导）

1. **`analyze` 一次只认一种语言** —— 混语言仓库必须跑两遍（`--lang python` 单独跑一次），
   否则 Python 那 3 万行完全不出现在计划里。
2. **`bridge` 的 unit id 取决于 root** —— 对 `wr/` 这种包内文件，必须 `rust-anything bridge native-reader wr/crypto.py`，
   用仓库根会报 `no unit or source file`。
3. **`map --write` 在混语言仓库里不准** —— 它重新 analyze 时只看到 TS 单元，
   会把已有的 Python port 报成 "None yet"。所以本仓库暂时**不提交 `PORT_MAP.md`**。
4. **`analyze` 会把 UI 判成可移植** —— `chatui/` 被标为 wasm-bindgen 可移植，实际是渲染层，按 ADR-001 保留。
5. **`refresh` 会清掉手改的 `lib.rs`** —— 自定义异常映射（ADR-005）写在 `lib.rs`，
   每次 `refresh` 后要重新施加。四个 crate 里 `wr-crypto-rs`、`wr-protocol-rs` 有这段代码。

## 下一步

`wr/database.py` 是下一个有实质收益的单元（SQLite 查询 + zstd 解压），但它和 `snapshot.py`
都需要**真实文件**才能 replay：要先准备一套最小 fixture 目录，再 `record --inputs`。

## 范围外

- `scripts/`：一次性构建 / 训练 / 打包脚本，port 零收益。
- 上游 fork 关系：本仓库是 `tswawa/WechatVibe` 的 fork，跟着上游走，不另起实现。

- `scripts/`：一次性构建 / 训练 / 打包脚本，port 零收益。
- 上游 fork 关系：本仓库是 `tswawa/WechatVibe` 的 fork，跟着上游走，不另起实现。
