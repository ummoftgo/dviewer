//! The self-check: open everything, and say what happened.
//!
//! This exists because of what the unit layers cannot reach. Every defect this
//! repository has shipped past its tests was of one class — the app started,
//! something was opened, and it fell over: a crash only the release profile
//! produced, an event loop that blocked on itself, a capability that was never
//! wired. None of them needed a complicated interaction to reproduce. What they
//! needed was a real window, a real IPC round trip and a real webview boot.
//!
//! So the harness is the app. It runs the ordinary open pipeline over a list of
//! documents and records how far each got. There is no driver, no selector and
//! no timing to flake on — and it works on the *released* binary, which is the
//! only way to catch something that only happens there.
//!
//! Two rules shape everything here.
//!
//! **Results are written a line at a time and flushed.** A single document
//! assembled at the end would be empty exactly when this harness earns its
//! keep: if the process dies, the file is all that is left, and the last line
//! written names what killed it.
//!
//! **Nothing here imposes a deadline.** The runner outside does. Two of the
//! three defect classes above are the event loop failing to turn, and a timer
//! living inside that loop would stop with it.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::cli::{Smoke, SmokeMode};

/// Everything went as the plan said it would.
pub const OK: i32 = 0;
/// At least one document did not. Which ones is in the results file.
pub const MISMATCH: i32 = 1;
/// The harness itself could not run — no manifest, or nowhere to write.
pub const BROKEN: i32 = 2;

/// One document to open, and what should become of it.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// As the manifest names it, which is what a failure is reported under.
    pub file: String,
    /// Absolute, resolved against the manifest's own directory — the manifest
    /// sits with the fixtures, so it is the only thing that knows where they
    /// are.
    #[serde(default)]
    pub path: String,
    /// The view this should end in, or `error` when refusing is the right
    /// answer. One field, and it is what separates an archive that unwraps to
    /// its single document from one that falls back to its list.
    pub expect: String,
    /// A second thing to do once it is open, for the paths a file alone does
    /// not reach: `openEntry`, `toggleHeader`.
    #[serde(default)]
    pub then: Option<String>,
}

/// A self-check in progress.
pub struct SmokeRun {
    plan: Vec<Step>,
    out: Mutex<File>,
    started: Instant,
    tally: Mutex<(usize, usize)>,
    /// The window whose destruction ends this run, if one has asked.
    ///
    /// The `--new` half of the round trip finishes by closing its own window,
    /// because the thing being checked is what happens *after* that: a window
    /// going away has to take its documents with it, and no unit test can
    /// reach that code — it lives in a Tauri event handler. So the run cannot
    /// end when the frontend is done; it ends when the window is really gone.
    finish_when_gone: Mutex<Option<String>>,
}

impl SmokeRun {
    /// Read the plan and open the results file, or say why not.
    ///
    /// Failing here is `BROKEN` rather than `MISMATCH`: nothing about the app
    /// has been tested yet, and reporting a document as broken when the harness
    /// could not read its own manifest would be a lie in the direction that
    /// wastes the most time.
    pub fn start(smoke: &Smoke) -> Result<Self, String> {
        let plan = match &smoke.mode {
            SmokeMode::Listen => Vec::new(),
            SmokeMode::Run { manifest } => read_plan(manifest)?,
        };
        let out = File::create(&smoke.out)
            .map_err(|e| format!("cannot write {}: {e}", smoke.out.display()))?;
        Ok(Self {
            plan,
            out: Mutex::new(out),
            started: Instant::now(),
            tally: Mutex::new((0, 0)),
            finish_when_gone: Mutex::new(None),
        })
    }

    pub fn plan(&self) -> &[Step] {
        &self.plan
    }

    /// Append one result and flush it.
    ///
    /// Flushed rather than buffered, and the reason is the whole design: this
    /// file is the only thing that survives a process that stops existing.
    ///
    /// `ok` is folded into the line rather than kept beside it. Whoever reads
    /// this file later has only the file, and a result that does not say
    /// whether it passed makes them reconstruct the verdict from the fields —
    /// which is exactly the kind of guessing that reads a banner as a failure.
    /// Done here rather than in the command, because not every line comes from
    /// the frontend: the destroy handler writes one too.
    pub fn record(&self, line: serde_json::Value, ok: bool) {
        {
            let mut tally = self.tally.lock();
            tally.0 += 1;
            if !ok {
                tally.1 += 1;
            }
        }
        let mut line = line;
        if let Some(object) = line.as_object_mut() {
            object.insert("ok".into(), ok.into());
        }
        let mut out = self.out.lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }

    /// End the run when `window` is destroyed rather than now.
    pub fn finish_when_gone(&self, window: &str) {
        *self.finish_when_gone.lock() = Some(window.to_owned());
    }

    /// Whether the destruction of `window` is what ends the run.
    pub fn ends_with(&self, window: &str) -> bool {
        self.finish_when_gone.lock().as_deref() == Some(window)
    }

    /// Write the summary and say how the process should end.
    ///
    /// The summary line is also the completion mark: a results file without one
    /// is a run that did not finish, whatever its last line says. The runner
    /// outside reads it that way, which is what lets a killed process be told
    /// apart from a failing one.
    pub fn finish(&self) -> i32 {
        let (total, failed) = *self.tally.lock();
        let summary = serde_json::json!({
            "summary": {
                "total": total,
                "failed": failed,
                "ms": self.started.elapsed().as_millis() as u64,
            }
        });
        let mut out = self.out.lock();
        let _ = writeln!(out, "{summary}");
        let _ = out.flush();
        if failed == 0 { OK } else { MISMATCH }
    }
}

fn read_plan(manifest: &Path) -> Result<Vec<Step>, String> {
    let text = std::fs::read_to_string(manifest)
        .map_err(|e| format!("cannot read {}: {e}", manifest.display()))?;
    let mut plan: Vec<Step> = serde_json::from_str(&text)
        .map_err(|e| format!("cannot parse {}: {e}", manifest.display()))?;
    if plan.is_empty() {
        return Err(format!("{} lists nothing to open", manifest.display()));
    }

    let beside = manifest.parent().unwrap_or_else(|| Path::new("."));
    for step in &mut plan {
        step.path = PathBuf::from(beside)
            .join(&step.file)
            .to_string_lossy()
            .into_owned();
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrote(name: &str, body: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("dviewer-smoke-{name}"));
        std::fs::create_dir_all(&path).expect("dir");
        let manifest = path.join("smoke.json");
        std::fs::write(&manifest, body).expect("write");
        manifest
    }

    /// The manifest sits with the fixtures, so it is what says where they are.
    /// A harness run from anywhere else must still find them.
    #[test]
    fn a_document_is_found_beside_the_manifest_that_lists_it() {
        let manifest = wrote("resolve", r#"[{"file":"sample.md","expect":"prose"}]"#);
        let plan = read_plan(&manifest).expect("plan");
        assert_eq!(plan[0].file, "sample.md");
        assert!(plan[0].path.ends_with("sample.md"));
        assert!(
            PathBuf::from(&plan[0].path).is_absolute() || plan[0].path.contains(std::path::MAIN_SEPARATOR),
            "resolved beside the manifest, not left as a bare name: {}",
            plan[0].path
        );
    }

    #[test]
    fn a_follow_up_step_is_optional() {
        let manifest = wrote(
            "then",
            r#"[{"file":"a.zip","expect":"archive","then":"openEntry"},
                {"file":"b.md","expect":"prose"}]"#,
        );
        let plan = read_plan(&manifest).expect("plan");
        assert_eq!(plan[0].then.as_deref(), Some("openEntry"));
        assert_eq!(plan[1].then, None);
    }

    /// Every one of these is the harness being unable to run, not a document
    /// being wrong — and the two must not be reported as the same thing.
    #[test]
    fn a_manifest_that_cannot_be_used_says_so_rather_than_failing_a_document() {
        assert!(read_plan(Path::new("nowhere/smoke.json")).is_err());
        assert!(read_plan(&wrote("garbage", "not json at all")).is_err());
        assert!(read_plan(&wrote("empty", "[]")).is_err());
    }

    /// The summary is the completion mark. Without it the runner outside cannot
    /// tell a process that failed from one that was killed.
    #[test]
    fn the_results_end_with_a_summary_that_counts_what_went_wrong() {
        let manifest = wrote("finish", r#"[{"file":"a.md","expect":"prose"}]"#);
        let out = manifest.with_file_name("out.jsonl");
        let run = SmokeRun::start(&Smoke {
            mode: SmokeMode::Run {
                manifest: manifest.clone(),
            },
            out: out.clone(),
        })
        .expect("start");

        run.record(serde_json::json!({"file": "a.md", "ok": true}), true);
        run.record(serde_json::json!({"file": "b.md", "ok": false}), false);
        assert_eq!(run.finish(), MISMATCH);

        let written = std::fs::read_to_string(&out).expect("read");
        let lines: Vec<&str> = written.lines().collect();
        assert_eq!(lines.len(), 3, "two results and a summary");
        let summary: serde_json::Value = serde_json::from_str(lines[2]).expect("summary");
        assert_eq!(summary["summary"]["total"], 2);
        assert_eq!(summary["summary"]["failed"], 1);
    }

    #[test]
    fn a_run_with_nothing_wrong_ends_at_zero() {
        let manifest = wrote("clean", r#"[{"file":"a.md","expect":"prose"}]"#);
        let run = SmokeRun::start(&Smoke {
            mode: SmokeMode::Run { manifest: manifest.clone() },
            out: manifest.with_file_name("clean.jsonl"),
        })
        .expect("start");
        run.record(serde_json::json!({"file": "a.md", "ok": true}), true);
        assert_eq!(run.finish(), OK);
    }


    /// Every line says whether it passed, whoever wrote it.
    ///
    /// The frontend used to fold `ok` in on its way through the command, which
    /// left the one line the backend writes by itself — the reclaim line from
    /// the destroy handler — without a verdict. Whoever reads this file has
    /// only the file.
    #[test]
    fn a_recorded_line_carries_its_own_verdict() {
        let manifest = wrote("verdict", r#"[{"file":"a.md","expect":"prose"}]"#);
        let out = manifest.with_file_name("verdict.jsonl");
        let run = SmokeRun::start(&Smoke {
            mode: SmokeMode::Run { manifest: manifest.clone() },
            out: out.clone(),
        })
        .expect("start");

        run.record(serde_json::json!({"step": "reclaim", "window": "doc-1", "docs": 1}), true);
        run.record(serde_json::json!({"step": "reclaim", "window": "doc-2", "docs": 0}), false);
        run.finish();

        let written = std::fs::read_to_string(&out).expect("read");
        let lines: Vec<serde_json::Value> = written
            .lines()
            .map(|line| serde_json::from_str(line).expect("json"))
            .collect();
        assert_eq!(lines[0]["ok"], true);
        assert_eq!(lines[0]["docs"], 1);
        assert_eq!(lines[1]["ok"], false, "nothing reclaimed is a failure");
    }

    /// Which window's death ends the run, and only that one's.
    #[test]
    fn a_run_can_be_told_to_end_when_a_window_goes() {
        let manifest = wrote("gone", r#"[{"file":"a.md","expect":"prose"}]"#);
        let run = SmokeRun::start(&Smoke {
            mode: SmokeMode::Run { manifest: manifest.clone() },
            out: manifest.with_file_name("gone.jsonl"),
        })
        .expect("start");

        assert!(!run.ends_with("doc-1"), "nothing ends the run until something asks");
        run.finish_when_gone("doc-1");
        assert!(run.ends_with("doc-1"));
        assert!(!run.ends_with("main"), "another window closing is not the end");
    }

    /// Listening opens nothing, so it has no plan — and must still start.
    #[test]
    fn listening_starts_without_a_manifest() {
        let out = std::env::temp_dir().join("dviewer-smoke-listen.jsonl");
        let run = SmokeRun::start(&Smoke {
            mode: SmokeMode::Listen,
            out,
        })
        .expect("start");
        assert!(run.plan().is_empty());
    }
}
