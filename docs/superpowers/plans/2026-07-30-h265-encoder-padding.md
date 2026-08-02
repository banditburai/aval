# H.265 Encoder Padding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept valid x265 coding-block padding and SPS conformance cropping while preserving exact authored H.265 decoded storage and publishing the encoder-reported coded surface.

**Architecture:** Keep the pre-encode YUV spool at the codec-neutral 2x2-aligned storage dimensions. After encoding, parse the first canonical H.265 SPS, require any right or bottom padding to be less than its declared coding-tree-block size, reconcile the coded extent against the exact crop-visible storage rectangle, and then run the existing strict whole-rendition inspector with that geometry. Normalize format-parser failures at the compiler boundary; runtime and manifest contracts stay unchanged because they already separate coded dimensions from decoded storage.

**Tech Stack:** TypeScript, Vitest, FFmpeg/libx265, AVAL format H.265 parser and inspector, Vite/React example, Playwright browser verification.

---

### Task 1: Add failing geometry reconciliation tests

**Files:**
- Create: `packages/compiler/test/h265-encoded-geometry.test.ts`
- Create later: `packages/compiler/src/compile/h265-encoded-geometry.ts`

- [ ] **Step 1: Write the acceptance test for encoder-owned padding**

Create `packages/compiler/test/h265-encoded-geometry.test.ts` with a native
packed-alpha base geometry and the observed SPS surface:

```ts
import { deriveVideoRenditionGeometry } from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

// Import reconcileH265EncodedGeometry from the compiler-private module using
// the same local test convention as neighboring compiler tests. Do not add it
// to the public package exports.

const base = deriveVideoRenditionGeometry({
  canvasWidth: 3_840,
  canvasHeight: 670,
  layout: "packed-alpha",
  visibleWidth: 3_840,
  visibleHeight: 670,
  storage: { widthAlignment: 2, heightAlignment: 2 }
});

describe("H.265 encoded geometry", () => {
  it("promotes x265 padding while preserving decoded packed storage", () => {
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
});
```

- [ ] **Step 2: Add the complete acceptance matrix**

Before the observed-surface test, add a table that proves no padding,
right-only padding, padding on both axes, and opaque geometry are accepted.
Every case must carry the SPS-declared `log2CtbSize`; the assertions also prove
the reconciler does not mutate the original geometry:

```ts
it.each([
  {
    name: "no padding",
    geometry: base,
    surface: {
      codedWidth: 3_840,
      codedHeight: 1_348,
      log2CtbSize: 6,
      crop: {
        left: 0, right: 0, top: 0, bottom: 0,
        visibleWidth: 3_840, visibleHeight: 1_348
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
        left: 0, right: 4, top: 0, bottom: 0,
        visibleWidth: 3_840, visibleHeight: 1_348
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
        left: 0, right: 4, top: 0, bottom: 4,
        visibleWidth: 3_840, visibleHeight: 1_348
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
        left: 0, right: 0, top: 0, bottom: 2,
        visibleWidth: 64, visibleHeight: 30
      }
    }
  }
])("accepts $name and preserves decoded geometry", ({ geometry, surface }) => {
  const originalGeometry = structuredClone(geometry);
  const result = reconcileH265EncodedGeometry(geometry, surface);

  expect(geometry).toEqual(originalGeometry);
  expect(result).not.toBe(geometry);
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
```

- [ ] **Step 3: Add rejection cases**

In the same `describe`, add table-driven cases which change one SPS fact at a
time. Include `log2CtbSize: 6` on every ordinary surface and explicitly reject
padding equal to one full coding-tree block:

```ts
it.each([
  {
    name: "non-origin crop",
    surface: {
      codedWidth: 3_840,
      codedHeight: 1_352,
      log2CtbSize: 6,
      crop: {
        left: 2, right: 0, top: 0, bottom: 4,
        visibleWidth: 3_838, visibleHeight: 1_348
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
        left: 0, right: 0, top: 0, bottom: 2,
        visibleWidth: 3_840, visibleHeight: 1_350
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
        left: 0, right: 0, top: 0, bottom: 0,
        visibleWidth: 3_840, visibleHeight: 1_346
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
        left: 0, right: 0, top: 0, bottom: 4,
        visibleWidth: 3_839, visibleHeight: 1_348
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
        left: 0, right: 0, top: 0, bottom: 64,
        visibleWidth: 3_840, visibleHeight: 1_348
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
        left: 0, right: 0, top: 0, bottom: 4,
        visibleWidth: 3_840, visibleHeight: 1_348
      }
    }
  }
])("rejects $name", ({ surface }) => {
  expect(() => reconcileH265EncodedGeometry(base, surface))
    .toThrow(/H\\.265 encoded geometry/u);
});
```

- [ ] **Step 4: Run the focused test and verify red**

Run:

```sh
npx vitest run packages/compiler/test/h265-encoded-geometry.test.ts
```

Expected: FAIL because `h265-encoded-geometry.js` does not exist.

- [ ] **Step 5: Commit the red test**

```sh
git add packages/compiler/test/h265-encoded-geometry.test.ts
git commit -m "test: cover H.265 encoder padding geometry"
```

### Task 2: Implement the geometry reconciler

**Files:**
- Create: `packages/compiler/src/compile/h265-encoded-geometry.ts`
- Test: `packages/compiler/test/h265-encoded-geometry.test.ts`

- [ ] **Step 1: Add the narrow encoded-surface contract**

Create the module with compiler-internal structural types:

```ts
import type {
  H265CropSummary,
  VideoRenditionGeometry
} from "@pixel-point/aval-format";

import { CompilerError } from "../diagnostics.js";

export interface H265EncodedSurface {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly log2CtbSize: number;
  readonly crop: Readonly<H265CropSummary>;
}
```

- [ ] **Step 2: Implement exact crop/storage reconciliation**

Add:

```ts
export function reconcileH265EncodedGeometry(
  geometry: Readonly<VideoRenditionGeometry>,
  surface: Readonly<H265EncodedSurface>
): Readonly<VideoRenditionGeometry> {
  const codedWidth = codedDimension(surface.codedWidth, "width");
  const codedHeight = codedDimension(surface.codedHeight, "height");
  const codingTreeBlockSize = ctbSize(surface.log2CtbSize);
  const [storageX, storageY, storageWidth, storageHeight] =
    geometry.decodedStorageRect;
  const rightPadding = codedWidth - storageWidth;
  const bottomPadding = codedHeight - storageHeight;
  const crop = surface.crop;
  if (
    storageX !== 0 ||
    storageY !== 0 ||
    rightPadding < 0 ||
    bottomPadding < 0 ||
    rightPadding >= codingTreeBlockSize ||
    bottomPadding >= codingTreeBlockSize ||
    !cropFactsAreIntegers(crop) ||
    crop.left !== 0 ||
    crop.top !== 0 ||
    crop.visibleWidth !== storageWidth ||
    crop.visibleHeight !== storageHeight ||
    crop.right !== rightPadding ||
    crop.bottom !== bottomPadding
  ) {
    throw invalid("H.265 encoded geometry crop does not expose exact decoded storage");
  }
  return Object.freeze({
    ...geometry,
    codedWidth,
    codedHeight,
    codedRgbaBytes: checkedProduct(codedWidth, codedHeight, 4)
  });
}
```

Implement `codedDimension`, `cropFactsAreIntegers`, `checkedProduct`, and
`invalid` in the same file:

```ts
function codedDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 2 || value % 2 !== 0) {
    throw invalid(`H.265 encoded geometry ${name} must be a positive even integer`);
  }
  return value;
}

function ctbSize(log2CtbSize: number): number {
  if (
    !Number.isSafeInteger(log2CtbSize) ||
    log2CtbSize < 3 ||
    log2CtbSize > 6
  ) {
    throw invalid(
      "H.265 encoded geometry CTB size must be between 8 and 64 luma samples"
    );
  }
  return 2 ** log2CtbSize;
}

function cropFactsAreIntegers(
  crop: Readonly<H265CropSummary> | undefined
): crop is Readonly<H265CropSummary> {
  if (typeof crop !== "object" || crop === null) return false;
  return [
    crop.left,
    crop.right,
    crop.top,
    crop.bottom,
    crop.visibleWidth,
    crop.visibleHeight
  ].every((value, index) =>
    Number.isSafeInteger(value) &&
    value >= (index < 4 ? 0 : 1)
  );
}

function checkedProduct(...values: number[]): number {
  let result = 1;
  for (const value of values) {
    result *= value;
    if (!Number.isSafeInteger(result) || result < 1) {
      throw invalid("H.265 encoded geometry byte size exceeds safe arithmetic");
    }
  }
  return result;
}

function invalid(message: string): CompilerError {
  return new CompilerError("ASSET_INVALID", message, { phase: "encode" });
}
```

- [ ] **Step 3: Run the unit test and compiler typecheck**

Run:

```sh
npx vitest run packages/compiler/test/h265-encoded-geometry.test.ts
npm run typecheck -w @pixel-point/aval-compiler
```

Expected: PASS.

- [ ] **Step 4: Commit the reconciler**

```sh
git add packages/compiler/src/compile/h265-encoded-geometry.ts
git commit -m "fix: reconcile H.265 encoded geometry"
```

### Task 3: Add a real libx265 regression before wiring the fix

**Files:**
- Modify: `packages/compiler/test/video-rendition-pipeline.test.ts`

- [ ] **Step 1: Make packed storage non-aligned**

Change the real pipeline fixture from `HEIGHT = 28` to `HEIGHT = 30`. Its
codec-neutral packed storage becomes `64x68`:

```ts
const WIDTH = 64;
const HEIGHT = 30;
const PACKED_HEIGHT = HEIGHT * 2 + 8;
```

Update the expected alpha rectangle from `[0, 36, WIDTH, HEIGHT]` to:

```ts
visibleAlphaRect: [0, 38, WIDTH, HEIGHT],
decodedStorageRect: [0, 0, WIDTH, PACKED_HEIGHT]
```

- [ ] **Step 2: Exercise the requested H.265 preset**

Change the H.265 fixture policy to:

```ts
return Object.freeze({
  codec,
  preset: "veryslow",
  threads: 2,
  renditions
});
```

- [ ] **Step 3: Assert raw storage and emitted coded geometry separately**

Import the validator from the compiler's public package root:

```ts
import { validateAssetFile } from "@pixel-point/aval-compiler";
```

Inside the codec matrix test, after compilation:

```ts
if (codec === "h265") {
  expect(compiled.invocations[1]?.arguments).toEqual(expect.arrayContaining([
    "-video_size", `${String(WIDTH)}x${String(PACKED_HEIGHT)}`
  ]));
  expect(compiled.renditions[0]?.geometry.codedHeight)
    .toBeGreaterThan(PACKED_HEIGHT);
} else if (codec === "h264") {
  expect(compiled.renditions[0]?.geometry.codedHeight).toBe(80);
} else {
  expect(compiled.renditions[0]?.geometry.codedHeight).toBe(PACKED_HEIGHT);
}
```

After parsing the assembled front index, require its rendition to retain color
and alpha rectangles while publishing the prepared coded height:

```ts
expect(front.manifest.renditions[0]).toMatchObject({
  codedHeight: compiled.renditions[0]?.geometry.codedHeight,
  alphaLayout: {
    colorRect: [0, 0, WIDTH, HEIGHT],
    alphaRect: [0, 38, WIDTH, HEIGHT]
  }
});

const preparedGeometry = compiled.renditions[0]!.geometry;
expect(front.manifest.limits.decodedPixelBytes).toBe(
  preparedGeometry.codedWidth * preparedGeometry.codedHeight * 4
);

const assetPath = join(directory, `${codec}.avl`);
await writeFile(assetPath, artifact.assetBytes);
const validated = await validateAssetFile(assetPath);
expect(validated.frontIndex.manifest.codec).toBe(codec);
```

This public validation step is required: parsing the front index alone is only
structural and does not exercise the complete asset-validation contract.

- [ ] **Step 4: Add the opaque H.265 regression**

Add a libx265-gated test next to the existing opaque H.264 case. It must prove
that the opaque input remains `64x30`, x265 may publish a larger coded height,
no packed-alpha witness is created, the manifest uses the reconciled coded
surface, and the generated file passes public validation:

```ts
it.skipIf(!hasEncoder("libx265"))(
  "accepts H.265 coding-block padding for an opaque rendition",
  async () => {
    const project = projectFixture(encodingFixture("h265"), "opaque");
    const source = preparedSource();
    const encoding = project.encodings[0]!;
    const compiled = await compileVideoEncodingRenditions({
      project,
      encoding,
      layout: "opaque",
      sources: new Map([[source.id, source]]),
      executable: "ffmpeg",
      timeoutMs: 30_000
    });

    expect(compiled.invocations.map(({ operation }) => operation)).toEqual([
      "h265:video.main:idle.body:scale-rgba",
      "h265:video.main:idle.body:encode"
    ]);
    expect(compiled.invocations[1]?.arguments).toEqual(expect.arrayContaining([
      "-video_size", `${String(WIDTH)}x${String(HEIGHT)}`
    ]));
    const preparedGeometry = compiled.renditions[0]!.geometry;
    expect(preparedGeometry.decodedStorageRect).toEqual([0, 0, WIDTH, HEIGHT]);
    expect(preparedGeometry.codedHeight).toBeGreaterThan(HEIGHT);
    expect(compiled.renditions[0]?.outputQualification).toBeUndefined();

    const artifact = compileProjectEncoding({
      project,
      encoding,
      layout: "opaque",
      renditions: compiled.renditions
    });
    const front = parseFrontIndex(artifact.assetBytes);
    expect(front.manifest.renditions[0]).toMatchObject({
      codedWidth: preparedGeometry.codedWidth,
      codedHeight: preparedGeometry.codedHeight,
      alphaLayout: {
        type: "opaque",
        colorRect: [0, 0, WIDTH, HEIGHT]
      }
    });
    expect(front.manifest.renditions[0]?.outputQualification).toBeUndefined();
    expect(front.manifest.limits.decodedPixelBytes).toBe(
      preparedGeometry.codedWidth * preparedGeometry.codedHeight * 4
    );

    const assetPath = join(directory, "h265-opaque.avl");
    await writeFile(assetPath, artifact.assetBytes);
    await expect(validateAssetFile(assetPath)).resolves.toBeDefined();
  },
  40_000
);
```

- [ ] **Step 5: Run the real H.265 cases and verify red**

Run:

```sh
npx vitest run packages/compiler/test/video-rendition-pipeline.test.ts
```

Expected before wiring: the H.265 case fails with
`SPS coded dimensions do not match the rendition profile`; the opaque H.265
case fails for the same reason, while the other installed codec cases pass.

- [ ] **Step 6: Commit the red integration regressions**

```sh
git add packages/compiler/test/video-rendition-pipeline.test.ts
git commit -m "test: reproduce x265 conformance padding"
```

### Task 4: Reconcile the first canonical H.265 SPS during preparation

**Files:**
- Modify: `packages/compiler/src/compile/video-codec-compiler.ts`
- Test: `packages/compiler/test/video-rendition-pipeline.test.ts`
- Test: `packages/compiler/test/h265-encoded-geometry.test.ts`
- Create: `packages/compiler/test/h265-video-codec-compiler.test.ts`

- [ ] **Step 1: Import H.265 SPS parsing and reconciliation**

Extend the format imports:

```ts
import {
  H265_NAL_SPS,
  canonicalizeH265EncoderUnitStream,
  inspectH265AnnexBRendition,
  parseH265Sps,
  splitH265AnnexBAccessUnit
} from "@pixel-point/aval-format";
```

Import:

```ts
import { reconcileH265EncodedGeometry } from "./h265-encoded-geometry.js";
```

- [ ] **Step 2: Extract the first canonical SPS**

Add a private helper after `prepareH265Rendition`:

```ts
function firstH265Sps(
  units: readonly Readonly<{
    readonly id: string;
    readonly accessUnits: readonly Readonly<{
      readonly bytes: Uint8Array;
      readonly key: boolean;
    }>[];
  }>[]
) {
  const firstUnit = units[0];
  const firstAccessUnit = firstUnit?.accessUnits[0];
  if (firstUnit === undefined || firstAccessUnit === undefined) {
    throw new CompilerError("ASSET_INVALID", "H.265 encoder emitted no access unit", {
      phase: "encode"
    });
  }
  const sps = splitH265AnnexBAccessUnit(
    firstAccessUnit.bytes,
    `units.${firstUnit.id}.accessUnits[0]`
  ).find(({ type }) => type === H265_NAL_SPS);
  if (sps === undefined) {
    throw new CompilerError("ASSET_INVALID", "H.265 encoder emitted no SPS", {
      phase: "encode",
      unit: firstUnit.id
    });
  }
  return parseH265Sps(sps, `units.${firstUnit.id}.accessUnits[0].sps`);
}
```

- [ ] **Step 3: Promote only the prepared geometry**

In `prepareH265Rendition`, after canonicalization:

```ts
const geometry = reconcileH265EncodedGeometry(
  input.geometry,
  firstH265Sps(canonicalUnits)
);
const inspection = inspectH265AnnexBRendition({
  profile: inspectionProfile(geometry, input.frameRate),
  units: canonicalUnits
});
```

Return `geometry` instead of `input.geometry`. Keep encoding, raw spool
creation, and FFmpeg invocation on the original 2x2-aligned `input.geometry`.
The parsed SPS object is passed intact so its `log2CtbSize` bounds the accepted
right and bottom padding to less than one coding-tree block.

- [ ] **Step 4: Normalize H.265 parser failures at the compiler boundary**

Rename the existing `prepareH265Rendition` implementation to
`prepareValidatedH265Rendition` without changing its body. Add this wrapper
under the original name so canonicalization, access-unit splitting, SPS
parsing, and full inspection all share one format-error boundary:

```ts
function prepareH265Rendition(
  input: Readonly<CodecPrepareInput<H265Encoding, EncodedElementaryUnit>>
): Readonly<PreparedEncodingRendition> {
  try {
    return prepareValidatedH265Rendition(input);
  } catch (cause) {
    if (cause instanceof FormatError) {
      throw new CompilerError("ASSET_INVALID", cause.message, {
        cause,
        rendition: input.renditionId,
        phase: "encode"
      });
    }
    throw cause;
  }
}
```

Create `packages/compiler/test/h265-video-codec-compiler.test.ts`. Import the
compiler-private codec object and compiler error type with the same local test
convention as neighboring compiler tests; do not expose either through a new
public subpath. Then add the malformed-output regression:

```ts
import {
  deriveVideoRenditionGeometry,
  FormatError
} from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

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
      phase: "encode",
      cause: expect.any(FormatError)
    }));
  });
});
```

This test protects the public diagnostic from regressing to the generic
`IO_FAILED` fallback.

- [ ] **Step 5: Run focused compiler tests**

Run:

```sh
npx vitest run \
  packages/compiler/test/h265-encoded-geometry.test.ts \
  packages/compiler/test/h265-video-codec-compiler.test.ts \
  packages/compiler/test/video-rendition-pipeline.test.ts \
  packages/compiler/test/video-encode-unit.test.ts \
  packages/compiler/test/project-encoding-compiler.test.ts
npm run typecheck -w @pixel-point/aval-compiler
```

Expected: PASS. The real H.265 case must report raw `64x68`, decoded storage
`64x68`, and a larger SPS-coded height. The opaque case must report raw
`64x30`, retain decoded storage `64x30`, and publish a larger SPS-coded height.
Both generated temporary assets must pass `validateAssetFile`, and malformed
H.265 output must report `ASSET_INVALID` with rendition `video.main` and phase
`encode`.

- [ ] **Step 6: Commit the pipeline fix**

```sh
git add \
  packages/compiler/src/compile/video-codec-compiler.ts \
  packages/compiler/test/h265-video-codec-compiler.test.ts \
  packages/compiler/test/video-rendition-pipeline.test.ts
git commit -m "fix: accept x265 conformance padding"
```

### Task 5: Restore the lend/borrow example to native resolution

**Files:**
- Modify: `examples/lend-borrow-react/motion.json`
- Modify: `examples/lend-borrow-react/README.md`
- Modify: `docs/compiler/authoring-video-and-states.md`
- Modify: `docs/superpowers/specs/2026-07-30-lend-borrow-react-example-design.md`
- Modify: `docs/superpowers/plans/2026-07-30-lend-borrow-react-example.md`

- [ ] **Step 1: Change both renditions to the native canvas**

Use this target for VP9 and H.265:

```json
{
  "id": "video.1x",
  "width": 3840,
  "height": 670
}
```

Retain VP9 CRF 40 / deadline `best`, H.265 CRF 30 / preset `veryslow`, 8-bit
output, and eight threads.

- [ ] **Step 2: Replace workaround documentation with final geometry**

Document:

- logical and visible rendition `3840x670`;
- VP9 packed coded surface `3840x1348`;
- H.265 current-toolchain coded surface `3840x1352` with a four-row conformance
  crop to decoded storage `3840x1348`;
- encoder padding does not alter authored visible resolution.

Add one compiler authoring note that a codec may publish a coded surface larger
than decoded storage when its bitstream carries an exact conformance crop.

- [ ] **Step 3: Validate documents and project JSON**

Run:

```sh
npm run docs:check
node -e "JSON.parse(require('node:fs').readFileSync('examples/lend-borrow-react/motion.json','utf8'))"
git diff --check
```

Expected: PASS.

- [ ] **Step 4: Commit source and documentation updates**

```sh
git add \
  examples/lend-borrow-react/motion.json \
  examples/lend-borrow-react/README.md \
  docs/compiler/authoring-video-and-states.md \
  docs/superpowers/specs/2026-07-30-lend-borrow-react-example-design.md \
  docs/superpowers/plans/2026-07-30-lend-borrow-react-example.md
git commit -m "docs: restore native packed-alpha rendition"
```

### Task 6: Regenerate and verify native assets

**Files:**
- Modify: `examples/lend-borrow-react/public/lend-borrow/vp9.avl`
- Modify: `examples/lend-borrow-react/public/lend-borrow/h265.avl`
- Modify: `examples/lend-borrow-react/public/lend-borrow/build.json`

- [ ] **Step 1: Compile the example**

Run:

```sh
npm run compile:lend-borrow-react
```

Expected: two assets and one report are regenerated without an H.265 SPS
dimension error.

- [ ] **Step 2: Inspect report policies and dimensions**

Require:

- project renditions `3840x670`;
- VP9 encode input and coded surface `3840x1348`;
- H.265 encode input `3840x1348`;
- H.265 manifest/SPS coded surface `3840x1352` on the pinned local toolchain;
- no warnings;
- only VP9 and H.265 assets;
- VP9 `deadline: "best"`, CRF 40, 8-bit;
- H.265 `preset: "veryslow"`, CRF 30, 8-bit.

- [ ] **Step 3: Validate both assets**

Run:

```sh
npm run avl -- validate examples/lend-borrow-react/public/lend-borrow/vp9.avl --json
npm run avl -- validate examples/lend-borrow-react/public/lend-borrow/h265.avl --json
```

Expected: PASS with 72 displayed frames per asset and packed-alpha output
qualification.

- [ ] **Step 4: Run the browser playback regression**

Run:

```sh
npm run test:lend-borrow-react
```

Expected: PASS for idle frames 0-35, queued activation after the current idle
pass, active frames 0-35, completion return to idle, visible selected
background through transparent pixels, and zero underflows.

- [ ] **Step 5: Commit generated outputs**

```sh
git add examples/lend-borrow-react/public/lend-borrow
git commit -m "build: regenerate native lend-borrow assets"
```

### Task 7: Run repository-wide verification

**Files:**
- Verify all modified and generated files.

- [ ] **Step 1: Run compiler and public contract gates**

```sh
npm run typecheck
npm run api:check
npm run check:generated
```

Expected: PASS with no public API report change from the compiler-internal
reconciler.

- [ ] **Step 2: Run all unit tests**

```sh
npm run test:unit
```

Expected: every Vitest file passes, including the real x265 regression.

- [ ] **Step 3: Run full production builds and static consistency checks**

```sh
npm run build
npm run docs:check
node scripts/fixtures/verify-all.mjs
git diff --check
```

Expected: PASS. Certification fixtures should remain byte-identical because
their current H.265 packed storage is already aligned.

- [ ] **Step 4: Review the final diff**

Confirm:

- no player or manifest-schema code changed;
- H.264, VP9, and AV1 behavior is unchanged;
- H.265 raw input dimensions remain decoded-storage dimensions;
- H.265 prepared/manifest dimensions come from the strictly validated SPS;
- the example no longer contains the `3072x536` workaround;
- no unrelated worktree changes were staged or overwritten.
