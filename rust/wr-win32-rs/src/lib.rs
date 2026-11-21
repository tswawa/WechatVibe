//! Rust port of `wr/window.py`, the geometry / capture boundary of `wr/window_capture.py`,
//! and the Win32 half of `wr/discovery.py`.
//!
//! Split in two layers:
//! * pure functions (payload shaping, primary selection, key-literal scanning) — unit tested
//!   with synthetic data;
//! * thin Win32 adapters over the `windows` crate — they read live process/window state and
//!   therefore **cannot** be differentially compared with the Python original. This is stated
//!   plainly in `rust/DECISIONS.md` (ADR-017).

// Win32 adapters necessarily call unsafe APIs. Each call site is annotated `SAFETY:`.

use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowInfo {
    pub hwnd: usize,
    pub pid: u32,
    pub window: Rect,
    pub client: Rect,
    pub visible: bool,
    pub iconic: bool,
    pub foreground: bool,
    pub toolwindow: bool,
    pub dpi: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WeixinProcess {
    pub pid: u32,
    pub exe: Option<String>,
}

/// Port of `_window_payload`.
pub fn window_payload(info: &WindowInfo) -> Value {
    let rect = |r: Rect| {
        json!({
            "x": r.x, "y": r.y, "width": r.width, "height": r.height,
        })
    };
    json!({
        "hwnd": info.hwnd,
        "pid": info.pid,
        "window": rect(info.window),
        "client": rect(info.client),
        "visible": info.visible,
        "iconic": info.iconic,
        "foreground": info.foreground,
        "dpi": info.dpi,
    })
}

/// Port of the primary-window choice in `current_geometry`.
pub fn primary_window(windows: &[WindowInfo]) -> Option<&WindowInfo> {
    windows.iter().find(|w| w.foreground).or(windows.first())
}

/// Port of `current_geometry` for an already-collected window list.
///
/// `frame` is the optional cached capture payload; callers must never request a capture here
/// unless the caller explicitly opted in.
pub fn current_geometry(windows: &[WindowInfo], frame: Option<Value>) -> Value {
    if windows.is_empty() {
        return json!({
            "visible": false, "foreground": false,
            "width": 0, "height": 0, "windows": [],
        });
    }
    let primary = primary_window(windows).expect("non-empty");
    let mut payload = json!({
        "visible": primary.visible && !primary.iconic,
        "foreground": primary.foreground,
        "width": primary.client.width,
        "height": primary.client.height,
        "dpi": primary.dpi,
        "windows": windows.iter().map(window_payload).collect::<Vec<Value>>(),
    });
    if let Some(frame) = frame {
        payload
            .as_object_mut()
            .expect("object")
            .insert("frame".to_string(), frame);
    }
    payload
}

/// Port of the `active_account_id` matching rule: exactly one account wins.
pub fn active_account_id(
    accounts: &[(String, String)],
    open_paths: &[String],
    is_under: impl Fn(&str, &str) -> bool,
) -> Option<String> {
    let mut matches = std::collections::HashSet::new();
    for path in open_paths {
        for (id, dir) in accounts {
            if is_under(path, dir) {
                matches.insert(id.clone());
            }
        }
    }
    if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    }
}

/// Port of the `HEX64` / `SQL_KEY_LITERAL` candidate extraction over a bounded memory buffer.
///
/// `x'<hex>'` literals with 64..192 hex chars, plus bare 64-hex sequences.
pub fn scan_key_literals(data: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let is_hex = |b: u8| b.is_ascii_hexdigit();
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'x' && i + 2 < data.len() && data[i + 1] == b'\'' {
            let start = i + 2;
            let mut end = start;
            while end < data.len() && is_hex(data[end]) {
                end += 1;
            }
            let len = end - start;
            if (64..=192).contains(&len) && end < data.len() && data[end] == b'\'' {
                out.push((
                    "sql_literal".to_string(),
                    String::from_utf8_lossy(&data[start..end]).into_owned(),
                ));
                i = end + 1;
                continue;
            }
        }
        if is_hex(data[i]) {
            let start = i;
            let mut end = i;
            while end < data.len() && is_hex(data[end]) {
                end += 1;
            }
            if end - start == 64 {
                out.push((
                    "hex64".to_string(),
                    String::from_utf8_lossy(&data[start..end]).into_owned(),
                ));
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Port of `_is_under` for live paths (realpath + normcase boundary).
pub fn is_path_under(path: &str, root: &str) -> bool {
    let normalise = |raw: &str| {
        let canonical =
            std::fs::canonicalize(raw).unwrap_or_else(|_| std::path::PathBuf::from(raw));
        canonical
            .to_string_lossy()
            .to_lowercase()
            .replace('/', "\\")
    };
    let path = normalise(path);
    let root = normalise(root);
    path == root || path.starts_with(&format!("{root}\\"))
}

/// Whether a process name is Weixin / WeChat (port of the name filter).
pub fn is_weixin_process(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "weixin.exe" | "wechat.exe"
    )
}

// ---------------------------------------------------------------- Win32 adapters
// These are not reproducible: they read the running desktop. Unit tests cover the pure layer above.

pub mod win32 {
    use super::*;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClientRect, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
        IsIconic, IsWindowVisible,
    };

    /// Enumerate live Weixin processes.
    pub fn find_weixin_processes() -> Vec<WeixinProcess> {
        let mut found = Vec::new();
        // SAFETY: CreateToolhelp32Snapshot takes no pointers and returns an owned handle.
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return found;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
        while ok {
            let name: String = entry
                .szExeFile
                .iter()
                .take_while(|c| **c != 0)
                .map(|c| char::from_u32(*c as u32).unwrap_or('?'))
                .collect();
            if is_weixin_process(&name) {
                found.push(WeixinProcess {
                    pid: entry.th32ProcessID,
                    exe: None,
                });
            }
            ok = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
        }
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(snapshot) };
        found
    }

    fn rect_of(raw: RECT) -> Rect {
        Rect {
            x: raw.left,
            y: raw.top,
            width: (raw.right - raw.left).max(0),
            height: (raw.bottom - raw.top).max(0),
        }
    }

    /// Enumerate visible windows belonging to `pids`, with window/client rectangles.
    pub fn enumerate_windows(pids: &[u32]) -> Vec<WindowInfo> {
        let mut results: Vec<WindowInfo> = Vec::new();
        let foreground = unsafe { GetForegroundWindow() }.0 as usize;
        unsafe extern "system" fn callback(
            hwnd: HWND,
            lparam: LPARAM,
        ) -> windows::Win32::Foundation::BOOL {
            let state = unsafe { &mut *(lparam.0 as *mut Vec<(usize, u32)>) };
            if unsafe { IsWindowVisible(hwnd) }.as_bool() {
                let mut pid = 0u32;
                unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
                state.push((hwnd.0 as usize, pid));
            }
            windows::Win32::Foundation::BOOL(1)
        }
        let mut candidates: Vec<(usize, u32)> = Vec::new();
        unsafe {
            EnumWindows(
                Some(callback),
                LPARAM(&mut candidates as *mut Vec<(usize, u32)> as isize),
            )
        }
        .ok();

        for (hwnd, pid) in candidates {
            if !pids.contains(&pid) {
                continue;
            }
            let hwnd_handle = HWND(hwnd as *mut core::ffi::c_void);
            let mut outer = RECT::default();
            let mut inner = RECT::default();
            if unsafe { GetWindowRect(hwnd_handle, &mut outer) }.is_err()
                || unsafe { GetClientRect(hwnd_handle, &mut inner) }.is_err()
            {
                continue;
            }
            let mut origin = POINT {
                x: inner.left,
                y: inner.top,
            };
            let _ = unsafe { ClientToScreen(hwnd_handle, &mut origin) };
            let client = Rect {
                x: origin.x,
                y: origin.y,
                width: (inner.right - inner.left).max(0),
                height: (inner.bottom - inner.top).max(0),
            };
            let dpi = unsafe { GetDpiForWindow(hwnd_handle) };
            results.push(WindowInfo {
                hwnd,
                pid,
                window: rect_of(outer),
                client,
                visible: true,
                iconic: unsafe { IsIconic(hwnd_handle) }.as_bool(),
                foreground: hwnd == foreground,
                toolwindow: false,
                dpi,
            });
        }
        results
    }

    /// Geometry for live windows. Capture is deliberately not implemented here: the original
    /// only asks a bounded worker for a cached frame, and no worker exists in this crate.
    pub fn current_geometry(pids: &[u32], capture: bool) -> Value {
        let windows = enumerate_windows(pids);
        let frame = if capture { None } else { None };
        super::current_geometry(&windows, frame)
    }
}
