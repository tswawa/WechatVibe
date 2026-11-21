//! Deterministic helpers of `wr/discovery.py`.

use wr_discovery::{decode_config_bytes, opaque_account_id};

#[test]
fn opaque_id_is_stable_and_never_the_directory_name() {
    let id = opaque_account_id("C:/Users/me/Documents/xwechat_files/acctA/db_storage");
    assert!(id.starts_with("acc-"));
    assert_eq!(id.len(), 20);
    assert!(!id.contains("acctA"));
    assert_eq!(
        id,
        opaque_account_id("C:/Users/me/Documents/xwechat_files/acctA/db_storage")
    );
}

#[test]
fn config_decoding_handles_boms_and_gbk() {
    assert_eq!(decode_config_bytes(b"\xef\xbb\xbfhello"), "hello");
    assert_eq!(decode_config_bytes(&[0xFF, 0xFE, b'h', 0, b'i', 0]), "hi");
    // GBK for 中文
    assert_eq!(decode_config_bytes(&[0xD6, 0xD0, 0xCE, 0xC4]), "中文");
}
