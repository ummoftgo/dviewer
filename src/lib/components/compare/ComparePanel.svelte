<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { t } from '../../i18n';
  import { docLines, docSourceText, errorMessage } from '../../ipc';
  import type { DocTab } from '../../state/docs.svelte';
  import { CompareError, CompareRequests, type Comparison, type DiffRow } from '../../compare';
  import { loadComparison } from '../../compareLoad';
  import Icon from '../Icon.svelte';

  interface Props { tabs: DocTab[]; initialLeftId?: number; onClose: () => void }
  let { tabs, initialLeftId, onClose }: Props = $props();
  const supported = (tab: DocTab) => ['text', 'markdown', 'json'].includes(tab.meta.kind);
  let eligible = $derived(tabs.filter(supported));
  const initial = untrack(() => eligible);
  const initialId = untrack(() => initialLeftId);
  let leftId = $state(initial.some(tab => tab.id === initialId) ? initialId! : initial[0]?.id ?? -1);
  let rightId = $state(initial.find(tab => tab.id !== leftId)?.id ?? -1);
  let left = $derived(eligible.find(tab => tab.id === leftId));
  let right = $derived(eligible.find(tab => tab.id === rightId));
  let structural = $derived(left?.meta.kind === 'json' && right?.meta.kind === 'json');
  let raw = $state(false);
  let sync = $state(true);
  let refresh = $state(0);
  let busy = $state(false);
  let result = $state<Comparison | null>(null);
  let error = $state<string | null>(null);
  let selected = $state(-1);
  let leftPane = $state<HTMLDivElement>();
  let rightPane = $state<HTMLDivElement>();
  let leftTop = $state(0), rightTop = $state(0);
  let leftHeight = $state(0), rightHeight = $state(0);
  const rowHeight = 28;
  const requests = new CompareRequests();
  let panel: HTMLElement;
  onMount(() => panel.focus());
  const leftStart = $derived(Math.max(0, Math.floor(leftTop / rowHeight) - 10));
  const rightStart = $derived(Math.max(0, Math.floor(rightTop / rowHeight) - 10));
  const leftRows = $derived(result?.rows.slice(leftStart, leftStart + Math.ceil(leftHeight / rowHeight) + 20) ?? []);
  const rightRows = $derived(result?.rows.slice(rightStart, rightStart + Math.ceil(rightHeight / rowHeight) + 20) ?? []);

  $effect(() => {
    const a = left, b = right;
    const asJson = structural && !raw;
    void refresh;
    const ticket = requests.begin();
    result = null; selected = -1; error = null; leftTop = 0; rightTop = 0;
    untrack(() => {
      if (leftPane) leftPane.scrollTop = 0;
      if (rightPane) rightPane.scrollTop = 0;
    });
    if (!a || !b || a.id === b.id) { busy = false; return () => requests.cancel(); }
    busy = true;
    const current = requests.guard(ticket, () => a.meta.generation, () => b.meta.generation);
    void loadComparison({id: a.id, byteLen: a.meta.byteLen, pagedLines: a.meta.kind === 'text'}, {id: b.id, byteLen: b.meta.byteLen, pagedLines: b.meta.kind === 'text'}, asJson, current, {lines: docLines, sourceText: docSourceText}).then(value => {
      if (current()) { result = value; busy = false; }
    }).catch(cause => {
      if (!current()) return;
      error = cause instanceof CompareError ? t(cause.reason === 'limit' ? 'compare.limit' : cause.reason === 'complexity' ? 'compare.complexity' : 'compare.invalidJson') : errorMessage(cause);
      busy = false;
    });
    return () => requests.cancel();
  });

  function cancel() { requests.cancel(); busy = false; result = null; }
  function scroll(side: 'left' | 'right') {
    const pane = side === 'left' ? leftPane : rightPane;
    if (!pane) return;
    if (side === 'left') leftTop = pane.scrollTop; else rightTop = pane.scrollTop;
    const other = side === 'left' ? rightPane : leftPane;
    if (sync && other && Math.abs(other.scrollTop - pane.scrollTop) > 1) {
      other.scrollTop = pane.scrollTop;
      if (side === 'left') rightTop = other.scrollTop; else leftTop = other.scrollTop;
    }
  }
  async function jump(direction: number) {
    if (!result?.changes.length) return;
    selected = selected < 0 ? direction > 0 ? 0 : result.changes.length - 1 : (selected + direction + result.changes.length) % result.changes.length;
    const top = result.changes[selected] * rowHeight;
    if (leftPane) leftPane.scrollTop = top;
    if (rightPane) rightPane.scrollTop = top;
    leftTop = leftPane?.scrollTop ?? 0; rightTop = rightPane?.scrollTop ?? 0;
    await tick();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]')];
      const at = controls.indexOf(document.activeElement as HTMLElement);
      if (at === -1 || (event.shiftKey && at === 0) || (!event.shiftKey && at === controls.length - 1)) {
        event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      }
      return;
    }
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation(); onClose();
  }
  const label = (row: DiffRow, side: 'left' | 'right') => row.path ?? String((side === 'left' ? row.leftLine : row.rightLine) ?? '');
</script>

<!-- Escape is delegated from the panel controls. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="compare-backdrop">
<div bind:this={panel} tabindex="-1" role="dialog" aria-modal="true" class="compare-panel" data-ready={result !== null} data-busy={busy} data-current={selected} data-changes={result?.changes.length ?? 0} aria-label={t('compare.title')} onkeydown={keydown}>
  <header>
    <strong>{t('compare.title')}</strong>
    <button class="btn" data-action="compare-refresh" onclick={() => refresh++}>{t('compare.refresh')}</button>
    <button class="icon-btn" data-action="compare-close" title={t('compare.close')} aria-label={t('compare.close')} onclick={onClose}><Icon name="close" /></button>
  </header>
  <div class="choices">
    <label>{t('compare.left')}<select class="field" data-action="compare-left" bind:value={leftId}>
      <option value={-1}>{t('compare.choose')}</option>
      {#each eligible as tab (tab.id)}<option value={tab.id} disabled={tab.id === rightId}>{tab.meta.title}</option>{/each}
    </select></label>
    <label>{t('compare.right')}<select class="field" data-action="compare-right" bind:value={rightId}>
      <option value={-1}>{t('compare.choose')}</option>
      {#each eligible as tab (tab.id)}<option value={tab.id} disabled={tab.id === leftId}>{tab.meta.title}</option>{/each}
    </select></label>
  </div>
  <div class="controls">
    <button class="btn" data-action="compare-prev" disabled={!result?.changes.length} onclick={() => jump(-1)}>{t('compare.previous')}</button>
    <button class="btn" data-action="compare-next" disabled={!result?.changes.length} onclick={() => jump(1)}>{t('compare.next')}</button>
    <span>{t('compare.count', {n: selected + 1, total: result?.changes.length ?? 0})}</span>
    <label><input type="checkbox" data-action="compare-sync" bind:checked={sync} onchange={() => { if (sync) scroll('left'); }} />{t('compare.sync')}</label>
    {#if structural}<label><input type="checkbox" data-action="compare-raw" bind:checked={raw} />{t('compare.raw')}</label>{/if}
    {#if busy}<button class="btn" data-action="compare-cancel" onclick={cancel}>{t('compare.cancel')}</button>{/if}
  </div>
  <p class="hint">{t(structural && !raw ? 'compare.jsonHint' : 'compare.sourceHint')}</p>
  {#if error}<p class="message" role="alert">{error}</p>
  {:else if busy}<p class="message" role="status">{t('compare.loading')}</p>
  {:else if !left || !right || leftId === rightId}<p class="message">{t('compare.needTwo')}</p>
  {:else if result && !result.changes.length}<p class="message" role="status">{t('compare.identical')}</p>{/if}
  {#if result && (result.rows.length > 0)}
    <div class="panes">
      <!-- Scrollable source panes must accept keyboard focus for native PageUp/PageDown. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="pane" data-side="left" bind:this={leftPane} bind:clientHeight={leftHeight} onscroll={() => scroll('left')} tabindex="0" role="region" aria-label={t('compare.left')}>
        <div class="spacer" style:height="{result.rows.length * rowHeight}px">
          {#each leftRows as row, index (leftStart + index)}
            <div class="line {row.kind}" class:selected={result.changes[selected] === leftStart + index} style:top="{(leftStart + index) * rowHeight}px">
              <span class="number" title={label(row, 'left')}>{label(row, 'left')}</span><span class="value">{row.left ?? ''}</span>
              {#if row.kind === 'order'}<span class="badge">{t('compare.keyOrder')}</span>{/if}
            </div>
          {/each}
        </div>
      </div>
      <!-- Scrollable source panes must accept keyboard focus for native PageUp/PageDown. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="pane" data-side="right" bind:this={rightPane} bind:clientHeight={rightHeight} onscroll={() => scroll('right')} tabindex="0" role="region" aria-label={t('compare.right')}>
        <div class="spacer" style:height="{result.rows.length * rowHeight}px">
          {#each rightRows as row, index (rightStart + index)}
            <div class="line {row.kind}" class:selected={result.changes[selected] === rightStart + index} style:top="{(rightStart + index) * rowHeight}px">
              <span class="number" title={label(row, 'right')}>{label(row, 'right')}</span><span class="value">{row.right ?? ''}</span>
              {#if row.kind === 'order'}<span class="badge">{t('compare.keyOrder')}</span>{/if}
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>
</div>

<style>
  .compare-backdrop { position:fixed; inset:0; z-index:40; padding:20px; background:rgb(0 0 0 / 35%); display:flex; }
  .compare-panel { flex:1; border:1px solid var(--border); border-radius:8px; overflow:hidden; display:flex; flex-direction:column; min-height:0; height:100%; background:var(--bg); }
  header { display:flex; align-items:center; gap:8px; padding:10px; border-bottom:1px solid var(--border); }
  header strong { flex:1; }
  .choices { display:flex; gap:12px; padding:10px; }
  .choices label { display:flex; flex:1; align-items:center; gap:8px; min-width:0; }
  select { min-width:0; width:100%; }
  .controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:0 10px; }
  .controls label { display:flex; gap:5px; align-items:center; }
  .hint { margin:8px 10px; color:var(--text-muted); font-size:12px; }
  .message { margin:10px; }
  .panes { display:flex; min-height:0; flex:1; border-top:1px solid var(--border); }
  .pane { flex:1; min-width:0; overflow:auto; position:relative; }
  .pane + .pane { border-left:1px solid var(--border); }
  .spacer { position:relative; min-width:100%; width:max-content; }
  .line { position:absolute; left:0; right:0; height:28px; line-height:28px; display:flex; white-space:pre; font-family:var(--font-mono, monospace); font-size:12px; }
  .number { display:inline-block; position:sticky; left:0; min-width:48px; max-width:240px; padding:0 8px; overflow:hidden; text-overflow:ellipsis; color:var(--text-muted); background:var(--bg); z-index:1; }
  .value { padding:0 8px; }
  .changed { background:color-mix(in srgb, #c89a32 17%, var(--bg)); }
  .added { background:color-mix(in srgb, #398b55 17%, var(--bg)); }
  .removed { background:color-mix(in srgb, #b55151 17%, var(--bg)); }
  .order { background:color-mix(in srgb, #6277ac 17%, var(--bg)); }
  .selected { outline:2px solid var(--accent); outline-offset:-2px; }
  .badge { font-family:var(--font-body); color:var(--text-muted); padding:0 8px; }
</style>
