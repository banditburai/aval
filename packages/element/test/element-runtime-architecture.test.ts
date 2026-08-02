import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = new URL("../src/", import.meta.url);

describe("element runtime architecture", () => {
  it("keeps DOM facade and runtime session within their reviewed size bounds", async () => {
    const facade = await source("aval-element.ts");
    const session = await source("element-runtime-session.ts");
    const diagnostics = await source("element-diagnostics.ts");
    const contract = await source("element-runtime-contract.ts");
    const host = await source("element-host-environment.ts");
    const deadlines = await source("preparation-deadline.ts");

    expect(lines(facade)).toBeLessThanOrEqual(800);
    expect(lines(session)).toBeLessThanOrEqual(1_000);
    expect(lines(diagnostics)).toBeLessThanOrEqual(600);
    expect(lines(contract)).toBeLessThanOrEqual(250);
    expect(lines(host)).toBeLessThanOrEqual(600);
    expect(lines(deadlines)).toBeLessThanOrEqual(600);
  });

  it("keeps player authority out of the DOM facade", async () => {
    const facade = await source("aval-element.ts");

    expect(facade).toContain("new ElementRuntimeSession");
    expect(facade).not.toContain("LifecycleLane");
    expect(facade).not.toContain("#player");
    expect(facade).not.toContain('from "./player.js"');
  });

  it("keeps the runtime behind one lazy module boundary", async () => {
    const session = await source("element-runtime-session.ts");

    expect(session).toContain('import("./player.js")');
    expect(session).not.toContain('from "./player.js"');
    expect(session.match(/import\("\.\/player\.js"\)/gu)).toHaveLength(1);
  });

  it("uses four neutral ports without concrete facade-owner dependencies", async () => {
    const session = await source("element-runtime-session.ts");
    const contract = await source("element-runtime-contract.ts");

    for (const port of ["read", "publish", "presentation", "pageResources"]) {
      expect(session).toContain(`readonly ${port}:`);
    }
    for (const concrete of [
      "ElementDiagnostics",
      "ElementHostEnvironment",
      "ElementInputBinding",
      "ElementPageResourceOwner",
      "ShadowLayerOwner"
    ]) {
      expect(session).not.toContain(concrete);
      expect(contract).not.toContain(concrete);
    }
  });
});

async function source(name: string): Promise<string> {
  return readFile(new URL(name, SOURCE_ROOT), "utf8");
}

function lines(value: string): number {
  return value.split("\n").length - Number(value.endsWith("\n"));
}
