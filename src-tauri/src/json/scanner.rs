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

use crate::error::{Error, Result};

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
        return Err(Error::Json(format!(
            "파일이 너무 큽니다 ({}GB). 최대 4GB까지 열 수 있습니다.",
            bytes.len() / 1024 / 1024 / 1024
        )));
    }

    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let bom_offset = (bytes.len() - body.len()) as u32;

    let mut scanner = Scanner {
        b: body,
        p: 0,
        nodes: Vec::new(),
        stack: Vec::new(),
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
        let mut roots = 0u32;
        self.skip_ws();
        if self.p >= self.b.len() {
            return Err(Error::Json("내용이 비어 있습니다.".into()));
        }

        loop {
            if self.p >= self.next_progress {
                if should_stop() {
                    return Err(Error::Cancelled);
                }
                progress(self.p);
                self.next_progress = self.p + PROGRESS_STEP;
            }

            let at_root = self.stack.is_empty();
            let key = self.pending_key.take();
            self.begin_value(key)?;
            if at_root {
                roots += 1;
            }

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
            return Err(self.err_at("값 뒤에 해석할 수 없는 내용이 있습니다"));
        }
        Ok(roots)
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
                return Err(self.err_at("닫는 괄호가 없습니다"));
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
                _ => return Err(self.err_at("',' 또는 닫는 괄호가 필요합니다")),
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
            return Err(self.err_at("값이 필요합니다"));
        }

        if self.nodes.len() as u32 >= self.limits.max_nodes {
            return Err(Error::Json(format!(
                "노드가 너무 많습니다 (최대 {}개). 파일을 나눠서 열어 주세요.",
                self.limits.max_nodes
            )));
        }
        if self.stack.len() as u16 >= self.limits.max_depth {
            return Err(self.err_at("중첩이 너무 깊습니다"));
        }

        let start = self.p;
        let kind = match self.b[start] {
            b'{' => Kind::Object,
            b'[' => Kind::Array,
            b'"' => Kind::String,
            b't' | b'f' => Kind::Bool,
            b'n' => Kind::Null,
            b'-' | b'0'..=b'9' => Kind::Number,
            _ => return Err(self.err_at("값을 해석할 수 없습니다")),
        };

        let (parent, sibling_index) = match self.stack.last_mut() {
            Some((pid, count)) => {
                let index = *count;
                *count += 1;
                (*pid, index)
            }
            None => (NO_PARENT, self.nodes.len() as u32),
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
            return Err(self.err_at("객체 키가 필요합니다"));
        }
        let start = self.p;
        let end = self.scan_string(start)?;
        self.p = end;
        self.skip_ws();
        if self.p >= self.b.len() || self.b[self.p] != b':' {
            return Err(self.err_at("키 뒤에 ':' 가 필요합니다"));
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
                return Err(self.err_at_pos(start, "문자열이 닫히지 않았습니다"));
            };
            let j = i + offset;
            if self.b[j] == b'"' {
                return Ok(j + 1);
            }
            // Skip the backslash and whatever it escapes.
            i = j + 2;
            if i > self.b.len() {
                return Err(self.err_at_pos(start, "문자열이 닫히지 않았습니다"));
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
            return Err(self.err_at_pos(start, "값을 해석할 수 없습니다"));
        }
        Ok(end)
    }

    fn skip_ws(&mut self) {
        while self.p < self.b.len() && matches!(self.b[self.p], b' ' | b'\t' | b'\n' | b'\r') {
            self.p += 1;
        }
    }

    fn err_at(&self, msg: &str) -> Error {
        self.err_at_pos(self.p, msg)
    }

    fn err_at_pos(&self, pos: usize, msg: &str) -> Error {
        let (line, col) = line_col(self.b, pos);
        Error::Json(format!("{line}행 {col}열: {msg}"))
    }
}

fn is_value_start(b: u8) -> bool {
    matches!(b, b'{' | b'[' | b'"' | b't' | b'f' | b'n' | b'-' | b'0'..=b'9')
}

fn is_number(text: &[u8]) -> bool {
    !text.is_empty()
        && text
            .iter()
            .all(|b| matches!(b, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
}

fn line_col(b: &[u8], pos: usize) -> (usize, usize) {
    let upto = &b[..pos.min(b.len())];
    let line = memchr::memchr_iter(b'\n', upto).count() + 1;
    let col = match memchr::memrchr(b'\n', upto) {
        Some(newline) => pos - newline,
        None => pos + 1,
    };
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
    use super::*;

    fn scan_ok(src: &str) -> Scan {
        scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| false)
            .unwrap_or_else(|e| panic!("scan failed for {src:?}: {e}"))
    }

    fn err(src: &str) -> String {
        scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| false)
            .err()
            .unwrap_or_else(|| panic!("expected {src:?} to fail"))
            .to_string()
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
        let message = scan(src.as_bytes(), &limits, |_| {}, &|| false)
            .err()
            .expect("depth limit should trip")
            .to_string();
        assert!(message.contains("중첩이 너무 깊습니다"), "{message}");
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
        assert!(err(r#"{"a": [1, 2"#).contains("닫는 괄호가 없습니다"));
        assert!(err(r#"{"a": "unterminated"#).contains("문자열이 닫히지 않았습니다"));
        assert!(err(r#"{"a" 1}"#).contains("':' 가 필요합니다"));
        assert!(err(r#"{"a": tru}"#).contains("값을 해석할 수 없습니다"));
        assert!(err("").contains("비어 있습니다"));
        // Line/column is what makes a truncated 500MB file actionable.
        assert!(err("{\n  \"a\": [1,\n  2\n").contains("행"));
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
