//! Replay NativeService fixture-mode ops and print their JSON responses.

use serde_json::{Value, json};
use std::io::{BufRead, Write};
use wr_native::NativeService;

fn arg(args: &[String], name: &str) -> Option<String> {
    let index = args.iter().position(|a| a == name)?;
    args.get(index + 1).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let manifest = arg(&args, "--manifest").unwrap_or_default();
    let cache = arg(&args, "--cache").unwrap_or_default();
    let ops_path = arg(&args, "--ops").unwrap_or_else(|| "testdata/ops.json".to_string());

    let mut service = NativeService::new(&cache, Some(&manifest))
        .unwrap_or_else(|e| panic!("construct service: {e:?}"));
    let file = std::fs::File::open(&ops_path).expect("read ops");
    let mut out: Vec<Value> = Vec::new();
    let params = |op: &Value| op.get("params").cloned().unwrap_or(json!({}));

    for line in std::io::BufReader::new(file).lines() {
        let line = line.expect("read line");
        if line.trim().is_empty() {
            continue;
        }
        let op: Value = serde_json::from_str(&line).expect("parse op");
        let name = op.get("op").and_then(Value::as_str).unwrap_or_default();
        let outcome: Result<Value, (String, String)> = match name {
            "hello" => Ok(service.hello()),
            "status" => Ok(service.status()),
            "accounts" => Ok(service.accounts_method()),
            "connect" => service.connect(&params(&op)),
            "contacts" => service.contacts(&params(&op)),
            "latest" => service.latest(&params(&op)),
            "open_history" => service.open_history(&params(&op)),
            "read_history" => service.read_history(&params(&op)),
            "read_incremental" => service.read_incremental(&params(&op)),
            "window_method" => Ok(service.window_method(&params(&op))),
            "window_uia_method" => Ok(service.window_uia_method(&params(&op))),
            "close" => Ok(service.close()),
            other => Ok(json!({"error": format!("unknown op {other}")})),
        };
        out.push(match outcome {
            Ok(v) => json!({ "ok": v }),
            Err((code, message)) => json!({ "error": format!("ProtocolError({code}): {message}") }),
        });
    }
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{}", serde_json::to_string(&out).expect("encode")).expect("write");
}
