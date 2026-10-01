import type {DocTab} from '../state/docs.svelte';
import type {FrameServed, FrameRequest} from '../ipc';
import type {FrameStall} from './messages';

export interface FrameObservation {
  atMs:number; serverAtMs:number|null; stall:FrameStall|null; served:FrameServed|null; stages:string[];
}
export interface FrameTeardown { atMs:number; reason:'deadline'|'agent-error'|'isolation-broken' }

export function captureFrameObservation(tab: Pick<DocTab,'frameStall'|'frameServed'|'frameStages'>, atMs = Date.now()): FrameObservation {
  // Owned snapshot: later messages/counters must not turn an 8s observation into a 30s one.
  return JSON.parse(JSON.stringify({atMs,serverAtMs:null,stall:tab.frameStall,served:tab.frameServed,stages:tab.frameStages}));
}
export function markFrameTeardown(tab: Pick<DocTab,'frameTeardown'>, reason:FrameTeardown['reason'], atMs = Date.now()): void {
  tab.frameTeardown ??= {atMs,reason};
}
export function parentCspViolation(directive: string, blockedURI: string): string {
  const name = /^[a-z-]{1,32}$/.test(directive) ? directive : 'unknown';
  let target = ['inline', 'eval', 'self'].includes(blockedURI) ? blockedURI : 'blocked';
  try { target = `port ${new URL(blockedURI).port || 'default'}`; } catch { /* No raw URI enters diagnostics. */ }
  return `${name} ${target}`;
}

/** Keep document URLs and their bearer tokens out of CI failure output. */
export function frameDiagnosticText(value: string, limit = 4096): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/[a-f\d]{64}/gi, '[token]')
    .replace(/[\r\n]+/g, ' ').slice(0, limit);
}
function requestDiagnostic(item:FrameRequest): string {
  const phase = item.respondReturnedAtMs !== null ? `respond-returned:${item.respondResult}`
    : item.respondEnteredAtMs !== null ? 'respond-enter' : item.builtAtMs !== null ? 'response-built'
    : item.buildEnteredAtMs !== null ? 'response-build-enter' : 'recv-returned';
  return `${item.sequence}:${item.path} ${item.status ?? '?'} ${phase} len=${item.contentLength ?? '?'}${item.respondErrorKind ? `:${item.respondErrorKind}` : ''}`;
}
function health(served:FrameServed|null) {
  if (!served) return null;
  const {requests,...worker} = served.server;
  // Preserve unassociated requests too: these are the observations before token locks.
  return {...worker,requests:requests.filter(item => item.docId === null || item.sequence === worker.activeRequestId).slice(-8)};
}
function earlyDiagnostic(early:FrameObservation|null|undefined) {
  if (!early) return null;
  return {...early,served:early.served ? {registryAvailable:early.served.registryAvailable,html:early.served.html,agent:early.served.agent,resource:early.served.resource,
    last:early.served.last,server:health(early.served)} : null};
}
export function frameDiagnostic(tab: Pick<DocTab, 'frameUrlPort' | 'frameLoaded' | 'frameReady' | 'frameError' | 'frameServed' | 'frameCsp' | 'frameAgentStarted' | 'frameStages' | 'frameStall' | 'frameOrientation'> & Partial<Pick<DocTab,'frameEarly'|'frameTeardown'>>): string {
  const clean = frameDiagnosticText;
  const served = tab.frameServed;
  // tiny_http may return Ok after a peer disconnect. No result here proves delivery.
  const last = served?.last.map(requestDiagnostic).join(', ') || '-';
  const extra = `${served ? `, worker ${JSON.stringify(health(served))}` : ''}${tab.frameEarly ? `, early ${JSON.stringify(earlyDiagnostic(tab.frameEarly))}` : ''}${tab.frameTeardown ? `, teardown ${JSON.stringify(tab.frameTeardown)}` : ''}`;
  return clean(`(frame: url ${tab.frameUrlPort === null ? 'not issued' : `ok, port ${tab.frameUrlPort}`}, load ${tab.frameLoaded ? 'yes' : 'no'}, ready ${tab.frameReady ? 'yes' : 'no'}, error ${clean(tab.frameError ?? '-')}, served ${served ? served.registryAvailable ? `html ${served.html} agent ${served.agent} resource ${served.resource}` : 'registry unavailable' : 'unknown'}, csp ${tab.frameCsp.join(' | ') || '-'}, agent start ${tab.frameAgentStarted ? 'yes' : 'no'}, stage ${tab.frameStages.join('>') || '-'}, last: ${last}, stall ${tab.frameStall ? JSON.stringify(tab.frameStall) : '-'}, orientation ${tab.frameOrientation ? JSON.stringify(tab.frameOrientation) : '-'}${extra})`,65536);
}
