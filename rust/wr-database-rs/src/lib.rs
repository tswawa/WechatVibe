//! Python bindings for `wr/database.py`: generated from the signatures in `port.rs` by rust-anything.
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
    // `wr.errors.ProtocolError` is a class of the project: `port.rs` writes it as
    // `ProtocolError(<code>): <message>` and it is instantiated from the original package here.
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

/// Instantiate a project exception class: `wr.errors.<class>(code, message)`.
fn project_error(class: &str, code: &str, text: &str) -> Option<PyErr> {
    Python::attach(|py| {
        let cls = match py.import("wr.errors").and_then(|m| m.getattr(class)) {
            Ok(c) => c,
            Err(_) => fallback_exception(py, class)?,
        };
        match cls.call1((code, text)) {
            Ok(instance) => Some(PyErr::from_value(instance)),
            Err(_) => None,
        }
    })
}

/// Same-name equivalent when the original package is not importable (replay sandbox).
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
    let file = std::ffi::CString::new("database_rs_errors.py").ok()?;
    let name = std::ffi::CString::new("database_rs_errors").ok()?;
    let module = PyModule::from_code(py, &code, &file, &name).ok()?;
    module.getattr(class).ok()
}

fn md5_username_inner(username: Bound<'_, PyAny>) -> Result<String, String> {
    let username: serde_json::Value = crate::pyconv::FromPy::from_py(&username)?;
    let out = port::md5_username(username)?;
    Ok(out)
}

/// `md5_username`.
#[pyfunction]
#[pyo3(name = "md5_username", signature = (username))]
fn md5_username(username: Bound<'_, PyAny>) -> PyResult<String> {
    md5_username_inner(username).map_err(error)
}

fn contact_id_for_inner(
    account_id: Bound<'_, PyAny>,
    username: Bound<'_, PyAny>,
) -> Result<String, String> {
    let account_id: serde_json::Value = crate::pyconv::FromPy::from_py(&account_id)?;
    let username: serde_json::Value = crate::pyconv::FromPy::from_py(&username)?;
    let out = port::contact_id_for(account_id, username)?;
    Ok(out)
}

/// `contact_id_for`.
#[pyfunction]
#[pyo3(name = "contact_id_for", signature = (account_id, username))]
fn contact_id_for(account_id: Bound<'_, PyAny>, username: Bound<'_, PyAny>) -> PyResult<String> {
    contact_id_for_inner(account_id, username).map_err(error)
}

fn message_id_for_inner(
    account_id: Bound<'_, PyAny>,
    username: Bound<'_, PyAny>,
    shard_id: Bound<'_, PyAny>,
    local_id: Bound<'_, PyAny>,
) -> Result<String, String> {
    let account_id: serde_json::Value = crate::pyconv::FromPy::from_py(&account_id)?;
    let username: serde_json::Value = crate::pyconv::FromPy::from_py(&username)?;
    let shard_id: serde_json::Value = crate::pyconv::FromPy::from_py(&shard_id)?;
    let local_id: serde_json::Value = crate::pyconv::FromPy::from_py(&local_id)?;
    let out = port::message_id_for(account_id, username, shard_id, local_id)?;
    Ok(out)
}

/// `message_id_for`.
#[pyfunction]
#[pyo3(name = "message_id_for", signature = (account_id, username, shard_id, local_id))]
fn message_id_for(
    account_id: Bound<'_, PyAny>,
    username: Bound<'_, PyAny>,
    shard_id: Bound<'_, PyAny>,
    local_id: Bound<'_, PyAny>,
) -> PyResult<String> {
    message_id_for_inner(account_id, username, shard_id, local_id).map_err(error)
}

fn normalize_time_inner(value: Bound<'_, PyAny>) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = crate::pyconv::FromPy::from_py(&value)?;
    let out = port::normalize_time(value)?;
    Ok(out)
}

/// `normalize_time`.
#[pyfunction]
#[pyo3(name = "normalize_time", signature = (value))]
fn normalize_time(py: Python<'_>, value: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    normalize_time_inner(value)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn extract_text_inner(
    message_content: Bound<'_, PyAny>,
    compress_content: Bound<'_, PyAny>,
) -> Result<Option<String>, String> {
    let message_content: serde_json::Value = crate::pyconv::FromPy::from_py(&message_content)?;
    let compress_content: serde_json::Value = crate::pyconv::FromPy::from_py(&compress_content)?;
    let out = port::extract_text(message_content, compress_content)?;
    Ok(out)
}

/// `extract_text`.
#[pyfunction]
#[pyo3(name = "extract_text", signature = (message_content, compress_content))]
fn extract_text(
    message_content: Bound<'_, PyAny>,
    compress_content: Bound<'_, PyAny>,
) -> PyResult<Option<String>> {
    extract_text_inner(message_content, compress_content).map_err(error)
}

fn classify_kind_inner(local_type: Bound<'_, PyAny>) -> Result<String, String> {
    let local_type: serde_json::Value = crate::pyconv::FromPy::from_py(&local_type)?;
    let out = port::classify_kind(local_type)?;
    Ok(out)
}

/// `classify_kind`.
#[pyfunction]
#[pyo3(name = "classify_kind", signature = (local_type))]
fn classify_kind(local_type: Bound<'_, PyAny>) -> PyResult<String> {
    classify_kind_inner(local_type).map_err(error)
}

fn encode_cursor_inner(cursor: Bound<'_, PyAny>) -> Result<Option<serde_json::Value>, String> {
    let cursor: serde_json::Value = crate::pyconv::FromPy::from_py(&cursor)?;
    let out = port::encode_cursor(cursor)?;
    Ok(out)
}

/// `encode_cursor`.
#[pyfunction]
#[pyo3(name = "encode_cursor", signature = (cursor))]
fn encode_cursor(py: Python<'_>, cursor: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    encode_cursor_inner(cursor)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn decode_cursor_inner(raw: Bound<'_, PyAny>) -> Result<Option<serde_json::Value>, String> {
    let raw: serde_json::Value = crate::pyconv::FromPy::from_py(&raw)?;
    let out = port::decode_cursor(raw)?;
    Ok(out)
}

/// `decode_cursor`.
#[pyfunction]
#[pyo3(name = "decode_cursor", signature = (raw))]
fn decode_cursor(py: Python<'_>, raw: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    decode_cursor_inner(raw)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn sqlite_image_from_pages_inner(
    pages: Bound<'_, PyAny>,
    page_size: i64,
    reserved: i64,
    commit_pages: Option<i64>,
) -> Result<serde_json::Value, String> {
    let pages: serde_json::Value = crate::pyconv::FromPy::from_py(&pages)?;
    let out = port::sqlite_image_from_pages(pages, page_size, reserved, commit_pages)?;
    Ok(out)
}

/// `sqlite_image_from_pages`.
#[pyfunction]
#[pyo3(name = "sqlite_image_from_pages", signature = (pages, page_size=4096, reserved=80, commit_pages=None))]
fn sqlite_image_from_pages(
    py: Python<'_>,
    pages: Bound<'_, PyAny>,
    page_size: i64,
    reserved: i64,
    commit_pages: Option<i64>,
) -> PyResult<Py<PyAny>> {
    sqlite_image_from_pages_inner(pages, page_size, reserved, commit_pages)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

#[pymodule]
#[pyo3(name = "_native")]
fn native_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(md5_username, m)?)?;
    m.add_function(wrap_pyfunction!(contact_id_for, m)?)?;
    m.add_function(wrap_pyfunction!(message_id_for, m)?)?;
    m.add_function(wrap_pyfunction!(normalize_time, m)?)?;
    m.add_function(wrap_pyfunction!(extract_text, m)?)?;
    m.add_function(wrap_pyfunction!(classify_kind, m)?)?;
    m.add_function(wrap_pyfunction!(encode_cursor, m)?)?;
    m.add_function(wrap_pyfunction!(decode_cursor, m)?)?;
    m.add_function(wrap_pyfunction!(sqlite_image_from_pages, m)?)?;
    Ok(())
}
