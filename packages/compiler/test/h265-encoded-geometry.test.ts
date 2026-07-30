import { deriveVideoRenditionGeometry } from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import { reconcileH265EncodedGeometry } from
  "../src/compile/h265-encoded-geometry.js";
import type { CompilerError } from "../src/diagnostics.js";

const base = deriveVideoRenditionGeometry({
  canvasWidth: 3_840,
  canvasHeight: 670,
  layout: "packed-alpha",
  visibleWidth: 3_840,
  visibleHeight: 670,
  storage: { widthAlignment: 2, heightAlignment: 2 }
});

describe("H.265 encoded geometry", () => {
  it.each([
    {
      name: "no padding",
      geometry: base,
      surface: {
        codedWidth: 3_840,
        codedHeight: 1_348,
        log2CtbSize: 6,
        crop: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          visibleWidth: 3_840,
          visibleHeight: 1_348
        }
      }
    },
    {
      name: "right-only padding",
      geometry: base,
      surface: {
        codedWidth: 3_844,
        codedHeight: 1_348,
        log2CtbSize: 6,
        crop: {
          left: 0,
          right: 4,
          top: 0,
          bottom: 0,
          visibleWidth: 3_840,
          visibleHeight: 1_348
        }
      }
    },
    {
      name: "padding on both axes",
      geometry: base,
      surface: {
        codedWidth: 3_844,
        codedHeight: 1_352,
        log2CtbSize: 6,
        crop: {
          left: 0,
          right: 4,
          top: 0,
          bottom: 4,
          visibleWidth: 3_840,
          visibleHeight: 1_348
        }
      }
    },
    {
      name: "opaque geometry",
      geometry: deriveVideoRenditionGeometry({
        canvasWidth: 64,
        canvasHeight: 30,
        layout: "opaque",
        visibleWidth: 64,
        visibleHeight: 30,
        storage: { widthAlignment: 2, heightAlignment: 2 }
      }),
      surface: {
        codedWidth: 64,
        codedHeight: 32,
        log2CtbSize: 4,
        crop: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 2,
          visibleWidth: 64,
          visibleHeight: 30
        }
      }
    }
  ])("accepts $name and preserves decoded geometry", ({ geometry, surface }) => {
    const result = reconcileH265EncodedGeometry(geometry, surface);

    expect(result).toEqual({
      ...geometry,
      codedWidth: surface.codedWidth,
      codedHeight: surface.codedHeight,
      codedRgbaBytes: surface.codedWidth * surface.codedHeight * 4
    });
    expect(result.decodedStorageRect).toBe(geometry.decodedStorageRect);
    expect(result.visibleColorRect).toBe(geometry.visibleColorRect);
    expect(result.visibleAlphaRect).toBe(geometry.visibleAlphaRect);
    expect(result.decodedRgbaBytes).toBe(geometry.decodedRgbaBytes);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("promotes the observed x265 surface without changing packed storage", () => {
    const result = reconcileH265EncodedGeometry(base, {
      codedWidth: 3_840,
      codedHeight: 1_352,
      log2CtbSize: 6,
      crop: {
        left: 0,
        right: 0,
        top: 0,
        bottom: 4,
        visibleWidth: 3_840,
        visibleHeight: 1_348
      }
    });

    expect(result).toEqual({
      ...base,
      codedWidth: 3_840,
      codedHeight: 1_352,
      codedRgbaBytes: 20_766_720
    });
    expect(result.decodedStorageRect).toEqual([0, 0, 3_840, 1_348]);
    expect(result.visibleAlphaRect).toEqual([0, 678, 3_840, 670]);
    expect(result.decodedRgbaBytes).toBe(20_705_280);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    {
      name: "non-origin crop",
      surface: {
        codedWidth: 3_840,
        codedHeight: 1_352,
        log2CtbSize: 6,
        crop: {
          left: 2,
          right: 0,
          top: 0,
          bottom: 4,
          visibleWidth: 3_838,
          visibleHeight: 1_348
        }
      }
    },
    {
      name: "wrong visible storage",
      surface: {
        codedWidth: 3_840,
        codedHeight: 1_352,
        log2CtbSize: 6,
        crop: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 2,
          visibleWidth: 3_840,
          visibleHeight: 1_350
        }
      }
    },
    {
      name: "undersized coded surface",
      surface: {
        codedWidth: 3_840,
        codedHeight: 1_346,
        log2CtbSize: 6,
        crop: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          visibleWidth: 3_840,
          visibleHeight: 1_346
        }
      }
    },
    {
      name: "odd coded surface",
      surface: {
        codedWidth: 3_839,
        codedHeight: 1_352,
        log2CtbSize: 6,
        crop: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 4,
          visibleWidth: 3_839,
          visibleHeight: 1_348
        }
      }
    },
    {
      name: "padding of one full coding-tree block",
      surface: {
        codedWidth: 3_840,
        codedHeight: 1_412,
        log2CtbSize: 6,
        crop: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 64,
          visibleWidth: 3_840,
          visibleHeight: 1_348
        }
      }
    },
    {
      name: "invalid coding-tree block size",
      surface: {
        codedWidth: 3_840,
        codedHeight: 1_352,
        log2CtbSize: 7,
        crop: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 4,
          visibleWidth: 3_840,
          visibleHeight: 1_348
        }
      }
    }
  ])("rejects $name", ({ surface }) => {
    expect(() => reconcileH265EncodedGeometry(base, surface))
      .toThrow(/H\.265 encoded geometry/u);
  });

  it("attributes geometry failures to the prepared rendition", () => {
    expect(() => reconcileH265EncodedGeometry(base, {
      codedWidth: 3_840,
      codedHeight: 1_352,
      log2CtbSize: 6,
      crop: {
        left: 0,
        right: 0,
        top: 0,
        bottom: 2,
        visibleWidth: 3_840,
        visibleHeight: 1_350
      }
    }, "video.main")).toThrowError(
      expect.objectContaining<Partial<CompilerError>>({
        code: "ASSET_INVALID",
        rendition: "video.main",
        phase: "encode"
      })
    );
  });
});
