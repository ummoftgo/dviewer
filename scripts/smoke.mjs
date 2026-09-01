/**
 * Runs the app against every fixture and says whether it survived.
 *
 *   node scripts/smoke.mjs [--release] [--keep]
 *
 * The app does the checking; this starts it, holds the clock, and reads the
 * verdict. Three things live out here and not in the app:
 *
 * **The deadline.** Two of the defect classes this exists to catch are the
 * event loop failing to turn, and a timer inside that loop would stop with it.
 * A process that stops answering is killed from outside, and a results file
 * with no summary line is how that is told apart from a run that failed.
 *
 * **The second process.** The single-instance hand-off needs two of them, and
 * an app cannot start itself.
 *
 * **Finding the binary.** Which build is under test is the runner's business —
 * and the release one is the point, because that is where the crashes this
 * targets only ever appeared.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const release = process.argv.includes("--release");
const keep = process.argv.includes("--keep");
const root = process.cwd();
const manifest = path.join(root, "fixtures/smoke.json");

/**
 * Where the binary is, in the order worth looking.
 *
 * More than one place because the macOS release is built for
 * `universal-apple-darwin`, which cargo puts under the target's own directory
 * rather than the profile's. `DVIEWER_EXE` wins over both, for anyone testing
 * something that was built elsewhere — an installed copy, say.
 */
const name = process.platform === "win32" ? "dviewer.exe" : "dviewer";
const profile = release ? "release" : "debug";
const candidates = [
  process.env.DVIEWER_EXE,
  path.join(root, "src-tauri/target", profile, name),
  path.join(root, "src-tauri/target/universal-apple-darwin", profile, name),
].filter(Boolean);
const exe = candidates.find((candidate) => existsSync(candidate));

/** The whole sweep. Generous: a cold runner opening a 500MB fixture is slow. */
const SWEEP_TIMEOUT_MS = 10 * 60_000;
/** One hand-off. If it has not arrived by now it is not going to. */
const HANDOFF_TIMEOUT_MS = 60_000;
/**
 * How long to wait for the listening process to say it is listening.
 *
 * It says so rather than being assumed ready after a pause. The request is
 * handed over as an event, and an event nobody is listening for yet is lost
 * without a sound — so a pause here is a guess about webview boot time, and the
 * guess is wrong on exactly the machine that matters: a cold CI runner starting
 * a release build under a virtual display.
 */
const READY_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`  ✗ ${message}`);
  process.exitCode = 1;
}

/** Start the app and wait for it to end, or kill it when the clock runs out. */
function run(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, killed: true, stderr });
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, killed: false, stderr: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, killed: false, stderr });
    });
  });
}

/**
 * Read a results file.
 *
 * The summary line is the completion mark. Its absence means the process never
 * got to the end, whatever else the file says — and the last line before it is
 * then the document it was working on.
 */
async function results(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const summary = lines.at(-1)?.summary ?? null;
  return { lines: summary ? lines.slice(0, -1) : lines, summary };
}

/**
 * Wait until the listening process has said it is listening.
 *
 * `gone` means it ended before it got there, which on this check means
 * something else already held the single-instance lock.
 */
async function waitForListening(file, ended) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { lines } = await results(file);
    if (lines.some((line) => line.step === "listening")) return "ready";
    if (ended()) return "gone";
    await sleep(100);
  }
  return "timeout";
}

function report(lines) {
  for (const line of lines) {
    // Only `ok` decides. A line can carry an error and still have passed — an
    // archive whose one document was refused shows its list and says why, and
    // that banner is the correct outcome rather than a failure.
    if (line.ok !== false) continue;
    fail(
      `${line.file ?? line.step}: ${line.stage ?? ""} ${line.error ?? ""}`.trim() +
        (line.view ? ` (${line.view} 로 열림, ${line.expect} 를 기대)` : ""),
    );
  }
}

// --- go ----------------------------------------------------------------------

if (!exe) {
  console.error("빌드된 앱을 찾지 못했습니다. 찾아본 곳:");
  for (const candidate of candidates) console.error(`  ${candidate}`);
  console.error(
    release
      ? "  npm run build && cd src-tauri && cargo build --release --features custom-protocol"
      : "  npm run build && cd src-tauri && cargo build --features custom-protocol",
  );
  process.exit(2);
}
if (!existsSync(manifest)) {
  console.error(`픽스처가 없습니다. 먼저: node scripts/gen-fixtures.mjs`);
  process.exit(2);
}

const work = await mkdtemp(path.join(tmpdir(), "dviewer-smoke-"));
console.log(`스모크 (${release ? "릴리스" : "디버그"} 빌드)`);

// 1 — every fixture, through the ordinary open pipeline.
{
  const out = path.join(work, "sweep.jsonl");
  const started = Date.now();
  const ended = await run([`--smoke=${manifest}`, `--smoke-out=${out}`], SWEEP_TIMEOUT_MS);
  const { lines, summary } = await results(out);

  if (ended.code === 2) fail(`하네스가 시작하지 못했습니다: ${ended.stderr.trim()}`);
  else if (!summary) {
    const last = lines.at(-1);
    fail(
      ended.killed
        ? `${Math.round(SWEEP_TIMEOUT_MS / 1000)}초 안에 끝나지 않았습니다` +
            (last ? ` — 마지막으로 연 것: ${last.file}` : " — 아무것도 열지 못했습니다")
        : `끝까지 가지 못했습니다 (종료 코드 ${ended.code})` +
            (last ? ` — 마지막으로 연 것: ${last.file}` : ""),
    );
  } else {
    report(lines);
    if (summary.failed > 0) fail(`${summary.total}개 중 ${summary.failed}개 실패`);
    else console.log(`  ✓ 픽스처 ${summary.total}개, ${Math.round((Date.now() - started) / 1000)}초`);
  }
}

// 2 — the single-instance hand-off. A second `dviewer` must give its arguments
//     to the first and exit; only the first can say they arrived.
for (const [label, extra] of [
  ["단일 인스턴스 전달", []],
  ["--new 창", ["--new"]],
]) {
  const out = path.join(work, `${extra.length ? "new" : "handoff"}.jsonl`);
  let listenerEnded = false;
  const listening = run(["--smoke-listen", `--smoke-out=${out}`], HANDOFF_TIMEOUT_MS).then(
    (ended) => {
      listenerEnded = true;
      return ended;
    },
  );

  const ready = await waitForListening(out, () => listenerEnded);
  if (ready === "gone") {
    // The listener holds the single-instance lock, so it must still be running.
    // If it is not, something else already held it — an open dviewer — and this
    // check would be measuring that instead.
    fail(`${label}: dviewer 가 이미 떠 있습니다. 닫고 다시 돌려 주세요.`);
    continue;
  }
  if (ready === "timeout") {
    fail(`${label}: 듣는 프로세스가 ${READY_TIMEOUT_MS / 1000}초 안에 준비되지 않았습니다`);
    continue;
  }

  const second = await run([...extra, path.join(root, "fixtures/sample.md")], HANDOFF_TIMEOUT_MS);
  if (second.killed) fail(`${label}: 두 번째 프로세스가 스스로 종료하지 않았습니다`);

  const first = await listening;
  const { lines, summary } = await results(out);
  report(lines);

  if (!summary) fail(`${label}: 첫 프로세스가 전달을 보고하지 않았습니다`);
  else if (first.code !== 0 || summary.failed > 0) fail(`${label}: 전달이 확인되지 않았습니다`);
  else console.log(`  ✓ ${label}`);
}

if (!keep) await rm(work, { recursive: true, force: true });
else console.log(`  결과: ${work}`);

if (process.exitCode) console.error("스모크 실패");
else console.log("스모크 통과");
