import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { createPlaygroundConfig } from "./vite.shared.js";

export default defineConfig({
  ...createPlaygroundConfig(),
  resolve: {
    // The local playground exercises workspace sources without a prior build.
    alias: {
      "@pixel-point/aval-format": fileURLToPath(
        new URL("../../packages/format/src/index.ts", import.meta.url)
      ),
      "@pixel-point/aval-graph": fileURLToPath(
        new URL("../../packages/graph/src/index.ts", import.meta.url)
      ),
      "@pixel-point/aval-element/auto": fileURLToPath(
        new URL("../../packages/element/src/auto.ts", import.meta.url)
      ),
      "@pixel-point/aval-element": fileURLToPath(
        new URL("../../packages/element/src/index.ts", import.meta.url)
      )
    }
  }
});
