import { t } from '../../i18n';
import { highlightCode, type CodeLanguage } from '../../ipc';
import type { DocTab } from '../../state/docs.svelte';
import { toasts } from '../../state/toast.svelte';
import { languageLabel } from './code';

export interface CodeControl {
  button: HTMLButtonElement;
  language: CodeLanguage;
  select(name: string): Promise<void>;
}
const enhanced = new WeakMap<HTMLElement, ReturnType<typeof createControls>>();
export function enhanceCode(root: HTMLElement, tab: DocTab, open: (control: CodeControl) => void, highlight = highlightCode) {
  const existing = enhanced.get(root);
  if (existing) return existing;
  const handle = createControls(root, tab, open, highlight);
  enhanced.set(root, handle);
  return handle;
}
function createControls(root: HTMLElement, tab: DocTab, open: (control: CodeControl) => void, highlight: typeof highlightCode) {
  const revision = tab.markdownRevision;
  let alive = true;
  const refreshers: (() => void)[] = [];
  const buttons: HTMLButtonElement[] = [];
  const controls: CodeControl[] = [];
  root.querySelectorAll<HTMLElement>('pre > code').forEach((code, index) => {
    const pre = code.parentElement!;
    const source = code.textContent ?? '';
    const original = tab.codeLanguages[pre.getAttribute('data-sourcepos') ?? ''] ?? { name: 'Plain Text', unknown: null };
    let language = original;
    let request = 0;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-language';
    button.dataset.dviewerUi = 'language';
    button.setAttribute('aria-haspopup', 'menu');
    const refresh = () => {
      const label = languageLabel(language, (name) => t('markdown.code.unknown', { name }));
      button.textContent = `${label} ▾`;
      button.title = `${t('markdown.code.language')}: ${label}`;
      button.setAttribute('aria-label', button.title);
    };
    const control: CodeControl = {
      button,
      get language() { return language; },
      async select(name) {
        const seq = ++request;
        const previous = tab.codeSelections.get(index);
        tab.codeSelections.set(index, name);
        const current = () => alive && revision === tab.markdownRevision && seq === request && code.isConnected;
        try {
          const html = await highlight(name, source);
          if (!current()) return;
          code.innerHTML = html;
          language = { name, unknown: null };
          refresh();
        } catch {
          if (!current()) return;
          if (previous === undefined) tab.codeSelections.delete(index);
          else tab.codeSelections.set(index, previous);
          toasts.show(t('markdown.code.failed'), 'error');
        }
      },
    };
    button.onclick = () => open(control);
    pre.append(button);
    refresh();
    const saved = tab.codeSelections.get(index);
    if (saved) void control.select(saved);
    buttons.push(button);
    controls.push(control);
    refreshers.push(refresh);
  });
  return {
    controls,
    refresh() { for (const refresh of refreshers) refresh(); },
    destroy() {
      alive = false;
      for (const button of buttons) { button.onclick = null; button.remove(); }
      enhanced.delete(root);
    },
  };
}
