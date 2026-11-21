//! Public entry points; implementation helpers live in `helpers.rs`.

#[path = "helpers.rs"]
mod helpers;

pub use helpers::{
    historical_mood, keyword_counts, keywords_from_counts, keywords_from_texts, style_traits,
    summary_from_aggregate, summary_from_signals, validate_style_evidence,
};
