//! Rust port of `wr/snapshot.py`: ciphertext dataset + snapshot metadata store.
//!
//! Writes are atomic (`path.tmp` then rename). Blob names use a hash of the shard id, so ids with
//! path separators cannot escape the directory.
//!
//! Proved by differential replay (`tools/compare.py`): the same initial directory is copied into
//! two trees, Python and Rust run the same ops, then both return values and the resulting file
//! trees are compared. `uuid4` ids are normalised by the harness.

#![forbid(unsafe_code)]

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

pub type PortError = (String, String);

fn protocol_error(code: &str, message: &str) -> PortError {
    (code.to_string(), message.to_string())
}

/// Port of `_safe_id` (`ID_PATTERN = ^[A-Za-z0-9._-]{1,64}$`).
pub fn safe_id(value: &Value, what: &str) -> Result<String, PortError> {
    let Some(text) = value.as_str() else {
        return Err(("snapshot_error".to_string(), format!("invalid {what} id")));
    };
    if text.is_empty()
        || text.len() > 64
        || !text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(("snapshot_error".to_string(), format!("invalid {what} id")));
    }
    Ok(text.to_string())
}

/// Port of `blob_digest`.
pub fn blob_digest(shard_id: &str) -> String {
    let digest = Sha256::digest(shard_id.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..32].to_string()
}

fn abspath(raw: &str) -> PathBuf {
    let path = Path::new(raw);
    let joined = if path.is_absolute() {
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
    out
}

/// Python's `json.dumps(x, ensure_ascii=False)` — spaces after `,` and `:`.
fn python_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => python_string(s),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(python_json).collect();
            format!("[{}]", parts.join(", "))
        }
        Value::Object(map) => {
            let parts: Vec<String> = map
                .iter()
                .map(|(k, v)| format!("{}: {}", python_string(k), python_json(v)))
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
    }
}

/// Python escapes controls, quote and backslash, but keeps non-ASCII as UTF-8.
fn python_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub struct SnapshotStore {
    directory: PathBuf,
}

impl SnapshotStore {
    /// Port of `SnapshotStore.__init__`.
    pub fn new(directory: &str) -> Result<Self, PortError> {
        let directory = abspath(directory);
        std::fs::create_dir_all(&directory)
            .map_err(|_| protocol_error("snapshot_error", "cannot create directory"))?;
        Ok(SnapshotStore { directory })
    }

    fn dataset_path(&self, dataset_id: &Value) -> Result<PathBuf, PortError> {
        Ok(self
            .directory
            .join(format!("{}.dataset.json", safe_id(dataset_id, "dataset")?)))
    }

    fn snapshot_path(&self, snapshot_id: &Value) -> Result<PathBuf, PortError> {
        Ok(self
            .directory
            .join(format!("{}.meta.json", safe_id(snapshot_id, "snapshot")?)))
    }

    fn blob_path(&self, dataset_id: &Value, shard_id: &Value) -> Result<PathBuf, PortError> {
        let dataset_id = safe_id(dataset_id, "dataset")?;
        let shard_id = shard_id.as_str().unwrap_or_default();
        Ok(self
            .directory
            .join(format!("{dataset_id}.{}.bin", blob_digest(shard_id))))
    }

    fn write_atomic(path: &Path, data: &[u8]) -> Result<(), PortError> {
        // The original writes to `<path>.tmp` (e.g. `x.meta.json.tmp`).
        let mut tmp = path.as_os_str().to_os_string();
        tmp.push(".tmp");
        let temporary = PathBuf::from(tmp);
        std::fs::write(&temporary, data)
            .map_err(|_| protocol_error("snapshot_error", "cannot write"))?;
        std::fs::rename(&temporary, path)
            .map_err(|_| protocol_error("snapshot_error", "cannot write"))?;
        Ok(())
    }

    /// Port of `has_dataset`.
    pub fn has_dataset(&self, dataset_id: &Value) -> Result<bool, PortError> {
        Ok(self.dataset_path(dataset_id)?.is_file())
    }

    /// Port of `create_dataset`.
    pub fn create_dataset(
        &self,
        dataset_id: &Value,
        meta: &Value,
        blobs: &[Value],
    ) -> Result<Value, PortError> {
        let dataset_id = safe_id(dataset_id, "dataset")?;
        let id_value = json!(dataset_id);
        for pair in blobs {
            let pair = pair
                .as_array()
                .ok_or_else(|| protocol_error("snapshot_error", "invalid blob"))?;
            let shard_id = pair.first().cloned().unwrap_or(Value::Null);
            let raw = pair.get(1).cloned().unwrap_or(Value::Null);
            let decoded: Vec<u8> = if let Some(text) = raw.as_str() {
                text.as_bytes().to_vec()
            } else if let Some(array) = raw.get("$bytes").and_then(Value::as_array) {
                array
                    .iter()
                    .filter_map(|b| b.as_u64())
                    .map(|b| b as u8)
                    .collect()
            } else {
                return Err(protocol_error("snapshot_error", "invalid blob"));
            };
            let path = self.blob_path(&id_value, &shard_id)?;
            if !path.is_file() {
                Self::write_atomic(&path, &decoded)?;
            }
        }
        let mut payload = meta
            .as_object()
            .cloned()
            .ok_or_else(|| protocol_error("snapshot_error", "meta must be an object"))?;
        payload.insert("datasetId".to_string(), Value::String(dataset_id));
        let value = Value::Object(payload);
        Self::write_atomic(
            &self.dataset_path(&id_value)?,
            python_json(&value).as_bytes(),
        )?;
        Ok(value)
    }

    /// Port of `load_dataset_meta`.
    pub fn load_dataset_meta(&self, dataset_id: &Value) -> Result<Value, PortError> {
        let path = self.dataset_path(dataset_id)?;
        if !path.is_file() {
            return Err(protocol_error("not_found", "dataset not found"));
        }
        let text = std::fs::read_to_string(path)
            .map_err(|_| protocol_error("snapshot_error", "dataset unreadable"))?;
        serde_json::from_str(&text)
            .map_err(|_| protocol_error("snapshot_error", "dataset unreadable"))
    }

    /// Port of `load_dataset_blob`.
    pub fn load_dataset_blob(
        &self,
        dataset_id: &Value,
        shard_id: &Value,
    ) -> Result<Value, PortError> {
        let path = self.blob_path(dataset_id, shard_id)?;
        let bytes = std::fs::read(&path).map_err(|e| {
            protocol_error(
                "snapshot_error",
                &format!("dataset blob unreadable {}: {e}", path.display()),
            )
        })?;
        Ok(Value::Array(bytes.into_iter().map(|b| json!(b)).collect()))
    }

    /// Port of `create_snapshot`. The id is returned so the caller can use it in later ops.
    pub fn create_snapshot(&self, meta: &Value) -> Result<Value, PortError> {
        let snapshot_id = uuid::Uuid::new_v4().simple().to_string();
        let mut payload = meta
            .as_object()
            .cloned()
            .ok_or_else(|| protocol_error("snapshot_error", "meta must be an object"))?;
        payload.insert("snapshotId".to_string(), Value::String(snapshot_id));
        let value = Value::Object(payload);
        Self::write_atomic(
            &self.snapshot_path(&value["snapshotId"])?,
            python_json(&value).as_bytes(),
        )?;
        Ok(value)
    }

    /// Port of `load_meta`.
    pub fn load_meta(&self, snapshot_id: &Value) -> Result<Value, PortError> {
        let path = self.snapshot_path(snapshot_id)?;
        if !path.is_file() {
            return Err(protocol_error("not_found", "snapshot not found"));
        }
        let text = std::fs::read_to_string(path)
            .map_err(|_| protocol_error("snapshot_error", "snapshot unreadable"))?;
        serde_json::from_str(&text)
            .map_err(|_| protocol_error("snapshot_error", "snapshot unreadable"))
    }

    /// Port of `prune_datasets`.
    pub fn prune_datasets(&self, max_datasets: i64) -> Result<(), PortError> {
        let mut entries: Vec<String> = match std::fs::read_dir(&self.directory) {
            Ok(read_dir) => read_dir
                .filter_map(Result::ok)
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.ends_with(".dataset.json"))
                .collect(),
            Err(_) => return Ok(()),
        };
        if (entries.len() as i64) <= max_datasets {
            return Ok(());
        }
        let mut referenced: Vec<String> = Vec::new();
        if let Ok(read_dir) = std::fs::read_dir(&self.directory) {
            for entry in read_dir.filter_map(Result::ok) {
                let name = match entry.file_name().into_string() {
                    Ok(name) => name,
                    Err(_) => continue,
                };
                if !name.ends_with(".meta.json") {
                    continue;
                }
                if let Ok(text) = std::fs::read_to_string(entry.path())
                    && let Ok(value) = serde_json::from_str::<Value>(&text)
                    && let Some(id) = value.get("datasetId").and_then(Value::as_str)
                {
                    referenced.push(id.to_string());
                }
            }
        }
        const SUFFIX: &str = ".dataset.json";
        entries.sort_by_key(|name| {
            std::fs::metadata(self.directory.join(name))
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        });
        let mut removed = 0usize;
        let prunable_count = (entries.len() as i64 - max_datasets) as usize;
        for name in entries {
            if removed >= prunable_count {
                break;
            }
            let dataset_id = name[..name.len() - SUFFIX.len()].to_string();
            if referenced.iter().any(|id| id == &dataset_id) {
                continue;
            }
            if std::fs::remove_file(self.directory.join(&name)).is_err() {
                continue;
            }
            removed += 1;
            if let Ok(read_dir) = std::fs::read_dir(&self.directory) {
                for other in read_dir.filter_map(Result::ok) {
                    let other_name = match other.file_name().into_string() {
                        Ok(name) => name,
                        Err(_) => continue,
                    };
                    if other_name.starts_with(&format!("{dataset_id}."))
                        && other_name.ends_with(".bin")
                    {
                        let _ = std::fs::remove_file(other.path());
                    }
                }
            }
        }
        Ok(())
    }
}
