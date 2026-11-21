# Rust migration plan: weixinAnalyzer (Python)

1 packages, 94 source files (29874 lines), 86 test files, 0 UI files, grouped into 3 units.

| Ready | Caution | Blocked | Keep in source language |
| ---: | ---: | ---: | ---: |
| 0 | 3 | 0 | 0 |

## Start here

Best first ports: safe to port (readiness) and worth porting (loops and string work, tests, size).

| # | Unit | Lines | Priority | Readiness | Tests | Bridge | Main risks |
| ---: | --- | ---: | ---: | ---: | ---: | --- | --- |
| 1 | `scripts/` | 5874 | 28 | 0 | 0 | PyO3 | Hash iteration order (87); String offsets and slicing (56); numpy array parameters (20) |
| 2 | `native-reader/wr/` | 3001 | 27 | 0 | 0 | PyO3 | String offsets and slicing (81); Hash iteration order (21); Dynamic typing (29) |
| 3 | `bridge/` | 20999 | 24 | 0 | 0 | PyO3 | Hash iteration order (449); String offsets and slicing (171); Regex features the `regex` crate lacks (1) |

### `scripts/`

5874 lines in 29 files, wave 0, priority 28, readiness 0, bridge **PyO3**.

- 15 PyPI dependencies not in the crate table: check them by hand.
- Leaf: imports no other unit.
- Hash iteration order x87: `scripts/build-model-asset.py:56`, `scripts/build-model-asset.py:56`, `scripts/build-portable-clean.py:90`
- String offsets and slicing x56: `scripts/build-portable-clean.py:91`, `scripts/build-portable-clean.py:92`, `scripts/build-portable-clean.py:101`
- numpy array parameters x20: `scripts/train-mbti-linear.py:138`, `scripts/train-mbti-linear.py:138`, `scripts/train-mbti-linear.py:155`
- Dynamic typing x134: `scripts/build-model-asset.py:28`, `scripts/build-portable-clean.py:52`, `scripts/build-portable-clean.py:58`
- Class inheritance x16: `scripts/start-real-client.py:52`, `scripts/start-real-client.py:56`, `scripts/test-build-portable-clean.py:26`
- Division and modulo x13: `scripts/perf-baseline.py:57`, `scripts/perf-baseline.py:107`, `scripts/perf-baseline.py:123`
- Integer width and overflow x11: `scripts/build-windows-release.py:32`, `scripts/real-client-update-extract.py:18`, `scripts/real-client-update-extract.py:19`
- Concurrency x4: `scripts/run-python-tests.py:82`, `scripts/test-launcher-port-selection.py:108`, `scripts/test-start-real-client.py:100`
- Generators x2: `scripts/start-real-client.py:373`, `scripts/start-real-client.py:373`
- Exceptions x335: `scripts/advisor-package-grant.py:12`, `scripts/advisor-package-grant.py:14`, `scripts/advisor-package-grant.py:18`
- Number semantics x32: `scripts/build-windows-release.py:107`, `scripts/build-windows-release.py:233`, `scripts/build-windows-release.py:257`

### `native-reader/wr/`

3001 lines in 15 files, wave 0, priority 27, readiness 0, bridge **PyO3**.

- 3 PyPI dependencies not in the crate table: check them by hand.
- Leaf: imports no other unit.
- String offsets and slicing x81: `native-reader/wr/crypto.py:85`, `native-reader/wr/crypto.py:87`, `native-reader/wr/crypto.py:88`
- Hash iteration order x21: `native-reader/wr/database.py:32`, `native-reader/wr/database.py:152`, `native-reader/wr/database.py:155`
- Dynamic typing x29: `native-reader/wr/database.py:79`, `native-reader/wr/database.py:82`, `native-reader/wr/database.py:84`
- Generators x8: `native-reader/wr/database.py:346`, `native-reader/wr/database.py:346`, `native-reader/wr/database.py:428`
- Division and modulo x8: `native-reader/wr/service.py:143`, `native-reader/wr/service.py:148`, `native-reader/wr/window_capture.py:159`
- Integer width and overflow x7: `native-reader/wr/database.py:487`, `native-reader/wr/database.py:520`, `native-reader/wr/service.py:636`
- Class inheritance x5: `native-reader/wr/discovery.py:356`, `native-reader/wr/errors.py:52`, `native-reader/wr/errors.py:61`
- Concurrency x1: `native-reader/wr/window_capture.py:288`
- Exceptions x128: `native-reader/wr/crypto.py:58`, `native-reader/wr/crypto.py:60`, `native-reader/wr/crypto.py:83`
- Number semantics x61: `native-reader/wr/crypto.py:48`, `native-reader/wr/crypto.py:125`, `native-reader/wr/crypto.py:137`

### `bridge/`

20999 lines in 50 files, wave 0, priority 24, readiness 0, bridge **PyO3**.

- 49 PyPI dependencies not in the crate table: check them by hand.
- 4 imports use aliases or virtual modules and were not followed.
- Leaf: imports no other unit.
- Hash iteration order x449: `bridge/account_pin_source.py:47`, `bridge/account_pin_source.py:47`, `bridge/account_pin_source.py:161`
- String offsets and slicing x171: `bridge/advisor_context.py:155`, `bridge/advisor_context.py:576`, `bridge/advisor_context.py:687`
- Regex features the `regex` crate lacks x1: `bridge/advisor_packages.py:49`
- Regexes built at runtime x1: `bridge/backend_service.py:1367`
- Dynamic typing x1610: `bridge/account_api.py:17`, `bridge/account_api.py:21`, `bridge/account_api.py:52`
- Generators x86: `bridge/advisor_context.py:559`, `bridge/advisor_context.py:559`, `bridge/advisor_service.py:841`
- Class inheritance x32: `bridge/account_pin_source.py:33`, `bridge/account_store.py:24`, `bridge/account_store.py:28`
- Division and modulo x28: `bridge/advisor_context.py:578`, `bridge/advisor_context.py:593`, `bridge/advisor_context.py:605`
- Concurrency x15: `bridge/advisor_context.py:411`, `bridge/advisor_runtime.py:53`, `bridge/advisor_service.py:628`
- Integer width and overflow x13: `bridge/advisor_context.py:504`, `bridge/advisor_context.py:505`, `bridge/advisor_contracts.py:429`
- Exceptions x1318: `bridge/account_api.py:40`, `bridge/account_api.py:74`, `bridge/account_api.py:86`
- Number semantics x51: `bridge/account_pin_source.py:131`, `bridge/account_store.py:65`, `bridge/advisor_http.py:14`

## Order by package

Packages come after the workspace packages they use. Inside a package, port by wave: a unit's imports are in earlier waves.

### 1. root (`.`, portable, 86 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `bridge/` | caution | 20999 | 0 | PyO3 | Hash iteration order (449); String offsets and slicing (171) |
| 0 | `native-reader/wr/` | caution | 3001 | 0 | PyO3 | String offsets and slicing (81); Hash iteration order (21) |
| 0 | `scripts/` | caution | 5874 | 0 | PyO3 | Hash iteration order (87); String offsets and slicing (56) |

## PyPI dependencies

| Package | Units | Rust | Fit | Note |
| --- | ---: | --- | --- | --- |
| `psutil` | 3 | ? | unknown |  |
| `advisor-contracts` | 2 | ? | unknown |  |
| `advisor-imports` | 2 | ? | unknown |  |
| `backend-contracts` | 2 | ? | unknown |  |
| `installation-gate` | 2 | ? | unknown |  |
| `instance-identity` | 2 | ? | unknown |  |
| `local-model-source` | 2 | ? | unknown |  |
| `model-bundle` | 2 | ? | unknown |  |
| `model-source` | 2 | ? | unknown |  |
| `profile-signals` | 2 | ? | unknown |  |
| `profile-state` | 2 | ? | unknown |  |
| `result-store` | 2 | ? | unknown |  |
| `wechat-source` | 2 | ? | unknown |  |
| `account-api` | 1 | ? | unknown |  |
| `account-leases` | 1 | ? | unknown |  |
| `account-pin-source` | 1 | ? | unknown |  |
| `account-store` | 1 | ? | unknown |  |
| `advisor-context` | 1 | ? | unknown |  |
| `advisor-http` | 1 | ? | unknown |  |
| `advisor-packages` | 1 | ? | unknown |  |
| `advisor-runtime` | 1 | ? | unknown |  |
| `advisor-service` | 1 | ? | unknown |  |
| `advisor-store` | 1 | ? | unknown |  |
| `api-pool` | 1 | ? | unknown |  |
| `api-portrait-ledger` | 1 | ? | unknown |  |
| `api-portrait-statistics` | 1 | ? | unknown |  |
| `api-tasks` | 1 | ? | unknown |  |
| `backend-service` | 1 | ? | unknown |  |
| `batch-engine` | 1 | ? | unknown |  |
| `batch-state` | 1 | ? | unknown |  |
| `cache-source` | 1 | ? | unknown |  |
| `conversation-selection` | 1 | ? | unknown |  |
| `data-root-source` | 1 | ? | unknown |  |
| `guidance-contracts` | 1 | ? | unknown |  |
| `history-browser` | 1 | ? | unknown |  |
| `jieba` | 1 | ? | unknown |  |
| `live-source` | 1 | ? | unknown |  |
| `message-contracts` | 1 | ? | unknown |  |
| `message-input` | 1 | ? | unknown |  |
| `message-results` | 1 | ? | unknown |  |
| `node-analysis` | 1 | ? | unknown |  |
| `packaging` | 1 | ? | unknown |  |
| `payload-crypto` | 1 | ? | unknown |  |
| `portrait-contracts` | 1 | ? | unknown |  |
| `process-lock` | 1 | ? | unknown |  |
| `project-python` | 1 | ? | unknown |  |
| `real-http` | 1 | ? | unknown |  |
| `snapshot-cache` | 1 | ? | unknown |  |
| `uiautomation` | 1 | ? | unknown |  |
| `wechatauto` | 1 | ? | unknown |  |
| `win32crypt` | 1 | ? | unknown |  |
| `windows-file-owners` | 1 | ? | unknown |  |
| `zstandard` | 1 | ? | unknown |  |
| `cryptography` | 2 | ring, RustCrypto crates | partial |  |
| `numpy` | 1 | ndarray | partial | Broadcasting and dtype rules differ; check numerics. |
| `yaml` | 1 | serde_yaml_ng, saphyr | partial | Round-tripping comments is not covered. |

## Risk guide

- **String offsets and slicing** (High): JS indexes strings in UTF-16 code units, Rust in UTF-8 bytes. Offsets that cross the boundary must be converted, or non-ASCII text gets wrong ranges silently.
- **Regex features the `regex` crate lacks** (High): Lookaround, backreferences and the `y` flag are not in the `regex` crate. Use `fancy-regex` for those patterns, or rewrite them, and test them on non-ASCII text: `\w`, `\b` and case-insensitive matching differ between engines even where a pattern compiles. JS `/i` without `u` never matches a non-ASCII letter to an ASCII one, Rust `(?i)` does (`ſ` matches `s`, the Kelvin sign `K` matches `k`): write `(?i-u)` or compare with `eq_ignore_ascii_case`.
- **Regexes built at runtime** (High): Patterns come from data or config in JS syntax. Rust regex syntax differs, so user-visible behavior can change. Pin it with tests on real patterns.
- **Dynamic typing** (Medium): Values whose shape is checked at runtime need an explicit Rust enum or `serde_json::Value`.
- **Exceptions** (Low): Thrown errors become `Result`. Errors crossing the bridge must map back to the same JS error shape.
- **Generators** (Medium): Lazy generators become iterators, or return a collected Vec across the bridge.
- **Class inheritance** (Medium): Class hierarchies become traits plus composition; `instanceof` checks become enums.
- **Number semantics** (Low): JS numbers are f64; bitwise ops truncate to i32; parseInt is lenient. Pick Rust integer types deliberately. Printing differs: `${n}` gives `1e+21`, `1e-7` and `0` for -0 where Rust's `{}` does not, so use `js::number_to_string`. `Math.round` rounds halves up (-2.5 gives -2), Rust's `round` away from zero: use `js::math_round`. `toFixed` rounds exact halves up ((2.5).toFixed(0) is "3"), Rust's `{:.0}` to even.
- **Integer width and overflow** (Medium): Python ints never overflow; C, Go and Java ints wrap or are undefined on overflow. Pick i64, i128 or a bignum crate deliberately, and use wrapping_* where the source wraps.
- **Division and modulo** (Medium): Python `//` and `%` floor toward negative infinity; Rust `/` and `%` truncate: use `div_euclid`/`rem_euclid` or explicit floor math. C division by zero is undefined.
- **Hash iteration order** (High): Set and map iteration order comes from the source language's hash function. A port cannot reproduce it: sort before output, or make the order part of the contract.
- **Concurrency** (Medium): Threads, goroutines and locks need a design in Rust (channels, Send/Sync), not a line-by-line translation; keep concurrency in the caller where possible.
- **numpy array parameters** (High): `record` passes JSON values, never numpy arrays, so a function that takes `np.ndarray` gets no valid cases on the unit path. Record the app instead (`app record`, `app replay`), or port the function together with a caller that takes and returns plain lists.

## Whole app

Shape: **server**.

| Entry point | Kind | Found from |
| --- | --- | --- |
| `bridge/chat_server.py` | cli | `if __name__ == "__main__"` at bridge/chat_server.py:85 |
| `bridge/installation_gate.py` | cli | `if __name__ == "__main__"` at bridge/installation_gate.py:220 |
| `bridge/model_install.py` | cli | `if __name__ == "__main__"` at bridge/model_install.py:101 |
| `bridge/payload_recovery.py` | cli | `if __name__ == "__main__"` at bridge/payload_recovery.py:169 |
| `bridge/real_http.py` | server | `HTTPServer(` at bridge/real_http.py:35 |
| `bridge/wechat_bridge.py` | cli | `if __name__ == "__main__"` at bridge/wechat_bridge.py:247 |
| `scripts/build-model-asset.py` | cli | `if __name__ == "__main__"` at scripts/build-model-asset.py:75 |
| `scripts/build-portable-clean.py` | cli | `if __name__ == "__main__"` at scripts/build-portable-clean.py:236 |
| `scripts/build-windows-release.py` | cli | `if __name__ == "__main__"` at scripts/build-windows-release.py:398 |
| `scripts/perf-baseline.py` | cli | `if __name__ == "__main__"` at scripts/perf-baseline.py:166 |
| `scripts/real-client-update-extract.py` | cli | `if __name__ == "__main__"` at scripts/real-client-update-extract.py:179 |
| `scripts/run-project-python.py` | cli | `if __name__ == "__main__"` at scripts/run-project-python.py:19 |
| `scripts/run-python-tests.py` | cli | `if __name__ == "__main__"` at scripts/run-python-tests.py:125 |
| `scripts/setup-advisor-engine.py` | cli | `if __name__ == "__main__"` at scripts/setup-advisor-engine.py:75 |
| `scripts/stage-real-client.py` | cli | `if __name__ == "__main__"` at scripts/stage-real-client.py:248 |
| `scripts/stage-real-runtime.py` | cli | `if __name__ == "__main__"` at scripts/stage-real-runtime.py:390 |
| `scripts/start-real-client.py` | cli | `if __name__ == "__main__"` at scripts/start-real-client.py:947 |
| `scripts/start-release-test-client.py` | cli | `if __name__ == "__main__"` at scripts/start-release-test-client.py:179 |
| `scripts/start-test-client.py` | cli | `if __name__ == "__main__"` at scripts/start-test-client.py:337 |
| `scripts/test-build-portable-clean.py` | cli | `if __name__ == "__main__"` at scripts/test-build-portable-clean.py:201 |
| `scripts/test-build-windows-release.py` | cli | `if __name__ == "__main__"` at scripts/test-build-windows-release.py:288 |
| `scripts/test-launcher-port-selection.py` | cli | `if __name__ == "__main__"` at scripts/test-launcher-port-selection.py:122 |
| `scripts/test-model-preserve.py` | cli | `if __name__ == "__main__"` at scripts/test-model-preserve.py:61 |
| `scripts/test-project-python.py` | cli | `if __name__ == "__main__"` at scripts/test-project-python.py:48 |
| `scripts/test-python-requirements-lock.py` | cli | `if __name__ == "__main__"` at scripts/test-python-requirements-lock.py:57 |
| `scripts/test-real-client-update-extract.py` | cli | `if __name__ == "__main__"` at scripts/test-real-client-update-extract.py:102 |
| `scripts/test-stage-real-runtime.py` | cli | `if __name__ == "__main__"` at scripts/test-stage-real-runtime.py:53 |
| `scripts/test-start-real-client.py` | server | `HTTPServer(` at scripts/test-start-real-client.py:98 |
| `scripts/test-start-test-client.py` | cli | `if __name__ == "__main__"` at scripts/test-start-test-client.py:228 |
| `scripts/train-mbti-linear.py` | cli | `if __name__ == "__main__"` at scripts/train-mbti-linear.py:354 |
| `scripts/train-relationship-linear.py` | cli | `if __name__ == "__main__"` at scripts/train-relationship-linear.py:331 |
| `scripts/train_relationship_classifier.py` | cli | `if __name__ == "__main__"` at scripts/train_relationship_classifier.py:235 |

### Every dependency

| Dependency | Declared | Used by | Rust | Fit | Note |
| --- | --- | --- | --- | --- | --- |
| `psutil` | no | 3 | ? | unknown |  |
| `advisor-contracts` | no | 2 | ? | unknown |  |
| `advisor-imports` | no | 2 | ? | unknown |  |
| `backend-contracts` | no | 2 | ? | unknown |  |
| `installation-gate` | no | 2 | ? | unknown |  |
| `instance-identity` | no | 2 | ? | unknown |  |
| `local-model-source` | no | 2 | ? | unknown |  |
| `model-bundle` | no | 2 | ? | unknown |  |
| `model-source` | no | 2 | ? | unknown |  |
| `profile-signals` | no | 2 | ? | unknown |  |
| `profile-state` | no | 2 | ? | unknown |  |
| `result-store` | no | 2 | ? | unknown |  |
| `wechat-source` | no | 2 | ? | unknown |  |
| `account-api` | no | 1 | ? | unknown |  |
| `account-leases` | no | 1 | ? | unknown |  |
| `account-pin-source` | no | 1 | ? | unknown |  |
| `account-store` | no | 1 | ? | unknown |  |
| `advisor-context` | no | 1 | ? | unknown |  |
| `advisor-http` | no | 1 | ? | unknown |  |
| `advisor-packages` | no | 1 | ? | unknown |  |
| `advisor-runtime` | no | 1 | ? | unknown |  |
| `advisor-service` | no | 1 | ? | unknown |  |
| `advisor-store` | no | 1 | ? | unknown |  |
| `api-pool` | no | 1 | ? | unknown |  |
| `api-portrait-ledger` | no | 1 | ? | unknown |  |
| `api-portrait-statistics` | no | 1 | ? | unknown |  |
| `api-tasks` | no | 1 | ? | unknown |  |
| `backend-service` | no | 1 | ? | unknown |  |
| `batch-engine` | no | 1 | ? | unknown |  |
| `batch-state` | no | 1 | ? | unknown |  |
| `cache-source` | no | 1 | ? | unknown |  |
| `conversation-selection` | no | 1 | ? | unknown |  |
| `data-root-source` | no | 1 | ? | unknown |  |
| `guidance-contracts` | no | 1 | ? | unknown |  |
| `history-browser` | no | 1 | ? | unknown |  |
| `jieba` | no | 1 | ? | unknown |  |
| `live-source` | no | 1 | ? | unknown |  |
| `message-contracts` | no | 1 | ? | unknown |  |
| `message-input` | no | 1 | ? | unknown |  |
| `message-results` | no | 1 | ? | unknown |  |
| `node-analysis` | no | 1 | ? | unknown |  |
| `packaging` | no | 1 | ? | unknown |  |
| `payload-crypto` | no | 1 | ? | unknown |  |
| `portrait-contracts` | no | 1 | ? | unknown |  |
| `process-lock` | no | 1 | ? | unknown |  |
| `project-python` | no | 1 | ? | unknown |  |
| `real-http` | no | 1 | ? | unknown |  |
| `snapshot-cache` | no | 1 | ? | unknown |  |
| `uiautomation` | no | 1 | ? | unknown |  |
| `wechatauto` | no | 1 | ? | unknown |  |
| `win32crypt` | no | 1 | ? | unknown |  |
| `windows-file-owners` | no | 1 | ? | unknown |  |
| `zstandard` | no | 1 | ? | unknown |  |
| `cryptography` | no | 2 | ring, RustCrypto crates | partial |  |
| `numpy` | no | 1 | ndarray | partial | Broadcasting and dtype rules differ; check numerics. |
| `yaml` | no | 1 | serde_yaml_ng, saphyr | partial | Round-tripping comments is not covered. |

### Pieces, in port order

- wave 0: `bridge/` (20999 lines)
- wave 0: `native-reader/wr/` (3001 lines)
- wave 0: `scripts/` (5874 lines)

### Decisions for the user

**D1** (shape): The app is a server, entered through bridge/chat_server.py, bridge/installation_gate.py, bridge/model_install.py, bridge/payload_recovery.py, bridge/real_http.py, bridge/wechat_bridge.py, scripts/build-model-asset.py, scripts/build-portable-clean.py, scripts/build-windows-release.py, scripts/perf-baseline.py, scripts/real-client-update-extract.py, scripts/run-project-python.py, scripts/run-python-tests.py, scripts/setup-advisor-engine.py, scripts/stage-real-client.py, scripts/stage-real-runtime.py, scripts/start-real-client.py, scripts/start-release-test-client.py, scripts/start-test-client.py, scripts/test-build-portable-clean.py, scripts/test-build-windows-release.py, scripts/test-launcher-port-selection.py, scripts/test-model-preserve.py, scripts/test-project-python.py, scripts/test-python-requirements-lock.py, scripts/test-real-client-update-extract.py, scripts/test-stage-real-runtime.py, scripts/test-start-real-client.py, scripts/test-start-test-client.py, scripts/train-mbti-linear.py, scripts/train-relationship-linear.py, scripts/train_relationship_classifier.py. Port every entry point, in that shape?

> Yes: an axum front door (`app front-door`) takes the server over first

**D2** (dependency psutil): Which crate replaces psutil (used by 3 units)?

> Research it against primary sources into rust/research/psutil.md before porting what uses it

**D3** (dependency advisor-contracts): Which crate replaces advisor-contracts (used by 2 units)?

> Research it against primary sources into rust/research/advisor-contracts.md before porting what uses it

**D4** (dependency advisor-imports): Which crate replaces advisor-imports (used by 2 units)?

> Research it against primary sources into rust/research/advisor-imports.md before porting what uses it

**D5** (dependency backend-contracts): Which crate replaces backend-contracts (used by 2 units)?

> Research it against primary sources into rust/research/backend-contracts.md before porting what uses it

**D6** (dependency installation-gate): Which crate replaces installation-gate (used by 2 units)?

> Research it against primary sources into rust/research/installation-gate.md before porting what uses it

**D7** (dependency instance-identity): Which crate replaces instance-identity (used by 2 units)?

> Research it against primary sources into rust/research/instance-identity.md before porting what uses it

**D8** (dependency local-model-source): Which crate replaces local-model-source (used by 2 units)?

> Research it against primary sources into rust/research/local-model-source.md before porting what uses it

**D9** (dependency model-bundle): Which crate replaces model-bundle (used by 2 units)?

> Research it against primary sources into rust/research/model-bundle.md before porting what uses it

**D10** (dependency model-source): Which crate replaces model-source (used by 2 units)?

> Research it against primary sources into rust/research/model-source.md before porting what uses it

**D11** (dependency profile-signals): Which crate replaces profile-signals (used by 2 units)?

> Research it against primary sources into rust/research/profile-signals.md before porting what uses it

**D12** (dependency profile-state): Which crate replaces profile-state (used by 2 units)?

> Research it against primary sources into rust/research/profile-state.md before porting what uses it

**D13** (dependency result-store): Which crate replaces result-store (used by 2 units)?

> Research it against primary sources into rust/research/result-store.md before porting what uses it

**D14** (dependency wechat-source): Which crate replaces wechat-source (used by 2 units)?

> Research it against primary sources into rust/research/wechat-source.md before porting what uses it

**D15** (dependency account-api): Which crate replaces account-api (used by 1 unit)?

> Research it against primary sources into rust/research/account-api.md before porting what uses it

**D16** (dependency account-leases): Which crate replaces account-leases (used by 1 unit)?

> Research it against primary sources into rust/research/account-leases.md before porting what uses it

**D17** (dependency account-pin-source): Which crate replaces account-pin-source (used by 1 unit)?

> Research it against primary sources into rust/research/account-pin-source.md before porting what uses it

**D18** (dependency account-store): Which crate replaces account-store (used by 1 unit)?

> Research it against primary sources into rust/research/account-store.md before porting what uses it

**D19** (dependency advisor-context): Which crate replaces advisor-context (used by 1 unit)?

> Research it against primary sources into rust/research/advisor-context.md before porting what uses it

**D20** (dependency advisor-http): Which crate replaces advisor-http (used by 1 unit)?

> Research it against primary sources into rust/research/advisor-http.md before porting what uses it

**D21** (dependency advisor-packages): Which crate replaces advisor-packages (used by 1 unit)?

> Research it against primary sources into rust/research/advisor-packages.md before porting what uses it

**D22** (dependency advisor-runtime): Which crate replaces advisor-runtime (used by 1 unit)?

> Research it against primary sources into rust/research/advisor-runtime.md before porting what uses it

**D23** (dependency advisor-service): Which crate replaces advisor-service (used by 1 unit)?

> Research it against primary sources into rust/research/advisor-service.md before porting what uses it

**D24** (dependency advisor-store): Which crate replaces advisor-store (used by 1 unit)?

> Research it against primary sources into rust/research/advisor-store.md before porting what uses it

**D25** (dependency api-pool): Which crate replaces api-pool (used by 1 unit)?

> Research it against primary sources into rust/research/api-pool.md before porting what uses it

**D26** (dependency api-portrait-ledger): Which crate replaces api-portrait-ledger (used by 1 unit)?

> Research it against primary sources into rust/research/api-portrait-ledger.md before porting what uses it

**D27** (dependency api-portrait-statistics): Which crate replaces api-portrait-statistics (used by 1 unit)?

> Research it against primary sources into rust/research/api-portrait-statistics.md before porting what uses it

**D28** (dependency api-tasks): Which crate replaces api-tasks (used by 1 unit)?

> Research it against primary sources into rust/research/api-tasks.md before porting what uses it

**D29** (dependency backend-service): Which crate replaces backend-service (used by 1 unit)?

> Research it against primary sources into rust/research/backend-service.md before porting what uses it

**D30** (dependency batch-engine): Which crate replaces batch-engine (used by 1 unit)?

> Research it against primary sources into rust/research/batch-engine.md before porting what uses it

**D31** (dependency batch-state): Which crate replaces batch-state (used by 1 unit)?

> Research it against primary sources into rust/research/batch-state.md before porting what uses it

**D32** (dependency cache-source): Which crate replaces cache-source (used by 1 unit)?

> Research it against primary sources into rust/research/cache-source.md before porting what uses it

**D33** (dependency conversation-selection): Which crate replaces conversation-selection (used by 1 unit)?

> Research it against primary sources into rust/research/conversation-selection.md before porting what uses it

**D34** (dependency data-root-source): Which crate replaces data-root-source (used by 1 unit)?

> Research it against primary sources into rust/research/data-root-source.md before porting what uses it

**D35** (dependency guidance-contracts): Which crate replaces guidance-contracts (used by 1 unit)?

> Research it against primary sources into rust/research/guidance-contracts.md before porting what uses it

**D36** (dependency history-browser): Which crate replaces history-browser (used by 1 unit)?

> Research it against primary sources into rust/research/history-browser.md before porting what uses it

**D37** (dependency jieba): Which crate replaces jieba (used by 1 unit)?

> Research it against primary sources into rust/research/jieba.md before porting what uses it

**D38** (dependency live-source): Which crate replaces live-source (used by 1 unit)?

> Research it against primary sources into rust/research/live-source.md before porting what uses it

**D39** (dependency message-contracts): Which crate replaces message-contracts (used by 1 unit)?

> Research it against primary sources into rust/research/message-contracts.md before porting what uses it

**D40** (dependency message-input): Which crate replaces message-input (used by 1 unit)?

> Research it against primary sources into rust/research/message-input.md before porting what uses it

**D41** (dependency message-results): Which crate replaces message-results (used by 1 unit)?

> Research it against primary sources into rust/research/message-results.md before porting what uses it

**D42** (dependency node-analysis): Which crate replaces node-analysis (used by 1 unit)?

> Research it against primary sources into rust/research/node-analysis.md before porting what uses it

**D43** (dependency packaging): Which crate replaces packaging (used by 1 unit)?

> Research it against primary sources into rust/research/packaging.md before porting what uses it

**D44** (dependency payload-crypto): Which crate replaces payload-crypto (used by 1 unit)?

> Research it against primary sources into rust/research/payload-crypto.md before porting what uses it

**D45** (dependency portrait-contracts): Which crate replaces portrait-contracts (used by 1 unit)?

> Research it against primary sources into rust/research/portrait-contracts.md before porting what uses it

**D46** (dependency process-lock): Which crate replaces process-lock (used by 1 unit)?

> Research it against primary sources into rust/research/process-lock.md before porting what uses it

**D47** (dependency project-python): Which crate replaces project-python (used by 1 unit)?

> Research it against primary sources into rust/research/project-python.md before porting what uses it

**D48** (dependency real-http): Which crate replaces real-http (used by 1 unit)?

> Research it against primary sources into rust/research/real-http.md before porting what uses it

**D49** (dependency snapshot-cache): Which crate replaces snapshot-cache (used by 1 unit)?

> Research it against primary sources into rust/research/snapshot-cache.md before porting what uses it

**D50** (dependency uiautomation): Which crate replaces uiautomation (used by 1 unit)?

> Research it against primary sources into rust/research/uiautomation.md before porting what uses it

**D51** (dependency wechatauto): Which crate replaces wechatauto (used by 1 unit)?

> Research it against primary sources into rust/research/wechatauto.md before porting what uses it

**D52** (dependency win32crypt): Which crate replaces win32crypt (used by 1 unit)?

> Research it against primary sources into rust/research/win32crypt.md before porting what uses it

**D53** (dependency windows-file-owners): Which crate replaces windows-file-owners (used by 1 unit)?

> Research it against primary sources into rust/research/windows-file-owners.md before porting what uses it

**D54** (dependency zstandard): Which crate replaces zstandard (used by 1 unit)?

> Research it against primary sources into rust/research/zstandard.md before porting what uses it

**D55** (dependency cryptography): cryptography maps to ring, RustCrypto crates only in part (used by 2 units). Use it?

> Use ring, RustCrypto crates, and record cases for the behavior it does not cover

**D56** (dependency numpy): numpy maps to ndarray only in part (used by 1 unit; Broadcasting and dtype rules differ; check numerics). Use it?

> Use ndarray, and record cases for the behavior it does not cover

**D57** (dependency yaml): yaml maps to serde_yaml_ng, saphyr only in part (used by 1 unit; Round-tripping comments is not covered). Use it?

> Use serde_yaml_ng, saphyr, and record cases for the behavior it does not cover

