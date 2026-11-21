//! Pure helpers of the snapshot store, testable without any filesystem state.

use serde_json::json;
use wr_snapshot::{blob_digest, safe_id};

#[test]
fn safe_id_matches_the_python_pattern() {
    for valid in ["a", "ds-1", "A.B_c-9", "x".repeat(64).as_str()] {
        assert_eq!(safe_id(&json!(valid), "dataset").unwrap(), valid);
    }
    for invalid in [
        "",
        "has space",
        "../escape",
        "中文",
        "x".repeat(65).as_str(),
    ] {
        let error = safe_id(&json!(invalid), "dataset").unwrap_err();
        assert_eq!(
            error,
            (
                "snapshot_error".to_string(),
                "invalid dataset id".to_string()
            )
        );
    }
    assert!(safe_id(&json!(12), "snapshot").is_err());
}

#[test]
fn blob_digest_is_stable_and_path_safe() {
    assert_eq!(blob_digest("s1"), "e8bc163c82eee18733288c7d4ac636db");
    assert_eq!(blob_digest("s1"), blob_digest("s1"));
    assert_ne!(blob_digest("s1"), blob_digest("s2"));
    assert!(
        blob_digest("../escape")
            .chars()
            .all(|c| c.is_ascii_hexdigit())
    );
}
