import { describe, expect, it, vi } from "vitest";

import {
  assertCandidateResourceBudget,
  assertPlayerResourceBudget,
  assertRuntimeResourceBudget,
  checkedResourceTotal,
  encodedCopyCeilingForUnits,
  playerResourceByteTotal,
  readinessResidentFrameCount,
  reportPlayerResourceBytes,
  renditionRenderLayout
} from "../src/player-resource-budget.js";
import type { ReadinessPlan } from "../src/readiness.js";
import { opaqueQualifiedManifest } from "./support/provisional-output-harness.js";

describe("player resource budget", () => {
  it("derives the canonical rendition layout", () => {
    const manifest = opaqueQualifiedManifest();
    const layout = renditionRenderLayout(manifest, manifest.renditions[0]!);

    expect(layout).toMatchObject({
      storageWidth: 2,
      storageHeight: 2,
      logicalWidth: 2,
      logicalHeight: 2
    });
  });

  it("reports exact totals and the null retirement report", () => {
    const onResourceBytes = vi.fn();
    const resources = {
      metadataBytes: 11,
      residentBlobBytes: 13,
      decoderBytes: 17,
      rendererRuntimeBytes: 19,
      maximumBytes: 60,
      enforceMaximum: false
    } as const;

    expect(playerResourceByteTotal(resources)).toBe(60);
    reportPlayerResourceBytes({ onResourceBytes }, resources);
    reportPlayerResourceBytes({ onResourceBytes }, null);
    expect(onResourceBytes.mock.calls).toEqual([[60], [0]]);
  });

  it("rejects invalid totals and enforced runtime overflow", () => {
    expect(() => checkedResourceTotal([-1])).toThrow(/resource budget/i);
    expect(() => checkedResourceTotal([
      Number.MAX_SAFE_INTEGER,
      1
    ])).toThrow(/resource budget/i);
    expect(() => reportPlayerResourceBytes({ onResourceBytes: vi.fn() }, {
      metadataBytes: 5,
      residentBlobBytes: 0,
      decoderBytes: 0,
      rendererRuntimeBytes: 0,
      maximumBytes: 4,
      enforceMaximum: true
    })).toThrowError(expect.objectContaining({ name: "ResourceBudgetError" }));
  });

  it("admits an exact player ceiling and rejects one byte over it", () => {
    const resources = Object.freeze({
      metadataBytes: 5,
      residentBlobBytes: 7,
      decoderBytes: 11,
      rendererRuntimeBytes: 13,
      maximumBytes: 36,
      enforceMaximum: false
    });

    expect(() => assertPlayerResourceBudget(resources)).not.toThrow();
    expect(() => assertPlayerResourceBudget(Object.freeze({
      ...resources,
      maximumBytes: 35
    }))).toThrowError(expect.objectContaining({ name: "ResourceBudgetError" }));
  });

  it("budgets queued, active, and retiring encoded copies", () => {
    expect(encodedCopyCeilingForUnits([10])).toBe(30);
    expect(encodedCopyCeilingForUnits([10, 8, 6, 4, 2])).toBe(48);
    expect(encodedCopyCeilingForUnits([])).toBe(0);
  });

  it("admits candidate and runtime budgets at the exact declared ceiling", () => {
    const base = opaqueQualifiedManifest();
    const manifest = Object.freeze({
      ...base,
      limits: Object.freeze({ ...base.limits, maxRuntimeBytes: 300_000 })
    });
    const rendition = manifest.renditions[0]!;
    const unitBlobs = [Object.freeze({
      rendition: rendition.id,
      unit: "bootstrap",
      chunkStart: 0,
      chunkCount: 1,
      frameCount: 3,
      sha256: "0".repeat(64),
      offset: 0,
      length: 10
    })];
    const common = {
      manifest,
      rendition,
      unitBlobs,
      metadataBytes: 10,
      residentBlobBytes: 10,
      rendererRuntimeBytes: 20
    } as const;

    expect(() => assertCandidateResourceBudget({
      ...common,
      assetMode: "range",
      readinessEncodedBytes: 10
    })).not.toThrow();
    expect(() => assertRuntimeResourceBudget({
      ...common,
      decoderOpenFrameBytes: 0
    })).not.toThrow();
    expect(() => assertRuntimeResourceBudget({
      ...common,
      rendererRuntimeBytes: 300_000,
      decoderOpenFrameBytes: 0
    })).toThrowError(expect.objectContaining({ name: "ResourceBudgetError" }));
  });

  it("counts unique resident frames before renderer admission", () => {
    const readiness = {
      units: [],
      loops: [],
      reversibleUnits: [],
      resident: [
        { unit: "a", frames: [0, 1, 1] },
        { unit: "b", frames: [2] }
      ],
      endpoints: [],
      routes: [],
      decodedFrameBytes: 0,
      encodedBytes: 0,
      semanticPersistentBytes: 0,
      uniquePersistentBytes: 0,
      declaredWorkingSetBytes: 0
    } satisfies Readonly<ReadinessPlan>;

    expect(readinessResidentFrameCount(readiness)).toBe(3);
  });
});
