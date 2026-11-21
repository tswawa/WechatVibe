//! The Rust port of `wr/png_encode.py`.
//!
//! Dependency-free PNG encoder for window-frame evidence. Output must be **byte-identical** to the
//! original, so compression goes through real zlib (CPython's `zlib.compress`) rather than
//! miniz_oxide: same deflate level, same bytes.

#![forbid(unsafe_code)]

use flate2::Compression;
use flate2::write::ZlibEncoder;
use serde_json::{Value, json};
use std::io::Write;

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n'];
const COLOUR_TYPE_RGB: u8 = 2;
const BIT_DEPTH: u8 = 8;

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

/// `rgb` as bytes, following the original's `len(rgb)` semantics: a value with no `len()` raises
/// `TypeError` before the size comparison happens, and a list of ints is a valid byte source.
fn rgb_of(v: &Value) -> Result<Vec<u8>, String> {
    if let Some(bytes) = bytes_of(v) {
        return Ok(bytes);
    }
    match v {
        Value::Number(_) | Value::Bool(_) | Value::Null => Err(format!(
            "TypeError: object of type '{}' has no len()",
            type_name(v)
        )),
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                match item.as_u64().and_then(|n| u8::try_from(n).ok()) {
                    Some(b) => out.push(b),
                    None => {
                        return Err("ValueError: rgb buffer size does not match dimensions".into());
                    }
                }
            }
            Ok(out)
        }
        _ => Err("ValueError: rgb buffer size does not match dimensions".to_string()),
    }
}

fn chunk(kind: &[u8], data: &[u8]) -> Vec<u8> {
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(kind);
    hasher.update(data);
    let crc = hasher.finalize();
    let mut out = Vec::with_capacity(12 + data.len());
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc.to_be_bytes());
    out
}

/// Port of `encode_png_rgb` (`wr/png_encode.py:23`).
pub fn encode_png_rgb(
    width: i64,
    height: i64,
    rgb: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if width <= 0 || height <= 0 {
        return Err("ValueError: invalid png dimensions".to_string());
    }
    let rgb = rgb_of(&rgb)?;
    let stride = width.saturating_mul(3);
    if (rgb.len() as i64) != stride.saturating_mul(height) {
        return Err("ValueError: rgb buffer size does not match dimensions".to_string());
    }

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(width as u32).to_be_bytes());
    ihdr.extend_from_slice(&(height as u32).to_be_bytes());
    ihdr.push(BIT_DEPTH);
    ihdr.push(COLOUR_TYPE_RGB);
    ihdr.push(0);
    ihdr.push(0);
    ihdr.push(0);

    // Every scanline is prefixed with filter type 0 (None), like the original.
    let stride = stride as usize;
    let mut raw = Vec::with_capacity((stride + 1) * height as usize);
    for y in 0..height as usize {
        raw.push(0);
        let start = y * stride;
        raw.extend_from_slice(&rgb[start..start + stride]);
    }

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
    encoder
        .write_all(&raw)
        .map_err(|e| format!("ValueError: {e}"))?;
    let idat = encoder.finish().map_err(|e| format!("ValueError: {e}"))?;

    let mut out = Vec::with_capacity(PNG_SIGNATURE.len() + 12 * 3 + ihdr.len() + idat.len());
    out.extend_from_slice(&PNG_SIGNATURE);
    out.extend_from_slice(&chunk(b"IHDR", &ihdr));
    out.extend_from_slice(&chunk(b"IDAT", &idat));
    out.extend_from_slice(&chunk(b"IEND", &[]));
    Ok(json!({ "$bytes": out }))
}
