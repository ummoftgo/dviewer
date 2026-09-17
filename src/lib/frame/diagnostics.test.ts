import {expect, test} from 'vitest';
import {frameDiagnostic, parentCspViolation} from './diagnostics';
import {frameMessage} from './messages';

const pending = {frameServed:null, frameCsp:[], frameAgentStarted:false, frameStage:null, frameStall:null};

test('frame timeouts distinguish URL failure, missing load and missing agent ready', () => {
  const state = {...pending, frameUrlPort:null, frameLoaded:false, frameReady:false, frameError:null};
  expect(frameDiagnostic(state)).toBe('(frame: url not issued, load no, ready no, error -, served unknown, csp -, agent start no, stage -, last: -, stall -)');
  expect(frameDiagnostic({...state, frameError:'server unavailable'}))
    .toBe('(frame: url not issued, load no, ready no, error server unavailable, served unknown, csp -, agent start no, stage -, last: -, stall -)');
  expect(frameDiagnostic({...state, frameUrlPort:'43123'}))
    .toBe('(frame: url ok, port 43123, load no, ready no, error -, served unknown, csp -, agent start no, stage -, last: -, stall -)');
  expect(frameDiagnostic({...state, frameUrlPort:'43123', frameLoaded:true, frameError:'HTML 문서를 표시하지 못했습니다.'}))
    .toBe('(frame: url ok, port 43123, load yes, ready no, error HTML 문서를 표시하지 못했습니다., served unknown, csp -, agent start no, stage -, last: -, stall -)');
});

test('frame errors never expose document URLs or tokens in the diagnostic line', () => {
  const token = 'ab'.repeat(32);
  const diagnostic = frameDiagnostic({...pending, frameUrlPort:'43123', frameLoaded:false, frameReady:false,
    frameError:`failed http://127.0.0.1:43123/${token}/?g=1\nsecret ${token}`});
  expect(diagnostic).toBe('(frame: url ok, port 43123, load no, ready no, error failed [url] secret [token], served unknown, csp -, agent start no, stage -, last: -, stall -)');
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
    frameServed:{html:1, agent:1, resource:2,last:[]}, frameCsp:[csp], frameAgentStarted:true, frameStage:null,frameStall:null});
  expect(diagnostic).toBe('(frame: url ok, port 46199, load yes, ready no, error -, served html 1 agent 1 resource 2, csp frame-src port 46199, agent start yes, stage -, last: -, stall -)');
  expect(diagnostic).not.toContain(token);
  expect(diagnostic).not.toContain('http');
});

test('PDF timeout retains the last stage and error detail without document credentials', () => {
  const token = 'ab'.repeat(32);
  expect(frameDiagnostic({...pending,frameUrlPort:'43123',frameLoaded:true,frameReady:false,frameStage:'worker-start',
    frameError:`PDF failed (detail Failed to import http://127.0.0.1:43123/${token}/_/pdfjs/build/pdf.worker.mjs\n${token})`}))
    .toBe('(frame: url ok, port 43123, load yes, ready no, error PDF failed (detail Failed to import [url] [token]), served unknown, csp -, agent start no, stage worker-start, last: -, stall -)');
});
