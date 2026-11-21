//! The Rust port of `wr/database.py` — the free functions.
//!
//! The query layer (`SqliteShard`, `ContactStore`) needs a real SQLite driver and stays in Python
//! for now; everything callable on its own is ported here: identities, time normalisation, text
//! extraction (incl. Zstd), cursor encoding and the page-to-image assembly.
//!
//! `ProtocolError` travels as `ProtocolError(<code>): <message>`; `lib.rs` maps it back to
//! `wr.errors.ProtocolError` (see ADR-005).

#![forbid(unsafe_code)]

use md5::Md5;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
const SECONDS_MAX: i64 = 100_000_000_000;
const KIND_TEXT: &str = "text";
const KIND_NON_TEXT: &str = "nontext";
const KIND_SYSTEM: &str = "system";
const SYSTEM_TYPES: [i64; 2] = [10_000, 10_002];

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

fn bytes_of(v: &Value) -> Option<Vec<u8>> {
    let arr = v.get("$bytes")?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for b in arr {
        out.push(u8::try_from(b.as_u64()?).ok()?);
    }
    Some(out)
}

/// Python's `repr()`: containers print their string items quoted.
fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => format!("'{s}'"),
        other => py_str(other),
    }
}

/// Python's `str()` for the values that reach these functions.
fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".to_string(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(py_repr).collect();
            format!("[{}]", parts.join(", "))
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| format!("'{}': {}", k, py_repr(&o[*k])))
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
    }
}

fn protocol_error(code: &str, message: &str) -> String {
    format!("ProtocolError({code}): {message}")
}

/// Port of `md5_username` (`wr/database.py:44`).
pub fn md5_username(username: serde_json::Value) -> Result<String, String> {
    let Value::String(text) = &username else {
        return Err(format!(
            "AttributeError: '{}' object has no attribute 'encode'",
            type_name(&username)
        ));
    };
    Ok(format!("{:x}", Md5::digest(text.as_bytes())))
}

fn sha256_short(basis: &str) -> String {
    let digest = Sha256::digest(basis.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..32].to_string()
}

/// Port of `contact_id_for` (`wr/database.py:48`).
pub fn contact_id_for(
    account_id: serde_json::Value,
    username: serde_json::Value,
) -> Result<String, String> {
    Ok(sha256_short(&format!(
        "{}\u{0}{}",
        py_str(&account_id),
        py_str(&username)
    )))
}

/// Port of `message_id_for` (`wr/database.py:52`).
pub fn message_id_for(
    account_id: serde_json::Value,
    username: serde_json::Value,
    shard_id: serde_json::Value,
    local_id: serde_json::Value,
) -> Result<String, String> {
    Ok(sha256_short(&format!(
        "{}\u{0}{}\u{0}{}\u{0}l{}",
        py_str(&account_id),
        py_str(&username),
        py_str(&shard_id),
        py_str(&local_id)
    )))
}

/// Python integers are arbitrary precision: small values stay `i64`, big ones travel as `$int`.
enum PyNum {
    Small(i64),
    Big(String),
}

fn float_to_num(f: f64) -> Result<PyNum, String> {
    if f.is_infinite() {
        return Err("OverflowError: cannot convert float infinity to integer".to_string());
    }
    let truncated = f.trunc();
    // `{:.0}` prints the exact decimal expansion of the f64, which is what `int(f)` returns.
    if truncated.abs() < 9.2e18 {
        return Ok(PyNum::Small(truncated as i64));
    }
    Ok(PyNum::Big(format!("{truncated:.0}")))
}

/// `int()` on a decimal string that does not fit `i64`: normalise sign, underscores, leading zeros.
fn parse_big(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = digits.chars().filter(|c| *c != '_').collect();
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let trimmed_zeros = digits.trim_start_matches('0');
    if trimmed_zeros.is_empty() {
        return Some("0".to_string());
    }
    Some(format!("{sign}{trimmed_zeros}"))
}

/// `int()` on a string that fits `i64`: surrounding whitespace, sign, digits, `_` separators.
fn parse_py_int(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1i64, rest),
        None => (1i64, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    if digits.is_empty() {
        return None;
    }
    let mut value: i64 = 0;
    let mut last_underscore = true;
    for ch in digits.chars() {
        if ch == '_' {
            if last_underscore {
                return None;
            }
            last_underscore = true;
            continue;
        }
        let digit = ch.to_digit(10)?;
        value = value.checked_mul(10)?.checked_add(i64::from(digit))?;
        last_underscore = false;
    }
    if last_underscore {
        return None;
    }
    Some(sign * value)
}

/// Python `int(value)`; `None` where it would raise `TypeError`/`ValueError`.
fn py_num(v: &Value) -> Result<Option<PyNum>, String> {
    match v {
        Value::Bool(b) => Ok(Some(PyNum::Small(i64::from(*b)))),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return Ok(Some(PyNum::Small(i)));
            }
            let f = n.as_f64().unwrap_or(0.0);
            if f.is_nan() {
                return Ok(None); // int(nan) raises ValueError, which the original swallows to 0
            }
            Ok(Some(float_to_num(f)?))
        }
        Value::String(text) => {
            if let Some(i) = parse_py_int(text) {
                return Ok(Some(PyNum::Small(i)));
            }
            Ok(parse_big(text).map(PyNum::Big))
        }
        // Non-finite floats travel as `{"$num": "Infinity"}`, like the recorder encodes them.
        Value::Object(map) => {
            if let Some(tag) = map.get("$num").and_then(Value::as_str) {
                let f = match tag {
                    "Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    "-0" => -0.0,
                    _ => return Ok(None), // NaN
                };
                return Ok(Some(float_to_num(f)?));
            }
            match map.get("$float").and_then(Value::as_str) {
                Some(text) => Ok(text.parse::<f64>().ok().map(float_to_num).transpose()?),
                None => Ok(None),
            }
        }
        _ => Ok(None),
    }
}

/// Port of `normalize_time` (`wr/database.py:63`).
pub fn normalize_time(value: serde_json::Value) -> Result<serde_json::Value, String> {
    if value.is_null() {
        return Ok(json!(0));
    }
    let Some(number) = py_num(&value)? else {
        return Ok(json!(0));
    };
    Ok(match number {
        PyNum::Small(0) => json!(0),
        PyNum::Small(n) if n < 0 => json!(0),
        // Below the seconds threshold, `* 1000` always stays inside i64.
        PyNum::Small(n) if (n as i128) < SECONDS_MAX as i128 => json!(n * 1000),
        PyNum::Small(n) => json!(n),
        PyNum::Big(text) if text.starts_with('-') => json!(0),
        PyNum::Big(text) => json!({ "$int": text }),
    })
}

/// Port of `extract_text` (`wr/database.py:76`).
pub fn extract_text(
    message_content: serde_json::Value,
    compress_content: serde_json::Value,
) -> Result<Option<String>, String> {
    let mut raw: Option<Vec<u8>> = None;
    match &message_content {
        Value::String(s) if !s.is_empty() => raw = Some(s.as_bytes().to_vec()),
        _ => {
            if let Some(bytes) = bytes_of(&message_content)
                && !bytes.is_empty()
            {
                raw = Some(bytes);
            }
        }
    }
    if raw.is_none()
        && let Some(bytes) = bytes_of(&compress_content)
        && !bytes.is_empty()
    {
        raw = Some(bytes);
    }
    let Some(raw) = raw else {
        return Ok(Some(String::new()));
    };
    let raw = if raw.len() >= 4 && raw[..4] == ZSTD_MAGIC {
        match zstd::decode_all(raw.as_slice()) {
            Ok(decoded) => decoded,
            Err(_) => return Ok(None),
        }
    } else {
        raw
    };
    Ok(String::from_utf8(raw).ok())
}

/// Port of `classify_kind` (`wr/database.py:99`).
pub fn classify_kind(local_type: serde_json::Value) -> Result<String, String> {
    let number = match &local_type {
        Value::Bool(b) => Some(i64::from(*b)),
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        _ => None,
    };
    let Some(number) = number else {
        return Ok(KIND_NON_TEXT.to_string());
    };
    if SYSTEM_TYPES.contains(&number) {
        return Ok(KIND_SYSTEM.to_string());
    }
    if number == 1 {
        return Ok(KIND_TEXT.to_string());
    }
    Ok(KIND_NON_TEXT.to_string())
}

/// Port of `encode_cursor` (`wr/database.py:610`).
pub fn encode_cursor(cursor: serde_json::Value) -> Result<Option<serde_json::Value>, String> {
    if cursor.is_null() {
        return Ok(None);
    }
    // A Python tuple arrives as `{"$tuple": [..]}`; a list arrives as a JSON array.
    let items: &Vec<Value> = if let Some(items) = cursor.get("$tuple").and_then(Value::as_array) {
        items
    } else if let Value::Array(items) = &cursor {
        items
    } else {
        return Err(format!(
            "TypeError: '{}' object is not subscriptable",
            type_name(&cursor)
        ));
    };
    if items.len() < 3 {
        return Err("IndexError: tuple index out of range".to_string());
    }
    let mut out = Map::new();
    out.insert("sortSeq".to_string(), Value::String(py_str(&items[0])));
    out.insert("shardId".to_string(), items[1].clone());
    out.insert("localId".to_string(), Value::String(py_str(&items[2])));
    Ok(Some(Value::Object(out)))
}

/// Port of `decode_cursor` (`wr/database.py:616`).
pub fn decode_cursor(raw: serde_json::Value) -> Result<Option<serde_json::Value>, String> {
    if raw.is_null() {
        return Ok(None);
    }
    let Value::Object(map) = &raw else {
        return Err(protocol_error("bad_request", "cursor must be an object"));
    };
    let sort_seq = map
        .get("sortSeq")
        .ok_or_else(|| protocol_error("bad_request", "invalid cursor"))?;
    let shard_id = map
        .get("shardId")
        .ok_or_else(|| protocol_error("bad_request", "invalid cursor"))?;
    let local_id = map
        .get("localId")
        .ok_or_else(|| protocol_error("bad_request", "invalid cursor"))?;
    let sort_seq = parse_py_int(&py_str(sort_seq))
        .ok_or_else(|| protocol_error("bad_request", "invalid cursor"))?;
    let local_id = parse_py_int(&py_str(local_id))
        .ok_or_else(|| protocol_error("bad_request", "invalid cursor"))?;
    Ok(Some(json!({
        "$tuple": [sort_seq, py_str(shard_id), local_id]
    })))
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `pages` as (key, usable bytes) pairs when it is mapping-shaped.
fn page_entries(pages: &Value) -> Option<Vec<(Value, Value)>> {
    if let Some(pairs) = pages.get("$dict").and_then(Value::as_array) {
        let mut out = Vec::with_capacity(pairs.len());
        for pair in pairs {
            let parts = pair.as_array()?;
            if parts.len() != 2 {
                return None;
            }
            out.push((parts[0].clone(), parts[1].clone()));
        }
        return Some(out);
    }
    let map = pages.as_object()?;
    Some(
        map.iter()
            .map(|(k, v)| (Value::String(k.clone()), v.clone()))
            .collect(),
    )
}

fn read_error(message: &str) -> String {
    protocol_error("read_error", message)
}

fn is_mapping(pages: &Value) -> bool {
    pages.is_object()
}

/// Port of `sqlite_image_from_pages` (`wr/database.py:627`).
pub fn sqlite_image_from_pages(
    pages: serde_json::Value,
    page_size: i64,
    reserved: i64,
    commit_pages: Option<i64>,
) -> Result<serde_json::Value, String> {
    if !truthy(&pages) {
        return Err(read_error("no pages"));
    }

    let mut ordered: Vec<Vec<u8>> = Vec::new();

    if let Some(commit) = commit_pages {
        if commit < 1 {
            return Err(read_error("invalid committed page count"));
        }
        if !is_mapping(&pages) {
            // `page_number not in pages` on a non-mapping raises before anything is read.
            return Err(match &pages {
                Value::String(_) => {
                    "TypeError: 'in <string>' requires string as left operand, not int".to_string()
                }
                other => format!(
                    "TypeError: argument of type '{}' is not iterable",
                    type_name(other)
                ),
            });
        }
        let entries = page_entries(&pages).unwrap_or_default();
        for page_number in 1..=commit {
            match entries.iter().find(|(k, _)| {
                py_num(k).ok().flatten().map(|n| match n {
                    PyNum::Small(i) => i == page_number,
                    PyNum::Big(_) => false,
                }) == Some(true)
            }) {
                Some((_, value)) => ordered.push(usable_bytes(value)?),
                None => return Err(read_error("committed page missing")),
            }
        }
    } else if is_mapping(&pages) {
        let mut entries = page_entries(&pages).unwrap_or_default();
        entries.sort_by_key(|(k, _)| match py_num(k) {
            Ok(Some(PyNum::Small(i))) => i,
            _ => 0,
        });
        for (_, value) in entries {
            ordered.push(usable_bytes(&value)?);
        }
    } else {
        return Err(match &pages {
            Value::String(_) => "TypeError: string indices must be integers, not 'str'".to_string(),
            other => format!(
                "TypeError: '<' not supported between instances of 'int' and '{}'",
                type_name(other)
            ),
        });
    }

    let usable_size = page_size - reserved;
    let mut out = Vec::new();
    for usable in ordered {
        if usable.len() as i64 != usable_size {
            return Err(read_error("unexpected usable page size"));
        }
        out.extend_from_slice(&usable);
        out.extend(std::iter::repeat_n(0u8, reserved.max(0) as usize));
    }
    Ok(json!({ "$bytes": out }))
}

/// One page value as bytes; a `str` of the right length fails at `str + bytes` in the original.
fn usable_bytes(value: &Value) -> Result<Vec<u8>, String> {
    match value {
        Value::String(_) => {
            Err("TypeError: can only concatenate str (not \"bytes\") to str".to_string())
        }
        other => bytes_of(other).ok_or_else(|| read_error("unexpected usable page size")),
    }
}
