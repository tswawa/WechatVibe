# DECISIONS — 架构决策记录

一条一个 ADR，编号只增不改。被推翻的用新 ADR supersede，不回头改旧条目。

## ADR-001: 全量 Rust 化，UI 最后才换壳

Status: accepted (2026-11-21)

Context: 用户要求全量 Rust 化。项目是 Electron + Python 后端。`analyze` 把 shape 判成
HTTP server，实际是桌面 app（它只找到了 `scripts/advisor-native-smoke.ts` 里的一个
`createServer(`）。`chatui/` 10,127 行是渲染层纯 HTML/JS，被误标为可移植。

Decision: 后端逻辑（Python + Electron 主进程）逐单元迁到 Rust；渲染层 UI 保持 web 资源不动，
最后一步用 Tauri 承载（同一份 web UI，Rust 后端），而不是重写成 Rust GUI。

Consequences: 每一步 app 都可运行；UI 不用翻译；但 Tauri 切换是不可逆的大动作，放在 lift 之后。

## ADR-002: 等价标准 —— 字节级精确，不放宽浮点

Status: accepted (2026-11-21)

Context: 本项目涉及解密、分数、统计与标签 schema。LLM 调用走外网且带采样随机性。

Decision: 纯函数按**字节级**精确比对（不设 `--float-tolerance`）；错误按「异常类名 + 消息」
比对；LLM 请求**不录制**（无法产生稳定 baseline），只对纯计算单元录用例。

Consequences: 加密/解密/统计可以做到完全可证明；对外部 API 的行为由集成测试而非 replay 保证。

## ADR-003: `scripts/` 不纳入迁移

Status: accepted (2026-11-21)

Context: `scripts/` 合计约 13,237 行（TS 7,363 + Python 5,874），全是一次性构建、训练、
打包脚本；TS 侧 `analyze` 判为 `blocked`（用了 `eval` / 计算型 import）。

Decision: 不迁移。它们只在开发期跑，不属于产品行为。

Consequences: 若将来要 Rust 化构建流程，另开项目，不在本 MAP 内。

## ADR-004: `PageKey` 以 JSON 跨界

Status: accepted (2026-11-21)

Context: `PageKey` 是 Python `@dataclass(frozen=True)`，`bridge` 把它列为 `js_only`
（"stays in Python"）。但生成的绑定 `pyconv::from_py` 只认基础类型 / bytes / list / dict /
set / tuple，遇到任意对象直接 `TypeError`；`to_py` 也没有 `$object` 分支。所以带 `PageKey`
的 4 个函数（`make_page_key` / `decrypt_page` / `encrypt_page` / `validate_key`）默认**无法调用**。

Decision: `PageKey` 在 Rust 侧用内部结构体表示，跨边界时编码为
`{"key": {"$bytes": [..]}, "salt": .., "hmac_key": ..}`（也接受
`{"$object": "PageKey", "attrs": {..}}`，即录制用例的原样形状）。返回侧回吐同一形状。

Consequences: 走通 diff/gate；但 Python 调用方拿到的是 dict 而非 `PageKey` 实例，
所以**不能靠生成的 shadow 做 drop-in**。这个限制在单元 2 把调用方一起 port 之后自动消失
（届时没有 Python 边界）。

## ADR-005: 自定义异常类由 `lib.rs` 反查原包

Status: accepted (2026-11-21)

Context: 原版抛 `wr.errors.ProtocolError(code, message)`。生成的 `error()` 只映射 stdlib 异常
（TypeError / ValueError / ...），`ProtocolError` 落到 `_ => PyValueError`，于是调用方看到
`ValueError("ProtocolError: ...")` —— 类名错了，且 `.code` 属性丢失，会破坏 Electron 侧
「错误码 → NativeWechatState」的映射。

Decision: `port.rs` 把错误写成 `ProtocolError(<code>): <message>`；`lib.rs` 的 `error()` 识别这个
前缀，`import wr.errors` 取到真实类并以 `(code, message)` 实例化。
原包不可导入时（replay 沙箱只把 crate 的 `python/` 放进 `sys.path`），就地定义一个同名同签名的
等价类兜底，保证类名与 `str()` 一致。

Consequences: 生产环境抛的是真类，`isinstance` 与 `.code` 都成立；沙箱里是等价类，只有类身份不同。
**注意：`rust-anything refresh` 会重新生成 `lib.rs`，这段手改会被覆盖，需要重新施加。**

## ADR-006: crypto 不按「逐函数桥」上线，必须连同调用方一起 port

Status: accepted (2026-11-21)

Context: 单元 1 的 `bench` 结果（ns/call，含跨界）：

| 函数 | 原版 | Rust | 倍率 |
| --- | ---: | ---: | ---: |
| derive_hmac_key | 2,833 | 2,087 | 1.36x |
| make_page_key | 1,258 | 2,673 | 0.47x |
| derive_key_from_passphrase | 6,269,433 | 5,431,201 | 1.15x |
| decrypt_page | 4,000 | 7,682 | 0.52x |
| encrypt_page | 2,371 | 4,789 | 0.50x |
| is_valid_sqlite_page_one | 373 | 12,310 | 0.03x |
| validate_key | 2,769 | 18,423 | 0.15x |
| looks_like_key | 151 | 390 | 0.39x |

整体几何平均 0.37x —— 比 Python 慢。

Decision: 单元 1 只作为**可证明正确的构件**保留，不接线上。真热路径是
`service.py:_decrypt_shard_pages`：一次处理整个分片的所有页。把它整体 port，
让一次调用做 4096×N 字节的活，才能摊销跨界成本。

Consequences: 单元 2 的验收标准不只是 gate 通过，还包括 `bench` 相对原版 ≥1.1x；
否则说明边界仍然切错，要继续往调用方靠。

## ADR-007: dataclass 一律按 `$object` JSON 形状跨界

Status: accepted (2026-11-21)

Context: ADR-004 只在 `PageKey` 上验证过。`wr/wal.py` 的 `WalFrame` / `WalParseResult` 是同样的
局面（`bridge` 判为 `js_only`），而 `parse_wal` 的返回值整个就是这两个 dataclass。

Decision: 返回侧一律输出录制器给 dataclass 用的同一形状
`{"$object": "<类名>", "attrs": {<字段名>: <值>}}`，字段顺序与 dataclass 定义一致；
`tuple` 用 `{"$tuple": [...]}`、`bytes` 用 `{"$bytes": [...]}`。原因：`diff` 比的是**编码后的值**，
只要形状一致就等价；`to_py` 会把它变成普通 dict，但编码回来仍然是同一份 JSON。

Consequences: 返回值在 Python 侧是 dict 而不是 dataclass 实例，`isinstance` 判定会失败。
和 ADR-004 一样，这是过渡期的限制，等调用方一起 port 就没有边界了。

## ADR-008: PNG 压缩必须用真 zlib，不能用 miniz_oxide

Status: accepted (2026-11-21)

Context: `png_encode.py` 用 `zlib.compress(data, 6)`。Rust 的 `flate2` 默认后端是 miniz_oxide，
同样 level 6 但 deflate 实现不同，**产出的字节不一样**，输出就不再等价。

Decision: `flate2` 关掉默认特性、启用 `zlib`（`libz-sys`，编进 CPython 的那个 zlib）。

Consequences: 9 个真实尺寸的 PNG 全部字节级一致（232/232）。代价是多一次 C 编译，
且依赖 zlib 版本行为稳定 —— 换 zlib 大版本时要重跑 diff。

## ADR-009: Python 的 `len()` / `type()` 语义要逐个复现

Status: accepted (2026-11-21)

Context: 原版大量用 `len(x) != N` 做前置校验。Python 里 `len()` 对 int / bool / None 抛
`TypeError: object of type 'X' has no len()`，对 str 数字符（码点）而不是字节；`int.from_bytes`
对非 bytes 抛 `cannot convert 'list' object to bytes`。直接照 Rust 的类型写会静默改变错误路径。

Decision: 每个 port 里写 `py_len` / `type_name` 辅助函数：bytes 数字节，str 数 `chars().count()`，
容器数元素，其余抛 `TypeError`。入口函数先做 `len` 判定再取字节，顺序与原版一致。

Consequences: 错误消息与异常类型逐字一致；代价是每个 crate 有十几行样板。
`wal.py` 的 12 个不匹配、`png_encode.py` 的 29 个不匹配都是这一类，改完立刻归零。

## ADR-010: Python 的整数是任意精度，`normalize_time` 要能吃 1e308

Status: accepted (2026-11-21)

Context: `normalize_time` 走 `int(value)`，Python 的 int 无上限。fuzz 用例里有 `1e21` 和
`1.7976931348623157e308`，原版返回精确的十进制整数（309 位），Rust 用 `i64` 直接截断成 `i64::MAX`，
输出就不等了。另外 `int(float('nan'))` 抛 `ValueError`（被 `except` 吞成 0），
`int(float('inf'))` 抛 `OverflowError`（不吞，直接冒给调用方）——两者处理路径不同。

Decision: 内部用 `enum PyNum { Small(i64), Big(String) }`。超出 `i64` 的浮点走
`format!("{:.0}", f)` —— Rust 的这个格式化给出 f64 的**精确**十进制展开，正是 `int(f)` 的结果；
字符串溢出的走 `parse_big`（去符号、下划线、前导零）。返回时大数编码成 `{"$int": "<十进制>"}`。
NaN 当作"转换失败"返回 `None` → 0；Infinity 抛 `OverflowError`。

Consequences: 4 个边界用例从不匹配变匹配。代价是 `normalize_time` 的返回类型从 `i64` 变成
`serde_json::Value`（也因此 `refresh` 会重新生成绑定）。

## ADR-011: 类不适合 bridge，改用「金标准操作集」证明

Status: accepted (2026-11-21)

Context: `SqliteShard` 和 `ContactStore` 是类，边界是一个活着的 `sqlite3` 连接，`pyconv` 带不过去，
`record`/`diff` 对它们失效。但它们恰恰是 `wr/` 里逻辑最重的一块（SQL 分页、游标、跨分片归并）。

Decision: 换一种证明方式，`rust/wr-query-rs`：
1. `tools/build-golden.py` 用**原版 Python** 造一个 fixture 分片（Name2Id + 两张 Msg_ 表，
   含秒/毫秒时间戳、zstd 正文、非法 UTF-8、Name2Id 里缺失的 sender），
   把 201 个操作跑一遍，输出 `testdata/expected.json`。
2. Rust 侧实现同样的类，`src/main.rs` 重放同一批操作，`tests/golden.rs` 逐条比对，
   不一致就打印 op 序号、参数和两边的完整 JSON。
3. `tools/compare.py` 提供不依赖 cargo 的端到端复跑。

Consequences: 证明力与 record/diff 等价（同样的输入、同样的输出、逐条比对），代价是用例要手写，
且新增行为要同时补 Python 侧和 Rust 侧的操作。第一次跑就发现一个真问题：
用例里 `set_self_username(None)` 排在取数操作之前，导致 `side` 三个分支只覆盖了一个 —— 顺序一调，
`self`/`other`/`unknown` 才全部跑到。

## ADR-012: 金标准用例的参数必须由两边共同读取

Status: accepted (2026-11-21)

Context: 加 `ContactStore.page()` 时，Python 侧把 cutoff 硬编码在调用里
（`store.page(username, 4_000_000_000_000, None, limit)`），而 Rust 侧从 op 里读 `cutoff_ms` ——
op 里没这个字段，于是 Rust 拿到 0，9 个 page 用例全返回空。两边"都过了自己的测试"，但不一致。

Decision: 金标准操作 JSON 是双方唯一的输入契约。任何影响结果的参数都必须写进 op，
Python 侧也从 `op[...]` 读，不许在驱动代码里硬编码。

Consequences: 这条约束已经写进 `tools/build-golden.py`：page 的 `cutoff_ms` 现在随 op 传递。
代价是 op JSON 略微冗长，换来的是"两边真的在比较同一件事"。

## ADR-013: 会写文件的模块用「双目录差分」证明

Status: accepted (2026-11-21)

Context: `snapshot.py` 会创建、覆盖、删除文件，不能像 `fixture.py` 那样只读重放；
`create_snapshot` 还用 `uuid4()` 生成随机 id，两次运行必然不同。

Decision: `tools/compare.py` 用双目录差分：
1. 同一份初始目录复制成两份，Python 与 Rust 各跑同一批 22 个操作。
2. 比对所有返回值，以及跑完之后整棵目录树的**文件名和字节**。
3. 随机 uuid 按创建顺序映射成 `snap0` / `snap1` 再比 —— 不能直接全替换成一个占位符，
   否则两个快照文件名会撞成同一个 key，等于少比了文件（确实踩过，30/30 变成假的 29/29）。
4. Python 侧 `json.dumps` 的默认分隔符是 `", "` / `": "`，Rust 侧手写同款序列化，
   否则元数据文件的字节会不同。

Consequences: 结果 30/30（22 个响应 + 8 个文件）一致。代价是每个写操作都要在 op 里显式编码，
不能靠录制器自动生成。

## ADR-014: discovery 只移植可复现的一半

Status: accepted (2026-11-21)

Context: `discovery.py` 混了两类代码：路径/配置解析（确定性，能差分）和
`find_weixin_processes` / `process_open_file_paths` / 内存扫描（读活进程，两次运行结果天然不同）。

Decision: `rust/wr-discovery-rs` 只移植前者：`opaque_account_id`、`_is_under`、配置解码
（UTF-8 BOM / UTF-16 / GBK）、配置值提取、`discover_account_dirs(roots)`、`discover_shards`。
26 个操作在合成目录树上与原版逐条一致。活进程扫描明确列为未完成，**不假装有等价证明**。

Consequences: 未来接 `service.py` 时，进程信息只能由 Rust 侧用 `windows` crate 重新实现，
并单独设计自测；不能声称和原版做过输入输出比对。

## ADR-015: 解密热循环按「一次调用一个分片」落地

Status: accepted (2026-11-21)

Context: ADR-006 的 bench 结论是逐页跨桥比 Python 慢（0.37x）。`_decrypt_shard_pages` 在一次调用里
处理整个分片的所有 4096 字节页 + 已提交 WAL 帧，才值得做成 Rust。

Decision: `rust/wr-service-core-rs` 把该函数连同 `_decrypt_shard_image` 和 4 个自由函数一起移植。
crypto / wal 的已证明实现直接复制进这个 crate 作为 `mod`，避免 pyo3 extension-module 的链接问题。
22 个操作用合成 SQLCipher 分片差分，成功路径确实跑到了：3 页主库 + 1 个 WAL 帧 → 3+1 页，
commit_pages=2，最终镜像 8192 字节且带 SQLite 头。

踩到的两个坑：
1. WAL 头/帧的盐是 **4 字节**，和 SQLCipher 第 1 页的 16 字节盐不是一回事。传错会让头长从 32 变 56，
   `parse_wal` 直接判为 corrupt（4 个用例全落在错误分支，差点假绿）。
2. crypto 的 port 已经把错误编码成 `ProtocolError(code): msg`，外层再包一次会变成双前缀。

Consequences: 22/22 一致，`cargo test` 3/3。`NativeService` 仍是 Python，它依赖活进程与窗口状态。

## ADR-016: 服务层用 fixture 模式证明，live 模式不假装有证明

Status: accepted (2026-11-21)

Context: `NativeService` 的 live 路径要扫活进程、活窗口；fixture 模式则读 manifest 里的明文 DB，
但两者共用同一套 contacts / keyset 分页 / 快照冻结 / 增量读取逻辑。

Decision: `rust/wr-native-rs` 只移植 fixture 路径，把已经证明的 crypto / wal / database / snapshot /
fixture / protocol 模块组合进一个自包含 crate（避免 pyo3 extension-module 的链接问题）。
18 个操作与原版逐条一致：hello / status / accounts / connect / contacts / latest / open_history /
read_history / close。成功路径确实读到 3 行分页数据和 total=12。

踩到的坑：
- 快照里 `datasetId` 指向的 dataset meta 才含 `shards`，不能从 snapshot meta 直接读；
- `create_snapshot` 的随机 uuid 要归一化，否则只差 id 就会被误判为不等价；
- Rust 二进制自己生成快照 id，占位符 `__snap0` 需要「先跑一次拿 id、再重写 ops 跑第二次」。

Consequences: live 模式、window 方法、进程/内存扫描明确列为未完成。

## ADR-017: Win32 层只做单元自测，明确不声称等价

Status: accepted (2026-11-21)

Context: `wr/window.py` 的窗口枚举/几何、`window_uia.py` 的 UIA 树、`window_capture.py` 的截图，
以及 discovery 的进程/内存扫描，都读活桌面。原版两次运行的结果本身就不相同，任何"逐条比对
输入输出"的证明都不成立。

Decision:
- `rust/wr-win32-rs` 用 `windows` crate 实现进程枚举（Toolhelp32）、窗口枚举（EnumWindows +
  GetWindowRect / GetClientRect / ClientToScreen / GetDpiForWindow）、几何 payload 组装、
  `active_account_id` 匹配、`_is_under`、密钥字面量扫描。
- 可判定的部分（payload 形状、primary 选择、进程名过滤、key literal 扫描、路径边界）做 6 项
  单元测试；Win32 adapter 明确不测试。
- `window_uia_method` 在无窗口时返回原版的 `{"ok": false, "reason": "no-window"}`，有窗口时
  返回显式 `uia-unavailable`，**不伪装成等价实现**。
- `NativeService` live 模式构造函数、进程/账号刷新入口已接上；`_connect_live` 的密钥扫描与
  内存读取没有移植。

Consequences: 至此不再有任何"声称与 Python 等价"的缺口被掩盖。UIA 树遍历与截图是真正未完成的功能。

## ADR-018: Win32 层收尾范围

Status: accepted (2026-11-21)

Context: 截图、UIA、进程内存扫描是最后三块 Win32 代码。

Decision:
- `window_capture`：GDI `BitBlt` + `GetDIBits` 抓客户区，BGR→RGB 后复用已证明的 zlib PNG 编码；
  只在 `capture=true` 时执行，不落盘。
- 进程内存：`OpenProcess` + `VirtualQueryEx` + `ReadProcessMemory`，8 MiB 分块、最多 4096 块、
  512 MiB 上限；只返回密钥字面量，纯扫描函数有单元测试。
- UIA：实现有界树模型（`probe_tree`，节点/深度上限与 offscreen 剪枝，7 项单元测试之一），
  但 COM 树遍历未接；有窗口时返回显式 `uia-unavailable`。
- `NativeService::connect_live`：解析 96-hex `x'<key><salt>'` 候选，逐个尝试解密分片，
  用 SQLite 头验证候选正确性，构建 `ContactStore`。无等价证明。

Consequences: 没有再以"等价"名义交付的 Win32 代码。真正未实现的是 UIA COM 树遍历。

## ADR-019: UIA COM 已接通，控制类型保留数字 id

Status: accepted (2026-11-21)

Context: `windows` crate 0.58 的 UIA 在 `Win32_UI_Accessibility`，不是 `UI_UIAutomation`；
`CUIAutomation` 是 GUID 常量，要用 `CoCreateInstance` 取 `IUIAutomation`。

Decision: `probe_uia` 用 `CoInitializeEx` + `CoCreateInstance` + `ElementFromHandle` +
`FindAll(TreeScope_Descendants, TrueCondition)`，逐元素读 CurrentName / AutomationId /
IsEnabled / IsOffscreen / BoundingRectangle / ControlType，节点数受 maxNodes 上限约束。
控制类型返回 UIA 数字 id，未映射到 Python 的名字字符串 —— 这是明确的行为差异。

Consequences: UIA 树遍历不再是 stub。仍无等价证明：三次差异全部来自活桌面状态。
