// Windows-only, real updater UI/installer gate. Both versions use this source tree
// with test version/key overlays: this is NOT a published-old-binary upgrade test.
// No smoke mode, production keys, replacement-app launch, or optional pass paths.
import assert from 'node:assert/strict';
import { copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { testBrowserArguments } from './test-updater-windows.mjs';

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

export async function waitFor(label, check, timeout = 60_000, interval = 250, health = () => {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    // A dead app is terminal, not a transient CDP connection failure.
    await health();
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
async function reservePort(requested = 0) {
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requested, '127.0.0.1', resolve); });
  return { port: server.address().port, release: async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
export function assertTestBrowserOverlay(config, port) {
  assert.equal(config.identifier, 'com.xenia.dviewer.m22test', 'CDP overlay must use the isolated test identifier');
  assert.equal(config.app?.windows?.length, 1, 'CDP test must have one configured window');
  assert.equal(config.app.windows[0].additionalBrowserArgs, testBrowserArguments(String(port)), 'test overlay CDP arguments mismatch');
}
export function assertAppRunning(app) {
  if (app.failure) throw new Error(`App failed to spawn (${app.failure.code ?? app.failure.name ?? 'unknown'})`);
  if (app.exitCode !== null || app.signalCode !== null) {
    const code = Number.isInteger(app.exitCode) ? `0x${(app.exitCode >>> 0).toString(16).padStart(8, '0')}` : null;
    throw new Error(`App exited before CDP readiness (exit=${app.exitCode}, code=${code}, signal=${app.signalCode})`);
  }
}
export function discoveryFailure(error) {
  const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_ -]{1,80}$/.test(value) ? value : null;
  return { name: safeCode(error.name), code: safeCode(error.code), causeCode: safeCode(error.cause?.code),
    syscall: safeCode(error.cause?.syscall), causeName: safeCode(error.cause?.name) };
}
export function targetSummary(targets) {
  assert.ok(Array.isArray(targets), 'CDP target list is not an array');
  return targets.slice(0, 20).map(target => {
    let origin = 'invalid';
    try {
      const url = new URL(target.url);
      origin = (['http:', 'https:'].includes(url.protocol) && url.hostname === 'tauri.localhost') || (url.protocol === 'tauri:' && url.hostname === 'localhost') ? 'tauri-app'
        : ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? 'loopback' : 'other';
    } catch { /* Record only a category, never a raw URL or page title. */ }
    return { type: ['page', 'iframe', 'worker', 'service_worker'].includes(target.type) ? target.type : 'other', origin,
      debugger: typeof target.webSocketDebuggerUrl === 'string' };
  });
}
export function peMetadata(dos, nt) {
  assert.ok(dos.length >= 64 && dos.subarray(0, 2).toString() === 'MZ', 'test binary is not a PE executable');
  assert.ok(nt.length >= 96 && nt.subarray(0, 4).equals(Buffer.from('PE\0\0')), 'test PE header missing');
  const machine = nt.readUInt16LE(4), subsystem = nt.readUInt16LE(92);
  return { machine: `0x${machine.toString(16)}`, subsystem, kind: subsystem === 2 ? 'windows-gui' : subsystem === 3 ? 'windows-console' : 'other' };
}
function executableInfo(executable) {
  const fd = openSync(executable, 'r');
  try {
    const dos = Buffer.alloc(64); assert.equal(readSync(fd, dos, 0, 64, 0), 64);
    const offset = dos.readUInt32LE(60); assert.ok(offset < 1024 * 1024, 'unexpected PE header offset');
    const nt = Buffer.alloc(96); assert.equal(readSync(fd, nt, 0, 96, offset), 96);
    return { bytes: statSync(executable).size, ...peMetadata(dos, nt) };
  } finally { closeSync(fd); }
}
async function startupNative(pid, executable, profile, port) {
  const raw = await powershell(`
    $all=@(Get-CimInstance Win32_Process);
    $ids=[Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${pid});
    for ($i=0; $i -lt 8; $i++) { foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } }
    $selected=@($all | Where-Object { $ids.Contains([int]$_.ProcessId) -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.Contains($env:DVIEWER_TEST_PROFILE)) } | Select-Object -First 40);
    $rows=@($selected | ForEach-Object {
      $cmd=[string]$_.CommandLine; $version=$null;
      if ($_.Name -eq 'msedgewebview2.exe' -and $_.ExecutablePath) { $version=(Get-Item -LiteralPath $_.ExecutablePath -ErrorAction SilentlyContinue).VersionInfo.ProductVersion }
      @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;kind=$(if ($_.ExecutablePath -ieq $env:DVIEWER_TEST_EXE) {'test-app'} elseif ($_.Name -eq 'msedgewebview2.exe') {'webview2'} else {'other-child'});
        version=$version;debugPortMatches=$cmd.Contains('--remote-debugging-port=${port}');profileMatches=$cmd.Contains($env:DVIEWER_TEST_PROFILE)}
    });
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { @{pid=[int]$_.OwningProcess;loopback=($_.LocalAddress -in @('127.0.0.1','::1'))} });
    $app=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;
    $observerElevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
    @{observerElevated=$observerElevated;appPresent=($null -ne $app);hasMainWindow=($null -ne $app -and $app.MainWindowHandle -ne 0);profileExists=(Test-Path -LiteralPath $env:DVIEWER_TEST_PROFILE);processes=$rows;listeners=$listeners} | ConvertTo-Json -Depth 5 -Compress
  `, { DVIEWER_TEST_EXE: executable, DVIEWER_TEST_PROFILE: profile });
  return JSON.parse(raw);
}
async function connect(port, { health = () => {}, evidence = {} } = {}) {
  evidence.startedAt = new Date().toISOString(); evidence.attempts = 0;
  return waitFor('WebView2 app CDP target', async () => {
    evidence.attempts++; evidence.phase = 'http-discovery';
    let response;
    try { response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }); }
    catch (error) { evidence.failure = discoveryFailure(error); throw error; }
    evidence.httpStatus = response.status;
    assert.ok(response.ok, 'CDP discovery failed');
    evidence.phase = 'target-selection';
    const targets = await response.json(); evidence.targets = targetSummary(targets);
    const app = targets.find(target => target.type === 'page' && /^https?:\/\/tauri\.localhost(?:\/|$)|^tauri:\/\/localhost(?:\/|$)/.test(target.url));
    if (!app) return false;
    const address = new URL(app.webSocketDebuggerUrl);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) && Number(address.port) === port && address.protocol === 'ws:', 'CDP target must be local');
    evidence.phase = 'websocket-connect';
    const socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connect timed out')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket failed')); }, { once: true });
    });
    const cdp = new Cdp(socket);
    evidence.phase = 'enable-protocol';
    try { await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable'); evidence.phase = 'ready'; return cdp; }
    catch (error) { cdp.close(); throw error; }
  }, 60_000, 250, health);
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
  const report = { schema: 1, sourceSha: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, from, to, source: 'same candidate tree, debug version overlays', ok: false, cases: [], startups: [], stage: 'build', cleanup: false };
  const consoles = [];
  const scrub = value => sanitize(value, [out, root, process.env.USERPROFILE, process.env.APPDATA, process.env.LOCALAPPDATA, tmpdir()]);
  let server, cdp, currentStartup, reservation, cleanupStarted = false;
  function recordNative(stream, label) {
    if (!stream) return; // A failed spawn is reported by the process health check.
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
    // Reserve one loopback port while both test binaries are built with it.
    reservation = await reservePort();
    const port = reservation.port;
    const buildArgs = [join(root, 'scripts', 'test-updater-windows.mjs'), from, to];
    await run(process.execPath, buildArgs, { env: { ...process.env, DVIEWER_TEST_CDP_PORT: String(port) } }, 50 * 60_000, childProcess => own('builder', childProcess, buildArgs));
    const context = JSON.parse(readFileSync(join(out, 'context.json'), 'utf8'));
    assert.equal(context.from, from); assert.equal(context.to, to); assert.equal(context.cdpPort, port);
    for (const version of [from, to]) {
      assertTestBrowserOverlay(JSON.parse(readFileSync(join(out, `config-${version}.json`), 'utf8')), port);
    }
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
      currentStartup = null;
      report.stage = `${flavor}:prepare`;
      mkdirSync(data[0], { recursive: true });
      writeFileSync(join(data[0], 'dviewer.json'), JSON.stringify({ settings: { locale: 'en', restoreSession: true }, updates: { check: false } }));
      const directory = join(out, flavor === 'nsis' ? 'nsis-installed' : 'portable');
      mkdirSync(directory);
      const executable = join(directory, 'dviewer.exe');
      if (flavor === 'portableExe') copyFileSync(join(out, `portable-${from}.exe`), executable);
      else await run(join(out, `setup-${from}.exe`), ['/S', `/D=${directory}`], { windowsVerbatimArguments: true }, 120_000);
      assert.ok(existsSync(executable), 'isolated executable not installed at expected path');
      const temp = join(out, `${flavor}-temp`);
      mkdirSync(temp);
      const env = { ...process.env, DVIEWER_UPDATE_MANIFEST: `${origin}/latest.json`, TEMP: temp, TMP: temp,
        WEBVIEW2_USER_DATA_FOLDER: join(out, `${flavor}-webview`) };
      delete env.DVIEWER_INSTANCE;
      // The baked test overlay is the only debug-argument source, including restart.
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS') delete env[key];
      await reservation.release();
      reservation = await reservePort(port); // Fail if an unrelated listener took the port.
      await reservation.release();
      // The ONLY app launch in this flavor. After Update now, only observe.
      report.stage = `${flavor}:launch`;
      const startup = { flavor, phase: 'original', binary: executableInfo(executable), windowsHide: false,
        environment: { debugArgumentSource: 'test-config-api', loopbackDebugging: true, isolatedProfile: true, isolatedTemp: true,
          nodeEnvProxy: env.NODE_USE_ENV_PROXY === '1', proxyPresent: Object.keys(env).some(key => /^(http|https|all)_proxy$/i.test(key) && !!env[key]),
          browserOverridePresent: !!env.WEBVIEW2_BROWSER_EXECUTABLE_FOLDER,
          debugArgumentVariableCount: Object.keys(env).filter(key => key.toUpperCase() === 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS').length }, discovery: {} };
      report.startups.push(startup);
      const original = child(executable, [`--open=${file}`, `--open-url=${url}`], { env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
      startup.pid = original.pid; startup.startedAt = new Date().toISOString();
      const updateProcess = () => { if (cleanupStarted) return; startup.exitCode = original.exitCode; startup.signal = original.signalCode;
        if (original.failure) startup.spawnFailure = discoveryFailure(original.failure); };
      original.on('exit', updateProcess); original.on('error', updateProcess); updateProcess();
      recordNative(original.stdout, `${flavor}-stdout`); recordNative(original.stderr, `${flavor}-stderr`);
      currentStartup = async () => {
        updateProcess();
        try {
          const snapshot = await startupNative(original.pid, executable, env.WEBVIEW2_USER_DATA_FOLDER, port);
          (startup.observations ??= []).push({ observedAt: new Date().toISOString(), ...snapshot });
        }
        catch (error) { startup.nativeObservationError = scrub(error.message); }
      };
      await currentStartup();
      report.stage = `${flavor}:cdp-discovery`;
      cdp = await connect(port, { health: () => assertAppRunning(original), evidence: startup.discovery });
      await currentStartup();
      report.stage = `${flavor}:old-ui`;
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
      const restarted = { flavor, phase: 'replacement', pid: afterProcess.pid, discovery: {} };
      report.startups.push(restarted);
      currentStartup = async () => {
        try {
          const snapshot = await startupNative(afterProcess.pid, executable, env.WEBVIEW2_USER_DATA_FOLDER, port);
          (restarted.observations ??= []).push({ observedAt: new Date().toISOString(), ...snapshot });
        }
        catch (error) { restarted.nativeObservationError = scrub(error.message); }
      };
      await currentStartup();
      let checkedAt = 0;
      const replacementHealth = async () => {
        if (Date.now() - checkedAt < 2000) return;
        checkedAt = Date.now();
        assert.ok((await processes(executable)).some(app => app.pid === afterProcess.pid), 'Replacement app exited before CDP readiness');
      };
      report.stage = `${flavor}:replacement-cdp`;
      cdp = await connect(port, { health: replacementHealth, evidence: restarted.discovery });
      await currentStartup();
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
    await currentStartup?.();
    await capture('failure');
  } finally {
    cleanupStarted = true; // Do not misreport our cleanup termination as an app startup crash.
    try { await reservation?.release(); }
    catch (error) { report.ok = false; report.portCleanupError = scrub(error.message); }
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
