//! Recognising the shape of a log, so its leading fields can become columns.
//!
//! The rule this module exists to hold is a restraint: **take only the fields
//! at the front that are certainly fields, and leave everything else in one
//! message column.** A table that split a line wrongly is worse than the single
//! column it replaced — the reader cannot see what was moved where, and the one
//! place they were looking now holds half a sentence.
//!
//! So the patterns here are narrow and the thresholds are high. A file has to
//! look like a log almost everywhere before it is read as one, and a line that
//! does not match falls whole into the message rather than being forced.
//!
//! Detection follows the same rule as encoding: decide by confidence, say that
//! it was a guess, and let the reader switch it off.

use serde::Serialize;

/// How many bytes of the document the guess is allowed to look at.
const SAMPLE_BYTES: usize = 1024 * 1024;
/// And how many lines, whichever comes first. A log with enormous lines should
/// not make the guess read the whole megabyte for three of them.
const SAMPLE_LINES: usize = 2_000;
/// The share of sampled lines that must match before a shape is accepted.
///
/// High on purpose. A prose file with one date in it must not become a table,
/// and stack traces mean even a real log never reaches 100%.
const AGREEMENT: f64 = 0.7;
/// A line needs this many `key=value` pairs to count towards logfmt.
const LOGFMT_MIN_PAIRS: usize = 3;

/// What a recognised log line is made of, in order.
///
/// The message is always last and always present: it is what is left over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LogField {
    Timestamp,
    Level,
    /// A `[...]` field. Logs put a logger name, a thread or a request id here,
    /// and which one it is differs per program — so the column is numbered
    /// rather than named something that would be wrong half the time.
    Bracketed(usize),
    /// A `key=value` key, when the whole file is written that way.
    Key(String),
    /// Everything the fields above did not take.
    Message,
}

/// The columns a log's lines split into.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLayout {
    pub fields: Vec<LogField>,
}

impl LogLayout {
    pub fn column_count(&self) -> usize {
        self.fields.len()
    }
}

/// Look at the front of a document and say how its lines are built.
///
/// Returns None when nothing is confident enough, which leaves the document as
/// plain lines.
pub fn detect(bytes: &[u8]) -> Option<LogLayout> {
    let sample = sample_lines(bytes);
    if sample.is_empty() {
        return None;
    }
    logfmt_layout(&sample).or_else(|| prefixed_layout(&sample))
}

/// The same layout with its message column opened into `key=value` columns.
///
/// Returns None when the messages carry no pairs worth a column — asking for
/// the expansion should not produce a table of empty ones.
///
/// The message column stays. Pairs sit at the end of a line and prose comes
/// before them, so there is nearly always something left that belongs nowhere
/// else — and a line that carries no pairs at all has to land somewhere.
pub fn expanded(bytes: &[u8], layout: &LogLayout) -> Option<LogLayout> {
    if layout.fields.iter().any(|f| matches!(f, LogField::Key(_))) {
        // logfmt is already nothing but pairs.
        return None;
    }
    let mut keys: Vec<String> = Vec::new();
    let mut lines = 0usize;

    for line in sample_lines(bytes) {
        lines += 1;
        let message = message_of(line, layout);
        for (key, _) in pairs_in(message) {
            if !keys.iter().any(|seen| seen == key) {
                keys.push(key.to_owned());
            }
        }
    }
    if keys.is_empty() || lines == 0 {
        return None;
    }

    let mut fields: Vec<LogField> = layout
        .fields
        .iter()
        .filter(|f| !matches!(f, LogField::Message))
        .cloned()
        .collect();
    fields.extend(keys.into_iter().map(LogField::Key));
    fields.push(LogField::Message);
    Some(LogLayout { fields })
}

/// The part of `line` the layout leaves for the message.
fn message_of<'a>(line: &'a str, layout: &LogLayout) -> &'a str {
    let cells = split(line, layout);
    match cells.last() {
        Some(&(from, to)) => &line[from..to],
        None => line,
    }
}

/// Lines from the front of the document that could be the start of a record.
///
/// Blank lines say nothing, and a line beginning with whitespace is a
/// continuation — a stack trace under the error that caused it. Counting those
/// as failures would let a handful of them talk a real log out of being one.
fn sample_lines(bytes: &[u8]) -> Vec<&str> {
    let head = &bytes[..bytes.len().min(SAMPLE_BYTES)];
    head.split(|&b| b == b'\n')
        .filter_map(|line| {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            std::str::from_utf8(line).ok()
        })
        .filter(|line| !line.trim().is_empty())
        .filter(|line| !line.starts_with([' ', '\t']))
        .take(SAMPLE_LINES)
        .collect()
}

// --- logfmt -----------------------------------------------------------------

/// `level=info msg="started" port=8080` — the whole line is pairs.
///
/// Columns are the union of the keys seen, in the order they first appear. A
/// line missing a key leaves that cell empty, which is the honest reading: the
/// pair was not written.
fn logfmt_layout(sample: &[&str]) -> Option<LogLayout> {
    let mut keys: Vec<String> = Vec::new();
    let mut agreeing = 0usize;

    for line in sample {
        let pairs = pairs_in(line);
        if pairs.len() < LOGFMT_MIN_PAIRS || !pairs_cover_line(line, &pairs) {
            continue;
        }
        agreeing += 1;
        for (key, _) in pairs {
            if !keys.iter().any(|seen| seen == key) {
                keys.push(key.to_owned());
            }
        }
    }

    if (agreeing as f64) < sample.len() as f64 * AGREEMENT {
        return None;
    }
    // A line of pairs has nothing left over, but the column stays: a line that
    // did not parse has to land somewhere, and dropping it would hide it.
    let mut fields: Vec<LogField> = keys.into_iter().map(LogField::Key).collect();
    fields.push(LogField::Message);
    Some(LogLayout { fields })
}

/// Whether the pairs account for most of the line, rather than sitting inside
/// prose that happens to contain an equals sign.
fn pairs_cover_line(line: &str, pairs: &[(&str, &str)]) -> bool {
    let covered: usize = pairs.iter().map(|(k, v)| k.len() + v.len() + 1).sum();
    covered * 2 >= line.trim().len()
}

/// Where each `key=value` pair sits: the key's range, then the value's.
///
/// Positions rather than slices, because the message column has to be cut at
/// the first pair of the trailing run and a slice cannot say where it began.
pub fn pair_spans(line: &str) -> Vec<((usize, usize), (usize, usize))> {
    let bytes = line.as_bytes();
    let mut pairs = Vec::new();
    let mut i = 0usize;

    while i < bytes.len() {
        // A key runs from a word boundary up to `=`.
        if !is_key_byte(bytes[i]) {
            i += 1;
            continue;
        }
        let key_start = i;
        while i < bytes.len() && is_key_byte(bytes[i]) {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' || i == key_start {
            continue;
        }
        let key_end = i;
        i += 1;

        let value_start = i;
        if bytes.get(i) == Some(&b'"') {
            i += 1;
            while i < bytes.len() && bytes[i] != b'"' {
                // A backslash escapes the next byte, including a quote.
                i += if bytes[i] == b'\\' { 2 } else { 1 };
            }
            i = (i + 1).min(bytes.len());
        } else {
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
        }
        pairs.push(((key_start, key_end), (value_start, i)));
    }
    pairs
}

/// The `key=value` pairs in a line, values honouring double quotes.
pub fn pairs_in(line: &str) -> Vec<(&str, &str)> {
    pair_spans(line)
        .into_iter()
        .map(|((ks, ke), (vs, ve))| (&line[ks..ke], &line[vs..ve]))
        .collect()
}

/// Where the run of pairs that reaches the end of the line begins.
///
/// Pairs live at the end of a log line and prose comes before them, so cutting
/// here leaves the message as the sentence its author wrote. A pair sitting in
/// the middle of prose is not a trailing run and does not cut anything.
fn trailing_pairs_start(line: &str) -> Option<usize> {
    let pairs = pair_spans(line);
    let end = line.trim_end().len();
    let mut cut = None;
    for index in (0..pairs.len()).rev() {
        let ((key_start, _), (_, value_end)) = pairs[index];
        let next = pairs.get(index + 1).map(|((ks, _), _)| *ks).unwrap_or(end);
        // Only whitespace may sit between one pair and the next, and the last
        // pair has to reach the end of the line.
        if !line[value_end..next].trim().is_empty() || value_end > next {
            break;
        }
        cut = Some(key_start);
    }
    cut
}

fn is_key_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-'
}

// --- timestamp, level, brackets ---------------------------------------------

/// `2026-08-30T01:02:03.123Z INFO [server] started`
///
/// The timestamp is required — it is the one token whose shape cannot be
/// mistaken for prose. Level and bracketed fields are taken only if most lines
/// carry them, so a column never exists for the sake of a handful of rows.
fn prefixed_layout(sample: &[&str]) -> Option<LogLayout> {
    let mut with_timestamp = 0usize;
    let mut with_level = 0usize;
    let mut brackets = Vec::new();

    for line in sample {
        let Some(rest) = timestamp_len(line).map(|n| line[n..].trim_start()) else {
            continue;
        };
        with_timestamp += 1;
        let rest = match level_len(rest) {
            Some(n) => {
                with_level += 1;
                rest[n..].trim_start()
            }
            None => rest,
        };
        brackets.push(bracket_count(rest));
    }

    let needed = sample.len() as f64 * AGREEMENT;
    if (with_timestamp as f64) < needed {
        return None;
    }

    let mut fields = vec![LogField::Timestamp];
    if (with_level as f64) >= needed {
        fields.push(LogField::Level);
    }
    // As many bracket columns as most lines actually have. Taking the maximum
    // would give every row empty cells for the one line that had three.
    for index in 0..common_bracket_count(&brackets, needed) {
        fields.push(LogField::Bracketed(index));
    }
    fields.push(LogField::Message);
    Some(LogLayout { fields })
}

/// The largest count that at least `needed` lines reach.
fn common_bracket_count(counts: &[usize], needed: f64) -> usize {
    let mut best = 0;
    for candidate in 1..=counts.iter().copied().max().unwrap_or(0) {
        let reaching = counts.iter().filter(|&&n| n >= candidate).count();
        if (reaching as f64) >= needed {
            best = candidate;
        }
    }
    best
}

/// How many bytes of a leading timestamp, if there is one.
///
/// Two shapes, both unmistakable: `2026-08-30T01:02:03` with optional fraction
/// and zone, and syslog's `Aug 30 01:02:03`. A bare time or a bare date is not
/// taken — too much prose begins with a number.
pub fn timestamp_len(line: &str) -> Option<usize> {
    let b = line.as_bytes();
    if let Some(n) = iso_len(b) {
        return Some(n);
    }
    syslog_len(b)
}

fn iso_len(b: &[u8]) -> Option<usize> {
    // YYYY-MM-DD
    if b.len() < 10 || !digits(b, 0, 4) || b[4] != b'-' || !digits(b, 5, 2) || b[7] != b'-' || !digits(b, 8, 2) {
        return None;
    }
    let mut i = 10;
    // A date alone is a date; a log's timestamp carries a time.
    if !(matches!(b.get(i), Some(b'T' | b't' | b' ')) && b.len() >= i + 9) {
        return None;
    }
    i += 1;
    if !(digits(b, i, 2) && b[i + 2] == b':' && digits(b, i + 3, 2) && b[i + 5] == b':' && digits(b, i + 6, 2)) {
        return None;
    }
    i += 8;
    // Fractional seconds, either separator.
    if matches!(b.get(i), Some(b'.' | b',')) && digits(b, i + 1, 1) {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    }
    // Zone: Z, or ±HH:MM / ±HHMM.
    match b.get(i) {
        Some(b'Z' | b'z') => i += 1,
        Some(b'+' | b'-') if digits(b, i + 1, 2) => {
            i += 3;
            if b.get(i) == Some(&b':') && digits(b, i + 1, 2) {
                i += 3;
            } else if digits(b, i, 2) {
                i += 2;
            }
        }
        _ => {}
    }
    Some(i)
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn syslog_len(b: &[u8]) -> Option<usize> {
    if b.len() < 15 {
        return None;
    }
    let month = std::str::from_utf8(&b[..3]).ok()?;
    if !MONTHS.iter().any(|m| m.eq_ignore_ascii_case(month)) {
        return None;
    }
    let mut i = 3;
    while b.get(i) == Some(&b' ') {
        i += 1;
    }
    let day_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == day_start || i - day_start > 2 || b.get(i) != Some(&b' ') {
        return None;
    }
    i += 1;
    if !(digits(b, i, 2) && b.get(i + 2) == Some(&b':') && digits(b, i + 3, 2) && b.get(i + 5) == Some(&b':') && digits(b, i + 6, 2)) {
        return None;
    }
    Some(i + 8)
}

fn digits(b: &[u8], at: usize, count: usize) -> bool {
    b.len() >= at + count && b[at..at + count].iter().all(u8::is_ascii_digit)
}

const LEVELS: [&str; 10] = [
    "TRACE", "DEBUG", "INFO", "INFORMATION", "NOTICE", "WARN", "WARNING", "ERROR", "FATAL",
    "CRITICAL",
];

/// How many bytes of a leading level token, bracketed or bare.
pub fn level_len(rest: &str) -> Option<usize> {
    let b = rest.as_bytes();
    let bracketed = b.first() == Some(&b'[');
    let inner = if bracketed { &rest[1..] } else { rest };
    let word_len = inner
        .find(|c: char| !c.is_ascii_alphabetic())
        .unwrap_or(inner.len());
    let word = &inner[..word_len];
    if !LEVELS.iter().any(|level| level.eq_ignore_ascii_case(word)) {
        return None;
    }
    if bracketed {
        if inner.as_bytes().get(word_len) != Some(&b']') {
            return None;
        }
        return Some(word_len + 2);
    }
    Some(word_len)
}

/// How many `[...]` fields the line opens with.
fn bracket_count(rest: &str) -> usize {
    let mut count = 0;
    let mut at = rest;
    while at.starts_with('[') {
        let Some(close) = at.find(']') else { break };
        count += 1;
        at = at[close + 1..].trim_start();
    }
    count
}

/// Where each of the layout's cells sits inside `line`, as byte ranges.
///
/// Ranges rather than slices, because a field the line does not carry has no
/// slice — and an empty `&str` borrowed from nowhere cannot be turned back into
/// a position in the document. Missing fields come back as an empty range at
/// the start of the line.
///
/// A line that does not match the layout puts everything in the message, which
/// is the column that exists precisely so there is always somewhere to put it.
pub fn split(line: &str, layout: &LogLayout) -> Vec<(usize, usize)> {
    let mut cells = vec![(0usize, 0usize); layout.column_count()];
    let message_at = layout.column_count() - 1;
    let whole = (0, line.len());

    // Where the structural fields stop and the message begins.
    let mut at = 0usize;
    let mut next = 0usize;
    let structural = layout.fields.iter().any(|f| !matches!(f, LogField::Key(_) | LogField::Message));

    if structural {
        let Some(stamp) = timestamp_len(line) else {
            cells[message_at] = whole;
            return cells;
        };
        cells[next] = (0, line[..stamp].trim_end().len());
        next += 1;
        at = stamp + leading_space(&line[stamp..]);

        if matches!(layout.fields.get(next), Some(LogField::Level)) {
            if let Some(n) = level_len(&line[at..]) {
                let token = &line[at..at + n];
                let inner = token.trim_matches(|c| c == '[' || c == ']');
                let offset = token.find(inner).unwrap_or(0);
                cells[next] = (at + offset, at + offset + inner.len());
                at += n;
                at += leading_space(&line[at..]);
            }
            next += 1;
        }

        while matches!(layout.fields.get(next), Some(LogField::Bracketed(_))) {
            if let Some(close) = line[at..].strip_prefix('[').and_then(|inner| inner.find(']')) {
                cells[next] = (at + 1, at + 1 + close);
                at += close + 2;
                at += leading_space(&line[at..]);
            }
            next += 1;
        }
    }

    // What is left is the message — unless keys are being pulled out of it.
    let rest = &line[at..];
    let has_keys = layout.fields.iter().any(|f| matches!(f, LogField::Key(_)));
    if !has_keys {
        cells[message_at] = (at, line.len());
        return cells;
    }

    let pairs = pair_spans(rest);
    for (index, field) in layout.fields.iter().enumerate() {
        let LogField::Key(name) = field else { continue };
        if let Some((_, (vs, ve))) = pairs
            .iter()
            .find(|((ks, ke), _)| &rest[*ks..*ke] == name)
        {
            let (vs, ve) = unquoted(rest, *vs, *ve);
            cells[index] = (at + vs, at + ve);
        }
    }

    // The message keeps the prose and gives up the run of pairs at its end.
    // Leaving them in both places would say the same thing twice; cutting
    // anywhere but the trailing run would cut a sentence in half.
    let cut = trailing_pairs_start(rest).unwrap_or(rest.len());
    cells[message_at] = (at, at + rest[..cut].trim_end().len());
    cells
}

/// The value's range with surrounding quotes dropped.
fn unquoted(line: &str, start: usize, end: usize) -> (usize, usize) {
    let value = &line[start..end];
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return (start + 1, end - 1);
    }
    (start, end)
}

fn leading_space(rest: &str) -> usize {
    rest.len() - rest.trim_start().len()
}




#[cfg(test)]
mod tests {
    /// The trailing pairs become columns, and the prose keeps the message.
    #[test]
    fn expanding_pulls_the_pairs_out_of_the_message() {
        let base = layout(APP).expect("recognised");
        let wide = expanded(APP.as_bytes(), &base).expect("has pairs");
        assert_eq!(
            wide.fields,
            vec![
                LogField::Timestamp,
                LogField::Level,
                LogField::Bracketed(0),
                LogField::Key("port".into()),
                LogField::Key("elapsed".into()),
                LogField::Key("path".into()),
                LogField::Key("status".into()),
                LogField::Message,
            ]
        );
        assert_eq!(
            cells("2026-08-30T01:02:03.123Z INFO  [server] 시작됨 port=8080", &wide),
            ["2026-08-30T01:02:03.123Z", "INFO", "server", "8080", "", "", "", "시작됨"]
        );
        // Quotes around a value belong to the syntax, not to the value.
        assert_eq!(
            cells(
                "2026-08-30T01:02:06.010Z INFO  [server] 요청 path=\"/a/b\" status=200",
                &wide
            ),
            ["2026-08-30T01:02:06.010Z", "INFO", "server", "", "", "/a/b", "200", "요청"]
        );
    }

    /// A line with no pairs keeps its whole message, and one that matches
    /// nothing still lands in the message column.
    #[test]
    fn expanding_leaves_the_others_alone() {
        let base = layout(APP).expect("recognised");
        let wide = expanded(APP.as_bytes(), &base).expect("has pairs");
        assert_eq!(
            cells("2026-08-30T01:02:05.900Z ERROR [db] 연결 실패", &wide),
            ["2026-08-30T01:02:05.900Z", "ERROR", "db", "", "", "", "", "연결 실패"]
        );
        let trace = "\tat Connection.open(Connection.java:117)";
        assert_eq!(cells(trace, &wide).last(), Some(&trace));
    }

    /// A pair in the middle of a sentence is not a trailing run, so nothing
    /// is cut from the message.
    #[test]
    fn a_pair_inside_prose_does_not_cut_the_message() {
        let base = layout(APP).expect("recognised");
        let wide = expanded(APP.as_bytes(), &base).expect("has pairs");
        let line = "2026-08-30T01:02:03.123Z INFO  [server] port=8080 으로 시작함";
        assert_eq!(cells(line, &wide).last(), Some(&"port=8080 으로 시작함"));
    }

    /// logfmt is already nothing but pairs; there is nothing to expand.
    #[test]
    fn logfmt_has_nothing_to_expand() {
        let src = "level=info msg=\"a\" port=1\nlevel=warn msg=\"b\" port=2\nlevel=info msg=\"c\" port=3\n";
        let base = layout(src).expect("recognised");
        assert!(expanded(src.as_bytes(), &base).is_none());
    }

    /// A log whose messages carry no pairs cannot be expanded into empty
    /// columns.
    #[test]
    fn a_log_without_pairs_does_not_expand() {
        let src = "\
2026-08-30T01:00:00Z INFO [a] 시작
2026-08-30T01:00:01Z INFO [a] 계속
2026-08-30T01:00:02Z INFO [a] 끝
";
        let base = layout(src).expect("recognised");
        assert!(expanded(src.as_bytes(), &base).is_none());
    }

    use super::*;

    fn layout(src: &str) -> Option<LogLayout> {
        detect(src.as_bytes())
    }

    fn cells<'a>(line: &'a str, layout: &LogLayout) -> Vec<&'a str> {
        split(line, layout)
            .into_iter()
            .map(|(from, to)| &line[from..to])
            .collect()
    }

    const APP: &str = "\
2026-08-30T01:02:03.123Z INFO  [server] 시작됨 port=8080
2026-08-30T01:02:04.001Z WARN  [db] 연결이 느립니다 elapsed=1520ms
2026-08-30T01:02:05.900Z ERROR [db] 연결 실패
2026-08-30T01:02:06.010Z INFO  [server] 요청 path=\"/a/b\" status=200
";

    /// The shape the roadmap is for: time, level, source, and the rest whole.
    #[test]
    fn a_prefixed_log_becomes_columns() {
        let layout = layout(APP).expect("recognised");
        assert_eq!(
            layout.fields,
            vec![
                LogField::Timestamp,
                LogField::Level,
                LogField::Bracketed(0),
                LogField::Message,
            ]
        );
        assert_eq!(
            cells("2026-08-30T01:02:03.123Z INFO  [server] 시작됨 port=8080", &layout),
            ["2026-08-30T01:02:03.123Z", "INFO", "server", "시작됨 port=8080"]
        );
    }

    /// A line that does not match falls whole into the message.
    ///
    /// A stack trace is the common case, and forcing it into the timestamp
    /// column would put a fragment where a time should be.
    #[test]
    fn an_unmatched_line_keeps_itself() {
        let layout = layout(APP).expect("recognised");
        let trace = "\tat Connection.open(Connection.java:117)";
        assert_eq!(cells(trace, &layout), ["", "", "", trace]);
    }

    /// syslog names its month instead of numbering it.
    #[test]
    fn syslog_timestamps_are_recognised() {
        let src = "\
Aug 30 01:02:03 host sshd[1]: accepted
Aug 30 01:02:04 host sshd[2]: closed
Aug 30 01:02:05 host cron[3]: ran
";
        let layout = layout(src).expect("recognised");
        assert_eq!(layout.fields.first(), Some(&LogField::Timestamp));
        assert_eq!(cells("Aug 30 01:02:03 host sshd[1]: accepted", &layout)[0], "Aug 30 01:02:03");
    }

    /// A whole file of pairs becomes a column per key, in first-seen order.
    #[test]
    fn logfmt_becomes_a_column_per_key() {
        let src = "\
level=info msg=\"started\" port=8080
level=warn msg=\"slow\" elapsed=1520
level=info msg=\"ready\" port=8080
";
        let layout = layout(src).expect("recognised");
        assert_eq!(
            layout.fields,
            vec![
                LogField::Key("level".into()),
                LogField::Key("msg".into()),
                LogField::Key("port".into()),
                LogField::Key("elapsed".into()),
                LogField::Message,
            ]
        );
        // A missing key leaves its cell empty rather than shifting the others.
        assert_eq!(
            cells("level=warn msg=\"slow\" elapsed=1520", &layout),
            ["warn", "slow", "", "1520", ""]
        );
    }

    /// Prose must not become a table because one line held a date.
    #[test]
    fn prose_is_not_a_log() {
        assert!(layout("회의록\n\n2026-08-30 01:02:03 에 시작했다.\n다음 안건은 예산이다.\n").is_none());
        assert!(layout("한 줄\n두 줄\n세 줄\n").is_none());
        assert!(layout("key=value 라는 표현이 문장 안에 있다\n또 다른 문장\n").is_none());
    }

    /// A column is not created for a field only a few lines carry.
    #[test]
    fn rare_fields_do_not_become_columns() {
        let src = "\
2026-08-30T01:00:00Z 시작
2026-08-30T01:00:01Z 계속
2026-08-30T01:00:02Z 계속
2026-08-30T01:00:03Z INFO [only-here] 드물다
";
        let layout = layout(src).expect("recognised");
        assert_eq!(layout.fields, vec![LogField::Timestamp, LogField::Message]);
        assert_eq!(
            cells("2026-08-30T01:00:03Z INFO [only-here] 드물다", &layout),
            ["2026-08-30T01:00:03Z", "INFO [only-here] 드물다"]
        );
    }

    /// The timestamp shapes that are taken, and the ones that are not.
    #[test]
    fn only_unmistakable_timestamps_count() {
        for good in [
            "2026-08-30T01:02:03Z",
            "2026-08-30T01:02:03.123Z",
            "2026-08-30 01:02:03,123",
            "2026-08-30T01:02:03+09:00",
            "2026-08-30T01:02:03-0500",
            "Aug 30 01:02:03",
        ] {
            assert_eq!(timestamp_len(good), Some(good.len()), "{good}");
        }
        for bad in ["2026-08-30", "01:02:03", "30/08/2026 01:02:03", "2026년 8월"] {
            assert!(timestamp_len(bad).is_none(), "{bad}");
        }
    }

    /// Levels are taken bare or bracketed, in any case.
    #[test]
    fn levels_are_recognised_either_way() {
        assert_eq!(level_len("INFO rest"), Some(4));
        assert_eq!(level_len("[WARN] rest"), Some(6));
        assert_eq!(level_len("error rest"), Some(5));
        assert!(level_len("INFOMERCIAL").is_none());
        assert!(level_len("[server]").is_none());
    }
}
