import {expect, test} from 'vitest';
import {frameDiagnostic, parentCspViolation} from './diagnostics';
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

// A request with no entry never reached the server; one marked pending was built but its
// response never finished writing; aborted means the page went away first.
test('the request list says which responses were still being written or cut off', () => {
  const last=[{sequence:4,path:'/_/pdfjs/build/pdf.mjs',status:200,sent:true},{sequence:5,path:'/_/pdfjs/web/viewer.css',status:200,sent:null},
    {sequence:6,path:'/_/pdfjs/web/images/a.svg',status:200,sent:false},{sequence:7,path:'/_/old.js',status:200}];
  const diagnostic=frameDiagnostic({...pending,frameUrlPort:'1',frameLoaded:false,frameReady:false,frameError:null,frameServed:{html:1,agent:2,resource:3,last}});
  expect(diagnostic).toContain('last: 4:/_/pdfjs/build/pdf.mjs 200, 5:/_/pdfjs/web/viewer.css 200 pending, 6:/_/pdfjs/web/images/a.svg 200 aborted, 7:/_/old.js 200,');
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
    frameServed:{html:1, agent:1, resource:2,last:[]}, frameCsp:[csp], frameAgentStarted:true, frameStages:[],frameStall:null,frameOrientation:null});
  expect(diagnostic).toBe('(frame: url ok, port 46199, load yes, ready no, error -, served html 1 agent 1 resource 2, csp frame-src port 46199, agent start yes, stage -, last: -, stall -, orientation -)');
  expect(diagnostic).not.toContain(token);
  expect(diagnostic).not.toContain('http');
});

test('PDF timeout retains the stages in arrival order and error detail without document credentials', () => {
  const token = 'ab'.repeat(32);
  expect(frameDiagnostic({...pending,frameUrlPort:'43123',frameLoaded:true,frameReady:false,frameStages:['start','webviewerloaded','worker-start'],
    frameError:`PDF failed (detail Failed to import http://127.0.0.1:43123/${token}/_/pdfjs/build/pdf.worker.mjs\n${token})`}))
    .toBe('(frame: url ok, port 43123, load yes, ready no, error PDF failed (detail Failed to import [url] [token]), served unknown, csp -, agent start no, stage start>webviewerloaded>worker-start, last: -, stall -, orientation -)');
});
