import { t } from '../../i18n';

export type ZoomSource = HTMLImageElement | SVGSVGElement;

/** Enhancement owns attributes/listeners; the modal temporarily borrows the existing node. */
export function enhanceImageZoom(root: HTMLElement, onOpen: (source: ZoomSource) => void) {
  const sources = [...root.querySelectorAll<ZoomSource>('img, .mermaid-block:not(.mermaid-error) > svg')];
  const originals = sources.map(source => ({ source, attributes: ['tabindex', 'role', 'aria-label', 'title'].map(name => [name, source.getAttribute(name)] as const) }));
  const refresh = () => {
    for (const source of sources) {
      source.setAttribute('tabindex', '0');
      source.setAttribute('role', 'button');
      source.setAttribute('aria-label', t('imageZoom.open'));
      source.setAttribute('title', t('imageZoom.open'));
      source.dataset.dviewerZoom = 'true';
    }
  };
  const target = (event: Event): ZoomSource | undefined => {
    const element = event.target instanceof Element ? event.target : null;
    return sources.find(source => source === element || (!!element && source.contains(element)));
  };
  const open = (source: ZoomSource, event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (source instanceof HTMLImageElement && (!source.complete || !source.naturalWidth || source.classList.contains('img-missing'))) return;
    onOpen(source);
  };
  const click = (event: MouseEvent) => { const source = target(event); if (source && event.button === 0) open(source, event); };
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const source = target(event);
    if (source) open(source, event);
  };
  refresh();
  root.addEventListener('click', click, true);
  root.addEventListener('keydown', keydown, true);
  return { refresh, destroy() {
    root.removeEventListener('click', click, true);
    root.removeEventListener('keydown', keydown, true);
    for (const {source, attributes} of originals) {
      for (const [name, value] of attributes) {
        if (value === null) source.removeAttribute(name);
        else source.setAttribute(name, value);
      }
      delete source.dataset.dviewerZoom;
    }
  } };
}
