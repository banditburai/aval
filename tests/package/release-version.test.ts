import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bumpReleaseVersion,
  nextReleaseVersion,
  parseStableVersion,
  validateReleaseVersionState
} from "../../scripts/release/release-version.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("stable synchronized release versions", () => {
  it("calculates major, minor, patch, and exact stable releases", () => {
    expect(parseStableVersion("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      text: "1.2.3"
    });
    expect(nextReleaseVersion("1.2.3", "major")).toBe("2.0.0");
    expect(nextReleaseVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextReleaseVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextReleaseVersion("1.2.3", "2.4.0")).toBe("2.4.0");
  });

  it.each([
    "1.2",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-next.1",
    "1.2.3+build.1",
    "v1.2.3",
    "1.2.3\n"
  ])("rejects non-stable or non-canonical input %j", (value) => {
    expect(() => parseStableVersion(value)).toThrow(/stable SemVer/u);
  });

  it("rejects exact versions that do not increase", () => {
    expect(() => nextReleaseVersion("1.2.3", "1.2.3")).toThrow(/greater/u);
    expect(() => nextReleaseVersion("1.2.3", "1.2.2")).toThrow(/greater/u);
  });

  it("updates package versions and only exact internal dependency references", async () => {
    const root = await fixtureRepository();
    const result = await bumpReleaseVersion(root, "minor");
    expect(result).toMatchObject({ previousVersion: "1.0.0", version: "1.1.0" });

    const graph = await json(join(root, "packages/graph/package.json"));
    const format = await json(join(root, "packages/format/package.json"));
    const certification = await json(join(root, "packages/certification/package.json"));
    const example = await json(join(root, "examples/demo/package.json"));
    const policy = await json(join(root, "config/release/release-policy.json"));
    const legal = await json(join(root, "config/release/legal-review.json"));
    const readme = await readFile(join(root, "README.md"), "utf8");

    expect(graph.version).toBe("1.1.0");
    expect(format.version).toBe("1.1.0");
    expect(format.dependencies).toEqual({
      "@pixel-point/aval-graph": "1.1.0",
      thirdparty: "^1.0.0"
    });
    expect(certification).toMatchObject({
      version: "1.1.0",
      private: true,
      dependencies: { "@pixel-point/aval-format": "1.1.0" }
    });
    expect(example.version).toBe("7.8.9");
    expect(example.dependencies).toEqual({ "@pixel-point/aval-format": "1.1.0" });
    expect(policy).toMatchObject({ releaseVersion: "1.1.0", wireFormatVersion: "1.1" });
    expect(legal).toMatchObject({
      releaseVersion: "1.1.0",
      status: "pending",
      reviewId: null,
      reviewerRole: null,
      reviewedAt: null
    });
    expect(readme).toContain("npm install @pixel-point/aval-format@1.1.0");
    await expect(validateReleaseVersionState(root, { includeLockfile: false }))
      .resolves.toMatchObject({ version: "1.1.0", publicPackages: 2, packages: 3 });
  });

  it("reports drift instead of silently choosing one package version", async () => {
    const root = await fixtureRepository();
    const manifestPath = join(root, "packages/format/package.json");
    const manifest = await json(manifestPath);
    await writeJson(manifestPath, { ...manifest, version: "1.0.1" });
    await expect(validateReleaseVersionState(root, { includeLockfile: false }))
      .rejects.toThrow(/version drift/u);
  });
});

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aval-release-version-test-"));
  temporaryRoots.push(root);
  await Promise.all([
    mkdir(join(root, "packages/graph"), { recursive: true }),
    mkdir(join(root, "packages/format"), { recursive: true }),
    mkdir(join(root, "packages/certification"), { recursive: true }),
    mkdir(join(root, "examples/demo"), { recursive: true }),
    mkdir(join(root, "config/release"), { recursive: true })
  ]);
  await Promise.all([
    writeJson(join(root, "packages/graph/package.json"), {
      name: "@pixel-point/aval-graph",
      version: "1.0.0",
      private: false,
      dependencies: {}
    }),
    writeJson(join(root, "packages/format/package.json"), {
      name: "@pixel-point/aval-format",
      version: "1.0.0",
      private: false,
      dependencies: {
        "@pixel-point/aval-graph": "1.0.0",
        thirdparty: "^1.0.0"
      }
    }),
    writeJson(join(root, "packages/certification/package.json"), {
      name: "@pixel-point/aval-certification",
      version: "1.0.0",
      private: true,
      dependencies: { "@pixel-point/aval-format": "1.0.0" }
    }),
    writeJson(join(root, "examples/demo/package.json"), {
      name: "demo",
      version: "7.8.9",
      private: true,
      dependencies: { "@pixel-point/aval-format": "1.0.0" }
    }),
    writeJson(join(root, "config/release/release-policy.json"), {
      schemaVersion: "1.0",
      releaseVersion: "1.0.0",
      wireFormatVersion: "1.1",
      publicPackages: ["@pixel-point/aval-graph", "@pixel-point/aval-format"]
    }),
    writeJson(join(root, "config/release/api-changes.json"), {
      schemaVersion: "1.0",
      releaseVersion: "1.0.0"
    }),
    writeJson(join(root, "config/release/legal-review.json"), {
      schemaVersion: "1.0",
      releaseVersion: "1.0.0",
      status: "approved",
      reviewId: "old-review",
      reviewerRole: "qualified-reviewer",
      reviewedAt: "2026-01-01T00:00:00.000Z"
    }),
    writeJson(join(root, "config/release/publication-metadata.json"), {
      schemaVersion: "1.0",
      releaseVersion: "1.0.0",
      status: "approved",
      reviewId: "old-publication-review",
      reviewerRole: "qualified-publication-metadata-reviewer",
      reviewedAt: "2026-01-01T00:00:00.000Z",
      registryScopeAuthority: { scope: "@pixel-point" }
    }),
    writeFile(join(root, "README.md"), "npm install @pixel-point/aval-format@1.0.0\n")
  ]);
  return root;
}

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
