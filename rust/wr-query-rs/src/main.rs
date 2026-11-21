//! Replays `testdata/ops.json` against the fixture shards and prints the JSON results.
//!
//! Used by `tools/compare.py`; `cargo test` runs the same dispatch through `tests/golden.rs`.

use serde_json::Value;
use std::io::{BufRead, Write};
use wr_query::Runner;

fn arg(args: &[String], name: &str) -> Option<String> {
    let index = args.iter().position(|a| a == name)?;
    args.get(index + 1).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let first = arg(&args, "--image").unwrap_or_else(|| "testdata/msg-1.db".to_string());
    let second = arg(&args, "--second-image").unwrap_or_else(|| "testdata/msg-2.db".to_string());
    let account = arg(&args, "--account").unwrap_or_else(|| "account".to_string());
    let shard_id = arg(&args, "--shard-id").unwrap_or_else(|| "shard-1".to_string());
    let self_username = arg(&args, "--self").filter(|s| !s.is_empty());
    let ops_path = arg(&args, "--ops").unwrap_or_else(|| "testdata/ops.json".to_string());

    let first = std::fs::read(&first).expect("read first image");
    let second = std::fs::read(&second).expect("read second image");
    let mut runner = Runner::new(
        &shard_id,
        &first,
        &second,
        &account,
        self_username.as_deref(),
    )
    .unwrap_or_else(|e| panic!("open shards: {e:?}"));

    let file = std::fs::File::open(&ops_path).expect("read ops");
    let mut out: Vec<Value> = Vec::new();
    for line in std::io::BufReader::new(file).lines() {
        let line = line.expect("read line");
        if line.trim().is_empty() {
            continue;
        }
        let op: Value = serde_json::from_str(&line).expect("parse op");
        out.push(runner.run(&op));
    }
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    writeln!(handle, "{}", serde_json::to_string(&out).expect("encode")).expect("write");
}
