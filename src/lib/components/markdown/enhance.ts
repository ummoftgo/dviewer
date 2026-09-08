/**
 * Post-processing applied to the HTML Rust hands us.
 *
 * Rust does the parsing, sanitising and syntax highlighting; the browser
 * resolves image paths, lays out diagrams, typesets maths and sizes table columns.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { toasts } from "../../state/toast.svelte";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DocMeta } from "../../ipc";
import { ICON_PATHS } from "../Icon.svelte";
import { fillWidths, rectangularColumns, resizeWidths, widthRatios, type TableMode, type TableState } from "./tables";

/** Collapse `.` and `..` segments so a path is safe to hand to the asset protocol. */
function normalizeSegments(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  // A leading drive letter or root slash must survive the rebuild.
  return (path.startsWith("/") ? "/" : "") + out.join("/");
}

function isAbsolute(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//") || src.startsWith("/");
}

/**
 * Point relative `<img src>` at something the webview can actually load.
 * File documents resolve through the asset protocol, URL documents against the
 * document's own address.
 */
export function rewriteImages(root: HTMLElement, meta: DocMeta) {
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!src) continue;

    if (!isAbsolute(src)) {
      if (meta.source.type === "file" && meta.baseDir) {
        const base = meta.baseDir.replace(/\\/g, "/").replace(/\/$/, "");
        img.src = convertFileSrc(normalizeSegments(`${base}/${src}`));
      } else if (meta.source.type === "url") {
        try {
          img.src = new URL(src, meta.source.url).toString();
        } catch {
          // Leave it alone; the error handler below will mark it.
        }
      }
    }

    img.loading = "lazy";
    img.addEventListener(
      "error",
      () => {
        img.classList.add("img-missing");
        // The browser's broken-image icon says nothing useful; the path does.
        img.removeAttribute("src");
        if (!img.alt) img.alt = t("markdown.imageMissing", { src });
      },
      { once: true },
    );
  }
}

/**
 * Send outbound links to the system browser. Navigating the webview itself
 * would replace the whole app with the target page and there is no way back.
 */
export function interceptLinks(root: HTMLElement, onAnchor: (id: string) => void): () => void {
  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;

    event.preventDefault();
    if (href.startsWith("#")) {
      onAnchor(decodeURIComponent(href.slice(1)));
      return;
    }
    // Handed to the OS, which decides what opens them. The list is closed on
    // purpose: `javascript:` and `data:` must never reach a handler, and a
    // scheme nobody recognises is better refused out loud than swallowed.
    if (/^(https?|mailto|tel):/i.test(href)) {
      void openUrl(href).catch((err) => {
        console.warn("[dviewer] could not open the link:", err);
        toasts.show(t("link.failed"), "error");
      });
      return;
    }

    // Everything else — a relative path to another document, an unknown
    // scheme — was cancelled and then dropped, so the link simply did nothing
    // and never said why.
    toasts.show(t("link.unsupported"), "info");
  };

  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}

/** Replace `<pre class="mermaid-source">` blocks with rendered diagrams. */
export async function renderMermaid(root: HTMLElement, dark: boolean) {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre.mermaid-source")];
  if (blocks.length === 0) return;

  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? "dark" : "default",
    securityLevel: "strict",
    fontFamily: "var(--font-ui)",
  });

  await Promise.all(
    blocks.map(async (block, i) => {
      const source = block.textContent ?? "";
      const container = document.createElement("div");
      container.className = "mermaid-block";
      try {
        const { svg } = await mermaid.render(`dviewer-mermaid-${Date.now()}-${i}`, source);
        container.innerHTML = svg;
      } catch (err) {
        // A broken diagram should show its source and the reason, not vanish.
        container.classList.add("mermaid-error");
        container.textContent = t("markdown.mermaidError", {
        detail: err instanceof Error ? err.message : String(err),
      });
        const pre = document.createElement("pre");
        pre.textContent = source;
        container.append(pre);
      }
      block.replaceWith(container);
    }),
  );
}

/** Typeset the `data-math-style` spans comrak emits. */
export async function renderMath(root: HTMLElement) {
  const nodes = [...root.querySelectorAll<HTMLElement>("[data-math-style]")];
  if (nodes.length === 0) return;

  const [katex] = await Promise.all([
    import("katex").then((m) => m.default),
    import("katex/dist/katex.min.css"),
  ]);

  for (const node of nodes) {
    const displayMode = node.dataset.mathStyle === "display";
    try {
      const html = katex.renderToString(node.textContent ?? "", {
        displayMode,
        throwOnError: true,
        output: "html",
      });
      const wrapper = document.createElement(displayMode ? "div" : "span");
      wrapper.innerHTML = html;
      node.replaceWith(wrapper);
    } catch (err) {
      node.classList.add("math-error");
      node.title = err instanceof Error ? err.message : String(err);
    }
  }
}

export interface EnhancedTables {
  refresh(): void;
  destroy(): void;
}

const enhancedTables = new WeakMap<HTMLElement, EnhancedTables>();

/** The tab owns values; this handle owns only the current DOM and its observers. */
export function enhanceTables(root: HTMLElement, states: Map<number, TableState>, defaultMode: TableMode): EnhancedTables {
  const existing = enhancedTables.get(root);
  if (existing) return existing;
  const layouts = new Map<Element, () => void>();
  const refreshers: (() => void)[] = [];
  const cleanups: (() => void)[] = [];
  const pending = new Set<() => void>();
  let frame = 0;
  const schedule = (layout: () => void) => {
    pending.add(layout);
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      for (const apply of pending) apply();
      pending.clear();
    });
  };
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const layout = layouts.get(entry.target);
      if (layout) schedule(layout);
    }
  });

  root.querySelectorAll("table").forEach((table, index) => {
    const count = rectangularColumns(table.rows);
    if (!count || table.querySelector("table") || table.parentElement?.closest("table")) return;
    const state = states.get(index) ?? { mode: defaultMode };
    states.set(index, state);
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    wrap.dataset.table = String(index);
    const viewport = document.createElement("div");
    viewport.className = "table-viewport";
    const toolbar = document.createElement("div");
    toolbar.className = "table-tools";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.dataset.action = "mode";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.dataset.action = "reset";
    toolbar.append(toggle, reset);
    table.before(wrap);
    viewport.append(table);
    wrap.append(toolbar, viewport);

    const oldGroups = [...table.children].filter((child) => child.tagName === "COLGROUP");
    for (const group of oldGroups) group.remove();
    const group = document.createElement("colgroup");
    const cols = Array.from({ length: count }, () => document.createElement("col"));
    for (const col of cols) group.append(col);
    const caption = table.querySelector(":scope > caption");
    if (caption) caption.after(group);
    else table.prepend(group);
    const cells = [...table.rows[0].cells];
    let natural: number[] | undefined;
    let border = 0;
    let minimum = 0;
    const grips = cells.map((cell, column) => {
      const grip = document.createElement("span");
      grip.className = "table-grip";
      grip.setAttribute("role", "separator");
      grip.setAttribute("aria-orientation", "vertical");
      cell.append(grip);
      grip.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter" || event.key === "End") fit(column);
        else {
          const widths = currentWidths();
          const step = event.shiftKey ? 24 : 8;
          change(widths, column, event.key === "Home" ? minimum - widths[column] : event.key === "ArrowLeft" ? -step : step);
        }
      };
      grip.ondblclick = (event) => { event.preventDefault(); fit(column); };
      let drag: { pointer: number; x: number; widths: number[] } | undefined;
      function end() {
        if (drag && grip.hasPointerCapture(drag.pointer)) grip.releasePointerCapture(drag.pointer);
        drag = undefined;
        wrap.classList.remove("table-resizing");
      }
      grip.onpointerdown = (event) => {
        if (event.button !== 0 || (state.mode === "fill" && count === 1)) return;
        event.preventDefault();
        grip.focus();
        drag = { pointer: event.pointerId, x: event.clientX, widths: currentWidths() };
        grip.setPointerCapture(event.pointerId);
        wrap.classList.add("table-resizing");
      };
      grip.onpointermove = (event) => {
        if (drag && drag.pointer === event.pointerId) change(drag.widths, column, event.clientX - drag.x);
      };
      grip.onpointerup = grip.onpointercancel = grip.onlostpointercapture = end;
      cleanups.push(() => {
        end();
        grip.onkeydown = grip.ondblclick = grip.onpointerdown = grip.onpointermove = null;
        grip.onpointerup = grip.onpointercancel = grip.onlostpointercapture = null;
        grip.remove();
      });
      return grip;
    });

    function currentWidths() {
      return cells.map((cell) => cell.getBoundingClientRect().width);
    }

    function change(widths: number[], column: number, delta: number) {
      if (state.mode === "fill" && count === 1) return;
      const next = resizeWidths(widths, column, delta, state.mode, minimum);
      if (state.mode === "scroll") state.scrollWidths = next;
      else state.fillRatios = widthRatios(next);
      layout();
    }

    function fit(column: number) {
      if (state.mode === "fill" && count === 1) return;
      const widths = currentWidths();
      const left = viewport.scrollLeft;
      measure();
      change(widths, column, natural![column] - widths[column]);
      viewport.scrollLeft = left;
    }

    function labels() {
      const next = state.mode === "scroll" ? "fill" : "scroll";
      const label = t(`markdown.table.${next}`);
      toggle.title = label;
      toggle.setAttribute("aria-label", label);
      toggle.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="${ICON_PATHS[next === "fill" ? "fit-width" : "scroll-x"]}" /></svg>`;
      reset.textContent = t("markdown.table.reset");
      reset.title = reset.textContent;
      reset.disabled = !state.scrollWidths && !state.fillRatios;
      grips.forEach((grip, column) => {
        const disabled = state.mode === "fill" && count === 1;
        grip.tabIndex = disabled ? -1 : 0;
        grip.setAttribute("aria-disabled", String(disabled));
        grip.setAttribute("aria-label", t("markdown.table.resize", { column: column + 1 }));
        grip.title = t("markdown.table.resizeHint");
      });
    }

    function measure() {
      wrap.dataset.mode = "scroll";
      table.style.tableLayout = "auto";
      table.style.width = "max-content";
      for (const col of cols) col.style.width = "";
      natural = cells.map((cell) => cell.getBoundingClientRect().width);
      border = Math.max(0, table.getBoundingClientRect().width - natural.reduce((sum, width) => sum + width, 0));
      minimum = cells.reduce((minimum, cell) => {
        const css = getComputedStyle(cell);
        return Math.max(minimum, parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) + 2);
      }, 3 * parseFloat(getComputedStyle(document.documentElement).fontSize));
    }

    function applyWidths(widths: number[]) {
      table.style.tableLayout = "fixed";
      table.style.width = `${widths.reduce((sum, width) => sum + width, 0) + border}px`;
      cols.forEach((col, column) => { col.style.width = `${widths[column]}px`; });
    }

    function layout() {
      labels();
      if (!table.checkVisibility() || viewport.clientWidth === 0) return;
      const left = viewport.scrollLeft;
      if (!natural) measure();
      wrap.dataset.mode = state.mode;
      if (state.mode === "fill") {
        applyWidths(fillWidths(state.fillRatios ?? natural!, viewport.clientWidth - border, minimum));
      } else if (state.scrollWidths) {
        applyWidths(state.scrollWidths.map((width) => Math.max(minimum, width)));
      } else {
        table.style.tableLayout = "auto";
        table.style.width = "max-content";
        for (const col of cols) col.style.width = "";
      }
      viewport.scrollLeft = left;
      const widths = currentWidths();
      grips.forEach((grip, column) => {
        grip.setAttribute("aria-valuemin", String(Math.round(minimum)));
        grip.setAttribute("aria-valuenow", String(Math.round(widths[column])));
        grip.setAttribute("aria-valuetext", `${Math.round(widths[column])}px`);
        if (state.mode === "fill") {
          const neighbor = column === count - 1 ? column - 1 : column + 1;
          grip.setAttribute("aria-valuemax", String(Math.round(count === 1 ? widths[column] : widths[column] + widths[neighbor] - minimum)));
        } else grip.removeAttribute("aria-valuemax");
      });
    }

    toggle.onclick = () => {
      state.mode = state.mode === "scroll" ? "fill" : "scroll";
      layout();
    };
    reset.onclick = () => {
      delete state.scrollWidths;
      delete state.fillRatios;
      natural = undefined;
      layout();
    };
    refreshers.push(() => { natural = undefined; schedule(layout); });
    layouts.set(viewport, layout);
    observer.observe(viewport);
    layout();
    cleanups.push(() => {
      toggle.onclick = reset.onclick = null;
      group.remove();
      table.prepend(...oldGroups);
      table.style.removeProperty("width");
      table.style.removeProperty("table-layout");
      wrap.replaceWith(table);
    });
  });

  const refresh = () => { for (const update of refreshers) update(); };
  // Lazy images and a newly opened details element can change intrinsic widths.
  root.addEventListener("load", refresh, true);
  root.addEventListener("toggle", refresh, true);
  document.fonts.addEventListener("loadingdone", refresh);
  const handle = {
    refresh,
    destroy() {
      observer.disconnect();
      cancelAnimationFrame(frame);
      pending.clear();
      root.removeEventListener("load", refresh, true);
      root.removeEventListener("toggle", refresh, true);
      document.fonts.removeEventListener("loadingdone", refresh);
      for (const cleanup of cleanups) cleanup();
      enhancedTables.delete(root);
    },
  };
  enhancedTables.set(root, handle);
  return handle;
}
