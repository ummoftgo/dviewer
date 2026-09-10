<script lang="ts">
  import { t } from "../../i18n";
  import type { TocEntry } from "../../ipc";

  interface Props {
    entries: TocEntry[];
    activeId: string;
    onSelect: (id: string) => void;
  }

  let { entries, activeId, onSelect }: Props = $props();
  let nav = $state<HTMLElement>();
  let hovering = $state(false);
  let focused = $state(false);

  $effect(() => {
    const host = nav, id = activeId;
    if (!host || hovering || focused || !id) return;
    const frame = requestAnimationFrame(() => {
      const current = host.querySelector<HTMLElement>('[aria-current="true"]');
      if (!current) return;
      const item = current.getBoundingClientRect(), box = host.getBoundingClientRect();
      if (item.top < box.top) host.scrollTop += item.top - box.top;
      else if (item.bottom > box.bottom) host.scrollTop += item.bottom - box.bottom;
    });
    return () => cancelAnimationFrame(frame);
  });

  // Indent relative to the shallowest heading present, so a document that
  // starts at h2 does not sit needlessly indented.
  const base = $derived(Math.min(...entries.map((e) => e.level)));
</script>

<nav aria-label={t("markdown.toc")} bind:this={nav}
  onmouseenter={() => { hovering = true; }} onmouseleave={() => { hovering = false; }}
  onfocusin={() => { focused = true; }}
  onfocusout={(event) => { focused = event.relatedTarget instanceof Node && !!nav?.contains(event.relatedTarget); }}>
  <h2>{t("markdown.toc")}</h2>
  <ul>
    {#each entries as entry (entry.id)}
      <li style="--indent: {Math.min(entry.level - base, 3)}">
        <button onclick={() => onSelect(entry.id)} aria-current={entry.id === activeId ? 'true' : undefined}
          title={entry.id === activeId ? `${entry.text} · ${t('markdown.toc.current')}` : entry.text}>{entry.text}</button>
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

  button[aria-current="true"] {
    border-left-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
</style>
