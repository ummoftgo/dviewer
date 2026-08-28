//! Turning raw byte spans into display strings.
//!
//! Unescaping happens per visible row — about a hundred at a time — so a
//! document with 10M string values never pays for the 9,999,900 nobody looked
//! at. Values are also cut to a character budget: one row holding a 10MB
//! base64 blob must not be able to stall the IPC channel.
//!
//! Previews are **one line**. The tree draws rows at a fixed height and
//! positions them by index, so a value carrying a newline would spill over the
//! rows beneath it. Escape sequences that decode to a control character are
//! therefore left in escaped form for display: `"a\nb"` shows as `a\nb`,
//! which is both renderable and what the file actually says.
//!
//! Copying is the opposite job — see [`decode_full`]. There the point is to get
//! the value itself, so escapes resolve to the characters they stand for.

use std::fmt::Write as _;

use super::scanner::{Kind, Node};

/// Characters of a scalar value kept for the row preview.
pub const VALUE_PREVIEW_CHARS: usize = 500;
/// Keys are short in practice; the cap only guards against pathological input.
pub const KEY_PREVIEW_CHARS: usize = 200;

pub fn decode_key(bytes: &[u8], node: &Node) -> String {
    if node.key_len == 0 {
        return String::new();
    }
    let raw = slice(bytes, node.key_start, node.key_len);
    unescape(raw, KEY_PREVIEW_CHARS, Rendering::Display).0
}

/// Display text for a scalar, plus whether it was cut short.
pub fn decode_scalar(bytes: &[u8], node: &Node) -> (String, bool) {
    let raw = slice(bytes, node.val_start, node.val_len);
    match node.kind {
        // Strip the surrounding quotes before unescaping.
        Kind::String => {
            let inner = raw.get(1..raw.len().saturating_sub(1)).unwrap_or_default();
            unescape(inner, VALUE_PREVIEW_CHARS, Rendering::Display)
        }
        _ => truncate_chars(&String::from_utf8_lossy(raw), VALUE_PREVIEW_CHARS),
    }
}

/// The value itself, for copying — not the preview.
///
/// A string yields its text: no surrounding quotes, and `\n` is a newline
/// again. Everything else yields the document's own bytes, because the source
/// of an object or an array *is* the value you would paste elsewhere.
///
/// `max_bytes` bounds the source span, not the result; the flag reports whether
/// that ceiling was hit.
pub fn decode_full(bytes: &[u8], node: &Node, max_bytes: usize) -> (String, bool) {
    let raw = slice(bytes, node.val_start, node.val_len);
    let truncated = raw.len() > max_bytes;
    let raw = &raw[..raw.len().min(max_bytes)];

    match node.kind {
        Kind::String => {
            // Drop the opening quote, and the closing one unless the cut has
            // already removed it.
            let end = raw.len().saturating_sub(if truncated { 0 } else { 1 });
            let inner = raw.get(1..end).unwrap_or_default();
            (unescape(inner, usize::MAX, Rendering::Verbatim).0, truncated)
        }
        _ => (String::from_utf8_lossy(raw).into_owned(), truncated),
    }
}

/// Whether decoded characters are made safe for a single line, or left as they
/// are. The two callers want opposite things out of the same escape decoding.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Rendering {
    Display,
    Verbatim,
}

fn push(out: &mut String, ch: char, rendering: Rendering) {
    match rendering {
        Rendering::Display => push_display(out, ch),
        Rendering::Verbatim => out.push(ch),
    }
}

fn slice(bytes: &[u8], start: u32, len: u32) -> &[u8] {
    let start = (start as usize).min(bytes.len());
    let end = (start + len as usize).min(bytes.len());
    &bytes[start..end]
}

fn truncate_chars(text: &str, max_chars: usize) -> (String, bool) {
    let mut out = String::with_capacity(text.len());
    let mut chars = 0;
    for ch in text.chars() {
        if chars >= max_chars {
            return (out, true);
        }
        push_display(&mut out, ch);
        chars += 1;
    }
    (out, false)
}

/// Append one character in a form that occupies a single line.
///
/// A raw newline or tab would break the row grid, and the remaining control
/// characters have no visible glyph at all — showing them the way JSON writes
/// them is both renderable and truthful. U+2028/U+2029 are included because CSS
/// treats them as line breaks even though they are not C0 controls.
fn push_display(out: &mut String, ch: char) {
    match ch {
        // Without these two, `"a\nb"` and `"a\\nb"` — a newline and a literal
        // backslash — would render identically, and nothing downstream could
        // tell an escape from text that merely looks like one.
        '\\' => out.push_str("\\\\"),
        '"' => out.push_str("\\\""),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        '\u{8}' => out.push_str("\\b"),
        '\u{c}' => out.push_str("\\f"),
        '\u{2028}' | '\u{2029}' => {
            let _ = write!(out, "\\u{:04X}", ch as u32);
        }
        _ if ch.is_control() => {
            let _ = write!(out, "\\u{:04X}", ch as u32);
        }
        _ => out.push(ch),
    }
}

/// Decode JSON string escapes. Invalid escapes are kept verbatim rather than
/// rejected — a viewer should still show a file a strict parser would refuse.
fn unescape(raw: &[u8], max_chars: usize, rendering: Rendering) -> (String, bool) {
    // No fast path: even a string with no backslashes can hold a raw control
    // character, because the scanner is deliberately permissive about them.
    let mut out = String::with_capacity(raw.len());
    let mut chars = 0usize;
    let mut i = 0usize;

    while i < raw.len() {
        if chars >= max_chars {
            return (out, true);
        }
        if raw[i] != b'\\' {
            // Copy one whole UTF-8 character.
            let width = utf8_width(raw[i]).min(raw.len() - i);
            match std::str::from_utf8(&raw[i..i + width]) {
                Ok(text) => {
                    for ch in text.chars() {
                        push(&mut out, ch, rendering);
                    }
                }
                Err(_) => out.push(char::REPLACEMENT_CHARACTER),
            }
            i += width;
            chars += 1;
            continue;
        }

        let Some(&escape) = raw.get(i + 1) else {
            out.push('\\');
            break;
        };
        i += 2;
        chars += 1;
        match escape {
            b'"' => push(&mut out, '"', rendering),
            b'\\' => push(&mut out, '\\', rendering),
            b'/' => out.push('/'),
            b'b' => push(&mut out, '\u{8}', rendering),
            b'f' => push(&mut out, '\u{c}', rendering),
            b'n' => push(&mut out, '\n', rendering),
            b'r' => push(&mut out, '\r', rendering),
            b't' => push(&mut out, '\t', rendering),
            b'u' => {
                let (decoded, consumed) = unescape_unicode(raw, i);
                push(&mut out, decoded, rendering);
                i += consumed;
            }
            other => {
                out.push('\\');
                out.push(other as char);
            }
        }
    }

    (out, false)
}

/// `i` points just past the `u` of a `\u` escape. Returns the decoded
/// character and how many bytes it consumed.
fn unescape_unicode(raw: &[u8], i: usize) -> (char, usize) {
    let Some(high) = hex4(raw, i) else {
        return (char::REPLACEMENT_CHARACTER, 0);
    };

    // A high surrogate is only meaningful when a low surrogate follows.
    if (0xD800..0xDC00).contains(&high) {
        if raw.get(i + 4) == Some(&b'\\') && raw.get(i + 5) == Some(&b'u') {
            if let Some(low) = hex4(raw, i + 6) {
                if (0xDC00..0xE000).contains(&low) {
                    let code = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
                    let decoded = char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER);
                    return (decoded, 10);
                }
            }
        }
        return (char::REPLACEMENT_CHARACTER, 4);
    }

    (
        char::from_u32(high).unwrap_or(char::REPLACEMENT_CHARACTER),
        4,
    )
}

fn hex4(raw: &[u8], i: usize) -> Option<u32> {
    let digits = raw.get(i..i + 4)?;
    let text = std::str::from_utf8(digits).ok()?;
    u32::from_str_radix(text, 16).ok()
}

fn utf8_width(first: u8) -> usize {
    match first {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(raw: &str) -> String {
        unescape(raw.as_bytes(), VALUE_PREVIEW_CHARS, Rendering::Display).0
    }

    #[test]
    fn plain_strings_pass_through() {
        assert_eq!(decode("hello 세상"), "hello 세상");
    }

    #[test]
    fn quotes_and_backslashes_stay_escaped_for_display() {
        // The preview is a JSON string body, so it survives being re-read.
        assert_eq!(decode(r#"a\"b\\c\/d"#), r#"a\"b\\c/d"#);
    }

    /// The reason the backslash is escaped at all: these two values are
    /// different and must not look the same.
    #[test]
    fn a_newline_and_a_literal_backslash_n_render_differently() {
        let newline = decode(r#"a\nb"#);
        let backslash = decode(r#"a\\nb"#);
        assert_eq!(newline, r#"a\nb"#);
        assert_eq!(backslash, r#"a\\nb"#);
        assert_ne!(newline, backslash);
    }

    /// The single-line guarantee the tree's fixed row height depends on.
    #[test]
    fn control_escapes_stay_escaped() {
        assert_eq!(decode(r#"a\nb"#), r#"a\nb"#);
        assert_eq!(decode(r#"a\tb\rc\bd\fe"#), r#"a\tb\rc\bd\fe"#);
    }

    #[test]
    fn raw_control_characters_are_escaped_too() {
        // The scanner is permissive, so a literal newline can reach us even
        // though JSON forbids one inside a string.
        assert_eq!(decode("a\nb"), r#"a\nb"#);
        assert_eq!(decode("a\u{1}b"), r#"a\u0001b"#);
        assert_eq!(decode("a\u{7f}b"), r#"a\u007Fb"#);
    }

    #[test]
    fn unicode_line_separators_are_escaped() {
        // CSS breaks lines on these even though they are not C0 controls.
        assert_eq!(decode("a\u{2028}b"), r#"a\u2028b"#);
        assert_eq!(decode("a\u{2029}b"), r#"a\u2029b"#);
    }

    #[test]
    fn a_unicode_escape_that_decodes_to_a_control_stays_escaped() {
        // Input is the six characters `\u000A`, not a newline.
        assert_eq!(decode(r#"\u000A"#), r#"\n"#);
        assert_eq!(decode(r#"\u0007"#), r#"\u0007"#);
    }

    #[test]
    fn every_preview_is_a_single_line() {
        let sources = [
            r#"a\nb"#,
            "a\nb",
            "a\u{2028}b",
            "a\u{b}b",
            r#"\u000D"#,
            "a\r\nb",
        ];
        for source in sources {
            let text = decode(source);
            assert_eq!(text.lines().count(), 1, "multi-line preview from {source:?}");
            assert!(
                !text.contains(['\n', '\r', '\t']),
                "raw control character survived in {source:?}"
            );
        }
    }

    #[test]
    fn unicode_escapes_decode() {
        // Written with doubled backslashes so the test data is `한글`.
        assert_eq!(decode("\\uD55C\\uAE00"), "한글");
    }

    #[test]
    fn surrogate_pairs_decode_to_one_character() {
        assert_eq!(decode("\\uD83D\\uDE42"), "\u{1F642}");
    }

    #[test]
    fn a_lone_surrogate_becomes_a_replacement_character() {
        assert_eq!(decode("\\uD83Dx"), "\u{FFFD}x");
    }

    #[test]
    fn unknown_escapes_are_kept_verbatim() {
        assert_eq!(decode(r#"a\qb"#), r#"a\qb"#);
    }

    #[test]
    fn long_values_are_truncated_on_character_boundaries() {
        let long = "가".repeat(VALUE_PREVIEW_CHARS + 50);
        let (text, truncated) = unescape(long.as_bytes(), VALUE_PREVIEW_CHARS, Rendering::Display);
        assert!(truncated);
        assert_eq!(text.chars().count(), VALUE_PREVIEW_CHARS);

        // The budget counts *source* characters. Each escaped control renders
        // as two, so the output is deliberately longer than the cap.
        let escaped = r#"\n"#.repeat(VALUE_PREVIEW_CHARS + 50);
        let (text, truncated) = unescape(escaped.as_bytes(), VALUE_PREVIEW_CHARS, Rendering::Display);
        assert!(truncated);
        assert_eq!(text.chars().count(), VALUE_PREVIEW_CHARS * 2);
        assert_eq!(text.lines().count(), 1);
    }

    #[test]
    fn scalar_decoding_strips_quotes_only_for_strings() {
        //           0123456789
        let src = br#"{"k":"v\n","n":12}"#;
        let string_node = Node {
            key_start: 2,
            key_len: 1,
            val_start: 5,
            val_len: 5,
            subtree_size: 1,
            child_count: 0,
            parent: 0,
            sibling_index: 0,
            depth: 1,
            kind: Kind::String,
        };
        // Shown escaped, because the tree draws one line per node.
        assert_eq!(decode_scalar(src, &string_node), (r#"v\n"#.to_owned(), false));
        assert_eq!(decode_key(src, &string_node), "k");

        let number_node = Node {
            val_start: 15,
            val_len: 2,
            kind: Kind::Number,
            ..string_node
        };
        assert_eq!(decode_scalar(src, &number_node), ("12".to_owned(), false));
    }
}
