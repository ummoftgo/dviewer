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
        Step::Index(nth) => {
            if let Some(position) = position(index, id, *nth) {
                out.extend(index.children(id, position, 1));
            }
        }
        Step::Slice { start, end, step } => {
            // A node that has no children gives an empty stride, so a slice
            // over a scalar needs no special case.
            let count = index.node(id).map_or(0, |node| node.child_count);
            if let Some(stride) = slice_stride(count, *start, *end, *step) {
                pick(index, id, &stride, out);
            }
        }
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

/// Which child a `[n]` means, or none if it is past either end.
///
/// A negative index counts from the end, which needs the number of children —
/// and the index has that already (`child_count`), so no walking is needed to
/// work out *which* child. Reaching it is still a walk; see `pick`.
fn position(index: &TreeIndex, id: u32, nth: i64) -> Option<u32> {
    if nth >= 0 {
        return u32::try_from(nth).ok();
    }
    let count = i64::from(index.node(id)?.child_count);
    u32::try_from(count + nth).ok()
}

/// The child positions a slice selects: every `step`th one from `first`
/// through `last`.
///
/// Held as a stride rather than a list of positions on purpose. `[0:1000000]`
/// selects a million children, and a viewer that built a million-entry list of
/// *positions* before going to look for the nodes would pay for the answer
/// twice.
#[derive(Debug, PartialEq, Eq)]
struct Stride {
    first: u32,
    last: u32,
    step: u32,
}

/// Turn `start:end:step` into a stride over a run of `count` children.
///
/// This is RFC 9535 §2.3.4.2.2, which is longer than it looks because five
/// things interact: either bound may be absent, either may be negative, the
/// step may be negative, and the defaults for the two bounds *swap* when it
/// is. The RFC's own procedure is followed rather than reinvented — the
/// tests below are its table.
///
/// The direction is not kept. A negative step selects the same children as
/// its mirror, in the opposite order, and `select` sorts what it gathers into
/// document order anyway — a viewer highlights nodes, and a highlight has no
/// order to reverse.
fn slice_stride(count: u32, start: Option<i64>, end: Option<i64>, step: i64) -> Option<Stride> {
    if step == 0 {
        // Not an error: the RFC says a zero step selects nothing, and it is
        // the only reading that terminates.
        return None;
    }
    let len = i64::from(count);
    let from_end = |i: i64| if i >= 0 { i } else { len + i };

    // A step at least as long as the run selects only where it starts, so
    // clamping the magnitude here loses nothing and keeps the arithmetic below
    // inside i64 even for `[::-9223372036854775808]`.
    let stride = i64::from(step.unsigned_abs().min(u64::from(count.max(1))) as u32);

    let (first, last) = if step > 0 {
        let lower = start.map_or(0, from_end).clamp(0, len);
        let upper = end.map_or(len, from_end).clamp(0, len);
        if lower >= upper {
            return None;
        }
        // lower, lower+stride, ... while < upper
        let taken = (upper - lower + stride - 1) / stride;
        (lower, lower + (taken - 1) * stride)
    } else {
        let upper = start.map_or(len - 1, from_end).clamp(-1, len - 1);
        let lower = end.map_or(-len - 1, from_end).clamp(-1, len - 1);
        if upper <= lower {
            return None;
        }
        // upper, upper-stride, ... while > lower
        let taken = (upper - lower + stride - 1) / stride;
        (upper - (taken - 1) * stride, upper)
    };

    Some(Stride {
        first: first as u32,
        last: last as u32,
        step: stride as u32,
    })
}

/// The children a stride names, found in one pass.
///
/// Children are laid out end to end in the index, so getting to the nth one
/// means stepping over the n-1 before it — the same cost as scrolling to that
/// row. One pass serves the whole stride rather than one pass per position.
fn pick(index: &TreeIndex, id: u32, stride: &Stride, out: &mut Vec<u32>) {
    let Some(node) = index.node(id) else { return };
    let end = id + node.subtree_size;
    let mut child = id + 1;
    let mut position = 0u32;
    while child < end && position <= stride.last {
        if position >= stride.first && (position - stride.first) % stride.step == 0 {
            out.push(child);
        }
        child += index.nodes[child as usize].subtree_size;
        position += 1;
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
mod tests {
    use super::*;

    /// RFC 9535 §2.3.4.3, whose examples run over a seven-element array. The
    /// expected values there are elements; what this function has is
    /// positions, and for `["a".."g"]` those are the same thing.
    fn sliced(count: u32, start: Option<i64>, end: Option<i64>, step: i64) -> Vec<u32> {
        let Some(stride) = slice_stride(count, start, end, step) else {
            return Vec::new();
        };
        (stride.first..=stride.last)
            .filter(|p| (p - stride.first) % stride.step == 0)
            .collect()
    }

    #[test]
    fn the_slice_table_from_the_rfc() {
        // $[1:3] -> b c
        assert_eq!(sliced(7, Some(1), Some(3), 1), [1, 2]);
        // $[5:] -> f g
        assert_eq!(sliced(7, Some(5), None, 1), [5, 6]);
        // $[1:5:2] -> b d
        assert_eq!(sliced(7, Some(1), Some(5), 2), [1, 3]);
        // $[5:1:-2] -> f d, which this returns in document order
        assert_eq!(sliced(7, Some(5), Some(1), -2), [3, 5]);
        // $[::-1] -> g f e d c b a, likewise
        assert_eq!(sliced(7, None, None, -1), [0, 1, 2, 3, 4, 5, 6]);
        // $[:] and $[::] -> everything
        assert_eq!(sliced(7, None, None, 1), [0, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn the_edges_of_a_slice() {
        assert_eq!(sliced(7, Some(0), Some(0), 1), [0u32; 0], "an empty run");
        assert_eq!(sliced(7, None, None, 0), [0u32; 0], "a step of zero selects nothing");
        assert_eq!(sliced(7, Some(-100), None, 1), [0, 1, 2, 3, 4, 5, 6], "clamped");
        assert_eq!(sliced(7, None, Some(100), 1), [0, 1, 2, 3, 4, 5, 6], "clamped");
        assert_eq!(sliced(7, Some(3), Some(1), 1), [0u32; 0], "backwards with a forward step");
        assert_eq!(sliced(7, Some(-2), None, 1), [5, 6], "counted from the end");
        assert_eq!(sliced(7, Some(1), Some(3), -1), [0u32; 0], "forwards with a backward step");
        assert_eq!(sliced(0, None, None, 1), [0u32; 0], "nothing to slice");
        assert_eq!(sliced(1, None, None, -1), [0]);
        // A step longer than the run selects only where it starts.
        assert_eq!(sliced(7, None, None, 100), [0]);
        assert_eq!(sliced(7, None, None, i64::MIN), [6]);
    }
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

    fn ids(source: &str) -> Vec<u32> {
        let index = index();
        let steps = parse(source).expect("parse");
        select(&index, DOC.as_bytes(), &steps)
    }

    /// Over a real array, and against the long way round: `[-1]` and `[1:2]`
    /// have to land on the node `[1]` does.
    #[test]
    fn an_index_from_the_end_reaches_the_same_node() {
        let last = ids("$.items[1]");
        assert_eq!(last.len(), 1);
        assert_eq!(ids("$.items[-1]"), last);
        assert_eq!(ids("$.items[1:2]"), last);
        assert_eq!(ids("$.items[-1:]"), last);

        let first = ids("$.items[0]");
        assert_eq!(ids("$.items[-2]"), first);
        assert_eq!(ids("$.items[:1]"), first);

        // Both, in document order, however they were asked for.
        let both = ids("$.items[*]");
        assert_eq!(both.len(), 2);
        assert_eq!(ids("$.items[:]"), both);
        assert_eq!(ids("$.items[::-1]"), both, "reversed, then put back in order");
        assert_eq!(ids("$.items[-5:5]"), both, "clamped at both ends");

        // Past either end is nothing, not an error.
        assert!(ids("$.items[9]").is_empty());
        assert!(ids("$.items[-9]").is_empty());
        assert!(ids("$.items[5:9]").is_empty());

        // A slice over something that is not an array is nothing.
        assert!(ids("$.count[0:2]").is_empty());
        assert!(ids("$.count[-1]").is_empty());
    }
}
