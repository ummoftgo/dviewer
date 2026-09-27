import { expect, test } from "vitest";
import { assembleNotices, bundledPackages, fence, npmSection } from "./notices";

test("only packages in the module graph, innermost node_modules winning, scoped names whole", () => {
  const ids = [
    "G:/Works/dviewer/src/lib/app.ts",
    "\0vite/preload-helper.js",
    "G:\\Works\\dviewer\\node_modules\\katex\\dist\\katex.mjs",
    "G:/Works/dviewer/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2?url",
    "/repo/node_modules/@tauri-apps/api/core.js",
    "/repo/node_modules/mermaid/node_modules/d3/src/index.js",
    "/repo/node_modules/.vite/deps/chunk.js",
    "/repo/not_node_modules/x/index.js",
    "\0/repo/node_modules/svelte/src/internal/client/index.js?commonjs-proxy",
  ];
  expect(bundledPackages(ids)).toEqual([
    { name: "@tauri-apps/api", dir: "/repo/node_modules/@tauri-apps/api" },
    { name: "d3", dir: "/repo/node_modules/mermaid/node_modules/d3" },
    { name: "katex", dir: "G:/Works/dviewer/node_modules/katex" },
    { name: "svelte", dir: "/repo/node_modules/svelte" },
  ]);
});

test("a licence text cannot close its own fence", () => {
  expect(fence("MIT License\r\n\r\nCopyright\n\n")).toBe("````text\nMIT License\n\nCopyright\n````");
  const tricky = fence("before\n`````\nafter");
  expect(tricky.startsWith("``````text\n")).toBe(true);
  expect(tricky.endsWith("\n``````")).toBe(true);
});

test("the npm section names each package and says so when it ships no licence file", () => {
  const section = npmSection([
    { name: "katex", version: "0.18.4", license: "MIT", files: [{ name: "LICENSE", text: "The MIT License (MIT)\n\nCopyright (c) Khan Academy" }] },
    { name: "fastdom", version: "1.0.12", license: "MIT", author: "Wilson Page", files: [] },
  ]);
  expect(section).toContain("### katex 0.18.4 — MIT\n\nLICENSE:\n\n````text\nThe MIT License (MIT)\n\nCopyright (c) Khan Academy\n````");
  expect(section).toContain("### fastdom 1.0.12 — MIT\n\nThe package ships no licence file; its package.json declares MIT, by Wilson Page.");
});

test("the document puts dviewer's own licence first, then the parts in order", () => {
  const text = assembleNotices({
    version: "0.23.0", license: "MIT License\n\nCopyright (c) 2026 yonghyeon",
    staticPart: "## Components without their own package metadata\n",
    pdfjs: { version: "6.3.289", files: [{ name: "LICENSE", text: "Apache License" }] },
    rust: "## Rust crates\n", npm: "## JavaScript packages\n",
  });
  const order = ["# Third-party notices", "## dviewer", "Copyright (c) 2026 yonghyeon", "## Components without",
    "## PDF.js 6.3.289", "### LICENSE", "## Rust crates", "## JavaScript packages"].map((mark) => text.indexOf(mark));
  expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
  expect(text).toContain("dviewer 0.23.0 is released under the MIT License");
});
