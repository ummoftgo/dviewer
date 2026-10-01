/**
 * Bounded native diagnostic experiment, never a production smoke replacement.
 * Build the release app first, then run from the repository root:
 *   node scripts/pdf-startup-repro.mjs
 * Linux needs the same Xvfb / D-Bus wrapper as the ordinary native smoke.
 * Exit 0 = not reproduced, 1 = application failure, 2 = harness/inconclusive.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, open, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, release as osRelease, arch } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDiagnosticSanitizer, fileFingerprint, pdfjsFingerprint, sanitizeDiagnostic,
  sanitizeEnvironment } from './smoke-diagnostics.mjs';
import { parseResults } from './smoke-results.mjs';

export const MODES = Object.freeze(['css-control', 'css-delay', 'module-delay']);
export const TARGETS = Object.freeze(['report.pdf', 'upright-image.pdf']);
const CORE = { css: '/_/pdfjs/web/viewer.css', module: '/_/pdfjs/web/viewer.mjs', viewer: '/_/pdfjs/web/viewer.html' };
const CASE_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 2_000;
const FILE_LIMIT = 8 * 1024 * 1024 + 4096;
const execFileAsync = promisify(execFile);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const basename = name => typeof name === 'string' ? name.split(/[\\/]/).at(-1) : null;
const originalError = text => /components:\s*The\s+`?container`?\s+must be absolutely positioned\./.test(text ?? '');

export function validateMode(value) {
  if (value !== undefined && !MODES.includes(value)) throw new Error('invalid DVIEWER_PDF_STARTUP_REPRO; expected css-control, css-delay, or module-delay');
}

/** The generator's manifest is the only fixture inventory; never list fixtures/. */
export function makeExperiments(source, fixtureRoot) {
  if (!Array.isArray(source)) throw new Error('fixture manifest must be an array');
  const entry = name => {
    const matches = source.filter(row => row && row.file === name);
    if (matches.length !== 1 || matches[0].expect !== 'frame' || typeof matches[0].then !== 'string') {
      throw new Error(`fixture manifest must contain exactly one frame step for ${name}`);
    }
    // Rust resolves `file` beside the manifest and ignores an input `path`.
    // Absolute names preserve the original fixtures from a temporary manifest.
    return { file: path.resolve(fixtureRoot, name), expect: matches[0].expect, then: matches[0].then };
  };
  const html = entry('report.html');
  return TARGETS.flatMap(target => {
    const manifest = JSON.stringify([html, entry(target)], null, 2) + '\n';
    return MODES.map(mode => ({ target, mode, name: `${target.slice(0, -4)}-${mode}`, manifest }));
  });
}

export function parseTrace(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > FILE_LIMIT) throw new Error('trace exceeds retention limit');
  if (!text.endsWith('\n')) throw new Error('trace is missing a complete final line');
  return text.split('\n').filter(line => line.trim()).map(line => {
    if (Buffer.byteLength(line) > 80 * 1024) throw new Error('trace line exceeds retention limit');
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid trace row');
    return row;
  });
}

/** Extract one balanced JSON object without confusing embedded braces/quotes. */
export function stallSnapshot(diagnostic) { return diagnosticObject(diagnostic, 'stall'); }

function diagnosticObject(diagnostic, field) {
  if (typeof diagnostic !== 'string' || diagnostic.length > 70 * 1024) return null;
  const marker = `, ${field} `, start = diagnostic.indexOf(marker) + marker.length;
  if (start < marker.length || diagnostic[start] !== '{') return null;
  let depth = 0, quoted = false, escape = false;
  for (let i = start; i < diagnostic.length; i++) {
    const char = diagnostic[i];
    if (quoted) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(diagnostic.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

export function inspectResults(text, processResult, target) {
  const result = { outcome: 'harness-malfunction', originalFailure: false, reasons: [], summary: null };
  let rows;
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > FILE_LIMIT || !text.endsWith('\n')) throw new Error('incomplete results');
    const parsed = parseResults(text);
    rows = parsed.lines;
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('invalid result row');
    result.summary = parsed.summary;
  } catch { result.reasons.push('results-missing-malformed-or-truncated'); return result; }
  const pdf = rows.find(row => basename(row.file) === target);
  result.originalFailure = pdf?.ok === false && originalError(pdf.error);
  const expected = ['report.html', target];
  if (rows.length !== 2 || rows.some((row, i) => basename(row.file) !== expected[i] || typeof row.ok !== 'boolean')) result.reasons.push('unexpected-result-sequence');
  const failures = rows.filter(row => row.ok === false).length;
  if (!result.summary || result.summary.total !== 2 || result.summary.failed !== failures) result.reasons.push('missing-or-inconsistent-summary');
  if (processResult.timedOut || processResult.interrupted || processResult.spawnError || processResult.pipeTimedOut || processResult.cleanupError || processResult.signal) result.reasons.push('process-incomplete');
  if (![0, 1].includes(processResult.code) || processResult.code !== (failures ? 1 : 0)) result.reasons.push('exit-code-result-mismatch');
  if (result.reasons.length) return result;
  result.htmlPassed = rows[0].ok;
  result.pdfPassed = rows[1].ok;
  result.outcome = result.originalFailure ? 'original-failure' : failures ? 'other-failure' : 'passed';
  return result;
}

/** All ordering uses the native trace's monotonic clock, never page-relative time. */
export function inspectInjection(events, mode, { originalFailure = false } = {}) {
  if (!MODES.includes(mode)) throw new Error('invalid experiment mode');
  const reasons = [], evidence = { established: false, reasons, mode };
  const rows = events.map((row, index) => ({ ...row, index }));
  const faults = rows.filter(row => row.kind === 'pdf-startup-fault');
  const target = mode === 'module-delay' ? 'module' : 'css';
  const delayMs = mode === 'css-control' ? 0 : 1000;
  const phases = ['armed', 'held', 'release', 'responded', 'joined'];
  const fault = Object.fromEntries(phases.map(phase => [phase, faults.find(row => row.phase === phase)]));
  evidence.target = target;
  evidence.delayMs = delayMs;
  evidence.injectionCount = faults.filter(row => row.phase === 'held').length;
  if (faults.length !== 5 || phases.some(phase => faults.filter(row => row.phase === phase).length !== 1)
      || faults.some(row => row.target !== target || row.delayMs !== delayMs)) reasons.push('fault-sequence-not-exactly-one');
  if (!rows.some(row => row.kind === 'native-hook' && row.state === 'ready')) reasons.push('native-hook-not-ready');
  const retention = rows.filter(row => row.kind === 'trace-retention');
  if (!retention.length || rows.some(row => row.dropped > 0) || retention.some(row => row.dropped !== 0)
      || rows.some(row => row.kind === 'export-retention')) reasons.push('trace-incomplete-or-dropped');
  if (reasons.length) return evidence;
  const { held, release, responded } = fault;
  if (!integer(held.requestId) || held.requestId === 0 || !integer(held.docId) || held.docId === 0) reasons.push('fault-identity-missing');
  evidence.docId = held.docId;
  evidence.requestId = held.requestId;
  if (faults.some(row => (row.requestId != null && row.requestId !== held.requestId)
      || (row.docId != null && row.docId !== held.docId))) reasons.push('fault-identity-changed');
  const origin = held.clockOriginAtMs;
  const validClock = row => integer(row.elapsedMs) && integer(row.clockOriginAtMs) && row.clockOriginAtMs === origin;
  if (faults.some(row => !validClock(row)) || phases.some((phase, i) => i && (fault[phase].index <= fault[phases[i - 1]].index
      || fault[phase].elapsedMs < fault[phases[i - 1]].elapsedMs))) reasons.push('fault-order-or-clock-invalid');
  if (release.elapsedMs - held.elapsedMs < delayMs || !integer(release.heldMs) || release.heldMs < delayMs) reasons.push('delay-too-short');
  evidence.actualHeldMs = release.heldMs;
  if ([held, release, responded].some(row => row.status !== 200)) reasons.push('fault-response-not-validated-200');
  if (fault.joined.result !== 'ok') reasons.push('fault-helper-not-joined-successfully');

  // Error receipt can race native cancellation. The parent captures teardown
  // Date.now() before removing the iframe; compare that host wall timestamp
  // with native atMs, never the iframe's performance.now() startup samples.
  const earlyError = mode === 'css-delay' && originalFailure ? rows.find(row => {
    if (row.kind !== 'frame' || row.docId !== held.docId) return false;
    const snapshot = stallSnapshot(row.diagnostic), teardown = diagnosticObject(row.diagnostic, 'teardown');
    const error = snapshot?.startup?.find(sample => sample.phase === 'error');
    return snapshot?.reason === 'error' && snapshot.steps?.components === 'rejected'
      && error?.stylesheet?.present === true && error.stylesheet.sheet === false
      && error.stylesheet.load === null && error.stylesheet.error === null
      && error.stylesheet.disabled === false && ['static', 'relative', 'fixed', 'sticky'].includes(error.containerPosition)
      && teardown?.reason === 'agent-error' && integer(teardown.atMs)
      && integer(held.atMs) && integer(release.atMs) && teardown.atMs >= held.atMs && teardown.atMs < release.atMs;
  }) : null;
  const teardown = earlyError ? diagnosticObject(earlyError.diagnostic, 'teardown') : null;
  if (mode === 'css-delay' && originalFailure && !earlyError) reasons.push('original-failure-not-observed-before-css-release');
  if (earlyError) evidence.errorBeforeCssRelease = { teardownAtMs: teardown.atMs, timingBasis: 'captured-host-wall-clock',
    frameReceiptElapsedMs: earlyError.elapsedMs };

  // Backend requestId/docId and native id/initialRouteScope are distinct namespaces.
  // Infer the sole core viewer scope from CSS + module starts. HTML isolation
  // probes may request viewer.html in a different scope or after this startup.
  const startsFor = key => rows.filter(row => row.kind === 'native-resource' && row.path === CORE[key] && row.event === 'resource-load-started');
  const cssStarts = startsFor('css'), moduleStarts = startsFor('module');
  const scope = cssStarts.length === 1 && moduleStarts.length === 1
    && cssStarts[0].initialRouteScope === moduleStarts[0].initialRouteScope ? cssStarts[0].initialRouteScope : null;
  evidence.routeScope = scope;
  const resources = {};
  for (const key of ['viewer', 'css', 'module']) {
    const starts = startsFor(key).filter(row => key !== 'viewer' || (row.initialRouteScope === scope && row.index < held.index));
    if (starts.length !== 1 || !integer(starts[0]?.id) || !integer(starts[0]?.initialRouteScope) || starts[0].initialRouteScope === 0) {
      reasons.push(`${key}-native-start-ambiguous`); continue;
    }
    const start = starts[0];
    const lifecycle = rows.filter(row => row.kind === 'native-resource' && row.id === start.id);
    const responses = lifecycle.filter(row => row.event === 'response');
    const finishes = lifecycle.filter(row => row.event === 'finished');
    const failures = lifecycle.filter(row => row.event === 'failed');
    if (lifecycle.some(row => row.path !== CORE[key] || row.initialRouteScope !== start.initialRouteScope || !validClock(row))) {
      reasons.push(`${key}-native-identity-or-clock-invalid`); continue;
    }
    const response = responses[0], finish = finishes[0], failed = failures[0];
    // Only an earlier, captured fatal startup error can explain a CSS abort.
    // The module must still have a successful native 200/finished lifecycle.
    const abortedAfterError = key === 'css' && earlyError && responses.length === 0 && finishes.length === 1
      && failures.length === 1 && finish.failedBeforeFinish === true
      && start.index < held.index && held.index < failed.index && failed.index < finish.index && finish.index < release.index
      && integer(failed.atMs) && failed.atMs >= teardown.atMs && failed.elapsedMs >= held.elapsedMs
      && finish.elapsedMs >= failed.elapsedMs && finish.elapsedMs < release.elapsedMs;
    if (abortedAfterError) {
      resources[key] = { start, failed, finish, abortedAfterError: true };
      evidence.cssAbortedAfterFatal = true;
      continue;
    }
    if (responses.length !== 1 || response?.status !== 200 || finishes.length !== 1 || finish?.failedBeforeFinish !== false || failures.length) {
      reasons.push(`${key}-native-lifecycle-incomplete`); continue;
    }
    if (start.index >= response.index || response.index >= finish.index || start.elapsedMs > response.elapsedMs || response.elapsedMs > finish.elapsedMs) {
      reasons.push(`${key}-native-order-invalid`); continue;
    }
    resources[key] = { start, response, finish };
  }
  if (responded.result !== 'ok' && !(resources.css?.abortedAfterError && responded.result === 'error'
      && ['BrokenPipe', 'ConnectionReset'].includes(responded.errorKind))) reasons.push('fault-response-failed');
  if (Object.keys(resources).length === 3) {
    if (!integer(scope) || scope === 0 || Object.values(resources).some(resource => resource.start.initialRouteScope !== scope)) reasons.push('core-viewer-route-scope-mismatch');
    const delayed = resources[target];
    if (delayed.start.index >= held.index || delayed.start.elapsedMs > held.elapsedMs
        || (!delayed.abortedAfterError && (delayed.response.index <= release.index || delayed.response.elapsedMs < release.elapsedMs))) reasons.push('target-not-withheld-until-release');
    evidence.nativeOrder = Object.entries(resources).flatMap(([resource, value]) => ['start', 'response', 'failed', 'finish']
      .filter(event => value[event]).map(event => ({ resource, event, id: value[event].id,
        elapsedMs: value[event].elapsedMs, traceIndex: value[event].index }))).sort((a, b) => a.traceIndex - b.traceIndex);
    evidence.heldElapsedMs = held.elapsedMs;
    evidence.releaseElapsedMs = release.elapsedMs;
    if (mode === 'css-delay') {
      const finished = resources.module.finish;
      evidence.moduleCompletedWhileCssHeld = finished.index > held.index && finished.index < release.index
        && finished.elapsedMs >= held.elapsedMs && finished.elapsedMs < release.elapsedMs;
      if (!evidence.moduleCompletedWhileCssHeld) reasons.push('module-did-not-complete-while-css-held');
    }
    if (mode === 'module-delay') {
      const finished = resources.css.finish;
      evidence.cssCompletedWhileModuleHeld = finished.index > held.index && finished.index < release.index
        && finished.elapsedMs >= held.elapsedMs && finished.elapsedMs < release.elapsedMs;
      evidence.cssCompletedBeforeModuleRelease = finished.index < release.index && finished.elapsedMs < release.elapsedMs;
      if (!evidence.cssCompletedBeforeModuleRelease) reasons.push('css-did-not-complete-before-module-release');
    }
  }
  evidence.established = reasons.length === 0;
  return evidence;
}

function inspectStartup(events, docId, outcome) {
  const snapshots = events.filter(row => row.kind === 'frame' && row.docId === docId)
    .map(row => ({ elapsedMs: row.elapsedMs, snapshot: stallSnapshot(row.diagnostic), originalError: originalError(row.diagnostic) }))
    .filter(row => row.snapshot);
  const reason = outcome === 'passed' ? 'initialized' : outcome === 'original-failure' ? 'error' : null;
  if (!reason) return { observed: true, snapshots };
  const relevant = snapshots.filter(row => row.snapshot.reason === reason);
  const sample = relevant.at(-1)?.snapshot;
  const phases = reason === 'initialized' ? ['webviewerloaded', 'components', 'initialized'] : ['webviewerloaded', 'components', 'error'];
  const valid = !!sample && Array.isArray(sample.startup) && sample.startup.length === 3
    && sample.startup.every((entry, i) => entry.phase === phases[i] && integer(entry.at)
      && entry.stylesheet && ['present', 'sheet', 'disabled'].every(key => typeof entry.stylesheet[key] === 'boolean' || entry.stylesheet[key] === null)
      && ['load', 'error'].every(key => entry.stylesheet[key] === null || integer(entry.stylesheet[key]))
      && (entry.phase === 'error' || entry.containerPosition === null))
    && (reason === 'initialized' ? sample.initialized === true && sample.steps?.components === 'resolved'
      : sample.steps?.components === 'rejected');
  return { observed: valid, reason, snapshots };
}

export function classifyCase({ target, mode, resultsText, traceText, process: processResult }) {
  const application = inspectResults(resultsText, processResult, target);
  let events;
  try { events = parseTrace(traceText); }
  catch { return { target, mode, classification: 'harness-malfunction', application, reasons: ['trace-missing-malformed-or-truncated'] }; }
  const injection = inspectInjection(events, mode, { originalFailure: application.originalFailure });
  const startup = inspectStartup(events, injection.docId, application.outcome);
  let classification = application.outcome;
  if (application.outcome === 'harness-malfunction') classification = 'harness-malfunction';
  else if (!injection.established) classification = 'injection-not-established';
  else if (!startup.observed) classification = 'startup-observation-incomplete';
  else if (application.outcome === 'passed') classification = 'not-reproduced';
  return { target, mode, classification, application, injection, startup };
}

export function classifyExperiment(cases, { binaryStable = true, harnessErrors = [] } = {}) {
  const expected = TARGETS.flatMap(target => MODES.map(mode => `${target}:${mode}`));
  const actual = cases.map(row => `${row.target}:${row.mode}`);
  const complete = actual.length === expected.length && expected.every(key => actual.filter(value => value === key).length === 1);
  const controls = cases.filter(row => row.mode === 'css-control' || row.mode === 'module-delay');
  const controlsPassed = controls.length === 4 && controls.every(row => row.classification === 'not-reproduced');
  const originalFailures = cases.filter(row => row.application?.originalFailure).map(row => `${row.target}:${row.mode}`);
  const reasons = [...harnessErrors];
  if (!complete) reasons.push('experiment-matrix-incomplete');
  if (!binaryStable) reasons.push('binary-changed-or-unreadable');
  if (!controlsPassed) reasons.push('controls-did-not-pass');
  if (cases.some(row => row.application?.htmlPassed === false)) reasons.push('html-control-did-not-pass');
  if (cases.some(row => ['harness-malfunction', 'injection-not-established', 'startup-observation-incomplete'].includes(row.classification))) reasons.push('case-inconclusive');
  if (reasons.length) return { classification: 'inconclusive', exitCode: 2, controlsPassed, originalFailures, reasons };
  if (originalFailures.length) return { classification: 'reproduced', exitCode: 1, controlsPassed, originalFailures, reasons };
  if (cases.some(row => row.classification !== 'not-reproduced')) return { classification: 'other-application-failure', exitCode: 1, controlsPassed, originalFailures, reasons };
  return { classification: 'not-reproduced', exitCode: 0, controlsPassed, originalFailures, reasons,
    conclusion: 'The bounded experiment did not reproduce the original error. This is not evidence of a fix.' };
}

async function boundedRead(file, limit = FILE_LIMIT) {
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('diagnostic file exceeds retention limit');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('diagnostic file exceeds retention limit');
    return buffer.toString('utf8', 0, bytesRead);
  } finally { await handle?.close(); }
}

async function version(command, args, cwd) {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd, timeout: 3000, maxBuffer: 64 * 1024 });
    return sanitizeDiagnostic(stdout.trim(), 1000);
  } catch { return 'unavailable'; }
}

async function gitHead(root, env) {
  const local = await version('git', ['rev-parse', 'HEAD'], root);
  if (/^[a-f\d]{40}$/i.test(local)) return { sha: local, source: 'git' };
  for (const name of ['GITHUB_SHA', 'CI_COMMIT_SHA', 'BUILD_SOURCEVERSION']) {
    if (/^[a-f\d]{40,64}$/i.test(env[name] ?? '')) return { sha: env[name].toLowerCase(), source: name };
  }
  return { sha: null, source: 'unavailable' };
}

async function runNative(exe, args, env, active, cwd) {
  const record = { code: null, signal: null, timedOut: false, interrupted: false, spawnError: false,
    pipeTimedOut: false, cleanupError: false, startedAt: new Date().toISOString(), stdout: '', stderr: '' };
  const started = performance.now();
  await new Promise(resolve => {
    const child = spawn(exe, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    const stdout = createDiagnosticSanitizer({ onText: text => { record.stdout += text; } });
    const stderr = createDiagnosticSanitizer({ onText: text => { record.stderr += text; } });
    child.stdout.on('data', chunk => stdout.write(chunk));
    child.stderr.on('data', chunk => stderr.write(chunk));
    let settled = false, closing, termination;
    const killTree = () => {
      if (termination) return termination;
      termination = (async () => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          try { await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 2000, maxBuffer: 4096 }); }
          catch { if (record.code === null) record.cleanupError = true; }
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') record.cleanupError = true; }
        }
      })();
      return termination;
    };
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(closing); active.delete(stop);
      // A separate process group contains only this experiment's app/children.
      // Clean it even after a normal app exit; a WebKit child must not leak into
      // the next case. No user-visible dviewer instance is targeted.
      await killTree();
      child.stdout.removeAllListeners('data'); child.stderr.removeAllListeners('data');
      child.stdout.destroy(); child.stderr.destroy();
      record.stdoutRetention = stdout.end(); record.stderrRetention = stderr.end();
      record.finishedAt = new Date().toISOString(); record.elapsedMs = Math.round(performance.now() - started);
      resolve();
    };
    const drainDeadline = () => {
      if (closing) return;
      closing = setTimeout(() => { record.pipeTimedOut = true; void finish(); }, CLOSE_TIMEOUT_MS);
    };
    const stop = interrupted => {
      if (settled) return;
      if (interrupted) record.interrupted = true; else record.timedOut = true;
      void killTree(); drainDeadline();
    };
    active.add(stop);
    const timer = setTimeout(() => stop(false), CASE_TIMEOUT_MS);
    child.on('error', () => { record.spawnError = true; void finish(); });
    child.on('exit', (code, signal) => { record.code = code; record.signal = signal; drainDeadline(); });
    child.on('close', (code, signal) => { record.code = code; record.signal = signal; void finish(); });
  });
  return record;
}

/** Exported for callers; importing this module never launches native processes. */
export async function main({ root = process.cwd(), env = process.env, argv = process.argv.slice(2) } = {}) {
  const artifactRoot = path.resolve(root, env.DVIEWER_PDF_STARTUP_ARTIFACT_DIR || 'pdf-startup-diagnostics');
  await mkdir(artifactRoot, { recursive: true });
  const artifacts = await mkdtemp(path.join(artifactRoot, 'run-'));
  const cases = [], harnessErrors = [], active = new Set();
  let work, before, after, exe, interrupted = false;
  const onSignal = () => { interrupted = true; for (const stop of active) stop(true); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    if (argv.length) throw new Error('this runner takes no arguments; it always uses a built release binary');
    validateMode(env.DVIEWER_PDF_STARTUP_REPRO);
    const name = process.platform === 'win32' ? 'dviewer.exe' : 'dviewer';
    const candidates = env.DVIEWER_EXE ? [path.resolve(root, env.DVIEWER_EXE)] : [
      path.join(root, 'src-tauri', 'target', 'release', name),
      path.join(root, 'src-tauri', 'target', 'universal-apple-darwin', 'release', name),
    ];
    exe = candidates.find(candidate => existsSync(candidate));
    if (!exe) throw new Error('built release binary unavailable; build it before this experiment');
    before = await fileFingerprint(exe);
    if (!before.sha256 || !before.bytes) throw new Error('cannot fingerprint built release binary');
    const fixtureRoot = path.join(root, 'fixtures');
    const experiments = makeExperiments(JSON.parse(await boundedRead(path.join(fixtureRoot, 'smoke.json'), 1024 * 1024)), fixtureRoot);
    for (const name of ['report.html', ...TARGETS]) {
      if (!(await stat(path.join(fixtureRoot, name))).isFile()) throw new Error(`fixture unavailable: ${name}`);
    }
    const head = await gitHead(root, env);
    const environment = sanitizeEnvironment({ platform: process.platform, osRelease: osRelease(), arch: arch(), node: process.version,
      profile: 'release', binary: path.basename(exe), binarySha256: before.sha256, binaryBytes: before.bytes,
      rust: await version('rustc', ['--version'], root), webkit: await version('pkg-config', ['--modversion', 'webkit2gtk-4.1'], root),
      gtk: await version('pkg-config', ['--modversion', 'gtk+-3.0'], root), libsoup: await version('pkg-config', ['--modversion', 'libsoup-3.0'], root),
      pdfjs: await pdfjsFingerprint(root) });
    await writeFile(path.join(artifacts, 'environment.json'), JSON.stringify({ ...environment, gitHead: head, caseTimeoutMs: CASE_TIMEOUT_MS,
      closeTimeoutMs: CLOSE_TIMEOUT_MS, processOutputLimitBytes: 256 * 1024, sourceManifest: 'fixtures/smoke.json' }, null, 2));
    work = await mkdtemp(path.join(tmpdir(), 'dviewer-pdf-startup-'));
    for (const experiment of experiments) {
      if (interrupted) break;
      const fingerprint = await fileFingerprint(exe);
      if (fingerprint.sha256 !== before.sha256 || fingerprint.bytes !== before.bytes) throw new Error('binary changed before experiment finished');
      const directory = path.join(artifacts, experiment.name);
      await mkdir(directory);
      const manifest = path.join(work, `${experiment.name}.json`);
      await writeFile(manifest, experiment.manifest);
      await writeFile(path.join(directory, 'manifest.json'), experiment.manifest);
      const output = path.join(directory, 'results.jsonl');
      const processResult = await runNative(exe, [`--smoke=${manifest}`, `--smoke-out=${output}`],
        { ...env, DVIEWER_INSTANCE: 'smoke', DVIEWER_PDF_STARTUP_REPRO: experiment.mode }, active, root);
      await writeFile(path.join(directory, 'process.json'), JSON.stringify(processResult, null, 2));
      let resultsText = '', traceText = '';
      try { resultsText = await boundedRead(output); traceText = await boundedRead(path.join(directory, 'results.trace.jsonl')); }
      catch { /* Raw artifacts stay in place; classification reports missing evidence. */ }
      const result = classifyCase({ target: experiment.target, mode: experiment.mode, resultsText, traceText, process: processResult });
      cases.push(result);
      await writeFile(path.join(directory, 'analysis.json'), JSON.stringify(result, null, 2));
      console.log(`${experiment.name}: ${result.classification}; native exit ${processResult.code ?? 'none'}`);
      if (processResult.timedOut || processResult.cleanupError || processResult.interrupted || processResult.pipeTimedOut) break;
    }
  } catch (error) {
    harnessErrors.push(sanitizeDiagnostic(error?.message ?? 'unknown harness error', 1000));
  } finally {
    for (const stop of active) stop(true);
    if (exe) after = await fileFingerprint(exe);
    if (interrupted) harnessErrors.push('experiment-interrupted');
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    if (work) await rm(work, { recursive: true, force: true }).catch(() => harnessErrors.push('temporary-manifest-cleanup-failed'));
  }
  const binaryStable = !!before?.sha256 && before.sha256 === after?.sha256 && before.bytes === after.bytes;
  const verdict = classifyExperiment(cases, { binaryStable, harnessErrors });
  await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ ...verdict, binaryBefore: before ?? null, binaryAfter: after ?? null, cases }, null, 2));
  console.log(`PDF startup experiment: ${verdict.classification}; artifacts: ${artifacts}`);
  if (verdict.classification === 'not-reproduced') console.log(verdict.conclusion);
  return verdict.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`PDF startup harness failed: ${sanitizeDiagnostic(error?.message ?? 'unknown error', 1000)}`);
    process.exitCode = 2;
  });
}
