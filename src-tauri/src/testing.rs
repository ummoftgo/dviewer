//! Finding the generated fixtures, and deciding what their absence means.
//!
//! `fixtures/` is written by `scripts/gen-fixtures.mjs` (and, for Parquet, by
//! `examples/parquet.rs`) and is not kept in the repository. Locally that is a
//! convenience: someone who has just cloned can run `cargo test` without
//! installing Node first, and the tests that have nothing to read step aside.
//!
//! On CI it was a hole. Eleven tests across `xlsx` and `parquet` stepped aside
//! on every runner, every time, because the check job never made the fixtures —
//! so they reported success without asserting anything. A test that passes when
//! its subject is missing is not a test.
//!
//! Both readings are wanted, so which one applies is said out loud rather than
//! guessed: `DVIEWER_FIXTURES=required` turns a missing fixture into a failure,
//! and the check job sets it. Without it nothing changes.

use std::path::PathBuf;

/// The environment variable that says a missing fixture is a failure.
const REQUIRED: &str = "DVIEWER_FIXTURES";

/// The path to a generated fixture, if the tests may run without it.
pub(crate) fn fixture(name: &str) -> Option<PathBuf> {
    fixture_with(std::env::var(REQUIRED).as_deref() == Ok("required"), name)
}

/// The decision itself, with the environment read out of it.
///
/// Split so it can be tested. Setting an environment variable from a test
/// would be read by every other test in the process — they share one — and the
/// runner runs them in parallel, so a test that set `DVIEWER_FIXTURES` would
/// change the answer for whichever tests happened to be running beside it.
fn fixture_with(required: bool, name: &str) -> Option<PathBuf> {
    let path = PathBuf::from("../fixtures").join(name);
    if path.exists() {
        return Some(path);
    }
    assert!(
        !required,
        "{REQUIRED}=required, but ../fixtures/{name} is not there. \
         `node scripts/gen-fixtures.mjs` writes the fixtures; the Parquet one \
         comes from `cargo run --example parquet -- write ../fixtures`."
    );
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The local bargain: no fixture, no assertions, no failure.
    #[test]
    fn a_missing_fixture_is_nothing_to_read_by_default() {
        assert!(fixture_with(false, "no-such-fixture.json").is_none());
    }

    /// The CI bargain: the same absence is the failure it was hiding.
    #[test]
    #[should_panic(expected = "no-such-fixture.json is not there")]
    fn a_missing_fixture_is_a_failure_when_required() {
        fixture_with(true, "no-such-fixture.json");
    }

    /// And when it is there, being required changes nothing about the answer.
    #[test]
    fn a_fixture_that_exists_is_found_either_way() {
        // Any file the generator writes would do; this one is small and has no
        // reader of its own to break. The lookup goes through the public
        // function so this test obeys the policy it is testing: under
        // `required` a missing fixture fails here too, rather than skipping
        // the comparison the way it may locally.
        let Some(found) = fixture("sample.toml") else { return };
        assert_eq!(fixture_with(false, "sample.toml").as_ref(), Some(&found));
        assert_eq!(fixture_with(true, "sample.toml"), Some(found));
    }
}
