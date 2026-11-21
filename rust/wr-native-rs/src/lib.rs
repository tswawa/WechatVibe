//! Rust port of `wr/service.py`'s `NativeService` in fixture mode.
//!
//! Fixture mode drives exactly the same query / pagination / snapshot code as live mode but takes
//! plaintext SQLite images from a manifest instead of scanning a running WeChat process. That makes
//! it the only part of the service layer whose input/output can be differentially proved.
//!
//! Live-mode entry points (`_refresh_live_accounts`, `_connect_live`, window methods) are explicitly
//! out of scope: they depend on a live desktop and cannot be replayed.

#![forbid(unsafe_code)]
#![allow(dead_code)] // composed crate: individual modules expose helpers used by their source crate

pub mod core;
pub mod crypto;
pub mod database;
pub mod fixture;
pub mod protocol;
pub mod snapshot;
pub mod wal;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

pub type PortError = (String, String);

fn protocol_error(code: &str, message: &str) -> PortError {
    (code.to_string(), message.to_string())
}

fn text(v: &Value, key: &str) -> String {
    v.get("attrs")
        .unwrap_or(v)
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn opt_text(v: &Value, key: &str) -> Option<String> {
    match v.get("attrs").unwrap_or(v).get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn bytes_of(v: &Value) -> Option<Vec<u8>> {
    let arr = v.get("$bytes")?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for b in arr {
        out.push(u8::try_from(b.as_u64()?).ok()?);
    }
    Some(out)
}

#[derive(Clone)]
struct AccountState {
    id: String,
    name: String,
    state: String,
    message: String,
    username: Option<String>,
    shards: Vec<Value>,
    contacts: Vec<Value>,
}

/// Port of `NativeService` (fixture path).
pub struct NativeService {
    store: snapshot::SnapshotStore,
    accounts: IndexMap<String, AccountState>,
    account_id: Option<String>,
    store_handle: Option<database::ContactStore>,
    state: String,
    message: String,
    snapshots: IndexMap<String, Value>,
    records: IndexMap<String, Record>,
}

struct Record {
    username: String,
    cutoff: i64,
    total: i64,
    store: database::ContactStore,
}

impl NativeService {
    /// Port of `NativeService.__init__` for fixture mode.
    pub fn new(cache_dir: &str, fixture_manifest: Option<&str>) -> Result<Self, PortError> {
        let store = snapshot::SnapshotStore::new(cache_dir)?;
        let mut accounts = IndexMap::new();
        if let Some(path) = fixture_manifest {
            let fixture_accounts = fixture::load_fixture(path.to_string())
                .map_err(|message| protocol_error("load_fixture_error", &message))?;
            for account in fixture_accounts {
                let id = text(&account, "id");
                let attrs = account.get("attrs").unwrap_or(&account);
                let entry = AccountState {
                    id: id.clone(),
                    name: text(&account, "name"),
                    state: "available".to_string(),
                    message: String::new(),
                    username: opt_text(&account, "username"),
                    shards: attrs
                        .get("shards")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                    contacts: attrs
                        .get("contacts")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                };
                accounts.insert(id, entry);
            }
        }
        Ok(NativeService {
            store,
            accounts,
            account_id: None,
            store_handle: None,
            state: "select_account".to_string(),
            message: "请选择账号".to_string(),
            snapshots: IndexMap::new(),
            records: IndexMap::new(),
        })
    }

    fn require_ready(&self) -> Result<(), PortError> {
        if (self.state != "ready" && self.state != "paused")
            || self.store_handle.is_none()
            || self.account_id.is_none()
        {
            return Err(protocol_error("not_connected", "not connected"));
        }
        Ok(())
    }

    fn account_status(&self) -> Value {
        let accounts: Vec<Value> = self
            .accounts
            .values()
            .map(|account| {
                let mut entry = Map::new();
                entry.insert("id".to_string(), Value::String(account.id.clone()));
                entry.insert("name".to_string(), Value::String(account.name.clone()));
                entry.insert("state".to_string(), Value::String(account.state.clone()));
                if !account.message.is_empty() {
                    entry.insert(
                        "message".to_string(),
                        Value::String(account.message.clone()),
                    );
                }
                Value::Object(entry)
            })
            .collect();
        json!({
            "state": self.state,
            "message": self.message,
            "accounts": accounts,
            "accountId": self.account_id,
        })
    }

    /// Port of `hello`.
    pub fn hello(&self) -> Value {
        json!({ "protocolVersion": 1, "mode": "fixture" })
    }

    /// Port of `status` / `accounts_method` (fixture mode never refreshes from processes).
    pub fn status(&self) -> Value {
        self.account_status()
    }

    pub fn accounts_method(&self) -> Value {
        json!(
            self.accounts
                .values()
                .map(|account| {
                    let mut entry = Map::new();
                    entry.insert("id".to_string(), Value::String(account.id.clone()));
                    entry.insert("name".to_string(), Value::String(account.name.clone()));
                    entry.insert("state".to_string(), Value::String(account.state.clone()));
                    if !account.message.is_empty() {
                        entry.insert(
                            "message".to_string(),
                            Value::String(account.message.clone()),
                        );
                    }
                    Value::Object(entry)
                })
                .collect::<Vec<Value>>()
        )
    }

    fn build_store(&self, account: &AccountState) -> Result<database::ContactStore, PortError> {
        let mut shards = Vec::new();
        for spec in &account.shards {
            let shard_id = text(spec, "id");
            let image = bytes_of(
                spec.get("attrs")
                    .unwrap_or(spec)
                    .get("image")
                    .unwrap_or(&Value::Null),
            )
            .ok_or_else(|| protocol_error("read_error", "fixture shard unreadable"))?;
            shards.push(database::SqliteShard::new(
                &shard_id,
                &image,
                &account.id,
                account.username.as_deref(),
            )?);
        }
        let mut contact_ids = IndexMap::new();
        let mut contact_meta: IndexMap<String, Map<String, Value>> = IndexMap::new();
        for contact in &account.contacts {
            let username = text(contact, "username");
            contact_ids.insert(username.clone(), text(contact, "id"));
            let mut meta = Map::new();
            meta.insert("name".to_string(), Value::String(text(contact, "name")));
            meta.insert(
                "kind".to_string(),
                Value::String(core::map_kind(&text(contact, "kind")).to_string()),
            );
            contact_meta.insert(username, meta);
        }
        Ok(database::ContactStore::with_meta(
            &account.id,
            shards,
            contact_ids,
            contact_meta,
        ))
    }

    /// Port of `connect` / `_connect_fixture`.
    pub fn connect(&mut self, params: &Value) -> Result<Value, PortError> {
        let requested = params.get("accountId").cloned().unwrap_or(Value::Null);
        let id = if requested.is_null() {
            if self.accounts.len() != 1 {
                return Err(protocol_error(
                    "select_account",
                    "multiple accounts require explicit selection",
                ));
            }
            self.accounts.keys().next().cloned().unwrap_or_default()
        } else {
            let id = requested.as_str().unwrap_or_default().to_string();
            if !self.accounts.contains_key(&id) {
                return Err(protocol_error("not_found", "unknown account"));
            }
            id
        };
        let account = self.accounts.get(&id).expect("checked above").clone();
        let store = self.build_store(&account)?;
        self.store_handle = Some(store);
        self.account_id = Some(account.id);
        self.state = "ready".to_string();
        self.message = "fixture ready".to_string();
        Ok(self.account_status())
    }

    /// Port of `contacts`.
    pub fn contacts(&self, params: &Value) -> Result<Value, PortError> {
        self.require_ready()?;
        if let Some(id) = params.get("accountId").and_then(Value::as_str)
            && id != self.account_id.as_deref().unwrap_or_default()
        {
            return Err(protocol_error("bad_request", "account mismatch"));
        }
        Ok(json!(
            self.store_handle.as_ref().expect("ready").contacts()?
        ))
    }

    /// Port of `latest`.
    pub fn latest(&mut self, params: &Value) -> Result<Value, PortError> {
        self.require_ready()?;
        if let Some(id) = params.get("accountId").and_then(Value::as_str)
            && id != self.account_id.as_deref().unwrap_or_default()
        {
            return Err(protocol_error("bad_request", "account mismatch"));
        }
        let contact_id = params
            .get("contactId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| protocol_error("bad_request", "contactId required"))?;
        let username = self
            .store_handle
            .as_ref()
            .expect("ready")
            .username_for(contact_id)
            .ok_or_else(|| protocol_error("not_found", "contact not found"))?;
        let limit = core::int_param(
            params.get("limit").unwrap_or(&Value::Null),
            120,
            1,
            200,
            "limit",
        )?;
        let rows = self
            .store_handle
            .as_mut()
            .expect("ready")
            .latest(&username, limit)?;
        Ok(json!({ "rows": rows }))
    }

    /// Port of `close`.
    pub fn close(&mut self) -> Value {
        self.store_handle = None;
        self.snapshots.clear();
        self.records.clear();
        json!({ "closed": true })
    }
}

/// Port of `encode_cursor`.
pub fn encode_cursor(cursor: Option<(i64, String, i64)>) -> Value {
    match cursor {
        None => Value::Null,
        Some((sort, shard, local)) => json!({
            "sortSeq": sort.to_string(),
            "shardId": shard,
            "localId": local.to_string(),
        }),
    }
}

/// Port of `decode_cursor`.
pub fn decode_cursor(raw: &Value) -> Result<Option<(i64, String, i64)>, PortError> {
    if raw.is_null() {
        return Ok(None);
    }
    let map = raw
        .as_object()
        .ok_or_else(|| protocol_error("bad_request", "cursor must be an object"))?;
    let number = |key: &str| -> Result<i64, PortError> {
        let value = map
            .get(key)
            .ok_or_else(|| protocol_error("bad_request", "invalid cursor"))?;
        let text = match value {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        text.trim()
            .parse::<i64>()
            .map_err(|_| protocol_error("bad_request", "invalid cursor"))
    };
    let shard = map
        .get("shardId")
        .ok_or_else(|| protocol_error("bad_request", "invalid cursor"))?;
    Ok(Some((
        number("sortSeq")?,
        match shard {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        },
        number("localId")?,
    )))
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Python `repr()` of the fingerprint tuple the fixture path builds: `((sid, hex), ...)`.
fn fingerprint_repr(parts: &[(String, String)]) -> String {
    if parts.is_empty() {
        return "()".to_string();
    }
    let items: Vec<String> = parts
        .iter()
        .map(|(sid, digest)| format!("('{}', '{}')", sid, digest))
        .collect();
    if items.len() == 1 {
        format!("({},)", items[0])
    } else {
        format!("({})", items.join(", "))
    }
}

impl NativeService {
    fn dataset_id(&self, cutoff: i64, fingerprint: &[(String, String)]) -> String {
        let basis = format!(
            "{}\u{0}{}\u{0}fixture\u{0}{}",
            self.account_id.as_deref().unwrap_or_default(),
            cutoff,
            fingerprint_repr(fingerprint)
        );
        sha256_hex(basis.as_bytes())[..32].to_string()
    }

    fn capture_dataset(&self, cutoff: i64) -> Result<String, PortError> {
        let account_id = self.account_id.as_deref().unwrap_or_default();
        let account = self
            .accounts
            .get(account_id)
            .ok_or_else(|| protocol_error("not_connected", "not connected"))?;
        let mut blobs: Vec<(String, Vec<u8>)> = Vec::new();
        for spec in &account.shards {
            let id = text(spec, "id");
            let image = bytes_of(
                spec.get("attrs")
                    .unwrap_or(spec)
                    .get("image")
                    .unwrap_or(&Value::Null),
            )
            .ok_or_else(|| protocol_error("read_error", "fixture shard unreadable"))?;
            blobs.push((id, image));
        }
        let fingerprint: Vec<(String, String)> = blobs
            .iter()
            .map(|(id, image)| (id.clone(), sha256_hex(image)))
            .collect();
        let dataset_id = self.dataset_id(cutoff, &fingerprint);
        let shard_meta: Vec<Value> = blobs
            .iter()
            .map(|(id, _)| json!({ "shardId": id, "hasWal": false }))
            .collect();
        let stored: Vec<Value> = blobs
            .iter()
            .map(|(id, image)| json!([format!("{id}#db"), { "$bytes": image }]))
            .collect();
        let meta = json!({
            "accountId": account_id,
            "mode": "fixture",
            "cutoffTime": cutoff,
            "shards": shard_meta,
        });
        let payload = self
            .store
            .create_dataset(&json!(dataset_id), &meta, &stored)?;
        let _ = payload;
        Ok(dataset_id)
    }

    fn record_from_meta(&mut self, meta: &Value) -> Result<Record, PortError> {
        let dataset_id = meta
            .get("datasetId")
            .and_then(Value::as_str)
            .ok_or_else(|| protocol_error("snapshot_error", "dataset id missing"))?;
        let snapshot_id = meta
            .get("snapshotId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let dataset_meta = self.store.load_dataset_meta(&json!(dataset_id))?;
        let shards_meta = dataset_meta
            .get("shards")
            .and_then(Value::as_array)
            .ok_or_else(|| protocol_error("snapshot_error", "dataset shards missing"))?;
        let mut shard_values: Vec<Value> = Vec::new();
        for entry in shards_meta {
            let id = entry
                .get("shardId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let image = self
                .store
                .load_dataset_blob(&json!(dataset_id), &json!(format!("{id}#db")))?;
            shard_values.push(json!({
                "$object": "FixtureShard",
                "attrs": { "id": id, "image": image },
            }));
        }
        let account_id = meta
            .get("accountId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let username = meta
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let self_username = meta
            .get("selfUsername")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let mut shards = Vec::new();
        for spec in &shard_values {
            let raw = spec
                .get("attrs")
                .unwrap_or(spec)
                .get("image")
                .unwrap_or(&Value::Null);
            let image = bytes_of(raw)
                .or_else(|| {
                    raw.as_array().map(|items| {
                        items
                            .iter()
                            .filter_map(|b| b.as_u64())
                            .map(|b| b as u8)
                            .collect()
                    })
                })
                .ok_or_else(|| protocol_error("read_error", "dataset blob unreadable"))?;
            shards.push(database::SqliteShard::new(
                &text(spec, "id"),
                &image,
                &account_id,
                self_username,
            )?);
        }
        let mut contact_ids = IndexMap::new();
        let mut contact_meta: IndexMap<String, Map<String, Value>> = IndexMap::new();
        if let Some(map) = meta.get("contactIds").and_then(Value::as_object) {
            for (key, value) in map {
                contact_ids.insert(key.clone(), value.as_str().unwrap_or_default().to_string());
            }
        }
        if let Some(map) = meta.get("contactMeta").and_then(Value::as_object) {
            for (key, value) in map {
                if let Some(entry) = value.as_object() {
                    let mut m = Map::new();
                    for (k, v) in entry {
                        m.insert(k.clone(), v.clone());
                    }
                    contact_meta.insert(key.clone(), m);
                }
            }
        }
        let store =
            database::ContactStore::with_meta(&account_id, shards, contact_ids, contact_meta);
        let total = meta.get("total").and_then(Value::as_i64).unwrap_or(0);
        let cutoff = meta.get("cutoffTime").and_then(Value::as_i64).unwrap_or(0);
        let _ = snapshot_id;
        Ok(Record {
            username,
            cutoff,
            total,
            store,
        })
    }

    fn remember(&mut self, snapshot_id: String, record: Record) {
        self.records.insert(snapshot_id, record);
    }

    /// Port of `open_history`.
    pub fn open_history(&mut self, params: &Value) -> Result<Value, PortError> {
        self.require_ready()?;
        if params.get("accountId").and_then(Value::as_str) != self.account_id.as_deref() {
            return Err(protocol_error("bad_request", "account mismatch"));
        }
        let contact_id = params
            .get("contactId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| protocol_error("bad_request", "contactId required"))?;
        if let Some(existing) = params.get("snapshotId").and_then(Value::as_str) {
            let meta = self.store.load_meta(&json!(existing))?;
            if meta.get("accountId").and_then(Value::as_str) != self.account_id.as_deref() {
                return Err(protocol_error(
                    "snapshot_error",
                    "snapshot account mismatch",
                ));
            }
            if meta.get("contactId").and_then(Value::as_str) != Some(contact_id) {
                return Err(protocol_error(
                    "snapshot_error",
                    "snapshot contact mismatch",
                ));
            }
            let record = self.record_from_meta(&meta)?;
            let high = record.store.last_key(&record.username, record.cutoff)?;
            let sid = existing.to_string();
            self.remember(sid.clone(), record);
            return Ok(json!({
                "snapshotId": sid,
                "total": self.records[&sid].total,
                "cursor": null,
                "highWatermark": encode_cursor(high),
            }));
        }
        let username = self
            .store_handle
            .as_ref()
            .expect("ready")
            .username_for(contact_id)
            .ok_or_else(|| protocol_error("not_found", "contact not found"))?;
        let cutoff = match params.get("cutoffTime") {
            None | Some(Value::Null) => 1i64 << 62,
            Some(value) => value
                .as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .or_else(|| value.as_i64())
                .ok_or_else(|| protocol_error("bad_request", "invalid cutoff"))?,
        };
        let total = self
            .store_handle
            .as_ref()
            .expect("ready")
            .total(&username, cutoff)?;
        let dataset_id = self.capture_dataset(cutoff)?;
        let contact_ids: Map<String, Value> = self
            .store_handle
            .as_ref()
            .expect("ready")
            .usernames()
            .into_iter()
            .map(|u| {
                let id = self
                    .store_handle
                    .as_ref()
                    .expect("ready")
                    .contact_id_for(&u);
                (u, Value::String(id))
            })
            .collect();
        let contact_meta = self
            .store_handle
            .as_ref()
            .expect("ready")
            .contact_meta_json();
        let meta = json!({
            "accountId": self.account_id,
            "contactId": contact_id,
            "username": username,
            "cutoffTime": cutoff,
            "total": total,
            "mode": "fixture",
            "datasetId": dataset_id,
            "selfUsername": self
                .accounts
                .get(self.account_id.as_deref().unwrap_or_default())
                .and_then(|a| a.username.clone())
                .map(Value::String)
                .unwrap_or(Value::Null),
            "contactIds": contact_ids,
            "contactMeta": contact_meta,
        });
        let payload = self.store.create_snapshot(&meta)?;
        let record = self.record_from_meta(&payload)?;
        let high = record.store.last_key(&record.username, record.cutoff)?;
        let sid = payload
            .get("snapshotId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.remember(sid.clone(), record);
        Ok(json!({
            "snapshotId": sid,
            "total": total,
            "cursor": null,
            "highWatermark": encode_cursor(high),
        }))
    }

    fn snapshot_record(&mut self, snapshot_id: &str) -> Result<&mut Record, PortError> {
        if !self.records.contains_key(snapshot_id) {
            let meta = self.store.load_meta(&json!(snapshot_id))?;
            if meta.get("accountId").and_then(Value::as_str) != self.account_id.as_deref() {
                return Err(protocol_error(
                    "snapshot_error",
                    "snapshot account mismatch",
                ));
            }
            let record = self.record_from_meta(&meta)?;
            self.remember(snapshot_id.to_string(), record);
        }
        Ok(self.records.get_mut(snapshot_id).expect("cached"))
    }

    /// Port of `read_history`.
    pub fn read_history(&mut self, params: &Value) -> Result<Value, PortError> {
        self.require_ready()?;
        let snapshot_id = params
            .get("snapshotId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| protocol_error("bad_request", "snapshotId required"))?;
        let limit = core::int_param(
            params.get("limit").unwrap_or(&Value::Null),
            200,
            1,
            500,
            "limit",
        )?;
        let context_limit = core::int_param(
            params.get("contextLimit").unwrap_or(&Value::Null),
            0,
            0,
            32,
            "contextLimit",
        )?;
        let cursor = decode_cursor(params.get("cursor").unwrap_or(&Value::Null))?;
        let record = self.snapshot_record(snapshot_id)?;
        let (rows, next, done) =
            record
                .store
                .page(&record.username, record.cutoff, cursor.clone(), limit)?;
        let context = match cursor {
            None => Vec::new(),
            Some(cursor) => record.store.context_before(
                &record.username,
                record.cutoff,
                cursor,
                context_limit,
                true,
            )?,
        };
        Ok(json!({
            "rows": rows,
            "context": context,
            "nextCursor": encode_cursor(next),
            "done": done,
            "total": record.total,
        }))
    }
}

fn row_key(row: &Value) -> (i64, String, i64) {
    let number = |key: &str| -> i64 {
        match row.get(key) {
            Some(Value::String(s)) => s.parse::<i64>().unwrap_or(0),
            Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
            _ => 0,
        }
    };
    (
        number("sortSeq"),
        row.get("shardId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        number("localId"),
    )
}

impl NativeService {
    /// Port of `read_incremental`.
    pub fn read_incremental(&mut self, params: &Value) -> Result<Value, PortError> {
        self.require_ready()?;
        if let Some(id) = params.get("accountId").and_then(Value::as_str)
            && id != self.account_id.as_deref().unwrap_or_default()
        {
            return Err(protocol_error("bad_request", "account mismatch"));
        }
        let contact_id = params
            .get("contactId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| protocol_error("bad_request", "contactId required"))?;
        let limit = core::int_param(
            params.get("limit").unwrap_or(&Value::Null),
            120,
            1,
            500,
            "limit",
        )?;
        let context_limit = core::int_param(
            params.get("contextLimit").unwrap_or(&Value::Null),
            0,
            0,
            32,
            "contextLimit",
        )?;
        let overlap_limit = core::int_param(
            params.get("overlapLimit").unwrap_or(&Value::Null),
            0,
            0,
            120,
            "overlapLimit",
        )?;
        let username = self
            .store_handle
            .as_ref()
            .expect("ready")
            .username_for(contact_id)
            .ok_or_else(|| protocol_error("not_found", "contact not found"))?;
        let cursor = decode_cursor(params.get("cursor").unwrap_or(&Value::Null))?;
        let store = self.store_handle.as_mut().expect("ready");

        if cursor.is_none() {
            let rows = store.latest(&username, limit)?;
            let (context, next_cursor) = if let (Some(first), Some(last)) =
                (rows.first(), rows.last())
            {
                let first_key = row_key(first);
                let last_key = row_key(last);
                (
                    store.context_before(&username, 1 << 62, first_key, context_limit, false)?,
                    Some(last_key),
                )
            } else {
                (Vec::new(), None)
            };
            return Ok(json!({
                "rows": rows,
                "context": context,
                "nextCursor": encode_cursor(next_cursor),
                "done": true,
            }));
        }

        let cursor = cursor.expect("checked");
        let (after, _next, done) = store.page(&username, 1 << 62, Some(cursor.clone()), limit)?;
        let next_cursor = after.last().map(row_key).unwrap_or(cursor.clone());
        let overlap = if overlap_limit > 0 {
            store.context_before(&username, 1 << 62, cursor, overlap_limit, true)?
        } else {
            Vec::new()
        };
        let mut rows = overlap;
        rows.extend(after);
        let context = match rows.first() {
            Some(first) => {
                store.context_before(&username, 1 << 62, row_key(first), context_limit, false)?
            }
            None => Vec::new(),
        };
        Ok(json!({
            "rows": rows,
            "context": context,
            "nextCursor": encode_cursor(Some(next_cursor)),
            "done": done,
        }))
    }
}
