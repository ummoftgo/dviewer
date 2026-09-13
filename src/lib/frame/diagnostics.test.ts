import {expect, test} from 'vitest';
import {frameDiagnostic} from './diagnostics';

test('frame timeouts distinguish URL failure, missing load and missing agent ready', () => {
  const state = {frameUrlPort:null, frameLoaded:false, frameReady:false, frameError:null};
  expect(frameDiagnostic(state)).toBe('(frame: url not issued, load no, ready no, error -)');
  expect(frameDiagnostic({...state, frameError:'server unavailable'}))
    .toBe('(frame: url not issued, load no, ready no, error server unavailable)');
  expect(frameDiagnostic({...state, frameUrlPort:'43123'}))
    .toBe('(frame: url ok, port 43123, load no, ready no, error -)');
  expect(frameDiagnostic({...state, frameUrlPort:'43123', frameLoaded:true, frameError:'HTML 문서를 표시하지 못했습니다.'}))
    .toBe('(frame: url ok, port 43123, load yes, ready no, error HTML 문서를 표시하지 못했습니다.)');
});

test('frame errors never expose document URLs or tokens in the diagnostic line', () => {
  const token = 'ab'.repeat(32);
  const diagnostic = frameDiagnostic({frameUrlPort:'43123', frameLoaded:false, frameReady:false,
    frameError:`failed http://127.0.0.1:43123/${token}/?g=1\nsecret ${token}`});
  expect(diagnostic).toBe('(frame: url ok, port 43123, load no, ready no, error failed [url] secret [token])');
  expect(diagnostic).not.toContain(token);
});
