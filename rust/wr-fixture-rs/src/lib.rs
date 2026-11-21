//! Python bindings for `wr/fixture.py`: generated from the signatures in `port.rs` by rust-anything.
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
    let file = std::ffi::CString::new("fixture_rs_errors.py").ok()?;
    let name = std::ffi::CString::new("fixture_rs_errors").ok()?;
    let module = PyModule::from_code(py, &code, &file, &name).ok()?;
    module.getattr(class).ok()
}

fn load_fixture_inner(manifest_path: String) -> Result<Vec<serde_json::Value>, String> {
    let out = port::load_fixture(manifest_path)?;
    Ok(out)
}

/// `load_fixture`.
#[pyfunction]
#[pyo3(name = "load_fixture", signature = (manifest_path))]
fn load_fixture(py: Python<'_>, manifest_path: String) -> PyResult<Py<PyAny>> {
    load_fixture_inner(manifest_path)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

#[pymodule]
#[pyo3(name = "_native")]
fn native_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(load_fixture, m)?)?;
    Ok(())
}
