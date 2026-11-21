//! The Rust port of `wr/crypto.py`.
//!
//! SQLCipher 4 page crypto: AES-256-CBC + HMAC-SHA512, PBKDF2-HMAC-SHA512 key derivation.
//! Behavior is held to the Python original's recorded cases (`cases.jsonl`).
//!
//! `PageKey` is a Python `@dataclass`, which the generated bridge cannot carry across the
//! boundary (`pyconv::from_py` rejects arbitrary objects, `to_py` has no `$object` branch).
//! It crosses as JSON instead: `{"key": {"$bytes": [..]}, "salt": .., "hmac_key": ..}`,
//! also accepted wrapped as `{"$object": "PageKey", "attrs": {..}}`.

#![forbid(unsafe_code)]

use aes::Aes256;
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit, block_padding::NoPadding};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha512;
use subtle::ConstantTimeEq;

const PAGE_SIZE: usize = 4096;
const RESERVED: usize = 80;
const IV_SIZE: usize = 16;
const KEY_SIZE: usize = 32;
const SALT_SIZE: usize = 16;
const SQLITE_HEADER: &[u8] = b"SQLite format 3\x00";
const KDF_ITERATIONS: u32 = 256_000;

/// Derived key material for one database salt. Mirrors the Python `PageKey` dataclass.
#[derive(Clone, Debug)]
struct PageKey {
    key: Vec<u8>,
    salt: Vec<u8>,
    hmac_key: Vec<u8>,
}

fn bytes_of(v: &Value) -> Option<Vec<u8>> {
    let arr = v.get("$bytes")?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for b in arr {
        out.push(u8::try_from(b.as_u64()?).ok()?);
    }
    Some(out)
}

fn arg_bytes(v: &Value, what: &str) -> Result<Vec<u8>, String> {
    bytes_of(v).ok_or_else(|| format!("TypeError: {what} is not bytes"))
}

/// Decode a `PageKey`, in either the flat or the `$object`/`attrs` shape.
fn page_key_of(v: &Value) -> Result<PageKey, String> {
    let attrs = v.get("attrs").filter(|a| a.is_object()).unwrap_or(v);
    let bad = || "TypeError: page_key is not a PageKey".to_string();
    let key = attrs.get("key").and_then(bytes_of).ok_or_else(bad)?;
    let salt = attrs.get("salt").and_then(bytes_of).ok_or_else(bad)?;
    let hmac_key = attrs.get("hmac_key").and_then(bytes_of).ok_or_else(bad)?;
    Ok(PageKey {
        key,
        salt,
        hmac_key,
    })
}

fn page_key_json(k: &PageKey) -> Value {
    json!({
        "$object": "PageKey",
        "attrs": {
            "key": { "$bytes": k.key },
            "salt": { "$bytes": k.salt },
            "hmac_key": { "$bytes": k.hmac_key },
        }
    })
}

fn pbkdf2_sha512(password: &[u8], salt: &[u8], rounds: u32, out_len: usize) -> Vec<u8> {
    let mut out = vec![0u8; out_len];
    pbkdf2::pbkdf2_hmac::<Sha512>(password, salt, rounds, &mut out);
    out
}

/// `salt XOR 0x3a`, the HMAC key salt of SQLCipher 4.
fn xor_mask(salt: &[u8]) -> Vec<u8> {
    salt.iter().map(|b| b ^ 0x3A).collect()
}

fn expected_hmac(page_key: &PageKey, ciphertext: &[u8], iv: &[u8], page_number: i64) -> Vec<u8> {
    let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(&page_key.hmac_key).expect("HMAC key");
    mac.update(ciphertext);
    mac.update(iv);
    mac.update(&(page_number as u32).to_le_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// The original raises `ProtocolError(code, message)`; `str()` of it is the message.
///
/// The generated `error()` cannot build a class defined by the project, so the code travels in
/// the kind position — `ProtocolError(key_unavailable): page HMAC mismatch` — and `lib.rs` maps it
/// back to `wr.errors.ProtocolError(code, message)`.
fn protocol_error(code: &str, message: &str) -> String {
    format!("ProtocolError({code}): {message}")
}

/// Port of `derive_hmac_key` (`wr/crypto.py:51`).
pub fn derive_hmac_key(key: Value, salt: Value) -> Result<Value, String> {
    let key = arg_bytes(&key, "key")?;
    let salt = arg_bytes(&salt, "salt")?;
    Ok(json!({ "$bytes": pbkdf2_sha512(&key, &xor_mask(&salt), 2, KEY_SIZE) }))
}

/// Port of `make_page_key` (`wr/crypto.py:56`).
pub fn make_page_key(raw_key: Value, salt: Value) -> Result<Value, String> {
    let raw_key = arg_bytes(&raw_key, "raw_key")?;
    let salt = arg_bytes(&salt, "salt")?;
    if raw_key.len() != KEY_SIZE {
        return Err(protocol_error(
            "key_unavailable",
            "raw key must be 32 bytes",
        ));
    }
    if salt.len() != SALT_SIZE {
        return Err(protocol_error(
            "unsupported_schema",
            "salt must be 16 bytes",
        ));
    }
    let hmac_key = pbkdf2_sha512(&raw_key, &xor_mask(&salt), 2, KEY_SIZE);
    Ok(page_key_json(&PageKey {
        key: raw_key,
        salt,
        hmac_key,
    }))
}

/// Port of `derive_key_from_passphrase` (`wr/crypto.py:64`).
pub fn derive_key_from_passphrase(passphrase: Value, salt: Value) -> Result<Value, String> {
    let passphrase = arg_bytes(&passphrase, "passphrase")?;
    let salt = arg_bytes(&salt, "salt")?;
    Ok(json!({ "$bytes": pbkdf2_sha512(&passphrase, &salt, KDF_ITERATIONS, KEY_SIZE) }))
}

/// Port of `decrypt_page` (`wr/crypto.py:80`).
pub fn decrypt_page(
    raw: Value,
    page_key: Value,
    page_number: i64,
    main_page_one: bool,
) -> Result<Value, String> {
    let raw = arg_bytes(&raw, "raw")?;
    let page_key = page_key_of(&page_key)?;
    if raw.len() != PAGE_SIZE {
        return Err(protocol_error("read_error", "page is not 4096 bytes"));
    }
    let offset = if main_page_one { SALT_SIZE } else { 0 };
    if offset != 0 && raw[..SALT_SIZE] != page_key.salt[..] {
        return Err(protocol_error(
            "read_error",
            "page-1 salt does not match key",
        ));
    }
    let body = &raw[offset..];
    let split = PAGE_SIZE - offset - RESERVED;
    let ciphertext = &body[..split];
    let iv = &body[split..split + IV_SIZE];
    let stored = &body[split + IV_SIZE..];
    let expected = expected_hmac(&page_key, ciphertext, iv, page_number);
    if stored.ct_eq(&expected).unwrap_u8() != 1 {
        return Err(protocol_error("key_unavailable", "page HMAC mismatch"));
    }
    let mut buf = ciphertext.to_vec();
    let plaintext = cbc::Decryptor::<Aes256>::new_from_slices(&page_key.key, iv)
        .map_err(|e| format!("ValueError: {e}"))?
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| format!("ValueError: {e}"))?;
    let plaintext = if main_page_one {
        let mut v = SQLITE_HEADER.to_vec();
        v.extend_from_slice(plaintext);
        v
    } else {
        plaintext.to_vec()
    };
    Ok(json!({ "$bytes": plaintext }))
}

/// Port of `encrypt_page` (`wr/crypto.py:101`).
pub fn encrypt_page(
    usable: Value,
    page_key: Value,
    page_number: i64,
    main_page_one: bool,
) -> Result<Value, String> {
    let usable = arg_bytes(&usable, "usable")?;
    let page_key = page_key_of(&page_key)?;
    if usable.len() != PAGE_SIZE - RESERVED {
        return Err("ValueError: usable page must be page_size - reserved".to_string());
    }
    let plaintext = if main_page_one {
        &usable[SALT_SIZE..]
    } else {
        &usable[..]
    };
    let iv = [0u8; IV_SIZE];
    let mut buf = plaintext.to_vec();
    let msg_len = buf.len();
    let ciphertext = cbc::Encryptor::<Aes256>::new_from_slices(&page_key.key, &iv)
        .map_err(|e| format!("ValueError: {e}"))?
        .encrypt_padded_mut::<NoPadding>(&mut buf, msg_len)
        .map_err(|e| format!("ValueError: {e}"))?
        .to_vec();
    let mac = expected_hmac(&page_key, &ciphertext, &iv, page_number);
    let mut body = ciphertext;
    body.extend_from_slice(&iv);
    body.extend_from_slice(&mac);
    let out = if main_page_one {
        let mut v = page_key.salt.clone();
        v.extend_from_slice(&body);
        v
    } else {
        body
    };
    Ok(json!({ "$bytes": out }))
}

/// Python's `type(v).__name__`, as it appears in `len()` failures.
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

/// Whether Python's `len(v)` succeeds: numbers, booleans and `None` raise `TypeError`.
fn is_sized(v: &Value) -> bool {
    matches!(v, Value::String(_) | Value::Array(_) | Value::Object(_))
}

fn no_len_error(v: &Value) -> String {
    format!("TypeError: object of type '{}' has no len()", type_name(v))
}

/// Port of `is_valid_sqlite_page_one` (`wr/crypto.py:116`).
///
/// The original starts with `if len(usable) < 100 or usable[:16] != SQLITE_HEADER`. A value with no
/// `len()` (int, bool, None) raises `TypeError`; any other non-`bytes` value fails the header
/// comparison and returns `False`.
pub fn is_valid_sqlite_page_one(usable: Value) -> Result<bool, String> {
    let Some(usable) = bytes_of(&usable) else {
        if !is_sized(&usable) {
            return Err(no_len_error(&usable));
        }
        return Ok(false);
    };
    if usable.len() < 100 || usable[..16] != *SQLITE_HEADER {
        return Ok(false);
    }
    let page_size = u16::from_be_bytes([usable[16], usable[17]]);
    let reserved = usable[20];
    Ok(page_size as usize == PAGE_SIZE && reserved as usize == RESERVED)
}

/// Port of `validate_key` (`wr/crypto.py:125`).
///
/// The original wraps key derivation and page-1 decryption in `except ProtocolError: return None`,
/// and `make_page_key` rejects any `len(raw_key) != 32` first. A value with no `len()` (int, bool,
/// `None`) therefore raises `TypeError` out of `validate_key` before the `try` can matter.
pub fn validate_key(
    raw_key: Value,
    salt: Value,
    page_one_ciphertext: Value,
) -> Result<Option<Value>, String> {
    if bytes_of(&raw_key).is_none() {
        if !is_sized(&raw_key) {
            return Err(no_len_error(&raw_key));
        }
        // Sized but not bytes: `len(raw_key) != 32` raises ProtocolError, which is caught.
        return Ok(None);
    }
    let (Some(raw_key), Some(salt), Some(page_one)) = (
        bytes_of(&raw_key),
        bytes_of(&salt),
        bytes_of(&page_one_ciphertext),
    ) else {
        return Ok(None);
    };
    let page_key = match make_page_key(json!({ "$bytes": raw_key }), json!({ "$bytes": salt })) {
        Ok(v) => match page_key_of(&v) {
            Ok(k) => k,
            Err(_) => return Ok(None),
        },
        Err(_) => return Ok(None),
    };
    let usable = match decrypt_page(
        json!({ "$bytes": page_one }),
        page_key_json(&page_key),
        1,
        true,
    ) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    if !is_valid_sqlite_page_one(usable)? {
        return Ok(None);
    }
    Ok(Some(page_key_json(&page_key)))
}

/// Python `bytes.fromhex`: ASCII whitespace is allowed only *between* bytes — only where an even
/// number of hex digits has been read so far (`bytes.fromhex("0 0")` raises at position 1). An odd
/// final digit count raises `ValueError` too.
fn from_hex(text: &str) -> Option<Vec<u8>> {
    let mut digits: Vec<u8> = Vec::new();
    for b in text.bytes() {
        if b.is_ascii_whitespace() {
            if !digits.len().is_multiple_of(2) {
                return None;
            }
            continue;
        }
        if !b.is_ascii_hexdigit() {
            return None;
        }
        digits.push(b);
    }
    if !digits.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(digits.len() / 2);
    for pair in digits.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

/// Port of `looks_like_key` (`wr/crypto.py:137`).
pub fn looks_like_key(hex_text: String) -> Result<Option<Value>, String> {
    if hex_text.chars().count() != 64 {
        return Ok(None);
    }
    Ok(from_hex(&hex_text).map(|b| json!({ "$bytes": b })))
}
