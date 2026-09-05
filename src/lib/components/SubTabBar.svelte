<script lang="ts">
  import { t } from "../i18n";
  import { family } from "../subtabs";
  import { workspace } from "../state/docs.svelte";
  import Icon from "./Icon.svelte";

  const group = $derived(family(workspace.tabs, workspace.activeId));
  let strip = $state<HTMLElement>();
  $effect(() => {
    void workspace.activeId;
    strip?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  });
</script>

{#if group && group.children.length}
  <div class="subtabs" role="tablist" aria-label={t("subtab.label")} bind:this={strip}>
    {#each [group.parent, ...group.children] as tab (tab.key)}
      {@const self = tab === group.parent}
      {@const source = tab.meta.source}
      {@const stale = source.type === "treeSlice" && source.generation !== (group.parent.meta.generation ?? 0)}
      {@const label = self ? t(`subtab.self.${tab.view}`) : tab.subtabLabel}
      <div class="subtab" class:active={tab.id === workspace.activeId}>
        <button
          class="label"
          class:stale
          role="tab"
          aria-selected={tab.id === workspace.activeId}
          title={self ? tab.meta.title : `${source.type === "treeSlice" ? source.path : tab.meta.title}${stale ? `\n${t("subtab.stale")}` : ""}`}
          onclick={() => workspace.activate(tab.id)}
          onauxclick={(event) => {
            if (!self && event.button === 1) { event.preventDefault(); void workspace.close(tab.id); }
          }}
        >{tab.status === "opening" ? "… " : ""}{label}</button>
        {#if !self}
          <button class="close" aria-label={t("subtab.close", { title: label })} onclick={() => void workspace.close(tab.id)}>
            <Icon name="close" size={11} />
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .subtabs { display: flex; flex: none; min-height: 1.9rem; overflow-x: auto; border-bottom: 1px solid var(--border); background: var(--bg-subtle); }
  .subtab { display: flex; flex: none; align-items: center; max-width: 18rem; border-right: 1px solid var(--border); color: var(--text-secondary); }
  .subtab.active { background: var(--bg); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
  button { border: 0; background: transparent; color: inherit; font: inherit; }
  button:hover { background: var(--bg-hover); }
  .label { padding: 0.3rem 0.65rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label.stale { color: var(--text-muted); font-style: italic; }
  .close { display: flex; flex: none; padding: 0.2rem; margin-right: 0.3rem; border-radius: var(--radius-sm); }
</style>
