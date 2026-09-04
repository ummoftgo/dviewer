//! XML, scanned into the same flat node index the JSON tree engine reads.
//!
//! Converting XML to JSON first would have been less code, and it is what most
//! viewers do. It is also lossy in exactly the places a reader cares about:
//! attributes become keys indistinguishable from child elements, two siblings
//! with the same name have to collapse into an array, order across different
//! names is lost, and comments disappear. A viewer's whole job is to show what
//! the file says, so XML gets its own scan and its own node kinds.
//!
//! What it borrows is everything after the scan — the flat pre-order index,
//! bitset visibility, virtual scrolling, search, path copying. Those never
//! cared what wrote the nodes.
//!
//! Two things are deliberately dropped. The `<?xml ...?>` declaration is about
//! the encoding of the file rather than its content, and keeping it would put
//! a second top-level node beside the root element in almost every document,
//! forcing a synthetic root onto all of them. Whitespace-only text between
//! elements is indentation, not content.

use quick_xml::events::Event;
use quick_xml::reader::Reader;

use crate::error::{Error, Result, Subject};
use crate::tree::scanner::{Kind, MAX_DOC_BYTES, NO_PARENT, Node, Scan, ScanLimits};

const PROGRESS_STEP: u64 = 8 * 1024 * 1024;

/// Scan `bytes` into a pre-order node index.
///
/// Mirrors `json::scanner::scan`: progress is a byte offset, and `should_stop`
/// is polled at the same cadence so a closed tab can abort the scan.
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
    let bom = (bytes.len() - body.len()) as u32;

    let mut reader = Reader::from_reader(body);
    {
        let config = reader.config_mut();
        // A viewer opens files it did not write. Refusing to show a document
        // over a mismatched closing tag helps nobody — the reader is usually
        // looking at it *because* something is wrong with it.
        config.check_end_names = false;
        config.allow_unmatched_ends = true;
        config.check_comments = false;
        config.allow_dangling_amp = true;
        // Indentation is handled here, not by the parser, because a text run
        // has to be measured before it can be judged whitespace-only.
        config.trim_text_start = false;
        config.trim_text_end = false;
        config.expand_empty_elements = false;
    }

    let mut builder = Builder {
        nodes: Vec::new(),
        stack: Vec::new(),
        roots: 0,
        limits,
    };
    let mut pending_text: Option<(u32, u32)> = None;
    let mut next_progress = PROGRESS_STEP;

    loop {
        let start = reader.buffer_position();
        if start >= next_progress {
            if should_stop() {
                return Err(Error::Cancelled);
            }
            progress(start as usize);
            next_progress = start + PROGRESS_STEP;
        }

        let event = reader
            .read_event()
            .map_err(|e| Error::XmlSyntax {
                offset: start,
                detail: e.to_string(),
            })?;
        let end = reader.buffer_position();
        let span = (bom + start as u32, (end - start) as u32);

        // Character data arrives in runs — quick-xml breaks a text node at every
        // `&entity;` — so adjacent pieces are merged back into one span before
        // anything else is emitted.
        let is_text = matches!(event, Event::Text(_) | Event::GeneralRef(_));
        let is_empty_tag = matches!(event, Event::Empty(_));
        if !is_text {
            if let Some(text) = pending_text.take() {
                // Indentation between elements is not content, and keeping it
                // would put a blank row between every pair of siblings.
                let from = (text.0 - bom) as usize;
                let raw = &body[from..from + text.1 as usize];
                if !raw.iter().all(u8::is_ascii_whitespace) {
                    builder.push_leaf(Kind::Text, (text.0, 0), text)?;
                }
            }
        }

        match event {
            Event::Eof => break,
            Event::Text(_) | Event::GeneralRef(_) => {
                pending_text = Some(match pending_text {
                    Some((first, len)) => (first, len + span.1),
                    None => span,
                });
            }
            Event::Start(e) | Event::Empty(e) => {
                let name =
                    span_of(body, e.name().into_inner().as_bytes(), bom).unwrap_or((span.0, 0));
                let id = builder.open(name, span.0)?;
                let attributes = attributes(body, &e, bom);
                builder.mark_attributes(id, !attributes.is_empty());
                for (key, value) in attributes {
                    builder.push_leaf(Kind::Attribute, key, value)?;
                }
                // Content begins just past the start tag; for `<a/>` that is
                // also where its empty value sits.
                builder.set_content_start(id, bom + end as u32);
                if is_empty_tag {
                    builder.close(bom + end as u32);
                }
            }
            Event::End(_) => builder.close(bom + end as u32),
            Event::CData(_) => builder.push_leaf(Kind::CData, (span.0, 0), inner(span, 9, 3))?,
            Event::Comment(_) => builder.push_leaf(Kind::Comment, (span.0, 0), inner(span, 4, 3))?,
            Event::DocType(_) | Event::PI(_) => {
                builder.push_leaf(Kind::Directive, (span.0, 0), span)?
            }
            // See the module note: the declaration describes the file, not the
            // document.
            Event::Decl(_) => {}
        }
    }

    progress(body.len());

    let mut nodes = builder.nodes;
    let roots = builder.roots;
    let synthetic_root = roots != 1;
    if synthetic_root {
        crate::tree::scanner::wrap_in_synthetic_root(&mut nodes, roots, bytes.len() as u32);
    }

    Ok(Scan {
        nodes,
        // XML comments are nodes of their own — see `architecture.md`. Nothing
        // here is an annotation on another node, whether it was written above
        // a value or after one.
        comments: Vec::new(),
        remarks: Vec::new(),
        synthetic_root,
    })
}

/// The content of a delimited construct: `<!--` … `-->` and `<![CDATA[` … `]]>`
/// both wrap their text in fixed-length markers.
fn inner(span: (u32, u32), open: u32, close: u32) -> (u32, u32) {
    let (start, len) = span;
    if len >= open + close {
        (start + open, len - open - close)
    } else {
        (start, len)
    }
}

/// Byte span of a borrowed sub-slice within the document.
///
/// The reader borrows straight from the input, so a name or an attribute value
/// is a view into the very bytes being scanned and its offset is the difference
/// between the two pointers. The bounds check is what makes that safe to
/// assume: anything quick-xml had to copy falls outside the range and is
/// reported as absent instead of as a wrong offset.
fn span_of(document: &[u8], part: &[u8], bom: u32) -> Option<(u32, u32)> {
    let base = document.as_ptr() as usize;
    let at = part.as_ptr() as usize;
    if at < base || at + part.len() > base + document.len() {
        return None;
    }
    Some((bom + (at - base) as u32, part.len() as u32))
}

/// Key and value spans for each attribute of a start tag.
fn attributes(
    document: &[u8],
    tag: &quick_xml::events::BytesStart<'_>,
    bom: u32,
) -> Vec<((u32, u32), (u32, u32))> {
    let mut out = Vec::new();
    for attribute in tag.attributes().flatten() {
        let Some(key) = span_of(document, attribute.key.into_inner().as_bytes(), bom) else {
            continue;
        };
        // An attribute with no value (`<input disabled>`) still deserves a row;
        // its value is the empty span just past the name.
        let value = span_of(document, attribute.value.as_bytes(), bom)
            .unwrap_or((key.0 + key.1, 0));
        out.push((key, value));
    }
    out
}

struct Frame {
    node: u32,
    children: u32,
    has_attributes: bool,
    /// Where the element's content begins, just past its start tag.
    content_start: u32,
}

struct Builder<'a> {
    nodes: Vec<Node>,
    stack: Vec<Frame>,
    roots: u32,
    limits: &'a ScanLimits,
}

impl Builder<'_> {
    fn check_room(&self) -> Result<()> {
        if self.nodes.len() as u32 >= self.limits.max_nodes {
            return Err(Error::TooManyNodes {
                limit: self.limits.max_nodes,
            });
        }
        if self.stack.len() as u16 >= self.limits.max_depth {
            return Err(Error::TooDeep {
                subject: Subject::Xml,
                limit: u32::from(self.limits.max_depth),
            });
        }
        Ok(())
    }

    fn parent(&self) -> u32 {
        self.stack.last().map_or(NO_PARENT, |frame| frame.node)
    }

    fn sibling_index(&self) -> u32 {
        self.stack.last().map_or(self.roots, |frame| frame.children)
    }

    fn count_child(&mut self) {
        match self.stack.last_mut() {
            Some(frame) => frame.children += 1,
            None => self.roots += 1,
        }
    }

    fn open(&mut self, name: (u32, u32), start: u32) -> Result<u32> {
        self.check_room()?;
        let id = self.nodes.len() as u32;
        self.nodes.push(Node {
            key_start: name.0,
            key_len: name.1,
            val_start: start,
            val_len: 0,
            subtree_size: 0,
            child_count: 0,
            parent: self.parent(),
            sibling_index: self.sibling_index(),
            depth: self.stack.len() as u16,
            kind: Kind::Element,
        });
        self.count_child();
        self.stack.push(Frame {
            node: id,
            children: 0,
            has_attributes: false,
            content_start: start,
        });
        Ok(id)
    }

    fn mark_attributes(&mut self, id: u32, has: bool) {
        if let Some(frame) = self.stack.last_mut() {
            if frame.node == id {
                frame.has_attributes = has;
            }
        }
    }

    fn set_content_start(&mut self, id: u32, at: u32) {
        if let Some(frame) = self.stack.last_mut() {
            if frame.node == id {
                frame.content_start = at;
            }
        }
    }

    fn push_leaf(&mut self, kind: Kind, key: (u32, u32), value: (u32, u32)) -> Result<()> {
        self.check_room()?;
        self.nodes.push(Node {
            key_start: key.0,
            key_len: key.1,
            val_start: value.0,
            val_len: value.1,
            subtree_size: 1,
            child_count: 0,
            parent: self.parent(),
            sibling_index: self.sibling_index(),
            depth: self.stack.len() as u16,
            kind,
        });
        self.count_child();
        Ok(())
    }

    fn close(&mut self, end: u32) {
        let Some(frame) = self.stack.pop() else {
            return;
        };
        let id = frame.node as usize;
        let subtree = self.nodes.len() as u32 - frame.node;
        let text_only = frame.children == 1
            && !frame.has_attributes
            && self.nodes.last().is_some_and(|n| n.kind == Kind::Text);

        if text_only {
            // The single text child is the last node pushed, so dropping it
            // costs nothing and no id shifts. Its span becomes the element's
            // value: `<name>John</name>` reads as one row instead of two.
            let text = self.nodes.pop().expect("just checked");
            let node = &mut self.nodes[id];
            node.kind = Kind::ElementText;
            node.val_start = text.val_start;
            node.val_len = text.val_len;
            node.child_count = 0;
            node.subtree_size = 1;
        } else if frame.children == 0 && !frame.has_attributes {
            let node = &mut self.nodes[id];
            node.kind = Kind::ElementText;
            node.val_start = frame.content_start;
            node.val_len = 0;
            node.child_count = 0;
            node.subtree_size = 1;
        } else {
            let start = self.nodes[id].val_start;
            let node = &mut self.nodes[id];
            node.val_len = end.saturating_sub(start);
            node.child_count = frame.children;
            node.subtree_size = subtree;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_ok(src: &str) -> Scan {
        scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| false)
            .unwrap_or_else(|e| panic!("scan failed for {src:?}: {e}"))
    }

    fn text_of<'a>(src: &'a str, node: &Node) -> &'a str {
        &src[node.val_start as usize..(node.val_start + node.val_len) as usize]
    }

    fn key_of<'a>(src: &'a str, node: &Node) -> &'a str {
        &src[node.key_start as usize..(node.key_start + node.key_len) as usize]
    }

    /// Every stage after the scan assumes ids run in document order and that a
    /// subtree is a contiguous range. Nothing works if this is not true.
    fn assert_consistent(scan: &Scan) {
        let nodes = &scan.nodes;
        for (i, node) in nodes.iter().enumerate() {
            let id = i as u32;
            assert!(
                node.subtree_size >= 1,
                "node {id} has an empty subtree: {node:?}"
            );
            assert!(
                id + node.subtree_size <= nodes.len() as u32,
                "node {id}'s subtree runs past the end"
            );
            if node.parent != NO_PARENT {
                assert!(node.parent < id, "node {id}'s parent comes after it");
                let parent = &nodes[node.parent as usize];
                assert_eq!(node.depth, parent.depth + 1, "node {id} depth");
                assert!(node.parent + parent.subtree_size > id, "node {id} outside parent");
            }
            let children = nodes
                .iter()
                .enumerate()
                .filter(|(j, n)| n.parent == id && *j != i)
                .count() as u32;
            assert_eq!(children, node.child_count, "node {id} child count");
        }
        let starts: Vec<u32> = nodes.iter().map(|n| n.val_start).collect();
        assert!(
            starts.windows(2).all(|w| w[0] <= w[1]),
            "val_start must not decrease in node order"
        );
    }

    #[test]
    fn a_single_root_needs_no_synthetic_wrapper() {
        let scan = scan_ok("<root><a/></root>");
        assert!(!scan.synthetic_root);
        assert_eq!(scan.nodes[0].kind, Kind::Element);
        assert_consistent(&scan);
    }

    /// Nearly every XML file starts with a declaration; keeping it would put a
    /// synthetic root on nearly every document.
    #[test]
    fn the_declaration_does_not_become_a_node() {
        let src = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><root/>";
        let scan = scan_ok(src);
        assert!(!scan.synthetic_root);
        assert_eq!(scan.nodes.len(), 1);
        assert_eq!(key_of(src, &scan.nodes[0]), "root");
    }

    #[test]
    fn a_text_only_element_is_one_row_not_two() {
        let src = "<root><name>John</name></root>";
        let scan = scan_ok(src);
        assert_eq!(scan.nodes.len(), 2);
        let name = &scan.nodes[1];
        assert_eq!(name.kind, Kind::ElementText);
        assert_eq!(key_of(src, name), "name");
        assert_eq!(text_of(src, name), "John");
        assert_eq!(name.child_count, 0);
        assert_consistent(&scan);
    }

    #[test]
    fn attributes_become_children_of_their_element() {
        let src = r#"<item id="7" kind="book"/>"#;
        let scan = scan_ok(src);
        assert_eq!(scan.nodes.len(), 3);
        assert_eq!(scan.nodes[0].kind, Kind::Element);
        assert_eq!(scan.nodes[0].child_count, 2);
        assert_eq!(scan.nodes[1].kind, Kind::Attribute);
        assert_eq!(key_of(src, &scan.nodes[1]), "id");
        assert_eq!(text_of(src, &scan.nodes[1]), "7");
        assert_eq!(key_of(src, &scan.nodes[2]), "kind");
        assert_eq!(text_of(src, &scan.nodes[2]), "book");
        assert_consistent(&scan);
    }

    /// An element with an attribute cannot fold its text away — the attribute
    /// has to have somewhere to live.
    #[test]
    fn text_beside_an_attribute_stays_a_child() {
        let src = r#"<a id="1">hello</a>"#;
        let scan = scan_ok(src);
        assert_eq!(scan.nodes[0].kind, Kind::Element);
        assert_eq!(scan.nodes[0].child_count, 2);
        assert_eq!(scan.nodes[2].kind, Kind::Text);
        assert_eq!(text_of(src, &scan.nodes[2]), "hello");
        assert_consistent(&scan);
    }

    #[test]
    fn an_empty_element_has_an_empty_value() {
        let src = "<root><a/><b></b></root>";
        let scan = scan_ok(src);
        assert_eq!(scan.nodes.len(), 3);
        for node in &scan.nodes[1..] {
            assert_eq!(node.kind, Kind::ElementText);
            assert_eq!(node.val_len, 0);
        }
        assert_consistent(&scan);
    }

    #[test]
    fn indentation_between_elements_is_not_content() {
        let src = "<root>\n  <a>1</a>\n  <b>2</b>\n</root>";
        let scan = scan_ok(src);
        assert_eq!(scan.nodes.len(), 3);
        assert_eq!(scan.nodes[0].child_count, 2);
        assert_consistent(&scan);
    }

    #[test]
    fn mixed_content_keeps_its_text_in_order() {
        let src = "<p>before<b>bold</b>after</p>";
        let scan = scan_ok(src);
        let kinds: Vec<Kind> = scan.nodes.iter().map(|n| n.kind).collect();
        assert_eq!(
            kinds,
            vec![Kind::Element, Kind::Text, Kind::ElementText, Kind::Text]
        );
        assert_eq!(text_of(src, &scan.nodes[1]), "before");
        assert_eq!(text_of(src, &scan.nodes[3]), "after");
        assert_consistent(&scan);
    }

    /// quick-xml breaks a text run at every entity, so the pieces have to be
    /// merged back or `a &amp; b` would show up as three separate rows.
    #[test]
    fn an_entity_does_not_split_the_text_around_it() {
        let src = "<a>x &amp; y</a>";
        let scan = scan_ok(src);
        assert_eq!(scan.nodes.len(), 1);
        assert_eq!(scan.nodes[0].kind, Kind::ElementText);
        assert_eq!(text_of(src, &scan.nodes[0]), "x &amp; y");
    }

    #[test]
    fn comments_and_cdata_show_their_contents() {
        let src = "<root><!-- note --><![CDATA[raw <text>]]></root>";
        let scan = scan_ok(src);
        assert_eq!(scan.nodes[1].kind, Kind::Comment);
        assert_eq!(text_of(src, &scan.nodes[1]), " note ");
        assert_eq!(scan.nodes[2].kind, Kind::CData);
        assert_eq!(text_of(src, &scan.nodes[2]), "raw <text>");
        assert_consistent(&scan);
    }

    #[test]
    fn a_doctype_is_a_directive_beside_the_root() {
        let src = "<!DOCTYPE html><html/>";
        let scan = scan_ok(src);
        assert!(scan.synthetic_root);
        assert_eq!(scan.nodes[0].kind, Kind::Array);
        assert_eq!(scan.nodes[1].kind, Kind::Directive);
        assert_consistent(&scan);
    }

    #[test]
    fn namespaced_names_are_kept_as_written() {
        let src = r#"<x:root xmlns:x="urn:x"><x:a>1</x:a></x:root>"#;
        let scan = scan_ok(src);
        assert_eq!(key_of(src, &scan.nodes[0]), "x:root");
        assert_eq!(key_of(src, &scan.nodes[1]), "xmlns:x");
        assert_eq!(key_of(src, &scan.nodes[2]), "x:a");
        assert_consistent(&scan);
    }

    /// Same name twice is ordinary XML and must not collapse the way a JSON
    /// object's duplicate keys would.
    #[test]
    fn repeated_sibling_names_stay_separate() {
        let src = "<list><item>a</item><item>b</item><item>c</item></list>";
        let scan = scan_ok(src);
        assert_eq!(scan.nodes[0].child_count, 3);
        assert_eq!(text_of(src, &scan.nodes[1]), "a");
        assert_eq!(text_of(src, &scan.nodes[3]), "c");
        assert_eq!(scan.nodes[3].sibling_index, 2);
        assert_consistent(&scan);
    }

    #[test]
    fn a_byte_order_mark_does_not_shift_the_offsets() {
        let src = "\u{feff}<a>x</a>";
        let scan = scan_ok(src);
        assert_eq!(scan.nodes.len(), 1);
        assert_eq!(text_of(src, &scan.nodes[0]), "x");
        assert_eq!(key_of(src, &scan.nodes[0]), "a");
    }

    #[test]
    fn deep_nesting_is_scanned_without_recursion() {
        let depth = 900;
        let src = format!("{}{}", "<a>".repeat(depth), "</a>".repeat(depth));
        let scan = scan_ok(&src);
        assert_eq!(scan.nodes.len(), depth);
        assert_eq!(scan.nodes[depth - 1].depth, depth as u16 - 1);
        assert_consistent(&scan);
    }

    #[test]
    fn nesting_past_the_limit_is_refused() {
        let limits = ScanLimits {
            max_nodes: 1000,
            max_depth: 8,
        };
        let src = format!("{}{}", "<a>".repeat(20), "</a>".repeat(20));
        let error = scan(src.as_bytes(), &limits, |_| {}, &|| false).expect_err("should fail");
        assert!(
            matches!(
                error,
                Error::TooDeep {
                    subject: Subject::Xml,
                    limit: 8,
                }
            ),
            "{error:?}"
        );
    }

    #[test]
    fn a_mismatched_closing_tag_still_shows_the_document() {
        let src = "<root><a>1</b></root>";
        let scan = scan_ok(src);
        assert!(!scan.nodes.is_empty());
        assert_consistent(&scan);
    }

    #[test]
    fn cancellation_stops_a_long_scan() {
        let src = format!("<root>{}</root>", "<a>1</a>".repeat(2_000_000));
        let result = scan(src.as_bytes(), &ScanLimits::default(), |_| {}, &|| true);
        assert!(result.is_err());
    }

    #[test]
    fn progress_reaches_the_end_of_the_document() {
        let src = "<root><a>1</a></root>";
        let mut last = 0;
        let _ = scan(src.as_bytes(), &ScanLimits::default(), |at| last = at, &|| false);
        assert_eq!(last, src.len());
    }
}
