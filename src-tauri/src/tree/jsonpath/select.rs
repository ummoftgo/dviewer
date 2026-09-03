//! Steps to nodes.
//!
//! Every step narrows a set of node ids, and the set starts at the root.
//! Nothing here builds a document — a step is a question about the index,
//! and the index already knows a node's children and its key.

use super::Step;
use crate::tree::index::TreeIndex;
use crate::tree::text;

/// The nodes an expression selects, in document order.
///
/// The root is where the document starts — node 0, or its children when the
/// scanner wrapped several top-level values in a synthetic array, because in
/// that case `$` means the file rather than the wrapper this app invented.
pub fn select(index: &TreeIndex, bytes: &[u8], steps: &[Step]) -> Vec<u32> {
    if index.nodes.is_empty() {
        return Vec::new();
    }
    let mut current = vec![0u32];
    let mut at = 0usize;

    while at < steps.len() {
        let mut next: Vec<u32> = Vec::new();
        match &steps[at] {
            // `..` followed by anything is read as one step. Collecting the
            // subtree and then filtering it would be the same answer by way of
            // a list of every node in the document — on a 38-million-node file
            // that is 150MB of node ids to build and sort before throwing
            // nearly all of them away.
            // `..name` is every node under here that is called `name`. A node
            // called `name` is by definition a child of its parent, so the
            // answer is a pass over the subtree testing keys — not the children
            // of every node in it, which would allocate a list per node.
            Step::Descend if matches!(steps.get(at + 1), Some(Step::Key(_))) => {
                let Some(Step::Key(name)) = steps.get(at + 1) else {
                    unreachable!("just matched")
                };
                for &id in &current {
                    let Some(node) = index.node(id) else { continue };
                    for descendant in id + 1..id + node.subtree_size {
                        if named(index, bytes, descendant, name) {
                            next.push(descendant);
                        }
                    }
                }
                at += 2;
            }
            // `..*` is every node under here except the one we started from,
            // since every other node in a subtree is some node's child.
            Step::Descend if matches!(steps.get(at + 1), Some(Step::Any)) => {
                for &id in &current {
                    let Some(node) = index.node(id) else { continue };
                    next.extend(id + 1..id + node.subtree_size);
                }
                at += 2;
            }
            Step::Descend if at + 1 < steps.len() => {
                for &id in &current {
                    let Some(node) = index.node(id) else { continue };
                    for descendant in id..id + node.subtree_size {
                        apply(index, bytes, &steps[at + 1], descendant, &mut next);
                    }
                }
                at += 2;
            }
            // On its own at the end, `..` is the subtree itself.
            Step::Descend => {
                for &id in &current {
                    let Some(node) = index.node(id) else { continue };
                    next.extend(id..id + node.subtree_size);
                }
                at += 1;
            }
            step => {
                for &id in &current {
                    apply(index, bytes, step, id, &mut next);
                }
                at += 1;
            }
        }
        next.sort_unstable();
        next.dedup();
        current = next;
        if current.is_empty() {
            break;
        }
    }
    current
}

/// One step, applied to one node, appending what it selects.
fn apply(index: &TreeIndex, bytes: &[u8], step: &Step, id: u32, out: &mut Vec<u32>) {
    match step {
        Step::Any => out.extend(children(index, id)),
        Step::Index(nth) => out.extend(index.children(id, *nth, 1)),
        Step::Key(name) => {
            for child in children(index, id) {
                if named(index, bytes, child, name) {
                    out.push(child);
                }
            }
        }
        // Two in a row is the same as one: everything under everything under a
        // node is everything under it.
        Step::Descend => {
            if let Some(node) = index.node(id) {
                out.extend(id..id + node.subtree_size);
            }
        }
    }
}

/// Whether a node's key is `name`.
///
/// Compared as bytes first. A key with an escape in it has to be decoded to be
/// compared, but almost none are, and decoding every key of a 38-million-node
/// document to find the few called `notes` would be the most expensive thing in
/// the walk.
fn named(index: &TreeIndex, bytes: &[u8], id: u32, name: &str) -> bool {
    let Some(node) = index.node(id) else {
        return false;
    };
    if node.key_len == 0 {
        return false;
    }
    let start = node.key_start as usize;
    let raw = &bytes[start..start + node.key_len as usize];
    if raw.contains(&b'\\') {
        return text::decode_key(bytes, node) == name;
    }
    raw == name.as_bytes()
}

fn children(index: &TreeIndex, id: u32) -> Vec<u32> {
    index.children(id, 0, u32::MAX)
}

#[cfg(test)]
mod against_a_real_shape {
    use super::*;
    use super::super::parse;
    use crate::tree::index::{Syntax, TreeIndex};
    use crate::tree::scanner::{scan, ScanLimits};
    use std::sync::Arc;

    /// The shape `fixtures/small.json` has: a wrapper object, an array of
    /// records, and a nested object two levels down.
    const DOC: &str = r#"{
        "generated": true,
        "count": 2,
        "items": [
            {"id": 0, "meta": {"owner": {"team": "team-0"}}},
            {"id": 1, "meta": {"owner": {"team": "team-1"}}}
        ]
    }"#;

    fn index() -> Arc<TreeIndex> {
        let scanned = scan(DOC.as_bytes(), &ScanLimits::default(), |_| {}, &|| false).expect("scan");
        Arc::new(TreeIndex::new(scanned.nodes, scanned.synthetic_root, Syntax::Json))
    }

    /// Descent followed by two keys, which is what a reader actually types.
    #[test]
    fn descent_then_two_keys() {
        let index = index();
        let steps = parse("$..owner.team").expect("parse");
        assert_eq!(
            steps,
            [Step::Descend, Step::Key("owner".into()), Step::Key("team".into())]
        );
        let found = select(&index, DOC.as_bytes(), &steps);
        assert_eq!(found.len(), 2, "one team per item");

        // And the long way round gives the same nodes.
        let spelled = parse("$.items[*].meta.owner.team").expect("parse");
        assert_eq!(select(&index, DOC.as_bytes(), &spelled), found);
    }
}
