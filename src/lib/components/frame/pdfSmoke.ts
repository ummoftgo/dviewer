import {tick} from 'svelte';
import {workspace,type DocTab} from '../../state/docs.svelte';
import {waitSearch} from '../markdown/searchSmoke';

const require = (ok: unknown, why: string) => { if (!ok) throw new Error(why); };
export async function checkPdfFrame(tab: DocTab, orientation: false | 'text' | 'image' | 'upright' = false) {
  const image = orientation === 'image' || orientation === 'upright';
  const expectedRotation = orientation === 'image' ? 270 : orientation === 'text' ? 90 : 0;
  let detectedRotation:number|undefined, reversedRotation:number|undefined;
  await waitSearch(() => tab.frameReady && tab.framePages === 2 && tab.frameProbe !== null,'PDF pages or probe missing',15000);
  require(tab.frameProbe === 'absent' || tab.frameProbe?.startsWith('rejected:'),'PDF isolation probe failed');
  if (orientation) {
    await waitSearch(() => tab.frameRotation !== undefined,'PDF orientation response missing');
    detectedRotation=tab.frameRotation;
    // The probe's own verdict travels with every failure, so a refusal says whether it was slow, grey or split.
    const verdict = `orientation ${JSON.stringify(tab.frameOrientation)}`;
    require(tab.frameRotation === expectedRotation && tab.frameAutoRotation === (expectedRotation !== 0),
      `PDF orientation mismatch: expected ${expectedRotation}, got ${tab.frameRotation}, auto ${tab.frameAutoRotation}; ${verdict}`);
    if (image) require(tab.frameOrientation?.reason === (orientation === 'image' ? 'sideways' : 'upright'),`PDF image probe did not see the fixture's lines; ${verdict}`);
    await tick();
    if (expectedRotation) require(document.querySelector(`[data-auto-rotation="${expectedRotation}"]`),'PDF automatic rotation status missing');
    else require(!document.querySelector('[data-auto-rotation]'),'Upright image was automatically rotated');
    require(tab.frameImageRotation === (orientation === 'image'),'PDF image correction provenance missing or incorrect');
  } else {
    require(tab.frameToc.length === 3 && tab.frameToc[1].text === 'Same page, another heading','PDF outline missing at ready');
    require(new Set(tab.frameToc.map(item => item.id)).size === 3,'PDF outline ids collided on the same page');
  }
  const frame = document.querySelector<HTMLIFrameElement>('.frame-layout iframe');
  require(frame?.contentWindow,'PDF iframe missing');
  frame!.contentWindow!.postMessage({type:'goto',page:2},'*');
  await waitSearch(() => tab.framePage === 2,'PDF goto page 2 did not complete');
  await waitSearch(() => tab.frameHasText === !image,'PDF text presence did not match fixture');
  if (!image) {
    const request = ++tab.frameSearch.request;
    frame!.contentWindow!.postMessage({type:'find',q:'needle',dir:1,request},'*');
    await waitSearch(() => tab.frameSearch.n >= 1,'PDF find needle did not match');
  }
  require(tab.savedPosition?.kind === 'pdf','PDF page position was not retained');
  if (orientation && expectedRotation) {
    require(tab.savedPosition?.kind === 'pdf' && tab.savedPosition.rotation === expectedRotation,'PDF automatic rotation was not retained');
    if (orientation === 'image') {
      const reverse = document.querySelector<HTMLButtonElement>('[data-action="pdf-rotation-reverse"]');
      require(reverse && document.querySelector('[data-image-rotation="true"]'),'PDF image correction controls missing');
      reverse!.click();
      await waitSearch(() => tab.frameRotation === 90 && !tab.frameAutoRotation,'PDF reverse did not complete');
      reversedRotation=tab.frameRotation;
      await tick();
      require(tab.framePage === 2 && tab.frameImageRotation,'PDF reverse lost page or undo controls');
      require(tab.savedPosition?.kind === 'pdf' && tab.savedPosition.rotation === 90,'PDF reversed direction was not retained');
    }
    const reset = document.querySelector<HTMLButtonElement>('[data-action="pdf-rotation-reset"]');
    require(reset,'PDF rotation reset button missing');
    reset!.click();
    await waitSearch(() => tab.frameRotation === 0 && !tab.frameAutoRotation,'PDF rotation reset did not complete');
    await tick();
    require(!document.querySelector('[data-auto-rotation]'),'PDF automatic rotation status survived reset');
    require(tab.framePage === 2 && tab.savedPosition?.kind === 'pdf' && tab.savedPosition.rotation === 0,'PDF reset lost the page or explicit zero rotation');
  }
  const metrics = {pages:tab.framePages,page:tab.framePage,headings:tab.frameToc.length,matches:tab.frameSearch.n,probe:tab.frameProbe,
    rotation:tab.frameRotation,autoRotation:tab.frameAutoRotation,imageRotation:tab.frameImageRotation,detectedRotation,reversedRotation,
    orientation:tab.frameOrientation};
  await workspace.close(tab.id); await tick();
  require(!frame!.isConnected,'PDF iframe survived closing its tab');
  return metrics;
}
