// Windows-only, real updater UI/installer gate. Both versions use this source tree
// with test version/key overlays: this is NOT a published-old-binary upgrade test.
// No smoke mode, production keys, replacement-app launch, or optional pass paths.
import assert from 'node:assert/strict';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.agent-works', 'm22-e2e');
const diagnostics = join(root, 'updater-e2e-diagnostics');
const marker = join(out, 'e2e-owner.json');
const identifier = 'com.xenia.dviewer.m22test';
const from = '0.24.2', to = '0.25.0';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function windowsArgs(command) {
  // The CommandLineToArgvW quoting rules, for our ordinary executable/arguments.
  const args = []; let i = 0;
  while (i < command.length) {
    while (/\s/.test(command[i] ?? '') && i < command.length) i++;
    if (i === command.length) break;
    let value = '', quoted = false;
    while (i < command.length && (quoted || !/\s/.test(command[i]))) {
      let slashes = 0;
      while (command[i] === '\\') { slashes++; i++; }
      if (command[i] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) value += '"'; else quoted = !quoted;
        i++;
      } else {
        value += '\\'.repeat(slashes);
        if (i < command.length && !quoted && /\s/.test(command[i])) break;
        if (i < command.length) value += command[i++];
      }
    }
    args.push(value);
  }
  return args;
}

export function assertRestart(before, after, expected) {
  assert.ok(Number.isInteger(after.pid) && after.pid > 0, 'new process PID missing');
  assert.notEqual(after.pid, before.pid, 'the original process is still running');
  assert.equal(win32.normalize(after.path).toLowerCase(), win32.normalize(expected.path).toLowerCase(), 'unexpected replacement path');
  assert.equal(after.version, to, 'replacement version mismatch');
  assert.equal(after.flavor, expected.flavor, 'replacement distribution mismatch');
  const args = windowsArgs(after.commandLine);
  assert.deepEqual(args.slice(1).filter(arg => arg !== '--').sort(), [`--open=${expected.file}`, `--open-url=${expected.url}`].sort(), 'updater lost or changed original reopen arguments');
  assert.equal(after.restoreSession, false, 'ordinary session restore must stay disabled');
  if (expected.flavor === 'portableExe') assert.equal(after.sha256, expected.sha256, 'portable replacement bytes mismatch');
}

export function sanitize(value, replacements = []) {
  let text = String(value);
  for (const item of replacements.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(item).join('<test-path>');
    text = text.split(item.replaceAll('\\', '/')).join('<test-path>');
    text = text.split(item.replaceAll('\\', '\\\\')).join('<test-path>');
  }
  return text.replace(/(?:https?|ws):\/\/127\.0\.0\.1:\d+/g, '<loopback>')
    .replace(/[A-Za-z0-9+/=]{60,}/g, '<encoded-data>').slice(0, 2000);
}

export async function waitFor(label, check, timeout = 60_000, interval = 250) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; }
    catch (error) { last = error; }
    await pause(interval);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}

export class Cdp {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.events = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`CDP ${request.method}: ${message.error.message}`));
        else request.resolve(message.result);
      } else if (['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded'].includes(message.method)) {
        if (this.events.length < 100) this.events.push(message);
      }
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(`CDP closed during ${request.method}`)); }
      this.pending.clear();
    });
  }
  async send(method, params = {}, timeout = 15_000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`Page evaluation failed: ${result.exceptionDetails.text}`);
    return result.result.value;
  }
  async click(expression, exiting = false) {
    const point = await this.evaluate(`(() => { const el = ${expression}; if (!el || el.disabled) throw new Error('UI control missing or disabled'); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); if (!r.width || !r.height) throw new Error('UI control hidden'); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    try { await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); }
    catch (error) { if (!exiting || !/CDP closed during/.test(error.message)) throw error; }
  }
  close() { this.socket.close(); }
}

function child(file, args, options = {}) {
  const process = spawn(file, args, { cwd: root, windowsHide: true, stdio: 'ignore', ...options });
  process.on('error', error => { process.failure = error; });
  return process;
}
async function run(file, args, options = {}, timeout = 60_000, onStart = () => {}) {
  const process = child(file, args, options);
  onStart(process);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        // This PID is the child just created by this invocation, never a name match.
        child('taskkill.exe', ['/PID', String(process.pid), '/T', '/F']);
        reject(new Error(`Child timed out: ${basename(file)}`));
      }, timeout);
      process.once('error', reject);
      process.once('exit', code => code === 0 ? resolve() : reject(new Error(`${basename(file)} exited ${code}`)));
    });
  } finally { clearTimeout(timer); }
}
async function powershell(script, extra = {}) {
  const process = child('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); " + script], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...globalThis.process.env, ...extra },
  });
  let stdout = '', stderr = '';
  process.stdout.on('data', data => { stdout += data; });
  process.stderr.on('data', data => { stderr += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.kill(); reject(new Error('Windows process query timed out')); }, 15_000);
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Windows process query failed: ${stderr}`)); });
  });
  return stdout.trim();
}
async function processes(executable) {
  const data = await powershell(`@(Get-CimInstance Win32_Process -Filter "Name='dviewer.exe'" | Where-Object { $_.ExecutablePath -ieq $env:DVIEWER_TEST_EXE } | ForEach-Object { @{pid=[int]$_.ProcessId;path=$_.ExecutablePath;commandLine=$_.CommandLine} }) | ConvertTo-Json -Compress`, { DVIEWER_TEST_EXE: executable });
  const parsed = JSON.parse(data || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}
export function matchesTrackedProcess(record, live) {
  if (!live || live.pid !== record.pid) return false;
  assert.ok(typeof live.path === 'string' && live.path && typeof live.commandLine === 'string' && live.commandLine
    && Number.isFinite(Date.parse(live.created)), 'cannot verify recorded process ownership');
  return win32.normalize(live.path ?? '').toLowerCase() === win32.normalize(record.executable).toLowerCase()
    && JSON.stringify(windowsArgs(live.commandLine ?? '').slice(1)) === JSON.stringify(record.args)
    && Math.abs(Date.parse(live.created) - record.startedAt) < 5000;
}
async function processByPid(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0, 'invalid recorded process PID');
  const data = await powershell(`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { @{pid=[int]$p.ProcessId;path=$p.ExecutablePath;commandLine=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`);
  return data ? JSON.parse(data) : null;
}
export async function killAndProveGone(pid, stillOwned, kill = () => run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {}, 15_000), timeout = 20_000) {
  let failure;
  try { await kill(); }
  catch (error) { failure = error; }
  await waitFor(`owned process ${pid} exit${failure ? ` after ${failure.message}` : ''}`, async () => !await stillOwned(), timeout, Math.min(250, timeout));
}
async function stopTracked(owned) {
  for (const record of owned.children ?? []) {
    const allowed = {
      builder: [join(root, 'scripts', 'test-updater-windows.mjs'), from, to],
      server: [join(root, 'scripts', 'serve-updater-test.mjs')],
    };
    assert.ok(Object.hasOwn(allowed, record.role), 'unexpected owned child role');
    assert.equal(record.executable, process.execPath, 'unexpected owned child executable');
    assert.deepEqual(record.args, allowed[record.role], 'unexpected owned child arguments');
    assert.ok(Number.isFinite(record.startedAt), 'owned process start time missing');
    const stillOwned = async () => matchesTrackedProcess(record, await processByPid(record.pid));
    // A reused PID belongs to someone else and must never be terminated.
    if (await stillOwned()) await killAndProveGone(record.pid, stillOwned);
  }
}
async function ownedProcesses() {
  const data = await powershell(`@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:DVIEWER_TEST_ROOT + '\\',[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { @{pid=[int]$_.ProcessId;path=$_.ExecutablePath;created=$_.CreationDate.ToUniversalTime().ToString('o')} }) | ConvertTo-Json -Compress`, { DVIEWER_TEST_ROOT: out });
  const rows = JSON.parse(data || '[]');
  return Array.isArray(rows) ? rows : [rows];
}
async function stopOwned() {
  for (const record of await ownedProcesses()) {
    const stillOwned = async () => (await ownedProcesses()).some(live => live.pid === record.pid && live.path === record.path && live.created === record.created);
    if (await stillOwned()) await killAndProveGone(record.pid, stillOwned);
  }
  await waitFor('all isolated app/installer processes exited', async () => (await ownedProcesses()).length === 0, 20_000);
}
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function connect(port) {
  return waitFor('WebView2 app CDP target', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    assert.ok(response.ok, 'CDP discovery failed');
    const targets = await response.json();
    const app = targets.find(target => target.type === 'page' && /^https?:\/\/tauri\.localhost(?:\/|$)|^tauri:\/\/localhost(?:\/|$)/.test(target.url));
    if (!app) return false;
    const address = new URL(app.webSocketDebuggerUrl);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) && Number(address.port) === port && address.protocol === 'ws:', 'CDP target must be local');
    const socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connect timed out')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket failed')); }, { once: true });
    });
    const cdp = new Cdp(socket);
    try { await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable'); return cdp; }
    catch (error) { cdp.close(); throw error; }
  });
}
const button = text => `Array.from(document.querySelectorAll('button')).find(el => (el.getAttribute('aria-label') || el.textContent.trim()) === ${JSON.stringify(text)})`;
const restore = `Array.from(document.querySelectorAll('aside.panel label')).find(el => el.textContent.includes('Restore previous documents and reading positions at startup'))?.querySelector('input')`;
const invoke = command => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)})`;
async function settings(cdp) {
  if (!await cdp.evaluate(`!!document.querySelector('aside.panel')`)) await cdp.click(button('Display settings'));
  await waitFor('settings panel', () => cdp.evaluate(`!!(${restore})`));
}
export function assertDocument(snapshot, source, marker) {
  const selected = snapshot.tabs.filter(tab => tab.selected);
  assert.equal(selected.length, 1, 'exactly one document tab must be selected');
  assert.equal(selected[0].title, source, 'wrong active document source');
  assert.equal(selected[0].opening, false, 'active document is still opening');
  assert.equal(snapshot.ready, true, 'active document view is not ready');
  assert.ok(snapshot.body.includes(marker), 'active document body is stale or missing');
}
async function checkDocuments(cdp, file, url) {
  const documents = [{ source: file, marker: 'M22 local original document' }, { source: url, marker: 'M22 URL original document' }];
  await waitFor('both original document tabs', async () => {
    const tabs = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).map(el => ({title:el.title,opening:!!el.querySelector('.opening')}))`);
    return tabs.length === 2 && documents.every(({source}) => tabs.some(tab => tab.title === source && !tab.opening));
  });
  for (const { source, marker } of documents) {
    await cdp.click(`Array.from(document.querySelectorAll('[role="tab"]')).find(el => el.title === ${JSON.stringify(source)})`);
    await waitFor('selected original document rendered body', async () => {
      const snapshot = await cdp.evaluate(`(() => { const main=document.querySelector('main'); return {
        tabs:Array.from(document.querySelectorAll('[role="tab"]')).map(el => ({title:el.title,selected:el.getAttribute('aria-selected')==='true',opening:!!el.querySelector('.opening')})),
        ready:!!main && !main.querySelector('.opening, [role="alert"]'), body:main?.innerText ?? '' }; })()`);
      assertDocument(snapshot, source, marker);
      return true;
    });
  }
}
function savedSettings() {
  return JSON.parse(readFileSync(join(process.env.APPDATA, identifier, 'dviewer.json'), 'utf8')).settings;
}

async function testInstallCount() {
  return Number(await powershell(`@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'dviewer M22 test' }).Count`));
}

async function cleanup() {
  if (!existsSync(marker)) return;
  const owned = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(owned.out, out, 'cleanup ownership mismatch');
  assert.equal(owned.run, process.env.GITHUB_RUN_ID ?? 'local', 'cleanup belongs to another run');
  assert.deepEqual(owned.data, [process.env.APPDATA, process.env.LOCALAPPDATA].map(base => join(base, identifier)), 'unexpected app data cleanup paths');
  const errors = [];
  const attempt = async task => { try { await task(); } catch (error) { errors.push(error); } };
  await attempt(() => stopTracked(owned));
  await attempt(stopOwned);
  const uninstaller = join(out, 'nsis-installed', 'uninstall.exe');
  if (existsSync(uninstaller)) await attempt(async () => {
    const temp = join(out, 'uninstall-temp'); mkdirSync(temp, { recursive: true });
    await run(uninstaller, ['/S'], { env: { ...process.env, TEMP: temp, TMP: temp } }, 60_000);
    await waitFor('isolated NSIS uninstall', () => !existsSync(join(out, 'nsis-installed', 'dviewer.exe')));
    await waitFor('isolated uninstaller exited', async () => (await ownedProcesses()).length === 0);
  });
  await attempt(async () => { assert.equal(await testInstallCount(), 0, 'isolated test uninstall registry entry survived cleanup'); });
  await attempt(async () => {
    if (!existsSync(join(out, 'context.json'))) return;
    const { directory } = JSON.parse(readFileSync(join(out, 'context.json'), 'utf8'));
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('dviewer-m22-keys-'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    assert.ok(!existsSync(directory), 'ephemeral key directory survived cleanup');
  });
  for (const path of owned.data) await attempt(() => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  // Preserve the marker on partial cleanup so the workflow's always step retries.
  if (!errors.length) await attempt(() => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  if (errors.length) throw new AggregateError(errors, 'Isolated updater cleanup failed');
}

async function main() {
  assert.equal(process.platform, 'win32', 'This gate requires native Windows; it cannot be skipped');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ is required for built-in WebSocket');
  assert.ok(process.env.APPDATA && process.env.LOCALAPPDATA, 'Windows app data paths missing');
  if (process.argv[2] === '--cleanup') { await cleanup(); return; }
  assert.equal(process.argv.length, 2, 'Usage: node scripts/test-updater-e2e.mjs [--cleanup]');
  assert.ok(!existsSync(out) || readdirSync(out).length === 0, 'Isolated build directory already exists; do not reuse another test run');
  const data = [process.env.APPDATA, process.env.LOCALAPPDATA].map(base => join(base, identifier));
  for (const path of data) assert.ok(!existsSync(path), 'Isolated test app data already exists; refusing to touch it');
  assert.ok(!existsSync(join(process.env.LOCALAPPDATA, 'dviewer M22 test')), 'Existing test installation must not be replaced');
  assert.equal(await testInstallCount(), 0, 'Existing test installation registry entry must not be replaced');
  assert.ok(!existsSync(diagnostics), 'Diagnostic directory already exists; do not overwrite prior evidence');
  mkdirSync(out, { recursive: true }); mkdirSync(diagnostics);
  const ownership = { out, data, run: process.env.GITHUB_RUN_ID ?? 'local', children: [] };
  const own = (role, childProcess, args) => {
    assert.ok(Number.isInteger(childProcess.pid), `${role} failed to start`);
    ownership.children.push({ role, pid: childProcess.pid, executable: process.execPath, args, startedAt: Date.now() });
    writeFileSync(marker, JSON.stringify(ownership));
  };
  writeFileSync(marker, JSON.stringify(ownership));
  const report = { schema: 1, sourceSha: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, from, to, source: 'same candidate tree, debug version overlays', ok: false, cases: [], stage: 'build', cleanup: false };
  const consoles = [];
  const scrub = value => sanitize(value, [out, root, process.env.USERPROFILE, process.env.APPDATA, process.env.LOCALAPPDATA, tmpdir()]);
  let server, cdp;
  function recordNative(stream, label) {
    let buffer = '', discard = false;
    stream.setEncoding('utf8');
    stream.on('data', text => {
      for (const part of text.split(/(?<=\n)/)) {
        if (!discard) buffer += part;
        if (buffer.length > 4096) { buffer = ''; discard = true; }
        if (part.endsWith('\n')) {
          if (!discard && consoles.length < 100) consoles.push({ label, event: scrub(buffer.trimEnd()) });
          buffer = ''; discard = false;
        }
      }
    });
    // An incomplete final line is discarded, never exported as a secret prefix.
  }
  async function capture(label, required = false) {
    if (!cdp) return;
    for (const event of cdp.events.splice(0)) consoles.push({ label, event: scrub(JSON.stringify(event)) });
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, 5000);
      writeFileSync(join(diagnostics, `${label}.png`), Buffer.from(data, 'base64'));
    } catch (error) {
      // The old webview closes during restart; before/after evidence is mandatory.
      if (required) throw error;
    }
  }
  try {
    const buildArgs = [join(root, 'scripts', 'test-updater-windows.mjs'), from, to];
    await run(process.execPath, buildArgs, {}, 50 * 60_000, childProcess => own('builder', childProcess, buildArgs));
    const context = JSON.parse(readFileSync(join(out, 'context.json'), 'utf8'));
    assert.equal(context.from, from); assert.equal(context.to, to);
    const serverArgs = [join(root, 'scripts', 'serve-updater-test.mjs')];
    server = child(process.execPath, serverArgs); own('server', server, serverArgs);
    const origin = await waitFor('isolated update server', () => {
      if (server.failure || server.exitCode !== null) throw new Error('Update server failed');
      if (!existsSync(join(out, 'server.json'))) return false;
      const info = JSON.parse(readFileSync(join(out, 'server.json'), 'utf8'));
      assert.equal(info.pid, server.pid); assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/); return info.origin;
    });
    const file = join(out, '원본 로컬 문서.txt'), url = `${origin}/${encodeURIComponent('원본 문서.txt')}`;
    writeFileSync(file, 'M22 local original document\n');
    writeFileSync(join(out, '원본 문서.txt'), 'M22 URL original document\n');
    for (const flavor of ['portableExe', 'nsis']) {
      report.stage = `${flavor}:prepare`;
      mkdirSync(data[0], { recursive: true });
      writeFileSync(join(data[0], 'dviewer.json'), JSON.stringify({ settings: { locale: 'en', restoreSession: true }, updates: { check: false } }));
      const directory = join(out, flavor === 'nsis' ? 'nsis-installed' : 'portable');
      mkdirSync(directory);
      const executable = join(directory, 'dviewer.exe');
      if (flavor === 'portableExe') copyFileSync(join(out, `portable-${from}.exe`), executable);
      else await run(join(out, `setup-${from}.exe`), ['/S', `/D=${directory}`], { windowsVerbatimArguments: true }, 120_000);
      assert.ok(existsSync(executable), 'isolated executable not installed at expected path');
      const port = await freePort(), temp = join(out, `${flavor}-temp`);
      mkdirSync(temp);
      const env = { ...process.env, DVIEWER_UPDATE_MANIFEST: `${origin}/latest.json`, TEMP: temp, TMP: temp,
        WEBVIEW2_USER_DATA_FOLDER: join(out, `${flavor}-webview`),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` };
      delete env.DVIEWER_INSTANCE;
      // The ONLY app launch in this flavor. After Update now, only observe.
      const original = child(executable, [`--open=${file}`, `--open-url=${url}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      recordNative(original.stdout, `${flavor}-stdout`); recordNative(original.stderr, `${flavor}-stderr`);
      cdp = await connect(port);
      const listeners = JSON.parse(await powershell(`@(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty LocalAddress) | ConvertTo-Json -Compress`));
      assert.ok([listeners].flat().length && [listeners].flat().every(address => ['127.0.0.1', '::1'].includes(address)), 'CDP listener is not loopback-only');
      await waitFor('old app version', async () => await cdp.evaluate(invoke('plugin:app|version')) === from);
      const oldStatus = await cdp.evaluate(invoke('update_status'));
      assert.equal(oldStatus.flavor, flavor); assert.equal(oldStatus.configured, true);
      assert.equal(oldStatus.check, false, 'unexpected automatic updater preferences');
      await checkDocuments(cdp, file, url);
      await settings(cdp);
      assert.equal(await cdp.evaluate(`(${restore}).checked`), true);
      await cdp.click(restore);
      await waitFor('restore-session persisted off', () => savedSettings().restoreSession === false);
      report.stage = `${flavor}:check-ui`;
      await cdp.click(button('Check now'));
      await waitFor('signed candidate in actual update dialog', async () => {
        const status = await cdp.evaluate(invoke('update_status'));
        if (status.error) throw new Error(`Updater check error: ${JSON.stringify(status.error)}`);
        return status.phase === 'idle' && status.available?.version === to && status.available.canInstall && await cdp.evaluate(`!!document.querySelector('dialog[open] #update-title')`);
      });
      // Exercise the badge's actual UI path too, rather than installing by IPC.
      await cdp.click(button('Later'));
      await cdp.click(button('Close settings'));
      await cdp.click(`document.querySelector('button.badge')`);
      await capture(`${flavor}-before`, true);
      const beforeRows = await processes(executable);
      assert.equal(beforeRows.length, 1); assert.equal(beforeRows[0].pid, original.pid);
      report.stage = `${flavor}:self-relaunch`;
      await cdp.click(button('Update now'), true);
      const afterProcess = await waitFor('updater-owned replacement PID', async () => {
        const rows = await processes(executable);
        return rows.length === 1 && rows[0].pid !== original.pid && original.exitCode !== null && rows[0];
      }, 120_000, 1000);
      await capture(`${flavor}-old-console`); cdp.close(); cdp = null;
      cdp = await connect(port);
      await waitFor('replacement app version', async () => await cdp.evaluate(invoke('plugin:app|version')) === to);
      const newStatus = await cdp.evaluate(invoke('update_status'));
      await checkDocuments(cdp, file, url);
      await settings(cdp);
      const restoreSession = await cdp.evaluate(`(${restore}).checked`);
      assert.equal(savedSettings().restoreSession, false);
      const after = { ...afterProcess, version: await cdp.evaluate(invoke('plugin:app|version')), flavor: newStatus.flavor, restoreSession,
        sha256: await hash(executable) };
      const expectedHash = flavor === 'portableExe' ? await hash(join(out, `portable-${to}.exe`)) : undefined;
      assertRestart(beforeRows[0], after, { flavor, path: executable, file, url, sha256: expectedHash });
      await cdp.click(button('Close settings'));
      await capture(`${flavor}-after`, true);
      report.cases.push({ flavor, ok: true, beforePid: original.pid, afterPid: after.pid, version: after.version,
        path: flavor === 'portableExe' ? '<isolated>/portable/dviewer.exe' : '<isolated>/nsis-installed/dviewer.exe',
        originalArguments: true, localDocument: true, urlDocument: true, restoreSession: false, sha256: after.sha256,
        ...(expectedHash ? { portableHashMatches: true } : {}) });
      cdp.close(); cdp = null;
      await stopOwned();
      for (const path of data) rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    }
    assert.equal(report.cases.length, 2, 'both Windows distributions are mandatory');
    report.ok = true; report.stage = 'complete';
  } catch (error) {
    report.error = scrub(error.message);
    await capture('failure');
  } finally {
    cdp?.close();
    try { await cleanup(); report.cleanup = true; }
    catch (error) { report.ok = false; report.cleanupError = scrub(error.message); }
    writeFileSync(join(diagnostics, 'result.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(diagnostics, 'console.json'), JSON.stringify(consoles, null, 2));
  }
  assert.ok(report.ok && report.cleanup, `Windows updater gate failed at ${report.stage}; see updater-e2e-diagnostics/result.json`);
  console.log('PASS: portableExe + NSIS real updater self-relaunch, 0.24.2 -> 0.25.0, original documents and isolated cleanup');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
