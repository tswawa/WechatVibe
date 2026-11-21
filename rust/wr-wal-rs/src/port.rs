//! The Rust port of `wr/wal.py`.
//!
//! SQLite WAL parsing with committed-frame semantics: only frames that pass salt + rolling
//! checksum validation up to the last commit frame are published.
//!
//! `WalFrame` / `WalParseResult` are Python dataclasses, which the generated bridge cannot carry
//! across. They are emitted in the same JSON shape the recorder stores for a dataclass
//! (`{"$object": "<class>", "attrs": {..}}`), so `diff` compares like for like.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

const WAL_MAGIC_LITTLE: u32 = 0x377F0682;
const WAL_MAGIC_BIG: u32 = 0x377F0683;
const WAL_HEADER_SIZE: usize = 32;
const FRAME_HEADER_SIZE: usize = 24;
const VALID_PAGE_SIZES: [u32; 8] = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

fn bytes_of(v: &Value) -> Option<Vec<u8>> {
    let arr = v.get("$bytes")?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for b in arr {
        out.push(u8::try_from(b.as_u64()?).ok()?);
    }
    Some(out)
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

fn no_len(v: &Value) -> String {
    format!("TypeError: object of type '{}' has no len()", type_name(v))
}

/// A `bytes` parameter in a `+` chain: anything else raises Python's concat error.
fn as_bytes(v: &Value) -> Result<Vec<u8>, String> {
    bytes_of(v).ok_or_else(|| format!("TypeError: can't concat {} to bytes", type_name(v)))
}

/// An argument of `int.to_bytes(4, "big")`.
fn as_u32(v: &Value) -> Result<u32, String> {
    let signed = match v {
        Value::Bool(b) => Some(i64::from(*b)),
        Value::Number(n) if !n.is_f64() => n.as_i64(),
        _ => None,
    };
    let Some(i) = signed else {
        return Err(format!(
            "AttributeError: '{}' object has no attribute 'to_bytes'",
            type_name(v)
        ));
    };
    if i < 0 {
        return Err("OverflowError: can't convert negative int to unsigned".to_string());
    }
    u32::try_from(i).map_err(|_| "OverflowError: int too big to convert".to_string())
}

fn be32(bytes: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn checksum(data: &[u8], mut s0: u32, mut s1: u32, little_endian: bool) -> (u32, u32) {
    let mut offset = 0;
    while offset + 8 <= data.len() {
        let x0 = if little_endian {
            u32::from_le_bytes([
                data[offset],
                data[offset + 1],
                data[offset + 2],
                data[offset + 3],
            ])
        } else {
            be32(data, offset)
        };
        let x1 = if little_endian {
            u32::from_le_bytes([
                data[offset + 4],
                data[offset + 5],
                data[offset + 6],
                data[offset + 7],
            ])
        } else {
            be32(data, offset + 4)
        };
        s0 = s0.wrapping_add(x0).wrapping_add(s1);
        s1 = s1.wrapping_add(x1).wrapping_add(s0);
        offset += 8;
    }
    (s0, s1)
}

fn frame_json(page_number: u32, page: &[u8]) -> Value {
    json!({
        "$object": "WalFrame",
        "attrs": {
            "page_number": page_number,
            "page": { "$bytes": page },
        }
    })
}

fn result_json(
    frames: Vec<Value>,
    header_ok: bool,
    corrupt_before_commit: bool,
    commit_db_size: Option<u32>,
) -> Value {
    json!({
        "$object": "WalParseResult",
        "attrs": {
            "frames": frames,
            "header_ok": header_ok,
            "corrupt_before_commit": corrupt_before_commit,
            "commit_db_size": commit_db_size,
        }
    })
}

/// Header fields shared by every entry point, or `None` when the image is not a valid WAL.
struct Header {
    page_size: usize,
    little_endian: bool,
    salt1: [u8; 4],
    salt2: [u8; 4],
    s0: u32,
    s1: u32,
}

fn read_header(data: &[u8]) -> Option<Header> {
    if data.len() < WAL_HEADER_SIZE {
        return None;
    }
    let magic = be32(data, 0);
    let little_endian = match magic {
        WAL_MAGIC_LITTLE => true,
        WAL_MAGIC_BIG => false,
        _ => return None,
    };
    let page_size = be32(data, 8);
    if !VALID_PAGE_SIZES.contains(&page_size) {
        return None;
    }
    let salt1 = [data[16], data[17], data[18], data[19]];
    let salt2 = [data[20], data[21], data[22], data[23]];
    let s0 = be32(data, 24);
    let s1 = be32(data, 28);
    if checksum(&data[0..24], 0, 0, little_endian) != (s0, s1) {
        return None;
    }
    Some(Header {
        page_size: page_size as usize,
        little_endian,
        salt1,
        salt2,
        s0,
        s1,
    })
}

fn parse_committed(data: &[u8]) -> (Vec<Value>, Option<u32>) {
    let Some(h) = read_header(data) else {
        return (Vec::new(), None);
    };
    let mut frames: Vec<Value> = Vec::new();
    let mut committed: Vec<Value> = Vec::new();
    let mut commit_size: Option<u32> = None;
    let mut s0 = h.s0;
    let mut s1 = h.s1;
    let mut offset = WAL_HEADER_SIZE;
    while offset + FRAME_HEADER_SIZE + h.page_size <= data.len() {
        let fh = &data[offset..offset + FRAME_HEADER_SIZE];
        let page_number = be32(fh, 0);
        let db_size_after = be32(fh, 4);
        let check0 = be32(fh, 16);
        let check1 = be32(fh, 20);
        let page = &data[offset + FRAME_HEADER_SIZE..offset + FRAME_HEADER_SIZE + h.page_size];

        let mut buf = Vec::with_capacity(8 + page.len());
        buf.extend_from_slice(&fh[0..8]);
        buf.extend_from_slice(page);
        let (next0, next1) = checksum(&buf, s0, s1, h.little_endian);
        if fh[8..12] != h.salt1 || fh[12..16] != h.salt2 || (next0, next1) != (check0, check1) {
            break;
        }
        s0 = next0;
        s1 = next1;
        frames.push(frame_json(page_number, page));
        if db_size_after != 0 {
            committed = frames.clone();
            commit_size = Some(db_size_after);
        }
        offset += FRAME_HEADER_SIZE + h.page_size;
    }
    (committed, commit_size)
}

/// True when the first frame is present but fails salt/checksum validation.
fn has_corruption_before_commit(data: &[u8]) -> bool {
    if data.len() < WAL_HEADER_SIZE {
        return false;
    }
    let magic = be32(data, 0);
    let little_endian = match magic {
        WAL_MAGIC_LITTLE => true,
        WAL_MAGIC_BIG => false,
        _ => return false,
    };
    let page_size = be32(data, 8);
    if !VALID_PAGE_SIZES.contains(&page_size) {
        return false;
    }
    let page_size = page_size as usize;
    let salt1 = &data[16..20];
    let salt2 = &data[20..24];
    let s0 = be32(data, 24);
    let s1 = be32(data, 28);
    if checksum(&data[0..24], 0, 0, little_endian) != (s0, s1) {
        return true;
    }
    if data.len() < WAL_HEADER_SIZE + FRAME_HEADER_SIZE + page_size {
        return false;
    }
    let fh = &data[WAL_HEADER_SIZE..WAL_HEADER_SIZE + FRAME_HEADER_SIZE];
    let page =
        &data[WAL_HEADER_SIZE + FRAME_HEADER_SIZE..WAL_HEADER_SIZE + FRAME_HEADER_SIZE + page_size];
    let mut buf = Vec::with_capacity(8 + page.len());
    buf.extend_from_slice(&fh[0..8]);
    buf.extend_from_slice(page);
    let (next0, next1) = checksum(&buf, s0, s1, little_endian);
    fh[8..12] != *salt1 || fh[12..16] != *salt2 || (next0, next1) != (be32(fh, 16), be32(fh, 20))
}

/// Python `len(v)`: bytes count bytes, `str` counts code points, containers count items.
fn py_len(v: &Value) -> Result<usize, String> {
    if let Some(bytes) = bytes_of(v) {
        return Ok(bytes.len());
    }
    match v {
        Value::String(s) => Ok(s.chars().count()),
        Value::Array(a) => Ok(a.len()),
        Value::Object(o) => Ok(o.len()),
        _ => Err(no_len(v)),
    }
}

/// `data` as bytes, or the error the original raises once it slices it.
fn data_of(v: &Value) -> Result<Vec<u8>, String> {
    bytes_of(v).ok_or_else(|| {
        format!(
            "TypeError: cannot convert '{}' object to bytes",
            type_name(v)
        )
    })
}

/// Port of `parse_wal` (`wr/wal.py:35`).
pub fn parse_wal(data: serde_json::Value) -> Result<serde_json::Value, String> {
    // The original checks `len(data) < WAL_HEADER_SIZE` before slicing, so a short non-bytes
    // argument returns an empty result instead of raising.
    if py_len(&data)? < WAL_HEADER_SIZE {
        return Ok(result_json(Vec::new(), false, false, None));
    }
    let data = data_of(&data)?;
    let (frames, commit_db_size) = parse_committed(&data);
    let magic = be32(&data, 0);
    let header_ok = magic == WAL_MAGIC_LITTLE || magic == WAL_MAGIC_BIG;
    let corrupt_before_commit =
        (!header_ok || has_corruption_before_commit(&data)) && frames.is_empty();
    Ok(result_json(
        frames,
        header_ok,
        corrupt_before_commit,
        commit_db_size,
    ))
}

/// Port of `parse_committed_frames` (`wr/wal.py:90`).
pub fn parse_committed_frames(data: serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    if py_len(&data)? < WAL_HEADER_SIZE {
        return Ok(Vec::new());
    }
    let data = data_of(&data)?;
    Ok(parse_committed(&data).0)
}

/// Port of `build_wal_header` (`wr/wal.py:142`).
pub fn build_wal_header(
    page_size: serde_json::Value,
    salt1: serde_json::Value,
    salt2: serde_json::Value,
    little_endian: bool,
) -> Result<serde_json::Value, String> {
    let page_size = as_u32(&page_size)?;
    let salt1 = as_bytes(&salt1)?;
    let salt2 = as_bytes(&salt2)?;
    let magic = if little_endian {
        WAL_MAGIC_LITTLE
    } else {
        WAL_MAGIC_BIG
    };
    let mut base = Vec::with_capacity(24 + salt1.len() + salt2.len());
    base.extend_from_slice(&magic.to_be_bytes());
    base.extend_from_slice(&3_007_000u32.to_be_bytes());
    base.extend_from_slice(&page_size.to_be_bytes());
    base.extend_from_slice(&0u32.to_be_bytes());
    base.extend_from_slice(&salt1);
    base.extend_from_slice(&salt2);
    let (s0, s1) = checksum(&base, 0, 0, little_endian);
    base.extend_from_slice(&s0.to_be_bytes());
    base.extend_from_slice(&s1.to_be_bytes());
    Ok(json!({ "$bytes": base }))
}

/// Python truthiness, for the `commit` flag.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Port of `build_frame` (`wr/wal.py:157`).
#[expect(clippy::too_many_arguments, reason = "mirrors the original signature")]
pub fn build_frame(
    page_number: serde_json::Value,
    page: serde_json::Value,
    salt1: serde_json::Value,
    salt2: serde_json::Value,
    s0: serde_json::Value,
    s1: serde_json::Value,
    commit: serde_json::Value,
    db_size_after: serde_json::Value,
    little_endian: bool,
) -> Result<serde_json::Value, String> {
    let page_number = as_u32(&page_number)?;
    let db_size_field = if truthy(&commit) {
        as_u32(&db_size_after)?
    } else {
        0
    };
    let page = as_bytes(&page)?;
    let salt1 = as_bytes(&salt1)?;
    let salt2 = as_bytes(&salt2)?;
    let s0 = as_u32(&s0)?;
    let s1 = as_u32(&s1)?;

    let mut prefix = Vec::with_capacity(8);
    prefix.extend_from_slice(&page_number.to_be_bytes());
    prefix.extend_from_slice(&db_size_field.to_be_bytes());
    let mut buf = prefix.clone();
    buf.extend_from_slice(&page);
    let (next0, next1) = checksum(&buf, s0, s1, little_endian);
    let mut out = prefix;
    out.extend_from_slice(&salt1);
    out.extend_from_slice(&salt2);
    out.extend_from_slice(&next0.to_be_bytes());
    out.extend_from_slice(&next1.to_be_bytes());
    out.extend_from_slice(&page);
    Ok(json!({ "$tuple": [{ "$bytes": out }, next0, next1] }))
}
