import { tick } from 'svelte';
import { settings, type ThemeMode } from '../../state/settings.svelte';
import { waitSearch } from './searchSmoke';
import { enhanceImageZoom } from './imageZoomControls';

const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const opened = () => document.querySelector<HTMLDialogElement>('dialog[data-image-zoom][open]');

function sourceDiagnostics(root: HTMLElement): string {
  return JSON.stringify({
    connected: root.isConnected,
    diagrams: root.querySelectorAll('.mermaid-block svg').length,
    images: [...root.querySelectorAll('img')].map(image => ({
      original: image.dataset.dviewerSrc,
      src: image.getAttribute('src'),
      missing: image.classList.contains('img-missing'),
      complete: image.complete,
      width: image.naturalWidth,
      height: image.naturalHeight,
    })),
  });
}

/** Runs in the actual webview. No copied raster, extra Mermaid render, or component test DOM. */
export async function checkImageZoom(): Promise<void> {
  const root = document.querySelector<HTMLElement>('article.markdown-body')!;
  const scroller = root.closest<HTMLElement>('.scroller')!;
  const startingScroll = scroller.scrollTop;
  try {
    // Identify the intended fixture even if loading failed, so the report can
    // distinguish an absent DOM source from a broken file/asset-protocol load.
    const sources = [
      { name: 'Mermaid SVG', source: root.querySelector<SVGSVGElement>('.mermaid-block svg') },
      { name: 'local image ./icon.png', source: root.querySelector<HTMLImageElement>('img[data-dviewer-src="./icon.png"]') },
    ];
    for (const { name, source } of sources) {
      if (!source) throw new Error(`image zoom ${name} source is missing: ${sourceDiagnostics(root)}`);
      source.scrollIntoView({block:'center'});
      if (source instanceof HTMLImageElement) {
        try {
          await waitSearch(() => source.classList.contains('img-missing') || (source.complete && source.naturalWidth > 0),
            `image zoom ${name} did not finish loading`);
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : error}: ${sourceDiagnostics(root)}`);
        }
        require(!source.classList.contains('img-missing') && source.naturalWidth > 0 && source.naturalHeight > 0,
          `image zoom ${name} failed to load: ${sourceDiagnostics(root)}`);
      }
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

/** A ready node from the previous theme is not evidence of the next render. */
export function imageThemeRenderReady<T>(previous: T | null, current: T | null, changed: boolean, zoomOpen: boolean): boolean {
  return !zoomOpen && current !== null && (!changed || current !== previous);
}

async function changeThemeAndWait(theme: ThemeMode, message: string): Promise<void> {
  const previous = document.querySelector<SVGSVGElement>('article.markdown-body .mermaid-block svg')
    ?? opened()?.querySelector<SVGSVGElement>('svg') ?? null;
  const resolved = settings.resolvedTheme;
  settings.theme = theme;
  const changed = settings.resolvedTheme !== resolved;
  // Effects replace the article HTML, then asynchronously render both Mermaid
  // and KaTeX. Before this flush the old theme still advertises itself as ready.
  await tick();
  await waitSearch(() => imageThemeRenderReady(previous,
    document.querySelector<SVGSVGElement>('main [data-position-ready="true"] article.markdown-body .mermaid-block svg'),
    changed, !!opened()), message);
}

export async function checkImageZoomThemeCleanup(): Promise<void> {
  const theme = settings.theme;
  try {
    const source = document.querySelector<SVGSVGElement>('article.markdown-body .mermaid-block svg')!;
    source.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    await waitSearch(() => !!opened(), 'theme cleanup zoom did not open');
    await changeThemeAndWait(settings.resolvedTheme === 'dark' ? 'light' : 'dark', 'theme update kept a stale image zoom');
  } finally {
    await changeThemeAndWait(theme, 'restored theme did not render');
  }
}
