/**
 * Driving the self-check from the frontend.
 *
 * The backend says what to open; this opens it the way a reader would — through
 * `workspace`, into a real view, over real IPC — and says how far it got. None
 * of the open pipeline is reimplemented here, because a harness that took a
 * shortcut past it would stop testing the thing it exists to test.
 *
 * Readiness is polled rather than awaited. Each view loads itself from an
 * effect when it mounts, so there is no promise to hold; what there is, is a
 * field on the tab that fills in. Polling for it is honest about that, and it
 * cannot deadlock — which matters, because two of the three defect classes this
 * harness targets are the event loop failing to turn.
 */
import * as ipc from "./ipc";
import type { LaunchRequest, SmokeStep as Step } from "./ipc";
import { workspace, type DocTab } from "./state/docs.svelte";

/**
 * How long one document may take before it counts as stuck.
 *
 * Generous, because the fixtures include the ones this app exists for and a
 * cold CI runner is slower than a warm desk. The runner outside has its own,
 * longer deadline for the whole process; this one is per document so a failure
 * can name which.
 */
const STEP_TIMEOUT_MS = 60_000;
/** How often to look. Roughly a frame — often enough not to skew timings. */
const POLL_MS = 16;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The view a tab has actually finished loading, or null while it is working. */
function readyView(tab: DocTab): string | null {
  switch (tab.view) {
    case "prose":
      return tab.html !== null ? "prose" : null;
    case "tree":
      return tab.treeStats !== null ? "tree" : null;
    case "table":
      return tab.tableStats !== null ? "table" : null;
    case "collection":
      return tab.collections.length > 0 ? "collection" : null;
    case "archive":
      // Not the entry count: an empty archive is ready and has none. The
      // encoding is written together with the list, and is never null after.
      return tab.nameEncoding !== null ? "archive" : null;
    default:
      return null;
  }
}

interface Outcome {
  ok: boolean;
  stage: string;
  view?: string;
  error?: string;
}

/**
 * Wait for a tab to finish loading, fail, or run out of time.
 *
 * A loaded view beats an error, and the order matters. Some views carry both:
 * an archive whose single document was refused shows its list *and* a banner
 * saying why, and that is the correct outcome rather than a failure. Only when
 * nothing has loaded does an error mean the document did not open.
 */
async function settle(tab: DocTab, expect: string): Promise<Outcome> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const view = readyView(tab);
    if (view !== null) {
      return { ok: view === expect, stage: "ready", view, error: tab.error ?? undefined };
    }
    if (tab.error !== null) {
      // A document that was supposed to be refused has done what was asked.
      return { ok: expect === "error", stage: "error", error: tab.error };
    }
    await sleep(POLL_MS);
  }
  return { ok: false, stage: "timeout" };
}

/**
 * The follow-ups a file alone does not reach.
 *
 * `openEntry` is the archive's real IPC path — clicking a row is a view
 * concern, but what it calls is this. `toggleHeader` is the one place a table's
 * shape changes under an open search, which is where the search has to be
 * discarded; that logic lives in a component, so this is the only layer that
 * can see it happen.
 */
async function follow(tab: DocTab, what: string): Promise<Outcome> {
  if (what === "openEntry") {
    const entry = tab.entries.find((candidate) => !candidate.encrypted);
    if (!entry) return { ok: false, stage: "openEntry", error: "nothing openable" };
    const opened = await workspace.openEntry(tab, entry);
    if (!opened) return { ok: false, stage: "openEntry", error: tab.error ?? "did not open" };
    const inside = await settle(opened, opened.view);
    return { ...inside, stage: `openEntry:${inside.stage}` };
  }

  if (what === "toggleHeader") {
    tab.tableSearch.query = "a";
    tab.tableSearch.hits = [{ row: 0, column: 0 }];
    const shape = await ipc.tableSetHasHeader(tab.id, !(tab.tableStats?.hasHeader ?? true));
    tab.tableStats = shape.stats;
    tab.header = shape.header;
    tab.tableSearch.reset();
    const discarded = tab.tableSearch.hits.length === 0;
    return {
      ok: discarded,
      stage: "toggleHeader",
      error: discarded ? undefined : "the search survived a change of shape",
    };
  }

  return { ok: false, stage: what, error: "no such follow-up" };
}

/**
 * Open everything the plan lists, then end the process.
 *
 * Every document is reported as it finishes, so a run that dies part way still
 * says where it was — which is the whole reason the results are a file of lines
 * rather than one document written at the end.
 */
export async function runSmoke(): Promise<void> {
  const plan: Step[] = await ipc.smokePlan();

  // Nothing to open means this process is the listening half of the
  // single-instance round trip: another `dviewer` is about to hand it a
  // request, and what it has to report is whether that arrived. It waits, and
  // if nothing comes the runner outside kills it — a results file with no
  // summary line is what says so.
  if (plan.length === 0) {
    await ipc.smokeReport({ step: "listening" }, true);
    return;
  }

  for (const step of plan) {
    const started = Date.now();
    let outcome: Outcome;

    const tab = await workspace.openPath(step.path);
    if (!tab) {
      // It did not open at all — which for some documents is the answer.
      outcome = {
        ok: step.expect === "error",
        stage: "open",
        error: workspace.notice ?? "did not open",
      };
      workspace.notice = null;
    } else {
      outcome = await settle(tab, step.expect);
      if (outcome.ok && step.then) outcome = await follow(tab, step.then);
    }

    await ipc.smokeReport(
      {
        file: step.file,
        expect: step.expect,
        stage: outcome.stage,
        view: outcome.view,
        error: outcome.error,
        ms: Date.now() - started,
      },
      outcome.ok,
    );
  }

  await ipc.smokeDone();
}

/**
 * A request delivered by a second `dviewer`, in the listening process.
 *
 * This is the whole single-instance contract from the receiving side: the other
 * process handed its arguments over and exited, and only this one can say they
 * arrived. A defect here is invisible until someone opens a file from a shell.
 *
 * The arrival is an **event**, and an event nobody is listening for is simply
 * lost. That is why the process writes a `listening` line first and the runner
 * waits for it: a fixed pause before handing over is a guess about how long a
 * webview takes to boot, and on a cold runner it is the wrong guess.
 */
export async function reportDelivery(request: LaunchRequest): Promise<void> {
  const arrived = request.files.length + request.urls.length;
  await ipc.smokeReport(
    { step: "delivery", files: request.files, urls: request.urls },
    arrived > 0,
  );
  await ipc.smokeDone();
}

/**
 * A window that was built to answer `--new`: it opens what it was given, says
 * so, and then closes itself.
 *
 * The failure this covers put an empty frame on screen: the window was created
 * on the event loop's own thread, so the webview never attached and the second
 * process never got its answer either. A window that reaches this line is a
 * window that booted — and one that opened the file it was handed, which is
 * what the frame was empty of.
 *
 * Closing rather than calling `smokeDone` is the other half. What happens when
 * a window goes away — its documents being reclaimed, its panels closed — lives
 * in a Tauri event handler that no unit test can reach, and exiting while the
 * window still stands would step over it. So the run ends from inside that
 * handler instead; see `smoke_close_self`.
 *
 * The close waits for the view to be ready on purpose. Closing mid-open would
 * exercise the *race* between opening and destruction, and a race decided by
 * timing makes a check that passes on some runs — that one is held down by
 * `state.rs` instead.
 */
export async function reportNewWindow(label: string, request: LaunchRequest): Promise<void> {
  const wanted = request.files.length + request.urls.length;
  let opened = 0;
  let ready: Outcome = { ok: wanted > 0, stage: "none" };

  for (const path of request.files) {
    const tab = await workspace.openPath(path);
    if (!tab) {
      ready = { ok: false, stage: "open", error: workspace.notice ?? "did not open" };
      break;
    }
    opened += 1;
    ready = await settle(tab, tab.view);
    if (!ready.ok) break;
  }

  await ipc.smokeReport(
    {
      step: "newWindow",
      window: label,
      files: request.files,
      opened,
      stage: ready.stage,
      view: ready.view,
      error: ready.error,
    },
    wanted > 0 && opened === request.files.length && ready.ok,
  );
  await ipc.smokeCloseSelf();
}
