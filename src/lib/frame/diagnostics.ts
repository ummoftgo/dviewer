import type {DocTab} from '../state/docs.svelte';

export function parentCspViolation(directive: string, blockedURI: string): string {
  const name = /^[a-z-]{1,32}$/.test(directive) ? directive : 'unknown';
  let target = ['inline', 'eval', 'self'].includes(blockedURI) ? blockedURI : 'blocked';
  try { target = `port ${new URL(blockedURI).port || 'default'}`; } catch { /* No raw URI enters diagnostics. */ }
  return `${name} ${target}`;
}

/** Keep document URLs and their bearer tokens out of CI failure output. */
export function frameDiagnostic(tab: Pick<DocTab, 'frameUrlPort' | 'frameLoaded' | 'frameReady' | 'frameError' | 'frameServed' | 'frameCsp' | 'frameAgentStarted'>): string {
  const error = (tab.frameError ?? '-')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b[a-f\d]{64}\b/gi, '[token]')
    .replace(/[\r\n]+/g, ' ').slice(0, 1024);
  const served = tab.frameServed;
  return `(frame: url ${tab.frameUrlPort === null ? 'not issued' : `ok, port ${tab.frameUrlPort}`}, load ${tab.frameLoaded ? 'yes' : 'no'}, ready ${tab.frameReady ? 'yes' : 'no'}, error ${error}, served ${served ? `html ${served.html} agent ${served.agent} resource ${served.resource}` : 'unknown'}, csp ${tab.frameCsp.join(' | ') || '-'}, agent start ${tab.frameAgentStarted ? 'yes' : 'no'})`;
}
