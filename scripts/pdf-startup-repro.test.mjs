import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MODES, TARGETS, validateMode, makeExperiments, parseTrace, stallSnapshot,
  inspectResults, inspectInjection, classifyCase, classifyExperiment } from './pdf-startup-repro.mjs';

const source = [
  { file: 'report.html', expect: 'frame', then: 'htmlFrame' },
  { file: 'report.pdf', expect: 'frame', then: 'pdfFrame' },
  { file: 'upright-image.pdf', expect: 'frame', then: 'pdfImageUpright' },
];
const ERR = 'components: The `container` must be absolutely positioned.';
const paths = { css: '/_/pdfjs/web/viewer.css', module: '/_/pdfjs/web/viewer.mjs', viewer: '/_/pdfjs/web/viewer.html' };
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const exited = code => ({ code, signal: null, timedOut: false, spawnError: false });
function results(target = 'report.pdf', failure = null) {
  return jsonl([
    { file: '/temporary/fixtures/report.html', ok: true },
    { file: `/temporary/fixtures/${target}`, ok: !failure, ...(failure ? { error: failure } : {}) },
    { summary: { total: 2, failed: failure ? 1 : 0 } },
  ]);
}
function snapshot(error = false) {
  return { reason: error ? 'error' : 'initialized', initialized: !error, steps: { components: error ? 'rejected' : 'resolved' },
    startup: ['webviewerloaded', 'components', error ? 'error' : 'initialized'].map((phase, i) => ({
      phase, at: 200 + i, containerPosition: phase === 'error' ? 'static' : null,
      stylesheet: { present: true, sheet: !error, disabled: false, load: error ? null : 150, error: null },
    })) };
}
function trace(mode = 'css-delay', failure = false) {
  const target = mode === 'module-delay' ? 'module' : 'css', delayMs = mode === 'css-control' ? 0 : 1000;
  const rows = [];
  const add = (elapsedMs, value) => rows.push({ elapsedMs, atMs: 10_000 + elapsedMs, clockOriginAtMs: 10_000, dropped: 0, ...value });
  const fault = (phase, elapsedMs, extra = {}) => add(elapsedMs, { kind: 'pdf-startup-fault', phase, target, delayMs,
    requestId: ['armed', 'joined'].includes(phase) ? null : 15, docId: ['armed', 'joined'].includes(phase) ? null : 2,
    status: ['armed', 'joined'].includes(phase) ? null : 200, ...extra });
  const native = (resource, event, elapsedMs, extra = {}) => add(elapsedMs, { kind: 'native-resource', event, path: paths[resource],
    id: { viewer: 100, css: 101, module: 102 }[resource], initialRouteScope: 7, ...extra });
  const finish = (resource, time) => {
    native(resource, 'response', time, { status: 200 });
    native(resource, 'finished', time + 1, { failedBeforeFinish: false });
  };
  fault('armed', 0);
  add(1, { kind: 'native-hook', state: 'ready' });
  native('viewer', 'resource-load-started', 2); finish('viewer', 3);
  native('css', 'resource-load-started', 10);
  native('module', 'resource-load-started', 11);
  fault('held', 20);
  if (mode === 'css-control') {
    fault('release', 20, { heldMs: 0 }); finish('css', 22); finish('module', 25);
  } else {
    finish(target === 'css' ? 'module' : 'css', 25);
    fault('release', 1020, { heldMs: 1000 }); finish(target, 1022);
  }
  fault('responded', delayMs + 30, { result: 'ok' });
  fault('joined', delayMs + 35, { result: 'ok' });
  add(delayMs + 40, { kind: 'frame', docId: 2,
    diagnostic: `(frame: error ${failure ? ERR : '-'}, stall ${JSON.stringify(snapshot(failure))}, orientation -${failure ? ', teardown '+JSON.stringify({atMs:10050,reason:'agent-error'}) : ''})` });
  rows.push({ kind: 'trace-retention', dropped: 0, bytes: 3000, limitBytes: 8 * 1024 * 1024 });
  return rows;
}
function one(mode = 'css-delay', failure = null, target = 'report.pdf', events = trace(mode, !!failure)) {
  return classifyCase({ target, mode, resultsText: results(target, failure), traceText: jsonl(events), process: exited(failure ? 1 : 0) });
}
function matrix() { return TARGETS.flatMap(target => MODES.map(mode => one(mode, null, target))); }

// These tests intentionally never launch an app or depend on generated fixtures.
test('matrix comes only from the generator manifest with identical HTML-to-PDF steps per condition', () => {
  const cases = makeExperiments([...source, { file: 'old-ghost.pdf', expect: 'frame' }], '/fixtures');
  assert.equal(cases.length, 6);
  for (const target of TARGETS) {
    const group = cases.filter(row => row.target === target);
    assert.deepEqual(group.map(row => row.mode), MODES);
    assert.equal(new Set(group.map(row => row.manifest)).size, 1);
    const plan = JSON.parse(group[0].manifest);
    assert.deepEqual(plan.map(row => path.basename(row.file)), ['report.html', target]);
    assert.ok(plan.every(row => path.isAbsolute(row.file)));
    assert.equal(plan[0].then, 'htmlFrame');
    assert.equal(plan[1].then, source.find(row => row.file === target).then);
  }
  assert.throws(() => makeExperiments(source.slice(1), '/fixtures'), /report.html/);
  assert.throws(() => makeExperiments([...source, source[1]], '/fixtures'), /exactly one/);
  assert.throws(() => makeExperiments({}, '/fixtures'), /array/);
});

test('only exact fault modes are accepted, including when supplied in the environment', () => {
  for (const value of [undefined, ...MODES]) assert.doesNotThrow(() => validateMode(value));
  for (const value of ['', 'css', 'CSS-delay', 'css-delay ', 'module-delay=1000', null]) assert.throws(() => validateMode(value), /invalid/);
});

test('native proof establishes each condition without equating backend and native IDs', () => {
  for (const mode of MODES) {
    const proof = inspectInjection(trace(mode), mode);
    assert.equal(proof.established, true, JSON.stringify(proof));
    assert.equal(proof.injectionCount, 1);
    assert.equal(proof.docId, 2);
    assert.equal(proof.requestId, 15);
    assert.equal(proof.routeScope, 7);
    assert.equal(proof.nativeOrder.length, 9);
    if (mode === 'css-delay') assert.equal(proof.moduleCompletedWhileCssHeld, true);
    if (mode === 'module-delay') assert.equal(proof.cssCompletedBeforeModuleRelease, true);
  }
});

test('CSS-delay cannot claim a negative result when viewer.mjs finished after CSS release', () => {
  const rows = trace();
  const finish = rows.find(row => row.path === paths.module && row.event === 'finished');
  finish.elapsedMs = 1021;
  assert.equal(inspectInjection(rows, 'css-delay').established, false);
  assert.equal(one('css-delay', null, 'report.pdf', rows).classification, 'injection-not-established');
});

test('module delay permits CSS completion before hold, but never after release', () => {
  const rows = trace('module-delay');
  const css = rows.filter(row => row.path === paths.css && ['response', 'finished'].includes(row.event));
  const heldIndex = rows.findIndex(row => row.phase === 'held');
  for (const row of css) rows.splice(rows.indexOf(row), 1);
  css[0].elapsedMs = 17; css[1].elapsedMs = 18;
  rows.splice(heldIndex, 0, ...css);
  let proof = inspectInjection(rows, 'module-delay');
  assert.equal(proof.established, true);
  assert.equal(proof.cssCompletedWhileModuleHeld, false);
  css[1].elapsedMs = 1021;
  proof = inspectInjection(rows, 'module-delay');
  assert.equal(proof.established, false);
});

test('each missing/duplicate fault phase, invalid delay, helper failure, and changed identity is inconclusive', () => {
  const mutations = [
    rows => rows.splice(rows.findIndex(row => row.phase === 'held'), 1),
    rows => rows.push({ ...rows.find(row => row.phase === 'held') }),
    rows => { rows.find(row => row.phase === 'release').elapsedMs = 1019; },
    rows => { rows.find(row => row.phase === 'responded').result = 'error'; },
    rows => { rows.find(row => row.phase === 'joined').result = 'panic'; },
    rows => { rows.find(row => row.phase === 'responded').docId = 9; },
    rows => { rows.find(row => row.phase === 'held').requestId = null; },
    rows => { rows.find(row => row.phase === 'armed').delayMs = 500; },
    rows => { rows.find(row => row.phase === 'held').status = 404; },
    rows => { rows.find(row => row.phase === 'release').heldMs = 999; },
    rows => { rows.find(row => row.phase === 'release').clockOriginAtMs = 99; },
    rows => { rows.find(row => row.phase === 'release').elapsedMs = NaN; },
  ];
  for (const mutate of mutations) {
    const rows = trace(); mutate(rows);
    assert.equal(inspectInjection(rows, 'css-delay').established, false);
  }
});

test('native starts alone and server respond Ok are never delivery proof', () => {
  const mutations = [
    rows => rows.filter(row => !(row.path === paths.module && row.event === 'finished')),
    rows => rows.map(row => row.path === paths.module ? { ...row, initialRouteScope: 8 } : row),
    rows => rows.map(row => row.path === paths.css && row.event === 'response' ? { ...row, status: 404 } : row),
    rows => rows.map(row => row.path === paths.css && row.event === 'finished' ? { ...row, failedBeforeFinish: true } : row),
    rows => [...rows, { ...rows.find(row => row.path === paths.module && row.event === 'resource-load-started'), id: 200 }],
    rows => rows.map(row => row.kind === 'native-hook' ? { ...row, state: 'unsupported-platform' } : row),
    rows => rows.map(row => row.kind === 'trace-retention' ? { ...row, dropped: 1 } : row),
    rows => rows.filter(row => row.kind !== 'trace-retention'),
    rows => rows.map(row => row.path === paths.css && row.event === 'response' ? { ...row, elapsedMs: 1000 } : row),
    rows => rows.map(row => row.path === paths.module && row.event === 'finished' ? { ...row, clockOriginAtMs: 20000 } : row),
  ];
  for (const mutate of mutations) assert.equal(inspectInjection(mutate(trace()), 'css-delay').established, false);
});

test('result parsing preserves original exit1 and false verdict instead of treating expected failure as pass', () => {
  const original = inspectResults(results('report.pdf', ERR), exited(1), 'report.pdf');
  assert.equal(original.outcome, 'original-failure');
  assert.equal(original.originalFailure, true);
  assert.equal(original.summary.failed, 1);
  assert.equal(one('css-delay', ERR).classification, 'original-failure');
  assert.equal(inspectResults(results('report.pdf', 'some other failure'), exited(1), 'report.pdf').outcome, 'other-failure');
  assert.equal(inspectResults(results('report.pdf', 'The container must be absolutely positioned.'), exited(1), 'report.pdf').originalFailure, false);
  assert.equal(inspectResults(results('report.pdf', ERR), exited(0), 'report.pdf').outcome, 'harness-malfunction');
  const missing = trace().filter(row => row.phase !== 'held');
  const uncertain = one('css-delay', ERR, 'report.pdf', missing);
  assert.equal(uncertain.classification, 'injection-not-established');
  assert.equal(uncertain.application.originalFailure, true);
});

test('process crashes, incomplete summaries, count mismatches, and unexpected fixture sequences are harness failures', () => {
  for (const process of [exited(2), exited(null), { ...exited(0), timedOut: true }, { ...exited(0), signal: 'SIGSEGV' },
    { ...exited(0), spawnError: true }, { ...exited(0), pipeTimedOut: true }, { ...exited(0), cleanupError: true }]) {
    assert.equal(inspectResults(results(), process, 'report.pdf').outcome, 'harness-malfunction');
  }
  for (const text of ['', 'null\n', '[]\n', '{bad}\n', results().trimEnd(), results().replace('"total":2', '"total":3'),
    results().replace('report.html', 'ghost.html'), results().replace('"failed":0', '"failed":1')]) {
    assert.equal(inspectResults(text, exited(0), 'report.pdf').outcome, 'harness-malfunction');
  }
});

test('snapshot extraction handles quoted braces and rejects truncation without inventing startup evidence', () => {
  const value = { reason: 'initialized', tricky: '} escaped " \\" {', nested: { x: 1 } };
  const diagnostic = `prefix, stall ${JSON.stringify(value)}, orientation -)`;
  assert.deepEqual(stallSnapshot(diagnostic), value);
  assert.equal(stallSnapshot('prefix, stall -, orientation -)'), null);
  assert.equal(stallSnapshot(diagnostic.slice(0, -30)), null);
  assert.equal(stallSnapshot('no stall marker'), null);
  assert.throws(() => parseTrace('{broken}\n'));
  assert.throws(() => parseTrace(jsonl(trace()).trimEnd()), /complete/);
});

test('success requires the matching PDF initialized snapshot and passive stylesheet observations', () => {
  for (const mode of MODES) assert.equal(one(mode).classification, 'not-reproduced');
  const mutations = [
    rows => { rows.find(row => row.kind === 'frame').docId = 1; },
    rows => { rows.find(row => row.kind === 'frame').diagnostic = '(frame: stall -)'; },
    rows => { rows.find(row => row.kind === 'frame').diagnostic = rows.find(row => row.kind === 'frame').diagnostic.replace('"reason":"initialized"', '"reason":"timeout"'); },
    rows => { rows.find(row => row.kind === 'frame').diagnostic = rows.find(row => row.kind === 'frame').diagnostic.replace('"containerPosition":null', '"containerPosition":"absolute"'); },
  ];
  for (const mutate of mutations) {
    const rows = trace(); mutate(rows);
    assert.equal(one('css-delay', null, 'report.pdf', rows).classification, 'startup-observation-incomplete');
  }
});

test('complete passing matrix is explicitly not-reproduced, never fixed', () => {
  const verdict = classifyExperiment(matrix());
  assert.equal(verdict.classification, 'not-reproduced');
  assert.equal(verdict.exitCode, 0);
  assert.match(verdict.conclusion, /not evidence of a fix/);
});

test('established original failure exits1 only with valid passing controls; all uncertainties exit2', () => {
  const cases = matrix();
  cases[1] = one('css-delay', ERR);
  assert.equal(classifyExperiment(cases).classification, 'reproduced');
  assert.equal(classifyExperiment(cases).exitCode, 1);
  assert.equal(classifyExperiment(cases, { binaryStable: false }).exitCode, 2);
  assert.equal(classifyExperiment(cases, { harnessErrors: ['interrupted'] }).exitCode, 2);
  assert.equal(classifyExperiment(cases.slice(1)).exitCode, 2);
  const duplicate = [...cases]; duplicate[5] = cases[4];
  assert.equal(classifyExperiment(duplicate).exitCode, 2);
  cases[0] = one('css-control', ERR);
  assert.equal(classifyExperiment(cases).exitCode, 2);
  assert.equal(classifyExperiment(cases).originalFailures.length, 2);
  cases[0] = one('css-control');
  cases[1] = one('css-delay', ERR, 'report.pdf', trace('css-delay', true).filter(row => row.phase !== 'held'));
  assert.equal(classifyExperiment(cases).exitCode, 2);
  cases[1] = one('css-delay', 'unrelated error');
  assert.equal(classifyExperiment(cases).classification, 'other-application-failure');
  assert.equal(classifyExperiment(cases).exitCode, 1);
});

function abortAfterFatal() {
  const rows = trace('css-delay', true);
  const css = rows.filter(row => row.path === paths.css && row.event !== 'resource-load-started');
  for (const row of css) rows.splice(rows.indexOf(row), 1);
  const at = rows.findIndex(row => row.phase === 'release');
  const common = { kind: 'native-resource', id: 101, initialRouteScope: 7, path: paths.css,
    clockOriginAtMs: 10000, dropped: 0 };
  rows.splice(at, 0, { ...common, event: 'failed', elapsedMs: 60, atMs: 10060, errorDomain: 'webkit-network', errorCode: 302 },
    { ...common, event: 'finished', elapsedMs: 61, atMs: 10061, failedBeforeFinish: true });
  const responded = rows.find(row => row.phase === 'responded');
  responded.result = 'error'; responded.errorKind = 'BrokenPipe';
  return rows;
}

test('CSS abort after a captured original fatal is fallout, while the successful module still proves injection', () => {
  const rows = abortAfterFatal();
  const result = one('css-delay', ERR, 'report.pdf', rows);
  assert.equal(result.classification, 'original-failure', JSON.stringify(result));
  assert.equal(result.injection.cssAbortedAfterFatal, true);
  assert.equal(result.injection.moduleCompletedWhileCssHeld, true);
  assert.equal(result.injection.errorBeforeCssRelease.teardownAtMs, 10050);
  const cases = matrix(); cases[1] = result;
  assert.equal(classifyExperiment(cases).exitCode, 1);
});

test('CSS abort is never excused without the earlier precise fatal, stylesheet state, and known disconnect outcome', () => {
  const mutations = [
    rows => { rows.find(row => row.kind === 'frame').diagnostic = rows.find(row => row.kind === 'frame').diagnostic.replace('10050', '10070'); },
    rows => { rows.find(row => row.kind === 'frame').diagnostic = rows.find(row => row.kind === 'frame').diagnostic.replace('10050', '11050'); },
    rows => { rows.find(row => row.kind === 'frame').diagnostic = rows.find(row => row.kind === 'frame').diagnostic.replaceAll('"sheet":false', '"sheet":true'); },
    rows => { rows.find(row => row.kind === 'frame').diagnostic = rows.find(row => row.kind === 'frame').diagnostic.replace('"reason":"agent-error"', '"reason":"deadline"'); },
    rows => { rows.find(row => row.phase === 'responded').errorKind = 'TimedOut'; },
    rows => { rows.find(row => row.path === paths.module && row.event === 'finished').failedBeforeFinish = true; },
  ];
  for (const mutate of mutations) {
    const rows = abortAfterFatal(); mutate(rows);
    assert.equal(one('css-delay', ERR, 'report.pdf', rows).classification, 'injection-not-established');
  }
  assert.equal(one('css-delay', null, 'report.pdf', abortAfterFatal()).classification, 'injection-not-established');
});

test('HTML isolation probes cannot masquerade as or invalidate the unique PDF startup scope', () => {
  const rows = trace();
  const first = rows.findIndex(row => row.path === paths.viewer);
  rows.splice(first, 0, { ...rows[first], id: 500, initialRouteScope: 3 });
  assert.equal(inspectInjection(rows, 'css-delay').established, true);
  rows.push({ ...rows.find(row => row.path === paths.viewer), id: 600, initialRouteScope: 7 });
  assert.equal(inspectInjection(rows, 'css-delay').established, true);
  const nativeModule = rows.find(row => row.path === paths.module && row.event === 'resource-load-started');
  rows.push({ ...nativeModule, id: 700 });
  assert.equal(inspectInjection(rows, 'css-delay').established, false);
});

test('module-delay failures invalidate CSS causality even when the CSS-delay error reproduces', () => {
  const cases = matrix(); cases[1] = one('css-delay', ERR); cases[2] = one('module-delay', ERR);
  const result = classifyExperiment(cases);
  assert.equal(result.classification, 'inconclusive');
  assert.equal(result.exitCode, 2);
  assert.equal(result.controlsPassed, false);
  assert.equal(result.originalFailures.length, 2);
});


test('error frame captured before frameError assignment still correlates with the exact failed PDF result', () => {
  const rows = abortAfterFatal();
  const frame = rows.find(row => row.kind === 'frame');
  frame.diagnostic = frame.diagnostic.replace(ERR, '-');
  const result = one('css-delay', ERR, 'report.pdf', rows);
  assert.equal(result.classification, 'original-failure');
  assert.equal(result.application.originalFailure, true);
  assert.equal(result.startup.observed, true);
  assert.equal(one('css-delay', 'unrelated failure', 'report.pdf', rows).classification, 'injection-not-established');
});
