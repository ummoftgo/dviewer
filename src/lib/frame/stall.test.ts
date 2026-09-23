import {expect,test} from 'vitest';
import {frameMessage,parseFrameMessage,type FrameStallSnapshot} from './messages';
import {frameDiagnostic} from './diagnostics';

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

test('timeout diagnostics include response order, missing paths, a bounded stall snapshot and the last orientation verdict',() => {
  const orientation={page:1,ms:12.3456,ink:0.0068,rowEnergy:null,colEnergy:null,decision:null,start:null,end:null,direction:null,reason:'sparse'} as const;
  const result=frameDiagnostic({frameOrientation:orientation,frameUrlPort:'43123',frameLoaded:true,frameReady:false,frameError:null,
    frameCsp:[],frameAgentStarted:true,frameStages:['start','webviewerloaded','worker-start','initializedPromise','worker-imported'],frameStall:snapshot,
    frameServed:{html:1,agent:2,resource:21,last:[{sequence:24,path:'/_/pdfjs/web/locale/en-US/viewer.ftl',status:404}]}});
  expect(result).toBe('(frame: url ok, port 43123, load yes, ready no, error -, served html 1 agent 2 resource 21, csp -, agent start yes, stage start>webviewerloaded>worker-start>initializedPromise>worker-imported, last: 24:/_/pdfjs/web/locale/en-US/viewer.ftl 404, stall '+JSON.stringify(snapshot)+', orientation '+JSON.stringify(orientation)+')');
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
