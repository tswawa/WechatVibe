//! The Rust port of `wr/protocol.py`.
//!
//! UTF-8 JSONL request/response framing: `{id, method, params}` in, `{id, ok, result|error}` out.
//! `read_request` / `write_message` take a `TextIO` and stay in Python — a file object has no
//! meaningful shape across the bridge.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

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

fn bad_request(message: &str) -> String {
    format!("ProtocolError(bad_request): {message}")
}

/// Port of `validate_request` (`wr/protocol.py:38`).
pub fn validate_request(request: serde_json::Value) -> Result<serde_json::Value, String> {
    let Value::Object(request) = &request else {
        return Err(format!(
            "AttributeError: '{}' object has no attribute 'get'",
            type_name(&request)
        ));
    };

    let request_id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").cloned().unwrap_or(Value::Null);
    let mut params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    match &request_id {
        Value::String(s) if (1..=256).contains(&s.chars().count()) => {}
        _ => return Err(bad_request("id must be a 1..256 string")),
    }
    match &method {
        Value::String(s) if (1..=64).contains(&s.chars().count()) => {}
        _ => return Err(bad_request("method must be a 1..64 string")),
    }
    if params.is_null() {
        params = json!({});
    }
    if !params.is_object() {
        return Err(bad_request("params must be an object"));
    }

    Ok(json!({ "$tuple": [request_id, method, params] }))
}

/// Port of `ok` (`wr/protocol.py:59`).
pub fn ok(
    request_id: serde_json::Value,
    result: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut out = Map::new();
    out.insert("id".to_string(), request_id);
    out.insert("ok".to_string(), Value::Bool(true));
    out.insert("result".to_string(), result);
    Ok(Value::Object(out))
}

/// Port of `fail` (`wr/protocol.py:63`).
pub fn fail(
    request_id: serde_json::Value,
    code: serde_json::Value,
    message: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut error = Map::new();
    error.insert("code".to_string(), code);
    error.insert("message".to_string(), message);
    let mut out = Map::new();
    out.insert("id".to_string(), request_id);
    out.insert("ok".to_string(), Value::Bool(false));
    out.insert("error".to_string(), Value::Object(error));
    Ok(Value::Object(out))
}
