<script lang="ts">
  import type { TocEntry } from "../../ipc";

  interface Props {
    entries: TocEntry[];
    onSelect: (id: string) => void;
  }

  let { entries, onSelect }: Props = $props();

  // Indent relative to the shallowest heading present, so a document that
  // starts at h2 does not sit needlessly indented.
  const base = $derived(Math.min(...entries.map((e) => e.level)));
</script>

<nav aria-label="목차">
  <h2>목차</h2>
  <ul>
    {#each entries as entry (entry.id)}
      <li style="--indent: {Math.min(entry.level - base, 3)}">
        <button onclick={() => onSelect(entry.id)} title={entry.text}>{entry.text}</button>
      </li>
    {/each}
  </ul>
</nav>

<style>
  nav {
    height: 100%;
    overflow-y: auto;
    padding: 2rem 1rem 4rem 0.5rem;
    border-left: 1px solid var(--border);
  }

  h2 {
    margin: 0 0 0.6rem 0.5rem;
    font-size: 0.85em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  button {
    display: block;
    width: 100%;
    padding: 0.2rem 0.5rem 0.2rem calc(0.5rem + var(--indent) * 0.7rem);
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.92em;
    line-height: 1.5;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button:hover {
    background: var(--bg-hover);
    border-left-color: var(--accent);
    color: var(--text);
  }
</style>
