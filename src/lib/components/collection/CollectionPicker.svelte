<!--
  Choosing one collection out of a file that holds several.

  A SQLite file has tables and views; a workbook has sheets. They are the same
  choice from the reader's side, so this knows nothing about either — it takes
  a list of names, says which are secondary, and reports what was picked.
-->
<script lang="ts">
  import Icon from "../Icon.svelte";
  import { t } from "../../i18n";

  interface Item {
    name: string;
    /** Shown with a mark. A view is readable but is not stored data. */
    secondary?: boolean;
  }

  let {
    label,
    items,
    selected,
    onselect,
    disabled = false,
  }: {
    label: string;
    items: Item[];
    selected: string | null;
    onselect: (name: string) => void;
    disabled?: boolean;
  } = $props();
</script>

<!-- Below two there is nothing to choose, and a control that can only be set
     to what it already says is furniture. The count beside it goes too — one
     name that is right there does not need to be counted. -->
{#if items.length > 1}
  <label class="picker">
  <Icon name="list" size={13} />
  <span class="label">{label}</span>
  <select
    value={selected ?? ""}
    disabled={disabled || items.length === 0}
    onchange={(event) => onselect(event.currentTarget.value)}
  >
    {#each items as item (item.name)}
      <!-- The mark is part of the option text: a `<select>` cannot carry an
           icon per option, and a suffix survives every platform's own menu. -->
      <option value={item.name}>
        {item.secondary ? `${item.name} · ${t("table.view")}` : item.name}
      </option>
    {/each}
  </select>
    <span class="count">{items.length}</span>
  </label>
{/if}

<style>
  .picker {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--text-secondary);
    font-size: 0.92em;
  }

  .label {
    white-space: nowrap;
  }

  select {
    /* A table name is as long as its author made it, so the control grows with
       the name rather than truncating it, up to a point. */
    max-width: 22rem;
    padding: 0.1rem 0.2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    font-size: inherit;
  }

  select:disabled {
    opacity: 0.6;
  }

  .count {
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }
</style>
