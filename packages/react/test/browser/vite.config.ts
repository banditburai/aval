import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const fakeAvalElement = fileURLToPath(
  new URL("./fake-aval-element.ts", import.meta.url)
);

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      // Exercise the real adapter while controlling its element upgrade seam.
      "./definition.js": fakeAvalElement,
      "@pixel-point/aval-react": fileURLToPath(
        new URL("../../src/index.ts", import.meta.url)
      ),
      "@pixel-point/aval-element/adapter": fileURLToPath(
        new URL("../../../element/src/adapter.ts", import.meta.url)
      ),
      "@pixel-point/aval-element": fakeAvalElement
    }
  }
});
