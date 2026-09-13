<script lang="ts">
  import { onMount } from "svelte";
  import { formatBytes } from "../format";
  import CopyDialog from "./markdown/CopyDialog.svelte";
  import { copyMarkdown } from "./markdown/copy";
  import Icon from "./Icon.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import type { MenuItem } from "./menu";
  import { DOC_KINDS, encodingChoices, readsBytes, warningMessage, type DocKind } from "../ipc";
  import { t } from "../i18n";
  import { supportsRaw } from '../viewMode';
  import { workspace, type DocTab } from "../state/docs.svelte";
  import { pageWidthLabel, pageWidthOptions, settings } from "../state/settings.svelte";

  interface Props {
    tab: DocTab;
    showToc: boolean;
    onToggleToc: () => void;
    onOpenSettings: () => void;
    onSearch: () => void;
  }

  let { tab, showToc, onToggleToc, onOpenSettings, onSearch }: Props = $props();

  let copyTarget = $state<{ tab: DocTab; revision: number } | null>(null);
  let copyButton = $state<HTMLButtonElement>();
  let encodings = $state<[string, string][]>([]);
  let widthAt = $state<{ x: number; y: number } | null>(null);
  let widthButton = $state<HTMLButtonElement>();

  $effect(() => {
    void tab.id;
    void tab.mode;
    void tab.view;
    widthAt = null;
    copyTarget = null;
  });

  const gridWidth = $derived(tab.view === 'table' || tab.view === 'collection');

  function widthItems(): MenuItem[] {
    if (gridWidth) return (['fill', 'scroll'] as const).map(mode => ({
      key: mode,
      label: t(mode === 'fill' ? 'settings.tableWidth.fill' : 'settings.tableWidth.scroll'),
      checked: tab.tableWidthMode === mode,
      action: () => settings.applyTableWidthMode(tab, mode),
    }));
    return pageWidthOptions(settings.markdownPageWidth).map((option) => ({
      key: String(option.width),
      label: t(option.label, { width: option.width }),
      icon: "fit-width",
      checked: option.checked,
      action: () => {
        settings.markdownPageWidth = option.width;
        settings.save();
      },
    }));
  }
  onMount(() => {
    void encodingChoices().then((list) => (encodings = list));
  });

  /**
   * Only a guess can be wrong, so only a guess is worth drawing attention to.
   * A BOM, valid UTF-8, or the reader's own choice are all settled facts.
   */
  const encodingUncertain = $derived(tab.meta.encoding.source === "guessed");
  const widthTitle = $derived(gridWidth ? t("toolbar.tableWidth") : t("markdown.width.current", { width: pageWidthLabel(settings.markdownPageWidth) }));

  const encodingHint = $derived.by(() => {
    const encoding = tab.meta.encoding;
    if (encoding.warning) return warningMessage(encoding.warning);
    switch (encoding.source) {
      case "bom":
        return t("toolbar.encoding.bom", { encoding: encoding.label });
      case "utf8":
        return t("toolbar.encoding.utf8");
      case "chosen":
        return t("toolbar.encoding.chosen", { encoding: encoding.label });
      default:
        return t("toolbar.encoding.guessed", { encoding: encoding.label });
    }
  });

</script>

<div class="toolbar">
  <div class="doc">
    <span class="title" title={tab.subtitle}>{tab.meta.title}</span>
    <span class="meta">{formatBytes(tab.meta.byteLen)}</span>
  </div>

  <div class="controls">
    {#if supportsRaw(tab.view, tab.kind)}
      <div class="segmented" role="group" aria-label={t("toolbar.mode.group")}>
        <button data-action="view-rendered" aria-pressed={tab.mode === "rendered"} onclick={() => (tab.mode = "rendered")}>
          {t(tab.kind === 'text' ? 'toolbar.mode.table' : 'toolbar.mode.rendered')}
        </button>
        <button data-action="view-raw" aria-pressed={tab.mode === "raw"} onclick={() => (tab.mode = "raw")}>
          {t("toolbar.mode.raw")}
        </button>
      </div>
    {/if}

    {#if tab.view === "prose"}
      <button class="icon-btn" data-action="copy-markdown" bind:this={copyButton}
        title={t('markdown.copy.all')} aria-label={t('markdown.copy.all')}
        disabled={tab.mode === 'rendered' && tab.html === null}
        onclick={() => {
          if (tab.mode === 'raw') void copyMarkdown(tab, 'raw');
          else copyTarget = { tab, revision: tab.markdownRevision };
        }}><Icon name="copy" /></button>
      <button class="icon-btn" data-action="search-markdown" onclick={onSearch}
        aria-pressed={tab.markdownSearch.open}
        title={t('toolbar.search')} aria-label={t('toolbar.search')}><Icon name="search" /></button>
      {#if tab.mode === "rendered" && tab.toc.length > 1}
        <button
          class="icon-btn"
          onclick={onToggleToc}
          aria-pressed={showToc}
          title={t("toolbar.toc")}
          aria-label={t("toolbar.toc.show")}
        >
          <Icon name="list" />
        </button>
      {/if}
    {/if}

    {#if tab.view === "frame"}
      <button class="icon-btn" data-action="search-frame" onclick={onSearch} aria-pressed={tab.frameSearch.open} title={t("toolbar.search")} aria-label={t("toolbar.search")}><Icon name="search" /></button>
      {#if tab.mode === "rendered" && tab.frameToc.length > 1}
        <button class="icon-btn" onclick={onToggleToc} aria-pressed={showToc} title={t("toolbar.toc")} aria-label={t("toolbar.toc.show")}><Icon name="list" /></button>
      {/if}
    {/if}

    {#if tab.mode === "rendered" && (tab.view === "prose" || gridWidth)}
      <button class="icon-btn page-width" bind:this={widthButton} data-action={gridWidth ? 'table-width' : 'page-width'}
        title={widthTitle} aria-label={widthTitle} aria-haspopup="menu" aria-expanded={widthAt !== null}
        onclick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          widthAt = { x: box.left, y: box.bottom };
        }}>
        <Icon name="fit-width" />
        <Icon name="chevron-down" size={10} />
      </button>
    {/if}

    <!-- Neither control is shown for a format that is not read as bytes. The
         switcher offers readings of one run of bytes and the encoding picker
         says how to turn those bytes into characters; a database is queried
         and a workbook is converted, so both would have nothing to act on. -->
    {#if readsBytes(tab.kind)}
    <!-- Eight formats is past what a row of buttons can carry, and the point
         of the control is to correct a wrong guess, not to be used often. -->
    <label class="format" title={t("toolbar.format.title")}>
      {t("toolbar.format.label")}
      <select
        value={tab.kind}
        onchange={(e) => workspace.setKind(tab.id, e.currentTarget.value as DocKind)}
      >
        {#each DOC_KINDS as entry (entry.kind)}
          <option value={entry.kind}>{t(entry.label)}</option>
        {/each}
      </select>
    </label>

    <!-- Beside the format picker because the two answer the same question in
         sequence: what is this file, and how do I read its bytes. -->
    <label class="format encoding" class:uncertain={encodingUncertain} title={encodingHint}>
      {#if tab.meta.encoding.warning}
        <span class="warn" aria-hidden="true"><Icon name="warning" size={12} /></span>
      {/if}
      {t("toolbar.encoding.label")}
      <select
        value={tab.meta.encoding.name}
        onchange={(e) => workspace.setEncoding(tab.id, e.currentTarget.value)}
      >
        {#each encodings as [name, label] (name)}
          <option value={name}>{label}</option>
        {/each}
        {#if !encodings.some(([name]) => name === tab.meta.encoding.name)}
          <!-- Detection can land on something outside the short menu; showing
               it keeps the control from lying about what is in effect. -->
          <option value={tab.meta.encoding.name}>{tab.meta.encoding.label}</option>
        {/if}
      </select>
    </label>
    {/if}

    <span class="scale" title={t("toolbar.scale")}>
      {Math.round(settings.uiScale * 100)}%
    </span>

    <button class="icon-btn" onclick={onOpenSettings} title={t("toolbar.settings")}
      aria-label={t("toolbar.settings")}>
      <Icon name="settings" />
    </button>
  </div>
</div>

{#if widthAt}
  <ContextMenu x={widthAt.x} y={widthAt.y} items={widthItems()} onClose={() => {
    widthAt = null;
    widthButton?.focus();
  }} />
{/if}

{#if copyTarget}
  <CopyDialog onChoose={(choice) => {
    const target = copyTarget;
    if (target && target.tab.markdownRevision === target.revision && (choice === 'raw' || choice === 'html')) void copyMarkdown(target.tab, choice);
    copyTarget = null;
    copyButton?.focus();
  }} onClose={() => { copyTarget = null; copyButton?.focus(); }} />
{/if}

<style>
  .page-width { width: 2.25rem; gap: 0.1rem; }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 2.25rem;
    padding: 0.25rem 0.5rem 0.25rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }

  .doc {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    min-width: 0;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .meta {
    flex: none;
    color: var(--text-muted);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex: none;
  }

  .format {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--text-muted);
    font-size: 0.85em;
  }

  .format select {
    padding: 0.1rem 0.2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text);
    font: inherit;
  }

  .encoding.uncertain select {
    border-color: var(--warning);
  }

  .encoding .warn {
    display: flex;
    color: var(--warning);
  }

  .scale {
    padding: 0 0.2rem;
    color: var(--text-muted);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }
</style>
