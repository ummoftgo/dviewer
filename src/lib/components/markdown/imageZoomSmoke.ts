import { settings } from '../../state/settings.svelte';
import { waitSearch } from './searchSmoke';
import { enhanceImageZoom } from './imageZoomControls';

const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const opened = () => document.querySelector<HTMLDialogElement>('dialog[data-image-zoom][open]');

/** Runs in the actual webview. No copied raster, extra Mermaid render, or component test DOM. */
export async function checkImageZoom(): Promise<void> {
  const root = document.querySelector<HTMLElement>('article.markdown-body')!;
  const scroller = root.closest<HTMLElement>('.scroller')!;
  const startingScroll = scroller.scrollTop;
  try {
    const sources = [root.querySelector<SVGSVGElement>('.mermaid-block svg')!, root.querySelector<HTMLImageElement>('img:not(.img-missing)')!];
    for (const source of sources) {
      require(source, 'image zoom source is missing');
      source.scrollIntoView({block:'center'});
      if (source instanceof HTMLImageElement) await waitSearch(() => source.complete && source.naturalWidth > 0, 'local image did not load');
      await frame();
      for (let repeat = 0; repeat < 3; repeat++) {
        source.focus({preventScroll:true});
        const top = scroller.scrollTop, style = source.getAttribute('style');
        // Exercise both discoverable click and keyboard opening.
        if (repeat === 1) source.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
        else source.dispatchEvent(new MouseEvent('click',{button:0,bubbles:true,cancelable:true}));
        await waitSearch(() => !!opened(), 'image zoom did not open');
        const dialog = opened()!;
        require(dialog.contains(source), 'zoom cloned or reloaded the source instead of borrowing it');
        require(!!root.querySelector('[data-dviewer-ui="image-zoom-placeholder"]'), 'zoom removed the reading layout');
        dialog.querySelector<HTMLButtonElement>('[data-action="actual"]')!.click();
        await frame();
        require(dialog.querySelector('output')?.textContent === '100%', 'actual size was not 100%');
        dialog.querySelector<HTMLButtonElement>('[data-action="in"]')!.click();
        await frame();
        require(dialog.querySelector('output')?.textContent === '125%', 'zoom button did not increase scale');
        dialog.querySelector<HTMLButtonElement>('[data-action="fit"]')!.click();
        await frame();
        require(Number(dialog.querySelector('output')!.textContent!.replace('%','')) <= 100, 'fit enlarged a small image');
        if (repeat === 1) dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
        else dialog.querySelector<HTMLButtonElement>('[data-action="close"]')!.click();
        await waitSearch(() => !opened() && root.contains(source), 'zoom did not return the original source');
        require(source.getAttribute('style') === style, 'zoom changed source styling');
        require(!root.querySelector('[data-dviewer-ui="image-zoom-placeholder"]'), 'zoom leaked its placeholder');
        require(scroller.scrollTop === top && document.activeElement === source, 'zoom lost reading scroll or keyboard focus');
      }
    }
    // Enhancement cleanup also applies to nodes carrying author attributes.
    const isolated = document.createElement('article');
    isolated.innerHTML = '<img role="img" tabindex="-1" title="Original" aria-label="Original label">';
    const image = isolated.querySelector('img')!;
    let calls = 0;
    const handle = enhanceImageZoom(isolated, () => { calls++; });
    handle.destroy();
    image.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    require(calls === 0 && image.getAttribute('role') === 'img' && image.getAttribute('tabindex') === '-1'
      && image.title === 'Original' && image.getAttribute('aria-label') === 'Original label' && !image.hasAttribute('data-dviewer-zoom'),
      'zoom enhancement did not restore attributes/listeners');
    const missing = root.querySelector<HTMLImageElement>('img.img-missing');
    if (missing) {
      missing.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      await frame();
      require(!opened(), 'a broken image opened an empty zoom');
    }
  } finally {
    opened()?.close();
    await frame();
    scroller.scrollTop = startingScroll;
  }
}

export async function checkImageZoomThemeCleanup(): Promise<void> {
  const theme = settings.theme;
  try {
    const source = document.querySelector<SVGSVGElement>('article.markdown-body .mermaid-block svg')!;
    source.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    await waitSearch(() => !!opened(), 'theme cleanup zoom did not open');
    settings.theme = settings.resolvedTheme === 'dark' ? 'light' : 'dark';
    await waitSearch(() => !opened() && !!document.querySelector('main [data-position-ready="true"] .mermaid-block svg'), 'theme update kept a stale image zoom');
  } finally {
    settings.theme = theme;
    await waitSearch(() => !!document.querySelector('main [data-position-ready="true"] .mermaid-block svg'), 'restored theme did not render');
  }
}
