import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cdp, assertActionable, assertUpdateDialog, evaluationError, reopenUpdateDialog, assertTestBrowserOverlay, assertAppRunning, discoveryFailure, targetSummary, peMetadata, assertDocument, assertRestart, matchesTrackedProcess, killAndProveGone, sanitize, waitFor, windowsArgs } from './test-updater-e2e.mjs';
import { testBrowserArguments } from './test-updater-windows.mjs';

const file = String.raw`C:\isolated test\원본 문서.txt`;
const url = 'http://127.0.0.1:12345/%EC%9B%90%EB%B3%B8%20%EB%AC%B8%EC%84%9C.txt';
const path = String.raw`C:\isolated test\portable\dviewer.exe`;
const expected = { path, file, url, flavor: 'portableExe', sha256: 'new-hash' };
const before = { pid: 100 };
const valid = { pid: 200, path, version: '0.25.0', flavor: 'portableExe', restoreSession: false, sha256: 'new-hash',
  commandLine: `"${path}" "--open=${file}" "--open-url=${url}"` };

test('accepts a self-relaunched portable process only with all evidence', () => assertRestart(before, valid, expected));
test('accepts NSIS quoting prefix without requiring portable bytes', () => {
  assertRestart(before, { ...valid, flavor: 'nsis', sha256: 'nsis-marker-hash', commandLine: `"${path}" -- "--open-url=${url}" "--open=${file}"` }, { ...expected, flavor: 'nsis' });
});
for (const [label, changed, pattern] of [
  ['same process', { pid: 100 }, /original process/],
  ['missing PID', { pid: undefined }, /PID missing/],
  ['wrong executable', { path: String.raw`C:\other\dviewer.exe` }, /replacement path/],
  ['old version', { version: '0.24.2' }, /version mismatch/],
  ['wrong flavor', { flavor: 'nsis' }, /distribution mismatch/],
  ['session restoration masking missing arguments', { restoreSession: true }, /session restore/],
  ['wrong replacement bytes', { sha256: 'old-hash' }, /bytes mismatch/],
  ['lost local original', { commandLine: `"${path}" "--open-url=${url}"` }, /reopen arguments/],
  ['lost URL original', { commandLine: `"${path}" "--open=${file}"` }, /reopen arguments/],
  ['extra restored source', { commandLine: `${valid.commandLine} --open=extra` }, /reopen arguments/],
]) test(`fails closed for ${label}`, () => assert.throws(() => assertRestart(before, { ...valid, ...changed }, expected), pattern));

test('Windows argv preserves Unicode, spaces, URL escapes and quoted trailing slashes', () => {
  assert.deepEqual(windowsArgs(valid.commandLine), [path, `--open=${file}`, `--open-url=${url}`]);
  assert.deepEqual(windowsArgs(String.raw`"C:\app.exe" "C:\tail\\" plain\ next`), [String.raw`C:\app.exe`, 'C:\\tail\\', 'plain\\', 'next']);
  assert.deepEqual(windowsArgs('  app.exe  --  ""  '), ['app.exe', '--', '']);
});
test('sanitizer removes test paths, ports and encoded key-like payloads', () => {
  const key = 'RWT' + 'A'.repeat(120);
  const clean = sanitize(`${file} ${url} ${key}`, [String.raw`C:\isolated test`]);
  assert.ok(!clean.includes('C:')); assert.ok(!clean.includes('12345')); assert.ok(!clean.includes(key));
  assert.ok(clean.includes('<test-path>')); assert.equal(sanitize('x'.repeat(5000)).length <= 2000, true);
});
test('a missing native condition has a clear failing deadline', async () => {
  await assert.rejects(waitFor('new PID', () => false, 10, 2), /Timed out: new PID/);
  await assert.rejects(waitFor('signed update', () => { throw new Error('invalid signature'); }, 10, 2), /invalid signature/);
});
class Socket extends EventTarget {
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  reply(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { this.dispatchEvent(new Event('close')); }
}
test('CDP replies are matched by request ID and fail on protocol errors', async () => {
  const socket = new Socket(), cdp = new Cdp(socket);
  const first = cdp.send('Runtime.enable'), second = cdp.send('Page.enable');
  socket.reply({ id: 2, result: { enabled: true } }); socket.reply({ id: 1, error: { message: 'denied' } });
  assert.deepEqual(await second, { enabled: true }); await assert.rejects(first, /denied/);
});
test('CDP disconnect and deadline cannot hang the gate', async () => {
  const socket = new Socket(), cdp = new Cdp(socket);
  const result = cdp.send('Runtime.evaluate'); socket.close();
  await assert.rejects(result, /CDP closed during Runtime.evaluate/);
  await assert.rejects(new Cdp(new Socket()).send('Page.enable', {}, 5), /CDP timeout/);
});
test('workflow gate is opt-in, uses only test keys, and uploads an explicit evidence allowlist', () => {
  const workflow = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
  assert.match(workflow, /updater_e2e:\s+description:[^\n]+\s+type: boolean\s+default: false/);
  const job = workflow.slice(workflow.indexOf('\n  updater-e2e:'), workflow.indexOf('\n  # Tags can restore'));
  assert.match(job, /inputs\.updater_e2e/); assert.match(job, /runs-on: windows-latest/);
  assert.match(job, /permissions:\s+contents: read/); assert.doesNotMatch(job, /secrets\.|contents: write|--smoke/);
  assert.match(job, /if: always\(\)\s+run: node scripts\/test-updater-e2e.mjs --cleanup/);
  assert.match(job, /updater-e2e-diagnostics\/result.json/); assert.match(job, /updater-e2e-diagnostics\/console.json/);
  assert.doesNotMatch(job, /path:.*m22-e2e|path:.*context/);
});

const snapshot = { tabs: [{ title: file, selected: true, opening: false }, { title: url, selected: false, opening: false }], ready: true, body: 'M22 local original document' };
test('document evidence requires the requested active source and its distinct body', () => {
  assertDocument(snapshot, file, 'M22 local original document');
  assert.throws(() => assertDocument(snapshot, url, 'M22 local original document'), /wrong active document/);
  assert.throws(() => assertDocument({ ...snapshot, body: 'M22 URL original document' }, file, 'M22 local original document'), /stale or missing/);
});
test('opening or unselected tabs cannot count as ready restored documents', () => {
  assert.throws(() => assertDocument({ ...snapshot, ready: false }, file, 'M22 local original document'), /not ready/);
  assert.throws(() => assertDocument({ ...snapshot, tabs: snapshot.tabs.map(tab => ({ ...tab, selected: false })) }, file, 'M22 local original document'), /exactly one/);
  assert.throws(() => assertDocument({ ...snapshot, tabs: [{ ...snapshot.tabs[0], opening: true }] }, file, 'M22 local original document'), /still opening/);
});

test('cancellation cleanup matches recorded Node executable, script, PID and birth time', () => {
  const record = { pid: 234, executable: String.raw`C:\node\node.exe`, args: [String.raw`C:\repo\scripts\serve-updater-test.mjs`], startedAt: Date.parse('2026-10-06T06:00:00Z') };
  const live = { pid: 234, path: record.executable, commandLine: `"${record.executable}" "${record.args[0]}"`, created: '2026-10-06T06:00:00.001Z' };
  assert.equal(matchesTrackedProcess(record, live), true);
  for (const changed of [{ pid: 235 }, { path: 'C:\\other.exe' }, { commandLine: 'node.exe unrelated.mjs' }, { created: '2026-10-06T06:00:10Z' }]) {
    assert.equal(matchesTrackedProcess(record, { ...live, ...changed }), false);
  }
  assert.equal(matchesTrackedProcess(record, null), false);
  assert.throws(() => matchesTrackedProcess(record, { ...live, path: null }), /cannot verify/);
});

test('cleanup proves exit even when taskkill reports success', async () => {
  await assert.rejects(killAndProveGone(234, async () => true, async () => {}, 5), /owned process 234 exit/);
});
test('taskkill failure is accepted only when the owned process has really gone', async () => {
  const kill = async () => { throw new Error('taskkill failed'); };
  await killAndProveGone(234, async () => false, kill, 5);
  await assert.rejects(killAndProveGone(234, async () => true, kill, 5), /taskkill failed/);
});

test('CDP startup distinguishes a live app from clean early exit and native loader failure', () => {
  assertAppRunning({ exitCode: null, signalCode: null });
  assert.throws(() => assertAppRunning({ exitCode: 0, signalCode: null }), /App exited.*0x00000000/);
  assert.throws(() => assertAppRunning({ exitCode: -1073741515, signalCode: null }), /0xc0000135/);
  assert.throws(() => assertAppRunning({ failure: { code: 'ENOENT' }, exitCode: null, signalCode: null }), /failed to spawn.*ENOENT/);
});
test('an app exit is terminal even while CDP fetch is being retried', async () => {
  const app = { exitCode: null, signalCode: null }; let checks = 0;
  await assert.rejects(waitFor('CDP', () => {
    checks++; app.exitCode = 0; throw new Error('fetch failed');
  }, 100, 1, () => assertAppRunning(app)), /App exited before CDP readiness/);
  assert.equal(checks, 1);
});
test('startup evidence retains network failure codes but never error URLs or headers', () => {
  const result = discoveryFailure({ name: 'TypeError', message: 'secret-token http://host/private',
    cause: { name: 'Error', code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', message: 'secret-token' } });
  assert.equal(result.causeCode, 'ECONNREFUSED'); assert.equal(result.syscall, 'connect');
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});
test('CDP target diagnostics are bounded categories without URLs, titles or debugger addresses', () => {
  const targets = targetSummary([
    { type: 'page', url: 'http://tauri.localhost/', title: 'secret-title', webSocketDebuggerUrl: 'ws://secret-token' },
    { type: 'iframe', url: 'http://127.0.0.1:123/private?token=secret-token' },
    { type: 'page', url: 'https://secret-token@example.com/private' },
  ]);
  assert.deepEqual(targets.map(target => target.origin), ['tauri-app', 'loopback', 'other']);
  assert.ok(!JSON.stringify(targets).includes('secret'));
  assert.equal(targetSummary(Array(50).fill({ type: 'page', url: 'tauri://localhost/' })).length, 20);
  assert.throws(() => targetSummary({}), /not an array/);
});
test('PE diagnostics distinguish x64 console and GUI test executables', () => {
  const dos = Buffer.alloc(64), nt = Buffer.alloc(96);
  dos.write('MZ'); nt.write('PE\0\0'); nt.writeUInt16LE(0x8664, 4); nt.writeUInt16LE(3, 92);
  assert.deepEqual(peMetadata(dos, nt), { machine: '0x8664', subsystem: 3, kind: 'windows-console' });
  nt.writeUInt16LE(2, 92); assert.equal(peMetadata(dos, nt).kind, 'windows-gui');
  assert.throws(() => peMetadata(Buffer.alloc(64), nt), /not a PE/);
});
test('the actual UI launch stays visible and retains early-process health checking', () => {
  const source = readFileSync(new URL('./test-updater-e2e.mjs', import.meta.url), 'utf8');
  assert.match(source, /const original = child\(executable,[^\n]*windowsHide: false/);
  assert.match(source, /connect\(port, \{ health: \(\) => assertAppRunning\(original\), evidence: startup.discovery \}\)/);
  assert.match(source, /cleanupStarted = true; \/\/ Do not misreport/);
});

test('test API browser arguments retain pinned Wry defaults and bind only loopback', () => {
  assert.equal(testBrowserArguments(undefined), undefined);
  assert.equal(testBrowserArguments('9231'), '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --remote-debugging-address=127.0.0.1 --remote-debugging-port=9231');
  const lock = readFileSync(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8');
  assert.match(lock, /name = "wry"\nversion = "0\.55\.1"/);
});
test('test CDP port rejects invalid values and flag injection', () => {
  for (const port of ['', '0', '80', '-1', '65536', '1.5', '9231 --no-sandbox', null, 9231]) {
    assert.throws(() => testBrowserArguments(port), /test CDP port/);
  }
  assert.match(testBrowserArguments('65535'), /--remote-debugging-port=65535$/);
});
test('both built overlays must carry the exact test-only API arguments', () => {
  const overlay = { identifier: 'com.xenia.dviewer.m22test', app: { windows: [{ additionalBrowserArgs: testBrowserArguments('9231') }] } };
  assertTestBrowserOverlay(overlay, 9231);
  assert.throws(() => assertTestBrowserOverlay({ ...overlay, identifier: 'com.xenia.dviewer' }, 9231), /isolated test identifier/);
  assert.throws(() => assertTestBrowserOverlay(overlay, 9232), /arguments mismatch/);
  assert.throws(() => assertTestBrowserOverlay({ ...overlay, app: { windows: [{}] } }, 9231), /arguments mismatch/);
  const production = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.ok(production.app.windows.every(window => !window.additionalBrowserArgs?.includes('remote-debugging')));
});
test('builder has an opt-in API overlay and app launch removes the ignored env flag', () => {
  const builder = readFileSync(new URL('./test-updater-windows.mjs', import.meta.url), 'utf8');
  const harness = readFileSync(new URL('./test-updater-e2e.mjs', import.meta.url), 'utf8');
  assert.match(builder, /testBrowserArguments\(process.env.DVIEWER_TEST_CDP_PORT\)/);
  assert.match(builder, /app:\{windows:\[\{additionalBrowserArgs,/);
  assert.match(harness, /DVIEWER_TEST_CDP_PORT: String\(port\)/);
  assert.match(harness, /for \(const version of \[from, to\]\)/);
  assert.match(harness, /key.toUpperCase\(\) === 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'\) delete env\[key\]/);
});

const readyDialog = { present: true, open: true, modal: true, versionMatches: true, installEnabled: true, error: false };
test('UI clicks reject missing, disabled, hidden and covered targets', () => {
  const ready = { exists: true, disabled: false, visible: true, hitTarget: true, hitKind: 'target' };
  assertActionable(ready, 'update badge');
  for (const [change, message] of [[{ exists: false }, /missing/], [{ disabled: true }, /disabled/],
    [{ visible: false }, /hidden/], [{ hitTarget: false, hitKind: 'scrim' }, /covered \(scrim\)/]]) {
    assert.throws(() => assertActionable({ ...ready, ...change }, 'update badge'), message);
  }
});
test('ordinary main view cannot stand in for the ready update dialog', () => {
  assertUpdateDialog(readyDialog);
  for (const key of ['present', 'open', 'modal', 'versionMatches', 'installEnabled']) {
    assert.throws(() => assertUpdateDialog({ ...readyDialog, [key]: false }));
  }
  assert.throws(() => assertUpdateDialog({ ...readyDialog, error: true }), /reports an error/);
});
test('badge path waits for old close event, settings teardown and new modal readiness', async () => {
  const trace = [];
  let oldDialog = true, settings = true, closedPolls = 0, settingsPolls = 0, readyPolls = 0;
  const cdp = {
    async click(_expression, _exiting, label) {
      trace.push(`click:${label}`);
      if (label === 'Close settings') assert.equal(oldDialog, false, 'old dialog onclose must finish first');
      if (label === 'update badge') assert.equal(settings, false, 'settings scrim must be gone first');
    },
    async evaluate(expression) {
      if (expression.startsWith('!document') && expression.includes('update-title')) {
        oldDialog = ++closedPolls < 2; return !oldDialog;
      }
      if (expression.startsWith('!document') && expression.includes('aside.panel')) {
        settings = ++settingsPolls < 2; return !settings;
      }
      return { ...readyDialog, open: ++readyPolls >= 2 };
    },
  };
  const wait = async (label, check) => {
    trace.push(`wait:${label}`);
    for (let i = 0; i < 3; i++) { try { if (await check()) return; } catch (error) { if (i === 2) throw error; } }
    assert.fail(`condition never ready: ${label}`);
  };
  await reopenUpdateDialog(cdp, () => {}, wait);
  assert.deepEqual(trace, ['click:Later', 'wait:dismissed update dialog removed', 'click:Close settings',
    'wait:settings and scrim removed', 'click:update badge', 'wait:badge reopened a ready update dialog']);
  assert.equal(readyPolls, 2); assert.deepEqual(cdp.lastUpdateUi, readyDialog);
});
test('badge click without a new modal fails before installation is attempted', async () => {
  const cdp = { click: async () => {}, evaluate: async expression => expression.startsWith('!document') ? true : { ...readyDialog, present: false } };
  await assert.rejects(reopenUpdateDialog(cdp, () => {}, async (_label, check) => {
    assert.equal(await check(), true);
  }), /update dialog is absent/);
});
test('CDP evaluation errors retain the actual bounded reason instead of only Uncaught', async () => {
  const socket = new Socket(), cdp = new Cdp(socket);
  const result = cdp.evaluate('unused test expression');
  socket.reply({ id: 1, result: { result: {}, exceptionDetails: { text: 'Uncaught', lineNumber: 2, columnNumber: 7,
    exception: { description: 'Error: UI control missing or disabled\n    at private-evaluated-source' } } } });
  await assert.rejects(result, /Page evaluation failed: Error: UI control missing or disabled/);
  assert.deepEqual(cdp.lastException, { description: 'Error: UI control missing or disabled', line: 2, column: 7 });
  const redacted = evaluationError({ text: 'Uncaught', exception: { description: 'Error: https://host.invalid/private?token=secret\nprivate stack' } });
  assert.ok(!JSON.stringify(redacted).includes('secret')); assert.ok(!JSON.stringify(redacted).includes('stack'));
});
test('relaunch phase is recorded only after the actual Update now input dispatch', () => {
  const source = readFileSync(new URL('./test-updater-e2e.mjs', import.meta.url), 'utf8');
  assert.match(source, /report.stage = `\$\{flavor\}:click-update-now`;\s+await cdp.click\(button\('Update now'\), true, 'Update now'\);\s+report.stage = `\$\{flavor\}:self-relaunch`;/);
});
