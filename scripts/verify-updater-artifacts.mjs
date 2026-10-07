// Read-only authentication of collected assets. Reports live outside artifacts/.
// Bundle jobs use the app's streaming verifier; release uses official minisign
// (https://jedisct1.github.io/minisign/), without building GUI dependencies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { createReadStream, lstatSync, mkdtempSync, mkdirSync, readFileSync,
  readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const bundleSlugs = ["linux-x86_64", "macos-universal", "windows-x64"];
const signedSuffixes = {
  "linux-x86_64": [["linux-x86_64_portable.AppImage", ["linux-x86_64"]]],
  "macos-universal": [["macos-universal.app.tar.gz", ["darwin-aarch64", "darwin-x86_64"]]],
  "windows-x64": [["windows-x64_setup.exe", ["windows-x86_64-nsis"]],
    ["windows-x64.msi", ["windows-x86_64-msi"]],
    ["windows-x64_portable.exe", ["windows-x86_64-portable"]]],
};
const unsignedSuffixes = {
  "linux-x86_64": ["linux-x86_64.deb", "linux-x86_64.rpm"],
  "macos-universal": ["macos-universal.dmg", "macos-universal_portable.zip"],
  "windows-x64": ["windows-x64_portable.zip"],
};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sorted = values => [...values].sort();
const payloadLimit = 256 * 1024 * 1024;
const signatureLimit = 16 * 1024;

function regularFile(path, max) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= max,
    `invalid regular file or size: ${basename(path)}`);
  return stat;
}
function readRegular(path, max) {
  regularFile(path, max);
  return readFileSync(path);
}
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function decodeEnvelope(value) {
  assert.equal(typeof value, "string", "missing public key or signature");
  assert.ok(Buffer.byteLength(value) <= signatureLimit, "signature envelope too large");
  const encoded = value.trim();
  assert.match(encoded, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    "invalid signature envelope encoding");
  const bytes = Buffer.from(encoded, "base64");
  assert.equal(bytes.toString("base64"), encoded, "noncanonical signature envelope");
  assert.ok(bytes.toString("utf8").startsWith("untrusted comment:"), "invalid minisign envelope");
  return bytes;
}

function configuration(repo) {
  const paths = ["src-tauri/tauri.conf.json", "package.json", "package-lock.json",
    "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
  const files = Object.fromEntries(paths.map(path => [path, readRegular(join(repo, path), 2 * 1024 * 1024)]));
  const config = JSON.parse(files[paths[0]]);
  assert.match(config.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "stable version required");
  const packageJson = JSON.parse(files[paths[1]]), packageLock = JSON.parse(files[paths[2]]);
  const cargoVersion = files[paths[3]].toString("utf8").match(/^\[package\]\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1]
    .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const lockedVersion = files[paths[4]].toString("utf8")
    .match(/^\[\[package\]\]\r?\nname = "dviewer"\r?\nversion = "([^"]+)"/m)?.[1];
  for (const version of [packageJson.version, packageLock.version, packageLock.packages?.[""]?.version,
    cargoVersion, lockedVersion]) assert.equal(version, config.version, "source version files differ");
  const publicKey = config.plugins?.updater?.pubkey;
  return { version: config.version, publicKey, publicKeySha256: sha256(decodeEnvelope(publicKey)),
    files: Object.fromEntries(paths.map(path => [path, sha256(files[path])])) };
}

function validateProvenance(value) {
  assert.equal(value.repository, "ummoftgo/dviewer", "unexpected repository");
  for (const field of ["source_sha", "workflow_sha", "event_sha"]) {
    assert.match(value[field] ?? "", /^[a-f0-9]{40}$/, `missing or invalid ${field}`);
  }
  for (const field of ["run_id", "run_attempt"]) {
    assert.match(value[field] ?? "", /^[1-9]\d*$/, `missing or invalid ${field}`);
  }
  assert.equal(value.run_url, `https://github.com/${value.repository}/actions/runs/${value.run_id}`);
  assert.ok(["push", "workflow_dispatch"].includes(value.event_name), "not a release/rehearsal event");
  assert.equal(value.workflow_ref, `${value.repository}/.github/workflows/build.yml@${value.ref}`);
  assert.ok(value.ref === "refs/heads/main" || /^refs\/tags\/v\d+\.\d+\.\d+$/.test(value.ref),
    "not a signed release/rehearsal ref");
}
export function readProvenance(repo, env = process.env) {
  const provenance = {
    repository: env.GITHUB_REPOSITORY,
    source_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    event_sha: env.GITHUB_SHA, workflow_sha: env.GITHUB_WORKFLOW_SHA,
    run_id: env.GITHUB_RUN_ID, run_attempt: env.GITHUB_RUN_ATTEMPT,
    event_name: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, workflow_ref: env.GITHUB_WORKFLOW_REF,
    run_url: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
  };
  validateProvenance(provenance);
  return provenance;
}

export function verifySignature(path, publicKey, signature, verifier) {
  assert.ok(["dviewer", "minisign"].includes(verifier.kind), "unsupported verifier");
  const publicBytes = decodeEnvelope(publicKey), signatureBytes = decodeEnvelope(signature);
  const directory = mkdtempSync(join(tmpdir(), "dviewer-public-verification-"));
  try {
    const keyFile = join(directory, "public.key"), signatureFile = join(directory, "payload.sig");
    writeFileSync(keyFile, verifier.kind === "minisign" ? publicBytes : publicKey, { flag: "wx" });
    writeFileSync(signatureFile, verifier.kind === "minisign" ? signatureBytes : signature, { flag: "wx" });
    const args = verifier.kind === "minisign"
      ? ["-V", "-H", "-q", "-p", keyFile, "-x", signatureFile, "-m", resolve(path)]
      : [resolve(path), keyFile, signatureFile];
    const result = spawnSync(resolve(verifier.path), args, { encoding: "utf8", timeout: 120_000 });
    // No verifier output or key/signature bytes are copied into logs or reports.
    assert.equal(result.status, 0, `signature rejected: ${basename(path)}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectedFiles(version, slugs) {
  const prefix = `dviewer_${version}_`;
  return {
    signed: slugs.flatMap(slug => signedSuffixes[slug].map(([suffix, platforms]) =>
      ({ name: prefix + suffix, platforms }))),
    unsigned: slugs.flatMap(slug => unsignedSuffixes[slug].map(suffix => prefix + suffix)),
  };
}
async function inspectFile(directory, name, max = payloadLimit) {
  const path = join(directory, name), stat = regularFile(path, max);
  return { name, bytes: stat.size, sha256: await hashFile(path) };
}

export async function verifyArtifacts({ repo, directory, mode, slug, verifier, provenance,
  sourceReportsDirectory, sourceRunId }) {
  assert.ok(["bundle", "release"].includes(mode), "invalid verification mode");
  validateProvenance(provenance);
  const config = configuration(repo), tag = `v${config.version}`;
  if (provenance.ref.startsWith("refs/tags/")) assert.equal(provenance.ref, `refs/tags/${tag}`, "tag/version mismatch");
  assert.ok(mode === "release" || bundleSlugs.includes(slug), "invalid bundle slug");
  if (mode === "release") assert.equal(provenance.ref, `refs/tags/${tag}`, "release report requires real tag ref");
  const slugs = mode === "release" ? bundleSlugs : [slug];
  const expected = expectedFiles(config.version, slugs);
  const names = [...expected.signed.flatMap(({ name }) => [name, `${name}.sig`]), ...expected.unsigned,
    ...(mode === "release" ? ["latest.json", "latest.json.sig"] : [])];
  assert.deepEqual(sorted(readdirSync(directory)), sorted(names), "missing or unexpected artifact files");
  regularFile(verifier.path, 256 * 1024 * 1024);
  const verifierHash = await hashFile(verifier.path);
  const verifierVersion = verifier.kind === "minisign"
    ? execFileSync(resolve(verifier.path), ["-v"], { encoding: "utf8", maxBuffer: 1024, timeout: 10_000 }).trim()
    : "app streaming verifier";
  if (verifier.kind === "minisign") assert.match(verifierVersion, /^minisign \d+\.\d+(?:\.\d+)?$/, "unexpected minisign version");
  const report = {
    schema: 1, mode, ...(mode === "bundle" ? { slug } : {}), version: config.version, tag,
    provenance, configuration_sha256: config.files, public_key_sha256: config.publicKeySha256,
    verifier: { kind: verifier.kind, version: verifierVersion, executable_sha256: verifierHash, node: process.version,
      script_sha256: sha256(readFileSync(new URL(import.meta.url))) },
    signed_payloads: [], unsigned_distribution_extras: [],
  };
  let manifestBytes, manifestSignature, manifest;
  if (mode === "release") {
    manifestBytes = readRegular(join(directory, "latest.json"), 64 * 1024);
    manifestSignature = readRegular(join(directory, "latest.json.sig"), signatureLimit);
    verifySignature(join(directory, "latest.json"), config.publicKey, manifestSignature.toString("utf8"), verifier);
    manifest = JSON.parse(manifestBytes);
    assert.deepEqual(sorted(Object.keys(manifest)), ["notes", "platforms", "pub_date", "version"], "manifest fields differ");
    assert.equal(manifest.version, config.version, "signed manifest/version mismatch");
    assert.equal(typeof manifest.notes, "string");
    assert.equal(typeof manifest.pub_date, "string");
    assert.ok(Number.isFinite(Date.parse(manifest.pub_date)), "invalid publication date");
    assert.deepEqual(sorted(Object.keys(manifest.platforms)), sorted(expected.signed.flatMap(file => file.platforms)),
      "manifest platform set differs");
  }
  for (const { name, platforms } of expected.signed) {
    const path = join(directory, name), before = await inspectFile(directory, name);
    const signatureBytes = readRegular(`${path}.sig`, signatureLimit), signature = signatureBytes.toString("utf8").trim();
    if (manifest) {
      for (const platform of platforms) assert.deepEqual(manifest.platforms[platform], {
        url: `https://github.com/ummoftgo/dviewer/releases/download/${tag}/${name}`, signature,
      }, `manifest reference differs: ${platform}`);
    }
    verifySignature(path, config.publicKey, signature, verifier);
    assert.deepEqual(await inspectFile(directory, name), before, `payload changed during verification: ${name}`);
    assert.ok(readRegular(`${path}.sig`, signatureLimit).equals(signatureBytes), `signature changed: ${name}`);
    report.signed_payloads.push({ ...before, platforms, signature_sha256: sha256(signatureBytes), signature_verified: true });
  }
  for (const name of expected.unsigned) {
    // Hash these distribution formats for identity only. They carry no updater signature.
    report.unsigned_distribution_extras.push({ ...await inspectFile(directory, name, 1024 * 1024 * 1024),
      signature_verified: false });
  }
  if (mode === "release") {
    assert.match(sourceRunId ?? "", /^[1-9]\d*$/, "missing source run id");
    const reportNames = bundleSlugs.map(value => `bundle-${value}.json`);
    assert.deepEqual(sorted(readdirSync(sourceReportsDirectory)), sorted(reportNames), "missing or unexpected source reports");
    report.source_bundles = [];
    for (const bundle of bundleSlugs) {
      const bytes = readRegular(join(sourceReportsDirectory, `bundle-${bundle}.json`), 64 * 1024);
      const source = JSON.parse(bytes);
      assert.equal(source.schema, 1, "source report schema differs");
      assert.equal(source.mode, "bundle", "not a bundle report");
      assert.equal(source.slug, bundle, "source report slug differs");
      assert.equal(source.version, config.version, "source report version differs");
      assert.equal(source.tag, tag, "source report tag differs");
      validateProvenance(source.provenance);
      assert.equal(source.provenance.run_id, sourceRunId, "source report run differs");
      assert.equal(source.provenance.source_sha, provenance.source_sha, "source report commit differs");
      if (sourceRunId !== provenance.run_id) {
        assert.equal(source.provenance.event_name, "workflow_dispatch", "reused source is not a rehearsal");
        assert.equal(source.provenance.ref, "refs/heads/main", "reused source is not main");
      } else {
        assert.equal(source.provenance.ref, provenance.ref, "source ref differs");
      }
      assert.equal(source.verifier.kind, "dviewer", "bundle did not use the app verifier");
      assert.equal(source.verifier.script_sha256, report.verifier.script_sha256, "source report script differs");
      assert.match(source.verifier.executable_sha256, /^[a-f0-9]{64}$/, "source verifier hash missing");
      assert.deepEqual(source.configuration_sha256, config.files, "source report configuration differs");
      assert.equal(source.public_key_sha256, config.publicKeySha256, "source report key differs");
      const bundleFiles = expectedFiles(config.version, [bundle]);
      assert.deepEqual(source.signed_payloads, report.signed_payloads.filter(file => bundleFiles.signed.some(f => f.name === file.name)),
        "source report signed payload hashes differ");
      assert.deepEqual(source.unsigned_distribution_extras, report.unsigned_distribution_extras.filter(file => bundleFiles.unsigned.includes(file.name)),
        "source report unsigned distribution hashes differ");
      report.source_bundles.push({ slug: bundle, report_sha256: sha256(bytes), provenance: source.provenance,
        verifier: source.verifier });
    }
    assert.ok(readRegular(join(directory, "latest.json"), 64 * 1024).equals(manifestBytes), "signed manifest bytes changed");
    assert.ok(readRegular(join(directory, "latest.json.sig"), signatureLimit).equals(manifestSignature), "manifest signature changed");
    report.manifest = { name: "latest.json", bytes: manifestBytes.length, sha256: sha256(manifestBytes),
      signature_sha256: sha256(manifestSignature), signature_verified: true, original_bytes_preserved: true,
      platform_count: Object.keys(manifest.platforms).length };
  }
  // Bind the emitted report to the complete final file set, including a file
  // that might have changed while a later payload was being authenticated.
  for (const file of [...report.signed_payloads, ...report.unsigned_distribution_extras]) {
    assert.deepEqual(await inspectFile(directory, file.name, file.signature_verified ? payloadLimit : 1024 * 1024 * 1024),
      { name: file.name, bytes: file.bytes, sha256: file.sha256 }, `artifact changed before report: ${file.name}`);
    if (file.signature_verified) assert.equal(sha256(readRegular(join(directory, `${file.name}.sig`), signatureLimit)),
      file.signature_sha256, `signature changed before report: ${file.name}`);
  }
  assert.equal(await hashFile(verifier.path), verifierHash, "verifier changed during verification");
  assert.deepEqual(configuration(repo), config, "source configuration changed during verification");
  assert.deepEqual(sorted(readdirSync(directory)), sorted(names), "artifact files changed during verification");
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2);
  assert.ok((mode === "bundle" && args.length === 4) || (mode === "release" && args.length === 5),
    "usage: verify-updater-artifacts.mjs bundle <slug> <assets> <app-verifier> <report> | release <assets> <minisign> <source-reports> <source-run-id> <report>");
  const [slug, directory, executable, sourceReportsDirectory, sourceRunId, output] = mode === "bundle"
    ? [args[0], args[1], args[2], undefined, undefined, args[3]]
    : [undefined, args[0], args[1], args[2], args[3], args[4]];
  const outputRelative = relative(resolve(directory), resolve(output));
  assert.ok(outputRelative.startsWith(`..${sep}`) || resolve(outputRelative) === outputRelative,
    "report must be outside asset directory");
  const repo = resolve(import.meta.dirname, "..");
  const report = await verifyArtifacts({ repo, directory: resolve(directory), mode, slug,
    verifier: { kind: mode === "bundle" ? "dviewer" : "minisign", path: resolve(executable) },
    provenance: readProvenance(repo), sourceReportsDirectory, sourceRunId });
  const bytes = JSON.stringify(report, null, 2) + "\n";
  assert.ok(Buffer.byteLength(bytes) <= 64 * 1024, "verification report too large");
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, bytes, { flag: "wx" });
  console.log(`Verified ${report.signed_payloads.length} signed payloads${mode === "release" ? " and signed manifest" : ""}; report: ${output}`);
}
