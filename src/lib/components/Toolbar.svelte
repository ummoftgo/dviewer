<script lang="ts">
  import { onMount } from "svelte";
  import { formatBytes } from "../format";
  import Icon from "./Icon.svelte";
  import { DOC_KINDS, encodingChoices, readsBytes, warningMessage, type DocKind } from "../ipc";
  import { t } from "../i18n";
  import { workspace, type DocTab } from "../state/docs.svelte";
  import { settings } from "../state/settings.svelte";

  interface Props {
    tab: DocTab;
    showToc: boolean;
    onToggleToc: () => void;
    onOpenSettings: () => void;
  }

  let { tab, showToc, onToggleToc, onOpenSettings }: Props = $props();

  let encodings = $state<[string, string][]>([]);
  onMount(() => {
    void encodingChoices().then((list) => (encodings = list));
  });

  /**
   * Only a guess can be wrong, so only a guess is worth drawing attention to.
   * A BOM, valid UTF-8, or the reader's own choice are all settled facts.
   */
  const encodingUncertain = $derived(tab.meta.encoding.source === "guessed");

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
    {#if tab.view === "prose"}
      <div class="segmented" role="group" aria-label={t("toolbar.mode.group")}>
        <button aria-pressed={tab.mode === "rendered"} onclick={() => (tab.mode = "rendered")}>
          {t("toolbar.mode.rendered")}
        </button>
        <button aria-pressed={tab.mode === "raw"} onclick={() => (tab.mode = "raw")}>
          {t("toolbar.mode.raw")}
        </button>
      </div>

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

<style>
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
