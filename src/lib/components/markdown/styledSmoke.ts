import { t } from '../../i18n';
import { DocTab } from '../../state/docs.svelte';
import { settings } from '../../state/settings.svelte';
import { toasts } from '../../state/toast.svelte';
import { copyMarkdown, htmlForCopy } from './copy';
import { STYLED_HTML_LIMIT } from './styledCopy';

const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };

export async function checkStyledCopy(tab: DocTab): Promise<void> {
  const previous = settings.markdownCopyStyled;
  const descriptor = Object.getOwnPropertyDescriptor(navigator.clipboard, 'write');
  let items: ClipboardItems = [];
  try {
    Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: async (value: ClipboardItems) => {
      items = value;
      await value[0].getType('text/html');
    } });
    // Both branches are explicit; this test must also work after a saved true.
    settings.markdownCopyStyled = true;
    await copyMarkdown(tab, 'html');
    require(items.length === 1, 'styled copy did not reach the clipboard');
    const html = await (await items[0].getType('text/html')).text();
    require(await (await items[0].getType('text/plain')).text() === html, 'styled HTML differs between clipboard MIME types');
    const template = document.createElement('template');
    template.innerHTML = html;
    const root = template.content.firstElementChild as HTMLElement;
    require(root && root.style.fontFamily && root.style.color && root.style.backgroundColor, 'styled HTML lost the inherited theme');
    require(!template.content.querySelector('[class]') && ![...template.content.querySelectorAll('*')].some(node => [...node.attributes].some(attribute => attribute.name.startsWith('data-'))), 'styled HTML retained app classes or data attributes');
    require(root.querySelector<HTMLElement>('h1')?.style.fontSize && root.querySelector<HTMLElement>('th')?.style.backgroundColor, 'heading or table styling was omitted');
    require(root.querySelector('pre span[style]'), 'code highlighting was omitted');
    require(root.querySelector('img')?.getAttribute('src') === './icon.png', 'style measurement rewrote the copied image source');
    await copyMarkdown(tab, 'html', 0);
    require((await (await items[0].getType('text/html')).text()).includes('style='), 'block copy ignored the styled HTML choice');

    const large = new DocTab(tab.meta);
    large.html = `<p>${'😀'.repeat(STYLED_HTML_LIMIT / 4)}</p>`;
    await copyMarkdown(large, 'html');
    require(await (await items[0].getType('text/html')).text() === large.html, 'styled HTML limit did not fall back to original HTML');
    require(toasts.items.at(-1)?.message === t('markdown.copy.styledLimit'), 'styled HTML limit was not announced');
    settings.markdownCopyStyled = false;
    await copyMarkdown(tab, 'html');
    require(await (await items[0].getType('text/html')).text() === htmlForCopy(tab.html!), 'disabling styled HTML changed the original copy format');
    require(!document.querySelector('[data-dviewer-ui="copy-measure"]'), 'copy measurement DOM was left behind');
  } finally {
    settings.markdownCopyStyled = previous;
    if (descriptor) Object.defineProperty(navigator.clipboard, 'write', descriptor);
    else Reflect.deleteProperty(navigator.clipboard, 'write');
  }
}
