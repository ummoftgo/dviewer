//! YAML and TOML, re-expressed as JSON so the tree engine can read them.
//!
//! Both formats are trees of the same shape JSON already models, and the
//! machinery that matters here — the flat pre-order index, collapsing, virtual
//! scrolling, path search — is all built on that model. Writing a second and
//! third scanner would duplicate every one of those without buying the reader
//! anything, so the parsed value is emitted as compact JSON instead and handed
//! to the existing scanner.
//!
//! The document keeps its original bytes for the raw view; only the tree is
//! built over the converted buffer.
//!
//! What this costs: unlike JSON, these are parsed into memory before being
//! re-emitted, so they are capped (`MAX_INPUT_BYTES`) rather than streamed.
//! Configuration files, which is what YAML and TOML are for, sit far below it.

use std::fmt::Write;

use serde::Deserialize;

use crate::error::{Error, Result};

/// Ceiling on a document that has to be parsed into memory. Well past any real
/// config file, and far enough below the JSON path's 4GB that the two are not
/// easily confused.
pub const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;

/// Guards the emitter's recursion. The YAML and TOML parsers have their own
/// limits, but those are theirs, not ours, and a stack overflow is not an error
/// we can report.
const MAX_DEPTH: usize = 512;

fn check_size(bytes: &[u8], what: &str) -> Result<()> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(Error::Parse(format!(
            "{what} 문서가 너무 큽니다 ({}MB). {}MB까지 읽을 수 있습니다.",
            bytes.len() / 1024 / 1024,
            MAX_INPUT_BYTES / 1024 / 1024
        )));
    }
    Ok(())
}

/// A byte-order mark is a marker, not content. The JSON, XML and CSV scanners
/// each strip their own; these two parsers are handed a `&str`, so it has to
/// come off here. TOML tolerates one, YAML refuses the whole document over it.
fn text_of<'a>(bytes: &'a [u8], what: &str) -> Result<&'a str> {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    std::str::from_utf8(body).map_err(|_| Error::Parse(format!("{what} 문서가 UTF-8이 아닙니다.")))
}

fn too_deep(what: &str) -> Error {
    Error::Parse(format!("{what} 문서의 중첩이 {MAX_DEPTH}단계를 넘습니다."))
}

/// Parse YAML and emit it as JSON text.
///
/// A stream of several documents (`---` separated) becomes a JSON array, the
/// same shape NDJSON already produces — the tree then shows one entry per
/// document instead of only the first.
pub fn yaml_to_json(bytes: &[u8]) -> Result<String> {
    use serde_yaml_ng::Value;

    check_size(bytes, "YAML")?;
    let text = text_of(bytes, "YAML")?;

    let mut docs = Vec::new();
    for document in serde_yaml_ng::Deserializer::from_str(text) {
        let value = Value::deserialize(document)
            .map_err(|e| Error::Parse(format!("YAML을 읽지 못했습니다: {e}")))?;
        docs.push(value);
    }

    let mut out = String::with_capacity(bytes.len() + bytes.len() / 4);
    match docs.len() {
        0 => out.push_str("null"),
        1 => write_yaml(&mut out, &docs[0], 0)?,
        _ => {
            out.push('[');
            for (i, doc) in docs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_yaml(&mut out, doc, 1)?;
            }
            out.push(']');
        }
    }
    Ok(out)
}

fn write_yaml(out: &mut String, value: &serde_yaml_ng::Value, depth: usize) -> Result<()> {
    use serde_yaml_ng::Value;

    if depth > MAX_DEPTH {
        return Err(too_deep("YAML"));
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => push_number(out, n.as_i64(), n.as_u64(), n.as_f64(), || n.to_string()),
        Value::String(s) => push_string(out, s),
        Value::Sequence(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_yaml(out, item, depth + 1)?;
            }
            out.push(']');
        }
        Value::Mapping(map) => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                // YAML keys can be any node; JSON keys cannot. Rendering a
                // non-string key as its scalar text keeps the entry visible
                // instead of dropping it.
                match key {
                    Value::String(s) => push_string(out, s),
                    other => push_string(out, &scalar_text(other)),
                }
                out.push(':');
                write_yaml(out, item, depth + 1)?;
            }
            out.push('}');
        }
        // `!Tag value` — the tag has no JSON counterpart, so the value survives
        // and the tag is lost. Better than refusing the whole document.
        Value::Tagged(tagged) => write_yaml(out, &tagged.value, depth)?,
    }
    Ok(())
}

fn scalar_text(value: &serde_yaml_ng::Value) -> String {
    use serde_yaml_ng::Value;
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        // A collection used as a key is vanishingly rare; show its shape.
        Value::Sequence(_) => "[복합 키]".into(),
        Value::Mapping(_) => "{복합 키}".into(),
        Value::Tagged(t) => scalar_text(&t.value),
    }
}

/// Parse TOML and emit it as JSON text.
pub fn toml_to_json(bytes: &[u8]) -> Result<String> {
    check_size(bytes, "TOML")?;
    let text = text_of(bytes, "TOML")?;

    let value: toml::Value =
        toml::from_str(text).map_err(|e| Error::Parse(format!("TOML을 읽지 못했습니다: {e}")))?;

    let mut out = String::with_capacity(bytes.len() + bytes.len() / 4);
    write_toml(&mut out, &value, 0)?;
    Ok(out)
}

fn write_toml(out: &mut String, value: &toml::Value, depth: usize) -> Result<()> {
    use toml::Value;

    if depth > MAX_DEPTH {
        return Err(too_deep("TOML"));
    }
    match value {
        Value::String(s) => push_string(out, s),
        Value::Integer(i) => {
            let _ = write!(out, "{i}");
        }
        Value::Float(f) => push_number(out, None, None, Some(*f), || f.to_string()),
        Value::Boolean(b) => out.push_str(if *b { "true" } else { "false" }),
        // Offset date-times and friends have no JSON counterpart, so they
        // travel as the text TOML spelled them with.
        Value::Datetime(dt) => push_string(out, &dt.to_string()),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_toml(out, item, depth + 1)?;
            }
            out.push(']');
        }
        Value::Table(table) => {
            out.push('{');
            for (i, (key, item)) in table.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_string(out, key);
                out.push(':');
                write_toml(out, item, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// JSON has no infinity or NaN. Rather than flatten them to null, they keep the
/// spelling their own format used and travel as strings — visibly odd in the
/// tree, which is the honest outcome.
fn push_number(
    out: &mut String,
    as_i64: Option<i64>,
    as_u64: Option<u64>,
    as_f64: Option<f64>,
    text: impl Fn() -> String,
) {
    if let Some(i) = as_i64 {
        let _ = write!(out, "{i}");
    } else if let Some(u) = as_u64 {
        let _ = write!(out, "{u}");
    } else if let Some(f) = as_f64 {
        if f.is_finite() {
            let _ = write!(out, "{f}");
        } else {
            push_string(out, &text());
        }
    } else {
        push_string(out, &text());
    }
}

fn push_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if c.is_control() => {
                let _ = write!(out, "\\u{:04X}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaml_becomes_equivalent_json() {
        let json = yaml_to_json(b"name: dviewer\nports:\n  - 80\n  - 443\nnested:\n  on: true\n")
            .expect("convert");
        assert_eq!(
            json,
            r#"{"name":"dviewer","ports":[80,443],"nested":{"on":true}}"#
        );
    }

    /// Key order is what the file says, not alphabetical — a config read out of
    /// order is harder to check against the original than one that matches it.
    #[test]
    fn yaml_keeps_document_key_order() {
        let json = yaml_to_json(b"zebra: 1\nalpha: 2\nmiddle: 3\n").expect("convert");
        assert_eq!(json, r#"{"zebra":1,"alpha":2,"middle":3}"#);
    }

    #[test]
    fn a_yaml_stream_becomes_an_array() {
        let json = yaml_to_json(b"---\na: 1\n---\na: 2\n").expect("convert");
        assert_eq!(json, r#"[{"a":1},{"a":2}]"#);
    }

    #[test]
    fn yaml_non_string_keys_survive_as_text() {
        let json = yaml_to_json(b"1: one\ntrue: yes\n").expect("convert");
        assert_eq!(json, r#"{"1":"one","true":"yes"}"#);
    }

    #[test]
    fn yaml_control_characters_are_escaped() {
        let json = yaml_to_json("a: \"x\\ty\\nz\"\n".as_bytes()).expect("convert");
        assert_eq!(json, r#"{"a":"x\ty\nz"}"#);
        // The point of escaping: the result is parseable as JSON again.
        assert!(serde_json::from_str::<serde_json::Value>(&json).is_ok());
    }

    #[test]
    fn yaml_infinities_do_not_become_null() {
        let json = yaml_to_json(b"a: .inf\nb: .nan\n").expect("convert");
        assert!(json.contains("inf"), "{json}");
        assert!(!json.contains("null"), "{json}");
        assert!(serde_json::from_str::<serde_json::Value>(&json).is_ok());
    }

    #[test]
    fn yaml_anchors_are_expanded() {
        let json = yaml_to_json(b"base: &b\n  a: 1\ncopy: *b\n").expect("convert");
        assert_eq!(json, r#"{"base":{"a":1},"copy":{"a":1}}"#);
    }

    #[test]
    fn toml_tables_keep_their_order() {
        let src = b"title = \"x\"\n[server]\nport = 8080\nhosts = [\"a\", \"b\"]\n";
        let json = toml_to_json(src).expect("convert");
        assert_eq!(
            json,
            r#"{"title":"x","server":{"port":8080,"hosts":["a","b"]}}"#
        );
    }

    #[test]
    fn toml_datetimes_travel_as_text() {
        let json = toml_to_json(b"when = 1979-05-27T07:32:00Z\n").expect("convert");
        assert_eq!(json, r#"{"when":"1979-05-27T07:32:00Z"}"#);
    }

    #[test]
    fn a_broken_document_reports_where() {
        let err = yaml_to_json(b"a: [1, 2\nb: 3\n").expect_err("should fail");
        let message = err.to_string();
        assert!(message.contains("YAML"), "{message}");
    }

    /// Windows editors add one without asking, and YAML refuses a document
    /// that starts with it.
    #[test]
    fn a_byte_order_mark_does_not_break_either_parser() {
        let yaml = yaml_to_json("\u{feff}name: dviewer\n".as_bytes()).expect("yaml");
        assert_eq!(yaml, r#"{"name":"dviewer"}"#);
        let toml = toml_to_json("\u{feff}name = \"dviewer\"\n".as_bytes()).expect("toml");
        assert_eq!(toml, r#"{"name":"dviewer"}"#);
    }

    #[test]
    fn oversized_input_is_refused_before_parsing() {
        let huge = vec![b'a'; MAX_INPUT_BYTES + 1];
        assert!(yaml_to_json(&huge).is_err());
        assert!(toml_to_json(&huge).is_err());
    }

    /// Whatever comes out has to survive the JSON scanner, because that is the
    /// only thing that will ever read it.
    #[test]
    fn output_is_always_valid_json() {
        let cases: &[&[u8]] = &[
            b"a: 1",
            b"- 1\n- 2",
            b"~",
            b"a:\n  b:\n    c: [1, {d: e}]",
            "quote: 'he said \"hi\"'".as_bytes(),
            "backslash: 'C:\\path\\to'".as_bytes(),
        ];
        for case in cases {
            let json = yaml_to_json(case).expect("convert");
            serde_json::from_str::<serde_json::Value>(&json)
                .unwrap_or_else(|e| panic!("{json} is not JSON: {e}"));
        }
    }
}
