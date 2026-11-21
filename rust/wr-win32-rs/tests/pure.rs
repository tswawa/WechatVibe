//! Unit tests for the deterministic layer. Win32 adapters read live state and are not tested here.

use serde_json::json;
use wr_win32::*;

fn win(hwnd: usize, pid: u32, foreground: bool) -> WindowInfo {
    WindowInfo {
        hwnd,
        pid,
        window: Rect {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
        },
        client: Rect {
            x: 8,
            y: 30,
            width: 784,
            height: 562,
        },
        visible: true,
        iconic: false,
        foreground,
        toolwindow: false,
        dpi: 96,
    }
}

#[test]
fn no_windows_yields_the_empty_payload() {
    assert_eq!(
        current_geometry(&[], None),
        json!({"visible": false, "foreground": false, "width": 0, "height": 0, "windows": []})
    );
}

#[test]
fn foreground_window_is_primary() {
    let windows = vec![win(1, 10, false), win(2, 10, true), win(3, 11, false)];
    let payload = current_geometry(&windows, None);
    assert_eq!(payload["foreground"], json!(true));
    assert_eq!(payload["width"], json!(784));
    assert_eq!(payload["height"], json!(562));
    assert_eq!(payload["windows"][1]["hwnd"], json!(2));
    assert!(payload.get("frame").is_none());
}

#[test]
fn capture_frame_is_only_added_when_supplied() {
    let windows = vec![win(1, 10, true)];
    let payload = current_geometry(&windows, Some(json!({"png": "abc"})));
    assert_eq!(payload["frame"], json!({"png": "abc"}));
}

#[test]
fn process_name_filter() {
    assert!(is_weixin_process("WeiXin.EXE"));
    assert!(is_weixin_process("WeChat.exe"));
    assert!(!is_weixin_process("explorer.exe"));
}

#[test]
fn key_literal_scanning() {
    let hex64 = "ab".repeat(32);
    let buf = format!("x'{hex64}' bare={hex64}").into_bytes();
    let found = scan_key_literals(&buf);
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].0, "sql_literal");
    assert_eq!(found[0].1, hex64);
    assert_eq!(found[1].0, "hex64");
}

#[test]
fn active_account_requires_exactly_one_match() {
    let accounts = vec![("a1".to_string(), "C:\\data\\a1".to_string())];
    let is_under = |path: &str, root: &str| path.starts_with(root);
    assert_eq!(
        active_account_id(
            &accounts,
            &["C:\\data\\a1\\db_storage\\m.db".to_string()],
            is_under,
        ),
        Some("a1".to_string())
    );
    assert_eq!(active_account_id(&accounts, &[], is_under), None);
}
