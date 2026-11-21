//! Deterministic helpers of `wr/service.py` that need no fixture files.

use serde_json::json;
use wr_service_core::{classify_shard, int_param, map_kind};

#[test]
fn map_kind_matches_the_original_table() {
    assert_eq!(map_kind("friend"), "friend");
    assert_eq!(map_kind("private"), "friend");
    assert_eq!(map_kind("chatroom"), "group");
    assert_eq!(map_kind("group"), "group");
    assert_eq!(map_kind("service"), "service");
    assert_eq!(map_kind("unknown"), "unknown");
    assert_eq!(map_kind("nonsense"), "unknown");
}

#[test]
fn classify_shard_checks_path_then_name() {
    assert_eq!(classify_shard("D:/x/Message/msg-1.db"), "message");
    assert_eq!(classify_shard("D:/x/message_0.db"), "message");
    assert_eq!(classify_shard("D:/x/contact.db"), "contact");
    assert_eq!(classify_shard("D:/x/session_1.db"), "session");
    assert_eq!(classify_shard("D:/x/misc.db"), "other");
}

#[test]
fn int_param_bounds_are_inclusive() {
    assert_eq!(int_param(&json!(null), 5, 1, 10, "value").unwrap(), 5);
    assert_eq!(int_param(&json!("7"), 5, 1, 10, "value").unwrap(), 7);
    assert_eq!(int_param(&json!(1), 5, 1, 10, "value").unwrap(), 1);
    assert!(int_param(&json!(11), 5, 1, 10, "value").is_err());
    assert!(int_param(&json!("x"), 5, 1, 10, "value").is_err());
}
