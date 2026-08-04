import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { validateSourceProject } from "../src/source-project-schema.js";

describe("documented motion project", () => {
  it("keeps the README and reference examples valid and compilable", async () => {
    for (const relativePath of [
      "../../../README.md",
      "../../../docs/project/1.0.md"
    ]) {
      const document = await readFile(
        new URL(relativePath, import.meta.url),
        "utf8"
      );
      const source = document.match(
        /<!-- BEGIN MOTION PROJECT EXAMPLE -->\n```json\n([\s\S]*?)\n```\n<!-- END MOTION PROJECT EXAMPLE -->/u
      )?.[1];

      expect(source, relativePath).toBeDefined();
      if (source === undefined) {
        throw new Error(`${relativePath} motion project is missing`);
      }
      const project = validateSourceProject(JSON.parse(source));
      expect(project.projectVersion).toBe("1.0");
      expect(project.initialState).toBe("idle");
      expect(project.encodings.map(({ codec }) => codec)).toEqual(["vp9"]);
    }
  });
});
