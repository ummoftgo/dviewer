import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ARTIFACT_LIMIT = 8 * 1024 * 1024;
const OMITTED_LINE = '[oversized diagnostic line omitted]\n';
const INCOMPLETE_LINE = '[incomplete diagnostic line omitted]\n';
const OUTPUT_LIMIT = '[diagnostic output limit reached]\n';
const PDFJS_CORE = ['build/pdf.mjs', 'build/pdf.worker.mjs', 'build/pdf.sandbox.mjs',
  'web/viewer.html', 'web/viewer.mjs', 'web/viewer.css', 'manifest.json'];
// Only files created by this runner or its explicitly named smoke processes.
const ARTIFACTS = ['environment.json', 'processes.json', 'child-processes.json', 'native-coverage.json',
  ...['sweep', 'handoff', 'new'].flatMap(name => [`${name}.jsonl`, `${name}.trace.jsonl`])];

/** Diagnostic exports contain metadata, never bearer URLs or process arguments. */
export function sanitizeDiagnostic(text, limit = ARTIFACT_LIMIT) {
  return String(text).replace(/https?:\/\/[^\s"'<>]+/gi, '[url]').replace(/[a-f\d]{64}/gi, '[token]').slice(0, limit);
}

/**
 * Redact only after a whole line arrives: neither a URL nor a capability is
 * safe to release one pipe chunk at a time. Buffer at most maxLineBytes, drop
 * oversized lines through their newline, and omit a truncated final line.
 * The output cap counts UTF-8 bytes and never cuts a line (or JSON record).
 */
export function createDiagnosticSanitizer({ onText = () => {}, maxBytes = 256 * 1024, maxLineBytes = 16 * 1024,
  markers = { oversized: OMITTED_LINE, incomplete: INCOMPLETE_LINE, limited: OUTPUT_LIMIT } } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new RangeError('invalid diagnostic retention limit');
  }
  let parts = [], pendingBytes = 0, dropping = false, ended = false, capped = false;
  const retention = { bytes: 0, limitBytes: maxBytes, lineLimitBytes: maxLineBytes, oversizedLines: 0, incompleteLines: 0, outputLimited: false };
  function emit(text) {
    if (capped) return;
    const bytes = Buffer.byteLength(text);
    if (retention.bytes + bytes > maxBytes) {
      retention.outputLimited = true;
      capped = true;
      if (retention.bytes + Buffer.byteLength(markers.limited) <= maxBytes) {
        retention.bytes += Buffer.byteLength(markers.limited);
        onText(markers.limited);
      }
      return;
    }
    retention.bytes += bytes;
    onText(text);
  }
  function append(piece) {
    if (dropping || capped) return;
    if (pendingBytes + piece.length > maxLineBytes) {
      parts = [];
      pendingBytes = 0;
      dropping = true;
      retention.oversizedLines++;
    } else if (piece.length) {
      // Copy the bounded fragment rather than retaining a possibly huge chunk.
      parts.push(Buffer.from(piece));
      pendingBytes += piece.length;
    }
  }
  return {
    write(chunk) {
      if (ended) throw new Error('diagnostic stream already ended');
      if (capped) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      let start = 0;
      for (let newline = buffer.indexOf(10, start); newline !== -1; newline = buffer.indexOf(10, start)) {
        append(buffer.subarray(start, newline));
        if (dropping) emit(markers.oversized);
        else emit(sanitizeDiagnostic(Buffer.concat(parts, pendingBytes).toString('utf8')) + '\n');
        parts = [];
        pendingBytes = 0;
        dropping = false;
        start = newline + 1;
        if (capped) return;
      }
      append(buffer.subarray(start));
    },
    end() {
      if (!ended) {
        if (dropping) emit(markers.oversized);
        else if (pendingBytes) {
          retention.incompleteLines++;
          emit(markers.incomplete);
        }
        parts = [];
        pendingBytes = 0;
        ended = true;
      }
      return { ...retention };
    },
  };
}

export function descendantProcesses(text, root) {
  const rows = text.trim().split('\n').map(line => {
    const [pid, ppid, rss, ...name] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), rssKiB: Number(rss), name: sanitizeDiagnostic(name.join(' ').split(/[\\/]/).at(-1), 64) };
  }).filter(row => Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.ppid) && row.ppid >= 0 && Number.isFinite(row.rssKiB) && row.rssKiB >= 0);
  const included = new Set([root]);
  for (let depth = 0; depth < 8; depth++) for (const row of rows) if (included.has(row.ppid)) included.add(row.pid);
  return rows.filter(row => included.has(row.pid)).slice(0, 32);
}

/** Coverage is observation of starts, never proof of successful delivery. */
export function nativeCoverage(text) {
  const events = text.split('\n').filter(Boolean).flatMap(line => {
    try {
      const event = JSON.parse(line);
      return event && typeof event === 'object' && !Array.isArray(event) ? [event] : [];
    } catch { return []; }
  });
  const paths = new Set(events.filter(event => event.kind === 'native-resource' && event.event === 'resource-load-started').map(event => event.path));
  return { ready: events.some(event => event.kind === 'native-hook' && event.state === 'ready'),
    html: paths.has('/_/agent.js'), pdfViewer: paths.has('/_/pdfjs/web/viewer.html'), pdfModule: paths.has('/_/pdfjs/build/pdf.mjs') };
}

/** Hash even large app binaries with a fixed-size stream, never readFile. */
export async function fileFingerprint(file) {
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
      bytes += chunk.length;
      digest.update(chunk);
    }
    return { sha256: digest.digest('hex'), bytes };
  } catch { return { sha256: null, bytes: null }; }
}

async function readPrefix(file, limit = 64 * 1024) {
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch { return ''; }
  finally { await handle?.close(); }
}

export async function pdfjsFingerprint(root) {
  const prepared = {};
  for (const file of PDFJS_CORE) prepared[file] = await fileFingerprint(path.join(root, 'dist', 'pdfjs', file));
  const header = await readPrefix(path.join(root, 'dist', 'pdfjs/build/pdf.mjs'));
  const version = header.match(/\bpdfjsVersion\s*=\s*["']?([\d]+\.[\d]+\.[\d]+)\b/)?.[1] ?? null;
  // These are source pins, not a claim about the version embedded in the app.
  const source = await readPrefix(path.join(root, 'scripts/prepare-pdfjs.mjs'));
  const pinnedVersion = source.match(/^const version = ['"]([\d]+\.[\d]+\.[\d]+)['"];?$/m)?.[1] ?? null;
  const expectedSha256 = source.match(/^const sha256 = ['"]([a-f\d]{64})['"];?$/im)?.[1]?.toLowerCase() ?? null;
  const cached = pinnedVersion ? await fileFingerprint(path.join(root, '.agent-works', `pdfjs-${pinnedVersion}`, 'dist.zip')) : { sha256: null, bytes: null };
  return { version, prepared, archive: { pinnedVersion, expectedSha256, actualSha256: cached.sha256, bytes: cached.bytes,
    matchesPin: expectedSha256 && cached.sha256 ? expectedSha256 === cached.sha256 : null } };
}

/** Preserve only known digest fields; arbitrary strings still lose 64-hex secrets. */
export function sanitizeEnvironment(environment) {
  function visit(value, keys = []) {
    if (typeof value === 'string') {
      const digestField = keys.join('.') === 'binarySha256' ||
        (keys.length === 4 && keys[0] === 'pdfjs' && keys[1] === 'prepared' && PDFJS_CORE.includes(keys[2]) && keys[3] === 'sha256') ||
        (keys.length === 3 && keys[0] === 'pdfjs' && keys[1] === 'archive' && ['expectedSha256', 'actualSha256'].includes(keys[2]));
      return digestField && /^[a-f\d]{64}$/i.test(value) ? value : sanitizeDiagnostic(value);
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...keys, String(index)]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitizeDiagnostic(key), visit(item, [...keys, key])]));
    return value;
  }
  return visit(environment);
}

/** Explicit output allowlist, no fixture-directory scan and no symlink inputs. */
export async function exportDiagnosticArtifacts(work, destination) {
  await mkdir(destination, { recursive: true });
  const exported = [];
  for (const name of ARTIFACTS) {
    const source = path.join(work, name);
    const stat = await lstat(source).catch(() => null);
    if (!stat?.isFile()) continue;
    let clean;
    if (name.endsWith('.jsonl')) {
      const chunks = [];
      const sanitizer = createDiagnosticSanitizer({ onText: text => chunks.push(text), maxBytes: ARTIFACT_LIMIT, maxLineBytes: 80 * 1024,
        markers: Object.fromEntries(['oversized', 'incomplete', 'limited'].map(reason => [reason, JSON.stringify({ kind: 'export-retention', reason }) + '\n'])) });
      // The Rust writer is capped too; stop reading on the export cap rather
      // than scanning an unexpectedly large file forever.
      for await (const chunk of createReadStream(source, { highWaterMark: 64 * 1024, end: ARTIFACT_LIMIT - 1 })) sanitizer.write(chunk);
      sanitizer.end();
      clean = chunks.join('');
    } else {
      if (stat.size > ARTIFACT_LIMIT) continue;
      const text = await readFile(source, 'utf8');
      clean = name === 'environment.json' ? JSON.stringify(sanitizeEnvironment(JSON.parse(text)), null, 2) : sanitizeDiagnostic(text);
    }
    const target = path.join(destination, name);
    const targetStat = await lstat(target).catch(() => null);
    if (targetStat && !targetStat.isFile()) throw new Error(`refusing non-regular diagnostic artifact: ${name}`);
    await writeFile(target, clean);
    exported.push(name);
  }
  return exported;
}
