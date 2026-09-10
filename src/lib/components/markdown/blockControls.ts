import { t } from '../../i18n';
import { ICON_PATHS } from '../Icon.svelte';
import { blockElements, blockDescription } from './copy';
import type { CopyBlock } from './blocks';

export interface BlockInfo extends CopyBlock { code: string | null }

/** Capture identity before tables, diagrams and maths replace their nodes. */
export function markBlocks(root: HTMLElement): BlockInfo[] {
  return blockElements(root).map((element, index) => {
    element.dataset.dviewerBlock = String(index);
    return { ...blockDescription(element), code: element.tagName === 'PRE' ? element.textContent ?? '' : null };
  });
}

export function transferBlock(source: HTMLElement, target: HTMLElement): void {
  for (const name of ['data-sourcepos', 'data-dviewer-block']) {
    const value = source.getAttribute(name);
    if (value !== null) target.setAttribute(name, value);
  }
}

const enhanced = new WeakMap<HTMLElement, ReturnType<typeof createControls>>();
export function enhanceBlocks(root: HTMLElement, onCopy: (index: number, button: HTMLButtonElement) => void) {
  const existing = enhanced.get(root);
  if (existing) return existing;
  const controls = createControls(root, onCopy);
  enhanced.set(root, controls);
  return controls;
}

function createControls(root: HTMLElement, onCopy: (index: number, button: HTMLButtonElement) => void) {
  const elements = [...root.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element.hasAttribute('data-dviewer-block'));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'block-copy';
  button.dataset.dviewerUi = 'copy';
  button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="${ICON_PATHS.copy}" /></svg>`;
  let selected = elements[0];
  let frame = 0;
  const position = () => {
    if (!selected) return;
    button.style.top = `${selected.offsetTop}px`;
    button.style.left = `${selected.offsetLeft}px`;
  };
  const schedule = () => {
    frame ||= requestAnimationFrame(() => { frame = 0; position(); });
  };
  const observer = new ResizeObserver(schedule);
  let hovered = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const keep = () => { hovered = true; clearTimeout(hideTimer); button.dataset.visible = 'true'; };
  const inside = (target: EventTarget | null) => target instanceof Node && (button.contains(target) || selected?.contains(target));
  const leave = (event?: PointerEvent) => {
    if (event && inside(event.relatedTarget)) return;
    hovered = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!hovered && document.activeElement !== button) delete button.dataset.visible;
    }, 180);
  };
  const refresh = () => {
    button.title = t('markdown.copy.block');
    button.setAttribute('aria-label', button.title);
    schedule();
  };
  refresh();
  if (selected) { root.append(button); position(); observer.observe(root); }
  root.addEventListener('load', schedule, true);
  root.addEventListener('toggle', schedule, true);
  document.fonts.addEventListener('loadingdone', schedule);
  const select = (element: HTMLElement, keyboard = false) => {
    if (element !== selected) {
      selected?.removeAttribute('data-dviewer-selected');
      selected = element;
      position();
    }
    button.dataset.visible = 'true';
    if (keyboard) {
      selected.dataset.dviewerSelected = 'true';
      selected.scrollIntoView({ block: 'nearest' });
      button.focus({ preventScroll: true });
    }
  };
  const over = (event: Event) => {
    if (button.contains(event.target as Node)) {
      if (event.type === 'pointerover') keep();
      return;
    }
    let element = event.target as HTMLElement | null;
    while (element && element.parentElement !== root) element = element.parentElement;
    if (element?.hasAttribute('data-dviewer-block')) {
      select(element);
      if (event.type === 'pointerover') keep();
    }
  };
  root.addEventListener('pointerover', over);
  root.addEventListener('focusin', over);
  root.addEventListener('pointerleave', leave);
  root.addEventListener('pointerout', leave);
  button.onfocus = () => { if (selected) selected.dataset.dviewerSelected = 'true'; };
  button.onblur = () => { selected?.removeAttribute('data-dviewer-selected'); if (!hovered) leave(); };
  button.onkeydown = (event) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = elements.indexOf(selected);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? elements.length - 1
      : Math.max(0, Math.min(elements.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    if (elements[next]) select(elements[next], true);
  };
  button.onclick = () => { if (selected) onCopy(Number(selected.dataset.dviewerBlock), button); };
  return {
    button, refresh,
    destroy() {
      observer.disconnect();
      cancelAnimationFrame(frame);
      root.removeEventListener('load', schedule, true);
      root.removeEventListener('toggle', schedule, true);
      document.fonts.removeEventListener('loadingdone', schedule);
      root.removeEventListener('pointerover', over);
      root.removeEventListener('focusin', over);
      root.removeEventListener('pointerleave', leave);
      root.removeEventListener('pointerout', leave);
      clearTimeout(hideTimer);
      button.onfocus = button.onblur = button.onkeydown = button.onclick = null;
      selected?.removeAttribute('data-dviewer-selected');
      button.remove();
      enhanced.delete(root);
    },
  };
}
