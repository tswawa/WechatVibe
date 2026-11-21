//! Golden check: replay `testdata/ops.json` and require byte-equal JSON with `testdata/expected.json`.
//!
//! `tools/build-golden.py` produced both files from the Python original, so a failure here means the
//! Rust query layer answered differently — not that the fixture is stale.

use serde_json::Value;
use wr_query::SqliteShard;

#[test]
fn replay_matches_the_python_original() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let image = std::fs::read(format!("{dir}/testdata/msg.db")).expect("read fixture image");
    let ops_text = std::fs::read_to_string(format!("{dir}/testdata/ops.json")).expect("read ops");
    let expected_text =
        std::fs::read_to_string(format!("{dir}/testdata/expected.json")).expect("read expected");
    let expected: Vec<Value> = serde_json::from_str(&expected_text).expect("parse expected");

    let mut shard = SqliteShard::new("shard-1", &image, "wxid_self_account", Some("wxid_me"))
        .expect("open shard");

    let mut failures = Vec::new();
    let mut count = 0usize;
    for line in ops_text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let op: Value = serde_json::from_str(line).expect("parse op");
        let actual = wr_query::run_op(&mut shard, &op);
        let wanted = expected.get(count).cloned().unwrap_or(Value::Null);
        if actual != wanted {
            failures.push(format!(
                "op #{count} {}:\n  expected {}\n  actual   {}",
                op.get("op").and_then(Value::as_str).unwrap_or("?"),
                serde_json::to_string(&wanted).unwrap_or_default(),
                serde_json::to_string(&actual).unwrap_or_default()
            ));
        }
        count += 1;
    }

    assert_eq!(
        count,
        expected.len(),
        "recorded {count} ops but the golden set has {}",
        expected.len()
    );
    assert!(
        failures.is_empty(),
        "{} of {count} ops differ from the Python original:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
