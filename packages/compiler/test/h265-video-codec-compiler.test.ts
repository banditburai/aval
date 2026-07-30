import { deriveVideoRenditionGeometry } from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import { H265_VIDEO_CODEC_COMPILER } from
  "../src/compile/video-codec-compiler.js";
import type { CompilerError } from "../src/diagnostics.js";

describe("H.265 codec preparation diagnostics", () => {
  it("normalizes malformed encoder output at the compiler boundary", () => {
    const geometry = deriveVideoRenditionGeometry({
      canvasWidth: 64,
      canvasHeight: 30,
      layout: "opaque",
      visibleWidth: 64,
      visibleHeight: 30,
      storage: { widthAlignment: 2, heightAlignment: 2 }
    });

    expect(() => H265_VIDEO_CODEC_COMPILER.prepare({
      encoding: {
        codec: "h265",
        preset: "veryslow",
        threads: 2,
        renditions: [{ id: "video.main", width: 64, height: 30, crf: 30 }]
      },
      renditionId: "video.main",
      geometry,
      frameRate: { numerator: 24, denominator: 1 },
      units: [{
        id: "idle.body",
        expectedFrames: 1,
        rawBytes: new Uint8Array([0, 0, 1, 0])
      }]
    })).toThrowError(expect.objectContaining<Partial<CompilerError>>({
      code: "ASSET_INVALID",
      rendition: "video.main",
      phase: "encode"
    }));
  });
});
