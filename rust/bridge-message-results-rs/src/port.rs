//! Pure validation of one analyzer result for a single message (bridge/message_results.py).
//!
//! Error text and check order mirror the original because callers match on them.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

const FINE_LABEL_SCHEMA: &str = "generic-v12";
const STYLE_LABELS: [&str; 6] = [
    "socialEnergy",
    "humor",
    "composure",
    "initiative",
    "care",
    "affection",
];
const AXES: [(&str, &str, &str); 4] = [
    ("EI", "E", "I"),
    ("SN", "S", "N"),
    ("TF", "T", "F"),
    ("JP", "J", "P"),
];

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

fn runtime(message: &str) -> String {
    format!("RuntimeError: {message}")
}

fn as_object<'a>(value: &'a Value, message: &str) -> Result<&'a Map<String, Value>, String> {
    value.as_object().ok_or_else(|| runtime(message))
}

fn finite_number(value: &Value) -> Option<f64> {
    let number = match value {
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    number.is_finite().then_some(number)
}

fn probability(entry: &Value, bool_ok: bool, message: &str) -> Result<f64, String> {
    let object = as_object(entry, message)?;
    let Some(label) = object.get("label") else {
        return Err(runtime(message));
    };
    if !label.is_string() {
        return Err(runtime(message));
    }
    let probability = object.get("probability").ok_or_else(|| runtime(message))?;
    if !bool_ok && probability.is_boolean() {
        return Err(runtime(message));
    }
    let value = finite_number(probability).ok_or_else(|| runtime(message))?;
    if !(0.0..=1.0).contains(&value) {
        return Err(runtime(message));
    }
    Ok(value)
}

fn distribution(
    value: Option<&Value>,
    required: bool,
    bool_ok: bool,
    message: &str,
) -> Result<Value, String> {
    match value {
        None if !required => Ok(json!([])),
        None => Err(runtime(message)),
        Some(Value::Null) if !required => Ok(json!([])),
        Some(Value::Array(items)) if !items.is_empty() || !required => {
            for item in items {
                probability(item, bool_ok, message)?;
            }
            Ok(Value::Array(items.clone()))
        }
        _ => Err(runtime(message)),
    }
}

fn validate_style_evidence(value: Option<&Value>) -> Result<Value, String> {
    let Some(value) = value else {
        return Ok(Value::Null);
    };
    if value.is_null() {
        return Ok(Value::Null);
    }
    let map = as_object(value, "invalid style evidence axes")?;
    if map.len() != STYLE_LABELS.len() || STYLE_LABELS.iter().any(|key| !map.contains_key(*key)) {
        return Err(runtime("invalid style evidence axes"));
    }
    for entry in map.values() {
        let number =
            finite_number(entry).ok_or_else(|| runtime("invalid style evidence probability"))?;
        if !(0.0..=1.0).contains(&number) {
            return Err(runtime("invalid style evidence probability"));
        }
    }
    Ok(value.clone())
}

fn validate_personality_evidence(value: Option<&Value>) -> Result<Value, String> {
    let Some(value) = value else {
        return Ok(Value::Null);
    };
    if value.is_null() {
        return Ok(Value::Null);
    }
    let map = as_object(value, "invalid personality evidence axes")?;
    if map.len() != AXES.len() || AXES.iter().any(|(axis, _, _)| !map.contains_key(*axis)) {
        return Err(runtime("invalid personality evidence axes"));
    }
    for (axis, left, right) in AXES {
        let entry = map.get(axis).expect("checked");
        let dist = as_object(entry, "invalid personality evidence distribution")?;
        if dist.len() != 3
            || !dist.contains_key(left)
            || !dist.contains_key(right)
            || !dist.contains_key("insufficient")
        {
            return Err(runtime("invalid personality evidence distribution"));
        }
        let mut sum = 0.0;
        for number in dist.values() {
            let value = finite_number(number)
                .ok_or_else(|| runtime("invalid personality evidence probability"))?;
            if !(0.0..=1.0).contains(&value) {
                return Err(runtime("invalid personality evidence probability"));
            }
            sum += value;
        }
        if sum <= 0.0 {
            return Err(runtime("invalid personality evidence probability"));
        }
    }
    Ok(value.clone())
}

fn check_grounded(response: &Map<String, Value>, fine: bool) -> Result<Value, String> {
    if fine {
        let Some(grounded) = response.get("groundedIntent") else {
            return Err(runtime("missing grounded intent"));
        };
        if grounded.is_null() {
            return Ok(Value::Null);
        }
        let map = as_object(grounded, "invalid grounded intent")?;
        if map.len() != 2
            || !map.contains_key("label")
            || !map.contains_key("evidenceKind")
            || !map["label"].is_string()
            || !map["evidenceKind"].is_string()
        {
            return Err(runtime("invalid grounded intent"));
        }
        let label = map["label"].as_str().unwrap_or_default();
        let kind = map["evidenceKind"].as_str().unwrap_or_default();
        let allowed: &[&str] = match label {
            "agree" => &["explicit_acceptance", "conditional_acceptance"],
            "reject" => &["explicit_refusal", "contextual_deferral"],
            "suggest_action" => &[
                "advice_marker",
                "negative_imperative",
                "imperative_adjustment",
                "delegated_action",
            ],
            "explain" => &["causal_explanation", "process_explanation"],
            "greet" => &["greeting_phrase"],
            "thank" => &["thanks_phrase"],
            "confirm" => &["short_acknowledgement"],
            "inspect" => &["first_person_inspection"],
            "deny" => &["contextual_denial"],
            "invite" => &["inclusive_invitation"],
            "ask_question" => &["answer_seeking_question"],
            "seek_help" => &["action_request"],
            "plan" => &["first_person_intention", "concrete_reschedule"],
            "correct" => &["explicit_correction"],
            "close_chat" => &["conversation_pause"],
            "complain" => &["negative_evaluation"],
            "status_report" => &["progress_statement"],
            "share_news" => &["sharing_announcement"],
            _ => &[],
        };
        if !allowed.contains(&kind) {
            return Err(runtime("invalid grounded intent"));
        }
        return Ok(grounded.clone());
    }
    if response.contains_key("groundedIntent") {
        return Err(runtime("grounded intent in portrait result"));
    }
    Ok(Value::Null)
}

fn build(response: Value, version: Value, side: Value, fine: bool) -> Result<Value, String> {
    let response = response.as_object().ok_or_else(|| {
        format!(
            "AttributeError: '{}' object has no attribute 'get'",
            type_name(&response)
        )
    })?;
    if response.get("analysisVersion") != Some(&version) {
        return Err(runtime("analysis response version mismatch"));
    }
    let label_schema = match response.get("labelSchema") {
        None => Value::Null,
        Some(Value::Null) => Value::Null,
        Some(Value::String(text)) => {
            if fine && text != FINE_LABEL_SCHEMA {
                return Err(runtime("fine label schema mismatch"));
            }
            Value::String(text.clone())
        }
        Some(_) => return Err(runtime("invalid label schema")),
    };
    if response.get("labelSchema").is_some()
        && !label_schema.is_null()
        && fine
        && label_schema.as_str() != Some(FINE_LABEL_SCHEMA)
    {
        return Err(runtime("fine label schema mismatch"));
    }
    let grounded = check_grounded(response, fine)?;

    let _emotion = distribution(response.get("emotion"), true, true, "invalid model emotion")?;
    let _intent = distribution(response.get("intent"), true, true, "invalid model intent")?;
    let broad = distribution(
        response.get("intentBroad"),
        false,
        true,
        "invalid broad intent",
    )?;
    let expression = distribution(
        response.get("expression"),
        false,
        true,
        "invalid expression distribution",
    )?;
    let playful = distribution(
        response.get("playfulIntent"),
        false,
        false,
        "invalid playful intent distribution",
    )?;
    if let Some(items) = playful.as_array() {
        for item in items {
            let label = item["label"].as_str().unwrap_or_default();
            if !label.starts_with("playful:") {
                return Err(runtime("invalid playful intent distribution"));
            }
        }
    }
    let relationship = match response.get("relationship") {
        None => None,
        Some(Value::Null) => Some(json!([])),
        Some(Value::Array(items)) => {
            for item in items {
                probability(item, false, "invalid relationship distribution")?;
            }
            Some(Value::Array(items.clone()))
        }
        Some(_) => return Err(runtime("invalid relationship distribution")),
    };

    let mut out = Map::new();
    for field in [
        "emotion",
        "intent",
        "emotionLabel",
        "intentLabel",
        "emotionP",
        "intentP",
        "analysisVersion",
    ] {
        out.insert(
            field.to_string(),
            response.get(field).cloned().unwrap_or(Value::Null),
        );
    }
    out.insert("intentBroad".to_string(), broad);
    if !label_schema.is_null() {
        out.insert("labelSchema".to_string(), label_schema);
    }
    if fine {
        out.insert("groundedIntent".to_string(), grounded);
    }
    out.insert("expression".to_string(), expression);
    out.insert("playfulIntent".to_string(), playful);
    out.insert(
        "styleEvidence".to_string(),
        validate_style_evidence(response.get("styleEvidence"))?,
    );
    out.insert(
        "personalityEvidence".to_string(),
        validate_personality_evidence(response.get("personalityEvidence"))?,
    );
    if let Some(relationship) = relationship {
        out.insert("relationship".to_string(), relationship);
    }
    let score = response.get("score").cloned().unwrap_or(Value::Null);
    let is_other = side.as_str() == Some("other");
    if is_other {
        let number = finite_number(&score).ok_or_else(|| runtime("missing relationship score"))?;
        if !(-1.0..=1.0).contains(&number) {
            return Err(runtime("missing relationship score"));
        }
    }
    out.insert("state".to_string(), Value::String("done".to_string()));
    out.insert(
        "score".to_string(),
        if is_other { score } else { Value::Null },
    );
    Ok(Value::Object(out))
}

/// Port of `validate_fine_result`.
pub fn validate_fine_result(
    response: serde_json::Value,
    version: serde_json::Value,
    side: serde_json::Value,
) -> Result<serde_json::Value, String> {
    build(response, version, side, true)
}

/// Port of `validate_portrait_result`.
pub fn validate_portrait_result(
    response: serde_json::Value,
    version: serde_json::Value,
    side: serde_json::Value,
) -> Result<serde_json::Value, String> {
    build(response, version, side, false)
}
