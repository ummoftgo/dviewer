//! Strip JSONC notation without rebuilding values or rounding numeric tokens.
use crate::error::{Error, Result, Subject};
use crate::table::MAX_CELL_TEXT_BYTES;
use std::sync::atomic::{AtomicBool, Ordering};
fn check(cancel: Option<&AtomicBool>, at: usize) -> Result<()> {
    if at % 4096 <= 1 && cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err(Error::Cancelled);
    }
    Ok(())
}
fn invalid(detail: &str) -> Error {
    Error::ParseFailed {
        subject: Subject::Table,
        detail: detail.to_owned(),
    }
}
fn trivia(bytes: &[u8], mut at: usize, cancel: Option<&AtomicBool>) -> Result<usize> {
    loop {
        check(cancel, at)?;
        while at < bytes.len() && matches!(bytes[at], b' ' | b'\t' | b'\r' | b'\n') {
            check(cancel, at)?;
            at += 1;
        }
        if bytes.get(at..at + 2) == Some(b"//") {
            at += 2;
            while at < bytes.len() && !matches!(bytes[at], b'\r' | b'\n') {
                check(cancel, at)?;
                at += 1;
            }
        } else if bytes.get(at..at + 2) == Some(b"/*") {
            at += 2;
            while at < bytes.len() && bytes.get(at..at + 2) != Some(b"*/") {
                check(cancel, at)?;
                at += 1;
            }
            if at == bytes.len() {
                return Err(invalid("Unterminated JSONC comment in exported value."));
            }
            at += 2;
        } else {
            return Ok(at);
        }
    }
}
pub(super) fn strict_with_cancel(text: &str, cancel: Option<&AtomicBool>) -> Result<String> {
    if text.len() > MAX_CELL_TEXT_BYTES {
        return Err(Error::TooLarge {
            subject: Subject::Table,
            megabytes: 9,
            limit_mb: 8,
        });
    }
    check(cancel, 0)?;
    let bytes = text.as_bytes();
    // Comment removal and trailing comma removal never increase the input size.
    let mut output = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        check(cancel, at)?;
        if bytes[at] == b'"' {
            let start = at;
            at += 1;
            while at < bytes.len() {
                check(cancel, at)?;
                if bytes[at] == b'\\' {
                    at += 2;
                } else if bytes[at] == b'"' {
                    at += 1;
                    break;
                } else {
                    at += 1;
                }
            }
            if at > bytes.len() || bytes.get(at - 1) != Some(&b'"') {
                return Err(invalid("Unterminated string in exported value."));
            }
            output.extend_from_slice(&bytes[start..at]);
        } else if bytes
            .get(at..at + 2)
            .is_some_and(|token| token == b"//" || token == b"/*")
        {
            at = trivia(bytes, at, cancel)?;
            // Keep tokens apart. 1/*comment*/2 must not silently become 12.
            output.push(b' ');
        } else {
            let trailing = bytes[at] == b','
                && matches!(bytes.get(trivia(bytes, at + 1, cancel)?), Some(b'}' | b']'));
            if !trailing {
                output.push(bytes[at]);
            }
            check(cancel, at)?;
            at += 1;
        }
    }
    let output = String::from_utf8(output).map_err(Error::internal)?;
    serde_json::from_str::<serde::de::IgnoredAny>(&output)
        .map_err(|error| invalid(&error.to_string()))?;
    check(cancel, 0)?;
    Ok(output)
}
#[cfg(test)]
fn strict(text: &str) -> Result<String> {
    strict_with_cancel(text, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comments_and_trailing_commas_preserve_numeric_and_string_tokens() {
        let value = strict(r#"{"n":18446744073709551617,/*note*/"d":0.12345678901234567890123456789,"s":"// literal /* note */ ,] \\\"","a":[true, // trailing
        ],}"#).unwrap();
        assert!(value.contains("18446744073709551617"));
        assert!(value.contains("0.12345678901234567890123456789"));
        assert!(value.contains(r#""s":"// literal /* note */ ,] \\\"""#));
        let parsed: serde_json::Value = serde_json::from_str(&value).unwrap();
        assert_eq!(parsed["a"], serde_json::json!([true]));
    }
    #[test]
    fn comments_cannot_merge_invalid_tokens_or_hide_an_incomplete_string() {
        assert!(strict("[1/*comment*/2]").is_err());
        assert!(strict("[1,/*unterminated]").is_err());
        assert!(strict("[\"unterminated]").is_err());
    }
    #[test]
    fn cancelled_normalization_stops_before_writing_any_value() {
        let cancel = AtomicBool::new(true);
        assert_eq!(
            strict_with_cancel("[1,/*note*/]", Some(&cancel)),
            Err(Error::Cancelled)
        );
    }
    #[test]
    fn cancellation_is_checked_inside_long_line_and_block_comments() {
        let cancel = AtomicBool::new(true);
        for comment in [
            format!("//{}\n", "x".repeat(8192)),
            format!("/*{}*/", "x".repeat(8192)),
        ] {
            // Offset 2 misses the initial checkpoint. The comment body must
            // reach its own 4096-byte checkpoint rather than scan to the end.
            assert_eq!(trivia(comment.as_bytes(), 2, Some(&cancel)), Ok(2));
            let comment = format!("  {comment}");
            assert_eq!(
                trivia(comment.as_bytes(), 2, Some(&cancel)),
                Err(Error::Cancelled)
            );
        }
    }
    #[test]
    fn normalization_is_bounded_by_the_original_scalar_bytes() {
        let input = format!("[{}1,]", "/**/".repeat(10_000));
        let normalized = strict(&input).unwrap();
        assert!(normalized.len() <= input.len());
        assert_eq!(
            strict(&" ".repeat(MAX_CELL_TEXT_BYTES + 1)),
            Err(Error::TooLarge {
                subject: Subject::Table,
                megabytes: 9,
                limit_mb: 8
            })
        );
    }
}
