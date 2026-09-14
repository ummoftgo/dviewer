import {tick} from 'svelte';
import {docLines, frameServed, type FrameServed} from '../../ipc';
import type {DocTab} from '../../state/docs.svelte';
import {waitSearch} from '../markdown/searchSmoke';

export async function checkHtmlFrame(tab: DocTab): Promise<{probe: string | null; headings: number; matches: number; scriptRan: boolean; moduleRan: boolean; fontLoaded: boolean; rawLines: number; afterUnmount: FrameServed; afterIdle: FrameServed; idleMs: number}> {
  const require = (ok: unknown, why: string) => {if(!ok)throw new Error(why);};
  await waitSearch(() => tab.frameReady && tab.frameProbe !== null && tab.frameBlocked > 0, 'HTML readiness, probe or blocked resource missing', 15000);
  require(tab.frameToc.length === 3,'HTML heading count changed');
  require(tab.frameProbe === 'absent' || tab.frameProbe?.startsWith('rejected:'),'HTML isolation probe was executed or timed out');
  const frame = document.querySelector<HTMLIFrameElement>('.frame-layout iframe');
  require(frame?.contentWindow,'HTML iframe missing');
  let details: {scriptRan?: boolean; moduleRan?: boolean; fontLoaded?: boolean} | undefined;
  const receive = (event: MessageEvent) => {
    if(event.source === frame!.contentWindow && event.data?.type === 'fixture-check') details=event.data;
  };
  addEventListener('message',receive);
  try {
    frame!.contentWindow!.postMessage({type:'fixture-check'},'*');
    await waitSearch(() => !!details,'HTML fixture did not answer',10000);
    require(details?.scriptRan && details.moduleRan && details.fontLoaded,'HTML inline script, module or local font did not load');
    const request=++tab.frameSearch.request;
    frame!.contentWindow!.postMessage({type:'find',q:'needle',dir:1,request},'*');
    await waitSearch(() => tab.frameSearch.n >= 1,'HTML find did not return a match');
    tab.mode='raw'; await tick();
    await waitSearch(() => !!document.querySelector('.text-raw-view .line-text'),'HTML source did not use the line-indexed view');
    const page=await docLines(tab.id,0,5);
    require(page.lines?.some(line=>line.includes('doctype')),'HTML source lines missing');
    require(!frame!.isConnected && !document.querySelector('.frame-layout iframe'),'HTML iframe survived source switch');
    const afterUnmount = await frameServed(tab.id);
    const started = performance.now();
    // An observation window for late requests, not a rendering readiness delay.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const afterIdle = await frameServed(tab.id);
    const idleMs = Math.round(performance.now() - started);
    require(afterUnmount.html === afterIdle.html && afterUnmount.agent === afterIdle.agent && afterUnmount.resource === afterIdle.resource,
      `HTML requests continued after unmount: ${JSON.stringify({afterUnmount, afterIdle, idleMs})}`);
    return {probe:tab.frameProbe,headings:tab.frameToc.length,matches:tab.frameSearch.n,scriptRan:!!details?.scriptRan,moduleRan:!!details?.moduleRan,fontLoaded:!!details?.fontLoaded,rawLines:page.total,afterUnmount,afterIdle,idleMs};
  } finally {
    removeEventListener('message',receive);
    // Leave the smoke document unmounted rather than creating another iframe.
  }
}
