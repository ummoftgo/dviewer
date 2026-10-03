<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../i18n';
  import { clampImage, fitImage, validImageSize, zoomImage, type ImageSize, type ImageTransform } from './imageZoom';
  import type { ZoomSource } from './imageZoomControls';

  let { source, scroller, onClose }: { source: ZoomSource; scroller: HTMLElement; onClose: () => void } = $props();
  let dialog: HTMLDialogElement;
  let stage: HTMLDivElement;
  let content: HTMLDivElement;
  let size = $state<ImageSize>({ width: 1, height: 1 });
  let viewport: ImageSize = { width: 1, height: 1 };
  let transform = $state<ImageTransform>({ scale: 1, x: 0, y: 0 });
  let fitting = true;
  let drag = $state<{pointer: number; x: number; y: number; transform: ImageTransform} | null>(null);
  let release: (() => void) | undefined;

  function fit() { fitting = true; transform = fitImage(size, viewport); }
  function actual() { fitting = false; transform = { scale: 1, x: 0, y: 0 }; }
  function zoom(factor: number, anchor?: {x: number; y: number}) {
    fitting = false;
    transform = zoomImage(transform, factor, size, viewport, anchor);
  }
  function endDrag() {
    const pointer = drag?.pointer;
    drag = null;
    if (pointer !== undefined && stage.hasPointerCapture(pointer)) stage.releasePointerCapture(pointer);
  }
  function keydown(event: KeyboardEvent) {
    // Keep modal shortcuts from reaching document search/navigation/focus mode.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
    if (event.target instanceof HTMLButtonElement && ['Enter', ' '].includes(event.key)) return;
    if (['+', '=', '-', '0', 'f', 'F', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '+' || event.key === '=') zoom(1.25);
      else if (event.key === '-') zoom(0.8);
      else if (event.key === '0') actual();
      else if (event.key.toLowerCase() === 'f') fit();
      else {
        fitting = false;
        transform = clampImage({ ...transform, x: transform.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0),
          y: transform.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0) }, size, viewport);
      }
    }
  }

  onMount(() => {
    if (!source.isConnected) { onClose(); return; }
    const box = source.getBoundingClientRect();
    const viewBox = source instanceof SVGSVGElement ? source.viewBox.baseVal : null;
    size = source instanceof HTMLImageElement ? { width: source.naturalWidth, height: source.naturalHeight }
      : viewBox && viewBox.width > 0 && viewBox.height > 0 ? {width:viewBox.width,height:viewBox.height} : {width:box.width,height:box.height};
    if (!validImageSize(size)) { onClose(); return; }
    const top = scroller.scrollTop, left = scroller.scrollLeft;
    const focus = document.activeElement;
    const style = source.getAttribute('style');
    const tabindex = source.getAttribute('tabindex');
    const placeholder = document.createElement('span');
    placeholder.dataset.dviewerUi = 'image-zoom-placeholder';
    placeholder.style.cssText = `display:inline-block;width:${box.width}px;height:${box.height}px;max-width:100%;vertical-align:${getComputedStyle(source).verticalAlign}`;
    source.before(placeholder);
    content.append(source);
    source.setAttribute('tabindex', '-1');
    source.style.cssText += `;display:block;width:${size.width}px;height:${size.height}px;max-width:none;max-height:none;margin:0;`;
    release = () => {
      if (style === null) source.removeAttribute('style'); else source.setAttribute('style', style);
      if (tabindex === null) source.removeAttribute('tabindex'); else source.setAttribute('tabindex', tabindex);
      if (placeholder.isConnected) placeholder.replaceWith(source); else source.remove();
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus({preventScroll:true});
      else if (source.isConnected) source.focus({preventScroll:true});
      if (scroller.isConnected) { scroller.scrollTop = top; scroller.scrollLeft = left; }
    };
    dialog.showModal();
    const resize = new ResizeObserver(() => {
      viewport = {width:stage.clientWidth,height:stage.clientHeight};
      if (fitting) fit(); else transform = clampImage(transform, size, viewport);
    });
    viewport = {width:stage.clientWidth,height:stage.clientHeight};
    fit();
    resize.observe(stage);
    return () => { endDrag(); resize.disconnect(); release?.(); release = undefined; };
  });
</script>

<dialog bind:this={dialog} class="image-zoom" data-image-zoom aria-label={t('imageZoom.title')} onkeydown={keydown}
  onclose={() => { release?.(); release = undefined; onClose(); }}>
  <div class="toolbar">
    <button class="btn" data-action="fit" onclick={fit}>{t('imageZoom.fit')}</button>
    <button class="btn" data-action="actual" onclick={actual}>{t('imageZoom.actual')}</button>
    <button class="btn" data-action="out" aria-label={t('imageZoom.out')} title={t('imageZoom.out')} onclick={() => zoom(0.8)}>−</button>
    <output aria-live="polite">{Math.round(transform.scale * 1000) / 10}%</output>
    <button class="btn" data-action="in" aria-label={t('imageZoom.in')} title={t('imageZoom.in')} onclick={() => zoom(1.25)}>+</button>
    <button class="btn close" data-action="close" onclick={() => dialog.close()}>{t('imageZoom.close')}</button>
  </div>
  <div class="stage" class:dragging={drag !== null} bind:this={stage} role="application" tabindex="-1" aria-label={t('imageZoom.hint')}
    onwheel={event => { event.preventDefault(); const box = stage.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, {x:event.clientX-box.left-box.width/2,y:event.clientY-box.top-box.height/2}); }}
    onpointerdown={event => { if (event.button !== 0) return; event.preventDefault(); stage.focus();
      drag = {pointer:event.pointerId,x:event.clientX,y:event.clientY,transform}; stage.setPointerCapture(event.pointerId); }}
    onpointermove={event => { if (!drag || drag.pointer !== event.pointerId) return;
      fitting = false; transform = clampImage({...drag.transform,x:drag.transform.x+event.clientX-drag.x,y:drag.transform.y+event.clientY-drag.y},size,viewport); }}
    onpointerup={endDrag} onpointercancel={endDrag} onlostpointercapture={() => { drag = null; }}>
    <div class="content" bind:this={content} style:width={`${size.width}px`} style:height={`${size.height}px`}
      style:transform={`translate(-50%, -50%) translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`}></div>
  </div>
  <p class="hint">{t('imageZoom.hint')}</p>
</dialog>

<style>
  dialog { width: calc(100vw - 2rem); height: calc(100vh - 2rem); max-width: none; max-height: none;
    padding: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); color: var(--text); }
  dialog[open] { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
  dialog::backdrop { background: rgb(0 0 0 / 0.65); }
  .toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:0.4rem; padding:0.65rem; border-bottom:1px solid var(--border); }
  .close { margin-left:auto; }
  output { min-width:4rem; text-align:center; font-variant-numeric:tabular-nums; }
  .stage { position:relative; min-height:0; overflow:hidden; cursor:grab; touch-action:none; user-select:none; }
  .stage.dragging { cursor:grabbing; }
  .content { position:absolute; left:50%; top:50%; transform-origin:center; pointer-events:none; }
  .hint { margin:0; padding:0.5rem 0.75rem; color:var(--text-muted); border-top:1px solid var(--border); font-size:0.85em; }
</style>
