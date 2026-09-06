// No key material is committed or printed; this pair belongs to this test only.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "dviewer-signature-"));
const file = join(directory, "payload.exe");
const key = join(directory, "test.key");
const cli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js");
function signer(args) {
  const result = spawnSync(process.execPath, [cli, "signer", ...args], { cwd: root, encoding: "utf8" });
  // CLI output can include key material. Never put it in an assertion message.
  assert.equal(result.status, 0, "Tauri signer failed");
}
function verify() {
  return spawnSync("cargo", ["run", "--offline", "--manifest-path", "src-tauri/Cargo.toml",
    "--example", "update", "--", file, `${key}.pub`, `${file}.sig`], { cwd: root, encoding: "utf8" });
}
try {
  writeFileSync(file, "Tauri signature compatibility\n", { flag: "wx" });
  signer(["generate", "--ci", "-w", key, "-p", ""]);
  signer(["sign", "-f", key, "-p", "", file]);
  const valid = verify();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /verified 30 bytes/);
  writeFileSync(file, "Tampered signature payload\n");
  const invalid = verify();
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /UpdateBadSignature/);
  console.log("Tauri signer compatibility: valid accepted, tampered rejected (2 checks).");
} finally {
  assert.equal(dirname(directory), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("dviewer-signature-"));
  rmSync(directory, { recursive: true, force: true });
}
