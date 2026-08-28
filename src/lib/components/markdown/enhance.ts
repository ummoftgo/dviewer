/**
 * Post-processing applied to the HTML Rust hands us.
 *
 * Rust does the parsing, sanitising and syntax highlighting; these three things
 * genuinely need the browser: resolving image paths against the app's asset
 * protocol, laying out diagrams, and typesetting maths.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DocMeta } from "../../ipc";

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
        if (!img.alt) img.alt = `이미지를 찾을 수 없습니다: ${src}`;
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
    if (/^https?:/i.test(href)) {
      void openUrl(href).catch((err) => console.warn("[dviewer] 링크를 열지 못했습니다:", err));
    }
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
        container.textContent = `mermaid 오류: ${err instanceof Error ? err.message : String(err)}`;
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
