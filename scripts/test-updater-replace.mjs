import { copyFileSync, appendFileSync, mkdtempSync, rmSync, statSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

if (process.platform !== "win32") {
  console.log("Not run: executable replacement is Windows-only.");
  process.exit(0);
}
const root = resolve(import.meta.dirname, "..");
const build = spawnSync("cargo", ["build", "--offline", "--manifest-path", "src-tauri/Cargo.toml",
  "--example", "update_replace"], { cwd: root, encoding: "utf8" });
assert.equal(build.status, 0, build.stderr);
const directory = mkdtempSync(join(tmpdir(), "dviewer-replace-"));
const current = join(directory, "current.exe");
const next = join(directory, "next.exe");
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
try {
  copyFileSync(join(root, "src-tauri/target/debug/examples/update_replace.exe"), current);
  copyFileSync(current, next);
  appendFileSync(next, "M22 replacement\n");
  assert.notEqual(await hash(current), await hash(next));
  const before = await hash(current);
  const failed = spawnSync(current, ["replace", join(directory, "missing.exe")], { encoding: "utf8" });
  assert.notEqual(failed.status, 0);
  assert.equal(await hash(current), before, "failed replacement must preserve the old executable");
  const replace = spawnSync(current, ["replace", next], { encoding: "utf8" });
  assert.equal(replace.status, 0, replace.stderr);
  assert.equal(await hash(current), await hash(next));
  const restart = spawnSync(current, ["report"], { encoding: "utf8" });
  assert.equal(restart.status, 0, restart.stderr);
  assert.equal(restart.stdout.trim(), `running ${statSync(next).size} bytes`);
  console.log("Portable replacement: copied running executable replaced, hash matched, new executable started.");
} finally {
  assert.equal(dirname(directory), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("dviewer-replace-"));
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
