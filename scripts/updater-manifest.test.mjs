import { mkdtempSync, writeFileSync, readFileSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeManifest, prepare } from "./updater-manifest.mjs";

test("release metadata refers to the exact signed files and fails closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "dviewer-manifest-"));
  try {
    const names = ["windows-x64_setup.exe", "windows-x64.msi", "windows-x64_portable.exe",
      "macos-universal.app.tar.gz", "linux-x86_64_portable.AppImage"];
    for (const name of names) {
      const path = join(directory, `dviewer_0.14.0_${name}`);
      writeFileSync(path, "asset");
      writeFileSync(`${path}.sig`, Buffer.from("untrusted comment: fixture\nsignature").toString("base64"));
    }
    const manifest = makeManifest(directory, "v0.14.0");
    assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64-nsis", "windows-x86_64-msi",
      "windows-x86_64-portable", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"]);
    for (const asset of Object.values(manifest.platforms)) {
      const url = new URL(asset.url);
      assert.equal(url.origin, "https://github.com");
      const file = join(directory, basename(url.pathname));
      assert.equal(asset.signature, readFileSync(`${file}.sig`, "utf8"));
    }
    assert.throws(() => makeManifest(directory, "v0.14.0-beta.1"));
    const portable = join(directory, "dviewer_0.14.0_windows-x64_portable.exe");
    truncateSync(portable, 256 * 1024 * 1024 + 1);
    assert.throws(() => makeManifest(directory, "v0.14.0"), /asset size/);
    writeFileSync(portable, "asset");
    rmSync(portable);
    assert.throws(() => makeManifest(directory, "v0.14.0"), /ENOENT/);
    const config = { version: "0.14.0", plugins: { updater: { pubkey: "" } } };
    const output = join(directory, "config.json");
    prepare(config, {}, output);
    assert.equal(JSON.parse(readFileSync(output)).bundle.createUpdaterArtifacts, false);
    const env = { GITHUB_REF: "refs/tags/v0.14.0" };
    assert.throws(() => prepare(config, env, output), /public key/);
    config.plugins.updater.pubkey = "test-only";
    assert.throws(() => prepare(config, env, output), /private key/);
    prepare(config, { ...env, TAURI_SIGNING_PRIVATE_KEY: "test-only" }, output);
    assert.equal(JSON.parse(readFileSync(output)).bundle.createUpdaterArtifacts, true);
  } finally {
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("dviewer-manifest-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
