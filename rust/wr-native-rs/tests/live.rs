//! Deterministic parts of the live-mode boundary. Live process/window reads are not replayable.

use serde_json::json;
use wr_native::{NativeService, decode_cursor, encode_cursor};

#[test]
fn cursor_roundtrip() {
    let key = (1700000000000, "shard-2".to_string(), 7);
    let encoded = encode_cursor(Some(key.clone()));
    assert_eq!(
        encoded,
        json!({"sortSeq": "1700000000000", "shardId": "shard-2", "localId": "7"})
    );
    assert_eq!(decode_cursor(&encoded).unwrap(), Some(key));
    assert_eq!(decode_cursor(&json!(null)).unwrap(), None);
    assert_eq!(encode_cursor(None), json!(null));
}

#[test]
fn invalid_cursor_is_rejected() {
    assert!(decode_cursor(&json!(["a"])).is_err());
    assert!(decode_cursor(&json!({"shardId": "s", "localId": "1"})).is_err());
    assert!(decode_cursor(&json!({"sortSeq": "x", "shardId": "s", "localId": "1"})).is_err());
}

#[test]
fn live_service_starts_closed() {
    let dir = std::env::temp_dir().join(format!("wr-native-live-{}", std::process::id()));
    let service = NativeService::new_live(dir.to_string_lossy().as_ref()).unwrap();
    assert_eq!(service.hello()["mode"], json!("live"));
    // status() reads live process state; only assert its shape, never its value.
    let mut service = service;
    let status = service.status();
    assert!(status["state"].is_string());
    assert!(status["accounts"].is_array());
    assert_eq!(status["accountId"], json!(null));
}
