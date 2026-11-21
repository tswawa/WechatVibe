//! Rust port of `wr/discovery.py`'s deterministic path / config discovery.
//!
//! Covered: `opaque_account_id`, `_is_under`, config decoding (UTF-8 BOM / UTF-16 / GBK),
//! config value extraction, `discover_account_dirs(roots)` and `discover_shards`.
//!
//! Deliberately **not** covered: `find_weixin_processes`, `process_open_file_paths`,
//! `active_account_id` and memory scanning. Those read live process state; their output is not
//! reproducible even between two runs of the original, so no differential proof is possible.

#![forbid(unsafe_code)]

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

const CONFIG_PATH_KEYS: [&str; 6] = [
    "dataDir",
    "data_dir",
    "fileSavePath",
    "savePath",
    "path",
    "defaultFileSavePath",
];

/// Python `os.path.abspath`: join with cwd if relative, then collapse `.` / `..` textually.
pub fn abspath(raw: &str) -> String {
    let path = Path::new(raw);
    let joined = if is_abs(raw) {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().replace('/', "\\")
}

fn is_abs(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.first().is_some_and(|b| *b == b'/' || *b == b'\\') {
        return true;
    }
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// Port of `opaque_account_id`.
pub fn opaque_account_id(path: &str) -> String {
    let digest = Sha256::digest(abspath(path).as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("acc-{}", &hex[..16])
}

/// Port of `_is_under`: realpath + normcase + separator boundary.
pub fn is_under(path: &str, root: &str) -> bool {
    let normalize = |raw: &str| -> String {
        let resolved = std::fs::canonicalize(raw).unwrap_or_else(|_| PathBuf::from(abspath(raw)));
        resolved.to_string_lossy().to_lowercase().replace('/', "\\")
    };
    let normalized = normalize(path);
    let boundary = normalize(root);
    normalized == boundary || normalized.starts_with(&format!("{boundary}\\"))
}

/// Port of `_decode_config_bytes`.
pub fn decode_config_bytes(data: &[u8]) -> String {
    if data.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&data[3..]).into_owned();
    }
    if data.starts_with(&[0xFF, 0xFE]) {
        return encoding_rs::UTF_16LE.decode(&data[2..]).0.into_owned();
    }
    if data.starts_with(&[0xFE, 0xFF]) {
        return encoding_rs::UTF_16BE.decode(&data[2..]).0.into_owned();
    }
    match std::str::from_utf8(data) {
        Ok(text) => text.to_string(),
        Err(_) => encoding_rs::GBK.decode(data).0.into_owned(),
    }
}

/// Port of `_existing_absolute_directory`.
pub fn existing_absolute_directory(value: &str) -> Option<String> {
    let candidate = value
        .trim()
        .trim_start_matches('\u{FEFF}')
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim();
    if candidate.is_empty() || !is_abs(candidate) || !Path::new(candidate).is_dir() {
        return None;
    }
    Some(abspath(candidate))
}

/// Port of `_config_line_directory`.
pub fn config_line_directory(line: &str) -> Option<String> {
    let stripped = line.trim().trim_start_matches('\u{FEFF}').trim();
    if stripped.is_empty() {
        return None;
    }
    if let Some(direct) = existing_absolute_directory(stripped) {
        return Some(direct);
    }
    for separator in ['=', ':'] {
        if let Some((_, value)) = stripped.split_once(separator)
            && let Some(candidate) = existing_absolute_directory(value)
        {
            return Some(candidate);
        }
    }
    None
}

/// Port of `_config_content_directories`.
pub fn config_content_directories(content: &str) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    let trimmed = content.trim().trim_start_matches('\u{FEFF}');
    let parsed: Option<Value> = serde_json::from_str(trimmed).ok();
    let mut push = |value: &Value| {
        if let Some(text) = value.as_str()
            && let Some(candidate) = existing_absolute_directory(text)
            && !roots.contains(&candidate)
        {
            roots.push(candidate);
        }
    };
    match &parsed {
        Some(Value::Object(map)) => {
            for key in CONFIG_PATH_KEYS {
                if let Some(value) = map.get(key) {
                    push(value);
                }
            }
            return roots;
        }
        Some(Value::Array(items)) => {
            for value in items {
                push(value);
            }
            return roots;
        }
        Some(Value::String(text)) => {
            push(&Value::String(text.clone()));
            return roots;
        }
        _ => {}
    }
    for line in content.lines() {
        if let Some(candidate) = config_line_directory(line)
            && !roots.contains(&candidate)
        {
            roots.push(candidate);
        }
        // Match `[A-Za-z]:[\\/][^\s\x00-\x1f"']+` — a drive path embedded in a setting line.
        for matched in drive_paths(line) {
            let trimmed_path = matched.trim_end_matches(['\\', '/', ';', ',']);
            if let Some(candidate) = existing_absolute_directory(trimmed_path)
                && !roots.contains(&candidate)
            {
                roots.push(candidate);
            }
        }
    }
    roots
}

fn drive_paths(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index + 2 < bytes.len() {
        if bytes[index].is_ascii_alphabetic()
            && bytes[index + 1] == b':'
            && (bytes[index + 2] == b'\\' || bytes[index + 2] == b'/')
        {
            let mut end = index + 3;
            while end < bytes.len() {
                let b = bytes[end];
                if b.is_ascii_whitespace() || b < 0x20 || b == b'"' || b == b'\'' {
                    break;
                }
                end += 1;
            }
            out.push(line[index..end].to_string());
            index = end;
        } else {
            index += 1;
        }
    }
    out
}

fn add_account(
    storage: &Path,
    seen: &mut std::collections::HashSet<String>,
    accounts: &mut Vec<Value>,
) {
    let key = abspath(&storage.to_string_lossy());
    if seen.insert(key.clone()) {
        accounts.push(json!({
            "$object": "AccountDir",
            "attrs": {
                "id": opaque_account_id(&key),
                "path": key,
                "state": "available",
                "message": "",
            }
        }));
    }
}

/// Port of `discover_account_dirs` with the roots supplied explicitly.
pub fn discover_account_dirs(roots: &[String]) -> Vec<Value> {
    let mut accounts: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for root in roots {
        if !Path::new(root).is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let storage = entry.path().join("db_storage");
                if storage.is_dir() {
                    add_account(&storage, &mut seen, &mut accounts);
                }
            }
        }
        let direct = Path::new(root).join("db_storage");
        if direct.is_dir() {
            add_account(&direct, &mut seen, &mut accounts);
        }
    }
    accounts
}

/// Port of `discover_shards` for one account path.
pub fn discover_shards(account_path: &str) -> Vec<Value> {
    fn visit(directory: &Path, account_path: &str, out: &mut Vec<Value>) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                visit(&path, account_path, out);
                continue;
            }
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if !name.ends_with(".db") {
                continue;
            }
            let full = path.to_string_lossy().replace('/', "\\");
            let wal = format!("{full}-wal");
            let relative = path
                .strip_prefix(account_path)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace(['/', '\\'], "/");
            out.push(json!({
                "$object": "ShardFile",
                "attrs": {
                    "id": relative,
                    "path": full,
                    "wal_path": if Path::new(&wal).exists() { Some(wal) } else { None },
                }
            }));
        }
    }

    let mut shards = Vec::new();
    visit(Path::new(account_path), account_path, &mut shards);
    shards.sort_by(|a, b| {
        a["attrs"]["path"]
            .as_str()
            .unwrap_or_default()
            .cmp(b["attrs"]["path"].as_str().unwrap_or_default())
    });
    shards
}
