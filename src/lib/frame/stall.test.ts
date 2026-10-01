import {expect,test} from 'vitest';
import {frameMessage,parseFrameMessage,type FrameStallSnapshot} from './messages';
import {frameDiagnostic} from './diagnostics';
import type {FrameServed} from '../ipc';

const snapshot: FrameStallSnapshot = {readyState:'complete',l10n:'object',pdfViewer:false,preferences:true,initialized:false,
  options:20,locale:null,language:'en-GB',fonts:'loaded',navigationStatus:null,
  steps:{initialize:'pending',preferences:'rejected',l10n:'pending',components:'not-started'},
  resources:[{name:'/_/pdfjs/web/locale/en-US/viewer.ftl',responseStatus:404,duration:12,transferSize:0}]};

test('stall parsing bounds resources and values while retaining current-frame identity',() => {
  const frame={} as Window, data={type:'stall',snapshot,load:'?g=1'};
  expect(frameMessage({source:frame,data},frame,'?g=1')).toEqual({type:'stall',snapshot});
  expect(frameMessage({source:{} as Window,data},frame,'?g=1')).toBeNull();
  expect(frameMessage({source:frame,data},frame,'?g=2')).toBeNull();
  expect(parseFrameMessage({...data,snapshot:{...snapshot,secret:'ignored'}})).toEqual({type:'stall',snapshot});
  for (const changed of [{readyState:['complete']},{l10n:[]},{pdfViewer:1},{options:-1},{options:1.5},{language:'x'.repeat(65)},
    {navigationStatus:600},{steps:{...snapshot.steps,initialize:'invented'}},{resources:Array(16).fill(snapshot.resources[0])}]) {
    expect(parseFrameMessage({...data,snapshot:{...snapshot,...changed}})).toEqual({type:'stall',snapshot:{raw:expect.any(String)}});
  }
  for (const changed of [{name:'https://example.com/file'},{name:'/file?q=token'},{name:`/${'ab'.repeat(32)}/file`},
    {name:'/'+'x'.repeat(128)},{duration:Infinity},{transferSize:-1},{responseStatus:700}]) {
    expect(parseFrameMessage({...data,snapshot:{...snapshot,resources:[{...snapshot.resources[0],...changed}]}})).toEqual({type:'stall',snapshot:{raw:expect.any(String)}});
  }
});

test('typed early stalls preserve unknown app state and validate bounded passive evidence',() => {
  const early:FrameStallSnapshot={...snapshot,l10n:null,pdfViewer:null,preferences:null,initialized:null,
    application:{global:false,local:false,pdfjsLib:false,options:false},
    lifecycle:{agentStart:0,domInteractive:1,domContentLoaded:2,domComplete:null,load:null,webviewerloaded:null},
    scripts:[{src:'/_/pdfjs/web/viewer.mjs',type:'module',async:true,defer:false,load:null,error:10}],
    styles:[{href:'/_/pdfjs/web/viewer.css',load:3,error:null}],
    reason:'error',startup:[{phase:'error',at:97,readyState:'interactive',visibility:'visible',containerConnected:true,containerPosition:'static',
      stylesheet:{present:true,sheet:false,disabled:false,load:null,error:null}}],
    csp:[{directive:'script-src-elem',blocked:'/_/pdfjs/web/viewer.mjs',at:10}],
    coreResources:{'/_/pdfjs/build/pdf.mjs':{responseStatus:200,duration:10,transferSize:100}}};
  const frame={} as Window,data={type:'stall',snapshot:early,load:'?g=1'};
  expect(parseFrameMessage(data)).toEqual({type:'stall',snapshot:early});
  expect(frameMessage({source:frame,data},frame,'?g=1')).toEqual({type:'stall',snapshot:early});
  expect(frameMessage({source:frame,data},frame,'?g=2')).toBeNull();
  expect(frameMessage({source:{} as Window,data},frame,'?g=1')).toBeNull();
  expect(parseFrameMessage({...data,snapshot:{...early,initialized:false}})).toHaveProperty('snapshot.initialized',false);
  for (const changed of [{application:{global:'false',local:false}}, {application:{...early.application,pdfjsLib:'false'}}, {lifecycle:{...early.lifecycle,load:-1}},
    {scripts:Array(9).fill(early.scripts![0])}, {scripts:[{...early.scripts![0],load:false}]},
    {scripts:[{...early.scripts![0],src:'/file?secret=value'}]}, {scripts:[{...early.scripts![0],src:'/file%3fsecret'}]},
    {styles:Array(5).fill(early.styles![0])}, {styles:[{...early.styles![0],href:'/file?secret=value'}]},
    {reason:'invented'}, {startup:Array(4).fill(early.startup![0])}, {startup:[{...early.startup![0],phase:'invented'}]},
    {startup:[{...early.startup![0],containerPosition:'url(secret)'}]}, {startup:[{...early.startup![0],at:-1}]},
    {startup:[{...early.startup![0],stylesheet:{...early.startup![0].stylesheet,sheet:'true'}}]},
    {csp:Array(9).fill(early.csp![0])}, {csp:[{...early.csp![0],blocked:'https://example.com/private'}]},
    {csp:[{...early.csp![0],directive:'script-src secret'}]},
    {coreResources:{'/private':{responseStatus:200}}}, {coreResources:{'/_/pdfjs/build/pdf.mjs':{duration:Infinity}}}]) {
    expect(parseFrameMessage({...data,snapshot:{...early,...changed}})).toHaveProperty('snapshot.raw',expect.any(String));
  }
});

test('timeout diagnostics include response order, missing paths, a bounded stall snapshot and the last orientation verdict',() => {
  const orientation={page:1,ms:12.3456,ink:0.0068,rowEnergy:null,colEnergy:null,decision:null,start:null,end:null,direction:null,reason:'sparse'} as const;
  const served:FrameServed={registryAvailable:true,html:1,agent:2,resource:21,
    last:[{sequence:24,path:'/_/pdfjs/web/locale/en-US/viewer.ftl',docId:1,generation:0,receivedAtMs:1,receivedElapsedMs:0,buildEnteredElapsedMs:null,builtElapsedMs:null,respondEnteredElapsedMs:null,respondReturnedElapsedMs:null,buildEnteredAtMs:2,
      builtAtMs:3,respondEnteredAtMs:4,respondReturnedAtMs:5,status:404,contentLength:0,respondResult:'ok',respondErrorKind:null}],
    server:{clockOrigin:'doc-server-start' as const,clockOriginAtMs:1,observedElapsedMs:5,healthConsistent:true,phaseElapsedMs:4,lastProgressElapsedMs:4,exitedElapsedMs:null,phase:'recv-wait',phaseAtMs:5,phaseAgeMs:2,lastProgressAtMs:5,lastProgressAgeMs:2,activeRequestId:null,
      recvTimeoutCount:1,recvErrorCount:0,lastErrorKind:null,exitedAtMs:null,exitReason:null,retention:{historyAvailable:true,contentionCount:0,requestDrops:0,eventDrops:0,snapshotMisses:0,limit:128,total:24,dropped:0},requests:[]}};
  const result=frameDiagnostic({frameOrientation:orientation,frameUrlPort:'43123',frameLoaded:true,frameReady:false,frameError:null,
    frameCsp:[],frameAgentStarted:true,frameStages:['start','webviewerloaded','worker-start','initializedPromise','worker-imported'],frameStall:snapshot,
    frameServed:served});
  expect(result).toBe('(frame: url ok, port 43123, load yes, ready no, error -, served html 1 agent 2 resource 21, csp -, agent start yes, stage start>webviewerloaded>worker-start>initializedPromise>worker-imported, last: 24:/_/pdfjs/web/locale/en-US/viewer.ftl 404 respond-returned:ok len=0, stall '+JSON.stringify(snapshot)+', orientation '+JSON.stringify(orientation)+', worker '+JSON.stringify({...served.server,requests:[]})+')');
  expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(8192);
});

test('stall resource fields are optional and missing WebKit timing values become null',() => {
  const data={type:'stall',snapshot:{...snapshot,resources:[{}, {name:'/_/pdfjs/web/viewer.mjs',duration:1.25}]}};
  expect(parseFrameMessage(data)).toEqual({type:'stall',snapshot:{...snapshot,resources:[
    {name:null,responseStatus:null,duration:null,transferSize:null},
    {name:'/_/pdfjs/web/viewer.mjs',responseStatus:null,duration:1.25,transferSize:null},
  ]}});
  const large={...snapshot,resources:Array.from({length:15},()=>({...snapshot.resources[0],name:'/'+'"'.repeat(127)}))};
  expect(JSON.stringify(large).length).toBeGreaterThan(4096);
  expect(parseFrameMessage({type:'stall',snapshot:large})).toEqual({type:'stall',snapshot:large});
});

test('invalid stalls retain a bounded redacted raw preview instead of disappearing',() => {
  const token='ab'.repeat(32);
  const invalid={why:`failed http://127.0.0.1:123/${token}/file?x=1\n${token}`,extra:'x'.repeat(9000)};
  const message=parseFrameMessage({type:'stall',snapshot:invalid});
  expect(message?.type).toBe('stall');
  if (message?.type !== 'stall' || !('raw' in message.snapshot)) throw new Error('raw stall missing');
  expect(message.snapshot.raw.length).toBeLessThanOrEqual(2000);
  expect(message.snapshot.raw).toContain('[url]');
  expect(message.snapshot.raw).not.toContain(token);
  const cycle: Record<string,unknown>={}; cycle.self=cycle;
  expect(parseFrameMessage({type:'stall',snapshot:cycle})).toEqual({type:'stall',snapshot:{raw:expect.any(String)}});
  expect(parseFrameMessage({type:'stall',snapshot:{raw:'x'.repeat(9000)}})).toEqual({type:'stall',snapshot:{raw:'x'.repeat(2000)}});
});
