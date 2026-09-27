import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { mkdirSync, writeFileSync } from "node:fs";
import { bundledPackages } from "./src/lib/notices";

const host = process.env.TAURI_DEV_HOST;

/**
 * Records which npm packages the build actually bundled — devDependencies
 * included when imported, nothing that was only installed. scripts/notices.mjs
 * turns the list into the JavaScript half of THIRD-PARTY-NOTICES. Workers are
 * separate bundles, so their modules are added to the same set.
 */
const bundled = new Set<string>();
function noticesModules(): Plugin {
  return {
    name: "dviewer-notices",
    apply: "build",
    generateBundle() {
      for (const id of this.getModuleIds()) bundled.add(id);
      mkdirSync("node_modules/.cache/dviewer-notices", { recursive: true });
      writeFileSync("node_modules/.cache/dviewer-notices/npm.json", JSON.stringify(bundledPackages(bundled), null, 1));
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), noticesModules()],
  worker: { plugins: () => [noticesModules()] },

  // Vite options tailored for Tauri development, applied in `tauri dev` / `tauri build`.
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri uses Chromium on Windows/Linux and WebKit on macOS
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    // Boolean, not a named minifier: Vite 8 replaced the bundled esbuild with
    // oxc, and naming one pins us to whatever the current release ships.
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
