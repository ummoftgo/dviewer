//! The command line.
//!
//! `dviewer report.md`, `dviewer --open=data.json`, `dviewer --open-url=https://…`
//! and `--new` to put the result in its own window rather than a tab of the one
//! already open.
//!
//! Parsing is a pure function over the arguments so it can be tested without a
//! window — which matters, because the second invocation of the app never gets
//! a window of its own: its arguments arrive in the *first* process through the
//! single-instance plugin, and a mistake there is invisible until someone tries
//! to open a file from a shell.
//!
//! Unknown flags are ignored rather than refused. A GUI process on Windows has
//! nowhere to print a complaint, so failing would just mean a window that never
//! appears.
//!
//! The `--smoke*` flags are the self-check the smoke harness drives. They are
//! parsed here with everything else so there is one parser: `lib.rs` peeks at
//! the raw arguments before building the app, but only far enough to know that
//! a smoke run is happening — what it *is* is decided here.

use std::path::PathBuf;

use serde::Serialize;

/// What a launch asks the app to open.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub files: Vec<String>,
    pub urls: Vec<String>,
}

impl LaunchRequest {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && self.urls.is_empty()
    }
}

/// What a self-check run is being asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SmokeMode {
    /// Open everything the manifest lists, and report on each.
    Run { manifest: PathBuf },
    /// Open nothing, and wait for a request another process delivers.
    ///
    /// The other half of the single-instance round trip: a second `dviewer`
    /// hands its arguments to this one and exits, and only this process can say
    /// whether they arrived.
    Listen,
}

/// A self-check run: what to do, and where to write what happened.
///
/// Both flags are required and neither has a default. The mode ships in the
/// released binary — testing something other than what is shipped would give up
/// half the reason this harness exists — so it must not be possible to start
/// one by accident, or to have it write somewhere nobody asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Smoke {
    pub mode: SmokeMode,
    pub out: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Launch {
    pub request: LaunchRequest,
    /// `--new`: open a window of its own instead of a tab in the running one.
    pub new_window: bool,
    pub smoke: Option<Smoke>,
}

/// Parse the arguments after the executable's own name.
pub fn parse<S: AsRef<str>>(args: &[S]) -> Launch {
    let mut launch = Launch::default();
    let mut rest = args.iter().map(AsRef::as_ref);
    let mut manifest: Option<String> = None;
    let mut out: Option<String> = None;
    let mut listen = false;

    while let Some(arg) = rest.next() {
        match arg {
            "--new" => launch.new_window = true,
            "--smoke-listen" => listen = true,
            "--smoke" => manifest = rest.next().map(str::to_owned),
            "--smoke-out" => out = rest.next().map(str::to_owned),
            // `--open path` and `--open=path` are both common enough that
            // supporting one and not the other reads as a bug.
            "--open" => {
                if let Some(value) = rest.next() {
                    launch.request.files.push(value.to_owned());
                }
            }
            "--open-url" => {
                if let Some(value) = rest.next() {
                    launch.request.urls.push(value.to_owned());
                }
            }
            _ => {
                if let Some(value) = arg.strip_prefix("--open=") {
                    push(&mut launch.request.files, value);
                } else if let Some(value) = arg.strip_prefix("--open-url=") {
                    push(&mut launch.request.urls, value);
                } else if let Some(value) = arg.strip_prefix("--smoke=") {
                    manifest = Some(value.to_owned());
                } else if let Some(value) = arg.strip_prefix("--smoke-out=") {
                    out = Some(value.to_owned());
                } else if !arg.starts_with('-') {
                    // A bare path, so `dviewer report.md` works and so does a
                    // file association.
                    push(&mut launch.request.files, arg);
                }
            }
        }
    }

    // Both halves or neither. A run with nowhere to write its results would
    // report by exit code alone, which is the one thing this harness must not
    // do: the exit code cannot say *which* document went wrong.
    launch.smoke = out.filter(|path| !path.is_empty()).and_then(|out| {
        let mode = if listen {
            SmokeMode::Listen
        } else {
            SmokeMode::Run {
                manifest: unquote(&manifest?).into(),
            }
        };
        Some(Smoke {
            mode,
            out: unquote(&out).into(),
        })
    });
    launch
}

/// The same unwrapping `push` does, for values that are not document paths.
fn unquote(value: &str) -> String {
    value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(value)
        .to_owned()
}

/// Shells vary in how much quoting survives, so a value that arrives still
/// wrapped in quotes is unwrapped rather than treated as part of the path.
fn push(into: &mut Vec<String>, value: &str) {
    let trimmed = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(value);
    if !trimmed.is_empty() {
        into.push(trimmed.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(args: &[&str]) -> Launch {
        parse(args)
    }

    #[test]
    fn a_bare_path_is_a_file() {
        let launch = parsed(&["report.md"]);
        assert_eq!(launch.request.files, ["report.md"]);
        assert!(launch.request.urls.is_empty());
        assert!(!launch.new_window);
    }

    #[test]
    fn both_spellings_of_a_flag_work() {
        assert_eq!(parsed(&["--open=a.json"]).request.files, ["a.json"]);
        assert_eq!(parsed(&["--open", "a.json"]).request.files, ["a.json"]);
        assert_eq!(
            parsed(&["--open-url=https://x/y"]).request.urls,
            ["https://x/y"]
        );
        assert_eq!(
            parsed(&["--open-url", "https://x/y"]).request.urls,
            ["https://x/y"]
        );
    }

    #[test]
    fn several_documents_open_in_order() {
        let launch = parsed(&["a.json", "--open=b.yaml", "--open", "c.xml"]);
        assert_eq!(launch.request.files, ["a.json", "b.yaml", "c.xml"]);
    }

    #[test]
    fn files_and_urls_are_kept_apart() {
        let launch = parsed(&["--open=a.json", "--open-url=https://x", "b.csv"]);
        assert_eq!(launch.request.files, ["a.json", "b.csv"]);
        assert_eq!(launch.request.urls, ["https://x"]);
    }

    #[test]
    fn new_asks_for_a_window_of_its_own() {
        let launch = parsed(&["--new", "--open=a.json"]);
        assert!(launch.new_window);
        assert_eq!(launch.request.files, ["a.json"]);
        // Order must not matter — nobody remembers where a flag goes.
        assert!(parsed(&["--open=a.json", "--new"]).new_window);
    }

    /// A path with a space survives a shell that passed the quotes through.
    #[test]
    fn quotes_around_a_value_are_not_part_of_the_path() {
        assert_eq!(
            parsed(&["--open=\"C:/My Files/a.json\""]).request.files,
            ["C:/My Files/a.json"]
        );
    }

    #[test]
    fn a_self_check_needs_both_a_plan_and_somewhere_to_write() {
        let launch = parsed(&["--smoke=fixtures/smoke.json", "--smoke-out=out.jsonl"]);
        assert_eq!(
            launch.smoke,
            Some(Smoke {
                mode: SmokeMode::Run {
                    manifest: "fixtures/smoke.json".into()
                },
                out: "out.jsonl".into(),
            })
        );
        assert_eq!(
            parsed(&["--smoke", "fixtures/smoke.json", "--smoke-out", "out.jsonl"]).smoke,
            launch.smoke,
        );
    }

    /// Half a request is not a request. A run with nowhere to write could only
    /// report by exit code, and an exit code cannot name the document that
    /// went wrong.
    #[test]
    fn half_a_self_check_is_no_self_check() {
        assert!(parsed(&["--smoke=fixtures/smoke.json"]).smoke.is_none());
        assert!(parsed(&["--smoke-out=out.jsonl"]).smoke.is_none());
        assert!(parsed(&["--smoke-out="]).smoke.is_none());
        assert!(parsed(&["--smoke-listen"]).smoke.is_none());
    }

    /// The listening half of the single-instance round trip opens nothing, so
    /// it has no manifest to be given.
    #[test]
    fn listening_needs_no_plan() {
        let launch = parsed(&["--smoke-listen", "--smoke-out=out.jsonl"]);
        assert_eq!(
            launch.smoke,
            Some(Smoke {
                mode: SmokeMode::Listen,
                out: "out.jsonl".into()
            })
        );
    }

    /// Ordinary launches must not grow a self-check by accident — the mode
    /// ships in the released binary.
    #[test]
    fn nothing_else_starts_a_self_check() {
        assert!(parsed(&["a.json", "--new"]).smoke.is_none());
        assert!(parsed(&[]).smoke.is_none());
    }

    #[test]
    fn a_quoted_result_path_is_unwrapped_like_a_document_path() {
        let launch = parsed(&["--smoke=\"a b/smoke.json\"", "--smoke-out=\"c d/out.jsonl\""]);
        assert_eq!(
            launch.smoke.expect("smoke").out,
            std::path::PathBuf::from("c d/out.jsonl")
        );
    }

    /// A GUI process has nowhere to print a complaint, so an argument it does
    /// not know is skipped rather than fatal.
    #[test]
    fn unknown_flags_are_ignored() {
        let launch = parsed(&["--verbose", "-x", "--open=a.json"]);
        assert_eq!(launch.request.files, ["a.json"]);
        assert!(!launch.new_window);
    }

    #[test]
    fn a_flag_with_nothing_after_it_adds_nothing() {
        assert!(parsed(&["--open"]).request.is_empty());
        assert!(parsed(&["--open-url"]).request.is_empty());
        assert!(parsed(&["--open="]).request.is_empty());
    }

    #[test]
    fn no_arguments_asks_for_nothing() {
        let launch = parsed(&[]);
        assert!(launch.request.is_empty());
        assert!(!launch.new_window);
    }

    /// What the frontend receives, so the two ends agree on the field names.
    #[test]
    fn a_request_serialises_with_the_names_the_frontend_reads() {
        let launch = parsed(&["a.json", "--open-url=https://x"]);
        assert_eq!(
            serde_json::to_value(&launch.request).expect("serialise"),
            serde_json::json!({ "files": ["a.json"], "urls": ["https://x"] })
        );
    }
}
