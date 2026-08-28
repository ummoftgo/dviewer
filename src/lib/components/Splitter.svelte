<script lang="ts">
  /**
   * A draggable divider.
   *
   * The geometry differs per use — a side pane is measured in pixels from the
   * container's right edge, a table column as a fraction from its left — so the
   * caller supplies `measure` and `bounds` and this owns only the interaction:
   * pointer capture, clamping, keyboard steps and a reset.
   *
   * Positioning is the caller's job too: pass a class and place it as a grid
   * column or absolutely, whichever suits.
   */
  interface Props {
    value: number;
    /** Pointer position → candidate value, given the parent's box. */
    measure: (event: PointerEvent, parent: DOMRect) => number;
    /** Allowed range, recomputed at drag time so a resized window stays sane. */
    bounds: (parent: DOMRect) => { min: number; max: number };
    /** Keyboard increment. */
    step: number;
    /** +1 when ArrowRight should raise the value, -1 when it should lower it. */
    keyDirection?: 1 | -1;
    /** Value restored on double-click. */
    reset: number;
    label: string;
    class?: string;
    onCommit?: () => void;
  }

  let {
    value = $bindable(),
    measure,
    bounds,
    step,
    keyDirection = 1,
    reset,
    label,
    class: className = "",
    onCommit,
  }: Props = $props();

  let handle = $state<HTMLElement>();
  let dragging = $state(false);
  let range = $state({ min: 0, max: 1 });

  // Report a truthful range from the start rather than after the first drag.
  $effect(() => {
    const parent = parentRect();
    if (parent) range = bounds(parent);
  });

  function parentRect(): DOMRect | null {
    return handle?.parentElement?.getBoundingClientRect() ?? null;
  }

  function apply(next: number) {
    const parent = parentRect();
    if (!parent) return;
    range = bounds(parent);
    value = Math.min(range.max, Math.max(range.min, next));
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    try {
      handle?.setPointerCapture(event.pointerId);
    } catch {
      // Capture is an improvement, not a prerequisite: without it a drag that
      // leaves the handle stops tracking, but it must still start.
    }
    dragging = true;
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent) {
    const parent = parentRect();
    if (!dragging || !parent) return;
    apply(measure(event, parent));
  }

  function onPointerUp(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try {
      handle?.releasePointerCapture(event.pointerId);
    } catch {
      // Nothing was captured; nothing to release.
    }
    onCommit?.();
  }

  function onKeydown(event: KeyboardEvent) {
    // A divider that only answers to a mouse is not a control.
    const parent = parentRect();
    if (!parent) return;
    const limits = bounds(parent);
    const moves: Record<string, number> = {
      ArrowRight: value + step * keyDirection,
      ArrowLeft: value - step * keyDirection,
      Home: keyDirection === 1 ? limits.min : limits.max,
      End: keyDirection === 1 ? limits.max : limits.min,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    apply(next);
    onCommit?.();
  }
</script>

<!-- A separator carrying aria-valuenow is the ARIA window-splitter pattern: it
     is a focusable widget by definition, which the generic rule does not know. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={handle}
  class="splitter {className}"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={Math.round(value * 1000) / 1000}
  aria-valuemin={Math.round(range.min * 1000) / 1000}
  aria-valuemax={Math.round(range.max * 1000) / 1000}
  tabindex="0"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onkeydown={onKeydown}
  ondblclick={() => {
    apply(reset);
    onCommit?.();
  }}
  title="{label} — 드래그하거나 화살표 키로 조절, 두 번 누르면 기본값"
></div>

<style>
  .splitter {
    position: relative;
    cursor: col-resize;
    background: var(--border);
    transition: background-color 0.12s;
    touch-action: none;
  }

  /* A 1px target is unhittable, so the hit area spills over both sides. */
  .splitter::after {
    content: "";
    position: absolute;
    inset: 0 -3px;
  }

  .splitter:hover,
  .splitter:focus-visible,
  .splitter.dragging {
    background: var(--accent);
  }

  .splitter:focus-visible {
    outline: none;
  }
</style>
