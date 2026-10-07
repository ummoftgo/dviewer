import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';

const run = promisify(execFile);

// Independently validate PNG framing, checksums and decoded RGB scanlines.
// This checks more than the signature: truncated/corrupt IDAT also fails here.
function decodeRgbPng(png) {
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert.ok(end <= png.length, 'PNG chunk is truncated');
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff;
    for (const byte of png.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, png.readUInt32BE(end - 4), `${type} checksum`);
    chunks.push({ type, data });
    offset = end;
  }
  assert.deepEqual(chunks.map(chunk => chunk.type), ['IHDR', 'IDAT', 'IEND']);
  const header = chunks[0].data;
  assert.equal(header.length, 13);
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  assert.deepEqual([...header.subarray(8)], [8, 2, 0, 0, 0], '8-bit, non-interlaced RGB');
  const rows = inflateSync(chunks[1].data);
  assert.equal(rows.length, height * (1 + 3 * width));
  for (let y = 0; y < height; y++) assert.equal(rows[y * (1 + 3 * width)], 0, 'unfiltered scanline');
  return { width, height, rows };
}

test('a clean fixture generation supplies the local image used by native Markdown zoom', async context => {
  // Never use the repository fixtures/: stale hand-created files hid the bug.
  const cwd = await mkdtemp(path.join(tmpdir(), 'dviewer-fixture-images-'));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const generator = fileURLToPath(new URL('./gen-fixtures.mjs', import.meta.url));
  await run(process.execPath, [generator], { cwd, timeout: 60_000 });
  const fixtures = path.join(cwd, 'fixtures');
  const markdown = await readFile(path.join(fixtures, 'sample.md'), 'utf8');
  assert.match(markdown, /!\[[^\]]*\]\(\.\/icon\.png\)/, 'sample must exercise a local raster');
  const png = decodeRgbPng(await readFile(path.join(fixtures, 'icon.png')));
  assert.deepEqual({ width: png.width, height: png.height }, { width: 96, height: 64 });
  // Preserve the contrasting colors used to visually check native scaling.
  const colors = new Set();
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const pixel = y * (1 + 3 * png.width) + 1 + x * 3;
      colors.add([...png.rows.subarray(pixel, pixel + 3)].join(','));
    }
  }
  assert.deepEqual([...colors].sort(), ['30,40,60', '56,132,216', '247,185,71'].sort());
  assert.match(markdown, /!\[[^\]]*\]\(\.\/does-not-exist\.png\)/);
  await assert.rejects(readFile(path.join(fixtures, 'does-not-exist.png')), { code: 'ENOENT' },
    'the intentionally broken image must stay broken');
  const plan = JSON.parse(await readFile(path.join(fixtures, 'smoke.json'), 'utf8'));
  assert.ok(plan.some(step => step.file === 'sample.md' && step.expect === 'prose'));
});
