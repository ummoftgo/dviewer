//! Failures, as data.
//!
//! Nothing here is a sentence. Each variant serialises to a `code` and the
//! values that fill it in, and the frontend turns that into text in whatever
//! language the reader has chosen — see `src/lib/i18n/`. That is what lets a
//! message already on screen change when the language does, and it keeps every
//! translation in one place instead of two.
//!
//! Where a `detail` appears it is a third-party message (an OS error, a YAML
//! parser's complaint) that we cannot translate and will not invent a summary
//! for. It travels verbatim and the template wraps it.

use serde::Serialize;

/// What a failure is about, when several failures differ only in that.
///
/// Collapses what would otherwise be a variant per format per limit, without
/// giving up precision — the reader still sees which thing was too large.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Subject {
    Document,
    Markdown,
    /// The raw text behind a rendered document.
    Source,
    Json,
    Yaml,
    Toml,
    Xml,
    Table,
    Tree,
    /// What came out of a compressed file, which is what the limit is on.
    Decompressed,
    /// A SQLite database, and anything asked of it.
    Database,
    Workbook,
    Columnar,
    /// A zip, and anything asked of it.
    Archive,
}

/// Why the JSON scanner stopped. Ten fixed reasons, so they are codes rather
/// than strings assembled at the point of failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyntaxReason {
    /// Something follows the document's single top-level value.
    TrailingContent,
    MissingCloser,
    ExpectedCommaOrCloser,
    ExpectedValue,
    ExpectedKey,
    ExpectedColon,
    UnterminatedString,
    /// A `/*` with no `/*`-closing partner. Its own reason because the
    /// alternative — swallowing the rest of the file and reporting whatever
    /// went missing at the end — points at the wrong place entirely.
    UnterminatedComment,
    UnreadableValue,
    TooDeep,
}

/// Every failure that can reach the frontend.
///
/// `tag`/`content` give `{"code": "...", "params": {...}}`; a variant with no
/// fields gives just `{"code": "..."}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", content = "params", rename_all = "camelCase")]
pub enum Error {
    // --- the machine, not the document -------------------------------------
    Io { detail: String },
    /// A background task died. Nothing the reader can act on, but silence
    /// would be worse.
    Internal { detail: String },
    NoSuchDoc { id: u32 },
    Cancelled,

    // --- opening ------------------------------------------------------------
    EmptyPaste,
    UnknownEncoding { name: String },

    // --- the network --------------------------------------------------------
    BadUrl { url: String },
    UnsupportedScheme,
    FetchFailed { detail: String },
    HttpStatus { status: String },
    #[serde(rename_all = "camelCase")]
    DownloadFailed { detail: String, limit_mb: u64 },

    // --- limits -------------------------------------------------------------
    #[serde(rename_all = "camelCase")]
    FileTooLarge { gigabytes: usize, limit_gb: usize },
    #[serde(rename_all = "camelCase")]
    TooLarge {
        subject: Subject,
        megabytes: usize,
        limit_mb: usize,
    },
    TooManyNodes { limit: u32 },
    /// One row group of a columnar file holds more rows than may be decoded at
    /// once. The group is the unit the format is written in, so there is no
    /// half of it to show.
    GroupTooLarge { rows: u32, limit: u32 },
    TooDeep { subject: Subject, limit: u32 },

    // --- asking for something that is not there ------------------------------
    /// The index is still being built.
    NotReady { subject: Subject },
    /// This format cannot be read that way at all.
    WrongView { subject: Subject },
    /// A database and a text format are not two readings of the same bytes.
    ///
    /// Every other format switch is a reinterpretation of one run of bytes, so
    /// any of them can become any other and the reader decides. A database is
    /// not read as bytes at all — it is queried — so there is nothing to
    /// reinterpret in either direction.
    NotInterchangeable,
    NoSuchNode,
    NoSuchCell,
    NoSuchRow,
    /// The archive has no entry with that number.
    ///
    /// Reachable when a tab outlives the file it was listed from — the list is
    /// a snapshot, and the archive on disk can be rewritten under it.
    NoSuchEntry { index: u32 },
    /// The entry is password-protected.
    ///
    /// A refusal and not a prompt. Asking for a password would mean holding
    /// one, and reading encrypted archives is a different program from reading
    /// documents. The list marks these before they are clicked, so this is the
    /// answer to a click made anyway.
    EntryEncrypted,

    // --- reading the document ------------------------------------------------
    NotUtf8 { subject: Subject },
    JsonEmpty,
    JsonSyntax {
        line: u32,
        column: u32,
        reason: SyntaxReason,
        /// The strict reading failed somewhere JSONC would have carried on.
        ///
        /// Sent so the message can say which switch to reach for. A `.json`
        /// file full of comments is common enough — `tsconfig.json` and every
        /// editor setting file — that leaving the reader at a dead end is a
        /// choice, and this is the other one. The reading itself does not
        /// budge: nothing here relaxes what `.json` may contain.
        jsonc: bool,
    },
    ParseFailed { subject: Subject, detail: String },
    XmlSyntax { offset: u64, detail: String },

    // --- searching ------------------------------------------------------------
    EmptyQuery,
    BadQuery { detail: String },
    /// The path expression cannot be read, or uses a part of the syntax this
    /// does not do. Both are said out loud: a filter expression that quietly
    /// selected everything would be a wrong answer wearing an answer's clothes.
    BadPath { detail: String },
    /// The regular expression does not compile. `detail` is the crate's own
    /// message, which names the position and the reason — worth more to the
    /// person fixing it than anything this app could say instead.
    BadRegex { detail: String },

    // --- settings -------------------------------------------------------------
    FontsFailed { detail: String },
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Error::Io {
            detail: error.to_string(),
        }
    }
}

impl Error {
    pub fn internal(detail: impl std::fmt::Display) -> Self {
        Error::Internal {
            detail: detail.to_string(),
        }
    }

    /// The variant's code, which is also the message key the frontend looks up.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Io { .. } => "io",
            Error::Internal { .. } => "internal",
            Error::NoSuchDoc { .. } => "noSuchDoc",
            Error::Cancelled => "cancelled",
            Error::EmptyPaste => "emptyPaste",
            Error::UnknownEncoding { .. } => "unknownEncoding",
            Error::BadUrl { .. } => "badUrl",
            Error::UnsupportedScheme => "unsupportedScheme",
            Error::FetchFailed { .. } => "fetchFailed",
            Error::HttpStatus { .. } => "httpStatus",
            Error::DownloadFailed { .. } => "downloadFailed",
            Error::FileTooLarge { .. } => "fileTooLarge",
            Error::TooLarge { .. } => "tooLarge",
            Error::TooManyNodes { .. } => "tooManyNodes",
            Error::GroupTooLarge { .. } => "groupTooLarge",
            Error::TooDeep { .. } => "tooDeep",
            Error::NotReady { .. } => "notReady",
            Error::WrongView { .. } => "wrongView",
            Error::NotInterchangeable => "notInterchangeable",
            Error::NoSuchNode => "noSuchNode",
            Error::NoSuchCell => "noSuchCell",
            Error::NoSuchRow => "noSuchRow",
            Error::NoSuchEntry { .. } => "noSuchEntry",
            Error::EntryEncrypted => "entryEncrypted",
            Error::NotUtf8 { .. } => "notUtf8",
            Error::JsonEmpty => "jsonEmpty",
            Error::JsonSyntax { .. } => "jsonSyntax",
            Error::ParseFailed { .. } => "parseFailed",
            Error::XmlSyntax { .. } => "xmlSyntax",
            Error::EmptyQuery => "emptyQuery",
            Error::BadQuery { .. } => "badQuery",
            Error::BadPath { .. } => "badPath",
            Error::BadRegex { .. } => "badRegex",
            Error::FontsFailed { .. } => "fontsFailed",
        }
    }
}

/// Developer-facing only — logs, test failures, `unwrap` panics. What the
/// reader sees is built in the frontend from the code and the parameters.
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code())?;
        match self {
            Error::Io { detail }
            | Error::Internal { detail }
            | Error::FetchFailed { detail }
            | Error::BadQuery { detail }
            | Error::FontsFailed { detail } => write!(f, ": {detail}"),
            Error::NoSuchDoc { id } => write!(f, ": {id}"),
            Error::NoSuchEntry { index } => write!(f, ": {index}"),
            Error::UnknownEncoding { name } => write!(f, ": {name}"),
            Error::BadUrl { url } => write!(f, ": {url}"),
            Error::HttpStatus { status } => write!(f, ": {status}"),
            Error::DownloadFailed { detail, limit_mb } => write!(f, ": {detail} (max {limit_mb}MB)"),
            Error::FileTooLarge { gigabytes, limit_gb } => {
                write!(f, ": {gigabytes}GB (max {limit_gb}GB)")
            }
            Error::TooLarge {
                subject,
                megabytes,
                limit_mb,
            } => write!(f, ": {subject:?} {megabytes}MB (max {limit_mb}MB)"),
            Error::TooManyNodes { limit } => write!(f, ": max {limit}"),
            Error::GroupTooLarge { rows, limit } => write!(f, ": {rows} rows (max {limit})"),
            Error::TooDeep { subject, limit } => write!(f, ": {subject:?} max {limit}"),
            Error::NotReady { subject } | Error::WrongView { subject } | Error::NotUtf8 { subject } => {
                write!(f, ": {subject:?}")
            }
            Error::JsonSyntax {
                line,
                column,
                reason,
                ..
            } => write!(f, ": {line}:{column} {reason:?}"),
            Error::ParseFailed { subject, detail } => write!(f, ": {subject:?} {detail}"),
            Error::XmlSyntax { offset, detail } => write!(f, ": at {offset} {detail}"),
            _ => Ok(()),
        }
    }
}

impl std::error::Error for Error {}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(error: &Error) -> serde_json::Value {
        serde_json::to_value(error).expect("serialise")
    }

    /// The shape the frontend's `errorMessage()` reads. If this changes, every
    /// message key changes with it.
    #[test]
    fn an_error_serialises_to_a_code_and_its_parameters() {
        assert_eq!(
            json(&Error::TooLarge {
                subject: Subject::Markdown,
                megabytes: 20,
                limit_mb: 16,
            }),
            serde_json::json!({
                "code": "tooLarge",
                "params": { "subject": "markdown", "megabytes": 20, "limitMb": 16 }
            })
        );
    }

    #[test]
    fn a_variant_without_fields_carries_no_parameters() {
        assert_eq!(json(&Error::Cancelled), serde_json::json!({ "code": "cancelled" }));
        assert_eq!(json(&Error::NoSuchNode), serde_json::json!({ "code": "noSuchNode" }));
    }

    #[test]
    fn a_syntax_reason_is_a_code_too() {
        assert_eq!(
            json(&Error::JsonSyntax {
                line: 3,
                column: 12,
                reason: SyntaxReason::UnterminatedString,
                jsonc: false,
            }),
            serde_json::json!({
                "code": "jsonSyntax",
                "params": {
                    "line": 3,
                    "column": 12,
                    "reason": "unterminatedString",
                    "jsonc": false
                }
            })
        );
    }

    /// `code()` is what the frontend looks up, so it has to be the same string
    /// serde puts in the payload. Nothing else keeps the two in step.
    #[test]
    fn the_code_method_agrees_with_serialisation() {
        let every: Vec<Error> = vec![
            Error::Io { detail: "x".into() },
            Error::Internal { detail: "x".into() },
            Error::NoSuchDoc { id: 1 },
            Error::Cancelled,
            Error::EmptyPaste,
            Error::UnknownEncoding { name: "x".into() },
            Error::BadUrl { url: "x".into() },
            Error::UnsupportedScheme,
            Error::FetchFailed { detail: "x".into() },
            Error::HttpStatus { status: "404".into() },
            Error::DownloadFailed { detail: "x".into(), limit_mb: 1 },
            Error::FileTooLarge { gigabytes: 5, limit_gb: 4 },
            Error::TooLarge { subject: Subject::Json, megabytes: 1, limit_mb: 1 },
            Error::TooManyNodes { limit: 1 },
            Error::GroupTooLarge { rows: 9, limit: 4 },
            Error::TooDeep { subject: Subject::Yaml, limit: 1 },
            Error::NotReady { subject: Subject::Tree },
            Error::WrongView { subject: Subject::Table },
            Error::NotInterchangeable,
            Error::NoSuchNode,
            Error::NoSuchCell,
            Error::NoSuchRow,
            Error::NotUtf8 { subject: Subject::Toml },
            Error::JsonEmpty,
            Error::JsonSyntax {
                line: 1,
                column: 1,
                reason: SyntaxReason::ExpectedValue,
                jsonc: false,
            },
            Error::ParseFailed { subject: Subject::Xml, detail: "x".into() },
            Error::XmlSyntax { offset: 1, detail: "x".into() },
            Error::EmptyQuery,
            Error::BadQuery { detail: "x".into() },
            Error::BadPath { detail: "x".into() },
            Error::BadRegex { detail: "x".into() },
            Error::FontsFailed { detail: "x".into() },
        ];

        for error in &every {
            let serialised = json(error);
            assert_eq!(
                serialised["code"].as_str(),
                Some(error.code()),
                "{error:?} serialises to a different code than it reports"
            );
        }
    }

    /// An `io::Error` reaching a command through `?` must not lose its message.
    #[test]
    fn an_io_error_keeps_what_the_system_said() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "그런 파일이 없습니다");
        let Error::Io { detail } = Error::from(io) else {
            panic!("io errors must map to Error::Io");
        };
        assert!(detail.contains("그런 파일이 없습니다"), "{detail}");
    }
}
