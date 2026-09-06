<script lang="ts">
  import { onMount } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { t } from "../i18n";
  import { errorMessage } from "../ipc";
  import { formatBytes } from "../format";
  import { updates } from "../state/updates.svelte";

  let dialog: HTMLDialogElement;
  const info = $derived(updates.status?.available);
  const phase = $derived(updates.status?.phase);
  const busy = $derived(phase === "downloading" || phase === "installing");
  const progress = $derived(updates.status?.progress);
  const error = $derived(updates.error ?? updates.status?.error);
  onMount(() => dialog.showModal());
</script>

<dialog bind:this={dialog} aria-labelledby="update-title"
  onclose={() => { updates.dialogOpen = false; }}
  oncancel={(event) => { if (busy) event.preventDefault(); }}>
  {#if info}
    <h2 id="update-title">{t("update.available", { version: info.version })}</h2>
    {#if info.notes}<p class="notes">{info.notes}</p>{/if}
    {#if info.canInstall}
      <p>{t("update.reopenWarning")}</p>
    {:else}
      <p>{t("update.linkOnly")}</p>
    {/if}
    {#if busy}
      <p role="status">{t(phase === "installing" ? "update.installing" : "update.downloading")}</p>
      <progress max={progress?.total || 1} value={progress?.total ? progress.received : undefined}
        aria-label={t("update.downloading")}></progress>
      {#if progress}<p>{formatBytes(progress.received)}{progress.total ? ` / ${formatBytes(progress.total)}` : ""}</p>{/if}
    {/if}
    {#if error}<p class="error" role="alert">{errorMessage(error)}</p>{/if}
    <div class="actions">
      {#if info.canInstall && !busy}
        <button class="btn btn-primary" disabled={phase !== "idle"}
          onclick={() => updates.install(info.version)}>{t("update.install")}</button>
      {/if}
      {#if busy}
        <button class="btn" disabled={phase !== "downloading"}
          onclick={() => updates.cancel()}>{t("update.cancel")}</button>
      {:else}
        <button class="btn" onclick={() => dialog.close()}>{t("update.later")}</button>
        <button class="btn" disabled={phase !== "idle"}
          onclick={() => updates.skip(info.version)}>{t("update.skip")}</button>
        <button class="btn" onclick={() => openUrl(info.releaseUrl).catch((error) => { updates.error = error; })}>
          {t("update.release")}
        </button>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  dialog { width: min(32rem, calc(100vw - 3rem)); max-height: calc(100vh - 3rem); overflow: auto;
    padding: 1.5rem; border: 1px solid var(--border); border-radius: 0.6rem;
    background: var(--bg); color: var(--text); box-shadow: var(--shadow-lg); }
  dialog::backdrop { background: rgb(0 0 0 / 0.35); }
  h2 { margin-top: 0; font-size: 1.15em; }
  .notes { white-space: pre-wrap; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; }
  progress { width: 100%; accent-color: var(--accent); }
  .error { color: var(--danger); overflow-wrap: anywhere; }
</style>
