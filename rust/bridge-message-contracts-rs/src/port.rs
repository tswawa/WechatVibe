//! Pure API-insight contract: label schema, revision, scope and shape.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

const API_INSIGHT_REVISION: &str = "free-label-v6-compact";
const API_STATUSES: [&str; 4] = ["ok", "routine", "uncertain", "insufficient"];
const AFFECT_FIELDS: [&str; 3] = ["tone", "feeling", "interaction"];
const API_INTENT_LIMIT: usize = 1;

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

fn is_han(character: char) -> bool {
    let code = character as u32;
    (0x3400..=0x4DBF).contains(&code)
        || (0x4E00..=0x9FFF).contains(&code)
        || (0xF900..=0xFAFF).contains(&code)
        || (0x20000..=0x2FA1F).contains(&code)
}

/// Port of `api_insight_scope`.
pub fn api_insight_scope(source_id: serde_json::Value) -> Result<serde_json::Value, String> {
    let Some(text) = source_id.as_str() else {
        return Err(format!(
            "TypeError: can only concatenate str (not \"{}\") to str",
            type_name(&source_id)
        ));
    };
    Ok(json!(format!("{text}:{API_INSIGHT_REVISION}")))
}

/// Port of `valid_api_insight_label`.
pub fn valid_api_insight_label(value: serde_json::Value) -> Result<serde_json::Value, String> {
    let valid = value.as_str().is_some_and(|text| {
        let count = text.chars().count();
        (1..=4).contains(&count) && text.chars().all(is_han)
    });
    Ok(json!(valid))
}

fn invalid() -> String {
    "ValueError: invalid-insights".to_string()
}

/// Port of `normalize_api_insight`.
pub fn normalize_api_insight(item: serde_json::Value) -> Result<serde_json::Value, String> {
    let map = item.as_object().ok_or_else(invalid)?;
    let identifier = map.get("id").and_then(Value::as_str).unwrap_or_default();
    if identifier.is_empty() {
        return Err(invalid());
    }
    let status = map
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !API_STATUSES.contains(&status) {
        return Err(invalid());
    }
    if status != "ok" {
        if let Some(affect) = map.get("affect")
            && !affect.is_null()
        {
            let object = affect.as_object().ok_or_else(invalid)?;
            if !object.is_empty() {
                return Err(invalid());
            }
        }
        if let Some(intents) = map.get("intents")
            && !intents.is_null()
        {
            let array = intents.as_array().ok_or_else(invalid)?;
            if !array.is_empty() {
                return Err(invalid());
            }
        }
        return Ok(json!({"id": identifier, "status": status}));
    }

    if map.contains_key("affect") || map.contains_key("intents") {
        let affect_value = map.get("affect").cloned().unwrap_or(Value::Null);
        let affect = if affect_value.is_null() {
            Value::Object(Map::new())
        } else {
            affect_value
        };
        let affect_map = affect.as_object().ok_or_else(invalid)?;
        if affect_map
            .keys()
            .any(|key| !AFFECT_FIELDS.contains(&key.as_str()))
        {
            return Err(invalid());
        }
        let mut clean_affect = Map::new();
        for field in AFFECT_FIELDS {
            let Some(label) = affect_map.get(field) else {
                continue;
            };
            if label.is_null() {
                continue;
            }
            let text = label.as_str().unwrap_or_default();
            let count = text.chars().count();
            if !(1..=4).contains(&count) || !text.chars().all(is_han) {
                return Err(invalid());
            }
            clean_affect.insert(field.to_string(), Value::String(text.to_string()));
        }
        let values: Vec<&str> = clean_affect.values().filter_map(Value::as_str).collect();
        for (index, value) in values.iter().enumerate() {
            if values[..index].contains(value) {
                return Err(invalid());
            }
        }

        let intents_value = map.get("intents").cloned().unwrap_or(Value::Null);
        let intents = if intents_value.is_null() {
            Vec::new()
        } else {
            intents_value.as_array().ok_or_else(invalid)?.clone()
        };
        if intents.len() > API_INTENT_LIMIT {
            return Err(invalid());
        }
        let mut clean_intents: Vec<String> = Vec::new();
        for label in &intents {
            let text = label.as_str().unwrap_or_default();
            let count = text.chars().count();
            if !(1..=4).contains(&count) || !text.chars().all(is_han) {
                return Err(invalid());
            }
            if clean_intents.iter().any(|existing| existing == text) {
                return Err(invalid());
            }
            if values.contains(&text) {
                return Err(invalid());
            }
            clean_intents.push(text.to_string());
        }
        let mut result = Map::new();
        result.insert("id".to_string(), Value::String(identifier.to_string()));
        result.insert("status".to_string(), Value::String("ok".to_string()));
        if !clean_affect.is_empty() {
            result.insert("affect".to_string(), Value::Object(clean_affect));
        }
        result.insert(
            "intents".to_string(),
            Value::Array(clean_intents.into_iter().map(Value::String).collect()),
        );
        return Ok(Value::Object(result));
    }

    let emotion = map
        .get("emotion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let intent = map
        .get("intent")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let valid = |text: &str| {
        let count = text.chars().count();
        (1..=4).contains(&count) && text.chars().all(is_han)
    };
    if !valid(emotion) || !valid(intent) {
        return Err(invalid());
    }
    let mut affect = Map::new();
    affect.insert("feeling".to_string(), Value::String(emotion.to_string()));
    Ok(json!({
        "id": identifier,
        "status": "ok",
        "affect": affect,
        "intents": [intent],
    }))
}
