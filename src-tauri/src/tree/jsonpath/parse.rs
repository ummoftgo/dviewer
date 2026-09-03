//! Text to steps.
//!
//! One pass, left to right. Every refusal names what it found and where,
//! because the reader is holding an expression they believe in.

use super::{bad, unsupported, Step};
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
    for (_, ch) in chars.by_ref() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None if ch == '\'' || ch == '"' => quote = Some(ch),
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

    let trimmed = inner.trim();
    if trimmed == "*" {
        return Ok(Step::Any);
    }
    // A quoted name is tested first, and that is not cosmetic: a key may hold
    // any of the characters the shapes below are recognised by. `['a:b']` is a
    // name, not a slice.
    if let Some(name) = quoted(trimmed) {
        return Ok(Step::Key(name));
    }
    // The parts of the syntax this does not do. Naming them is the point: a
    // reader who wrote one gets told, rather than getting a shorter answer.
    if trimmed.starts_with('?') {
        return Err(unsupported(source, "filter expressions `[?(...)]`"));
    }
    if trimmed.contains(',') {
        return Err(unsupported(source, "unions `[0,2]`"));
    }
    if trimmed.contains(':') {
        return slice(source, trimmed);
    }
    trimmed
        .parse::<i64>()
        .map(Step::Index)
        .map_err(|_| bad(source, &format!("`[{trimmed}]` is neither an index nor a name")))
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

    /// What the subset does not cover is refused by name. A reader who wrote a
    /// filter should be told it is not there, not handed a shorter answer.
    #[test]
    fn what_is_not_supported_is_refused_by_name() {
        for (source, expected) in [("$[?(@.a==1)]", "filter"), ("$[0,2]", "union")] {
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
