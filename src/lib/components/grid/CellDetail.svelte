<script lang="ts">
  /**
   * The selected cell's whole value, docked beside the grid.
   *
   * The grid draws a cell as one line of at most a thousand characters, which
   * is right for scanning a column and wrong for reading a value. This reads
   * what "copy value" reads — the same call, the same 8 MiB ceiling — and
   * wraps it. It also says which kind of nothing an empty cell is, which the
   * grid cannot: every one of them is drawn as a blank.
   *
   * `data-ready` says the value on screen is the selected cell's, so the smoke
   * run can wait for it rather than for a guess at how long a read takes.
   */
  import { untrack } from "svelte";
  import Icon from "../Icon.svelte";
  import { n, t, type MessageKey } from "../../i18n";
  import { errorMessage } from "../../ipc";
  import { copyText } from "../../clipboard";
  import { cellDetail, type CellDetail } from "../../cellDetail";
  import { toasts } from "../../state/toast.svelte";
  import { workspace, type DocTab } from "../../state/docs.svelte";
  import { cellValue } from "./copy";

  interface Props {
    tab: DocTab;
    columnName: (column: number) => string;
    firstRowNumber?: 0 | 1;
    onClose: () => void;
  }

  let { tab, columnName, firstRowNumber = 1, onClose }: Props = $props();

  /**
   * Which cell, as a string. The grid re-selects the same cell every time a
   * page arrives, and a fresh object for the same cell is not a reason to read
   * it again.
   */
  const key = $derived(
    tab.selectedCell
      ? [tab.meta.generation ?? 0, tab.collection ?? "", tab.order.revision, tab.selectedCell.row, tab.selectedCell.column].join(":")
      : "",
  );

  type Read = { key: string; sourceRow?: number; column: number; detail?: CellDetail; error?: string };
  let read = $state<Read | null>(null);

  $effect(() => {
    const wanted = key;
    if (!wanted) {
      read = null;
      return;
    }
    const cell = untrack(() => tab.selectedCell)!;
    let live = true;
    cellValue(tab, cell.row, cell.column, cell.sourceRow)
      .then(({ sourceRow, value }) => {
        if (live) read = { key: wanted, sourceRow, column: cell.column, detail: cellDetail(value) };
      })
      .catch((err) => {
        if (live) read = { key: wanted, column: cell.column, error: errorMessage(err) };
      });
    return () => {
      live = false;
    };
  });

  const ready = $derived(read !== null && read.key === key);
  const detail = $derived(ready ? read?.detail : undefined);

  async function copy() {
    if (!detail) return;
    try {
      await copyText(detail.text);
      toasts.show(detail.truncated ? t("toast.valueTruncated") : t("toast.valueCopied"));
    } catch (err) {
      toasts.show(errorMessage(err), "error");
    }
  }

  function where(): string {
    if (!read || read.sourceRow === undefined) return "";
    return t("table.status.where", { row: n(read.sourceRow + firstRowNumber), column: columnName(read.column) });
  }

  async function openJson() {
    if (!detail?.json) return;
    await workspace.openText(detail.text, `${tab.meta.title} · ${where()}`, "json");
  }
</script>

<aside
  class="cell-detail"
  aria-label={t("cellDetail.label")}
  aria-busy={!!key && !ready}
  data-ready={ready ? "true" : "false"}
  data-kind={detail?.kind}
>
  <header>
    <div class="target">
      {#if ready}<span class="where">{where()}</span>{/if}
      {#if detail?.kind === "value"}
        <span class="count">{t("cellDetail.length", { chars: n(detail.chars), lines: n(detail.lines) })}</span>
      {/if}
    </div>
    <button
      class="icon-btn"
      data-action="cell-detail-close"
      onclick={onClose}
      aria-label={t("cellDetail.close")}
      title={t("cellDetail.close")}
    >
      <Icon name="close" />
    </button>
  </header>

  {#if detail}
    <div class="actions">
      <button class="btn btn-ghost" data-action="cell-copy" onclick={copy}>
        <Icon name="copy" size={13} />
        {t("table.copyValue")}
      </button>
      {#if detail.json}
        <button class="btn btn-ghost" data-action="cell-json" onclick={openJson}>
          <Icon name="external" size={13} />
          {t("cellDetail.json")}
        </button>
      {/if}
    </div>
  {/if}

  <div class="body">
    {#if !key}
      <p class="note">{t("cellDetail.none")}</p>
    {:else if !ready}
      <p class="note">{t("inspector.loading")}</p>
    {:else if read?.error}
      <p class="note error" role="alert">{read.error}</p>
    {:else if detail && detail.kind !== "value"}
      <!-- Said in words: all three are blanks in the grid, and this is the
           one place the difference can be read. -->
      <p class="nothing" data-kind={detail.kind}>{t(`cellDetail.${detail.kind}` as MessageKey)}</p>
    {:else if detail}
      <pre class="value">{detail.shown}</pre>
      {#if detail.clipped}<p class="note">{t("inspector.valueCut")}</p>{/if}
      {#if detail.truncated}<p class="note warn">{t("cellDetail.truncated")}</p>{/if}
    {/if}
  </div>
</aside>

<style>
  .cell-detail {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: var(--bg-subtle);
  }

  header {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.35rem 0.35rem 0.35rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .target {
    flex: 1;
    min-width: 0;
  }

  .where {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-code);
    font-size: 0.92em;
    color: var(--text-secondary);
  }

  .count {
    font-size: 0.85em;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0.25rem 0.35rem;
    border-bottom: 1px solid var(--border);
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0.5rem 0.6rem;
  }

  /* Wrapped, and broken anywhere: a value is often one long token — a URL, a
     hash, minified JSON — and a panel that scrolls sideways hides the end. */
  .value {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-code);
    font-size: var(--doc-font-size);
    color: var(--text);
  }

  .note {
    margin: 0.4rem 0 0;
    color: var(--text-muted);
    font-size: 0.92em;
  }

  .note.error {
    color: var(--danger);
  }

  .note.warn {
    color: var(--warning);
  }

  /* The grid's NULL, larger: quiet, italic, never mistakable for a value. */
  .nothing {
    margin: 0;
    color: var(--text-muted);
    font-style: italic;
  }
</style>
