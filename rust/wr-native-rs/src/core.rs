//! Rust port of the deterministic helpers in `wr/service.py`.
//!
//! The centrepiece is `_decrypt_shard_pages` / `_decrypt_shard_image`: one call decrypts a whole
//! SQLCipher shard (main DB pages + committed WAL frames) into a SQLite image, so the cost of
//! crossing a boundary is paid once per shard instead of once per page (ADR-006).
//!
//! `crypto.rs` and `wal.rs` are the already-proved ports from `wr-crypto-rs` / `wr-wal-rs`, copied
//! here so this crate can be built as a standalone binary without pyo3's extension-module linkage.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

pub type PortError = (String, String);

fn protocol_error(code: &str, message: &str) -> PortError {
    (code.to_string(), message.to_string())
}

const PAGE_SIZE: usize = 4096;

fn bytes_of(v: &Value) -> Option<Vec<u8>> {
    let arr = v.get("$bytes")?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for b in arr {
        out.push(u8::try_from(b.as_u64()?).ok()?);
    }
    Some(out)
}

/// Python `int(value)`, with the original's TypeError shape.
fn py_int(v: &Value, name: &str) -> Result<i64, PortError> {
    match v {
        Value::Null => Err(protocol_error(
            "bad_request",
            &format!("{name} must be an integer"),
        )),
        Value::Bool(b) => Ok(i64::from(*b)),
        Value::Number(n) => n
            .as_i64()
            .ok_or_else(|| protocol_error("bad_request", &format!("{name} must be an integer"))),
        Value::String(s) => s
            .trim()
            .parse::<i64>()
            .map_err(|_| protocol_error("bad_request", &format!("{name} must be an integer"))),
        _ => Err(protocol_error(
            "bad_request",
            &format!("{name} must be an integer"),
        )),
    }
}

/// Port of `_map_kind`.
pub fn map_kind(kind: &str) -> &str {
    match kind {
        "friend" | "private" => "friend",
        "chatroom" => "group",
        "group" | "service" | "unknown" => kind,
        _ => "unknown",
    }
}

/// Port of `_int_param`.
pub fn int_param(
    value: &Value,
    default: i64,
    low: i64,
    high: i64,
    name: &str,
) -> Result<i64, PortError> {
    if value.is_null() {
        return Ok(default);
    }
    let number = py_int(value, name)?;
    if number < low || number > high {
        return Err(protocol_error(
            "bad_request",
            &format!("{name} must be {low}..{high}"),
        ));
    }
    Ok(number)
}

/// Port of `_classify_shard`.
pub fn classify_shard(path: &str) -> &'static str {
    let lowered = path.replace('\\', "/").to_lowercase();
    let name = lowered.rsplit('/').next().unwrap_or("");
    if lowered.contains("/message/") || name.starts_with("message") {
        return "message";
    }
    if lowered.contains("/contact/") || name.contains("contact") {
        return "contact";
    }
    if lowered.contains("/session/") || name.contains("session") {
        return "session";
    }
    "other"
}

/// Port of `_account_username_candidates`.
pub fn account_username_candidates(dir_path: &str) -> Vec<String> {
    let path = Path::new(dir_path);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let parent = Path::new(&absolute)
        .parent()
        .and_then(Path::file_name)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut candidates = Vec::new();
    if !parent.is_empty() {
        candidates.push(parent.clone());
        // INSTANCE_SUFFIX = ^(.+)_([0-9a-fA-F]{2,16})$
        let stripped = parent
            .rsplit_once('_')
            .filter(|(head, tail)| {
                !head.is_empty()
                    && (2..=16).contains(&tail.len())
                    && tail.chars().all(|c| c.is_ascii_hexdigit())
            })
            .map(|(head, _)| head.to_string());
        if let Some(stripped) = stripped
            && !stripped.is_empty()
        {
            candidates.push(stripped);
        }
    }
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|candidate| !candidate.is_empty() && seen.insert(candidate.clone()));
    candidates
}

use std::path::Path;

/// Build the `PageKey` JSON the crypto port expects, from raw key + salt.
fn page_key(raw_key: &Value, salt: &Value) -> Result<Value, PortError> {
    crate::crypto::make_page_key(raw_key.clone(), salt.clone()).map_err(|message| {
        // The crypto port already encodes `ProtocolError(code): message`; unwrap it instead of
        // nesting a second prefix.
        if let Some(rest) = message.strip_prefix("ProtocolError(")
            && let Some((code, text)) = rest.split_once("): ")
        {
            return (code.to_string(), text.to_string());
        }
        protocol_error("key_unavailable", &message)
    })
}

/// Port of `_decrypt_shard_pages`: returns (pages, commit_pages, wal_salt, frame_count).
pub fn decrypt_shard_pages(
    db: &Value,
    wal_data: Option<&Value>,
    raw_key: &Value,
    salt: &Value,
) -> Result<Value, PortError> {
    let db = bytes_of(db).unwrap_or_default();
    if db.is_empty() || !db.len().is_multiple_of(PAGE_SIZE) {
        return Err(protocol_error(
            "read_error",
            "shard size is not page aligned",
        ));
    }
    let key = page_key(raw_key, salt)?;
    let mut pages = serde_json::Map::new();
    for (offset, chunk) in db.chunks(PAGE_SIZE).enumerate() {
        let page_number = (offset + 1) as i64;
        let plain = crate::crypto::decrypt_page(
            json!({ "$bytes": chunk }),
            key.clone(),
            page_number,
            page_number == 1,
        )
        .map_err(|message| protocol_error("read_error", &message))?;
        pages.insert(page_number.to_string(), plain);
    }

    let mut commit_pages = Value::Null;
    let mut wal_salt = Value::Null;
    let mut frame_count = 0i64;
    if let Some(wal_value) = wal_data {
        let wal = bytes_of(wal_value).unwrap_or_default();
        let parsed = crate::wal::parse_wal(wal_value.clone())
            .map_err(|message| protocol_error("read_error", &message))?;
        let attrs = parsed
            .get("attrs")
            .and_then(Value::as_object)
            .ok_or_else(|| protocol_error("read_error", "bad wal parse result"))?;
        if attrs
            .get("corrupt_before_commit")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(protocol_error("read_error", "wal corrupt before commit"));
        }
        if let Some(frames) = attrs.get("frames").and_then(Value::as_array) {
            frame_count = frames.len() as i64;
            for frame in frames {
                let frame_attrs = frame
                    .get("attrs")
                    .and_then(Value::as_object)
                    .ok_or_else(|| protocol_error("read_error", "bad wal frame"))?;
                let page_number = frame_attrs
                    .get("page_number")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let page = frame_attrs.get("page").cloned().unwrap_or(Value::Null);
                let plain =
                    crate::crypto::decrypt_page(page, key.clone(), page_number, page_number == 1)
                        .map_err(|message| protocol_error("read_error", &message))?;
                pages.insert(page_number.to_string(), plain);
            }
        }
        commit_pages = attrs.get("commit_db_size").cloned().unwrap_or(Value::Null);
        if wal.len() >= 24 {
            wal_salt = json!({ "$bytes": wal[16..24].to_vec() });
        }
    }

    Ok(json!({
        "$tuple": [
            { "$dict": pages.into_iter().map(|(k, v)| (json!(k.parse::<i64>().unwrap_or(0)), v)).collect::<Vec<_>>() },
            commit_pages,
            wal_salt,
            frame_count,
        ]
    }))
}

/// Port of `_decrypt_shard_image`.
pub fn decrypt_shard_image(
    db: &Value,
    wal_data: Option<&Value>,
    raw_key: &Value,
    salt: &Value,
) -> Result<Value, PortError> {
    let result = decrypt_shard_pages(db, wal_data, raw_key, salt)?;
    let tuple = result
        .get("$tuple")
        .and_then(Value::as_array)
        .ok_or_else(|| protocol_error("read_error", "bad decrypt result"))?;
    let pages = tuple.first().cloned().unwrap_or(Value::Null);
    let commit_pages = tuple.get(1).cloned().unwrap_or(Value::Null);
    let page_size = json!(PAGE_SIZE as i64);
    let reserved = json!(80i64);
    // `sqlite_image_from_pages` lives in wr-database-rs; call the equivalent assembly here.
    assemble_image(&pages, &page_size, &reserved, &commit_pages)
}

fn assemble_image(
    pages: &Value,
    page_size: &Value,
    reserved: &Value,
    commit_pages: &Value,
) -> Result<Value, PortError> {
    let pairs = pages
        .get("$dict")
        .and_then(Value::as_array)
        .ok_or_else(|| protocol_error("read_error", "no pages"))?;
    let mut entries: Vec<(i64, Vec<u8>)> = Vec::new();
    for pair in pairs {
        let parts = pair
            .as_array()
            .ok_or_else(|| protocol_error("read_error", "bad page entry"))?;
        let key = parts
            .first()
            .and_then(Value::as_i64)
            .ok_or_else(|| protocol_error("read_error", "bad page number"))?;
        let bytes = bytes_of(parts.get(1).unwrap_or(&Value::Null))
            .ok_or_else(|| protocol_error("read_error", "bad page bytes"))?;
        entries.push((key, bytes));
    }
    let page_size = page_size.as_i64().unwrap_or(4096);
    let reserved = reserved.as_i64().unwrap_or(80);
    let usable_size = page_size - reserved;
    let ordered: Vec<Vec<u8>> = if commit_pages.is_null() {
        entries.sort_by_key(|(key, _)| *key);
        entries.into_iter().map(|(_, bytes)| bytes).collect()
    } else {
        let commit = commit_pages.as_i64().unwrap_or(0);
        if commit < 1 {
            return Err(protocol_error("read_error", "invalid committed page count"));
        }
        let mut out = Vec::new();
        for number in 1..=commit {
            match entries.iter().find(|(key, _)| *key == number) {
                Some((_, bytes)) => out.push(bytes.clone()),
                None => return Err(protocol_error("read_error", "committed page missing")),
            }
        }
        out
    };
    let mut result = Vec::new();
    for usable in ordered {
        if usable.len() as i64 != usable_size {
            return Err(protocol_error("read_error", "unexpected usable page size"));
        }
        result.extend_from_slice(&usable);
        result.extend(std::iter::repeat_n(0u8, reserved.max(0) as usize));
    }
    Ok(json!({ "$bytes": result }))
}
