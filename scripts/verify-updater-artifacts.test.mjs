// Real Tauri signatures, ephemeral test keys, and official minisign verification.
// No signing key material is committed, printed, or read from the environment.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { makeManifest } from "./updater-manifest.mjs";
import { readProvenance, verifyArtifacts, verifySignature } from "./verify-updater-artifacts.mjs";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "node_modules/@tauri-apps/cli/tauri.js");
const minisign = resolve(process.env.DVIEWER_MINISIGN ?? "/usr/bin/minisign");
const providedAppVerifier = process.env.DVIEWER_APP_VERIFIER ? resolve(process.env.DVIEWER_APP_VERIFIER) : undefined;
const version = "1.2.3", tag = `v${version}`, prefix = `dviewer_${version}_`;
// Keep the independently specified release contract visible in the tests.
const inventory = {
  "linux-x86_64": {
    signed: [["linux-x86_64_portable.AppImage", ["linux-x86_64"]]],
    unsigned: ["linux-x86_64.deb", "linux-x86_64.rpm"],
  },
  "macos-universal": {
    signed: [["macos-universal.app.tar.gz", ["darwin-aarch64", "darwin-x86_64"]]],
    unsigned: ["macos-universal.dmg", "macos-universal_portable.zip"],
  },
  "windows-x64": {
    signed: [["windows-x64_setup.exe", ["windows-x86_64-nsis"]],
      ["windows-x64.msi", ["windows-x86_64-msi"]],
      ["windows-x64_portable.exe", ["windows-x86_64-portable"]]],
    unsigned: ["windows-x64_portable.zip"],
  },
};
const configFiles = ["src-tauri/tauri.conf.json", "package.json", "package-lock.json",
  "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
const sha256 = value => createHash("sha256").update(value).digest("hex");
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const provenance = (overrides = {}) => {
  const value = { repository: "ummoftgo/dviewer", source_sha: "a".repeat(40),
    workflow_sha: "b".repeat(40), event_sha: "c".repeat(40), run_id: "1001", run_attempt: "1",
    event_name: "push", ref: `refs/tags/${tag}`, ...overrides };
  return { ...value, run_url: `https://github.com/${value.repository}/actions/runs/${value.run_id}`,
    workflow_ref: `${value.repository}/.github/workflows/build.yml@${value.ref}` };
};
let temporary, baseline, key, publicKey, wrongPublicKey, appVerifier, nextCase = 0;

function signer(args) {
  // The CLI may print keys. Discard both streams, including on failure.
  const env = {};
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "HOME", "USERPROFILE",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const result = spawnSync(process.execPath, [cli, "signer", ...args], {
    cwd: root, stdio: "ignore", timeout: 60_000, env,
  });
  assert.equal(result.status, 0, "ephemeral Tauri signer failed");
}
const sign = path => signer(["sign", "-f", key, "-p", "", path]);
function options(directory) {
  return { repo: join(directory, "repo"), directory: join(directory, "release"), mode: "release",
    verifier: providedAppVerifier ? { kind: "dviewer", path: providedAppVerifier }
      : { kind: "minisign", path: minisign }, provenance: provenance(),
    sourceReportsDirectory: join(directory, "source-reports"), sourceRunId: "1001" };
}
function fixture() {
  const directory = join(temporary, `case-${++nextCase}`);
  cpSync(baseline, directory, { recursive: true });
  return { root: directory, ...options(directory) };
}
function bundleOptions(fixture, slug = "linux-x86_64") {
  return { ...fixture, mode: "bundle", slug, directory: join(fixture.root, "bundles", slug),
    verifier: { kind: "dviewer", path: appVerifier } };
}
function editManifest(fixture, edit) {
  const path = join(fixture.directory, "latest.json"), manifest = readJson(path);
  edit(manifest);
  writeJson(path, manifest);
  sign(path);
}
function editSource(fixture, edit, slug = "linux-x86_64") {
  const path = join(fixture.sourceReportsDirectory, `bundle-${slug}.json`), report = readJson(path);
  edit(report);
  writeJson(path, report);
}

before(async () => {
  assert.ok(existsSync(providedAppVerifier ?? minisign),
    "set DVIEWER_APP_VERIFIER to the compiled update example, or install official minisign and set DVIEWER_MINISIGN");
  temporary = mkdtempSync(join(tmpdir(), "dviewer-artifact-tests-"));
  baseline = join(temporary, "baseline");
  key = join(temporary, "test.key");
  signer(["generate", "--ci", "-w", key, "-p", ""]);
  const wrongKey = join(temporary, "wrong-test.key");
  signer(["generate", "--ci", "-w", wrongKey, "-p", ""]);
  publicKey = readFileSync(`${key}.pub`, "utf8").trim();
  wrongPublicKey = readFileSync(`${wrongKey}.pub`, "utf8").trim();

  // Exercise dviewer's three positional arguments without a cargo build. This
  // test-only adapter decodes the envelopes and delegates ALL crypto to minisign.
  appVerifier = providedAppVerifier ?? join(temporary, "test-app-verifier.mjs");
  if (!providedAppVerifier) {
    writeFileSync(appVerifier, `#!${process.execPath}\n` + `
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const [payload, key, signature] = process.argv.slice(2);
const directory = mkdtempSync(join(${JSON.stringify(temporary)}, "adapter-"));
let status = 1;
try {
  const decodedKey = join(directory, "public.key"), decodedSignature = join(directory, "payload.sig");
  writeFileSync(decodedKey, Buffer.from(readFileSync(key, "utf8").trim(), "base64"));
  writeFileSync(decodedSignature, Buffer.from(readFileSync(signature, "utf8").trim(), "base64"));
  status = spawnSync(${JSON.stringify(minisign)}, ["-V", "-H", "-q", "-p", decodedKey,
    "-x", decodedSignature, "-m", payload], { stdio: "ignore" }).status ?? 1;
} finally { rmSync(directory, { recursive: true, force: true }); }
process.exitCode = status;
`);
    chmodSync(appVerifier, 0o700);
  }
  const config = options(baseline);
  mkdirSync(join(config.repo, "src-tauri"), { recursive: true });
  mkdirSync(config.directory, { recursive: true });
  mkdirSync(config.sourceReportsDirectory, { recursive: true });
  writeJson(join(config.repo, configFiles[0]), { version, plugins: { updater: { pubkey: publicKey } } });
  writeJson(join(config.repo, configFiles[1]), { name: "dviewer", version });
  writeJson(join(config.repo, configFiles[2]), { name: "dviewer", version, packages: { "": { version } } });
  writeFileSync(join(config.repo, configFiles[3]), `[package]\nname = "dviewer"\nversion = "${version}"\n`);
  writeFileSync(join(config.repo, configFiles[4]), `version = 4\n\n[[package]]\nname = "dviewer"\nversion = "${version}"\n`);
  for (const [slug, files] of Object.entries(inventory)) {
    const bundle = join(baseline, "bundles", slug);
    mkdirSync(bundle, { recursive: true });
    for (const [suffix] of files.signed) {
      const path = join(bundle, prefix + suffix);
      writeFileSync(path, Buffer.concat([Buffer.from(`Synthetic updater fixture: ${suffix}\n`), Buffer.from([0, 255, 128])]));
      sign(path);
    }
    for (const suffix of files.unsigned) writeFileSync(join(bundle, prefix + suffix), `Unsigned distribution fixture: ${suffix}\n`);
    for (const name of readdirSync(bundle)) cpSync(join(bundle, name), join(config.directory, name));
    const report = await verifyArtifacts(bundleOptions({ root: baseline, ...config }, slug));
    writeJson(join(config.sourceReportsDirectory, `bundle-${slug}.json`), report);
  }
  // Deliberately preserve unusual whitespace so a regeneration is detectable.
  const manifest = join(config.directory, "latest.json");
  writeFileSync(manifest, JSON.stringify(makeManifest(config.directory, tag), null, "\t") + "\r\n");
  sign(manifest);
});

after(() => {
  if (!temporary) return;
  assert.equal(dirname(temporary), resolve(tmpdir()));
  assert.ok(basename(temporary).startsWith("dviewer-artifact-tests-"));
  rmSync(temporary, { recursive: true, force: true });
});

test("all bundle inventories authenticate exact payloads and distinguish unsigned extras", async t => {
  for (const [slug, files] of Object.entries(inventory)) await t.test(slug, async () => {
    const config = bundleOptions(fixture(), slug), report = await verifyArtifacts(config);
    assert.equal(report.mode, "bundle");
    assert.equal(report.slug, slug);
    assert.deepEqual(report.signed_payloads.map(file => [file.name, file.platforms]),
      files.signed.map(([suffix, platforms]) => [prefix + suffix, platforms]));
    assert.deepEqual(report.unsigned_distribution_extras.map(file => file.name), files.unsigned.map(suffix => prefix + suffix));
    for (const file of [...report.signed_payloads, ...report.unsigned_distribution_extras]) {
      const bytes = readFileSync(join(config.directory, file.name));
      assert.equal(file.sha256, sha256(bytes));
      assert.equal(file.bytes, bytes.length);
    }
    for (const file of report.signed_payloads) {
      assert.equal(file.signature_verified, true);
      assert.equal(file.signature_sha256, sha256(readFileSync(join(config.directory, `${file.name}.sig`))));
    }
    for (const file of report.unsigned_distribution_extras) {
      assert.equal(file.signature_verified, false);
      assert.equal(Object.hasOwn(file, "signature_sha256"), false);
    }
    assert.deepEqual(report.configuration_sha256, Object.fromEntries(configFiles.map(path =>
      [path, sha256(readFileSync(join(config.repo, path)))])));
    assert.equal(report.public_key_sha256, sha256(Buffer.from(publicKey, "base64")));
    assert.equal(report.verifier.executable_sha256, sha256(readFileSync(appVerifier)));
    assert.equal(JSON.stringify(report).includes(publicKey), false);
  });
});

test("final release authenticates the original signed manifest and records exact source report hashes", async () => {
  const config = fixture();
  const snapshot = Object.fromEntries(readdirSync(config.directory).map(name => [name, readFileSync(join(config.directory, name))]));
  const report = await verifyArtifacts(config);
  assert.equal(report.signed_payloads.length, 5);
  assert.equal(report.unsigned_distribution_extras.length, 5);
  assert.deepEqual(report.manifest, { name: "latest.json", bytes: snapshot["latest.json"].length,
    sha256: sha256(snapshot["latest.json"]), signature_sha256: sha256(snapshot["latest.json.sig"]),
    signature_verified: true, original_bytes_preserved: true, platform_count: 6 });
  assert.deepEqual(report.source_bundles.map(source => source.slug), Object.keys(inventory));
  for (const source of report.source_bundles) {
    assert.equal(source.report_sha256, sha256(readFileSync(join(config.sourceReportsDirectory, `bundle-${source.slug}.json`))));
    assert.deepEqual(source.provenance, provenance());
  }
  for (const [name, bytes] of Object.entries(snapshot)) assert.deepEqual(readFileSync(join(config.directory, name)), bytes);
});

test("tag release can reuse a main rehearsal from a different run at the identical source SHA", async () => {
  const config = fixture();
  config.sourceRunId = "1000";
  const source = provenance({ run_id: "1000", event_name: "workflow_dispatch", ref: "refs/heads/main" });
  for (const slug of Object.keys(inventory)) editSource(config, report => { report.provenance = source; }, slug);
  const report = await verifyArtifacts(config);
  assert.ok(report.source_bundles.every(bundle => bundle.provenance.run_id === "1000"));
});

test("real verifier accepts Tauri signatures and rejects wrong keys, wrong signatures, and tampered bytes", async t => {
  const config = fixture(), path = join(config.directory, prefix + "windows-x64_portable.exe");
  const signature = readFileSync(`${path}.sig`, "utf8");
  verifySignature(path, publicKey, signature, config.verifier);
  await t.test("wrong key", () => assert.throws(() => verifySignature(path, wrongPublicKey, signature, config.verifier), /signature rejected/));
  await t.test("signature for a different payload", () => {
    const other = readFileSync(join(config.directory, prefix + "windows-x64.msi.sig"), "utf8");
    assert.throws(() => verifySignature(path, publicKey, other, config.verifier), /signature rejected/);
  });
  await t.test("authenticated trusted comment changed", () => {
    const envelope = Buffer.from(signature.trim(), "base64").toString("utf8").replace(/^trusted comment: /m, "trusted comment: changed ");
    assert.throws(() => verifySignature(path, publicKey, Buffer.from(envelope).toString("base64"), config.verifier), /signature rejected/);
  });
  await t.test("payload changed", () => {
    writeFileSync(path, "tampered payload\n");
    assert.throws(() => verifySignature(path, publicKey, signature, config.verifier), /signature rejected/);
  });
});

test("malformed or oversized envelopes fail before invoking a verifier", () => {
  const config = fixture(), path = join(config.directory, "latest.json");
  for (const signature of ["not base64!", "", Buffer.from("not a minisign envelope").toString("base64"), "A".repeat(16 * 1024 + 4)]) {
    assert.throws(() => verifySignature(path, publicKey, signature, config.verifier), /encoding|envelope/);
  }
});

test("tampered payload and manifest fail cryptographic verification", async t => {
  for (const name of [prefix + "linux-x86_64_portable.AppImage", "latest.json"]) await t.test(name, async () => {
    const config = fixture(), path = join(config.directory, name);
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(" \n")]));
    await assert.rejects(verifyArtifacts(config), /signature rejected/);
  });
});

test("missing and unexpected release files fail closed", async t => {
  for (const name of [prefix + "windows-x64_setup.exe", prefix + "windows-x64_setup.exe.sig",
    prefix + "linux-x86_64.deb", "latest.json", "latest.json.sig"]) await t.test(`missing ${name}`, async () => {
    const config = fixture();
    rmSync(join(config.directory, name));
    await assert.rejects(verifyArtifacts(config), /missing or unexpected artifact files/);
  });
  await t.test("unexpected report inside artifact directory", async () => {
    const config = fixture();
    writeFileSync(join(config.directory, "verification.json"), "{}");
    await assert.rejects(verifyArtifacts(config), /missing or unexpected artifact files/);
  });
});

test("a valid manifest signature does not excuse the wrong platform set, references, or version", async t => {
  const cases = [
    ["missing platform", manifest => { delete manifest.platforms["darwin-aarch64"]; }, /platform set differs/],
    ["unexpected platform", manifest => { manifest.platforms["linux-aarch64"] = manifest.platforms["linux-x86_64"]; }, /platform set differs/],
    ["wrong host", manifest => { manifest.platforms["linux-x86_64"].url = "https://example.invalid/payload"; }, /manifest reference differs/],
    ["wrong release URL", manifest => { manifest.platforms["linux-x86_64"].url = manifest.platforms["linux-x86_64"].url.replace(tag, "v1.2.2"); }, /manifest reference differs/],
    ["wrong embedded signature", manifest => { manifest.platforms["linux-x86_64"].signature = manifest.platforms["windows-x86_64-msi"].signature; }, /manifest reference differs/],
    ["wrong version", manifest => { manifest.version = "1.2.2"; }, /signed manifest\/version mismatch/],
    ["unexpected manifest field", manifest => { manifest.extra = true; }, /manifest fields differ/],
    ["invalid date", manifest => { manifest.pub_date = "not a date"; }, /invalid publication date/],
  ];
  for (const [name, edit, error] of cases) await t.test(name, async () => {
    const config = fixture();
    editManifest(config, edit);
    await assert.rejects(verifyArtifacts(config), error);
  });
});

test("all five source version files must agree", async t => {
  for (const path of configFiles) await t.test(path, async () => {
    const config = fixture(), file = join(config.repo, path);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll(version, "1.2.4"));
    await assert.rejects(verifyArtifacts(config), /source version files differ/);
  });
  await t.test("package lock root package", async () => {
    const config = fixture(), path = join(config.repo, "package-lock.json"), value = readJson(path);
    value.packages[""].version = "1.2.4";
    writeJson(path, value);
    await assert.rejects(verifyArtifacts(config), /source version files differ/);
  });
});

test("source reports bind source SHA, run, verifier, configuration, and artifact hashes", async t => {
  const cases = [
    ["source SHA", report => { report.provenance.source_sha = "d".repeat(40); }, /source report commit differs/],
    ["run ID", report => { report.provenance = provenance({ run_id: "1002" }); }, /source report run differs/],
    ["script hash", report => { report.verifier.script_sha256 = "d".repeat(64); }, /source report script differs/],
    ["missing verifier hash", report => { delete report.verifier.executable_sha256; }, /source verifier hash missing/],
    ["wrong verifier", report => { report.verifier.kind = "minisign"; }, /bundle did not use the app verifier/],
    ["configuration hash", report => { report.configuration_sha256["package.json"] = "d".repeat(64); }, /source report configuration differs/],
    ["public key hash", report => { report.public_key_sha256 = "d".repeat(64); }, /source report key differs/],
    ["signed payload hash", report => { report.signed_payloads[0].sha256 = "d".repeat(64); }, /source report signed payload hashes differ/],
    ["signature hash", report => { report.signed_payloads[0].signature_sha256 = "d".repeat(64); }, /source report signed payload hashes differ/],
    ["unsigned distribution hash", report => { report.unsigned_distribution_extras[0].sha256 = "d".repeat(64); }, /source report unsigned distribution hashes differ/],
    ["source report slug", report => { report.slug = "windows-x64"; }, /source report slug differs/],
  ];
  for (const [name, edit, error] of cases) await t.test(name, async () => {
    const config = fixture();
    editSource(config, edit);
    await assert.rejects(verifyArtifacts(config), error);
  });
});

test("reused runs must be main rehearsals, and same-run reports must share the release ref", async t => {
  for (const [name, source, sourceRunId, error] of [
    ["reused push", provenance({ run_id: "1000", event_name: "push", ref: "refs/heads/main" }), "1000", /reused source is not a rehearsal/],
    ["reused tag", provenance({ run_id: "1000", event_name: "workflow_dispatch" }), "1000", /reused source is not main/],
    ["same-run wrong ref", provenance({ ref: "refs/heads/main" }), "1001", /source ref differs/],
  ]) await t.test(name, async () => {
    const config = fixture();
    config.sourceRunId = sourceRunId;
    editSource(config, report => { report.provenance = source; });
    await assert.rejects(verifyArtifacts(config), error);
  });
});

test("source report inventory cannot omit a bundle or contain unrelated files", async t => {
  for (const missing of [true, false]) await t.test(missing ? "missing bundle" : "unexpected report", async () => {
    const config = fixture();
    if (missing) rmSync(join(config.sourceReportsDirectory, "bundle-windows-x64.json"));
    else writeFileSync(join(config.sourceReportsDirectory, "extra.json"), "{}");
    await assert.rejects(verifyArtifacts(config), /missing or unexpected source reports/);
  });
});

test("unsigned extras are hashed without claiming authenticity, but release reuse detects changed bytes", async () => {
  const config = fixture(), bundle = bundleOptions(config), name = prefix + "linux-x86_64.deb";
  writeFileSync(join(bundle.directory, name), "changed unsigned distribution\n");
  const report = await verifyArtifacts(bundle), extra = report.unsigned_distribution_extras.find(file => file.name === name);
  assert.equal(extra.signature_verified, false);
  assert.equal(extra.sha256, sha256(Buffer.from("changed unsigned distribution\n")));
  cpSync(join(bundle.directory, name), join(config.directory, name));
  await assert.rejects(verifyArtifacts(config), /source report unsigned distribution hashes differ/);
});

test("symlinks cannot substitute for artifacts, signatures, reports, configuration, or verifier", async t => {
  const locations = [
    ["payload", config => join(config.directory, prefix + "linux-x86_64_portable.AppImage")],
    ["signature", config => join(config.directory, prefix + "linux-x86_64_portable.AppImage.sig")],
    ["unsigned extra", config => join(config.directory, prefix + "linux-x86_64.deb")],
    ["manifest", config => join(config.directory, "latest.json")],
    ["manifest signature", config => join(config.directory, "latest.json.sig")],
    ["source report", config => join(config.sourceReportsDirectory, "bundle-linux-x86_64.json")],
    ["configuration", config => join(config.repo, configFiles[0])],
  ];
  for (const [name, locate] of locations) await t.test(name, async () => {
    const config = fixture(), path = locate(config), target = join(config.root, "symlink-target");
    cpSync(path, target);
    rmSync(path);
    symlinkSync(target, path);
    await assert.rejects(verifyArtifacts(config), /invalid regular file or size/);
  });
  await t.test("verifier", async () => {
    const config = fixture(), path = join(config.root, "linked-verifier");
    symlinkSync(config.verifier.path, path);
    config.verifier.path = path;
    await assert.rejects(verifyArtifacts(config), /invalid regular file or size/);
  });
});

test("zero-length and oversized files are rejected before hashing or signature work", async t => {
  for (const [name, size] of [[prefix + "linux-x86_64_portable.AppImage", 0],
    [prefix + "linux-x86_64_portable.AppImage", 256 * 1024 * 1024 + 1],
    [prefix + "linux-x86_64_portable.AppImage.sig", 16 * 1024 + 1], ["latest.json", 64 * 1024 + 1]]) {
    await t.test(`${name}: ${size} bytes`, async () => {
      const config = fixture();
      truncateSync(join(config.directory, name), size);
      await assert.rejects(verifyArtifacts(config), /invalid regular file or size/);
    });
  }
});

test("release reports require the matching tag and an explicit source run", async t => {
  for (const [name, edit, error] of [
    ["main ref", config => { config.provenance = provenance({ ref: "refs/heads/main" }); }, /release report requires real tag ref/],
    ["wrong tag", config => { config.provenance = provenance({ ref: "refs/tags/v1.2.4" }); }, /tag\/version mismatch/],
    ["missing source run", config => { delete config.sourceRunId; }, /missing source run id/],
  ]) await t.test(name, async () => {
    const config = fixture();
    edit(config);
    await assert.rejects(verifyArtifacts(config), error);
  });
});

test("readProvenance takes source SHA from checked-out HEAD and rejects invalid CI context", () => {
  const source = provenance(), env = {
    GITHUB_REPOSITORY: source.repository, GITHUB_SHA: source.event_sha,
    GITHUB_WORKFLOW_SHA: source.workflow_sha, GITHUB_RUN_ID: source.run_id,
    GITHUB_RUN_ATTEMPT: source.run_attempt, GITHUB_EVENT_NAME: source.event_name,
    GITHUB_REF: source.ref, GITHUB_WORKFLOW_REF: source.workflow_ref,
  };
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.deepEqual(readProvenance(root, env), { ...source, source_sha: sourceSha });
  for (const [field, value, error] of [
    ["GITHUB_REPOSITORY", "other/repository", /unexpected repository/],
    ["GITHUB_SHA", "invalid", /invalid event_sha/],
    ["GITHUB_WORKFLOW_SHA", "", /invalid workflow_sha/],
    ["GITHUB_RUN_ID", "0", /invalid run_id/],
    ["GITHUB_RUN_ATTEMPT", "", /invalid run_attempt/],
    ["GITHUB_EVENT_NAME", "pull_request", /not a release\/rehearsal event/],
    ["GITHUB_WORKFLOW_REF", "other/workflow", /Expected values to be strictly equal/],
  ]) assert.throws(() => readProvenance(root, { ...env, [field]: value }), error);
  assert.throws(() => readProvenance(root, { ...env, GITHUB_REF: "refs/heads/feature",
    GITHUB_WORKFLOW_REF: "ummoftgo/dviewer/.github/workflows/build.yml@refs/heads/feature" }), /not a signed release\/rehearsal ref/);
});
