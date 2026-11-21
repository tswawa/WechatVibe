//! Replay `ops.json` against a snapshot directory and print one JSON result per op.

use serde_json::{Value, json};
use std::io::{BufRead, Write};
use wr_snapshot::SnapshotStore;

fn arg(args: &[String], name: &str) -> Option<String> {
    let index = args.iter().position(|a| a == name)?;
    args.get(index + 1).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let directory = arg(&args, "--dir").unwrap_or_else(|| "testdata/py".to_string());
    let ops_path = arg(&args, "--ops").unwrap_or_else(|| "testdata/ops.json".to_string());

    let store = SnapshotStore::new(&directory).unwrap_or_else(|e| panic!("open store: {e:?}"));
    let file = std::fs::File::open(&ops_path).expect("read ops");
    let mut responses: Vec<Value> = Vec::new();

    for line in std::io::BufReader::new(file).lines() {
        let line = line.expect("read line");
        if line.trim().is_empty() {
            continue;
        }
        let op: Value = serde_json::from_str(&line).expect("parse op");
        let name = op.get("op").and_then(Value::as_str).unwrap_or_default();
        // `id` can reference the snapshotId returned by an earlier create_snapshot op, so both
        // implementations use their own freshly generated id in later calls.
        let resolved_id: Value = if let Some(index) = op.get("from_create").and_then(Value::as_u64)
        {
            responses
                .get(index as usize)
                .and_then(|r| r.get("ok"))
                .and_then(|r| r.get("snapshotId"))
                .cloned()
                .unwrap_or(Value::Null)
        } else {
            op.get("id").cloned().unwrap_or(Value::Null)
        };
        let id = &resolved_id;

        let outcome: Result<Value, (String, String)> = match name {
            "has_dataset" => store
                .has_dataset(op.get("dataset_id").unwrap_or(&Value::Null))
                .map(|v| json!(v)),
            "create_dataset" => store.create_dataset(
                op.get("dataset_id").unwrap_or(&Value::Null),
                op.get("meta").unwrap_or(&Value::Null),
                op.get("blobs")
                    .and_then(Value::as_array)
                    .unwrap_or(&Vec::new()),
            ),
            "load_dataset_meta" => {
                store.load_dataset_meta(op.get("dataset_id").unwrap_or(&Value::Null))
            }
            "load_dataset_blob" => store.load_dataset_blob(
                op.get("dataset_id").unwrap_or(&Value::Null),
                op.get("shard_id").unwrap_or(&Value::Null),
            ),
            "prune_datasets" => store
                .prune_datasets(op.get("max").and_then(Value::as_i64).unwrap_or(0))
                .map(|_| Value::Null),
            "create_snapshot" => store.create_snapshot(op.get("meta").unwrap_or(&Value::Null)),
            "load_meta" => store.load_meta(id),
            other => Ok(json!({ "error": format!("unknown op {other}") })),
        };
        responses.push(match outcome {
            Ok(value) => json!({ "ok": value }),
            Err((code, message)) => json!({ "error": format!("ProtocolError({code}): {message}") }),
        });
    }

    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    writeln!(
        handle,
        "{}",
        serde_json::to_string(&responses).expect("encode")
    )
    .expect("write");
}
