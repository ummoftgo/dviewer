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
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, release as osRelease, arch } from "node:os";
import path from "node:path";
import { sanitizeDiagnostic, createDiagnosticSanitizer, descendantProcesses, nativeCoverage, fileFingerprint, pdfjsFingerprint, sanitizeEnvironment, exportDiagnosticArtifacts } from './smoke-diagnostics.mjs';
import { parseResults } from './smoke-results.mjs';

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

/**
 * Every process this starts is a named instance, which gives it its own
 * single-instance lock and its own data folder (`cli::identifier`). Without it
 * the hand-off checks would talk to whatever dviewer the reader has open, and
 * the sweep would read and write the reader's settings.
 */
const INSTANCE_ENV = { ...process.env, DVIEWER_INSTANCE: "smoke" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);
const processRecords = [];
const processCompletions = [];
const stopProcesses = new Set();
async function version(command,args) {
  try {const {stdout}=await execFileAsync(command,args,{timeout:3000});return sanitizeDiagnostic(stdout.trim(),1000);}
  catch {return 'unavailable';}
}
async function processTree(pid) {
  if (!['darwin','linux'].includes(process.platform)) return [];
  try {const {stdout}=await execFileAsync('ps',['-e','-o','pid=','-o','ppid=','-o','rss=','-o','comm='],{timeout:1000});return descendantProcesses(stdout,pid);}
  catch {return [];}
}

async function processStats(pid) {
  if (!['darwin', 'linux'].includes(process.platform)) return 'process=n/a';
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'time=', '-o', 'pcpu=', '-o', 'rss=', '-p', String(pid)],
      { timeout: 1000, env: { ...process.env, LC_ALL: 'C' } });
    const [cpuTime, cpu, rss] = stdout.trim().split(/\s+/);
    if (!cpuTime || !Number.isFinite(Number(cpu)) || !Number.isFinite(Number(rss))) return 'process=unknown';
    return `pid=${pid} cpu-time=${cpuTime} cpu=${cpu}% rss=${rss}KiB`;
  } catch { return 'process=unknown'; }
}

function fail(message) {
  console.error(`  ✗ ${sanitizeDiagnostic(message)}`);
  process.exitCode = 1;
}

/** Start the app and wait for it to end, or kill it when the clock runs out. */
function run(args, timeoutMs, onSpawn = () => {}) {
  const completion = new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: false, env: INSTANCE_ENV });
    onSpawn(child.pid);
    const record = { pid: child.pid, mode: args.some(a => a.startsWith('--smoke=')) ? 'sweep' : args.includes('--smoke-listen') ? 'listen' : 'handoff',
      startedAt: new Date().toISOString(), code: null, signal: null, killed: false, stdout: '', stderr: '' };
    processRecords.push(record);
    const stdout = createDiagnosticSanitizer({ onText: clean => { record.stdout += clean; process.stdout.write(clean); } });
    const stderr = createDiagnosticSanitizer({ onText: clean => { record.stderr += clean; process.stderr.write(clean); } });
    child.stdout?.on('data', chunk => stdout.write(chunk));
    child.stderr?.on('data', chunk => stderr.write(chunk));
    let settled = false, closeDeadline;
    const finish = () => {
      if (settled) return;
      settled = true;
      stopProcesses.delete(stop);
      clearTimeout(timer);
      clearTimeout(closeDeadline);
      // Detach first: an inherited pipe can outlive its killed parent.
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      record.stdoutRetention = stdout.end();
      record.stderrRetention = stderr.end();
      record.finishedAt = new Date().toISOString();
      resolve({ code: record.code, killed: record.killed, stderr: record.stderr });
    };
    const stop = () => {
      if (settled || record.killed) return;
      record.killed = true;
      child.kill('SIGKILL');
      // Allow final output to drain, but a descendant holding the pipe cannot
      // defeat the external deadline or prevent artifact retention.
      closeDeadline = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 2000);
    };
    stopProcesses.add(stop);
    const timer = setTimeout(stop, timeoutMs);
    child.on('error', () => {
      // Spawn errors can include command paths or arguments. Keep a fixed code.
      stderr.write('smoke process could not start\n');
      finish();
    });
    child.on('close', (code, signal) => {
      record.code = code;
      record.signal = signal;
      finish();
    });
  });
  processCompletions.push(completion);
  return completion;
}

/**
 * Read a results file.
 *
 * The summary line is the completion mark. Its absence means the process never
 * got to the end, whatever else the file says — and the last line before it is
 * then the last document whose result was completed.
 */
async function results(file, streaming = false) {
  const text = await readFile(file, "utf8").catch(() => "");
  return parseResults(text, streaming);
}

/**
 * Wait until the listening process has said it is listening.
 *
 * `gone` means it ended before it got there, which on this check means
 * something else already held the smoke instance's lock — a dviewer left over
 * from an earlier smoke, since the reader's own app holds a different one.
 */
async function waitForListening(file, ended) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { lines } = await results(file, true);
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
try {
const binary = await fileFingerprint(exe);
const environment = sanitizeEnvironment({ platform: process.platform, osRelease: osRelease(), arch: arch(), node: process.version, profile,
  binary: path.basename(exe), binarySha256: binary.sha256, binaryBytes: binary.bytes,
  rust: await version('rustc', ['--version']), webkit: await version('pkg-config', ['--modversion', 'webkit2gtk-4.1']),
  gtk: await version('pkg-config', ['--modversion', 'gtk+-3.0']), libsoup: await version('pkg-config', ['--modversion', 'libsoup-3.0']),
  pdfjs: await pdfjsFingerprint(root) });
await writeFile(path.join(work, 'environment.json'), JSON.stringify(environment, null, 2));
console.log(`스모크 (${release ? "릴리스" : "디버그"} 빌드)`);

// 1 — every fixture, through the ordinary open pipeline.
{
  const out = path.join(work, "sweep.jsonl");
  const total = JSON.parse(await readFile(manifest, "utf8")).length;
  const started = performance.now();
  let seen = 0, lastObserved = started;
  let pid, nextSample = 0, stats = 'process=unknown';
  const childSamples=[];
  const progress = async () => {
    // ps reports only this PID, not separate WebContent processes. Sample at
    // most once a second so diagnostics do not dominate the 100ms polling loop.
    if (!ended && pid && performance.now() >= nextSample) {
      stats = `${await processStats(pid)} sample=${Math.round(performance.now() - started)}ms`;
      if (childSamples.length < 600) childSamples.push({atMs:Math.round(performance.now()-started),processes:await processTree(pid)});
      nextSample = performance.now() + 1000;
    }
    const { lines } = await results(out, true);
    // These are observation times: several fast fixtures can arrive in one poll.
    for (const line of lines.slice(seen)) {
      const now = performance.now();
      console.log(`  · ${line.file} ${line.stage ?? "-"} ${line.ok === false ? "✗" : "ok"} ${line.ms ?? "?"}ms` +
        ` (wall +${Math.round(now - lastObserved)}ms, elapsed ${Math.round(now - started)}ms; ${stats})`);
      lastObserved = now;
    }
    seen = lines.length;
  };
  let ended;
  const running = run([`--smoke=${manifest}`, `--smoke-out=${out}`], SWEEP_TIMEOUT_MS, value => { pid = value; }).then(value => { ended = value; });
  while (!ended) {
    await progress();
    if (!ended) await sleep(100);
  }
  await running;
  await progress(); // Drain rows written between the final poll and process exit.
  const { lines, summary } = await results(out, true);
  const elapsed = Math.round(performance.now() - started);
  await writeFile(path.join(work,'child-processes.json'),JSON.stringify(childSamples));
  if (process.platform === 'linux') {
    const coverage=nativeCoverage(await readFile(out.replace(/\.jsonl$/,'.trace.jsonl'),'utf8').catch(()=>''));
    await writeFile(path.join(work,'native-coverage.json'),JSON.stringify(coverage));
    // The unchanged full sweep starts report.html -> report.pdf. These controls
    // establish that the native hook actually sees iframe resources.
    if (!Object.values(coverage).every(Boolean)) fail(`native iframe observation coverage incomplete: ${JSON.stringify(coverage)}`);
  }

  if (ended.code === 2) fail(`하네스가 시작하지 못했습니다: ${ended.stderr.trim()}`);
  else if (!summary) {
    const last = lines.at(-1);
    const detail = ` — 마지막 완료: ${last?.file ?? "없음"}, 경과 ${elapsed}ms, 미완료 ${Math.max(0, total - lines.length)}개; ${stats}`;
    fail(
      ended.killed
        ? `${Math.round(SWEEP_TIMEOUT_MS / 1000)}초 안에 끝나지 않았습니다${detail}`
        : `끝까지 가지 못했습니다 (종료 코드 ${ended.code})${detail}`,
    );
  } else {
    report(lines);
    if (summary.failed > 0) fail(`${summary.total}개 중 ${summary.failed}개 실패`);
    else console.log(`  ✓ 픽스처 ${summary.total}개, ${Math.round(elapsed / 1000)}초`);
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
    // If it is not, something else already held it — a smoke-instance dviewer
    // an earlier run left behind — and this check would be measuring that.
    fail(`${label}: 앞선 스모크의 dviewer 가 아직 떠 있습니다. 닫고 다시 돌려 주세요.`);
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

  // The `--new` window closes itself when it is done, and what that closing
  // does — handing its documents back — is the thing being checked. `report`
  // above already fails on `ok: false`, so what is left to check is that the
  // line is there at all: if the destroy handler never ran, there is nothing
  // to be false.
  if (extra.length && !lines.some((line) => line.step === "reclaim")) {
    fail(`${label}: 창이 닫힐 때 문서를 회수했다는 보고가 없습니다`);
  }

  if (!summary) fail(`${label}: 첫 프로세스가 전달을 보고하지 않았습니다`);
  else if (first.code !== 0 || summary.failed > 0) fail(`${label}: 전달이 확인되지 않았습니다`);
  else console.log(`  ✓ ${label}`);
}

} catch (error) {
  fail(`smoke runner error: ${sanitizeDiagnostic(error?.message ?? 'unknown error', 1000)}`);
} finally {
  for (const stop of stopProcesses) stop();
  await Promise.allSettled(processCompletions);
  // Always retain completed diagnostics, even if result parsing or a later
  // hand-off throws. Failed runs keep the working directory as well.
  await writeFile(path.join(work, 'processes.json'), JSON.stringify(processRecords, null, 2));
  const artifactDir = process.env.DVIEWER_SMOKE_ARTIFACT_DIR;
  if (artifactDir) {
    try { await exportDiagnosticArtifacts(work, artifactDir); }
    catch (error) { fail(`diagnostic export failed: ${sanitizeDiagnostic(error?.message ?? 'unknown error', 1000)}`); }
  }
  if (!keep && !process.exitCode) await rm(work, { recursive: true, force: true });
  else console.log(`  결과: ${work}`);
}

if (process.exitCode) console.error("스모크 실패");
else console.log("스모크 통과");
