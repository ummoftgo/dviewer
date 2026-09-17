import {expect,test} from 'vitest';
import {frameMessage,parseFrameMessage,type FrameStall} from './messages';
import {frameDiagnostic} from './diagnostics';

const snapshot: FrameStall = {readyState:'complete',l10n:'object',pdfViewer:false,preferences:true,initialized:false,
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
    expect(parseFrameMessage({...data,snapshot:{...snapshot,...changed}})).toBeNull();
  }
  for (const changed of [{name:'https://example.com/file'},{name:'/file?q=token'},{name:`/${'ab'.repeat(32)}/file`},
    {name:'/'+'x'.repeat(128)},{duration:Infinity},{transferSize:-1},{responseStatus:700}]) {
    expect(parseFrameMessage({...data,snapshot:{...snapshot,resources:[{...snapshot.resources[0],...changed}]}})).toBeNull();
  }
});

test('timeout diagnostics include response order, missing paths and a bounded stall snapshot',() => {
  const result=frameDiagnostic({frameUrlPort:'43123',frameLoaded:true,frameReady:false,frameError:null,
    frameCsp:[],frameAgentStarted:true,frameStage:'worker-imported',frameStall:snapshot,
    frameServed:{html:1,agent:2,resource:21,last:[{sequence:24,path:'/_/pdfjs/web/locale/en-US/viewer.ftl',status:404}]}});
  expect(result).toBe('(frame: url ok, port 43123, load yes, ready no, error -, served html 1 agent 2 resource 21, csp -, agent start yes, stage worker-imported, last: 24:/_/pdfjs/web/locale/en-US/viewer.ftl 404, stall '+JSON.stringify(snapshot)+')');
  expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(4096);
});
