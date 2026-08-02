import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { checkBrowserRuntimeBoundaries } from
  "../../scripts/architecture/check-browser-runtime-boundaries.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("browser runtime architecture", () => {
  it("keeps element as the sole browser runtime", async () => {
    await expect(checkBrowserRuntimeBoundaries()).resolves.toMatchObject({
      status: "passed",
      canonicalRuntime: "@pixel-point/aval-element"
    });
  });

  it("rejects a nonexistent or malformed repository root", async () => {
    const parent = await temporaryRoot("aval-runtime-missing-");
    await expect(checkBrowserRuntimeBoundaries(join(parent, "missing")))
      .rejects.toThrow(/repository root package manifest is missing/u);

    const malformed = await temporaryRoot("aval-runtime-malformed-");
    await writeFile(join(malformed, "package.json"), "{");
    await expect(checkBrowserRuntimeBoundaries(malformed))
      .rejects.toThrow(/repository root package manifest is not valid JSON/u);
  });

  it("requires the canonical element package and runtime source sentinels", async () => {
    const root = await architectureFixture();
    await rm(join(root, "packages", "element"), {
      recursive: true,
      force: true
    });

    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
      /canonical element package manifest is missing/u
    );
  });

  it.each(["aval-element.ts", "player.ts"])(
    "requires the canonical element %s source sentinel",
    async (sourceFile) => {
      const root = await architectureFixture();
      await rm(join(root, "packages", "element", "src", sourceFile));

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        `canonical element runtime source is missing: packages/element/src/${sourceFile}`
      );
    }
  );

  it.each(["react", "svelte"] as const)(
    "requires the %s wrapper to depend only on element",
    async (wrapper) => {
      const root = await architectureFixture();
      await writePackageManifest(root, wrapper, {
        name: `@pixel-point/aval-${wrapper}`,
        dependencies: {
          "@pixel-point/aval-element": "1.0.0",
          "@pixel-point/aval-format": "1.0.0"
        }
      });

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        new RegExp(`packages/${wrapper} must depend exactly on @pixel-point/aval-element`, "u")
      );
    }
  );

  it("rejects an unreviewed parallel browser runtime package", async () => {
    const root = await architectureFixture();
    await writePackageManifest(root, "browser-runtime", {
      name: "@pixel-point/aval-browser-runtime",
      dependencies: {
        "@pixel-point/aval-format": "1.0.0",
        "@pixel-point/aval-graph": "1.0.0"
      }
    });

    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
      /packages\/browser-runtime is outside the reviewed package architecture/u
    );
  });

  it("retains the retired runtime identity scan", async () => {
    const root = await architectureFixture();
    const retiredPackage = [
      "@pixel-point/aval",
      ["player", "web"].join("-")
    ].join("-");
    await mkdir(join(root, "tools", "source"), { recursive: true });
    await writeFile(
      join(root, "tools", "source", "consumer.ts"),
      `import ${JSON.stringify(retiredPackage)};\n`
    );

    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
      /tools\/source\/consumer.ts: references the removed parallel runtime/u
    );
  });

  it("excludes only generated output and historical evidence", async () => {
    const root = await architectureFixture();
    const retiredPackage = [
      "@pixel-point/aval",
      ["player", "web"].join("-")
    ].join("-");
    await Promise.all([
      mkdir(join(root, "docs", "evidence"), { recursive: true }),
      mkdir(join(root, "output"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(
        join(root, "docs", "evidence", "historical.ts"),
        `import ${JSON.stringify(retiredPackage)};\n`
      ),
      writeFile(
        join(root, "output", "generated.ts"),
        `import ${JSON.stringify(retiredPackage)};\n`
      )
    ]);

    await expect(checkBrowserRuntimeBoundaries(root)).resolves.toMatchObject({
      status: "passed"
    });
  });
});

const PACKAGE_FIXTURES = Object.freeze([
  Object.freeze({
    directory: "certification",
    manifest: Object.freeze({
      name: "@pixel-point/aval-certification",
      private: true,
      dependencies: Object.freeze({ "@pixel-point/aval-format": "1.0.0" })
    })
  }),
  Object.freeze({
    directory: "compiler",
    manifest: Object.freeze({
      name: "@pixel-point/aval-compiler",
      dependencies: Object.freeze({
        "@pixel-point/aval-element": "1.0.0",
        "@pixel-point/aval-format": "1.0.0",
        "@pixel-point/aval-graph": "1.0.0"
      })
    })
  }),
  Object.freeze({
    directory: "element",
    manifest: Object.freeze({
      name: "@pixel-point/aval-element",
      dependencies: Object.freeze({
        "@pixel-point/aval-format": "1.0.0",
        "@pixel-point/aval-graph": "1.0.0"
      })
    })
  }),
  Object.freeze({
    directory: "format",
    manifest: Object.freeze({
      name: "@pixel-point/aval-format",
      dependencies: Object.freeze({ "@pixel-point/aval-graph": "1.0.0" })
    })
  }),
  Object.freeze({
    directory: "graph",
    manifest: Object.freeze({ name: "@pixel-point/aval-graph" })
  }),
  Object.freeze({
    directory: "react",
    manifest: Object.freeze({
      name: "@pixel-point/aval-react",
      dependencies: Object.freeze({ "@pixel-point/aval-element": "1.0.0" })
    })
  }),
  Object.freeze({
    directory: "svelte",
    manifest: Object.freeze({
      name: "@pixel-point/aval-svelte",
      dependencies: Object.freeze({ "@pixel-point/aval-element": "1.0.0" })
    })
  })
]);

async function architectureFixture(): Promise<string> {
  const root = await temporaryRoot("aval-runtime-architecture-");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "aval-workspace-fixture",
    private: true,
    workspaces: ["packages/*"]
  }));
  for (const fixture of PACKAGE_FIXTURES) {
    await writePackageManifest(root, fixture.directory, fixture.manifest);
  }
  const elementSource = join(root, "packages", "element", "src");
  await mkdir(elementSource, { recursive: true });
  await Promise.all([
    writeFile(join(elementSource, "aval-element.ts"), "export {};\n"),
    writeFile(join(elementSource, "player.ts"), "export {};\n")
  ]);
  return root;
}

async function writePackageManifest(
  root: string,
  directory: string,
  manifest: Readonly<Record<string, unknown>>
): Promise<void> {
  const packageRoot = join(root, "packages", directory);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest));
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
