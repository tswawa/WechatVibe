# Rust migration plan: weixinAnalyzer (TypeScript/JavaScript)

1 packages, 95 source files (27274 lines), 82 test files, 3 UI files, grouped into 9 units.

| Ready | Caution | Blocked | Keep in source language |
| ---: | ---: | ---: | ---: |
| 3 | 3 | 1 | 2 |

## Start here

Best first ports: safe to port (readiness) and worth porting (loops and string work, tests, size).

| # | Unit | Lines | Priority | Readiness | Tests | Bridge | Main risks |
| ---: | --- | ---: | ---: | ---: | ---: | --- | --- |
| 1 | `src/lib/` | 84 | 72 | 95 | 1 | wasm-bindgen | Insertion-ordered maps and object keys (5); Reflection and prototypes (1); Number semantics (2) |
| 2 | `shared/` | 614 | 53 | 66 | 1 | wasm-bindgen | Regex features the `regex` crate lacks (1); Callback-shaped APIs (24); Insertion-ordered maps and object keys (3) |
| 3 | `electron/laya/` | 3462 | 28 | 0 | 15 | napi-rs | String offsets and slicing (60); Regex features the `regex` crate lacks (9); Regexes built at runtime (2) |
| 4 | `electron/` | 4527 | 26 | 0 | 16 | napi-rs | String offsets and slicing (40); Regexes built at runtime (1); Async and promises (196) |

### `src/lib/`

84 lines in 1 files, wave 0, priority 72, readiness 95, bridge **wasm-bindgen**.

- 1 imports use aliases or virtual modules and were not followed.
- Leaf: imports no other unit.
- 1 test files import it directly.
- Portable code: wasm-bindgen keeps it running in browsers and Node. It needs the wasm32-unknown-unknown target and wasm-bindgen; `bridge --kind napi` runs with what Node already has.
- Insertion-ordered maps and object keys x5: `src/lib/labels.ts:9`, `src/lib/labels.ts:11`, `src/lib/labels.ts:25`
- Reflection and prototypes x1: `src/lib/labels.ts:16`
- Number semantics x2: `src/lib/labels.ts:80`, `src/lib/labels.ts:85`

### `shared/`

614 lines in 2 files, wave 0, priority 53, readiness 66, bridge **wasm-bindgen**.

- Leaf: imports no other unit.
- 1 test files import it directly.
- Portable code: wasm-bindgen keeps it running in browsers and Node. It needs the wasm32-unknown-unknown target and wasm-bindgen; `bridge --kind napi` runs with what Node already has.
- Regex features the `regex` crate lacks x1: `shared/contracts.ts:220`
- Callback-shaped APIs x24: `shared/contracts.ts:125`, `shared/contracts.ts:126`, `shared/contracts.ts:127`
- Insertion-ordered maps and object keys x3: `shared/contracts.ts:398`, `shared/message-input.ts:64`, `shared/message-input.ts:132`
- Class inheritance x1: `shared/contracts.ts:248`
- Exceptions x39: `shared/contracts.ts:258`, `shared/contracts.ts:264`, `shared/contracts.ts:270`

### `electron/laya/`

3462 lines in 26 files, wave 1, priority 28, readiness 0, bridge **napi-rs**.

- 2 npm dependencies not in the crate table: check them by hand.
- 5 imports use aliases or virtual modules and were not followed.
- 15 test files import it directly.
- String offsets and slicing x60: `electron/laya/agent.ts:104`, `electron/laya/agent.ts:105`, `electron/laya/agent.ts:117`
- Regex features the `regex` crate lacks x9: `electron/laya/context.ts:64`, `electron/laya/general-intent.ts:76`, `electron/laya/general-intent.ts:83`
- Regexes built at runtime x2: `electron/laya/tokenizer.ts:156`, `electron/laya/tokenizer.ts:157`
- Insertion-ordered maps and object keys x56: `electron/laya/agent.ts:72`, `electron/laya/agent.ts:100`, `electron/laya/agent.ts:146`
- Async and promises x46: `electron/laya/agent.ts:98`, `electron/laya/agent.ts:108`, `electron/laya/agent.ts:142`
- Callback-shaped APIs x11: `electron/laya/agent.ts:25`, `electron/laya/catalog.ts:65`, `electron/laya/catalog.ts:129`
- Dynamic typing x3: `electron/laya/agent.ts:192`, `electron/laya/agent.ts:192`, `electron/laya/catalog.ts:69`
- Class inheritance x2: `electron/laya/forecast.ts:52`, `electron/laya/message-batch.ts:50`
- Reflection and prototypes x1: `electron/laya/tokenizer.ts:185`
- Exceptions x68: `electron/laya/agent.ts:46`, `electron/laya/agent.ts:67`, `electron/laya/agent.ts:87`
- JSON round-trips x9: `electron/laya/agent.ts:88`, `electron/laya/context.ts:92`, `electron/laya/context.ts:105`
- Number semantics x3: `electron/laya/calibration.ts:61`, `electron/laya/scoring.ts:211`, `electron/laya/scoring.ts:231`

### `electron/`

4527 lines in 13 files, wave 2, priority 26, readiness 0, bridge **napi-rs**.

- 5 npm dependencies not in the crate table: check them by hand.
- 16 test files import it directly.
- String offsets and slicing x40: `electron/advisor-runtime.ts:292`, `electron/advisor-runtime.ts:293`, `electron/advisor-runtime.ts:534`
- Regexes built at runtime x1: `electron/api-message-insights.ts:149`
- Async and promises x196: `electron/advisor-runtime.ts:120`, `electron/advisor-runtime.ts:124`, `electron/advisor-runtime.ts:130`
- Insertion-ordered maps and object keys x96: `electron/advisor-runtime.ts:13`, `electron/advisor-runtime.ts:356`, `electron/advisor-runtime.ts:357`
- Callback-shaped APIs x21: `electron/advisor-runtime.ts:90`, `electron/advisor-runtime.ts:91`, `electron/advisor-runtime.ts:91`
- Dynamic typing x11: `electron/api-reply-options.ts:139`, `electron/api-reply-options.ts:145`, `electron/model-connectors.ts:160`
- Class inheritance x5: `electron/advisor-runtime.ts:41`, `electron/analysis.ts:106`, `electron/analysis.ts:121`
- Reflection and prototypes x2: `electron/advisor-runtime.ts:13`, `electron/api-portrait-classifier.ts:47`
- Exceptions x159: `electron/advisor-runtime.ts:105`, `electron/advisor-runtime.ts:123`, `electron/advisor-runtime.ts:129`
- JSON round-trips x53: `electron/advisor-runtime.ts:113`, `electron/advisor-runtime.ts:153`, `electron/advisor-runtime.ts:241`
- Number semantics x3: `electron/analysis.ts:862`, `electron/analysis.ts:866`, `electron/model-connectors.ts:707`

## Order by package

Packages come after the workspace packages they use. Inside a package, port by wave: a unit's imports are in earlier waves.

### 1. wechatvibe (`.`, portable, 82 test files)

| Wave | Unit | Status | Lines | Readiness | Bridge | Main risks |
| ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | `src/lib/` | ready | 84 | 95 | wasm-bindgen | Insertion-ordered maps and object keys (5); Reflection and prototypes (1) |
| 0 | `ui/advisor/vendor/opencode/` | keep | 246 | 67 | keep | String offsets and slicing (7); Regexes built at runtime (1) |
| 0 | `shared/` | ready | 614 | 66 | wasm-bindgen | Regex features the `regex` crate lacks (1); Callback-shaped APIs (24) |
| 0 | `chatui/` | caution | 10127 | 0 | wasm-bindgen | String offsets and slicing (308); Regex features the `regex` crate lacks (41) |
| 1 | `ui/advisor/` | keep | 87 | 82 | keep | Callback-shaped APIs (4); Reflection and prototypes (2) |
| 1 | `electron/laya/` | caution | 3462 | 0 | napi-rs | String offsets and slicing (60); Regex features the `regex` crate lacks (9) |
| 2 | `electron/` | caution | 4527 | 0 | napi-rs | String offsets and slicing (40); Regexes built at runtime (1) |
| 3 | `bridge/` | ready | 764 | 50 | napi-rs | String offsets and slicing (3); Async and promises (42) |
| 3 | `scripts/` | blocked | 7363 | 0 | napi-rs | String offsets and slicing (109); Regex features the `regex` crate lacks (5) |

## npm dependencies

| Package | Units | Rust | Fit | Note |
| --- | ---: | --- | --- | --- |
| `@anthropic-ai/sdk` | 1 | ? | unknown |  |
| `@google/genai` | 1 | ? | unknown |  |
| `@huggingface/tokenizers` | 1 | ? | unknown |  |
| `@opencode-ai/sdk` | 1 | ? | unknown |  |
| `electron` | 1 | ? | unknown |  |
| `esbuild` | 1 | ? | unknown |  |
| `esbuild-plugin-solid` | 1 | ? | unknown |  |
| `ollama` | 1 | ? | unknown |  |
| `onnxruntime-node` | 1 | ? | unknown |  |
| `openai` | 1 | ? | unknown |  |
| `undici` | 1 | reqwest | good |  |

## Blocked

- `scripts/`: Uses dynamic code (eval, new Function or computed imports).

## Risk guide

- **String offsets and slicing** (High): JS indexes strings in UTF-16 code units, Rust in UTF-8 bytes. Offsets that cross the boundary must be converted, or non-ASCII text gets wrong ranges silently.
- **Regex features the `regex` crate lacks** (High): Lookaround, backreferences and the `y` flag are not in the `regex` crate. Use `fancy-regex` for those patterns, or rewrite them, and test them on non-ASCII text: `\w`, `\b` and case-insensitive matching differ between engines even where a pattern compiles. JS `/i` without `u` never matches a non-ASCII letter to an ASCII one, Rust `(?i)` does (`ſ` matches `s`, the Kelvin sign `K` matches `k`): write `(?i-u)` or compare with `eq_ignore_ascii_case`.
- **Regexes built at runtime** (High): Patterns come from data or config in JS syntax. Rust regex syntax differs, so user-visible behavior can change. Pin it with tests on real patterns.
- **Dynamic code (eval, new Function, computed import)** (High): eval, new Function and computed imports have no Rust equivalent. Keep this part in JS or replace it with an explicit registry.
- **Dynamic typing** (Medium): Values whose shape is checked at runtime need an explicit Rust enum or `serde_json::Value`.
- **Insertion-ordered maps and object keys** (Medium): JS Map, Set and object keys keep insertion order. `HashMap` does not: use `indexmap` wherever order reaches output. With serde_json's `preserve_order`, `Map::remove` swaps the last key into the hole: use `shift_remove` for JS `delete`. Sort with `js::sort` when a comparator can return NaN: the order then depends on V8's algorithm.
- **Exceptions** (Low): Thrown errors become `Result`. Errors crossing the bridge must map back to the same JS error shape.
- **Async and promises** (Medium): Promises become futures. Bridge with napi-rs `async fn` or `wasm-bindgen-futures`, or keep the async shell in JS and port the sync core.
- **Class inheritance** (Medium): Class hierarchies become traits plus composition; `instanceof` checks become enums.
- **Reflection and prototypes** (Medium): Proxy, Reflect, Symbol and prototype tricks need a redesign, not a translation.
- **Callback-shaped APIs** (Medium): Function-typed parameters and methods cross the bridge on every call. Keep boundaries coarse: pass data in, get data out.
- **Number semantics** (Low): JS numbers are f64; bitwise ops truncate to i32; parseInt is lenient. Pick Rust integer types deliberately. Printing differs: `${n}` gives `1e+21`, `1e-7` and `0` for -0 where Rust's `{}` does not, so use `js::number_to_string`. `Math.round` rounds halves up (-2.5 gives -2), Rust's `round` away from zero: use `js::math_round`. `toFixed` rounds exact halves up ((2.5).toFixed(0) is "3"), Rust's `{:.0}` to even.
- **JSON round-trips** (Low): JSON.stringify key order and number formatting must match `serde_json` output if the result is user-visible.

## Whole app

Shape: **server**.

| Entry point | Kind | Found from |
| --- | --- | --- |
| `scripts/advisor-native-smoke.ts` | server | `createServer(` at scripts/advisor-native-smoke.ts:27 |

### Every dependency

| Dependency | Declared | Used by | Rust | Fit | Note |
| --- | --- | --- | --- | --- | --- |
| `tsx` | yes | 0 | - | none | Loads TS/JS config or plugins at runtime. Keep loading in JS and pass data to Rust. |
| `marked` | no | 2 | ? | unknown |  |
| `solid-js` | no | 2 | ? | unknown |  |
| `@anthropic-ai/sdk` | yes | 1 | ? | unknown |  |
| `@google/genai` | yes | 1 | ? | unknown |  |
| `@huggingface/tokenizers` | yes | 1 | ? | unknown |  |
| `@opencode-ai/sdk` | yes | 1 | ? | unknown |  |
| `dompurify` | no | 1 | ? | unknown |  |
| `electron` | no | 1 | ? | unknown |  |
| `esbuild` | no | 1 | ? | unknown |  |
| `esbuild-plugin-solid` | no | 1 | ? | unknown |  |
| `ollama` | yes | 1 | ? | unknown |  |
| `onnxruntime-node` | yes | 1 | ? | unknown |  |
| `openai` | yes | 1 | ? | unknown |  |
| `remend` | no | 1 | ? | unknown |  |
| `undici` | yes | 1 | reqwest | good |  |

### Pieces, in port order

- wave 0: `chatui/` (10127 lines)
- wave 0: `shared/` (614 lines)
- wave 0: `src/lib/` (84 lines)
- wave 1: `electron/laya/` (3462 lines)
- wave 2: `electron/` (4527 lines)
- wave 3: `bridge/` (764 lines)
- wave 3: `scripts/` (7363 lines)

### Decisions for the user

**D1** (shape): The app is a server, entered through scripts/advisor-native-smoke.ts. Port every entry point, in that shape?

> Yes: an axum front door (`app front-door`) takes the server over first

**D2** (desktop shell): This is an Electron app. Its main process is Node code that can move to Rust; its windows are web pages. Port the main-process logic and keep the web UI?

> Yes: port the main process piece by piece and keep the renderer as it is. Whether the UI later moves to Tauri (the same web UI on a Rust backend) is a separate choice, made once the logic is Rust

**D3** (keep ui/advisor/): ui/advisor/ stays in the source language (UI code: keep in the original language). What replaces it in the Rust app, or does it stay outside?

> Keep it outside the Rust app, behind the front door, and decide its replacement once the rest is Rust

**D4** (keep ui/advisor/vendor/opencode/): ui/advisor/vendor/opencode/ stays in the source language (UI code: keep in the original language). What replaces it in the Rust app, or does it stay outside?

> Keep it outside the Rust app, behind the front door, and decide its replacement once the rest is Rust

**D5** (blocked scripts/): scripts/ is blocked: Uses dynamic code (eval, new Function or computed imports). Rework that part in Rust, or keep the unit outside?

> Research the blocker first; then port it with the piece that uses it

**D6** (dependency tsx): No crate does what tsx does (declared, no unit imports it; Loads TS/JS config or plugins at runtime. Keep loading in JS and pass data to Rust). Reimplement what the app uses, or drop the feature?

> Reimplement only the part the app uses, proved by its recorded cases

**D7** (dependency marked): Which crate replaces marked (used by 2 units)?

> Research it against primary sources into rust/research/marked.md before porting what uses it

**D8** (dependency solid-js): Which crate replaces solid-js (used by 2 units)?

> Research it against primary sources into rust/research/solid-js.md before porting what uses it

**D9** (dependency @anthropic-ai/sdk): Which crate replaces @anthropic-ai/sdk (used by 1 unit)?

> Research it against primary sources into rust/research/@anthropic-ai-sdk.md before porting what uses it

**D10** (dependency @google/genai): Which crate replaces @google/genai (used by 1 unit)?

> Research it against primary sources into rust/research/@google-genai.md before porting what uses it

**D11** (dependency @huggingface/tokenizers): Which crate replaces @huggingface/tokenizers (used by 1 unit)?

> Research it against primary sources into rust/research/@huggingface-tokenizers.md before porting what uses it

**D12** (dependency @opencode-ai/sdk): Which crate replaces @opencode-ai/sdk (used by 1 unit)?

> Research it against primary sources into rust/research/@opencode-ai-sdk.md before porting what uses it

**D13** (dependency dompurify): Which crate replaces dompurify (used by 1 unit)?

> Research it against primary sources into rust/research/dompurify.md before porting what uses it

**D14** (dependency electron): Which crate replaces electron (used by 1 unit)?

> Research it against primary sources into rust/research/electron.md before porting what uses it

**D15** (dependency esbuild): Which crate replaces esbuild (used by 1 unit)?

> Research it against primary sources into rust/research/esbuild.md before porting what uses it

**D16** (dependency esbuild-plugin-solid): Which crate replaces esbuild-plugin-solid (used by 1 unit)?

> Research it against primary sources into rust/research/esbuild-plugin-solid.md before porting what uses it

**D17** (dependency ollama): Which crate replaces ollama (used by 1 unit)?

> Research it against primary sources into rust/research/ollama.md before porting what uses it

**D18** (dependency onnxruntime-node): Which crate replaces onnxruntime-node (used by 1 unit)?

> Research it against primary sources into rust/research/onnxruntime-node.md before porting what uses it

**D19** (dependency openai): Which crate replaces openai (used by 1 unit)?

> Research it against primary sources into rust/research/openai.md before porting what uses it

**D20** (dependency remend): Which crate replaces remend (used by 1 unit)?

> Research it against primary sources into rust/research/remend.md before porting what uses it

