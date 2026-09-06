import { createServer } from 'node:http';
import { createReadStream, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Transform } from 'node:stream';
const root = resolve(import.meta.dirname,'..');
const out = join(root,'.agent-works/m22-e2e');
const {key,to='0.14.0'} = JSON.parse(readFileSync(join(out,'context.json'),'utf8'));
let origin;
let lastScenario;
const server = createServer((req,res)=>{
  const pathname = new URL(req.url,origin).pathname;
  const raw = readFileSync(join(out,'scenario.json'),'utf8');
  if (pathname==='/latest.json' && raw!==lastScenario) {
    const scenario = JSON.parse(raw);
    const assets = scenario.large ? ['large.bin',`setup-${to}.exe`] : [`portable-${to}.exe`,`setup-${to}.exe`];
    const manifest = {version:scenario.version??to, notes:Array.from({length:20},(_,i)=>`노트 ${i+1}: <b>평문 그대로</b>`).join('\n'),pub_date:new Date().toISOString(),platforms:{}};
    for (const [index,flavor] of ['portable','nsis'].entries()) {
      manifest.platforms[`windows-x86_64-${flavor}`]={url:`${origin}/${assets[index]}`,signature:readFileSync(join(out,assets[index]+'.sig'),'utf8').trim()};
    }
    const file = join(out,'latest.json');
    writeFileSync(file,JSON.stringify(manifest));
    const signed = spawnSync(process.execPath,[join(root,'node_modules/@tauri-apps/cli/tauri.js'),'signer','sign','-f',key,'-p','',file],{encoding:'utf8',windowsHide:true});
    assert.equal(signed.status,0,'manifest signing failed');
    if(scenario.tamper) writeFileSync(file,readFileSync(file,'utf8')+' ');
    lastScenario=raw;
  }
  const allowed = ['latest.json','latest.json.sig',`portable-${to}.exe`,`setup-${to}.exe`,'large.bin','원본 문서.txt'];
  const name = decodeURIComponent(pathname.slice(1));
  if (!allowed.includes(name)) {res.writeHead(404);res.end();return;}
  const file=join(out,name);
  res.writeHead(200,{'Content-Length':statSync(file).size,'Content-Type':'application/octet-stream'});
  const stream = createReadStream(file, {highWaterMark:64*1024});
  if (name.endsWith('.exe') && JSON.parse(readFileSync(join(out,'scenario.json'),'utf8')).slow) {
    stream.pipe(new Transform({transform(chunk,encoding,done){setTimeout(()=>done(null,chunk),10);}})).pipe(res);
  } else stream.pipe(res);
});
server.listen(Number(process.argv[2] ?? 0),'127.0.0.1',()=>{
  origin=`http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(out,'server.json'),JSON.stringify({origin,pid:process.pid}));
  console.log(`Isolated update server ${origin}`);
});
