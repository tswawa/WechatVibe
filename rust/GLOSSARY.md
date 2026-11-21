# GLOSSARY — 领域术语与 Rust 命名

每个单元引入新术语时补进来，保证 Rust 侧和原版叫同一件事同一个名字。

| 原版术语 | 出处 | 含义 | Rust 命名 |
| --- | --- | --- | --- |
| `PageKey` | `wr/crypto.py:39` | 一个盐对应的一组派生密钥（`key` / `salt` / `hmac_key`），只在内存 | `struct PageKey`（`port.rs`，私有） |
| `raw_key` | `wr/crypto.py:56` | 32 字节的数据库主密钥 | `raw_key: Vec<u8>` |
| `salt` | 同上 | 16 字节，主库第 1 页前 16 字节 | `salt: Vec<u8>` |
| `hmac_key` | `wr/crypto.py:51` | `PBKDF2-HMAC-SHA512(raw_key, salt^0x3a, 2 轮, 32 字节)` | `hmac_key: Vec<u8>` |
| `usable` page | `wr/crypto.py:101` | 去掉保留区（80 字节）后的明文页，4016 字节 | `usable: Vec<u8>` |
| reserved | `wr/crypto.py:29` | 每页尾部 80 字节 = 16 字节 IV + 64 字节 HMAC | `RESERVED` |
| shard | `wr/service.py` | 一个微信 DB 分片文件（含 WAL） | `shard` |
| `main_page_one` | `wr/crypto.py:80` | 是否为主库第 1 页（前 16 字节是 salt，明文要补回 SQLite 头） | `main_page_one: bool` |
| `ProtocolError` | `wr/errors.py:52` | 带稳定 `code` 的协议异常，Electron 侧按 code 映射状态 | `ProtocolError(<code>): <msg>` 错误串（ADR-005） |

## 错误码（`wr/errors.py`，与 Rust 错误串的 code 段一致）

| code | 何时 | Rust 里由谁产生 |
| --- | --- | --- |
| `key_unavailable` | 密钥不可用 / 页 HMAC 不匹配 | `make_page_key`、`decrypt_page` |
| `unsupported_schema` | 盐长度或 schema 不符 | `make_page_key` |
| `read_error` | 页长度不对、第 1 页盐不匹配 | `decrypt_page` |
