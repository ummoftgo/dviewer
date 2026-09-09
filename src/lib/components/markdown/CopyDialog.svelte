<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../i18n';
  let { heading = false, onChoose, onClose }: {
    heading?: boolean;
    onChoose: (choice: 'raw' | 'html' | 'heading' | 'section') => void;
    onClose: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  onMount(() => dialog.showModal());
</script>

<dialog bind:this={dialog} aria-label={t(heading ? 'markdown.copy.childrenQuestion' : 'markdown.copy.question')} onclose={onClose}>
  <h2>{t(heading ? 'markdown.copy.childrenQuestion' : 'markdown.copy.question')}</h2>
  <div class="actions">
    {#if heading}
      <button class="btn" onclick={() => onChoose('heading')}>{t('markdown.copy.headingOnly')}</button>
      <button class="btn btn-primary" onclick={() => onChoose('section')}>{t('markdown.copy.withChildren')}</button>
    {:else}
      <button class="btn btn-primary" onclick={() => onChoose('html')}>{t('markdown.copy.html')}</button>
      <button class="btn" onclick={() => onChoose('raw')}>{t('markdown.copy.raw')}</button>
    {/if}
    <button class="btn" onclick={() => dialog.close()}>{t('markdown.copy.cancel')}</button>
  </div>
</dialog>

<style>
  dialog { max-width: calc(100vw - 3rem); padding: 1.5rem; border: 1px solid var(--border);
    border-radius: var(--radius); background: var(--bg); color: var(--text); box-shadow: var(--shadow-lg); }
  dialog::backdrop { background: rgb(0 0 0 / 0.35); }
  h2 { margin-top: 0; font-size: 1.15em; }
  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
</style>
