// Builds isolated, signed Windows test bundles; never creates a deployment key.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, openSync, closeSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
const out = join(root, '.agent-works/m22-e2e');
mkdirSync(out, {recursive:true});
const contextFile = join(out, 'context.json');
if (process.argv[2] === '--cleanup-keys') {
  const {directory} = JSON.parse(readFileSync(contextFile,'utf8'));
  assert.equal(dirname(directory),resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('dviewer-m22-keys-'));
  rmSync(directory,{recursive:true,force:true});
  console.log('Isolated signing keys removed.');
  process.exit(0);
}
assert.equal(process.platform,'win32','Windows test bundles only');
const payload = process.argv[2] === '--payload-mib';
const [from='0.13.0',to='0.14.0'] = payload ? [] : process.argv.slice(2);
for (const version of [from,to]) assert.match(version,/^\d+\.\d+\.\d+$/,'stable test versions required');
const directory = existsSync(contextFile) ? JSON.parse(readFileSync(contextFile,'utf8')).directory : mkdtempSync(join(tmpdir(), 'dviewer-m22-keys-'));
mkdirSync(directory,{recursive:true});
const key = join(directory, 'test.key');
const cli = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
function signer(args) {
  const result = spawnSync(process.execPath, [cli, 'signer', ...args], {cwd:root, encoding:'utf8'});
  assert.equal(result.status, 0, 'test signer failed');
}
if (payload) {
  assert.ok(existsSync(key),'prepare test bundles first');
  const size = Number(process.argv[3]);
  assert.ok(Number.isInteger(size) && size >= 1 && size <= 256,'test payload must be 1..256 MiB');
  const file = join(out,'large.bin');
  writeFileSync(file,'');
  truncateSync(file,size*1024*1024);
  signer(['sign','-f',key,'-p','',file]);
  writeFileSync(join(out,'scenario.json'),JSON.stringify({large:true,sizeMiB:size}));
  process.exit(0);
}
if (!existsSync(key)) signer(['generate','--ci','-w',key,'-p','']);
writeFileSync(join(out, 'context.json'), JSON.stringify({directory, key, out, from, to}));
writeFileSync(join(out,'scenario.json'),'{}');
writeFileSync(join(out,'원본 문서.txt'),'M22 original document\n');
for (const version of [from,to]) {
  const config = {
    productName:'dviewer M22 test', version, identifier:'com.xenia.dviewer.m22test',
    plugins:{updater:{pubkey:readFileSync(`${key}.pub`,'utf8').trim()}},
    app:{windows:[{title:`dviewer M22 test ${version}`, width:1180,height:800,minWidth:640,minHeight:420,dragDropEnabled:true}]},
    bundle:{createUpdaterArtifacts:version===to, windows:{nsis:{installMode:'currentUser'},webviewInstallMode:{type:'skip'}}},
  };
  const configFile = join(out, `config-${version}.json`);
  writeFileSync(configFile, JSON.stringify(config));
  const log = openSync(join(out, `build-${version}.log`),'w');
  const result = spawnSync(process.execPath,[cli,'build','--debug','--bundles','nsis','--config',configFile,'--ci'], {
    cwd:root, stdio:['ignore',log,log], env:{...process.env,TAURI_SIGNING_PRIVATE_KEY:readFileSync(key,'utf8'),TAURI_SIGNING_PRIVATE_KEY_PASSWORD:''}, windowsHide:true,
  });
  closeSync(log);
  assert.equal(result.status,0,`build ${version} failed; see isolated build log`);
  copyFileSync(join(root,'src-tauri/target/debug/dviewer.exe'),join(out,`portable-${version}.exe`));
  const bundle = join(root,'src-tauri/target/debug/bundle/nsis');
  const name = `dviewer M22 test_${version}_x64-setup.exe`;
  copyFileSync(join(bundle,name),join(out,`setup-${version}.exe`));
  if (version===to) {
    copyFileSync(join(bundle,`${name}.sig`),join(out,`setup-${version}.exe.sig`));
    signer(['sign','-f',key,'-p','',join(out,`portable-${version}.exe`)]);
  }
  console.log(`Isolated ${version} portable and NSIS built.`);
}
