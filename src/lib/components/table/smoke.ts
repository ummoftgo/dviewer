import { tick } from 'svelte';
import { docSourceText } from '../../ipc';
import type { DocTab } from '../../state/docs.svelte';

async function waitFor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 16));
  }
}

export async function checkTextReading(tab: DocTab): Promise<void> {
  const mode = tab.mode;
  try {
    tab.mode = 'rendered';
    await tick();
    const expected = await docSourceText(tab.id);
    const raw = document.querySelector<HTMLButtonElement>('[data-action="view-raw"]');
    if (!raw) throw new Error('text toolbar has no raw switch');
    raw.click();
    await waitFor(() => document.querySelector('.raw-view .source')?.textContent === expected,
      'text raw source did not finish loading');
    const numbers = document.querySelector('.raw-view .gutter')?.textContent?.split('\n') ?? [];
    const lines = expected.split('\n').length;
    if (numbers.length !== lines || numbers.at(-1) !== String(lines)) throw new Error('text raw line numbers changed');
    document.querySelector<HTMLButtonElement>('[data-action="view-rendered"]')!.click();
    await waitFor(() => document.querySelector('main [role="grid"]') !== null, 'text did not return to its table');
  } finally { tab.mode = mode; await tick(); }
}
