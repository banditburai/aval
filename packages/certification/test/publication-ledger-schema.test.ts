import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { RELEASE_PACKAGE_NAMES } from "../../../scripts/release/release-set-model.mjs";
import { PUBLIC_RELEASE_PACKAGES } from "../src/compatibility.js";

describe("public release package authorities", () => {
  it("use the exact canonical public release package set", async () => {
    const [schema, policy, apiClassification] = await Promise.all([
      readJson<PublicationLedgerSchema>("schemas/publication-ledger.schema.json"),
      readJson<ReleasePolicy>("config/release/release-policy.json"),
      readJson<ApiClassification>("config/release/api-classification.json")
    ]);

    expect(PUBLIC_RELEASE_PACKAGES).toEqual(RELEASE_PACKAGE_NAMES);
    expect(policy.publicPackages).toEqual(RELEASE_PACKAGE_NAMES);
    expect(schema.properties.operations.items.properties.packageName.enum)
      .toEqual(RELEASE_PACKAGE_NAMES);
    expect(Object.keys(apiClassification.packages).sort())
      .toEqual([...RELEASE_PACKAGE_NAMES].sort());
  });
});

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

interface ReleasePolicy {
  readonly publicPackages: readonly string[];
}

interface ApiClassification {
  readonly packages: Readonly<Record<string, unknown>>;
}

interface PublicationLedgerSchema {
  readonly properties: Readonly<{
    readonly operations: Readonly<{
      readonly items: Readonly<{
        readonly properties: Readonly<{
          readonly packageName: Readonly<{
            readonly enum: readonly string[];
          }>;
        }>;
      }>;
    }>;
  }>;
}
