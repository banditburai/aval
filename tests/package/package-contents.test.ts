import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PUBLIC_RELEASE_PACKAGES, validateSynchronizedReleaseSet, type ReleasePackageManifest } from "../../packages/certification/src/compatibility.js";
import { releasePackageDirectory } from "../../scripts/release/release-set.mjs";

describe("publishable package manifests", () => {
  it("form one synchronized explicit 1.0 release set", async () => {
    const manifests = await Promise.all(PUBLIC_RELEASE_PACKAGES.map(async (name) => {
      const short = releasePackageDirectory(name);
      return JSON.parse(await readFile(`packages/${short}/package.json`, "utf8")) as ReleasePackageManifest;
    }));
    expect(validateSynchronizedReleaseSet(manifests)).toEqual([]);
  });

  it("carry canonical package-specific repository metadata", async () => {
    for (const name of PUBLIC_RELEASE_PACKAGES) {
      const directory = releasePackageDirectory(name);
      const manifest = JSON.parse(await readFile(`packages/${directory}/package.json`, "utf8"));
      expect(manifest.repository).toEqual({
        type: "git",
        url: "https://github.com/pixel-point/aval.git",
        directory: `packages/${directory}`
      });
      expect(manifest.homepage).toBe("https://github.com/pixel-point/aval");
      expect(manifest.bugs).toEqual({ url: "https://github.com/pixel-point/aval/issues" });
    }
  });
});
