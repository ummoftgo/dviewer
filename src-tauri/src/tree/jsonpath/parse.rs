//! Text to steps.
//!
//! One pass, left to right. Every refusal names what it found and where,
//! because the reader is holding an expression they believe in.

use super::filter::parse_filter;
use super::{bad, Step};
use crate::error::Result;

/// Parse an expression, or say why it cannot be one.
pub fn parse(source: &str) -> Result<Vec<Step>> {
    let text = source.trim();
    let mut chars = text.char_indices().peekable();

    match chars.next() {
        Some((_, '$')) => {}
        // A path expression names where to start. Without `$` this is a
        // substring, which is what the literal reading is for.
        _ => return Err(bad(source, "expressions start at `$`")),
    }

    let mut steps = Vec::new();
    while let Some(&(at, ch)) = chars.peek() {
        match ch {
            '.' => {
                chars.next();
                if matches!(chars.peek(), Some((_, '.'))) {
                    chars.next();
                    steps.push(Step::Descend);
                    // `..` may be followed by a name, a bracket, or nothing.
                    if matches!(chars.peek(), Some((_, '[')) | None) {
                        continue;
                    }
                }
                if matches!(chars.peek(), Some((_, '*'))) {
                    chars.next();
                    steps.push(Step::Any);
                    continue;
                }
                let name = take_name(&mut chars);
                if name.is_empty() {
                    return Err(bad(source, "a `.` needs a name after it"));
                }
                steps.push(Step::Key(name));
            }
            '[' => {
                chars.next();
                steps.push(bracket(source, &mut chars)?);
            }
            _ => {
                return Err(bad(
                    source,
                    &format!("expected `.` or `[` at position {}", at + 1),
                ))
            }
        }
    }
    Ok(steps)
}

type Chars<'a> = std::iter::Peekable<std::str::CharIndices<'a>>;

fn take_name(chars: &mut Chars<'_>) -> String {
    let mut name = String::new();
    while let Some(&(_, ch)) = chars.peek() {
        if ch == '.' || ch == '[' {
            break;
        }
        name.push(ch);
        chars.next();
    }
    name
}

/// What is inside `[...]`.
fn bracket(source: &str, chars: &mut Chars<'_>) -> Result<Step> {
    let mut inner = String::new();
    let mut closed = false;
    let mut quote: Option<char> = None;
    let mut depth = 0usize;
    for (_, ch) in chars.by_ref() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            // A bracket may hold another one: a filter's query has brackets
            // of its own (`[?@.items[0] == 1]`). Stopping at the first `]`
            // would cut that filter in half.
            None if ch == '[' => depth += 1,
            None if ch == ']' && depth > 0 => depth -= 1,
            None if ch == ']' => {
                closed = true;
                break;
            }
            None => {}
        }
        if !closed {
            inner.push(ch);
        }
    }
    if !closed {
        return Err(bad(source, "a `[` with no `]`"));
    }

    bracket_step(source, &inner)
}

/// What one `[...]` means, for whoever has already found its contents.
///
/// Shared with `filter`, whose queries may hold brackets of their own — the
/// two readings have to agree about what `['a']` and `[-1]` are.
pub(crate) fn bracket_step(source: &str, inner: &str) -> Result<Step> {
    let trimmed = inner.trim();
    let parts = split_selectors(trimmed);
    if parts.len() > 1 {
        let mut selectors = Vec::with_capacity(parts.len());
        for part in parts {
            selectors.push(selector(source, part.trim())?);
        }
        return Ok(Step::Union(selectors));
    }
    selector(source, trimmed)
}

/// One selector: what may stand alone in a bracket, or between two commas.
fn selector(source: &str, trimmed: &str) -> Result<Step> {
    if trimmed == "*" {
        return Ok(Step::Any);
    }
    // A quoted name is tested first here too, and for the same reason.
    if let Some(name) = quoted(trimmed) {
        return Ok(Step::Key(name));
    }
    // The parts of the syntax this does not do. Naming them is the point: a
    // reader who wrote one gets told, rather than getting a shorter answer.
    if let Some(body) = trimmed.strip_prefix('?') {
        return parse_filter(source, body).map(Step::Filter);
    }
    if trimmed.contains(':') {
        return slice(source, trimmed);
    }
    trimmed
        .parse::<i64>()
        .map(Step::Index)
        .map_err(|_| bad(source, &format!("`[{trimmed}]` is neither an index nor a name")))
}

/// Cut a bracket's contents at its top-level commas.
///
/// Not `split(',')`: a comma may be inside a quoted name (`['a,b']`) or inside
/// a filter (`[?@.a=='x,y']`), and cutting there would make two halves of one
/// selector. So quotes and brackets are counted, and only a comma outside all
/// of them separates.
fn split_selectors(inner: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut quote: Option<char> = None;
    let mut depth = 0usize;

    for (at, ch) in inner.char_indices() {
        match quote {
            // A closing quote. Escapes inside a name are the scanner's
            // business, not this one's — what matters here is only where the
            // name ends.
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None => match ch {
                '\'' | '"' => quote = Some(ch),
                '(' | '[' => depth += 1,
                ')' | ']' => depth = depth.saturating_sub(1),
                ',' if depth == 0 => {
                    parts.push(&inner[start..at]);
                    start = at + 1;
                }
                _ => {}
            },
        }
    }
    parts.push(&inner[start..]);
    parts
}

/// `[start:end:step]`, with any of the three left out.
///
/// Only the shape is read here. What the numbers *mean* — which of them count
/// from the end, what an absent one defaults to, which direction the run goes
/// — depends on the length of the array, which is not known until a node is
/// in hand. That belongs to `select::slice_stride`.
fn slice(source: &str, trimmed: &str) -> Result<Step> {
    let parts: Vec<&str> = trimmed.split(':').collect();
    if parts.len() > 3 {
        return Err(bad(
            source,
            &format!("`[{trimmed}]` has more than `start:end:step`"),
        ));
    }

    let number = |part: &str| -> Result<Option<i64>> {
        let part = part.trim();
        if part.is_empty() {
            return Ok(None);
        }
        part.parse::<i64>()
            .map(Some)
            .map_err(|_| bad(source, &format!("`{part}` in `[{trimmed}]` is not a whole number")))
    };

    Ok(Step::Slice {
        start: number(parts[0])?,
        end: number(parts[1])?,
        // An absent step is 1. A step of 0 selects nothing rather than looping
        // forever, which is what the RFC says and also the only safe reading.
        step: parts.get(2).copied().map(number).transpose()?.flatten().unwrap_or(1),
    })
}

fn quoted(text: &str) -> Option<String> {
    for mark in ['\'', '"'] {
        if text.len() >= 2 && text.starts_with(mark) && text.ends_with(mark) {
            return Some(text[1..text.len() - 1].to_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    fn steps(source: &str) -> Vec<Step> {
        parse(source).expect("parse")
    }

    #[test]
    fn the_shapes_the_subset_covers() {
        assert_eq!(steps("$"), []);
        assert_eq!(steps("$.a"), [Step::Key("a".into())]);
        assert_eq!(steps("$.a.b"), [Step::Key("a".into()), Step::Key("b".into())]);
        assert_eq!(steps("$[\"a b\"]"), [Step::Key("a b".into())]);
        assert_eq!(steps("$['a.b']"), [Step::Key("a.b".into())]);
        assert_eq!(steps("$[3]"), [Step::Index(3)]);
        assert_eq!(steps("$[-1]"), [Step::Index(-1)]);
        assert_eq!(steps("$[*]"), [Step::Any]);
        assert_eq!(steps("$.*"), [Step::Any]);
        assert_eq!(steps("$..a"), [Step::Descend, Step::Key("a".into())]);
        assert_eq!(steps("$.."), [Step::Descend]);
        assert_eq!(
            steps("$.items[2].name"),
            [
                Step::Key("items".into()),
                Step::Index(2),
                Step::Key("name".into())
            ]
        );
        // A key with a dot in it has to be bracketed, which is what brackets
        // are for.
        assert_eq!(
            steps("$..owner['e.mail']"),
            [
                Step::Descend,
                Step::Key("owner".into()),
                Step::Key("e.mail".into())
            ]
        );
    }

    fn slice(source: &str) -> (Option<i64>, Option<i64>, i64) {
        match parse(source).expect("parse").remove(0) {
            Step::Slice { start, end, step } => (start, end, step),
            other => panic!("{source} gave {other:?}"),
        }
    }

    /// The shapes a slice can be written in. What they *mean* needs an array
    /// to mean it against, and that is tested in `select`.
    #[test]
    fn a_slice_may_leave_any_of_its_three_out() {
        assert_eq!(slice("$[1:3]"), (Some(1), Some(3), 1));
        assert_eq!(slice("$[1:]"), (Some(1), None, 1));
        assert_eq!(slice("$[:3]"), (None, Some(3), 1));
        assert_eq!(slice("$[:]"), (None, None, 1));
        assert_eq!(slice("$[::]"), (None, None, 1));
        assert_eq!(slice("$[1:5:2]"), (Some(1), Some(5), 2));
        assert_eq!(slice("$[::-1]"), (None, None, -1));
        assert_eq!(slice("$[-3:-1]"), (Some(-3), Some(-1), 1));
        assert_eq!(slice("$[ 1 : 3 ]"), (Some(1), Some(3), 1), "spaces are allowed");
        // A step of zero parses. It selects nothing, which is the RFC's answer
        // and the only one that ends.
        assert_eq!(slice("$[::0]"), (None, None, 0));
    }

    /// A key may hold any of the characters a slice is recognised by, so the
    /// quotes are what decide. This used to read `['a:b']` as a slice and
    /// refuse it.
    #[test]
    fn a_quoted_name_is_a_name_whatever_is_in_it() {
        assert_eq!(steps("$['a:b']"), [Step::Key("a:b".into())]);
        assert_eq!(steps("$['1:3']"), [Step::Key("1:3".into())]);
        assert_eq!(steps("$[\"-1\"]"), [Step::Key("-1".into())]);
        assert_eq!(steps("$['*']"), [Step::Key("*".into())]);
    }

    #[test]
    fn a_slice_that_is_not_numbers_is_refused() {
        for source in ["$[1:x]", "$[a:]", "$[1:2:3:4]", "$[1.5:]"] {
            assert!(
                matches!(parse(source), Err(Error::BadPath { .. })),
                "{source} should not parse"
            );
        }
    }

    /// A comma separates selectors, and what may stand between two commas is
    /// what may stand alone in a bracket.
    #[test]
    fn a_union_holds_whatever_a_bracket_holds() {
        assert_eq!(
            steps("$[0,2]"),
            [Step::Union(vec![Step::Index(0), Step::Index(2)])]
        );
        assert_eq!(
            steps("$['a','b']"),
            [Step::Union(vec![Step::Key("a".into()), Step::Key("b".into())])]
        );
        // Mixed, spaced, and with the shapes from the two steps before this.
        assert_eq!(
            steps("$[0, -1, 'name', *, 1:3]"),
            [Step::Union(vec![
                Step::Index(0),
                Step::Index(-1),
                Step::Key("name".into()),
                Step::Any,
                Step::Slice { start: Some(1), end: Some(3), step: 1 },
            ])]
        );
        // One selector is that selector, not a union of one.
        assert_eq!(steps("$[0]"), [Step::Index(0)]);
    }

    /// A comma inside a name is part of the name. `split(',')` would make two
    /// selectors out of one, and neither half would parse.
    #[test]
    fn a_comma_inside_quotes_does_not_separate() {
        assert_eq!(steps("$['a,b']"), [Step::Key("a,b".into())]);
        assert_eq!(
            steps("$['a,b', 'c']"),
            [Step::Union(vec![Step::Key("a,b".into()), Step::Key("c".into())])]
        );
        assert_eq!(steps("$[\"x, y\"]"), [Step::Key("x, y".into())]);
    }

    #[test]
    fn a_union_with_a_part_that_is_not_a_selector_is_refused() {
        for source in ["$[0,]", "$[,0]", "$[0,x]", "$[0,,1]"] {
            assert!(
                matches!(parse(source), Err(Error::BadPath { .. })),
                "{source} should not parse"
            );
        }
    }

    /// What the subset does not cover is refused by name. A reader who wrote a
    /// filter should be told it is not there, not handed a shorter answer.
    #[test]
    fn what_is_not_supported_is_refused_by_name() {
        for (source, expected) in [
            ("$[?length(@.*) > 2]", "has to be a value"),
            ("$[?count(1) == 1]", "has to be a query"),
            ("$[?match(@.a, 'x') == true]", "already a test"),
            ("$[?@.items[*] == 1]", "more than one node"),
        ] {
            match parse(source) {
                Err(Error::BadPath { detail }) => {
                    assert!(detail.contains(expected), "{source} said {detail}")
                }
                other => panic!("{source} gave {other:?}"),
            }
        }
    }

    /// A query that is not an expression at all is refused before anything is
    /// searched — it is a literal query in the wrong box.
    #[test]
    fn a_query_that_is_not_an_expression_is_refused() {
        for source in ["items", ".items", "$items", "$.", "$[", "$[a]"] {
            assert!(
                matches!(parse(source), Err(Error::BadPath { .. })),
                "{source} should not parse"
            );
        }
    }
}
