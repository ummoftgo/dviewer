import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

export function prepare(config, env, output) {
  const release = (env.GITHUB_REF ?? "").startsWith("refs/tags/v");
  if (release) {
    assert.equal(env.GITHUB_REF, `refs/tags/v${config.version}`, "tag and app version differ");
    assert.ok(config.plugins?.updater?.pubkey?.trim(), "release updater public key is missing");
    assert.ok(env.TAURI_SIGNING_PRIVATE_KEY?.trim(), "release signing private key is missing");
  }
  writeFileSync(output, JSON.stringify({ bundle: { createUpdaterArtifacts: release } }));
}

export function makeManifest(directory, tag) {
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "stable version tag required");
  const version = tag.slice(1);
  const prefix = `dviewer_${version}_`;
  const assets = [
    ["windows-x86_64-nsis", "windows-x64_setup.exe"],
    ["windows-x86_64-msi", "windows-x64.msi"],
    ["windows-x86_64-portable", "windows-x64_portable.exe"],
    ["darwin-aarch64", "macos-universal.app.tar.gz"],
    ["darwin-x86_64", "macos-universal.app.tar.gz"],
    ["linux-x86_64", "linux-x86_64_portable.AppImage"],
  ];
  const platforms = {};
  for (const [platform, suffix] of assets) {
    const name = prefix + suffix;
    const file = join(directory, name);
    const stat = statSync(file);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 256 * 1024 * 1024, `invalid asset size: ${name}`);
    assert.ok(statSync(`${file}.sig`).size <= 16 * 1024, `signature too large: ${name}`);
    const signature = readFileSync(`${file}.sig`, "utf8").trim();
    assert.match(signature, /^[A-Za-z0-9+/]+={0,2}$/, `invalid signature encoding: ${name}`);
    assert.ok(Buffer.from(signature, "base64").toString("utf8").startsWith("untrusted comment:"), `invalid signature format: ${name}`);
    platforms[platform] = {
      signature,
      url: `https://github.com/ummoftgo/dviewer/releases/download/${tag}/${name}`,
    };
  }
  return { version, notes: "", pub_date: new Date().toISOString(), platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--prepare") {
    prepare(JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")), process.env, process.argv[3]);
  } else {
    const directory = process.argv[2];
    const manifest = makeManifest(directory, process.argv[3]);
    const bytes = JSON.stringify(manifest, null, 2) + "\n";
    assert.ok(Buffer.byteLength(bytes) <= 64 * 1024, "manifest too large");
    writeFileSync(join(directory, "latest.json"), bytes);
    console.log(`Manifest references verified: ${Object.keys(manifest.platforms).length} platforms.`);
  }
}
