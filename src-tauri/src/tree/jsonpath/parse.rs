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
    // The parts of the syntax this does not do. Naming them is the point: a
    // reader who wrote one gets told, rather than getting a shorter answer.
    if trimmed.starts_with('?') {
        return Err(unsupported(source, "filter expressions `[?(...)]`"));
    }
    if trimmed.contains(':') {
        return Err(unsupported(source, "slices `[1:3]`"));
    }
    if trimmed.contains(',') {
        return Err(unsupported(source, "unions `[0,2]`"));
    }
    if let Some(name) = quoted(trimmed) {
        return Ok(Step::Key(name));
    }
    trimmed
        .parse::<u32>()
        .map(Step::Index)
        .map_err(|_| bad(source, &format!("`[{trimmed}]` is neither an index nor a name")))
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

    /// What the subset does not cover is refused by name. A reader who wrote a
    /// filter should be told it is not there, not handed a shorter answer.
    #[test]
    fn what_is_not_supported_is_refused_by_name() {
        for (source, expected) in [
            ("$[?(@.a==1)]", "filter"),
            ("$[1:3]", "slice"),
            ("$[0,2]", "union"),
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
