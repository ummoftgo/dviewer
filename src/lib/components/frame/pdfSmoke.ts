import {tick} from 'svelte';
import {workspace,type DocTab} from '../../state/docs.svelte';
import {waitSearch} from '../markdown/searchSmoke';

const require = (ok: unknown, why: string) => { if (!ok) throw new Error(why); };
export async function checkPdfFrame(tab: DocTab, orientation = false) {
  await waitSearch(() => tab.frameReady && tab.framePages === 2 && tab.frameProbe !== null,'PDF pages or probe missing',15000);
  require(tab.frameProbe === 'absent' || tab.frameProbe?.startsWith('rejected:'),'PDF isolation probe failed');
  if (orientation) {
    await waitSearch(() => tab.frameRotation === 90 && tab.frameAutoRotation,'PDF automatic rotation did not complete');
    await tick();
    require(document.querySelector('[data-auto-rotation="90"]'),'PDF automatic rotation status missing');
  } else {
    require(tab.frameToc.length === 3 && tab.frameToc[1].text === 'Same page, another heading','PDF outline missing at ready');
    require(new Set(tab.frameToc.map(item => item.id)).size === 3,'PDF outline ids collided on the same page');
  }
  const frame = document.querySelector<HTMLIFrameElement>('.frame-layout iframe');
  require(frame?.contentWindow,'PDF iframe missing');
  frame!.contentWindow!.postMessage({type:'goto',page:2},'*');
  await waitSearch(() => tab.framePage === 2,'PDF goto page 2 did not complete');
  await waitSearch(() => tab.frameHasText === true,'PDF text layer missing');
  const request = ++tab.frameSearch.request;
  frame!.contentWindow!.postMessage({type:'find',q:'needle',dir:1,request},'*');
  await waitSearch(() => tab.frameSearch.n >= 1,'PDF find needle did not match');
  require(tab.savedPosition?.kind === 'pdf','PDF page position was not retained');
  if (orientation) {
    require(tab.savedPosition?.kind === 'pdf' && tab.savedPosition.rotation === 90,'PDF automatic rotation was not retained');
    const reset = document.querySelector<HTMLButtonElement>('[data-action="pdf-rotation-reset"]');
    require(reset,'PDF rotation reset button missing');
    reset!.click();
    await waitSearch(() => tab.frameRotation === 0 && !tab.frameAutoRotation,'PDF rotation reset did not complete');
    await tick();
    require(!document.querySelector('[data-auto-rotation]'),'PDF automatic rotation status survived reset');
    require(tab.framePage === 2 && tab.savedPosition?.kind === 'pdf' && tab.savedPosition.rotation === 0,'PDF reset lost the page or explicit zero rotation');
  }
  const metrics = {pages:tab.framePages,page:tab.framePage,headings:tab.frameToc.length,matches:tab.frameSearch.n,probe:tab.frameProbe,
    rotation:tab.frameRotation,autoRotation:tab.frameAutoRotation};
  await workspace.close(tab.id); await tick();
  require(!frame!.isConnected,'PDF iframe survived closing its tab');
  return metrics;
}
