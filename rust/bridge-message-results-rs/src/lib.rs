//! Python bindings for `message_results.py`: generated from the signatures in `port.rs` by rust-anything.
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

fn validate_fine_result_inner(
    response: Bound<'_, PyAny>,
    version: Bound<'_, PyAny>,
    side: Bound<'_, PyAny>,
) -> Result<serde_json::Value, String> {
    let response: serde_json::Value = crate::pyconv::FromPy::from_py(&response)?;
    let version: serde_json::Value = crate::pyconv::FromPy::from_py(&version)?;
    let side: serde_json::Value = crate::pyconv::FromPy::from_py(&side)?;
    let out = port::validate_fine_result(response, version, side)?;
    Ok(out)
}

/// `validate_fine_result`.
#[pyfunction]
#[pyo3(name = "validate_fine_result", signature = (response, version, side))]
fn validate_fine_result(
    py: Python<'_>,
    response: Bound<'_, PyAny>,
    version: Bound<'_, PyAny>,
    side: Bound<'_, PyAny>,
) -> PyResult<Py<PyAny>> {
    validate_fine_result_inner(response, version, side)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn validate_portrait_result_inner(
    response: Bound<'_, PyAny>,
    version: Bound<'_, PyAny>,
    side: Bound<'_, PyAny>,
) -> Result<serde_json::Value, String> {
    let response: serde_json::Value = crate::pyconv::FromPy::from_py(&response)?;
    let version: serde_json::Value = crate::pyconv::FromPy::from_py(&version)?;
    let side: serde_json::Value = crate::pyconv::FromPy::from_py(&side)?;
    let out = port::validate_portrait_result(response, version, side)?;
    Ok(out)
}

/// `validate_portrait_result`.
#[pyfunction]
#[pyo3(name = "validate_portrait_result", signature = (response, version, side))]
fn validate_portrait_result(
    py: Python<'_>,
    response: Bound<'_, PyAny>,
    version: Bound<'_, PyAny>,
    side: Bound<'_, PyAny>,
) -> PyResult<Py<PyAny>> {
    validate_portrait_result_inner(response, version, side)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

#[pymodule]
#[pyo3(name = "_native")]
fn native_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(validate_fine_result, m)?)?;
    m.add_function(wrap_pyfunction!(validate_portrait_result, m)?)?;
    Ok(())
}
