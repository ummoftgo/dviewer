import type { DocTab } from '../../state/docs.svelte';
import { copyHtml, copyText } from '../../clipboard';
import { t } from '../../i18n';
import { toasts } from '../../state/toast.svelte';
import { rawBlock, sectionEnd, type CopyBlock } from './blocks';

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'PRE',
  'TABLE', 'BLOCKQUOTE', 'DETAILS', 'FIGURE', 'DL', 'SECTION', 'DIV', 'HR']);
export function blockElements(root: HTMLElement): HTMLElement[] {
  return [...root.children].filter((node): node is HTMLElement => node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName));
}
export function blockDescription(element: HTMLElement): CopyBlock {
  return { position: element.getAttribute('data-sourcepos'), level: /^H[1-6]$/.test(element.tagName) ? Number(element.tagName[1]) : 0 };
}

/** Receives only Rust-sanitised HTML, never author source or rendered SVG/KaTeX. */
export function htmlForCopy(html: string, index?: number, children = false): string {
  const root = document.createElement('article');
  root.innerHTML = html;
  if (index !== undefined) {
    const elements = blockElements(root);
    const end = children ? sectionEnd(elements.map(blockDescription), index) : index + 1;
    root.replaceChildren(...elements.slice(index, end));
  }
  cleanCopyDom(root);
  return root.innerHTML;
}

export function cleanCopyDom(root: HTMLElement): void {
  // Ownership attributes cannot come through ammonia. Author class names are not ownership.
  for (const node of root.querySelectorAll('[data-dviewer-ui]')) node.remove();
  for (const node of root.querySelectorAll<HTMLElement>('[data-dviewer-wrap]')) node.replaceWith(...node.childNodes);
  for (const image of root.querySelectorAll<HTMLImageElement>('img[data-dviewer-src]')) image.setAttribute('src', image.dataset.dviewerSrc!);
  for (const node of root.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name === 'data-sourcepos' || attribute.name.startsWith('data-dviewer-')) node.removeAttribute(attribute.name);
    }
  }
}

export async function copyMarkdown(tab: DocTab, format: 'raw' | 'html', index?: number, children = false): Promise<void> {
  const revision = tab.markdownRevision;
  const html = tab.html;
  try {
    if (format === 'html') {
      if (html === null) throw new Error(t('toast.copyFailed'));
      await copyHtml(htmlForCopy(html, index, children));
    } else {
      const raw = await tab.loadRaw();
      if (tab.markdownRevision !== revision) return;
      let text: string | null = raw;
      if (index !== undefined) {
        const root = document.createElement('article');
        root.innerHTML = html ?? '';
        text = rawBlock(raw, blockElements(root).map(blockDescription), index, children);
      }
      if (text === null) { toasts.show(t('markdown.copy.noSource'), 'info'); return; }
      await copyText(text);
    }
    toasts.show(t(format === 'raw' ? 'markdown.copy.rawDone' : 'markdown.copy.htmlDone'));
  } catch { toasts.show(t('toast.copyFailed'), 'error'); }
}
