import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeDiagnostic, createDiagnosticSanitizer, descendantProcesses, nativeCoverage,
  fileFingerprint, pdfjsFingerprint, sanitizeEnvironment, exportDiagnosticArtifacts } from './smoke-diagnostics.mjs';

const token = 'ab'.repeat(32);
const url = `http://127.0.0.1:123/${token}/?g=1`;
const digest = text => createHash('sha256').update(text).digest('hex');
function stream(chunks, options) {
  let output = '';
  const sanitizer = createDiagnosticSanitizer({ ...options, onText: clean => { output += clean; } });
  for (const chunk of chunks) sanitizer.write(chunk);
  const retention = sanitizer.end();
  assert.deepEqual(sanitizer.end(), retention, 'flushing twice is harmless');
  return { output, retention };
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'smoke-diagnostics-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('exports redact URLs and bearer tokens while preserving resource observations', () => {
  assert.equal(sanitizeDiagnostic(`${url} ${token} /_/pdfjs/build/pdf.mjs`), '[url] [token] /_/pdfjs/build/pdf.mjs');
  assert.equal(sanitizeDiagnostic('abcdefgh', 4), 'abcd');
});

test('streaming redacts complete URLs and tokens at every byte split, including UTF-8', () => {
  const input = Buffer.from(`한글😀 ${url} ${token}\r\nnext HTTPS://example.test/private?q=1\n`);
  const expected = '한글😀 [url] [token]\r\nnext [url]\n';
  for (let split = 0; split <= input.length; split++) {
    assert.equal(stream([input.subarray(0, split), input.subarray(split)]).output, expected, `split ${split}`);
  }
  assert.equal(stream([...input].map(byte => Buffer.from([byte]))).output, expected);
});

test('streaming emits nothing until newline, and drops every possible truncated secret prefix on flush', () => {
  let output = '';
  const sanitizer = createDiagnosticSanitizer({ onText: value => { output += value; } });
  sanitizer.write(`prefix ${token.slice(0, 31)}`);
  assert.equal(output, '');
  sanitizer.write(`${token.slice(31)}\n`);
  assert.equal(output, 'prefix [token]\n');
  sanitizer.end();
  assert.throws(() => sanitizer.write('late\n'), /already ended/);
  for (const secret of [token, url]) {
    for (let cut = 1; cut <= secret.length; cut++) {
      const { output, retention } = stream(['safe\n', secret.slice(0, cut)]);
      assert.equal(output, 'safe\n[incomplete diagnostic line omitted]\n', `truncated at ${cut}`);
      assert.equal(retention.incompleteLines, 1);
    }
  }
  assert.equal(stream([]).output, '');
});

test('oversized lines are discarded in full across chunk boundaries and at EOF', () => {
  const line = `private ${url} ${'x'.repeat(100)}\n`;
  for (let split = 0; split <= line.length; split++) {
    const result = stream([line.slice(0, split), line.slice(split), 'safe\n'], { maxLineBytes: 32 });
    assert.equal(result.output, '[oversized diagnostic line omitted]\nsafe\n');
    assert.equal(result.retention.oversizedLines, 1);
  }
  assert.equal(stream([line.slice(0, -1)], { maxLineBytes: 32 }).output, '[oversized diagnostic line omitted]\n');
  assert.equal(stream(['abcd\n'], { maxLineBytes: 4 }).output, 'abcd\n');
});

test('output retention is UTF-8 byte bounded without retaining line or secret prefixes', () => {
  const result = stream(['한글\n', 'x'.repeat(100) + '\n', token + '\n'], { maxBytes: 50 });
  assert.equal(result.output, '한글\n[diagnostic output limit reached]\n');
  assert.equal(result.retention.bytes, Buffer.byteLength(result.output));
  assert.equal(result.retention.outputLimited, true);
  assert.ok(result.retention.bytes <= 50);
  assert.equal(stream(['abc\n'], { maxBytes: 2 }).output, '');
  assert.equal(stream([token + '\n'], { maxBytes: 0 }).output, '');
  assert.throws(() => stream([], { maxLineBytes: 0 }), RangeError);
});

test('child metadata is bounded and includes WebKit processes without full executable paths or arguments', () => {
  const input = '1 0 200 init\n2 1 400 /private/user/dviewer\n3 2 500 /usr/lib/WebKitWebProcess\n4 3 600 WebKitNetworkProcess\n5 1 10 other\ninvalid\n-1 2 20 bad';
  assert.deepEqual(descendantProcesses(input, 2).map(r => r.name), ['dviewer', 'WebKitWebProcess', 'WebKitNetworkProcess']);
  assert.equal(descendantProcesses(Array.from({ length: 50 }, (_, i) => `${i + 2} 1 1 process`).join('\n'), 1).length, 32);
  assert.equal(descendantProcesses(`2 1 4 ${token}`, 1)[0].name, '[token]');
});

test('native coverage only reports observed starts and readiness, never request success', () => {
  const starts = ['/_/agent.js', '/_/pdfjs/web/viewer.html', '/_/pdfjs/build/pdf.mjs'].map((resource, id) =>
    ({ kind: 'native-resource', event: 'resource-load-started', path: resource, id, routeScope: 1 }));
  const rows = [{ kind: 'native-hook', state: 'ready' }, ...starts];
  const expected = { ready: true, html: true, pdfViewer: true, pdfModule: true };
  assert.deepEqual(nativeCoverage(rows.map(JSON.stringify).join('\n')), expected);
  const failedAndFinished = [...rows, ...starts.flatMap(row => [
    { ...row, event: 'failed', errorDomain: 'webkit-network', errorCode: 302 },
    { ...row, event: 'finished', failedBeforeFinish: true },
  ])];
  assert.deepEqual(nativeCoverage(failedAndFinished.map(JSON.stringify).join('\n')), expected);
  // A finished signal after failure is not a successful fetch, nor does it
  // invent a missing start. Result rows cannot stand in for native evidence.
  const withoutStarts = failedAndFinished.filter(row => row.event !== 'resource-load-started');
  withoutStarts.push({ ok: true, pdfViewer: true, event: 'resource-load-started', path: '/_/pdfjs/web/viewer.html' });
  assert.deepEqual(nativeCoverage(withoutStarts.map(JSON.stringify).join('\n')), { ...expected, html: false, pdfViewer: false, pdfModule: false });
  assert.deepEqual(nativeCoverage('null\n42\n[]\n{broken\n'), { ready: false, html: false, pdfViewer: false, pdfModule: false });
});

test('fingerprints stream file contents, record observed prepared version, and distinguish archive pins', async t => {
  const root = await temporary(t);
  const binary = Buffer.alloc(2 * 1024 * 1024 + 1, 37);
  await writeFile(path.join(root, 'binary'), binary);
  assert.deepEqual(await fileFingerprint(path.join(root, 'binary')), { sha256: digest(binary), bytes: binary.length });
  assert.deepEqual(await fileFingerprint(path.join(root, 'missing')), { sha256: null, bytes: null });
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'dist/pdfjs/build'), { recursive: true });
  await mkdir(path.join(root, '.agent-works/pdfjs-6.3.289'), { recursive: true });
  const pdf = '/* pdfjsVersion = 6.3.288 */\nexport {};\n';
  await writeFile(path.join(root, 'dist/pdfjs/build/pdf.mjs'), pdf);
  await writeFile(path.join(root, '.agent-works/pdfjs-6.3.289/dist.zip'), 'observed archive');
  await writeFile(path.join(root, 'scripts/prepare-pdfjs.mjs'), `const version = '6.3.289';\nconst sha256 = '${digest('different archive')}';\n`);
  const fingerprint = await pdfjsFingerprint(root);
  assert.equal(fingerprint.version, '6.3.288');
  assert.equal(fingerprint.archive.pinnedVersion, '6.3.289');
  assert.equal(fingerprint.archive.actualSha256, digest('observed archive'));
  assert.equal(fingerprint.archive.matchesPin, false);
  assert.deepEqual(fingerprint.prepared['build/pdf.mjs'], { sha256: digest(pdf), bytes: Buffer.byteLength(pdf) });
  assert.deepEqual(fingerprint.prepared['web/viewer.html'], { sha256: null, bytes: null });
});

test('environment retains only designated valid digest fields through artifact export', async t => {
  const root = await temporary(t);
  const work = path.join(root, 'work'), destination = path.join(root, 'export');
  await mkdir(work);
  const environment = { binarySha256: token, unexpected: token, binary: url, sha256: token,
    pdfjs: { prepared: { 'build/pdf.mjs': { sha256: token }, 'unknown/file': { sha256: token } },
      archive: { expectedSha256: token, actualSha256: token, unexpected: token } } };
  const clean = sanitizeEnvironment(environment);
  assert.equal(clean.binarySha256, token);
  assert.equal(clean.binary, '[url]');
  assert.equal(clean.unexpected, '[token]');
  assert.equal(clean.sha256, '[token]');
  assert.equal(clean.pdfjs.prepared['build/pdf.mjs'].sha256, token);
  assert.equal(clean.pdfjs.prepared['unknown/file'].sha256, '[token]');
  assert.equal(clean.pdfjs.archive.expectedSha256, token);
  assert.equal(clean.pdfjs.archive.unexpected, '[token]');
  assert.equal(sanitizeEnvironment({ binarySha256: url }).binarySha256, '[url]');
  await writeFile(path.join(work, 'environment.json'), JSON.stringify(environment));
  await writeFile(path.join(work, 'processes.json'), JSON.stringify([{ stdout: `safe ${url}\n`, stderr: token }]));
  await writeFile(path.join(work, 'sweep.trace.jsonl'), JSON.stringify({ path: '/_/pdfjs/build/pdf.mjs', url }) + '\n' + `{"truncated":"${token.slice(0, 30)}`);
  await writeFile(path.join(work, 'private.json'), 'never export');
  await writeFile(path.join(work, 'sample.pdf'), 'fixture body');
  assert.deepEqual(await exportDiagnosticArtifacts(work, destination), ['environment.json', 'processes.json', 'sweep.trace.jsonl']);
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'environment.json'), 'utf8')), clean);
  const processes = await readFile(path.join(destination, 'processes.json'), 'utf8');
  assert.ok(!processes.includes(token));
  assert.ok(!processes.includes('127.0.0.1'));
  const trace = (await readFile(path.join(destination, 'sweep.trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(trace[0].url, '[url]');
  assert.deepEqual(trace[1], { kind: 'export-retention', reason: 'incomplete' });
  assert.deepEqual((await readdir(destination)).sort(), ['environment.json', 'processes.json', 'sweep.trace.jsonl']);
});

test('export skips source symlinks and refuses non-regular destination files', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t);
  const work = path.join(root, 'work'), destination = path.join(root, 'export');
  await mkdir(work); await mkdir(destination);
  const privateFile = path.join(root, 'private');
  await writeFile(privateFile, 'private');
  await symlink(privateFile, path.join(work, 'sweep.jsonl'));
  assert.deepEqual(await exportDiagnosticArtifacts(work, destination), []);
  await writeFile(path.join(work, 'processes.json'), '[]');
  await symlink(privateFile, path.join(destination, 'processes.json'));
  await assert.rejects(exportDiagnosticArtifacts(work, destination), /non-regular/);
  assert.equal(await readFile(privateFile, 'utf8'), 'private');
});

test('runner retains sanitized stdout and stderr plus artifacts after malformed results', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t);
  await mkdir(path.join(root, 'fixtures'));
  await writeFile(path.join(root, 'fixtures/smoke.json'), '[]');
  const executable = path.join(root, 'fake-viewer');
  await writeFile(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nconst out = process.argv.find(arg => arg.startsWith('--smoke-out='))?.slice(12);\nprocess.stdout.write('prefix http://127.0.0.1:123/');\nprocess.stderr.write('${token.slice(0, 32)}');\nsetTimeout(() => { process.stdout.write('${token}/\\n'); process.stderr.write('${token.slice(32)}\\n'); writeFileSync(out, '{malformed\\n'); }, 5);\n`);
  await chmod(executable, 0o755);
  // Node's entry-point type detection is not part of this test.
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const artifacts = path.join(root, 'artifacts');
  const script = fileURLToPath(new URL('./smoke.mjs', import.meta.url));
  let output;
  try {
    await promisify(execFile)(process.execPath, [script], { cwd: root, env: { ...process.env, DVIEWER_EXE: executable, DVIEWER_SMOKE_ARTIFACT_DIR: artifacts }, timeout: 15000 });
    assert.fail('malformed results must fail');
  } catch (error) {
    assert.equal(error.code, 1);
    output = error.stdout + error.stderr;
  }
  assert.ok(!output.includes(token));
  assert.ok(!output.includes('127.0.0.1'));
  const processes = JSON.parse(await readFile(path.join(artifacts, 'processes.json'), 'utf8'));
  assert.equal(processes[0].stdout, 'prefix [url]\n');
  assert.equal(processes[0].stderr, '[token]\n');
  assert.equal(processes[0].stdoutRetention.incompleteLines, 0);
  assert.ok(processes[0].finishedAt);
  assert.ok(!('args' in processes[0]));
  const environment = JSON.parse(await readFile(path.join(artifacts, 'environment.json'), 'utf8'));
  assert.equal(environment.binarySha256, (await fileFingerprint(executable)).sha256);
  assert.ok('libsoup' in environment);
  const retained = output.match(/결과: (.+)/)?.[1]?.trim();
  assert.ok(retained, 'failed work directory must be retained');
  assert.ok((await readdir(retained)).includes('processes.json'));
  await rm(retained, { recursive: true, force: true });
});
