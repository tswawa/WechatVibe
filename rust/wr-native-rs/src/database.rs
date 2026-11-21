//! Rust port of `wr/database.py`'s `SqliteShard`: the read-only query layer over one decrypted
//! message shard.
//!
//! The Python class cannot cross the pyo3 bridge (its boundary is a live `sqlite3` connection), so
//! it is proved against a golden set instead: `tools/build-golden.py` records the original's
//! answers on a fixture image, `src/main.rs` replays the same ops and `cargo test` compares them.
//!
//! Everything observable is reproduced on purpose: column-name fallbacks, the
//! seconds-or-milliseconds time normalisation, `unknown` side when the sender is absent from
//! `Name2Id`, and the keyset/before predicates that depend on how the shard id sorts.

#![forbid(unsafe_code)]

use indexmap::IndexMap;
use md5::Md5;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const SECONDS_MAX: i128 = 100_000_000_000;
const KIND_TEXT: &str = "text";
const KIND_NON_TEXT: &str = "nontext";
const KIND_SYSTEM: &str = "system";
const SYSTEM_TYPES: [i64; 2] = [10_000, 10_002];
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

pub type PortError = (String, String);
/// Composite keyset cursor: `(sortSeq, shardId, localId)`.
pub type PageCursor = (i64, String, i64);
/// `page()` returns its rows, the cursor to continue from, and whether this was the last page.
pub type PageResult = (Vec<Value>, Option<PageCursor>, bool);

fn protocol_error(code: &str, message: &str) -> PortError {
    (code.to_string(), message.to_string())
}

// ---------------------------------------------------------------------------- pure helpers

/// Port of `md5_username`.
pub fn md5_username(username: &str) -> String {
    format!("{:x}", Md5::digest(username.as_bytes()))
}

/// Port of `message_id_for`.
pub fn message_id_for(account_id: &str, username: &str, shard_id: &str, local_id: i64) -> String {
    let basis = format!("{account_id}\u{0}{username}\u{0}{shard_id}\u{0}l{local_id}");
    let digest = Sha256::digest(basis.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..32].to_string()
}

/// Port of `classify_kind`.
fn classify_kind(local_type: i64) -> &'static str {
    if SYSTEM_TYPES.contains(&local_type) {
        return KIND_SYSTEM;
    }
    if local_type == 1 {
        return KIND_TEXT;
    }
    KIND_NON_TEXT
}

/// Port of `normalize_time` for the values SQLite hands back (int, float, str or NULL).
fn normalize_time(value: Option<&Value>) -> i64 {
    let Some(value) = value else { return 0 };
    let number = match value {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f.trunc() as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    };
    let Some(number) = number else { return 0 };
    if number <= 0 {
        return 0;
    }
    if (number as i128) < SECONDS_MAX {
        number * 1000
    } else {
        number
    }
}

/// Port of `extract_text`: exact text, or `None` when the body cannot be decoded faithfully.
fn extract_text(body: Option<&Value>, compress: Option<&Value>) -> Option<String> {
    let as_bytes = |v: Option<&Value>| -> Option<Vec<u8>> {
        let v = v?;
        match v {
            Value::String(s) if !s.is_empty() => Some(s.as_bytes().to_vec()),
            Value::String(_) => None,
            Value::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(u8::try_from(item.as_u64()?).ok()?);
                }
                Some(out)
            }
            _ => None,
        }
    };

    let mut raw = as_bytes(body);
    if raw.is_none() {
        raw = as_bytes(compress);
    }
    let Some(raw) = raw else {
        return Some(String::new());
    };
    let raw = if raw.len() >= 4 && raw[..4] == ZSTD_MAGIC {
        match zstd::decode_all(raw.as_slice()) {
            Ok(decoded) => decoded,
            Err(_) => return None,
        }
    } else {
        raw
    };
    String::from_utf8(raw).ok()
}

fn first_existing(columns: &[String], candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find(|c| columns.iter().any(|col| col == *c))
        .map(|c| (*c).to_string())
}

fn sql_value(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Value> {
    use rusqlite::types::ValueRef;
    Ok(match row.get_ref(index)? {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Value::Array(bytes.iter().map(|b| json!(*b)).collect()),
    })
}

/// Python `int(value or 0)` for a SQLite value.
fn int_or_zero(value: Option<&Value>) -> i64 {
    let Some(value) = value else { return 0 };
    match value {
        Value::Null => 0,
        Value::Bool(b) => i64::from(*b),
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f.trunc() as i64))
            .unwrap_or(0),
        Value::String(s) => s.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

// ---------------------------------------------------------------------------- the shard

pub struct SqliteShard {
    conn: Connection,
    shard_id: String,
    account_id: String,
    name_to_id: IndexMap<String, i64>,
    id_to_name: IndexMap<i64, String>,
    message_tables: IndexMap<String, String>,
    columns: IndexMap<String, Vec<String>>,
    self_id: Option<i64>,
}

impl SqliteShard {
    /// Port of `SqliteShard.__init__`.
    pub fn new(
        shard_id: &str,
        image: &[u8],
        account_id: &str,
        self_username: Option<&str>,
    ) -> Result<Self, PortError> {
        // `sqlite3.Connection.deserialize` needs a real file handle through rusqlite; the image is
        // written to a scratch file and opened read-only. Same engine, same results.
        let mut path = std::env::temp_dir();
        path.push(format!(
            "wr-query-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&path, image)
            .map_err(|_| protocol_error("unsupported_schema", "sqlite deserialize failed"))?;
        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| protocol_error("unsupported_schema", "sqlite deserialize failed"))?;
        let _ = std::fs::remove_file(&path);

        let mut shard = SqliteShard {
            conn,
            shard_id: shard_id.to_string(),
            account_id: account_id.to_string(),
            name_to_id: IndexMap::new(),
            id_to_name: IndexMap::new(),
            message_tables: IndexMap::new(),
            columns: IndexMap::new(),
            self_id: None,
        };
        shard.discover()?;
        if let Some(username) = self_username
            && !username.is_empty()
            && let Some(id) = shard.name_to_id.get(username)
        {
            shard.self_id = Some(*id);
        }
        Ok(shard)
    }

    fn discover(&mut self) -> Result<(), PortError> {
        let names = self.table_names()?;
        if !names.iter().any(|n| n == "Name2Id") {
            return Err(protocol_error("unsupported_schema", "Name2Id missing"));
        }
        let name_columns = self.table_columns("Name2Id")?;
        let id_column = if name_columns.iter().any(|c| c == "id") {
            "id"
        } else {
            "rowid"
        };
        let rows = self.query(&format!("SELECT {id_column}, user_name FROM Name2Id"), &[])?;
        for row in rows {
            let name = row.get(1).cloned().unwrap_or(Value::Null);
            if name.is_null() {
                continue;
            }
            let id = int_or_zero(row.first());
            self.name_to_id.insert(value_text(&name), id);
            self.id_to_name.insert(id, value_text(&name));
        }
        let usernames: Vec<String> = self.name_to_id.keys().cloned().collect();
        for username in usernames {
            let table = format!("Msg_{}", md5_username(&username));
            if names.contains(&table) {
                self.message_tables.insert(username.clone(), table.clone());
                self.columns
                    .insert(table.clone(), self.table_columns(&table)?);
            }
        }
        Ok(())
    }

    fn table_names(&self) -> Result<Vec<String>, PortError> {
        let rows = self.query("SELECT name FROM sqlite_master WHERE type='table'", &[])?;
        Ok(rows.iter().map(|r| value_text(&r[0])).collect())
    }

    fn table_columns(&self, table: &str) -> Result<Vec<String>, PortError> {
        let rows = self.query(&format!("PRAGMA table_info(\"{table}\")"), &[])?;
        Ok(rows.iter().map(|r| value_text(&r[1])).collect())
    }

    fn query(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<Vec<Value>>, PortError> {
        let mut stmt = self
            .conn
            .prepare(sql)
            .map_err(|_| protocol_error("unsupported_schema", "query failed"))?;
        let width = stmt.column_count();
        let mut rows = stmt
            .query(params)
            .map_err(|_| protocol_error("unsupported_schema", "query failed"))?;
        let mut out = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|_| protocol_error("unsupported_schema", "query failed"))?
        {
            let mut record = Vec::with_capacity(width);
            for index in 0..width {
                record.push(
                    sql_value(row, index)
                        .map_err(|_| protocol_error("unsupported_schema", "query failed"))?,
                );
            }
            out.push(record);
        }
        Ok(out)
    }

    // -- contact helpers ---------------------------------------------------

    /// This shard's id.
    pub fn id(&self) -> &str {
        &self.shard_id
    }

    /// Port of `usernames`.
    pub fn usernames(&self) -> Vec<String> {
        self.message_tables.keys().cloned().collect()
    }

    /// Port of `known_usernames`.
    pub fn known_usernames(&self) -> Vec<String> {
        self.name_to_id.keys().cloned().collect()
    }

    /// Port of `set_self_username`.
    pub fn set_self_username(&mut self, username: Option<&str>) -> bool {
        self.self_id = username.and_then(|u| self.name_to_id.get(u).copied());
        self.self_id.is_some()
    }

    /// Port of `has_table`.
    pub fn has_table(&self, username: &str) -> bool {
        self.message_tables.contains_key(username)
    }

    /// Port of `contact_metadata`.
    pub fn contact_metadata(&self) -> Result<Value, PortError> {
        let mut out: IndexMap<String, Map<String, Value>> = IndexMap::new();
        let mut tables = self.table_names()?;
        tables.sort();
        for table in tables {
            let Ok(columns) = self.table_columns(&table) else {
                continue;
            };
            if !columns.iter().any(|c| c == "username") {
                continue;
            }
            let Some(name_col) = first_existing(
                &columns,
                &["remark", "nick_name", "nickname", "alias", "display_name"],
            ) else {
                continue;
            };
            let Ok(rows) = self.query(
                &format!("SELECT \"username\", \"{name_col}\" FROM \"{table}\""),
                &[],
            ) else {
                continue;
            };
            for row in rows {
                let username = row.first().cloned().unwrap_or(Value::Null);
                if username.is_null() {
                    continue;
                }
                let username = value_text(&username);
                let entry = out.entry(username).or_default();
                let name = row.get(1).cloned().unwrap_or(Value::Null);
                if !name.is_null() {
                    let text = value_text(&name);
                    if !text.is_empty() {
                        entry.insert("name".to_string(), Value::String(text));
                    }
                }
            }
        }
        Ok(Value::Object(
            out.into_iter()
                .map(|(k, v)| (k, Value::Object(v)))
                .collect(),
        ))
    }

    /// Port of `count`.
    pub fn count(&self, username: &str, cutoff_ms: i64) -> Result<i64, PortError> {
        let Some(table) = self.message_tables.get(username) else {
            return Ok(0);
        };
        let time_sql = time_ms_sql(&self.time_column(table));
        let rows = self.query(
            &format!("SELECT COUNT(*) FROM \"{table}\" WHERE {time_sql} <= ?"),
            &[&cutoff_ms],
        )?;
        Ok(rows.first().map(|r| int_or_zero(r.first())).unwrap_or(0))
    }

    fn time_column(&self, table: &str) -> String {
        first_existing(&self.columns[table], &["create_time", "createTime"])
            .unwrap_or_else(|| "create_time".to_string())
    }

    fn order_columns(&self, table: &str) -> (String, String) {
        let columns = &self.columns[table];
        (
            first_existing(columns, &["sort_seq", "sortSeq"])
                .unwrap_or_else(|| "sort_seq".to_string()),
            first_existing(columns, &["local_id", "localId"])
                .unwrap_or_else(|| "local_id".to_string()),
        )
    }

    /// Port of `_select_columns`.
    fn select_columns(&self, table: &str) -> Result<(String, Vec<String>), PortError> {
        let columns = &self.columns[table];
        let local_col = first_existing(columns, &["local_id", "localId"]);
        let server_col = first_existing(columns, &["server_id", "serverId"]);
        let sort_col = first_existing(columns, &["sort_seq", "sortSeq"]);
        let type_col = first_existing(columns, &["local_type", "localType"]);
        let sender_col = first_existing(columns, &["real_sender_id", "realSenderId", "sender_id"]);
        let time_col = first_existing(columns, &["create_time", "createTime"]);
        let body_col = first_existing(columns, &["message_content", "messageContent", "content"]);
        let compress_col = first_existing(columns, &["compress_content", "compressContent"]);
        if local_col.is_none() || sort_col.is_none() || type_col.is_none() {
            return Err(protocol_error(
                "unsupported_schema",
                "message columns missing",
            ));
        }
        let selected: Vec<String> = [
            local_col,
            server_col,
            sort_col,
            type_col,
            sender_col,
            time_col,
            body_col,
            compress_col,
        ]
        .into_iter()
        .flatten()
        .collect();
        Ok((table.to_string(), selected))
    }

    /// Port of `_row_from`.
    fn row_from(
        &self,
        selected: &[String],
        record: &[Value],
        username: &str,
        contact_id: &str,
    ) -> Value {
        let lookup = |name: &str| -> Option<Value> {
            selected
                .iter()
                .position(|c| c == name)
                .and_then(|index| record.get(index).cloned())
        };
        let pick = |candidates: &[&str]| -> Option<Value> {
            for candidate in candidates {
                if let Some(value) = lookup(candidate) {
                    return Some(value);
                }
            }
            None
        };

        let local_id = int_or_zero(pick(&["local_id", "localId"]).as_ref());
        let server_id = int_or_zero(pick(&["server_id", "serverId"]).as_ref());
        let sort_seq = int_or_zero(pick(&["sort_seq", "sortSeq"]).as_ref());
        let local_type = int_or_zero(pick(&["local_type", "localType"]).as_ref());
        let sender_raw = pick(&["real_sender_id", "realSenderId", "sender_id"]);
        let create_time = pick(&["create_time", "createTime"]);
        let body = pick(&["message_content", "messageContent", "content"]);
        let compress = pick(&["compress_content", "compressContent"]);

        let mut kind = classify_kind(local_type);
        let mut text = String::new();
        if kind == KIND_TEXT {
            match extract_text(body.as_ref(), compress.as_ref()) {
                None => kind = KIND_NON_TEXT,
                Some(extracted) => text = extracted,
            }
        }

        let sender_id = match sender_raw.as_ref() {
            None | Some(Value::Null) => None,
            Some(value) => Some(int_or_zero(Some(value))),
        };
        let side = if kind != KIND_TEXT || self.self_id.is_none() || sender_id.is_none() {
            "unknown"
        } else if sender_id == self.self_id {
            "self"
        } else if self.id_to_name.contains_key(&sender_id.unwrap_or_default()) {
            "other"
        } else {
            "unknown"
        };

        let mut out = Map::new();
        out.insert(
            "id".to_string(),
            Value::String(message_id_for(
                &self.account_id,
                username,
                &self.shard_id,
                local_id,
            )),
        );
        out.insert(
            "accountId".to_string(),
            Value::String(self.account_id.clone()),
        );
        out.insert(
            "contactId".to_string(),
            Value::String(contact_id.to_string()),
        );
        out.insert("shardId".to_string(), Value::String(self.shard_id.clone()));
        out.insert("localId".to_string(), Value::String(local_id.to_string()));
        out.insert("serverId".to_string(), Value::String(server_id.to_string()));
        out.insert("sortSeq".to_string(), Value::String(sort_seq.to_string()));
        out.insert(
            "senderId".to_string(),
            Value::String(sender_id.unwrap_or(0).to_string()),
        );
        out.insert("localType".to_string(), json!(local_type));
        out.insert("kind".to_string(), Value::String(kind.to_string()));
        out.insert(
            "time".to_string(),
            json!(normalize_time(create_time.as_ref())),
        );
        out.insert("text".to_string(), Value::String(text));
        out.insert("side".to_string(), Value::String(side.to_string()));
        Value::Object(out)
    }

    /// Port of `latest`.
    pub fn latest(
        &self,
        username: &str,
        contact_id: &str,
        limit: i64,
    ) -> Result<Vec<Value>, PortError> {
        let Some(table) = self.message_tables.get(username) else {
            return Ok(Vec::new());
        };
        let (table, selected) = self.select_columns(table)?;
        let (sort_col, local_col) = self.order_columns(&table);
        let columns = quote_list(&selected);
        let sql = format!(
            "SELECT {columns} FROM \"{table}\" ORDER BY \"{sort_col}\" DESC, \"{local_col}\" DESC LIMIT ?"
        );
        let rows = self.query(&sql, &[&limit])?;
        Ok(rows
            .iter()
            .map(|r| self.row_from(&selected, r, username, contact_id))
            .collect())
    }

    /// Port of `last_key`.
    pub fn last_key(
        &self,
        username: &str,
        cutoff_ms: i64,
    ) -> Result<Option<(i64, i64)>, PortError> {
        let Some(table) = self.message_tables.get(username) else {
            return Ok(None);
        };
        let columns = &self.columns[table];
        let local_col = first_existing(columns, &["local_id", "localId"]);
        let sort_col = first_existing(columns, &["sort_seq", "sortSeq"]);
        let (Some(local_col), Some(sort_col)) = (local_col, sort_col) else {
            return Ok(None);
        };
        let time_sql = time_ms_sql(&self.time_column(table));
        let sql = format!(
            "SELECT \"{sort_col}\", \"{local_col}\" FROM \"{table}\" WHERE {time_sql} <= ? \
             ORDER BY \"{sort_col}\" DESC, \"{local_col}\" DESC LIMIT 1"
        );
        let rows = self.query(&sql, &[&cutoff_ms])?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        Ok(Some((int_or_zero(row.first()), int_or_zero(row.get(1)))))
    }

    /// Port of `iter_keyset`.
    pub fn iter_keyset(
        &self,
        username: &str,
        contact_id: &str,
        cutoff_ms: i64,
        cursor: Option<(i64, String, i64)>,
        limit: i64,
    ) -> Result<Vec<Value>, PortError> {
        let Some(table) = self.message_tables.get(username) else {
            return Ok(Vec::new());
        };
        let (table, selected) = self.select_columns(table)?;
        let (sort_col, local_col) = self.order_columns(&table);
        let (predicate_raw, predicate_params) =
            self.keyset_predicate_with(&table, cursor, &sort_col, &local_col);
        let columns = quote_list(&selected);
        let sql = format!(
            "SELECT {columns} FROM \"{table}\" WHERE {} <= ? {predicate_raw} \
             ORDER BY \"{sort_col}\" ASC, \"{local_col}\" ASC LIMIT ?",
            time_ms_sql(&self.time_column(&table))
        );
        let mut params: Vec<i64> = Vec::with_capacity(2 + predicate_params.len());
        params.push(cutoff_ms);
        params.extend(predicate_params);
        params.push(limit);
        let rows = self.query(
            &sql,
            &params
                .iter()
                .map(|p| p as &dyn rusqlite::ToSql)
                .collect::<Vec<_>>(),
        )?;
        Ok(rows
            .iter()
            .map(|r| self.row_from(&selected, r, username, contact_id))
            .collect())
    }

    fn keyset_predicate_with(
        &self,
        _table: &str,
        cursor: Option<(i64, String, i64)>,
        sort_col: &str,
        local_col: &str,
    ) -> (String, Vec<i64>) {
        let Some((cursor_sort, cursor_shard, cursor_local)) = cursor else {
            return (String::new(), Vec::new());
        };
        let sort_sql = format!("\"{sort_col}\"");
        let local_sql = format!("\"{local_col}\"");
        if self.shard_id > cursor_shard {
            return (format!("AND {sort_sql} >= ?"), vec![cursor_sort]);
        }
        if self.shard_id < cursor_shard {
            return (format!("AND {sort_sql} > ?"), vec![cursor_sort]);
        }
        (
            format!("AND ({sort_sql} > ? OR ({sort_sql} = ? AND {local_sql} > ?))"),
            vec![cursor_sort, cursor_sort, cursor_local],
        )
    }

    /// Port of `iter_before`.
    pub fn iter_before(
        &self,
        username: &str,
        contact_id: &str,
        cutoff_ms: i64,
        cursor: (i64, String, i64),
        limit: i64,
        inclusive: bool,
    ) -> Result<Vec<Value>, PortError> {
        let Some(table) = self.message_tables.get(username) else {
            return Ok(Vec::new());
        };
        if limit <= 0 {
            return Ok(Vec::new());
        }
        let (table, selected) = self.select_columns(table)?;
        let (sort_col, local_col) = self.order_columns(&table);
        let (predicate, predicate_params) =
            self.before_predicate(cursor, inclusive, &sort_col, &local_col);
        let columns = quote_list(&selected);
        let sql = format!(
            "SELECT {columns} FROM \"{table}\" WHERE {} <= ? {predicate} \
             ORDER BY \"{sort_col}\" DESC, \"{local_col}\" DESC LIMIT ?",
            time_ms_sql(&self.time_column(&table))
        );
        let mut params: Vec<i64> = Vec::with_capacity(2 + predicate_params.len());
        params.push(cutoff_ms);
        params.extend(predicate_params);
        params.push(limit);
        let rows = self.query(
            &sql,
            &params
                .iter()
                .map(|p| p as &dyn rusqlite::ToSql)
                .collect::<Vec<_>>(),
        )?;
        let mut rows: Vec<Value> = rows
            .iter()
            .map(|r| self.row_from(&selected, r, username, contact_id))
            .collect();
        rows.reverse();
        Ok(rows)
    }

    fn before_predicate(
        &self,
        cursor: (i64, String, i64),
        inclusive: bool,
        sort_col: &str,
        local_col: &str,
    ) -> (String, Vec<i64>) {
        let (cursor_sort, cursor_shard, cursor_local) = cursor;
        let sort_sql = format!("\"{sort_col}\"");
        let local_sql = format!("\"{local_col}\"");
        if self.shard_id < cursor_shard {
            return (format!("AND {sort_sql} <= ?"), vec![cursor_sort]);
        }
        if self.shard_id > cursor_shard {
            return (format!("AND {sort_sql} < ?"), vec![cursor_sort]);
        }
        if inclusive {
            return (
                format!("AND ({sort_sql} < ? OR ({sort_sql} = ? AND {local_sql} <= ?))"),
                vec![cursor_sort, cursor_sort, cursor_local],
            );
        }
        (
            format!("AND ({sort_sql} < ? OR ({sort_sql} = ? AND {local_sql} < ?))"),
            vec![cursor_sort, cursor_sort, cursor_local],
        )
    }
}

/// Port of `_time_ms_sql`.
fn time_ms_sql(column: &str) -> String {
    let quoted = format!("\"{column}\"");
    format!("(CASE WHEN {quoted} < 100000000000 THEN {quoted} * 1000 ELSE {quoted} END)")
}

fn quote_list(columns: &[String]) -> String {
    columns
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

fn value_text(value: &Value) -> String {
    match value {
        Value::Null => "None".to_string(),
        Value::String(s) => s.clone(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------- ContactStore

/// Port of `ContactStore`: aggregates every shard of one account.
pub struct ContactStore {
    account_id: String,
    shards: Vec<SqliteShard>,
    contact_ids: IndexMap<String, String>,
    contact_meta: IndexMap<String, Map<String, Value>>,
    usernames: IndexMap<String, Vec<usize>>,
    server_shard: std::collections::HashMap<String, String>,
}

impl ContactStore {
    /// Port of `ContactStore.__init__`.
    pub fn new(account_id: &str, shards: Vec<SqliteShard>) -> Self {
        Self::with_meta(account_id, shards, IndexMap::new(), IndexMap::new())
    }

    /// `NativeService` fixture mode supplies explicit contact ids and metadata.
    pub fn with_meta(
        account_id: &str,
        shards: Vec<SqliteShard>,
        contact_ids: IndexMap<String, String>,
        contact_meta: IndexMap<String, Map<String, Value>>,
    ) -> Self {
        let mut usernames: IndexMap<String, Vec<usize>> = IndexMap::new();
        for (index, shard) in shards.iter().enumerate() {
            for username in shard.usernames() {
                usernames.entry(username).or_default().push(index);
            }
        }
        ContactStore {
            account_id: account_id.to_string(),
            shards,
            contact_ids,
            contact_meta,
            usernames,
            server_shard: std::collections::HashMap::new(),
        }
    }

    /// Contact metadata as JSON, for snapshot serialization.
    pub fn contact_meta_json(&self) -> Value {
        Value::Object(
            self.contact_meta
                .iter()
                .map(|(k, v)| (k.clone(), Value::Object(v.clone())))
                .collect(),
        )
    }

    /// All usernames known to this store.
    pub fn usernames(&self) -> Vec<String> {
        self.usernames.keys().cloned().collect()
    }

    fn shards_for(&self, username: &str) -> &[usize] {
        self.usernames
            .get(username)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// Port of `contact_id_for` on the store (explicit ids win over the hash).
    pub fn contact_id_for(&self, username: &str) -> String {
        if let Some(explicit) = self.contact_ids.get(username) {
            return explicit.clone();
        }
        let basis = format!("{}\u{0}{username}", self.account_id);
        let digest = Sha256::digest(basis.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        hex[..32].to_string()
    }

    /// Port of `username_for`.
    pub fn username_for(&self, contact_id: &str) -> Option<String> {
        self.usernames
            .keys()
            .find(|username| self.contact_id_for(username) == contact_id)
            .cloned()
    }

    /// Port of `_kind`.
    fn kind(&self, username: &str) -> &'static str {
        if username.ends_with("@chatroom") {
            return "group";
        }
        if username.starts_with("gh_") {
            return "service";
        }
        if username.is_empty() {
            return "unknown";
        }
        "friend"
    }

    /// Port of `_dedupe`: drop a row whose nonzero server id already belongs to another shard.
    fn dedupe(&mut self, rows: Vec<Value>) -> Vec<Value> {
        let mut kept = Vec::with_capacity(rows.len());
        for row in rows {
            let server = text_field(&row, "serverId");
            let shard = text_field(&row, "shardId");
            if !server.is_empty() && server != "0" {
                if let Some(owner) = self.server_shard.get(&server)
                    && *owner != shard
                {
                    continue;
                }
                self.server_shard.insert(server, shard);
            }
            kept.push(row);
        }
        kept
    }

    /// Port of `contacts`.
    pub fn contacts(&self) -> Result<Vec<Value>, PortError> {
        let mut pairs: Vec<(&String, &Vec<usize>)> = self.usernames.iter().collect();
        pairs.sort_by(|a, b| a.0.cmp(b.0));
        let mut out = Vec::new();
        for (username, shard_indices) in pairs {
            let contact_id = self.contact_id_for(username);
            let mut count = 0i64;
            let mut latest: Option<i64> = None;
            for index in shard_indices {
                let shard = &self.shards[*index];
                count += shard.count(username, 1 << 62)?;
                let rows = shard.latest(username, &contact_id, 1)?;
                if let Some(row) = rows.first() {
                    let candidate = row.get("time").and_then(Value::as_i64).unwrap_or(0);
                    if latest.is_none_or(|current| candidate > current) {
                        latest = Some(candidate);
                    }
                }
            }
            if count <= 0 {
                continue;
            }
            let mut entry = Map::new();
            entry.insert("id".to_string(), Value::String(contact_id));
            entry.insert(
                "accountId".to_string(),
                Value::String(self.account_id.clone()),
            );
            let (name, kind) = match self.contact_meta.get(username) {
                Some(meta) => (
                    meta.get("name")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(username)
                        .to_string(),
                    meta.get("kind")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| self.kind(username))
                        .to_string(),
                ),
                None => (username.clone(), self.kind(username).to_string()),
            };
            entry.insert("name".to_string(), Value::String(name));
            entry.insert("kind".to_string(), Value::String(kind));
            entry.insert("messageCount".to_string(), json!(count));
            entry.insert(
                "lastTime".to_string(),
                match latest {
                    Some(time) => json!(time),
                    None => Value::Null,
                },
            );
            out.push(Value::Object(entry));
        }
        Ok(out)
    }

    /// Port of `total`.
    pub fn total(&self, username: &str, cutoff_ms: i64) -> Result<i64, PortError> {
        let mut sum = 0i64;
        for index in self.shards_for(username) {
            sum += self.shards[*index].count(username, cutoff_ms)?;
        }
        Ok(sum)
    }

    /// Port of `page`: one merged, de-duplicated page plus the cursor to continue from.
    pub fn page(
        &mut self,
        username: &str,
        cutoff_ms: i64,
        cursor: Option<(i64, String, i64)>,
        limit: i64,
    ) -> Result<PageResult, PortError> {
        let contact_id = self.contact_id_for(username);
        let indices: Vec<usize> = self.shards_for(username).to_vec();
        let mut merged: Vec<Value> = Vec::new();
        for index in indices {
            merged.extend(self.shards[index].iter_keyset(
                username,
                &contact_id,
                cutoff_ms,
                cursor.clone(),
                limit + 1,
            )?);
        }
        merged.sort_by_key(row_key);

        let mut rows: Vec<Value> = Vec::new();
        let mut last_key: Option<(i64, String, i64)> = None;
        let mut following: Option<Value> = None;
        for row in merged {
            let server = text_field(&row, "serverId");
            let shard_id = text_field(&row, "shardId");
            if !server.is_empty() && server != "0" {
                if let Some(owner) = self.server_shard.get(&server)
                    && *owner != shard_id
                {
                    continue;
                }
                self.server_shard.insert(server, shard_id.clone());
            }
            if rows.len() as i64 >= limit {
                following = Some(row);
                break;
            }
            last_key = Some(row_key(&row));
            rows.push(row);
        }
        if following.is_none() {
            return Ok((rows, None, true));
        }
        Ok((rows, last_key, false))
    }

    /// Port of `rows`, bounded by `limit` rows.
    pub fn rows(&mut self, username: &str, limit: i64) -> Result<Vec<Value>, PortError> {
        let mut collected: Vec<Value> = Vec::new();
        let mut cursor: Option<(i64, String, i64)> = None;
        while (collected.len() as i64) < limit {
            let (batch, next, done) = self.page(username, 1 << 62, cursor, 200)?;
            if batch.is_empty() && done {
                break;
            }
            collected.extend(batch);
            if done {
                break;
            }
            cursor = next;
            if cursor.is_none() {
                break;
            }
        }
        collected.truncate(limit.max(0) as usize);
        Ok(collected)
    }

    /// Port of `context_before`.
    pub fn context_before(
        &mut self,
        username: &str,
        cutoff_ms: i64,
        cursor: (i64, String, i64),
        limit: i64,
        inclusive: bool,
    ) -> Result<Vec<Value>, PortError> {
        if limit <= 0 {
            return Ok(Vec::new());
        }
        let contact_id = self.contact_id_for(username);
        let indices: Vec<usize> = self.shards_for(username).to_vec();
        let mut gathered: Vec<Value> = Vec::new();
        for index in indices {
            gathered.extend(self.shards[index].iter_before(
                username,
                &contact_id,
                cutoff_ms,
                cursor.clone(),
                limit,
                inclusive,
            )?);
        }
        gathered.sort_by_key(row_key);
        let mut deduped = self.dedupe(gathered);
        if deduped.len() as i64 > limit {
            deduped = deduped.split_off(deduped.len() - limit as usize);
        }
        Ok(deduped)
    }

    /// Port of `latest`.
    pub fn latest(&mut self, username: &str, limit: i64) -> Result<Vec<Value>, PortError> {
        let contact_id = self.contact_id_for(username);
        let indices: Vec<usize> = self.shards_for(username).to_vec();
        let mut gathered: Vec<Value> = Vec::new();
        for index in indices {
            gathered.extend(self.shards[index].latest(username, &contact_id, limit)?);
        }
        gathered.sort_by_key(row_key);
        let mut deduped = self.dedupe(gathered);
        if deduped.len() as i64 > limit {
            deduped = deduped.split_off(deduped.len() - limit as usize);
        }
        Ok(deduped)
    }

    /// Port of `last_key`.
    pub fn last_key(
        &self,
        username: &str,
        cutoff_ms: i64,
    ) -> Result<Option<(i64, String, i64)>, PortError> {
        let mut best: Option<(i64, String, i64)> = None;
        for index in self.shards_for(username) {
            let shard = &self.shards[*index];
            let Some((sort_seq, local_id)) = shard.last_key(username, cutoff_ms)? else {
                continue;
            };
            let candidate = (sort_seq, shard.id().to_string(), local_id);
            if best.as_ref().is_none_or(|current| candidate > *current) {
                best = Some(candidate);
            }
        }
        Ok(best)
    }
}

/// `(sortSeq, shardId, localId)` — the composite order every merged list uses.
fn row_key(row: &Value) -> (i64, String, i64) {
    let number = |key: &str| -> i64 {
        row.get(key)
            .map(|v| match v {
                Value::String(s) => s.parse::<i64>().unwrap_or(0),
                other => other.as_i64().unwrap_or(0),
            })
            .unwrap_or(0)
    };
    (
        number("sortSeq"),
        text_field(row, "shardId"),
        number("localId"),
    )
}

fn text_field(row: &Value, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

// ---------------------------------------------------------------------------- op dispatch

/// Owns the fixture shards and the store, and answers one op at a time.
pub struct Runner {
    account: String,
    self_username: Option<String>,
    first_image: Vec<u8>,
    second_image: Vec<u8>,
    shard: SqliteShard,
    store: Option<ContactStore>,
}

impl Runner {
    pub fn new(
        shard_id: &str,
        first: &[u8],
        second: &[u8],
        account: &str,
        self_username: Option<&str>,
    ) -> Result<Self, PortError> {
        Ok(Runner {
            account: account.to_string(),
            self_username: self_username.map(str::to_string),
            first_image: first.to_vec(),
            second_image: second.to_vec(),
            shard: SqliteShard::new(shard_id, first, account, self_username)?,
            store: None,
        })
    }

    fn ensure_store(&mut self) -> Result<&mut ContactStore, PortError> {
        if self.store.is_none() {
            let first = SqliteShard::new(
                "shard-1",
                &self.first_image,
                &self.account,
                self.self_username.as_deref(),
            )?;
            let second = SqliteShard::new(
                "shard-2",
                &self.second_image,
                &self.account,
                self.self_username.as_deref(),
            )?;
            self.store = Some(ContactStore::new(&self.account, vec![first, second]));
        }
        Ok(self.store.as_mut().expect("store built above"))
    }

    /// Answers one op. `target` picks the shard layer or the store layer.
    pub fn run(&mut self, op: &Value) -> Value {
        let target = op.get("target").and_then(Value::as_str).unwrap_or("shard");
        let outcome = if target == "store" {
            self.run_store(op)
        } else {
            self.run_shard(op)
        };
        match outcome {
            Ok(value) => json!({ "ok": value }),
            Err((code, message)) => {
                json!({ "error": format!("ProtocolError({code}): {message}") })
            }
        }
    }

    fn run_store(&mut self, op: &Value) -> Result<Value, PortError> {
        let name = op.get("op").and_then(Value::as_str).unwrap_or_default();
        let username = string_of(op, "username").unwrap_or_default();
        let limit = i64_of(op, "limit");
        let cutoff = i64_of(op, "cutoff_ms");
        let store = self.ensure_store()?;
        match name {
            "contact_id_for" => Ok(Value::String(store.contact_id_for(&username))),
            "username_for" => Ok(
                match store.username_for(&string_of(op, "contact_id").unwrap_or_default()) {
                    Some(found) => Value::String(found),
                    None => Value::Null,
                },
            ),
            "contacts" => store.contacts().map(|rows| json!(rows)),
            "total" => store.total(&username, cutoff).map(|n| json!(n)),
            "store_last_key" => store.last_key(&username, cutoff).map(|key| match key {
                None => Value::Null,
                Some((sort, shard, local)) => json!([sort, shard, local]),
            }),
            "store_latest" => store.latest(&username, limit).map(|rows| json!(rows)),
            "page" => {
                store
                    .page(&username, cutoff, cursor_of(op), limit)
                    .map(|(rows, cursor, done)| {
                        json!({
                            "rows": rows,
                            "cursor": match cursor {
                                None => Value::Null,
                                Some((sort, shard, local)) => json!([sort, shard, local]),
                            },
                            "done": done,
                        })
                    })
            }
            "context_before" => {
                let Some(cursor) = cursor_of(op) else {
                    return Ok(Value::Null);
                };
                store
                    .context_before(
                        &username,
                        cutoff,
                        cursor,
                        limit,
                        op.get("inclusive").and_then(Value::as_bool).unwrap_or(true),
                    )
                    .map(|rows| json!(rows))
            }
            "rows" => store.rows(&username, limit).map(|rows| json!(rows)),
            other => Ok(json!({ "error": format!("unknown store op {other}") })),
        }
    }

    fn run_shard(&mut self, op: &Value) -> Result<Value, PortError> {
        let name = op.get("op").and_then(Value::as_str).unwrap_or_default();
        let shard = &mut self.shard;
        match name {
            "usernames" => Ok(json!(shard.usernames())),
            "known_usernames" => Ok(json!(shard.known_usernames())),
            "contact_metadata" => shard.contact_metadata(),
            "has_table" => Ok(json!(
                shard.has_table(&string_of(op, "username").unwrap_or_default())
            )),
            "set_self_username" => Ok(json!(
                shard.set_self_username(string_of(op, "username").as_deref())
            )),
            "count" => shard
                .count(
                    &string_of(op, "username").unwrap_or_default(),
                    i64_of(op, "cutoff_ms"),
                )
                .map(|n| json!(n)),
            "last_key" => shard
                .last_key(
                    &string_of(op, "username").unwrap_or_default(),
                    i64_of(op, "cutoff_ms"),
                )
                .map(|key| match key {
                    None => Value::Null,
                    Some((sort, local)) => json!([sort, local]),
                }),
            "latest" => shard
                .latest(
                    &string_of(op, "username").unwrap_or_default(),
                    &string_of(op, "contact_id").unwrap_or_default(),
                    i64_of(op, "limit"),
                )
                .map(|rows| json!(rows)),
            "iter_keyset" => shard
                .iter_keyset(
                    &string_of(op, "username").unwrap_or_default(),
                    &string_of(op, "contact_id").unwrap_or_default(),
                    i64_of(op, "cutoff_ms"),
                    cursor_of(op),
                    i64_of(op, "limit"),
                )
                .map(|rows| json!(rows)),
            "iter_before" => {
                let Some(cursor) = cursor_of(op) else {
                    return Ok(Value::Null);
                };
                shard
                    .iter_before(
                        &string_of(op, "username").unwrap_or_default(),
                        &string_of(op, "contact_id").unwrap_or_default(),
                        i64_of(op, "cutoff_ms"),
                        cursor,
                        i64_of(op, "limit"),
                        op.get("inclusive").and_then(Value::as_bool).unwrap_or(true),
                    )
                    .map(|rows| json!(rows))
            }
            other => Ok(json!({ "error": format!("unknown op {other}") })),
        }
    }
}

fn string_of(op: &Value, key: &str) -> Option<String> {
    op.get(key).and_then(Value::as_str).map(str::to_string)
}

fn i64_of(op: &Value, key: &str) -> i64 {
    op.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn cursor_of(op: &Value) -> Option<(i64, String, i64)> {
    let raw = op.get("cursor")?;
    if raw.is_null() {
        return None;
    }
    let items = raw.as_array()?;
    Some((
        items.first()?.as_i64()?,
        items.get(1)?.as_str()?.to_string(),
        items.get(2)?.as_i64()?,
    ))
}
