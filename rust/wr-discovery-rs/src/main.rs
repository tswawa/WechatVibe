//! Replay deterministic discovery ops against a synthetic directory tree.

use serde_json::{Value, json};
use std::io::{BufRead, Write};
use wr_discovery as d;

fn arg(args: &[String], name: &str) -> Option<String> {
    let index = args.iter().position(|a| a == name)?;
    args.get(index + 1).cloned()
}

fn str_of(op: &Value, key: &str) -> String {
    op.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
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
        let answer: Value = match name {
            "opaque_account_id" => json!(d::opaque_account_id(&str_of(&op, "path"))),
            "is_under" => json!(d::is_under(&str_of(&op, "path"), &str_of(&op, "root"))),
            "decode_config_bytes" => {
                let hex = str_of(&op, "hex");
                let bytes: Vec<u8> = (0..hex.len())
                    .step_by(2)
                    .filter_map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
                    .collect();
                json!(d::decode_config_bytes(&bytes))
            }
            "existing_absolute_directory" => {
                json!(d::existing_absolute_directory(&str_of(&op, "value")))
            }
            "config_line_directory" => json!(d::config_line_directory(&str_of(&op, "line"))),
            "config_content_directories" => {
                json!(d::config_content_directories(&str_of(&op, "content")))
            }
            "discover_account_dirs" => {
                let roots: Vec<String> = op
                    .get("roots")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                json!(d::discover_account_dirs(&roots))
            }
            "discover_shards" => json!(d::discover_shards(&str_of(&op, "path"))),
            other => json!({ "error": format!("unknown op {other}") }),
        };
        out.push(json!({ "ok": answer }));
    }
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{}", serde_json::to_string(&out).expect("encode")).expect("write");
}
