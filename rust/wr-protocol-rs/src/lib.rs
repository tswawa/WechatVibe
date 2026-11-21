//! Python bindings for `wr/protocol.py`: generated from the signatures in `port.rs` by rust-anything.
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
    // `wr.errors.ProtocolError` is a class of the project, not of the stdlib: `port.rs` writes it
    // as `ProtocolError(<code>): <message>` and it is instantiated from the original package here.
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
/// When that package is not importable (the replay sandbox only puts this crate's `python/` folder
/// on `sys.path`), an equivalent class is defined on the fly: same name, same constructor, same
/// `str()`. Deployed inside the app the real class wins.
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
    let file = std::ffi::CString::new("protocol_rs_errors.py").ok()?;
    let name = std::ffi::CString::new("protocol_rs_errors").ok()?;
    let module = PyModule::from_code(py, &code, &file, &name).ok()?;
    module.getattr(class).ok()
}

fn validate_request_inner(request: Bound<'_, PyAny>) -> Result<serde_json::Value, String> {
    let request: serde_json::Value = crate::pyconv::FromPy::from_py(&request)?;
    let out = port::validate_request(request)?;
    Ok(out)
}

/// `validate_request`.
#[pyfunction]
#[pyo3(name = "validate_request", signature = (request))]
fn validate_request(py: Python<'_>, request: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    validate_request_inner(request)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn ok_inner(
    request_id: Bound<'_, PyAny>,
    result: Bound<'_, PyAny>,
) -> Result<serde_json::Value, String> {
    let request_id: serde_json::Value = crate::pyconv::FromPy::from_py(&request_id)?;
    let result: serde_json::Value = crate::pyconv::FromPy::from_py(&result)?;
    let out = port::ok(request_id, result)?;
    Ok(out)
}

/// `ok`.
#[pyfunction]
#[pyo3(name = "ok", signature = (request_id, result))]
fn ok(
    py: Python<'_>,
    request_id: Bound<'_, PyAny>,
    result: Bound<'_, PyAny>,
) -> PyResult<Py<PyAny>> {
    ok_inner(request_id, result)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn fail_inner(
    request_id: Bound<'_, PyAny>,
    code: Bound<'_, PyAny>,
    message: Bound<'_, PyAny>,
) -> Result<serde_json::Value, String> {
    let request_id: serde_json::Value = crate::pyconv::FromPy::from_py(&request_id)?;
    let code: serde_json::Value = crate::pyconv::FromPy::from_py(&code)?;
    let message: serde_json::Value = crate::pyconv::FromPy::from_py(&message)?;
    let out = port::fail(request_id, code, message)?;
    Ok(out)
}

/// `fail`.
#[pyfunction]
#[pyo3(name = "fail", signature = (request_id, code, message))]
fn fail(
    py: Python<'_>,
    request_id: Bound<'_, PyAny>,
    code: Bound<'_, PyAny>,
    message: Bound<'_, PyAny>,
) -> PyResult<Py<PyAny>> {
    fail_inner(request_id, code, message)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

#[pymodule]
#[pyo3(name = "_native")]
fn native_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(validate_request, m)?)?;
    m.add_function(wrap_pyfunction!(ok, m)?)?;
    m.add_function(wrap_pyfunction!(fail, m)?)?;
    Ok(())
}
