import { tick } from 'svelte';
import { workspace, type DocTab } from '../../state/docs.svelte';

const require = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function waitFor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    if (Date.now() > deadline) {
      const panel = document.querySelector<HTMLElement>('.compare-panel');
      throw new Error(`${message}; ${JSON.stringify({ready:panel?.dataset.ready,busy:panel?.dataset.busy,
        changes:panel?.dataset.changes,error:panel?.querySelector('[role="alert"]')?.textContent?.slice(0,300)})}`);
    }
    await new Promise(resolve => setTimeout(resolve, 16));
  }
}
/** Real native pane lifecycle and scroll checks using temporary source documents. */
export async function checkCompare(first: DocTab) {
  const previous = workspace.activeId;
  let a: DocTab | null = null, b: DocTab | null = null;
  const click = (action: string) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    require(button && !button.disabled, `comparison action missing or disabled: ${action}`); button!.click();
  };
  const panel = () => document.querySelector<HTMLElement>('.compare-panel');
  const choose = async (action: string, id: number) => {
    const select = document.querySelector<HTMLSelectElement>(`[data-action="${action}"]`)!;
    select.value = String(id); select.dispatchEvent(new Event('change', {bubbles: true})); await tick();
  };
  try {
    const left = Array.from({length: 200}, (_, index) => `line ${index + 1}`);
    const right = [...left]; right[5] = 'changed six'; right[150] = 'changed one hundred fifty-one';
    a = await workspace.openText(left.join('\n'), 'compare-left-smoke.txt', 'text');
    b = await workspace.openText(right.join('\n'), 'compare-right-smoke.txt', 'text');
    require(a && b, 'comparison sources did not open');
    for (let attempt = 0; attempt < 2; attempt++) {
      click('compare-open'); await tick();
      await choose('compare-left', -1); await choose('compare-right', b!.id); await choose('compare-left', a!.id);
      await waitFor(() => panel()?.dataset.ready === 'true' && panel()?.dataset.changes === '2', 'source comparison did not finish with two changes');
      click('compare-next'); await tick(); require(panel()?.dataset.current === '0', 'next did not select first change');
      click('compare-next'); await tick(); require(panel()?.dataset.current === '1', 'next did not select second change');
      click('compare-prev'); await tick(); require(panel()?.dataset.current === '0', 'previous did not return to first change');
      const panes = [...panel()!.querySelectorAll<HTMLElement>('.pane')];
      require(panes.length === 2 && panes[0].clientHeight > 0, 'comparison panes have no viewport');
      panes[0].scrollTop = 1000; panes[0].dispatchEvent(new Event('scroll')); await tick();
      require(Math.abs(panes[0].scrollTop - panes[1].scrollTop) <= 1, 'comparison scrolling did not synchronize');
      const sync = panel()!.querySelector<HTMLInputElement>('[data-action="compare-sync"]')!;
      sync.click(); await tick(); const before = panes[1].scrollTop;
      panes[0].scrollTop = 500; panes[0].dispatchEvent(new Event('scroll')); await tick();
      require(panes[1].scrollTop === before, 'comparison scrolling stayed synchronized after disabling');
      // Cancel in the same task that starts IPC; its late result must remain discarded.
      click('compare-refresh'); await tick();
      click('compare-cancel'); await tick();
      await new Promise(resolve => setTimeout(resolve, 100));
      require(panel()?.dataset.ready === 'false' && panel()?.dataset.busy === 'false', 'cancelled comparison published a late result');
      click('compare-refresh'); await waitFor(() => panel()?.dataset.ready === 'true', 'comparison did not restart after cancellation');
      if (attempt === 0) click('compare-close');
      else panel()!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
      await tick(); require(!panel(), 'comparison did not close');
    }
    await workspace.close(a!.id); await workspace.close(b!.id); a = null; b = null;
    a = await workspace.openText('{"2":9007199254740992,"1":null}', 'compare-left-smoke.json', 'json');
    b = await workspace.openText('{"1":null,"2":9007199254740993}', 'compare-right-smoke.json', 'json');
    require(a && b, 'JSON comparison sources did not open');
    click('compare-open'); await tick();
    await choose('compare-left', -1); await choose('compare-right', b!.id); await choose('compare-left', a!.id);
    await waitFor(() => panel()?.dataset.ready === 'true' && panel()?.dataset.changes === '2', 'JSON comparison did not distinguish key order and precise integer changes');
    require(panel()!.querySelectorAll('.line.order').length === 2 && panel()!.querySelectorAll('.line.changed').length === 2, 'JSON order and value changes did not render separately');
    panel()!.querySelector<HTMLInputElement>('[data-action="compare-raw"]')!.click();
    await waitFor(() => panel()?.dataset.ready === 'true' && panel()?.dataset.changes === '1', 'JSON source comparison did not replace structure comparison');
    click('compare-close'); await tick(); require(!panel(), 'JSON comparison did not close');
    return {changes: 2, lifecyclePasses: 2, jsonChanges: 2};
  } finally {
    document.querySelector<HTMLButtonElement>('[data-action="compare-close"]')?.click();
    if (a) await workspace.close(a.id); if (b) await workspace.close(b.id);
    if (previous !== null && workspace.tabs.some(tab => tab.id === previous)) workspace.activate(previous);
    else if (workspace.tabs.some(tab => tab.id === first.id)) workspace.activate(first.id);
    await tick();
  }
}
