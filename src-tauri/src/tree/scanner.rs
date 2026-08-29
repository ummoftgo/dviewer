//! Byte-level JSON scanner.
//!
//! Produces a flat, pre-order node index without ever building a `Value` tree:
//! a 500MB document costs one sequential pass over mmap'd bytes plus 36 bytes
//! per node, instead of the several gigabytes a materialised tree would take.
//!
//! Because nodes are emitted in document order, node id order *is* byte order.
//! Every later stage — visibility, viewport lookup, offset→node mapping for
//! search — is built on that invariant.

use serde::Serialize;

use crate::error::{Error, Result, SyntaxReason};

/// Node ids and byte offsets are `u32`, which caps a document at 4GiB.
pub const MAX_DOC_BYTES: usize = u32::MAX as usize;

pub const DEFAULT_MAX_NODES: u32 = 50_000_000;
pub const DEFAULT_MAX_DEPTH: u16 = 1024;

const PROGRESS_STEP: usize = 8 * 1024 * 1024;

pub const NO_PARENT: u32 = u32::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[repr(u8)]
pub enum Kind {
    Object = 0,
    Array = 1,
    String = 2,
    Number = 3,
    Bool = 4,
    Null = 5,
    // XML. The tree engine is shared, so a node kind describes what the source
    // format called it rather than what JSON would have called it — see
    // `crate::xml`.
    /// An element with attributes or element children.
    Element = 6,
    /// An element whose entire content is text, folded into one row: showing
    /// `<name>John</name>` as a container you have to open to find "John"
    /// costs a click and a line for no information.
    ElementText = 7,
    Attribute = 8,
    /// Text alongside sibling elements — mixed content.
    Text = 9,
    Comment = 10,
    CData = 11,
    /// `<?xml ...?>`, a processing instruction, or a doctype.
    Directive = 12,
}

impl Kind {
    pub fn is_container(self) -> bool {
        matches!(self, Kind::Object | Kind::Array | Kind::Element)
    }

    /// True when the node's value is XML text rather than a JSON literal, and
    /// so carries entities instead of backslash escapes.
    pub fn is_xml_text(self) -> bool {
        matches!(self, Kind::ElementText | Kind::Attribute | Kind::Text)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Object => "object",
            Kind::Array => "array",
            Kind::String => "string",
            Kind::Number => "number",
            Kind::Bool => "bool",
            Kind::Null => "null",
            Kind::Element => "element",
            Kind::ElementText => "elementText",
            Kind::Attribute => "attribute",
            Kind::Text => "text",
            Kind::Comment => "comment",
            Kind::CData => "cdata",
            Kind::Directive => "directive",
        }
    }
}

/// One node of the document. 36 bytes; everything is an offset or a count so
/// the whole index is a single flat allocation with no pointer chasing.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct Node {
    /// Byte span of the object key that introduced this node, quotes excluded
    /// (`key_len` is 0 when the parent is an array or this is a root).
    pub key_start: u32,
    pub key_len: u32,
    /// Byte span of the value itself: the literal, or `{`..`}` for containers.
    pub val_start: u32,
    pub val_len: u32,
    /// Self plus all descendants. Makes collapsing an O(1) range operation.
    pub subtree_size: u32,
    pub child_count: u32,
    /// `NO_PARENT` for roots.
    pub parent: u32,
    /// Position among siblings; the display index for array elements.
    pub sibling_index: u32,
    pub depth: u16,
    pub kind: Kind,
}

pub struct ScanLimits {
    pub max_nodes: u32,
    pub max_depth: u16,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_nodes: DEFAULT_MAX_NODES,
            max_depth: DEFAULT_MAX_DEPTH,
        }
    }
}

#[derive(Debug)]
pub struct Scan {
    pub nodes: Vec<Node>,
    /// True when the input held several top-level values (NDJSON and friends)
    /// and node 0 is a synthetic array wrapping them.
    pub synthetic_root: bool,
}

/// Scan `bytes`, reporting progress as a byte offset. `should_stop` is polled
/// at the same cadence so a closed tab can abort an in-flight index.
pub fn scan(
    bytes: &[u8],
    limits: &ScanLimits,
    mut progress: impl FnMut(usize),
    should_stop: &dyn Fn() -> bool,
) -> Result<Scan> {
    if bytes.len() > MAX_DOC_BYTES {
        return Err(Error::FileTooLarge {
            gigabytes: bytes.len() / 1024 / 1024 / 1024,
            limit_gb: MAX_DOC_BYTES / 1024 / 1024 / 1024,
        });
    }

    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let bom_offset = (bytes.len() - body.len()) as u32;

    let mut scanner = Scanner {
        b: body,
        p: 0,
        nodes: Vec::new(),
        stack: Vec::new(),
        roots: 0,
        pending_key: None,
        descended: false,
        limits,
        next_progress: PROGRESS_STEP,
    };

    let root_count = scanner.run(&mut progress, should_stop)?;
    progress(body.len());

    let mut nodes = scanner.nodes;
    let synthetic_root = root_count != 1;
    if synthetic_root {
        wrap_in_synthetic_root(&mut nodes, root_count, body.len() as u32);
    }

    // Offsets were computed against the BOM-stripped slice; shift them back so
    // callers can index the original buffer.
    if bom_offset > 0 {
        for node in &mut nodes {
            node.val_start += bom_offset;
            if node.key_len > 0 {
                node.key_start += bom_offset;
            }
        }
    }

    Ok(Scan {
        nodes,
        synthetic_root,
    })
}

struct Scanner<'a, 'l> {
    b: &'a [u8],
    p: usize,
    nodes: Vec<Node>,
    /// Open containers: (node id, children seen so far).
    stack: Vec<(u32, u32)>,
    /// Top-level values seen so far. A multi-root document — NDJSON, or JSON
    /// Lines — numbers its records from this, the same way the stack numbers
    /// the children of a container.
    roots: u32,
    /// Key span parsed but not yet attached to its value.
    pending_key: Option<(u32, u32)>,
    /// Set when the value just parsed was a container we stepped into.
    descended: bool,
    limits: &'l ScanLimits,
    next_progress: usize,
}

impl Scanner<'_, '_> {
    /// Returns how many top-level values the document held.
    fn run(
        &mut self,
        progress: &mut impl FnMut(usize),
        should_stop: &dyn Fn() -> bool,
    ) -> Result<u32> {
        self.skip_ws();
        if self.p >= self.b.len() {
            return Err(Error::JsonEmpty);
        }

        loop {
            if self.p >= self.next_progress {
                if should_stop() {
                    return Err(Error::Cancelled);
                }
                progress(self.p);
                self.next_progress = self.p + PROGRESS_STEP;
            }

            let key = self.pending_key.take();
            self.begin_value(key)?;

            // A container we stepped into leaves the loop to parse its first
            // child; everything else walks back up.
            if self.descended {
                self.descended = false;
                continue;
            }

            if self.ascend()? {
                break;
            }
        }

        self.skip_ws();
        if self.p < self.b.len() {
            return Err(self.err_at(SyntaxReason::TrailingContent));
        }
        // `begin_value` counts the roots as it numbers them; a second counter
        // here could only ever disagree with the numbering.
        Ok(self.roots)
    }

    /// Close finished containers. Returns true when the document is complete.
    fn ascend(&mut self) -> Result<bool> {
        loop {
            self.skip_ws();
            let Some(&(open_id, _)) = self.stack.last() else {
                // Top level. Another value may follow — NDJSON and concatenated
                // JSON streams are common enough in logs to be worth reading.
                let before = self.p;
                if self.p < self.b.len() && self.b[self.p] == b',' {
                    self.p += 1;
                    self.skip_ws();
                }
                if self.p >= self.b.len() {
                    return Ok(true);
                }
                if before == self.p && !is_value_start(self.b[self.p]) {
                    return Ok(true);
                }
                return Ok(false);
            };

            if self.p >= self.b.len() {
                return Err(self.err_at(SyntaxReason::MissingCloser));
            }

            let is_object = self.nodes[open_id as usize].kind == Kind::Object;
            match self.b[self.p] {
                b',' => {
                    self.p += 1;
                    if is_object {
                        self.read_key()?;
                    }
                    return Ok(false);
                }
                b'}' if is_object => self.close_container(),
                b']' if !is_object => self.close_container(),
                _ => return Err(self.err_at(SyntaxReason::ExpectedCommaOrCloser)),
            }
        }
    }

    fn close_container(&mut self) {
        let (id, children) = self.stack.pop().expect("close_container with no open container");
        self.p += 1;
        let total = self.nodes.len() as u32;
        let node = &mut self.nodes[id as usize];
        node.val_len = self.p as u32 - node.val_start;
        node.child_count = children;
        node.subtree_size = total - id;
    }

    /// Parse the value at `self.p` and push its node. Either steps into the
    /// container (setting `descended`) or leaves `self.p` just past the scalar.
    fn begin_value(&mut self, key: Option<(u32, u32)>) -> Result<()> {
        self.skip_ws();
        if self.p >= self.b.len() {
            return Err(self.err_at(SyntaxReason::ExpectedValue));
        }

        if self.nodes.len() as u32 >= self.limits.max_nodes {
            return Err(Error::TooManyNodes {
                limit: self.limits.max_nodes,
            });
        }
        if self.stack.len() as u16 >= self.limits.max_depth {
            return Err(self.err_at(SyntaxReason::TooDeep));
        }

        let start = self.p;
        let kind = match self.b[start] {
            b'{' => Kind::Object,
            b'[' => Kind::Array,
            b'"' => Kind::String,
            b't' | b'f' => Kind::Bool,
            b'n' => Kind::Null,
            b'-' | b'0'..=b'9' => Kind::Number,
            _ => return Err(self.err_at(SyntaxReason::UnreadableValue)),
        };

        let (parent, sibling_index) = match self.stack.last_mut() {
            Some((pid, count)) => {
                let index = *count;
                *count += 1;
                (*pid, index)
            }
            // Numbering a root by how many nodes came before it only agrees
            // with its position when every root is a scalar. `$[1]` has to be
            // the second record, not the second node.
            None => {
                let index = self.roots;
                self.roots += 1;
                (NO_PARENT, index)
            }
        };

        let id = self.nodes.len() as u32;
        let (key_start, key_len) = key.unwrap_or((0, 0));
        self.nodes.push(Node {
            key_start,
            key_len,
            val_start: start as u32,
            val_len: 0,
            subtree_size: 1,
            child_count: 0,
            parent,
            sibling_index,
            depth: self.stack.len() as u16,
            kind,
        });

        if kind.is_container() {
            self.p += 1;
            self.stack.push((id, 0));
            self.skip_ws();
            let close = if kind == Kind::Object { b'}' } else { b']' };
            if self.p < self.b.len() && self.b[self.p] == close {
                self.close_container();
            } else {
                if kind == Kind::Object {
                    self.read_key()?;
                }
                self.descended = true;
            }
            return Ok(());
        }

        let end = match kind {
            Kind::String => self.scan_string(start)?,
            _ => self.scan_literal(start, kind)?,
        };
        self.p = end;
        self.nodes[id as usize].val_len = (end - start) as u32;
        Ok(())
    }

    fn read_key(&mut self) -> Result<()> {
        self.skip_ws();
        if self.p >= self.b.len() || self.b[self.p] != b'"' {
            return Err(self.err_at(SyntaxReason::ExpectedKey));
        }
        let start = self.p;
        let end = self.scan_string(start)?;
        self.p = end;
        self.skip_ws();
        if self.p >= self.b.len() || self.b[self.p] != b':' {
            return Err(self.err_at(SyntaxReason::ExpectedColon));
        }
        self.p += 1;
        // Stored without the surrounding quotes.
        self.pending_key = Some((start as u32 + 1, (end - start - 2) as u32));
        Ok(())
    }

    /// `start` is the opening quote; returns the index just past the close.
    fn scan_string(&self, start: usize) -> Result<usize> {
        let mut i = start + 1;
        loop {
            let Some(offset) = memchr::memchr2(b'"', b'\\', &self.b[i..]) else {
                return Err(self.err_at_pos(start, SyntaxReason::UnterminatedString));
            };
            let j = i + offset;
            if self.b[j] == b'"' {
                return Ok(j + 1);
            }
            // Skip the backslash and whatever it escapes.
            i = j + 2;
            if i > self.b.len() {
                return Err(self.err_at_pos(start, SyntaxReason::UnterminatedString));
            }
        }
    }

    fn scan_literal(&self, start: usize, kind: Kind) -> Result<usize> {
        let end = self.b[start..]
            .iter()
            .position(|b| matches!(b, b',' | b']' | b'}' | b' ' | b'\t' | b'\n' | b'\r'))
            .map_or(self.b.len(), |offset| start + offset);

        let text = &self.b[start..end];
        let valid = match kind {
            Kind::Bool => text == b"true" || text == b"false",
            Kind::Null => text == b"null",
            Kind::Number => is_number(text),
            _ => true,
        };
        if !valid {
            return Err(self.err_at_pos(start, SyntaxReason::UnreadableValue));
        }
        Ok(end)
    }

    fn skip_ws(&mut self) {
        while self.p < self.b.len() && matches!(self.b[self.p], b' ' | b'\t' | b'\n' | b'\r') {
            self.p += 1;
        }
    }

    fn err_at(&self, reason: SyntaxReason) -> Error {
        self.err_at_pos(self.p, reason)
    }

    fn err_at_pos(&self, pos: usize, reason: SyntaxReason) -> Error {
        let (line, column) = line_col(self.b, pos);
        Error::JsonSyntax {
            line: line as u32,
            column: column as u32,
            reason,
        }
    }
}

fn is_value_start(b: u8) -> bool {
    matches!(b, b'{' | b'[' | b'"' | b't' | b'f' | b'n' | b'-' | b'0'..=b'9')
}

/// JSON's number grammar, exactly: `-? int frac? exp?`.
///
/// This is the only thing standing between a malformed number and a document
/// reported as sound. Accepting any run of the characters a number may contain
/// let `1.2.3`, `--`, `1e` and `01` through — the viewer showed them and said
/// nothing, which is worse than refusing the file.
fn is_number(text: &[u8]) -> bool {
    let mut i = 0usize;
    let digits = |i: &mut usize| {
        let from = *i;
        while *i < text.len() && text[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > from
    };

    if i < text.len() && text[i] == b'-' {
        i += 1;
    }
    // A leading zero stands alone: `01` is not a JSON number.
    if i < text.len() && text[i] == b'0' {
        i += 1;
    } else if !digits(&mut i) {
        return false;
    }
    if i < text.len() && text[i] == b'.' {
        i += 1;
        if !digits(&mut i) {
            return false;
        }
    }
    if i < text.len() && (text[i] == b'e' || text[i] == b'E') {
        i += 1;
        if i < text.len() && (text[i] == b'+' || text[i] == b'-') {
            i += 1;
        }
        if !digits(&mut i) {
            return false;
        }
    }
    i == text.len()
}

/// Where `pos` is, as a reader would count it.
///
/// The column counts characters, not bytes. Counting bytes puts the error two
/// columns further along for every Korean character earlier on the line, and
/// this number exists only to be looked at.
fn line_col(b: &[u8], pos: usize) -> (usize, usize) {
    let pos = pos.min(b.len());
    let upto = &b[..pos];
    let line = memchr::memchr_iter(b'\n', upto).count() + 1;
    let line_start = memchr::memrchr(b'\n', upto).map_or(0, |newline| newline + 1);
    // Every byte that is not a UTF-8 continuation byte starts a character.
    let col = b[line_start..pos]
        .iter()
        .filter(|&&byte| byte & 0xC0 != 0x80)
        .count()
        + 1;
    (line, col)
}

/// Prepend a synthetic array root over several top-level values so everything
/// downstream can assume a single tree.
/// Wrap several top-level values in one array node so the tree has a single
/// root. Shared with the XML scanner, where a prolog beside the root element
/// produces the same situation.
pub(crate) fn wrap_in_synthetic_root(nodes: &mut Vec<Node>, root_count: u32, total_len: u32) {
    for node in nodes.iter_mut() {
        node.depth += 1;
        node.parent = if node.parent == NO_PARENT {
            0
        } else {
            node.parent + 1
        };
    }
    nodes.insert(
        0,
        Node {
            key_start: 0,
            key_len: 0,
            val_start: 0,
            val_len: total_len,
            subtree_size: nodes.len() as u32 + 1,
            child_count: root_count,
            parent: NO_PARENT,
            sibling_index: 0,
            depth: 0,
            kind: Kind::Array,
        },
    );
}

#[cfg(test)]
mod tests {
    /// A malformed number must not pass for a sound document.
    #[test]
    fn numbers_follow_the_grammar() {
        for good in ["0", "-0", "1", "42", "-17", "1.5", "-1.5", "1e9", "1E+9", "1e-9", "0.5e2"] {
            let src = format!("[{good}]");
            assert!(
                scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| false).is_ok(),
                "rejected {good}"
            );
        }
        for bad in ["1.2.3", "--", "1e", "01", "1.", "+1", "1e+", "-", "1ee9"] {
            let src = format!("[{bad}]");
            assert!(
                scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| false).is_err(),
                "accepted {bad}"
            );
        }
    }

    /// The column in a syntax error counts characters, not bytes.
    #[test]
    fn the_error_column_counts_characters() {
        // Ten Korean characters before the malformed value; each is three bytes,
        // so a byte count would report column 36 rather than 16.
        let src = "{\"키키키키키키키키키키\": tru}";
        let err = scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| false)
            .expect_err("must not parse");
        match err {
            Error::JsonSyntax { line, column, .. } => {
                assert_eq!(line, 1);
                assert_eq!(column, 16);
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    use super::*;

    fn scan_ok(src: &str) -> Scan {
        scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| false)
            .unwrap_or_else(|e| panic!("scan failed for {src:?}: {e}"))
    }

    fn err_of(src: &str) -> Error {
        scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| false)
            .err()
            .unwrap_or_else(|| panic!("expected {src:?} to fail"))
    }

    /// Walk the tree the way the viewer does and check the flat invariants that
    /// every later stage relies on.
    fn assert_consistent(scan: &Scan, src: &str) {
        let n = scan.nodes.len() as u32;
        for (i, node) in scan.nodes.iter().enumerate() {
            let i = i as u32;
            assert!(i + node.subtree_size <= n, "node {i} subtree overruns");
            assert!(node.subtree_size >= 1);
            if node.parent != NO_PARENT {
                let parent = &scan.nodes[node.parent as usize];
                assert!(node.parent < i, "parent must precede child");
                assert!(node.parent + parent.subtree_size > i, "child outside parent subtree");
                assert_eq!(node.depth, parent.depth + 1);
            }
            if i > 0 {
                assert!(
                    scan.nodes[i as usize - 1].val_start <= node.val_start,
                    "val_start must be non-decreasing in node order"
                );
            }
            if !scan.synthetic_root || i > 0 {
                let text = &src[node.val_start as usize..(node.val_start + node.val_len) as usize];
                assert!(!text.is_empty(), "node {i} has an empty span");
            }
        }
    }

    #[test]
    fn scalars_and_nesting() {
        let src = r#"{"a": 1, "b": [true, null, "x"], "c": {"d": -2.5e3}}"#;
        let scan = scan_ok(src);
        assert_consistent(&scan, src);

        let root = scan.nodes[0];
        assert_eq!(root.kind, Kind::Object);
        assert_eq!(root.child_count, 3);
        assert_eq!(root.subtree_size, scan.nodes.len() as u32);
        assert_eq!(root.val_len as usize, src.len());

        let kinds: Vec<_> = scan.nodes.iter().map(|n| n.kind).collect();
        assert_eq!(
            kinds,
            [
                Kind::Object,
                Kind::Number,
                Kind::Array,
                Kind::Bool,
                Kind::Null,
                Kind::String,
                Kind::Object,
                Kind::Number,
            ]
        );

        let array = scan.nodes[2];
        assert_eq!(array.child_count, 3);
        assert_eq!(array.subtree_size, 4);
        assert_eq!(&src[array.key_start as usize..(array.key_start + array.key_len) as usize], "b");
        // Array members carry their display index.
        assert_eq!(scan.nodes[3].sibling_index, 0);
        assert_eq!(scan.nodes[5].sibling_index, 2);
    }

    #[test]
    fn empty_containers_are_leaves() {
        let scan = scan_ok(r#"{"a": {}, "b": []}"#);
        assert_eq!(scan.nodes.len(), 3);
        assert_eq!(scan.nodes[1].subtree_size, 1);
        assert_eq!(scan.nodes[1].child_count, 0);
        assert_eq!(scan.nodes[2].child_count, 0);
    }

    #[test]
    fn escapes_do_not_terminate_strings_early() {
        let src = r#"{"a\"b": "c\\", "d": "e\"f"}"#;
        let scan = scan_ok(src);
        assert_consistent(&scan, src);
        assert_eq!(scan.nodes.len(), 3);
        assert_eq!(scan.nodes[0].child_count, 2);
        let key = scan.nodes[1];
        assert_eq!(&src[key.key_start as usize..(key.key_start + key.key_len) as usize], r#"a\"b"#);
    }

    #[test]
    fn unicode_keys_keep_byte_offsets() {
        let src = r#"{"한글": "값", "emoji🙂": 1}"#;
        let scan = scan_ok(src);
        assert_consistent(&scan, src);
        let key = scan.nodes[1];
        assert_eq!(&src[key.key_start as usize..(key.key_start + key.key_len) as usize], "한글");
        let value = scan.nodes[1];
        assert_eq!(
            &src[value.val_start as usize..(value.val_start + value.val_len) as usize],
            "\"값\""
        );
    }

    #[test]
    fn deep_nesting_stays_iterative() {
        let depth = 900;
        let src = format!("{}1{}", "[".repeat(depth), "]".repeat(depth));
        let scan = scan_ok(&src);
        assert_eq!(scan.nodes.len(), depth + 1);
        assert_eq!(scan.nodes[depth].depth, depth as u16);
        assert_eq!(scan.nodes[0].subtree_size, depth as u32 + 1);
    }

    #[test]
    fn depth_limit_is_enforced() {
        let src = format!("{}1{}", "[".repeat(20), "]".repeat(20));
        let limits = ScanLimits {
            max_depth: 8,
            ..Default::default()
        };
        let error = scan(src.as_bytes(), &limits, |_| {}, &|| false)
            .err()
            .expect("depth limit should trip");
        assert!(
            matches!(
                error,
                Error::JsonSyntax {
                    reason: SyntaxReason::TooDeep,
                    ..
                }
            ),
            "{error:?}"
        );
    }

    #[test]
    fn ndjson_gets_a_synthetic_root() {
        let src = "{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n";
        let scan = scan_ok(src);
        assert!(scan.synthetic_root);
        assert_eq!(scan.nodes[0].kind, Kind::Array);
        assert_eq!(scan.nodes[0].child_count, 3);
        assert_eq!(scan.nodes[0].subtree_size, scan.nodes.len() as u32);
        assert_eq!(scan.nodes[1].depth, 1);
        assert_eq!(scan.nodes[1].parent, 0);
        assert_eq!(scan.nodes[2].depth, 2);
        assert_eq!(scan.nodes[2].parent, 1);
    }

    /// Records are `$[0]`, `$[1]`, `$[2]` — not `$[0]`, `$[2]`, `$[4]`.
    ///
    /// Every top-level value used to be numbered by how many nodes had been
    /// scanned before it, which is only the same thing when the roots are
    /// scalars. Paths, path copying and the `[N]` segment of path search all
    /// read this field.
    #[test]
    fn ndjson_roots_are_numbered_in_order() {
        let scan = scan_ok("{\"a\":1}
{\"a\":2}
{\"a\":3}
");
        let roots: Vec<u32> = scan
            .nodes
            .iter()
            .filter(|node| node.parent == 0 && node.depth == 1)
            .map(|node| node.sibling_index)
            .collect();
        assert_eq!(roots, [0, 1, 2]);
    }

    /// Bare scalars hid the bug: one node each means the counter happened to
    /// agree. Mixing them with containers does not.
    #[test]
    fn mixed_roots_are_numbered_in_order() {
        let scan = scan_ok("1
{\"a\":1,\"b\":2}
2
[7,8]
");
        let roots: Vec<u32> = scan
            .nodes
            .iter()
            .filter(|node| node.parent == 0 && node.depth == 1)
            .map(|node| node.sibling_index)
            .collect();
        assert_eq!(roots, [0, 1, 2, 3]);
    }

    #[test]
    fn single_root_needs_no_wrapper() {
        let scan = scan_ok("[1,2,3]");
        assert!(!scan.synthetic_root);
        assert_eq!(scan.nodes[0].parent, NO_PARENT);
        assert_eq!(scan.nodes.len(), 4);
    }

    #[test]
    fn bom_is_stripped_but_offsets_still_index_the_original() {
        let mut bytes = b"\xEF\xBB\xBF".to_vec();
        bytes.extend_from_slice(br#"{"a":1}"#);
        let scan = scan(&bytes, &ScanLimits::default(), |_| {}, &|| false).unwrap();
        let value = scan.nodes[1];
        assert_eq!(&bytes[value.val_start as usize..(value.val_start + value.val_len) as usize], b"1");
        let key = scan.nodes[1];
        assert_eq!(&bytes[key.key_start as usize..(key.key_start + key.key_len) as usize], b"a");
    }

    #[test]
    fn truncated_and_malformed_input_reports_a_position() {
        use SyntaxReason::*;
        let cases: &[(&str, SyntaxReason)] = &[
            (r#"{"a": [1, 2"#, MissingCloser),
            (r#"{"a": "unterminated"#, UnterminatedString),
            (r#"{"a" 1}"#, ExpectedColon),
            (r#"{"a": tru}"#, UnreadableValue),
        ];
        for (src, expected) in cases {
            let error = err_of(src);
            assert!(
                matches!(error, Error::JsonSyntax { reason, .. } if reason == *expected),
                "{src:?} gave {error:?}, wanted {expected:?}"
            );
        }
        assert!(matches!(err_of(""), Error::JsonEmpty));

        // Line and column are what make a truncated 500MB file actionable.
        let error = err_of("{\n  \"a\": [1,\n  2\n");
        let Error::JsonSyntax { line, column, .. } = error else {
            panic!("expected a syntax error, got {error:?}");
        };
        assert!(line >= 3 && column >= 1, "line {line}, column {column}");
    }

    #[test]
    fn cancellation_stops_a_long_scan() {
        let src = format!("[{}]", "1,".repeat(6_000_000) + "1");
        let result = scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| true);
        assert!(result.is_err());
    }

    #[test]
    fn whitespace_between_every_token_is_tolerated() {
        let src = " {\n\t\"a\" : [ 1 , { \"b\" : null } ]\r\n} ";
        let scan = scan_ok(src);
        assert_consistent(&scan, src);
        assert_eq!(scan.nodes.len(), 5);
    }
}
