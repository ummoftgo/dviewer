//! Session coordinates use exact source keys and child ordinals, not display paths.
use super::{TreeDoc, scanner::NO_PARENT};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_PATH: usize = 64 * 1024;
const MAX_DEPTH: usize = 1024;

#[derive(Serialize, Deserialize)]
struct Segment {
    index: u32,
    key: String,
    kind: u8,
}

impl TreeDoc {
    pub fn position_path(&self, mut id: u32) -> Option<String> {
        let mut segments = Vec::new();
        let mut bytes = 0;
        loop {
            let node = self.index.node(id)?;
            bytes += node.key_len as usize;
            if bytes > MAX_PATH || segments.len() >= MAX_DEPTH {
                return None;
            }
            let start = node.key_start as usize;
            let key = std::str::from_utf8(self.bytes.get(start..start + node.key_len as usize)?)
                .ok()?
                .to_owned();
            segments.push(Segment {
                index: node.sibling_index,
                key,
                kind: node.kind as u8,
            });
            if node.parent == NO_PARENT {
                break;
            }
            id = node.parent;
        }
        segments.reverse();
        let path = serde_json::to_string(&segments).ok()?;
        (path.len() <= MAX_PATH).then_some(path)
    }

    pub fn position_resolve(&self, path: &str, cancel: &AtomicBool) -> Option<u32> {
        if path.len() > MAX_PATH || cancel.load(Ordering::Relaxed) {
            return None;
        }
        let segments: Vec<Segment> = serde_json::from_str(path).ok()?;
        if segments.is_empty() || segments.len() > MAX_DEPTH {
            return None;
        }
        let mut id = 0;
        let mut steps = 0usize;
        for (depth, segment) in segments.iter().enumerate() {
            if depth > 0 {
                let parent = self.index.node(id)?;
                if segment.index >= parent.child_count {
                    return None;
                }
                let end = id.checked_add(parent.subtree_size)?;
                id += 1;
                for _ in 0..segment.index {
                    if steps % 4096 == 0 && cancel.load(Ordering::Relaxed) {
                        return None;
                    }
                    steps += 1;
                    id = id.checked_add(self.index.node(id)?.subtree_size.max(1))?;
                    if id >= end {
                        return None;
                    }
                }
            }
            let node = self.index.node(id)?;
            let start = node.key_start as usize;
            if node.kind as u8 != segment.kind
                || node.sibling_index != segment.index
                || self.bytes.get(start..start + node.key_len as usize)? != segment.key.as_bytes()
            {
                return None;
            }
        }
        if cancel.load(Ordering::Relaxed) {
            None
        } else {
            Some(id)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::DocBytes;
    use crate::tree::{index::Syntax, scanner::ScanLimits};
    use std::sync::Arc;

    fn doc(source: &str, syntax: Syntax) -> TreeDoc {
        TreeDoc::build(
            Arc::new(DocBytes::from(source.as_bytes().to_vec())),
            syntax,
            &ScanLimits::default(),
            |_| {},
            &|| false,
        )
        .unwrap()
    }

    #[test]
    fn exact_paths_survive_reindexing_and_distinguish_long_and_duplicate_keys() {
        let key = "k".repeat(250);
        let before = doc(
            &format!(r#"{{"first":[],"{key}A":1,"{key}B":2,"same":3,"same":4}}"#),
            Syntax::Json,
        );
        let after = doc(
            &format!(r#"{{"first":[0,1,2],"{key}A":1,"{key}B":2,"same":3,"same":4}}"#),
            Syntax::Json,
        );
        let cancel = AtomicBool::new(false);
        let children = before.index.children(0, 0, 10);
        let targets = after.index.children(0, 0, 10);
        for (id, target) in children.iter().zip(targets) {
            assert_eq!(
                after.position_resolve(&before.position_path(*id).unwrap(), &cancel),
                Some(target)
            );
        }
        assert_ne!(
            before.position_path(children[1]),
            before.position_path(children[2])
        );
        assert_ne!(
            before.position_path(children[3]),
            before.position_path(children[4])
        );
        let missing = doc(r#"{"first":[],"different":1}"#, Syntax::Json);
        assert_eq!(
            missing.position_resolve(&before.position_path(children[1]).unwrap(), &cancel),
            None
        );
    }

    #[test]
    fn xml_text_comments_and_wide_mixed_siblings_round_trip_exactly() {
        let source = format!(
            "<root a=\"1\">{}<b/>left<!--a-->right<!--b--><a/></root>",
            "<a/>".repeat(4100)
        );
        let tree = doc(&source, Syntax::Xml);
        let cancel = AtomicBool::new(false);
        for id in 0..tree.index.nodes.len() as u32 {
            assert_eq!(
                tree.position_resolve(&tree.position_path(id).unwrap(), &cancel),
                Some(id)
            );
        }
        assert_eq!(tree.position_resolve("[]", &cancel), None);
        assert_eq!(tree.position_resolve("broken", &cancel), None);
        assert_eq!(
            tree.position_resolve(&"x".repeat(MAX_PATH + 1), &cancel),
            None
        );
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(
            tree.position_resolve(&tree.position_path(0).unwrap(), &cancel),
            None
        );
    }
}
