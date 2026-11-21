//! Replay deterministic service helpers (including full shard decryption) against golden inputs.

use serde_json::{Value, json};
use std::io::{BufRead, Write};
use wr_service_core as s;

fn arg(args: &[String], name: &str) -> Option<String> {
    let index = args.iter().position(|a| a == name)?;
    args.get(index + 1).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let ops_path = arg(&args, "--ops").unwrap_or_else(|| "testdata/ops.json".to_string());
    let file = std::fs::File::open(&ops_path).expect("read ops");
    let mut out: Vec<Value> = Vec::new();
    for line in std::io::BufReader::new(file).lines() {
        let line = line.expect("read line");
        if line.trim().is_empty() {
            continue;
        }
        let op: Value = serde_json::from_str(&line).expect("parse op");
        let name = op.get("op").and_then(Value::as_str).unwrap_or_default();
        let val = |key: &str| op.get(key).cloned().unwrap_or(Value::Null);
        let text = |key: &str| val(key).as_str().unwrap_or_default().to_string();
        let answer: Result<Value, (String, String)> = match name {
            "map_kind" => Ok(json!(s::map_kind(&text("kind")))),
            "int_param" => s::int_param(
                &val("value"),
                val("default").as_i64().unwrap_or(0),
                val("low").as_i64().unwrap_or(0),
                val("high").as_i64().unwrap_or(0),
                "value",
            )
            .map(|n| json!(n)),
            "classify_shard" => Ok(json!(s::classify_shard(&text("path")))),
            "account_username_candidates" => {
                Ok(json!(s::account_username_candidates(&text("path"))))
            }
            "decrypt_shard_pages" => {
                let wal = op.get("wal").filter(|v| !v.is_null());
                s::decrypt_shard_pages(&val("db"), wal, &val("key"), &val("salt"))
            }
            "decrypt_shard_image" => {
                let wal = op.get("wal").filter(|v| !v.is_null());
                s::decrypt_shard_image(&val("db"), wal, &val("key"), &val("salt"))
            }
            other => Ok(json!({"error": format!("unknown op {other}")})),
        };
        out.push(match answer {
            Ok(v) => json!({"ok": v}),
            Err((code, message)) => json!({"error": format!("ProtocolError({code}): {message}")}),
        });
    }
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{}", serde_json::to_string(&out).expect("encode")).expect("write");
}
