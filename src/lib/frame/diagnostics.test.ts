import {expect, test} from 'vitest';
import type {FrameRequest} from '../ipc';
import type {PdfStage} from './messages';
import {captureFrameObservation, markFrameTeardown, frameDiagnostic, parentCspViolation} from './diagnostics';
import {frameMessage} from './messages';

const pending = {frameServed:null, frameCsp:[], frameAgentStarted:false, frameStages:[], frameStall:null, frameOrientation:null};

test('frame timeouts distinguish URL failure, missing load and missing agent ready', () => {
  const state = {...pending, frameUrlPort:null, frameLoaded:false, frameReady:false, frameError:null};
  expect(frameDiagnostic(state)).toBe('(frame: url not issued, load no, ready no, error -, served unknown, csp -, agent start no, stage -, last: -, stall -, orientation -)');
  expect(frameDiagnostic({...state, frameError:'server unavailable'}))
    .toBe('(frame: url not issued, load no, ready no, error server unavailable, served unknown, csp -, agent start no, stage -, last: -, stall -, orientation -)');
  expect(frameDiagnostic({...state, frameUrlPort:'43123'}))
    .toBe('(frame: url ok, port 43123, load no, ready no, error -, served unknown, csp -, agent start no, stage -, last: -, stall -, orientation -)');
  expect(frameDiagnostic({...state, frameUrlPort:'43123', frameLoaded:true, frameError:'HTML 문서를 표시하지 못했습니다.'}))
    .toBe('(frame: url ok, port 43123, load yes, ready no, error HTML 문서를 표시하지 못했습니다., served unknown, csp -, agent start no, stage -, last: -, stall -, orientation -)');
});

const server = {clockOrigin:'doc-server-start' as const,clockOriginAtMs:1,observedElapsedMs:5,healthConsistent:true,phaseElapsedMs:4,lastProgressElapsedMs:4,exitedElapsedMs:null,phase:'recv-wait',phaseAtMs:5,phaseAgeMs:2,lastProgressAtMs:5,lastProgressAgeMs:2,activeRequestId:null,
  recvTimeoutCount:1,recvErrorCount:0,lastErrorKind:null,exitedAtMs:null,exitReason:null,requests:[],retention:{historyAvailable:true,contentionCount:0,requestDrops:0,eventDrops:0,snapshotMisses:0,limit:128,total:4,dropped:0}};
const request:FrameRequest = {sequence:1,path:'/_/pdfjs/build/pdf.mjs',docId:1,generation:0,receivedAtMs:1,receivedElapsedMs:0,buildEnteredElapsedMs:null,builtElapsedMs:null,respondEnteredElapsedMs:null,respondReturnedElapsedMs:null,buildEnteredAtMs:null,
  builtAtMs:null,respondEnteredAtMs:null,respondReturnedAtMs:null,status:null,contentLength:null,respondResult:null,respondErrorKind:null};
test('recv, build and respond phases are distinct without implying browser delivery', () => {
  const last=[request,{...request,sequence:2,buildEnteredAtMs:2},
    {...request,sequence:3,buildEnteredAtMs:2,builtAtMs:3,respondEnteredAtMs:4,status:200,contentLength:99},
    {...request,sequence:4,respondReturnedAtMs:5,respondResult:'ok' as const,status:200}];
  const diagnostic=frameDiagnostic({...pending,frameUrlPort:'1',frameLoaded:false,frameReady:false,frameError:null,frameServed:{registryAvailable:true,html:1,agent:2,resource:3,last,server}});
  expect(diagnostic).toContain('1:/_/pdfjs/build/pdf.mjs ? recv-returned');
  expect(diagnostic).toContain('2:/_/pdfjs/build/pdf.mjs ? response-build-enter');
  expect(diagnostic).toContain('3:/_/pdfjs/build/pdf.mjs 200 respond-enter len=99');
  expect(diagnostic).toContain('4:/_/pdfjs/build/pdf.mjs 200 respond-returned:ok');
  expect(diagnostic).not.toMatch(/delivered|aborted|sent/);
});
test('early client and server observations survive later errors and teardown', () => {
  const state = {...pending,frameStages:['start'] as PdfStage[],frameServed:{registryAvailable:true,html:1,agent:2,resource:3,last:[request],server}};
  const early = captureFrameObservation(state,8000);
  state.frameStages.push('initializedPromise'); state.frameServed.last[0].builtAtMs=9;
  expect(early.stages).toEqual(['start']); expect(early.served?.last[0].builtAtMs).toBeNull();
  const target:{frameTeardown:null|{atMs:number;reason:'deadline'|'agent-error'|'isolation-broken'}}={frameTeardown:null};
  markFrameTeardown(target,'deadline',30000); markFrameTeardown(target,'agent-error',30001);
  expect(target.frameTeardown).toEqual({atMs:30000,reason:'deadline'});
  const output=frameDiagnostic({...state,frameEarly:early,...target,frameUrlPort:'1',frameLoaded:false,frameReady:false,frameError:'failed'});
  expect(output).toContain('"atMs":8000'); expect(output).toContain('"atMs":30000,"reason":"deadline"');
});

test('frame errors never expose document URLs or tokens in the diagnostic line', () => {
  const token = 'ab'.repeat(32);
  const diagnostic = frameDiagnostic({...pending, frameUrlPort:'43123', frameLoaded:false, frameReady:false,
    frameError:`failed http://127.0.0.1:43123/${token}/?g=1\nsecret ${token}`});
  expect(diagnostic).toBe('(frame: url ok, port 43123, load no, ready no, error failed [url] secret [token], served unknown, csp -, agent start no, stage -, last: -, stall -, orientation -)');
  expect(diagnostic).not.toContain(token);
});

test('request counts, parent CSP and agent start distinguish the second timeout stage without URLs', () => {
  const frame = {} as Window;
  const token = 'cd'.repeat(32);
  const data = {type:'agentStart', ignored:token, load:'?g=0&x=0'};
  expect(frameMessage({source:frame, data}, frame, data.load)).toEqual({type:'agentStart'});
  expect(frameMessage({source:{} as Window, data}, frame, data.load)).toBeNull();
  const csp = parentCspViolation('frame-src', `http://127.0.0.1:46199/${token}/?g=0`);
  expect(csp).toBe('frame-src port 46199');
  expect(parentCspViolation('script-src-elem', 'inline')).toBe('script-src-elem inline');
  expect(parentCspViolation(token, token)).toBe('unknown blocked');
  const diagnostic = frameDiagnostic({frameUrlPort:'46199', frameLoaded:true, frameReady:false, frameError:null,
    frameServed:{registryAvailable:true,html:1, agent:1, resource:2,last:[],server}, frameCsp:[csp], frameAgentStarted:true, frameStages:[],frameStall:null,frameOrientation:null});
  expect(diagnostic).toContain('served html 1 agent 1 resource 2, csp frame-src port 46199, agent start yes');
  expect(diagnostic).not.toContain(token);
  expect(diagnostic).not.toContain('http');
});

test('PDF timeout retains the stages in arrival order and error detail without document credentials', () => {
  const token = 'ab'.repeat(32);
  expect(frameDiagnostic({...pending,frameUrlPort:'43123',frameLoaded:true,frameReady:false,frameStages:['start','webviewerloaded','worker-start'],
    frameError:`PDF failed (detail Failed to import http://127.0.0.1:43123/${token}/_/pdfjs/build/pdf.worker.mjs\n${token})`}))
    .toBe('(frame: url ok, port 43123, load yes, ready no, error PDF failed (detail Failed to import [url] [token]), served unknown, csp -, agent start no, stage start>webviewerloaded>worker-start, last: -, stall -, orientation -)');
});
