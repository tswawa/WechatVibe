//! Python bindings for `wr/wal.py`: generated from the signatures in `port.rs` by rust-anything.
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

fn parse_wal_inner(data: Bound<'_, PyAny>) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = crate::pyconv::FromPy::from_py(&data)?;
    let out = port::parse_wal(data)?;
    Ok(out)
}

/// `parse_wal`.
#[pyfunction]
#[pyo3(name = "parse_wal", signature = (data))]
fn parse_wal(py: Python<'_>, data: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    parse_wal_inner(data)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn parse_committed_frames_inner(data: Bound<'_, PyAny>) -> Result<Vec<serde_json::Value>, String> {
    let data: serde_json::Value = crate::pyconv::FromPy::from_py(&data)?;
    let out = port::parse_committed_frames(data)?;
    Ok(out)
}

/// `parse_committed_frames`.
#[pyfunction]
#[pyo3(name = "parse_committed_frames", signature = (data))]
fn parse_committed_frames(py: Python<'_>, data: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    parse_committed_frames_inner(data)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn build_wal_header_inner(
    page_size: Bound<'_, PyAny>,
    salt1: Bound<'_, PyAny>,
    salt2: Bound<'_, PyAny>,
    little_endian: bool,
) -> Result<serde_json::Value, String> {
    let page_size: serde_json::Value = crate::pyconv::FromPy::from_py(&page_size)?;
    let salt1: serde_json::Value = crate::pyconv::FromPy::from_py(&salt1)?;
    let salt2: serde_json::Value = crate::pyconv::FromPy::from_py(&salt2)?;
    let out = port::build_wal_header(page_size, salt1, salt2, little_endian)?;
    Ok(out)
}

/// `build_wal_header`.
#[pyfunction]
#[pyo3(name = "build_wal_header", signature = (page_size, salt1, salt2, little_endian=false))]
fn build_wal_header(
    py: Python<'_>,
    page_size: Bound<'_, PyAny>,
    salt1: Bound<'_, PyAny>,
    salt2: Bound<'_, PyAny>,
    little_endian: bool,
) -> PyResult<Py<PyAny>> {
    build_wal_header_inner(page_size, salt1, salt2, little_endian)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn build_frame_inner(
    page_number: Bound<'_, PyAny>,
    page: Bound<'_, PyAny>,
    salt1: Bound<'_, PyAny>,
    salt2: Bound<'_, PyAny>,
    s0: Bound<'_, PyAny>,
    s1: Bound<'_, PyAny>,
    commit: Bound<'_, PyAny>,
    db_size_after: Bound<'_, PyAny>,
    little_endian: bool,
) -> Result<serde_json::Value, String> {
    let page_number: serde_json::Value = crate::pyconv::FromPy::from_py(&page_number)?;
    let page: serde_json::Value = crate::pyconv::FromPy::from_py(&page)?;
    let salt1: serde_json::Value = crate::pyconv::FromPy::from_py(&salt1)?;
    let salt2: serde_json::Value = crate::pyconv::FromPy::from_py(&salt2)?;
    let s0: serde_json::Value = crate::pyconv::FromPy::from_py(&s0)?;
    let s1: serde_json::Value = crate::pyconv::FromPy::from_py(&s1)?;
    let commit: serde_json::Value = crate::pyconv::FromPy::from_py(&commit)?;
    let db_size_after: serde_json::Value = crate::pyconv::FromPy::from_py(&db_size_after)?;
    let out = port::build_frame(
        page_number,
        page,
        salt1,
        salt2,
        s0,
        s1,
        commit,
        db_size_after,
        little_endian,
    )?;
    Ok(out)
}

/// `build_frame`.
#[pyfunction]
#[pyo3(name = "build_frame", signature = (page_number, page, salt1, salt2, s0, s1, commit, db_size_after, little_endian=false))]
fn build_frame(
    py: Python<'_>,
    page_number: Bound<'_, PyAny>,
    page: Bound<'_, PyAny>,
    salt1: Bound<'_, PyAny>,
    salt2: Bound<'_, PyAny>,
    s0: Bound<'_, PyAny>,
    s1: Bound<'_, PyAny>,
    commit: Bound<'_, PyAny>,
    db_size_after: Bound<'_, PyAny>,
    little_endian: bool,
) -> PyResult<Py<PyAny>> {
    build_frame_inner(
        page_number,
        page,
        salt1,
        salt2,
        s0,
        s1,
        commit,
        db_size_after,
        little_endian,
    )
    .map_err(error)
    .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

#[pymodule]
#[pyo3(name = "_native")]
fn native_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(parse_wal, m)?)?;
    m.add_function(wrap_pyfunction!(parse_committed_frames, m)?)?;
    m.add_function(wrap_pyfunction!(build_wal_header, m)?)?;
    m.add_function(wrap_pyfunction!(build_frame, m)?)?;
    Ok(())
}
