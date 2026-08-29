<script lang="ts">
  /**
   * Owns the syntax-highlighting stylesheet.
   *
   * Rust generates one stylesheet per theme up front; switching themes swaps
   * which one is live. The highlighted markup is class-based and never changes,
   * so no document is re-rendered when the theme flips.
   */
  import { highlightCss, errorMessage, type HighlightCss } from "../ipc";
  import { settings } from "../state/settings.svelte";

  let css = $state<HighlightCss | null>(null);

  $effect(() => {
    let cancelled = false;
    highlightCss()
      .then((loaded) => {
        if (!cancelled) css = loaded;
      })
      .catch((err) => {
        // Losing highlighting degrades code blocks to plain text, which is
        // survivable — log it and carry on.
        console.warn("[dviewer] could not load the highlight stylesheet:", errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const style = document.createElement("style");
    style.dataset.dviewerHighlight = "";
    style.textContent = css ? css[settings.resolvedTheme] : "";
    document.head.append(style);
    return () => style.remove();
  });
</script>
