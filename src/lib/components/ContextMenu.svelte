<script lang="ts">
  import type { MenuItem } from "./menu";

  interface Props {
    x: number;
    y: number;
    items: MenuItem[];
    onClose: () => void;
  }

  let { x, y, items, onClose }: Props = $props();

  let menu = $state<HTMLElement>();
  let size = $state({ width: 0, height: 0 });

  // The mark column exists only for menus that asked for one. Every other menu
  // keeps the spacing it has always had, which is the point of asking.
  const marks = $derived(items.some((item) => item.checked !== undefined));

  // Measure once per content change. Assigning unconditionally would make this
  // effect retrigger itself through `size`.
  $effect(() => {
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    if (rect.width !== size.width || rect.height !== size.height) {
      size = { width: rect.width, height: rect.height };
    }
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  });

  // Flip the menu back inside the window when it would open off the edge.
  const position = $derived({
    left: x + size.width > window.innerWidth ? Math.max(0, x - size.width) : x,
    top: y + size.height > window.innerHeight ? Math.max(0, y - size.height) : y,
  });

  function choose(item: MenuItem) {
    if (item.disabled) return;
    onClose();
    item.action();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onresize={onClose} onkeydown={onKeydown} />

<!-- A full-window catcher so the next click anywhere dismisses the menu,
     including a right-click that opens a different one. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="catcher"
  onpointerdown={onClose}
  oncontextmenu={(e) => {
    e.preventDefault();
    onClose();
  }}
></div>

<menu
  bind:this={menu}
  class="menu"
  style="left: {position.left}px; top: {position.top}px"
>
  {#each items as item (item.key ?? item.label)}
    <li>
      <button disabled={item.disabled} onclick={() => choose(item)}>
        {#if marks}
          <span class="mark" aria-hidden="true">{item.checked ? "✓" : ""}</span>
        {/if}
        <span class="label">{item.label}</span>
        {#if item.hint}<span class="hint">{item.hint}</span>{/if}
      </button>
    </li>
  {/each}
</menu>

<style>
  .catcher {
    position: fixed;
    inset: 0;
    z-index: 30;
  }

  .menu {
    position: fixed;
    z-index: 31;
    min-width: 10rem;
    max-width: 22rem;
    margin: 0;
    padding: 0.25rem;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-lg);
  }

  li {
    display: block;
  }

  button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    width: 100%;
    padding: 0.3rem 0.55rem;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    text-align: left;
    white-space: nowrap;
  }

  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--accent-subtle);
    outline: none;
  }

  button:disabled {
    color: var(--text-muted);
    cursor: default;
  }

  /* Fixed width so the labels line up whether or not a row is marked. */
  .mark {
    flex: none;
    width: 0.9rem;
    color: var(--accent);
  }

  /* Long enough entries are documents, not commands, so the menu is capped and
     the name gives way rather than the window. */
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hint {
    flex: none;
    color: var(--text-muted);
    font-size: 0.92em;
  }
</style>
