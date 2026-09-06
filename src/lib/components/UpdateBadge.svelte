<script lang="ts">
  import { t } from "../i18n";
  import { updates } from "../state/updates.svelte";
</script>

{#if updates.status?.available}
  <button class="badge" title={t("update.available", { version: updates.status.available.version })}
    aria-label={t("update.available", { version: updates.status.available.version })}
    onclick={() => { updates.dialogOpen = true; }}>
    ↑ v{updates.status.available.version}
  </button>
{/if}

<style>
  .badge { flex-shrink: 0; align-self: center; margin: 0 0.4rem; padding: 0.2rem 0.5rem;
    border: 1px solid var(--accent); border-radius: 999px; color: var(--accent);
    background: var(--bg); cursor: pointer; font: inherit; white-space: nowrap; }
</style>
