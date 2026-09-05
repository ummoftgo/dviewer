//! Steps to nodes.
//!
//! Every step narrows a set of node ids, and the set starts at the root.
//! Nothing here builds a document — a step is a question about the index,
//! and the index already knows a node's children and its key.

use std::sync::atomic::AtomicBool;

use super::filter::{matches, Budget};
use super::Step;
use crate::error::{Error, Result};
use crate::tree::index::TreeIndex;
use crate::tree::text;

/// The nodes an expression selects, in document order.
///
/// The root is where the document starts — node 0, or its children when the
/// scanner wrapped several top-level values in a synthetic array, because in
/// that case `$` means the file rather than the wrapper this app invented.
pub fn select(
    index: &TreeIndex,
    bytes: &[u8],
    steps: &[Step],
    cancel: &AtomicBool,
) -> Result<Vec<u32>> {
    if index.nodes.is_empty() {
        return Ok(Vec::new());
    }
    select_from(index, bytes, vec![0u32], steps, &mut Budget::new(cancel))
}

/// The same, starting somewhere other than the root.
///
/// A filter's own query starts at the node being asked about, and shares this
/// walk rather than having one of its own — `@.a.b` inside a filter has to
/// mean what `.a.b` means outside it.
pub(crate) fn select_from(
    index: &TreeIndex,
    bytes: &[u8],
    from: Vec<u32>,
    steps: &[Step],
    budget: &mut Budget<'_>,
) -> Result<Vec<u32>> {
    let mut current = from;
    let mut at = 0usize;

    while at < steps.len() {
        let mut next: Vec<u32> = budget.buffer();
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
            Step::Descend if matches_key(steps.get(at + 1)) => {
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
            Step::Descend if std::matches!(steps.get(at + 1), Some(Step::Any)) => {
                for &id in &current {
                    let Some(node) = index.node(id) else { continue };
                    next.extend(id + 1..id + node.subtree_size);
                }
                at += 2;
            }
            // Everything else after `..`, filters included. The step is
            // applied at each node of the subtree as the walk reaches it, so
            // nothing is collected only to be thrown away: `next` grows by
            // what matched, not by what was considered.
            Step::Descend if at + 1 < steps.len() => {
                for &id in &current {
                    let Some(node) = index.node(id) else { continue };
                    for descendant in id..id + node.subtree_size {
                        apply(index, bytes, &steps[at + 1], descendant, &mut next, budget)?;
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
                    apply(index, bytes, step, id, &mut next, budget)?;
                }
                at += 1;
            }
        }
        // The steps that only narrow are bounded by what they select, but `..`
        // is bounded by the file, so one look between steps costs nothing and
        // keeps a `$..` over 38 million nodes answerable.
        if budget.cancelled() {
            return Err(Error::Cancelled);
        }
        next.sort_unstable();
        next.dedup();
        budget.recycle(std::mem::replace(&mut current, next));
        if current.is_empty() {
            break;
        }
    }
    Ok(current)
}

/// Whether the next step is a name, spelled out because `matches!` is shadowed
/// here by the filter's own `matches`.
fn matches_key(step: Option<&Step>) -> bool {
    std::matches!(step, Some(Step::Key(_)))
}

/// One step, applied to one node, appending what it selects.
fn apply(
    index: &TreeIndex,
    bytes: &[u8],
    step: &Step,
    id: u32,
    out: &mut Vec<u32>,
    budget: &mut Budget<'_>,
) -> Result<()> {
    match step {
        Step::Any => out.extend(children(index, id)),
        Step::Index(nth) => {
            if let Some(position) = position(index, id, *nth) {
                out.extend(index.children(id, position, 1));
            }
        }
        // Each selector applied to the same node. The results are sorted and
        // deduplicated with everything else at the end of the step, so
        // `[0,0]` and `[1,0]` both give one node and document order.
        Step::Union(selectors) => {
            for selector in selectors {
                apply(index, bytes, selector, id, out, budget)?;
            }
        }
        // The question is asked of the children, one at a time, and only the
        // answers are kept. No list of candidates is built — over `$..[?...]`
        // that list would be every node in the document.
        Step::Filter(expr) => {
            for child in children(index, id) {
                if matches(index, bytes, expr, child, budget)? {
                    out.push(child);
                }
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
    Ok(())
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
        let steps = parse("$..owner.team").expect("parse");
        assert_eq!(
            steps,
            [Step::Descend, Step::Key("owner".into()), Step::Key("team".into())]
        );
        let found = ids("$..owner.team");
        assert_eq!(found.len(), 2, "one team per item");

        // And the long way round gives the same nodes.
        assert_eq!(ids("$.items[*].meta.owner.team"), found);
    }

    fn ids(source: &str) -> Vec<u32> {
        let index = index();
        let steps = parse(source).expect("parse");
        select(&index, DOC.as_bytes(), &steps, &AtomicBool::new(false)).expect("select")
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

    /// A union is the union: every node any of its selectors names, once each
    /// and in document order.
    #[test]
    fn a_union_gathers_without_repeating() {
        let both = ids("$.items[*]");
        assert_eq!(both.len(), 2);
        assert_eq!(ids("$.items[0,1]"), both);
        assert_eq!(ids("$.items[1,0]"), both, "the order asked for does not matter");
        assert_eq!(ids("$.items[0,0]"), ids("$.items[0]"), "and neither does repeating");
        assert_eq!(ids("$.items[0,-1]"), both, "counted from both ends");
        assert_eq!(ids("$.items[0,9]"), ids("$.items[0]"), "a part that names nothing");

        // Names and indices in one bracket, over the wrapper object.
        let named = ids("$['generated','count']");
        assert_eq!(named.len(), 2);
        assert_eq!(named, ids("$[\"count\",\"generated\"]"));

        // A union may hold a slice, and the answer is the same either way.
        assert_eq!(ids("$.items[0:1,1:2]"), both);
    }
}

/// The example document from RFC 9535 §1.5, and the answers its own tables
/// give — plus `expensive`, which §2.3.5.3 uses to show a filter reaching
/// outside the run it is filtering.
#[cfg(test)]
mod against_the_rfc {
    use super::super::parse;
    use super::*;
    use crate::tree::index::{Syntax, TreeIndex};
    use crate::tree::scanner::{scan, ScanLimits};
    use crate::tree::text;
    use std::sync::Arc;

    const DOC: &str = r#"{
        "store": {
            "book": [
                { "category": "reference",
                  "author": "Nigel Rees",
                  "title": "Sayings of the Century",
                  "price": 8.95 },
                { "category": "fiction",
                  "author": "Evelyn Waugh",
                  "title": "Sword of Honour",
                  "price": 12.99 },
                { "category": "fiction",
                  "author": "Herman Melville",
                  "title": "Moby Dick",
                  "isbn": "0-553-21311-3",
                  "price": 8.99 },
                { "category": "fiction",
                  "author": "J. R. R. Tolkien",
                  "title": "The Lord of the Rings",
                  "isbn": "0-395-19395-8",
                  "price": 22.99 }
            ],
            "bicycle": { "color": "red", "price": 399 }
        },
        "expensive": 10
    }"#;

    fn index() -> Arc<TreeIndex> {
        let scanned =
            scan(DOC.as_bytes(), &ScanLimits::default(), |_| {}, &|| false).expect("scan");
        Arc::new(TreeIndex::new(scanned.nodes, scanned.synthetic_root, Syntax::Json))
    }

    /// What an expression selects, as the values a reader would see.
    fn values(source: &str) -> Vec<String> {
        let index = index();
        let steps = parse(source).expect(source);
        let found = select(&index, DOC.as_bytes(), &steps, &AtomicBool::new(false)).expect(source);
        found
            .iter()
            .map(|id| {
                let node = index.node(*id).expect("node");
                text::decode_scalar(DOC.as_bytes(), node).0
            })
            .collect()
    }

    /// The titles of what an expression selected, for the queries that select
    /// whole books.
    fn titles(source: &str) -> Vec<String> {
        values(&format!("{source}.title"))
    }

    #[test]
    fn the_filters_from_the_rfc() {
        // §2.3.5.3: every book cheaper than ten.
        assert_eq!(
            titles("$..book[?@.price<10]"),
            ["Sayings of the Century", "Moby Dick"]
        );
        // The idiomatic spelling of the same thing.
        assert_eq!(titles("$..book[?(@.price < 10)]"), titles("$..book[?@.price<10]"));

        // Existence: the two books that have an ISBN.
        assert_eq!(titles("$..book[?@.isbn]"), ["Moby Dick", "The Lord of the Rings"]);
        // And the two that do not.
        assert_eq!(
            titles("$..book[?!@.isbn]"),
            ["Sayings of the Century", "Sword of Honour"]
        );

        // A string comparison.
        assert_eq!(
            titles("$.store.book[?@.author == 'Nigel Rees']"),
            ["Sayings of the Century"]
        );

        // Reaching outside the run being filtered. The bicycle is in here too,
        // because `$..` visits it: everything priced above `$.expensive`.
        assert_eq!(
            values("$..[?@.price > $.expensive].price"),
            ["12.99", "22.99", "399"]
        );

        // Logic, and both spellings of grouping.
        assert_eq!(
            titles("$..book[?@.price < 10 && @.category == 'fiction']"),
            ["Moby Dick"]
        );
        assert_eq!(
            titles("$..book[?@.isbn || @.price < 9]"),
            ["Sayings of the Century", "Moby Dick", "The Lord of the Rings"]
        );
        assert_eq!(titles("$..book[?!(@.price < 20)]"), ["The Lord of the Rings"]);
    }

    #[test]
    fn the_other_selectors_over_the_same_document() {
        // §2.3.3, §2.3.4, §2.3.6 against the book array.
        assert_eq!(titles("$..book[-1]"), ["The Lord of the Rings"]);
        assert_eq!(
            titles("$..book[0,1]"),
            ["Sayings of the Century", "Sword of Honour"]
        );
        assert_eq!(
            titles("$..book[:2]"),
            ["Sayings of the Century", "Sword of Honour"]
        );
        assert_eq!(
            titles("$..book[::2]"),
            ["Sayings of the Century", "Moby Dick"]
        );
        assert_eq!(titles("$..book[1:3]"), ["Sword of Honour", "Moby Dick"]);
        // Reversed, and back in document order.
        assert_eq!(titles("$..book[::-1]").len(), 4);
        // A union of a name and an index over one book.
        assert_eq!(
            values("$..book[0]['author','category']"),
            ["reference", "Nigel Rees"],
            "in document order, which is where the keys are"
        );
    }

    /// Numbers compare as numbers however each side was written, and a
    /// comparison between two different kinds of thing is simply false.
    #[test]
    fn the_comparison_rules_the_rfc_lays_down() {
        // 8.95 < 10 with one written whole and one not.
        assert_eq!(titles("$..book[?@.price < 8.99]"), ["Sayings of the Century"]);
        assert_eq!(titles("$..book[?@.price <= 8.99]").len(), 2);

        // A string against a number: never equal, and never ordered.
        assert!(titles("$..book[?@.title < 10]").is_empty());
        assert!(titles("$..book[?@.title == 10]").is_empty());
        assert_eq!(titles("$..book[?@.title != 10]").len(), 4, "and so all differ");

        // An integer too wide for `i64` became a float, and it still has to
        // compare as the large number it is rather than as an error or a zero.
        assert_eq!(titles("$..book[?@.price < 9223372036854775808]").len(), 4);
        assert!(titles("$..book[?@.price > 9223372036854775808]").is_empty());
        assert_eq!(
            titles("$..book[?9223372036854775808 > 1]").len(),
            4,
            "true of every child, however wide the number was written"
        );

        // A missing value equals a missing value and nothing else.
        assert_eq!(titles("$..book[?@.isbn == @.nothing]").len(), 2, "the two without");
        assert!(titles("$..book[?@.isbn == 'x']").is_empty());
        assert!(titles("$..book[?@.nothing < 1]").is_empty(), "unordered");

        // A filter asks its question of the *children* of where it is, so
        // reaching the bicycle's colour means filtering `store`, not the
        // bicycle — whose children are already the scalars.
        assert_eq!(values("$.store[?@.color == 'red'].color"), ["red"]);
        assert!(values("$.store.bicycle[?@.color == 'red']").is_empty());
    }

    /// RFC 9535 §2.4.4–§2.4.8, one section at a time, over this document.
    #[test]
    fn the_five_functions_from_the_rfc() {
        // §2.4.4 — the length of a string is in code points, and the length of
        // an object or an array is how many things are in it.
        assert_eq!(titles("$..book[?length(@.title) < 10]"), ["Moby Dick"]);
        assert_eq!(
            titles("$..book[?length(@) == 5]"),
            ["Moby Dick", "The Lord of the Rings"],
            "the two with an isbn have a fifth member"
        );
        // A number has no length, and Nothing is not less than anything.
        assert!(titles("$..book[?length(@.price) < 10]").is_empty());

        // §2.4.5 — count takes the query a comparison could not.
        assert_eq!(titles("$..book[?count(@.*) == 5]").len(), 2);
        assert_eq!(
            values("$.store[?count(@..*) == 2].color"),
            ["red"],
            "the bicycle holds two nodes and the book array holds far more"
        );

        // §2.4.6 — `match` is the whole string.
        assert_eq!(titles("$..book[?match(@.category, 'fict.*')]").len(), 3);
        assert!(
            titles("$..book[?match(@.category, 'fict')]").is_empty(),
            "and not a part of it"
        );
        // §2.4.7 — `search` is any part of it.
        assert_eq!(titles("$..book[?search(@.category, 'fict')]").len(), 3);
        assert_eq!(
            titles("$..book[?search(@.author, '[MT]')]"),
            ["Moby Dick", "The Lord of the Rings"]
        );
        // Neither matches something that is not text.
        assert!(titles("$..book[?search(@.price, '8')]").is_empty());

        // §2.4.8 — one node has a value; a query that finds several has none.
        assert_eq!(values("$.store[?value(@..color) == 'red'].color"), ["red"]);
        assert_eq!(
            values("$.store[?value(@..price) == 399].price"),
            ["399"],
            "the bicycle holds one price; the book array holds four, which is no value"
        );

        // A function's result is a value, so it may stand on either side.
        assert_eq!(titles("$..book[?count(@.*) == length(@)]").len(), 4);
    }

    /// A pattern the document holds, rather than one the query wrote out.
    ///
    /// The compiled form is cached one deep, so this also asks whether the
    /// cache answers for the second node and the ones after it.
    #[test]
    fn a_pattern_can_come_from_the_document() {
        let doc = r#"{
            "want": "^b",
            "rows": [ {"v": "abc"}, {"v": "bcd"}, {"v": "bde"}, {"v": 7} ]
        }"#;
        let scanned =
            scan(doc.as_bytes(), &ScanLimits::default(), |_| {}, &|| false).expect("scan");
        let index = Arc::new(TreeIndex::new(
            scanned.nodes,
            scanned.synthetic_root,
            Syntax::Json,
        ));
        let found = |source: &str| {
            let steps = parse(source).expect(source);
            select(&index, doc.as_bytes(), &steps, &AtomicBool::new(false))
                .expect(source)
                .len()
        };
        assert_eq!(found("$.rows[?search(@.v, $.want)]"), 2);
        // A pattern that is not a string matches nothing, rather than failing
        // the query — the pattern came out of the document.
        assert_eq!(found("$.rows[?search(@.v, $.rows[3].v)]"), 0);
    }

    /// A value longer than a row can show is still compared whole.
    ///
    /// This is the defect the test exists for: the display path cuts a scalar
    /// at `VALUE_PREVIEW_CHARS`, and comparing the cut text would make two
    /// strings that differ only after it come back equal.
    #[test]
    fn a_long_value_is_compared_to_its_end() {
        let long = "x".repeat(text::VALUE_PREVIEW_CHARS + 200);
        let other = format!("{long}-and-more");
        let doc = format!(
            r#"{{ "rows": [ {{ "v": "{long}" }}, {{ "v": "{other}" }} ] }}"#
        );
        let scanned =
            scan(doc.as_bytes(), &ScanLimits::default(), |_| {}, &|| false).expect("scan");
        let index = Arc::new(TreeIndex::new(
            scanned.nodes,
            scanned.synthetic_root,
            Syntax::Json,
        ));
        let idle = AtomicBool::new(false);

        let hits = |source: &str| {
            let steps = parse(source).expect(source);
            select(&index, doc.as_bytes(), &steps, &idle).expect(source).len()
        };

        // Both strings share their first `VALUE_PREVIEW_CHARS` characters, so
        // a comparison over the preview would find two of each of these.
        assert_eq!(hits(&format!("$.rows[?@.v == '{long}']")), 1);
        assert_eq!(hits(&format!("$.rows[?@.v == '{other}']")), 1);
        assert_eq!(hits(&format!("$.rows[?@.v != '{long}']")), 1);
    }

    /// A filter is the one step whose cost follows the file, so it has to be
    /// possible to give up on it.
    #[test]
    fn a_filter_can_be_cancelled() {
        let index = index();
        let steps = parse("$..[?@.price > 0]").expect("parse");
        let cancelled = AtomicBool::new(true);
        assert!(std::matches!(
            select(&index, DOC.as_bytes(), &steps, &cancelled),
            Err(crate::error::Error::Cancelled)
        ));
    }

    /// Comparing whole objects is not here, and says so rather than answering
    /// "no" to every node.
    #[test]
    fn comparing_two_objects_is_refused_rather_than_answered() {
        let index = index();
        let steps = parse("$..book[?@.price == @.nothing.deeper]").expect("parse");
        assert!(select(&index, DOC.as_bytes(), &steps, &AtomicBool::new(false)).is_ok());

        let steps = parse("$..[?@.book == 1]").expect("parse");
        match select(&index, DOC.as_bytes(), &steps, &AtomicBool::new(false)) {
            // The whole sentence. It goes to whoever wrote the query, so
            // the spacing is part of what is under test.
            Err(crate::error::Error::BadPath { detail }) => assert!(
                detail.contains(
                    "comparing an object or an array is not supported yet; compare one of its values instead"
                ),
                "{detail}"
            ),
            other => panic!("{other:?}"),
        }
    }
}
