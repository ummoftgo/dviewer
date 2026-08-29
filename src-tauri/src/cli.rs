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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Launch {
    pub request: LaunchRequest,
    /// `--new`: open a window of its own instead of a tab in the running one.
    pub new_window: bool,
}

/// Parse the arguments after the executable's own name.
pub fn parse<S: AsRef<str>>(args: &[S]) -> Launch {
    let mut launch = Launch::default();
    let mut rest = args.iter().map(AsRef::as_ref);

    while let Some(arg) = rest.next() {
        match arg {
            "--new" => launch.new_window = true,
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
                } else if !arg.starts_with('-') {
                    // A bare path, so `dviewer report.md` works and so does a
                    // file association.
                    push(&mut launch.request.files, arg);
                }
            }
        }
    }
    launch
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
