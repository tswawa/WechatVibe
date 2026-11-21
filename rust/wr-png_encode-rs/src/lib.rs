//! Python bindings for `wr/png_encode.py`: generated from the signatures in `port.rs` by rust-anything.
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

fn encode_png_rgb_inner(
    width: i64,
    height: i64,
    rgb: Bound<'_, PyAny>,
) -> Result<serde_json::Value, String> {
    let rgb: serde_json::Value = crate::pyconv::FromPy::from_py(&rgb)?;
    let out = port::encode_png_rgb(width, height, rgb)?;
    Ok(out)
}

/// `encode_png_rgb`.
#[pyfunction]
#[pyo3(name = "encode_png_rgb", signature = (width, height, rgb))]
fn encode_png_rgb(
    py: Python<'_>,
    width: i64,
    height: i64,
    rgb: Bound<'_, PyAny>,
) -> PyResult<Py<PyAny>> {
    encode_png_rgb_inner(width, height, rgb)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

#[pymodule]
#[pyo3(name = "_native")]
fn native_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(encode_png_rgb, m)?)?;
    Ok(())
}
