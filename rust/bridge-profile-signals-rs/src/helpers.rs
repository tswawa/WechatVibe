//! Deterministic summaries of cached, target-scoped model signals (bridge/profile_signals.py).
//!
//! `keyword_counts` uses the ASCII fallback tokenizer. The original prefers `jieba` when installed;
//! for ASCII words both produce the same accepted tokens, so golden cases stay on ASCII.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};
use std::collections::HashMap;

pub(crate) const STYLE_LABELS: [(&str, &str); 6] = [
    ("socialEnergy", "表达活力"),
    ("humor", "幽默表达"),
    ("composure", "情绪平和"),
    ("initiative", "话题主动"),
    ("care", "关怀支持"),
    ("affection", "亲近表达"),
];
pub(crate) const STOPWORDS: [&str; 16] = [
    "这个", "那个", "我们", "你们", "他们", "自己", "就是", "可以", "一下", "然后", "不是", "没有",
    "什么", "怎么", "真的", "还有",
];

pub(crate) fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => format!("'{s}'"),
        other => py_str(other),
    }
}

pub(crate) fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".to_string(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(py_repr).collect();
            format!("[{}]", parts.join(", "))
        }
        Value::Object(map) => {
            let parts: Vec<String> = map
                .iter()
                .map(|(k, v)| format!("'{}': {}", k, py_repr(v)))
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
    }
}

/// pyconv encodes non-finite floats as `{"$num": "NaN"}`; Python sees a plain float.
pub(crate) fn unwrap_special(v: &Value) -> Value {
    if let Some(tag) = v.get("$num").and_then(Value::as_str) {
        return match tag {
            "NaN" => json!(f64::NAN),
            "Infinity" => json!(f64::INFINITY),
            "-Infinity" => json!(f64::NEG_INFINITY),
            "-0" => json!(0.0),
            _ => v.clone(),
        };
    }
    v.clone()
}

pub(crate) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        _ => true,
    }
}

pub(crate) fn runtime(message: &str) -> String {
    format!("RuntimeError: {message}")
}

pub(crate) fn type_name(v: &Value) -> &'static str {
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

pub(crate) fn finite_number(v: &Value) -> Option<f64> {
    let n = v.as_f64()?;
    n.is_finite().then_some(n)
}

/// Port of `validate_style_evidence`.
pub fn validate_style_evidence(evidence: serde_json::Value) -> Result<serde_json::Value, String> {
    if evidence.is_null() {
        return Ok(Value::Null);
    }
    let map = evidence
        .as_object()
        .ok_or_else(|| runtime("invalid style evidence axes"))?;
    if map.len() != STYLE_LABELS.len()
        || STYLE_LABELS.iter().any(|(key, _)| !map.contains_key(*key))
    {
        return Err(runtime("invalid style evidence axes"));
    }
    for value in map.values() {
        let number =
            finite_number(value).ok_or_else(|| runtime("invalid style evidence probability"))?;
        if !(0.0..=1.0).contains(&number) {
            return Err(runtime("invalid style evidence probability"));
        }
    }
    Ok(evidence)
}

pub(crate) fn iter_rows(rows: &Value) -> Result<Vec<Value>, String> {
    match rows {
        Value::Array(items) => Ok(items.clone()),
        Value::String(text) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        Value::Object(map) => Ok(map.keys().cloned().map(Value::String).collect()),
        other => Err(format!(
            "TypeError: '{}' object is not iterable",
            type_name(other)
        )),
    }
}

pub(crate) fn unpack_row(row: &Value) -> Result<Vec<Value>, String> {
    let items = match row {
        Value::Array(items) => items.clone(),
        Value::String(text) => text.chars().map(|c| Value::String(c.to_string())).collect(),
        Value::Object(map) => map.keys().cloned().map(Value::String).collect(),
        other => {
            return Err(format!(
                "TypeError: cannot unpack non-iterable {} object",
                type_name(other)
            ));
        }
    };
    if items.len() < 4 {
        return Err(format!(
            "ValueError: not enough values to unpack (expected 4, got {})",
            items.len()
        ));
    }
    if items.len() > 4 {
        return Err("ValueError: too many values to unpack (expected 4)".to_string());
    }
    Ok(items)
}

pub(crate) fn row_result(row: &Value) -> Result<Map<String, Value>, String> {
    let items = unpack_row(row)?;
    items[1].as_object().cloned().ok_or_else(|| {
        format!(
            "AttributeError: '{}' object has no attribute 'get'",
            type_name(&items[1])
        )
    })
}

/// Port of `historical_mood`.
pub fn historical_mood(
    rows: serde_json::Value,
    kaomoji: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut signals: Vec<Vec<Value>> = Vec::new();
    for row in &iter_rows(&rows)? {
        let result = row_result(row)?;
        if let Some(Value::Array(emotion)) = result.get("emotion")
            && !emotion.is_empty()
        {
            signals.push(emotion.clone());
        }
    }
    if signals.is_empty() {
        return Ok(Value::Null);
    }
    let count = signals.len();
    let mut totals: Vec<(String, f64)> = Vec::new();
    let mut labels: HashMap<String, String> = HashMap::new();
    for (index, emotion) in signals.iter().enumerate() {
        let weight = if count == 1 {
            1.0
        } else {
            0.5 + 0.5 * index as f64 / (count - 1) as f64
        };
        for entry in emotion {
            let map = entry
                .as_object()
                .ok_or_else(|| runtime("invalid emotion entry"))?;
            let raw = map
                .get("rawLabel")
                .filter(|v| !v.is_null() && !v.as_str().unwrap_or_default().is_empty())
                .or_else(|| map.get("label"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let label = map.get("label").and_then(Value::as_str).unwrap_or_default();
            let probability = finite_number(map.get("probability").unwrap_or(&Value::Null))
                .ok_or_else(|| runtime("invalid emotion probability"))?;
            if let Some(entry) = totals.iter_mut().find(|(key, _)| key == raw) {
                entry.1 += weight * probability;
            } else {
                totals.push((raw.to_string(), weight * probability));
            }
            labels.insert(raw.to_string(), label.to_string());
        }
    }
    // Python's max() keeps the first maximum; Rust's max_by keeps the last.
    let mut dominant = String::new();
    let mut best: f64 = f64::NEG_INFINITY;
    for (key, value) in &totals {
        if *value > best {
            best = *value;
            dominant = key.clone();
        }
    }
    let kaomoji_value = kaomoji
        .as_object()
        .and_then(|m| m.get(&dominant))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({
        "label": labels
            .get(&dominant)
            .cloned()
            .map(Value::String)
            .unwrap_or(Value::Null),
        "rawLabel": dominant,
        "kaomoji": kaomoji_value,
        "sampleCount": count,
        "scope": "analyzed-history",
    }))
}

/// Port of `style_traits`.
pub fn style_traits(rows: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut values: HashMap<&str, Vec<f64>> = STYLE_LABELS
        .iter()
        .map(|(key, _)| (*key, Vec::new()))
        .collect();
    for row in &iter_rows(&rows)? {
        let result = row_result(row)?;
        let Some(evidence) = result.get("styleEvidence") else {
            continue;
        };
        if evidence.is_null() {
            continue;
        }
        let evidence = validate_style_evidence(evidence.clone())?;
        // INFALLIBLE: validate_style_evidence only returns an object or None.
        let Some(map) = evidence.as_object() else {
            continue;
        };
        for (key, _) in STYLE_LABELS {
            // INFALLIBLE: keys come from STYLE_LABELS and the map was validated above.
            if let Some(slot) = values.get_mut(key) {
                slot.push(map[key].as_f64().unwrap_or(0.0));
            }
        }
    }
    let mut out = Vec::new();
    for (key, label) in STYLE_LABELS {
        let items = &values[key];
        if items.is_empty() {
            continue;
        }
        let sum: f64 = items.iter().sum();
        let value = (100.0 * sum / items.len() as f64 + 0.5) as i64;
        out.push(json!({
            "key": key,
            "label": label,
            "val": value,
            "sampleCount": items.len(),
        }));
    }
    Ok(Value::Array(out))
}

/// ASCII fallback of `keyword_counts`.
pub fn keyword_counts(texts: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut counts: Vec<(String, i64)> = Vec::new();
    let array = iter_rows(&texts)?;
    for text in &array {
        let text = text.as_str().ok_or_else(|| {
            format!(
                "AttributeError: '{}' object has no attribute 'decode'",
                type_name(text)
            )
        })?;
        for token in tokenize_ascii(text) {
            if STOPWORDS.contains(&token.as_str()) || !valid_word(&token) {
                continue;
            }
            if let Some(entry) = counts.iter_mut().find(|(word, _)| word == &token) {
                entry.1 += 1;
            } else {
                counts.push((token, 1));
            }
        }
    }
    let out = counts;
    let map: Map<String, Value> = out
        .into_iter()
        .map(|(word, count)| (word, json!(count)))
        .collect();
    Ok(Value::Object(map))
}

pub(crate) fn tokenize_ascii(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphabetic() {
            current.push(ch);
        } else {
            if current.len() >= 3 {
                out.push(current.to_lowercase());
            }
            current.clear();
        }
    }
    if current.len() >= 3 {
        out.push(current.to_lowercase());
    }
    out
}

pub(crate) fn valid_word(word: &str) -> bool {
    let len = word.len();
    (2..=8).contains(&len) && word.chars().all(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
        || (3..=24).contains(&len) && word.bytes().all(|b| b.is_ascii_lowercase())
}

/// Port of `keywords_from_counts`.
pub fn keywords_from_counts(counts: serde_json::Value) -> Result<serde_json::Value, String> {
    let map = counts.as_object().ok_or_else(|| {
        format!(
            "AttributeError: '{}' object has no attribute 'items'",
            type_name(&counts)
        )
    })?;
    let mut items: Vec<(String, Value)> = Vec::new();
    for (key, value) in map {
        let number = finite_number(value).ok_or_else(|| {
            format!(
                "TypeError: bad operand type for unary -: '{}'",
                type_name(value)
            )
        })?;
        let _ = number;
        items.push((key.clone(), value.clone()));
    }
    items.sort_by(|a, b| {
        b.1.as_f64()
            .unwrap_or(0.0)
            .partial_cmp(&a.1.as_f64().unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    let out: Vec<Value> = items
        .into_iter()
        .filter(|(_, count)| count.as_f64().unwrap_or(0.0) >= 2.0)
        .take(6)
        .map(|(word, count)| json!({"word": word, "count": count}))
        .collect();
    Ok(Value::Array(out))
}

/// Port of `keywords_from_texts`.
pub fn keywords_from_texts(texts: serde_json::Value) -> Result<serde_json::Value, String> {
    keywords_from_counts(keyword_counts(texts)?)
}

/// Port of `summary_from_aggregate`.
pub fn summary_from_aggregate(
    count: serde_json::Value,
    broad: serde_json::Value,
    mood: serde_json::Value,
    keywords: serde_json::Value,
    group: bool,
) -> Result<serde_json::Value, String> {
    let nonfinite_broad = broad
        .get("$num")
        .and_then(Value::as_str)
        .filter(|tag| *tag != "-0")
        .map(str::to_string);
    let count = unwrap_special(&count);
    let broad = unwrap_special(&broad);
    if !truthy(&count) {
        return Ok(Value::Null);
    }
    let subject = if group {
        "群内成员"
    } else {
        "该联系人"
    };
    let mut parts = vec![format!("已分析{}条{subject}消息", py_str(&count))];
    if nonfinite_broad.is_some() {
        return Err("AttributeError: 'float' object has no attribute 'get'".to_string());
    }
    if truthy(&broad) {
        let map = broad.as_object().ok_or_else(|| {
            format!(
                "AttributeError: '{}' object has no attribute 'get'",
                type_name(&broad)
            )
        })?;
        let best = map
            .iter()
            .max_by(|a, b| {
                a.1.as_f64()
                    .unwrap_or(0.0)
                    .partial_cmp(&b.1.as_f64().unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(key, _)| key.clone())
            .unwrap_or_default();
        parts.push(format!("常见交流意图为{best}"));
    }
    if truthy(&mood) {
        let label = match &mood {
            Value::Object(map) => map
                .get("label")
                .and_then(Value::as_str)
                .ok_or_else(|| "KeyError: 'label'".to_string())?,
            Value::Array(_) => {
                return Err(
                    "TypeError: list indices must be integers or slices, not str".to_string(),
                );
            }
            Value::String(_) => {
                return Err("TypeError: string indices must be integers, not 'str'".to_string());
            }
            other => {
                return Err(format!(
                    "TypeError: '{}' object is not subscriptable",
                    type_name(other)
                ));
            }
        };
        parts.push(format!("情绪信号以{label}为主"));
    }
    if truthy(&keywords) {
        let items: Vec<Value> = match &keywords {
            Value::Array(items) => items.iter().take(3).cloned().collect(),
            Value::Object(_) => return Err("KeyError: slice(None, 3, None)".to_string()),
            Value::String(text) => text
                .chars()
                .take(3)
                .map(|c| Value::String(c.to_string()))
                .collect(),
            other => {
                return Err(format!(
                    "TypeError: '{}' object is not subscriptable",
                    type_name(other)
                ));
            }
        };
        let mut words = Vec::new();
        for item in items {
            let word = match &item {
                Value::Object(map) => map
                    .get("word")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "KeyError: 'word'".to_string())?,
                Value::String(_) => {
                    return Err("TypeError: string indices must be integers, not 'str'".to_string());
                }
                other => {
                    return Err(format!(
                        "TypeError: '{}' object is not subscriptable",
                        type_name(other)
                    ));
                }
            };
            words.push(word.to_string());
        }
        parts.push(format!("常见用词有{}", words.join("、")));
    }
    Ok(Value::String(format!("{}。", parts.join("，"))))
}

/// Port of `summary_from_signals`.
pub fn summary_from_signals(
    rows: serde_json::Value,
    mood: serde_json::Value,
    keywords: serde_json::Value,
    group: bool,
) -> Result<serde_json::Value, String> {
    if !truthy(&rows) {
        return Ok(Value::Null);
    }
    let array = iter_rows(&rows)?;
    let mut broad: Map<String, Value> = Map::new();
    for row in &array {
        let result = row_result(row)?;
        if let Some(Value::Array(items)) = result.get("intentBroad") {
            for item in items {
                let map = item
                    .as_object()
                    .ok_or_else(|| runtime("invalid broad entry"))?;
                let label = map.get("label").and_then(Value::as_str).unwrap_or_default();
                let probability =
                    finite_number(map.get("probability").unwrap_or(&Value::Null)).unwrap_or(0.0);
                let entry = broad.entry(label.to_string()).or_insert(json!(0.0));
                *entry = json!(entry.as_f64().unwrap_or(0.0) + probability);
            }
        }
    }
    summary_from_aggregate(
        json!(array.len()),
        Value::Object(broad),
        mood,
        keywords,
        group,
    )
}
