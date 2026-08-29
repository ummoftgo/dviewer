<script lang="ts">
  import Icon from "./Icon.svelte";
  import { pickFiles } from "../open";
  import { workspace } from "../state/docs.svelte";
  import { recents } from "../state/recents.svelte";
  import { DOC_KINDS, kindBadge, type DocKind } from "../ipc";
  import { n, t } from "../i18n";

  interface Props {
    onOpenSettings: () => void;
  }

  let { onOpenSettings }: Props = $props();

  type Mode = "url" | "paste";

  let mode = $state<Mode | null>(null);
  let url = $state("");
  let pasted = $state("");
  let pastedKind = $state<DocKind | "auto">("auto");

  async function submitUrl(event: SubmitEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    const opened = await workspace.openUrl(url.trim());
    if (opened) {
      url = "";
      mode = null;
    }
  }

  async function submitPaste(event: SubmitEvent) {
    event.preventDefault();
    if (!pasted.trim()) return;
    const kind = pastedKind === "auto" ? undefined : pastedKind;
    const opened = await workspace.openText(pasted, undefined, kind);
    if (opened) {
      pasted = "";
      mode = null;
    }
  }

  function toggle(next: Mode) {
    mode = mode === next ? null : next;
  }

  function fileName(path: string) {
    return path.split(/[\\/]/).pop() ?? path;
  }

  function parentDir(path: string) {
    // Slice at the last separator rather than split-and-rejoin: rejoining
    // would impose one platform's separator on the other's paths.
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return cut > 0 ? path.slice(0, cut) : "";
  }

  function relativeTime(at: number) {
    const minutes = Math.round((Date.now() - at) / 60000);
    if (minutes < 1) return t("time.justNow");
    if (minutes < 60) return t("time.minutes", { n: n(minutes) });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t("time.hours", { n: n(hours) });
    return t("time.days", { n: n(Math.round(hours / 24)) });
  }
</script>

<div class="start">
  <div class="inner">
    <header>
      <div class="titles">
        <h1>dviewer</h1>
        <p>{t("start.intro")}</p>
      </div>
      <!-- The toolbar only exists once a document is open, so without this the
           settings are unreachable from a cold start. -->
      <button class="icon-btn" onclick={onOpenSettings} title={t("toolbar.settings")}
        aria-label={t("toolbar.settings")}>
        <Icon name="settings" />
      </button>
    </header>

    {#if workspace.notice}
      <p class="notice" role="alert">
        <Icon name="warning" />
        {workspace.notice}
      </p>
    {/if}

    <div class="actions">
      <button class="btn btn-primary" onclick={pickFiles} disabled={workspace.opening}>
        <Icon name="file" />
        {t("start.openFile")}
      </button>
      <button
        class="btn"
        class:on={mode === "url"}
        aria-pressed={mode === "url"}
        onclick={() => toggle("url")}
      >
        <Icon name="link" />
        {t("start.openUrl")}
      </button>
      <button
        class="btn"
        class:on={mode === "paste"}
        aria-pressed={mode === "paste"}
        onclick={() => toggle("paste")}
      >
        <Icon name="clipboard" />
        {t("start.paste")}
      </button>
    </div>

    {#if mode === "url"}
      <form class="panel" onsubmit={submitUrl}>
        <input
          class="field"
          type="url"
          bind:value={url}
          placeholder="https://example.com/README.md"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="btn btn-primary" type="submit" disabled={!url.trim() || workspace.opening}>
          {workspace.opening ? t("action.opening") : t("action.open")}
        </button>
      </form>
    {/if}

    {#if mode === "paste"}
      <form class="panel column" onsubmit={submitPaste}>
        <textarea
          class="field"
          bind:value={pasted}
          rows="8"
          placeholder={t("start.pastePlaceholder")}
          spellcheck="false"
        ></textarea>
        <div class="row">
          <!-- Pasted text has no file name, and only JSON and XML can be
               recognised from their content alone, so the rest have to be
               named here. -->
          <label class="paste-kind">
            {t("toolbar.format.label")}
            <select bind:value={pastedKind}>
              <option value="auto">{t("start.auto")}</option>
              {#each DOC_KINDS as entry (entry.kind)}
                <option value={entry.kind}>{t(entry.label)}</option>
              {/each}
            </select>
          </label>
          <button class="btn btn-primary" type="submit" disabled={!pasted.trim()}>
            {t("action.open")}
          </button>
        </div>
      </form>
    {/if}

    {#if recents.entries.length > 0}
      <section class="recents">
        <div class="recents-head">
          <h2>{t("start.recents")}</h2>
          <button class="btn btn-ghost small" onclick={() => recents.clear()}>
            {t("start.clearRecents")}
          </button>
        </div>
        <ul>
          {#each recents.entries as entry (entry.path)}
            <li>
              <button class="recent" onclick={() => workspace.openPath(entry.path)}>
                <span class="kind" data-kind={entry.kind}>{kindBadge(entry.kind)}</span>
                <span class="name">{fileName(entry.path)}</span>
                <span class="dir" title={entry.path}>{parentDir(entry.path)}</span>
                <span class="when">{relativeTime(entry.openedAt)}</span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
</div>

<style>
  .start {
    height: 100%;
    overflow-y: auto;
    display: flex;
    justify-content: center;
    padding: 3rem 1.5rem;
  }

  .inner {
    width: 100%;
    max-width: 40rem;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  header h1 {
    margin: 0;
    font-size: 1.97em;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  header p {
    margin: 0.4rem 0 0;
    color: var(--text-secondary);
  }

  .notice {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin: 1.25rem 0 0;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    color: var(--danger);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1.75rem;
  }

  .actions .btn.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .panel {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-subtle);
  }

  .panel.column {
    flex-direction: column;
  }

  .panel textarea {
    resize: vertical;
    font-family: var(--font-code);
    font-size: 1em;
    line-height: 1.5;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .paste-kind {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--text-muted);
    font-size: 0.9em;
  }

  .paste-kind select {
    padding: 0.25rem 0.3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text);
    font: inherit;
  }

  .recents {
    margin-top: 2.5rem;
  }

  .recents-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .recents h2 {
    margin: 0;
    font-size: 0.92em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .small {
    padding: 0.15rem 0.4rem;
    font-size: 0.92em;
    color: var(--text-muted);
  }

  .recents ul {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .recents li + li {
    border-top: 1px solid var(--border);
  }

  .recent {
    display: grid;
    grid-template-columns: auto minmax(0, auto) minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    background: transparent;
    text-align: left;
  }

  .recent:hover {
    background: var(--bg-hover);
  }

  .kind {
    font-family: var(--font-code);
    font-size: 0.77em;
    line-height: 1;
    padding: 0.2rem 0.25rem;
    border-radius: var(--radius-sm);
    background: var(--bg-inset);
    color: var(--text-muted);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dir,
  .when {
    color: var(--text-muted);
    font-size: 0.92em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .when {
    text-align: right;
  }
</style>
