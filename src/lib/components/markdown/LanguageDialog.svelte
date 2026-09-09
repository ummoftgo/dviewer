<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../i18n';
  import type { HighlightLanguage } from '../../ipc';
  let { languages, current, onChoose, onClose }: {
    languages: HighlightLanguage[]; current: string; onChoose: (name: string) => void; onClose: () => void;
  } = $props();
  let query = $state('');
  let dialog: HTMLDialogElement;
  const filtered = $derived(languages.filter((language) => [language.name, ...language.tokens].some((value) => value.toLowerCase().includes(query.trim().toLowerCase()))));
  onMount(() => dialog.showModal());
</script>

<dialog bind:this={dialog} aria-label={t('markdown.code.language')} onclose={onClose}>
  <h2>{t('markdown.code.language')}</h2>
  <input type="search" bind:value={query} aria-label={t('markdown.code.search')} placeholder={t('markdown.code.search')} />
  <div class="languages">
    {#each filtered as language (language.name)}
      <button class="language" aria-pressed={language.name === current} onclick={() => onChoose(language.name)}>{language.name}</button>
    {/each}
  </div>
  <button class="btn" onclick={() => dialog.close()}>{t('markdown.copy.cancel')}</button>
</dialog>

<style>
  dialog { width: min(26rem, calc(100vw - 3rem)); padding: 1.25rem; border: 1px solid var(--border);
    border-radius: var(--radius); background: var(--bg); color: var(--text); box-shadow: var(--shadow-lg); }
  dialog::backdrop { background: rgb(0 0 0 / 0.35); }
  h2 { margin: 0 0 1rem; font-size: 1.15em; }
  input { width: 100%; }
  .languages { max-height: min(24rem, 55vh); overflow: auto; margin: 0.75rem 0; }
  .language { display: block; width: 100%; text-align: left; padding: 0.4rem; border: 0;
    background: transparent; color: var(--text); border-radius: var(--radius-sm); }
  .language:is(:hover, :focus-visible, [aria-pressed="true"]) { background: var(--accent-subtle); }
</style>
