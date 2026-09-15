// The viewer is absent from npm's pdfjs-dist. Use Mozilla's immutable release.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const version = '6.3.289';
const sha256 = '98c5832ffe7af4edd59853476a478c0d4d4d76dd49c1701f4c86f7182725cdf9';
const root = path.resolve(import.meta.dirname, '..');
const cache = path.join(root, '.agent-works', `pdfjs-${version}`);
const archive = path.join(cache, 'dist.zip');
const extracted = path.join(cache, 'extracted');
const out = path.join(root, 'dist', 'pdfjs');
await mkdir(extracted, { recursive: true });
let bytes;
try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!bytes) {
  const response = await fetch(`https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-dist.zip`);
  if (!response.ok) throw new Error(`PDF.js download: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('PDF.js SHA-256 mismatch');
await writeFile(archive, bytes);
// Native ZIP tools; only the hash-verified release is ever extracted.
if (process.platform === 'win32') execFileSync('tar', ['-xf', archive, '-C', extracted]);
else execFileSync('unzip', ['-oq', archive, '-d', extracted]);
const locales = ['en-US', 'ko', 'ja', 'zh-CN'];
const exact = new Set(['LICENSE', 'build/pdf.mjs', 'build/pdf.worker.mjs', 'build/pdf.sandbox.mjs',
  'web/viewer.html', 'web/viewer.mjs', 'web/viewer.css', ...locales.map(lang => `web/locale/${lang}/viewer.ftl`)]);
let total = 0, count = 0;
const manifest = [];
async function copy(directory = '') {
  for (const entry of await readdir(path.join(extracted, directory), { withFileTypes: true })) {
    const name = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { await copy(name); continue; }
    if (!exact.has(name) && !/^web\/(images|cmaps|standard_fonts|wasm|iccs)\//.test(name)) continue;
    let data = await readFile(path.join(extracted, name));
    if (name === 'web/viewer.html') {
      const html = data.toString();
      const metas = html.match(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/g);
      if (metas?.length !== 1) throw new Error('PDF.js viewer CSP changed');
      data = Buffer.from(html.replace(metas[0], ''));
    }
    const target = path.join(out, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    manifest.push(`pdfjs/${name}`);
    total += data.length; count++;
  }
}
await copy();
const localeData = JSON.stringify(Object.fromEntries(locales.map(lang => [lang.toLowerCase(), `${lang}/viewer.ftl`])));
await writeFile(path.join(out, 'web/locale/locale.json'), localeData);
manifest.push('pdfjs/web/locale/locale.json');
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest));
console.log(`PDF.js ${version}: ${count + 1} files, ${total + Buffer.byteLength(localeData)} bytes`);
