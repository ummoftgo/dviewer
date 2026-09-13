import type {DocTab} from '../state/docs.svelte';

/** Keep document URLs and their bearer tokens out of CI failure output. */
export function frameDiagnostic(tab: Pick<DocTab, 'frameUrlPort' | 'frameLoaded' | 'frameReady' | 'frameError'>): string {
  const error = (tab.frameError ?? '-')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b[a-f\d]{64}\b/gi, '[token]')
    .replace(/[\r\n]+/g, ' ').slice(0, 1024);
  return `(frame: url ${tab.frameUrlPort === null ? 'not issued' : `ok, port ${tab.frameUrlPort}`}, load ${tab.frameLoaded ? 'yes' : 'no'}, ready ${tab.frameReady ? 'yes' : 'no'}, error ${error})`;
}
