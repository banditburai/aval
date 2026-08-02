import { fileURLToPath } from "node:url";

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [svelte({
    configFile: fileURLToPath(new URL("../../svelte.config.js", import.meta.url))
  })],
  resolve: {
    alias: [
      {
        find: "@pixel-point/aval-element/adapter",
        replacement: fileURLToPath(new URL("../../../element/src/adapter.ts", import.meta.url))
      },
      {
        find: "@pixel-point/aval-element",
        replacement: fileURLToPath(new URL("../../../element/src/index.ts", import.meta.url))
      }
    ]
  }
});
