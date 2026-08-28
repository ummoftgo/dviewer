<script lang="ts">
  import { fly } from "svelte/transition";
  import { toasts } from "../state/toast.svelte";
</script>

<div class="stack" role="status" aria-live="polite">
  {#each toasts.items as toast (toast.id)}
    <div class="toast" class:error={toast.tone === "error"} transition:fly={{ y: 8, duration: 140 }}>
      {toast.message}
    </div>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    left: 50%;
    bottom: 2.5rem;
    z-index: 40;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
    transform: translateX(-50%);
    /* Purely informational — never in the way of a click. */
    pointer-events: none;
  }

  .toast {
    padding: 0.4rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: var(--shadow-md);
    white-space: nowrap;
  }

  .toast.error {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
