//! Python bindings for `message_contracts.py`: generated from the signatures in `port.rs` by rust-anything.
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

fn api_insight_scope_inner(source_id: Bound<'_, PyAny>) -> Result<serde_json::Value, String> {
    let source_id: serde_json::Value = crate::pyconv::FromPy::from_py(&source_id)?;
    let out = port::api_insight_scope(source_id)?;
    Ok(out)
}

/// `api_insight_scope`.
#[pyfunction]
#[pyo3(name = "api_insight_scope", signature = (source_id))]
fn api_insight_scope(py: Python<'_>, source_id: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    api_insight_scope_inner(source_id)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn valid_api_insight_label_inner(value: Bound<'_, PyAny>) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = crate::pyconv::FromPy::from_py(&value)?;
    let out = port::valid_api_insight_label(value)?;
    Ok(out)
}

/// `valid_api_insight_label`.
#[pyfunction]
#[pyo3(name = "valid_api_insight_label", signature = (value))]
fn valid_api_insight_label(py: Python<'_>, value: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    valid_api_insight_label_inner(value)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn normalize_api_insight_inner(item: Bound<'_, PyAny>) -> Result<serde_json::Value, String> {
    let item: serde_json::Value = crate::pyconv::FromPy::from_py(&item)?;
    let out = port::normalize_api_insight(item)?;
    Ok(out)
}

/// `normalize_api_insight`.
#[pyfunction]
#[pyo3(name = "normalize_api_insight", signature = (item))]
fn normalize_api_insight(py: Python<'_>, item: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    normalize_api_insight_inner(item)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

#[pymodule]
#[pyo3(name = "_native")]
fn native_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(api_insight_scope, m)?)?;
    m.add_function(wrap_pyfunction!(valid_api_insight_label, m)?)?;
    m.add_function(wrap_pyfunction!(normalize_api_insight, m)?)?;
    Ok(())
}
