import type {DocTab} from '../state/docs.svelte';

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

export function frameDiagnostic(tab: Pick<DocTab, 'frameUrlPort' | 'frameLoaded' | 'frameReady' | 'frameError' | 'frameServed' | 'frameCsp' | 'frameAgentStarted' | 'frameStage' | 'frameStall' | 'frameOrientation'>): string {
  const clean = frameDiagnosticText;
  const served = tab.frameServed;
  const last = served?.last.map(item => `${item.sequence}:${item.path} ${item.status}`).join(', ') || '-';
  return `(frame: url ${tab.frameUrlPort === null ? 'not issued' : `ok, port ${tab.frameUrlPort}`}, load ${tab.frameLoaded ? 'yes' : 'no'}, ready ${tab.frameReady ? 'yes' : 'no'}, error ${clean(tab.frameError ?? '-')}, served ${served ? `html ${served.html} agent ${served.agent} resource ${served.resource}` : 'unknown'}, csp ${tab.frameCsp.join(' | ') || '-'}, agent start ${tab.frameAgentStarted ? 'yes' : 'no'}, stage ${tab.frameStage ?? '-'}, last: ${clean(last)}, stall ${clean(tab.frameStall ? JSON.stringify(tab.frameStall) : '-',8192)}, orientation ${tab.frameOrientation ? JSON.stringify(tab.frameOrientation) : '-'})`;
}
