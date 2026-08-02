import { describe, expect, it } from "vitest";

import { lowerDirectEncoding } from "../src/compile/direct-project.js";
import type { DirectArtifactOptions } from "../src/model.js";

const canvas = Object.freeze({ width: 1_920, height: 1_080 });
const directBase = {
  inputPath: "input.mov",
  loop: [0, 1] as const
};

function lower(options: DirectArtifactOptions) {
  return lowerDirectEncoding(options, canvas);
}

describe("direct encoding defaults", () => {
  it("uses the highest-quality practical H.265 and VP9 modes", () => {
    expect(lower({ ...directBase, codec: "h265" })).toMatchObject({
      codec: "h265",
      preset: "veryslow"
    });
    expect(lower({ ...directBase, codec: "vp9" })).toMatchObject({
      codec: "vp9",
      deadline: "best"
    });
  });

  it("preserves explicit H.265 and VP9 overrides", () => {
    expect(lower({
      ...directBase,
      codec: "h265",
      preset: "medium"
    })).toMatchObject({
      codec: "h265",
      preset: "medium"
    });
    expect(lower({
      ...directBase,
      codec: "vp9",
      deadline: "good"
    })).toMatchObject({
      codec: "vp9",
      deadline: "good"
    });
  });

  it("keeps the H.264 default unchanged", () => {
    expect(lower({ ...directBase, codec: "h264" })).toMatchObject({
      codec: "h264",
      preset: "medium"
    });
  });
});
