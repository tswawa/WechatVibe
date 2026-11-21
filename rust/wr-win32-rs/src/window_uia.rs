//! Bounded UIA survey model.
//!
//! `window_uia.py` walks a UI Automation tree with strict node/depth limits and never logs text.
//! The tree shape and pruning rules live here and are unit tested with synthetic elements. The
//! COM adapter that materialises the tree from the live desktop is not implemented; callers get an
//! explicit `uia-unavailable` response instead of a fabricated result.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub struct Element {
    pub control_type: String,
    pub name: String,
    pub automation_id: String,
    pub enabled: bool,
    pub offscreen: bool,
    pub rect: (i32, i32, i32, i32),
    pub children: Vec<Element>,
}

fn payload(element: &Element) -> Value {
    json!({
        "controlType": element.control_type,
        "name": element.name,
        "automationId": element.automation_id,
        "enabled": element.enabled,
        "offscreen": element.offscreen,
        "rect": {
            "x": element.rect.0,
            "y": element.rect.1,
            "width": element.rect.2,
            "height": element.rect.3,
        },
    })
}

/// Port of the bounded tree walk. Returns the flattened element payloads.
pub fn probe_tree(root: &Element, max_nodes: usize, max_depth: usize) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let mut nodes = 0usize;
    // Breadth-first so the shallowest, most useful nodes survive the node budget.
    let mut queue: Vec<(&Element, usize)> = vec![(root, 0)];
    while let Some((element, depth)) = queue.pop() {
        if nodes >= max_nodes {
            break;
        }
        if depth > max_depth || element.offscreen {
            continue;
        }
        out.push(payload(element));
        nodes += 1;
        for child in element.children.iter().rev() {
            queue.push((child, depth + 1));
        }
    }
    json!({
        "ok": true,
        "nodes": out,
        "truncated": nodes >= max_nodes,
    })
}
