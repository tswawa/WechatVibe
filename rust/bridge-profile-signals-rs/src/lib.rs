//! Python bindings for `profile_signals.py`: generated from the signatures in `port.rs` by rust-anything.
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

fn validate_style_evidence_inner(evidence: Bound<'_, PyAny>) -> Result<serde_json::Value, String> {
    let evidence: serde_json::Value = crate::pyconv::FromPy::from_py(&evidence)?;
    let out = port::validate_style_evidence(evidence)?;
    Ok(out)
}

/// `validate_style_evidence`.
#[pyfunction]
#[pyo3(name = "validate_style_evidence", signature = (evidence))]
fn validate_style_evidence(py: Python<'_>, evidence: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    validate_style_evidence_inner(evidence)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn historical_mood_inner(
    rows: Bound<'_, PyAny>,
    kaomoji: Bound<'_, PyAny>,
) -> Result<serde_json::Value, String> {
    let rows: serde_json::Value = crate::pyconv::FromPy::from_py(&rows)?;
    let kaomoji: serde_json::Value = crate::pyconv::FromPy::from_py(&kaomoji)?;
    let out = port::historical_mood(rows, kaomoji)?;
    Ok(out)
}

/// `historical_mood`.
#[pyfunction]
#[pyo3(name = "historical_mood", signature = (rows, kaomoji))]
fn historical_mood(
    py: Python<'_>,
    rows: Bound<'_, PyAny>,
    kaomoji: Bound<'_, PyAny>,
) -> PyResult<Py<PyAny>> {
    historical_mood_inner(rows, kaomoji)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn style_traits_inner(rows: Bound<'_, PyAny>) -> Result<serde_json::Value, String> {
    let rows: serde_json::Value = crate::pyconv::FromPy::from_py(&rows)?;
    let out = port::style_traits(rows)?;
    Ok(out)
}

/// `style_traits`.
#[pyfunction]
#[pyo3(name = "style_traits", signature = (rows))]
fn style_traits(py: Python<'_>, rows: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    style_traits_inner(rows)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn keyword_counts_inner(texts: Bound<'_, PyAny>) -> Result<serde_json::Value, String> {
    let texts: serde_json::Value = crate::pyconv::FromPy::from_py(&texts)?;
    let out = port::keyword_counts(texts)?;
    Ok(out)
}

/// `keyword_counts`.
#[pyfunction]
#[pyo3(name = "keyword_counts", signature = (texts))]
fn keyword_counts(py: Python<'_>, texts: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    keyword_counts_inner(texts)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn keywords_from_counts_inner(counts: Bound<'_, PyAny>) -> Result<serde_json::Value, String> {
    let counts: serde_json::Value = crate::pyconv::FromPy::from_py(&counts)?;
    let out = port::keywords_from_counts(counts)?;
    Ok(out)
}

/// `keywords_from_counts`.
#[pyfunction]
#[pyo3(name = "keywords_from_counts", signature = (counts))]
fn keywords_from_counts(py: Python<'_>, counts: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    keywords_from_counts_inner(counts)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn keywords_from_texts_inner(texts: Bound<'_, PyAny>) -> Result<serde_json::Value, String> {
    let texts: serde_json::Value = crate::pyconv::FromPy::from_py(&texts)?;
    let out = port::keywords_from_texts(texts)?;
    Ok(out)
}

/// `keywords_from_texts`.
#[pyfunction]
#[pyo3(name = "keywords_from_texts", signature = (texts))]
fn keywords_from_texts(py: Python<'_>, texts: Bound<'_, PyAny>) -> PyResult<Py<PyAny>> {
    keywords_from_texts_inner(texts)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn summary_from_signals_inner(
    rows: Bound<'_, PyAny>,
    mood: Bound<'_, PyAny>,
    keywords: Bound<'_, PyAny>,
    group: bool,
) -> Result<serde_json::Value, String> {
    let rows: serde_json::Value = crate::pyconv::FromPy::from_py(&rows)?;
    let mood: serde_json::Value = crate::pyconv::FromPy::from_py(&mood)?;
    let keywords: serde_json::Value = crate::pyconv::FromPy::from_py(&keywords)?;
    let out = port::summary_from_signals(rows, mood, keywords, group)?;
    Ok(out)
}

/// `summary_from_signals`.
#[pyfunction]
#[pyo3(name = "summary_from_signals", signature = (rows, mood, keywords, group=false))]
fn summary_from_signals(
    py: Python<'_>,
    rows: Bound<'_, PyAny>,
    mood: Bound<'_, PyAny>,
    keywords: Bound<'_, PyAny>,
    group: bool,
) -> PyResult<Py<PyAny>> {
    summary_from_signals_inner(rows, mood, keywords, group)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

fn summary_from_aggregate_inner(
    count: Bound<'_, PyAny>,
    broad: Bound<'_, PyAny>,
    mood: Bound<'_, PyAny>,
    keywords: Bound<'_, PyAny>,
    group: bool,
) -> Result<serde_json::Value, String> {
    let count: serde_json::Value = crate::pyconv::FromPy::from_py(&count)?;
    let broad: serde_json::Value = crate::pyconv::FromPy::from_py(&broad)?;
    let mood: serde_json::Value = crate::pyconv::FromPy::from_py(&mood)?;
    let keywords: serde_json::Value = crate::pyconv::FromPy::from_py(&keywords)?;
    let out = port::summary_from_aggregate(count, broad, mood, keywords, group)?;
    Ok(out)
}

/// `summary_from_aggregate`.
#[pyfunction]
#[pyo3(name = "summary_from_aggregate", signature = (count, broad, mood, keywords, group=false))]
fn summary_from_aggregate(
    py: Python<'_>,
    count: Bound<'_, PyAny>,
    broad: Bound<'_, PyAny>,
    mood: Bound<'_, PyAny>,
    keywords: Bound<'_, PyAny>,
    group: bool,
) -> PyResult<Py<PyAny>> {
    summary_from_aggregate_inner(count, broad, mood, keywords, group)
        .map_err(error)
        .and_then(|v| crate::pyconv::ToPy::to_py(&v, py))
}

#[pymodule]
#[pyo3(name = "_native")]
fn native_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(validate_style_evidence, m)?)?;
    m.add_function(wrap_pyfunction!(historical_mood, m)?)?;
    m.add_function(wrap_pyfunction!(style_traits, m)?)?;
    m.add_function(wrap_pyfunction!(keyword_counts, m)?)?;
    m.add_function(wrap_pyfunction!(keywords_from_counts, m)?)?;
    m.add_function(wrap_pyfunction!(keywords_from_texts, m)?)?;
    m.add_function(wrap_pyfunction!(summary_from_signals, m)?)?;
    m.add_function(wrap_pyfunction!(summary_from_aggregate, m)?)?;
    Ok(())
}
