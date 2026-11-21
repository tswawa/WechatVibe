//! Python bindings for `wr/crypto.py`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use pyo3::prelude::*;

pub mod js;
pub mod port;
pub mod pyconv;
pub mod pynum;

#[allow(unused_imports)]
use pynum::Num;

fn error(message: String) -> PyErr {
    use pyo3::exceptions as e;
    // A class the project defines (`wr.errors.ProtocolError`) cannot be named from the fixed table
    // below, so `port.rs` writes it as `ProtocolError(<code>): <message>` and it is instantiated
    // from the original package here. Falls back to ValueError when that package is not importable.
    if let Some(rest) = message.strip_prefix("ProtocolError(")
        && let Some((code, text)) = rest.split_once("): ")
        && let Some(err) = project_error("ProtocolError", code, text)
    {
        return err;
    }
    let (kind, text) = message.split_once(": ").unwrap_or(("", message.as_str()));
    let text = text.to_string();
    match kind {
        "TypeError" => e::PyTypeError::new_err(text),
        "KeyError" => e::PyKeyError::new_err(text),
        "IndexError" => e::PyIndexError::new_err(text),
        "OverflowError" => e::PyOverflowError::new_err(text),
        "ZeroDivisionError" => e::PyZeroDivisionError::new_err(text),
        "AttributeError" => e::PyAttributeError::new_err(text),
        "RuntimeError" => e::PyRuntimeError::new_err(text),
        "NotImplementedError" => e::PyNotImplementedError::new_err(text),
        "LookupError" => e::PyLookupError::new_err(text),
        "ArithmeticError" => e::PyArithmeticError::new_err(text),
        "UnicodeError" => e::PyUnicodeError::new_err(text),
        "ValueError" => e::PyValueError::new_err(text),
        _ => e::PyValueError::new_err(message),
    }
}

/// Instantiate an exception class of the original package: `wr.errors.<class>(code, message)`.
///
/// When the original package is not importable (for example the replay sandbox that only puts this
/// crate's `python/` folder on `sys.path`), an equivalent class is defined on the fly: same name,
/// same `(code, message)` constructor, same `str()`. Deployed inside the app the real class wins.
fn project_error(class: &str, code: &str, text: &str) -> Option<PyErr> {
    Python::attach(|py| {
        let cls = match py.import("wr.errors").and_then(|m| m.getattr(class)) {
            Ok(c) => c,
            Err(err) => {
                crate::debug_log(&format!(
                    "wr.errors.{class} unavailable ({err}); using local class"
                ));
                fallback_exception(py, class)?
            }
        };
        match cls.call1((code, text)) {
            Ok(instance) => Some(PyErr::from_value(instance)),
            Err(err) => {
                crate::debug_log(&format!("call {class} failed: {err}"));
                None
            }
        }
    })
}

/// Define `<class>(code, message)` on the fly, shaped like `wr.errors.ProtocolError`.
fn fallback_exception<'py>(py: Python<'py>, class: &str) -> Option<Bound<'py, PyAny>> {
    use pyo3::types::PyModule;
    let source = format!(
        "class {class}(Exception):\n\
         \x20   def __init__(self, code, message=\"\"):\n\
         \x20       super().__init__(message or code)\n\
         \x20       self.code = code\n\
         \x20       self.message = message or code\n"
    );
    let code = std::ffi::CString::new(source).ok()?;
    let file = std::ffi::CString::new("crypto_rs_errors.py").ok()?;
    let name = std::ffi::CString::new("crypto_rs_errors").ok()?;
    let module = PyModule::from_code(py, &code, &file, &name).ok()?;
    module.getattr(class).ok()
}

/// Diagnostics for the exception mapping, only when `CRYPTO_RS_DEBUG` is set.
pub fn debug_log(message: &str) {
    let Ok(path) = std::env::var("CRYPTO_RS_DEBUG") else {
        return;
    };
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{message}");
    }
}

fn derive_hmac_key_inner(
    key: Bound<'_, PyAny>,
    salt: Bound<'_, PyAny>,
) -> Result<serde_json::Value, String> {
    let key: serde_json::Value = crate::pyconv::FromPy::from_py(&key)?;
    let salt: serde_json::Value = crate::pyconv::FromPy::from_py(&salt)?;
    let out = port::derive_hmac_key(key, salt)?;
    Ok(out)
}

/// `derive_hmac_key`.
#[pyfunction]
#[pyo3(name = "derive_hmac_key", signature = (key, salt))]
fn derive_hmac_key(
    py: Python<'_>,
    key: Bound<'_, PyAny>,
    salt: Bound<'_, PyAny>,
) -> PyResult<Py<PyAny>> {
    derive_hmac_key_inner(key, salt)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn make_page_key_inner(
    raw_key: Bound<'_, PyAny>,
    salt: Bound<'_, PyAny>,
) -> Result<serde_json::Value, String> {
    let raw_key: serde_json::Value = crate::pyconv::FromPy::from_py(&raw_key)?;
    let salt: serde_json::Value = crate::pyconv::FromPy::from_py(&salt)?;
    let out = port::make_page_key(raw_key, salt)?;
    Ok(out)
}

/// `make_page_key`.
#[pyfunction]
#[pyo3(name = "make_page_key", signature = (raw_key, salt))]
fn make_page_key(
    py: Python<'_>,
    raw_key: Bound<'_, PyAny>,
    salt: Bound<'_, PyAny>,
) -> PyResult<Py<PyAny>> {
    make_page_key_inner(raw_key, salt)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn derive_key_from_passphrase_inner(
    passphrase: Bound<'_, PyAny>,
    salt: Bound<'_, PyAny>,
) -> Result<serde_json::Value, String> {
    let passphrase: serde_json::Value = crate::pyconv::FromPy::from_py(&passphrase)?;
    let salt: serde_json::Value = crate::pyconv::FromPy::from_py(&salt)?;
    let out = port::derive_key_from_passphrase(passphrase, salt)?;
    Ok(out)
}

/// `derive_key_from_passphrase`.
#[pyfunction]
#[pyo3(name = "derive_key_from_passphrase", signature = (passphrase, salt))]
fn derive_key_from_passphrase(
    py: Python<'_>,
    passphrase: Bound<'_, PyAny>,
    salt: Bound<'_, PyAny>,
) -> PyResult<Py<PyAny>> {
    derive_key_from_passphrase_inner(passphrase, salt)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn decrypt_page_inner(
    raw: Bound<'_, PyAny>,
    page_key: Bound<'_, PyAny>,
    page_number: i64,
    main_page_one: bool,
) -> Result<serde_json::Value, String> {
    let raw: serde_json::Value = crate::pyconv::FromPy::from_py(&raw)?;
    let page_key: serde_json::Value = crate::pyconv::FromPy::from_py(&page_key)?;
    let out = port::decrypt_page(raw, page_key, page_number, main_page_one)?;
    Ok(out)
}

/// `decrypt_page`.
#[pyfunction]
#[pyo3(name = "decrypt_page", signature = (raw, page_key, page_number, main_page_one))]
fn decrypt_page(
    py: Python<'_>,
    raw: Bound<'_, PyAny>,
    page_key: Bound<'_, PyAny>,
    page_number: i64,
    main_page_one: bool,
) -> PyResult<Py<PyAny>> {
    decrypt_page_inner(raw, page_key, page_number, main_page_one)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn encrypt_page_inner(
    usable: Bound<'_, PyAny>,
    page_key: Bound<'_, PyAny>,
    page_number: i64,
    main_page_one: bool,
) -> Result<serde_json::Value, String> {
    let usable: serde_json::Value = crate::pyconv::FromPy::from_py(&usable)?;
    let page_key: serde_json::Value = crate::pyconv::FromPy::from_py(&page_key)?;
    let out = port::encrypt_page(usable, page_key, page_number, main_page_one)?;
    Ok(out)
}

/// `encrypt_page`.
#[pyfunction]
#[pyo3(name = "encrypt_page", signature = (usable, page_key, page_number, main_page_one))]
fn encrypt_page(
    py: Python<'_>,
    usable: Bound<'_, PyAny>,
    page_key: Bound<'_, PyAny>,
    page_number: i64,
    main_page_one: bool,
) -> PyResult<Py<PyAny>> {
    encrypt_page_inner(usable, page_key, page_number, main_page_one)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn is_valid_sqlite_page_one_inner(usable: Bound<'_, PyAny>) -> Result<bool, String> {
    let usable: serde_json::Value = crate::pyconv::FromPy::from_py(&usable)?;
    let out = port::is_valid_sqlite_page_one(usable)?;
    Ok(out)
}

/// `is_valid_sqlite_page_one`.
#[pyfunction]
#[pyo3(name = "is_valid_sqlite_page_one", signature = (usable))]
fn is_valid_sqlite_page_one(usable: Bound<'_, PyAny>) -> PyResult<bool> {
    is_valid_sqlite_page_one_inner(usable).map_err(error)
}

fn validate_key_inner(
    raw_key: Bound<'_, PyAny>,
    salt: Bound<'_, PyAny>,
    page_one_ciphertext: Bound<'_, PyAny>,
) -> Result<Option<serde_json::Value>, String> {
    let raw_key: serde_json::Value = crate::pyconv::FromPy::from_py(&raw_key)?;
    let salt: serde_json::Value = crate::pyconv::FromPy::from_py(&salt)?;
    let page_one_ciphertext: serde_json::Value =
        crate::pyconv::FromPy::from_py(&page_one_ciphertext)?;
    let out = port::validate_key(raw_key, salt, page_one_ciphertext)?;
    Ok(out)
}

/// `validate_key`.
#[pyfunction]
#[pyo3(name = "validate_key", signature = (raw_key, salt, page_one_ciphertext))]
fn validate_key(
    py: Python<'_>,
    raw_key: Bound<'_, PyAny>,
    salt: Bound<'_, PyAny>,
    page_one_ciphertext: Bound<'_, PyAny>,
) -> PyResult<Py<PyAny>> {
    validate_key_inner(raw_key, salt, page_one_ciphertext)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn looks_like_key_inner(hex_text: String) -> Result<Option<serde_json::Value>, String> {
    let out = port::looks_like_key(hex_text)?;
    Ok(out)
}

/// `looks_like_key`.
#[pyfunction]
#[pyo3(name = "looks_like_key", signature = (hex_text))]
fn looks_like_key(py: Python<'_>, hex_text: String) -> PyResult<Py<PyAny>> {
    looks_like_key_inner(hex_text)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

#[pymodule]
#[pyo3(name = "_native")]
fn native_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(derive_hmac_key, m)?)?;
    m.add_function(wrap_pyfunction!(make_page_key, m)?)?;
    m.add_function(wrap_pyfunction!(derive_key_from_passphrase, m)?)?;
    m.add_function(wrap_pyfunction!(decrypt_page, m)?)?;
    m.add_function(wrap_pyfunction!(encrypt_page, m)?)?;
    m.add_function(wrap_pyfunction!(is_valid_sqlite_page_one, m)?)?;
    m.add_function(wrap_pyfunction!(validate_key, m)?)?;
    m.add_function(wrap_pyfunction!(looks_like_key, m)?)?;
    Ok(())
}
