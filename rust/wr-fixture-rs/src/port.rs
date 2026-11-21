//! The Rust port of `wr/fixture.py`.
//!
//! Loads a synthetic fixture manifest: plaintext SQLite shards listed in JSON. Read-only — it never
//! writes, so the recorded cases replay deterministically.
//!
//! `$object` JSON carries the `FixtureAccount` / `FixtureContact` / `FixtureShard` dataclasses
//! (ADR-007); `ProtocolError` travels as `ProtocolError(<code>): <message>` (ADR-005).

#![forbid(unsafe_code)]

use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};

static EMPTY: Vec<Value> = Vec::new();

fn protocol_error(code: &str, message: &str) -> String {
    format!("ProtocolError({code}): {message}")
}

/// Python's `str()` for the values a manifest can hold.
fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".to_string(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Python's truthiness, for `a or b` fallbacks.
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

/// `os.path.abspath`: join with the working directory when relative, then collapse `.` / `..`.
fn abspath(raw: &str) -> PathBuf {
    let path = Path::new(raw);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `os.path.isabs` on Windows: drive-letter absolute, or rooted at a separator.
fn is_abs(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.first().is_some_and(|b| *b == b'/' || *b == b'\\') {
        return true;
    }
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// `manifest.get("version") != 1`, where Python's `True == 1` and `1.0 == 1`.
fn version_is_one(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(true)) => true,
        Some(Value::Number(n)) => n.as_f64() == Some(1.0),
        _ => false,
    }
}

fn key_error(key: &str) -> String {
    format!("KeyError: '{key}'")
}

fn get_array<'a>(map: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    match map.get(key) {
        None => Ok(&EMPTY),
        Some(Value::Array(items)) => Ok(items),
        Some(other) => Err(format!(
            "AttributeError: '{}' object has no attribute 'get'",
            if other.is_string() { "str" } else { "int" }
        )),
    }
}

fn shard_json(id: &Value, image: &[u8]) -> Value {
    json!({
        "$object": "FixtureShard",
        "attrs": {
            "id": py_str(id),
            "image": { "$bytes": image },
        }
    })
}

fn contact_json(id: &Value, username: &Value, name: &Value, kind: &Value) -> Value {
    json!({
        "$object": "FixtureContact",
        "attrs": {
            "id": py_str(id),
            "username": py_str(username),
            "name": py_str(name),
            "kind": py_str(kind),
        }
    })
}

/// Port of `load_fixture` (`wr/fixture.py:40`).
pub fn load_fixture(manifest_path: String) -> Result<Vec<serde_json::Value>, String> {
    let resolved = abspath(&manifest_path);
    if !resolved.is_file() {
        return Err(protocol_error("not_found", "fixture manifest not found"));
    }
    let text = std::fs::read_to_string(&resolved)
        .map_err(|_| protocol_error("bad_request", "fixture manifest unreadable"))?;
    let manifest: Value = serde_json::from_str(&text)
        .map_err(|_| protocol_error("bad_request", "fixture manifest unreadable"))?;
    if !manifest.is_object() || !version_is_one(manifest.get("version")) {
        return Err(protocol_error(
            "bad_request",
            "unsupported fixture manifest version",
        ));
    }
    let base = resolved
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut accounts: Vec<Value> = Vec::new();
    for raw_account in get_array(&manifest, "accounts")? {
        let mut shards: Vec<Value> = Vec::new();
        for raw_shard in get_array(raw_account, "shards")? {
            let raw_path = raw_shard.get("path").ok_or_else(|| key_error("path"))?;
            let raw_path = raw_path.as_str().unwrap_or_default().to_string();
            let path = if is_abs(&raw_path) {
                PathBuf::from(&raw_path)
            } else {
                base.join(&raw_path)
            };
            let image = std::fs::read(&path)
                .map_err(|_| protocol_error("read_error", "fixture shard unreadable"))?;
            let id = raw_shard.get("id").ok_or_else(|| key_error("id"))?;
            shards.push(shard_json(id, &image));
        }

        let mut contacts: Vec<Value> = Vec::new();
        for raw in get_array(raw_account, "contacts")? {
            let username = raw.get("username").ok_or_else(|| key_error("username"))?;
            let id = match raw.get("id") {
                Some(v) if truthy(v) => v.clone(),
                _ => username.clone(),
            };
            let name = match raw.get("name") {
                Some(v) if truthy(v) => v.clone(),
                _ => username.clone(),
            };
            let kind = match raw.get("kind") {
                Some(v) if truthy(v) => v.clone(),
                _ => Value::String("friend".to_string()),
            };
            contacts.push(contact_json(&id, username, &name, &kind));
        }

        let account_id = raw_account
            .get("id")
            .ok_or_else(|| key_error("id"))?
            .clone();
        let name = match raw_account.get("name") {
            Some(v) if truthy(v) => v.clone(),
            _ => account_id.clone(),
        };
        let username = raw_account.get("username").cloned().unwrap_or(Value::Null);
        accounts.push(json!({
            "$object": "FixtureAccount",
            "attrs": {
                "id": py_str(&account_id),
                "name": py_str(&name),
                "username": username,
                "contacts": contacts,
                "shards": shards,
            }
        }));
    }
    Ok(accounts)
}
