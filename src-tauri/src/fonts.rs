//! System font enumeration.
//!
//! The settings panel offers a real list rather than a free-text box, because
//! a mistyped family name fails silently — the text just renders in whatever
//! the fallback happens to be, with nothing to say why.
//!
//! `fontdb` is pure Rust, so this needs no DirectWrite/CoreText/fontconfig
//! bindings and builds the same way everywhere.

use std::sync::OnceLock;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub name: String,
    /// True when any face in the family is monospaced, which is what the code
    /// font picker sorts on.
    pub monospace: bool,
}

static FAMILIES: OnceLock<Vec<FontFamily>> = OnceLock::new();

/// Every installed family, sorted by name. Scanning the system font
/// directories takes a few hundred milliseconds, so the result is cached for
/// the life of the process — fonts do not come and go while an app is open.
pub fn families() -> &'static [FontFamily] {
    FAMILIES.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();

        // A family is monospaced if any of its faces is: a family with a
        // monospaced regular and a proportional italic is still a code font.
        let mut by_name: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();
        for face in db.faces() {
            let Some((name, _)) = face.families.first() else {
                continue;
            };
            if name.trim().is_empty() {
                continue;
            }
            let entry = by_name.entry(name.clone()).or_insert(false);
            *entry |= face.monospaced;
        }

        by_name
            .into_iter()
            .map(|(name, monospace)| FontFamily { name, monospace })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_has_fonts_and_at_least_one_is_monospaced() {
        let all = families();

        // The invariants this code owns hold whatever the machine has
        // installed, so they are checked unconditionally.
        assert!(all.windows(2).all(|w| w[0].name <= w[1].name), "not sorted");
        assert!(all.iter().all(|f| !f.name.trim().is_empty()));

        // Whether any font exists is the machine's business, not this module's.
        // A headless CI container legitimately has none, and failing there
        // would say nothing about the code.
        if all.is_empty() {
            eprintln!("no fonts installed; skipped the coverage assertions");
            return;
        }
        assert!(
            all.iter().any(|f| f.monospace),
            "fonts are installed but none is monospaced"
        );
    }

    #[test]
    fn the_scan_happens_only_once() {
        let first = families().as_ptr();
        let second = families().as_ptr();
        assert_eq!(first, second);
    }
}
