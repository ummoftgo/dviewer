/**
 * The test runner's configuration, kept apart from `vite.config.ts`.
 *
 * That file is what the Tauri CLI reads to build the app, and a `test:` block
 * in it would be configuration the build has no business carrying. Everything
 * the build does need is merged in from there, so the tests compile the same
 * way the app does — which is the whole reason the runner is vitest rather
 * than something with its own idea of how to read a `.svelte.ts`.
 */
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vite.config.ts";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Tests live beside the code they check, the way the Rust ones do.
      include: ["src/**/*.test.ts"],
      setupFiles: ["test/setup.ts"],
    },
  }),
);
