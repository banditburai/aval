import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = "scripts/release/publish-packages.sh";

describe("operator npm publication shell", () => {
  it("exposes only explicit bump, prepare, and publish mutations", async () => {
    const source = await readFile(script, "utf8");
    expect(source).toContain("set -eu");
    expect(source).toContain("release-version.mjs bump");
    expect(source).toContain("build-packages.mjs");
    expect(source).toContain("test-consumers.mjs");
    expect(source).toContain("publish-public-packages.mjs");
    expect(source).toContain("--execute");
    expect(source.indexOf("test-consumers.mjs")).toBeLessThan(source.indexOf("publish-public-packages.mjs"));
  });

  it("prints usage without reaching release or registry commands", () => {
    const help = spawnSync("sh", [script, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("bump <major|minor|patch|x.y.z>");
    expect(help.stdout).toContain("prepare");
    expect(help.stdout).toContain("publish");

    const invalid = spawnSync("sh", [script, "unknown"], { encoding: "utf8" });
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("Usage:");
  });
});
