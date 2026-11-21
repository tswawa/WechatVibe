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

`native-reader/wr/` 下面按文件拆成了独立 crate，逐个证明。合计 6 个 crate、4,062 条用例全绿。

| # | 单元 | 语言 | 行数 | crate | 状态 |
| ---: | --- | --- | ---: | --- | --- |
| 1 | `wr/crypto.py` | Python | 144 | `rust/wr-crypto-rs` | **done** gate 通过，1172/1172 |
| 2 | `wr/wal.py` | Python | 147 | `rust/wr-wal-rs` | **done** gate 通过，621/621 |
| 3 | `wr/png_encode.py` | Python | 47 | `rust/wr-png_encode-rs` | **done** gate 通过，232/232 |
| 4 | `wr/protocol.py` | Python | 65 | `rust/wr-protocol-rs` | **done** gate 通过，692/692（`read_request`/`write_message` 保留 Python） |
| 5 | `wr/snapshot.py` | Python | 154 | — | open —— 文件系统为主，需要 fixture 目录才能 replay |
| 6 | `wr/fixture.py` | Python | 70 | `rust/wr-fixture-rs` | **done** gate 通过，224/224（只读，testdata 目录随 crate 提交） |
| 7 | `wr/database.py`（自由函数） | Python | 571 | `rust/wr-database-rs` | **done** gate 通过，1121/1121；`SqliteShard`/`ContactStore` 两个查询类仍留在 Python |
| 8 | `wr/discovery.py` | Python | 488 | — | open —— ctypes/Win32 |
| 9 | `wr/window.py` / `window_uia.py` / `window_capture.py` | Python | 755 | — | open —— Win32 + UIA |
| 10 | `wr/service.py` | Python | 803 | — | open —— 编排层，依赖上面全部 |
| 11 | `bridge/` | Python | 20,999 | — | open |
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
