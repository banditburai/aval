# H.265 Encoder Padding Design

## Status

Approved for implementation on 2026-07-30.

## Goal

Allow H.265 renditions whose codec-neutral YUV input dimensions are valid
4:2:0 dimensions but require additional x265 coding-block padding. Preserve
the exact decoded storage rectangle, accept only the matching SPS conformance
crop, and publish the encoder-reported coded surface in the AVAL manifest.

The motivating native packed-alpha rendition has these extents:

- logical color: `3840x670`;
- codec-neutral packed storage: `3840x1348`;
- x265 `veryslow` SPS-coded surface: `3840x1352`;
- SPS conformance crop: four rows from the bottom;
- decoded storage exposed to the player: `3840x1348`.

The implementation must derive the coded surface from the emitted bitstream.
It must not hardcode `1352` or a preset-to-alignment table.

## Root Cause

The shared geometry model already distinguishes `decodedStorageRect` from
`codedWidth` and `codedHeight`, and the manifest and players already support a
decoded storage rectangle that is smaller than the coded surface.

The compiler loses that distinction before H.265 encoding:

1. It derives H.265 geometry with only 2x2 YUV420 alignment.
2. It writes a raw YUV spool whose dimensions equal that pre-encode geometry.
3. x265 accepts the raw dimensions and may pad them to its active minimum
   coding-unit grid, signaling the original dimensions with an SPS conformance
   crop.
4. H.265 preparation compares the SPS coded dimensions with the pre-encode
   dimensions and rejects the otherwise valid stream.

For `3840x1348` input and the requested `veryslow` preset, the current local
x265 emits coded `3840x1352` with a four-row bottom crop. Other presets may use
different coding-unit grids; for example, `ultrafast` may emit a taller coded
surface. The invariant is therefore the crop-visible storage, not one padding
number.

## Considered Approaches

### 1. Reconcile geometry from the emitted SPS

Keep the raw encoder input at the codec-neutral decoded-storage extent. After
canonicalizing the first H.265 access unit, parse its SPS, require its
conformance crop to expose exactly the intended storage rectangle at the coded
origin, and promote the prepared rendition to the SPS coded dimensions. Run
the existing full H.265 inspection against that reconciled geometry.

This is the selected approach. It follows the bitstream as the authority,
works across supported presets and encoder versions, and leaves strict
validation in place.

### 2. Maintain a preset-to-alignment table

Predict the x265 minimum coding-unit grid from the selected preset and derive
the final coded surface before encoding.

This is rejected because x265 preset internals are not an AVAL contract and may
change by encoder version. It would also still require a distinct raw input
extent so x265 can signal the conformance crop.

### 3. Force one x265 coding-block policy

Override preset internals with a fixed coding-unit size and calculate padding
from that forced value.

This is rejected because it changes the meaning and performance of user-chosen
presets, couples AVAL to an encoder-specific tuning option, and still requires
crop validation.

## Architecture

### Pre-encode geometry

`deriveVideoRenditionGeometry` continues to produce the codec-neutral H.265
input geometry with 2x2 alignment. For packed alpha, its
`decodedStorageRect` contains the color pane, eight-row gutter, and alpha pane.
The YUV spool uses these exact dimensions. No neutral padding is added merely
to predict x265's internal coded surface.

### SPS reconciliation

Add one compiler-internal H.265 geometry reconciler with a narrow contract:

- input: pre-encode `VideoRenditionGeometry` and parsed SPS coded/crop facts;
- require positive, even coded dimensions;
- require coded dimensions to contain the decoded storage rectangle;
- require crop origin `(0, 0)`;
- require crop-visible width and height to equal the decoded storage width and
  height exactly;
- require right and bottom crop deltas to account for all extra coded columns
  and rows;
- return a frozen geometry with unchanged layout and visible rectangles,
  unchanged `decodedRgbaBytes`, encoder-reported coded dimensions, and
  recomputed `codedRgbaBytes`.

H.265 preparation extracts the first canonical SPS only to establish the
candidate coded geometry. The existing full rendition inspector remains
authoritative for parameter-set stability, codec profile, crop, timing, color,
reference closure, and every encoded unit.

### Manifest and runtime

The prepared H.265 rendition carries the reconciled geometry into asset
assembly and runtime-limit estimation. The manifest records the SPS-coded
surface while preserving the original color and alpha rectangles.

No player or manifest-schema changes are required. Existing runtimes configure
the decoder with coded dimensions and independently validate/copy the decoded
visible storage rectangle.

## Error Handling

Compilation must fail before asset publication when:

- the first canonical H.265 access unit has no SPS;
- SPS coded dimensions are odd, invalid, or smaller than decoded storage;
- conformance cropping begins away from the coded origin;
- the crop-visible dimensions differ from the intended decoded storage;
- the full existing H.265 inspection finds different parameter sets or crop
  facts in any unit.

Failures remain H.265 bitstream/profile failures. The compiler must never
silently crop authored color or alpha pixels and must never infer a smaller
logical rendition from encoder padding.

## Tests

Add focused unit coverage for the reconciler:

- accept coded dimensions larger than storage when the crop exposes storage
  exactly;
- keep color, alpha, decoded-storage, and decoded-byte facts unchanged;
- recompute coded bytes from the SPS dimensions;
- reject crop-visible mismatch, non-origin crop, undersized coded surfaces,
  and invalid dimensions.

Strengthen the real codec pipeline integration fixture so packed storage is
not aligned to x265's `veryslow` coding grid. It must prove:

- the raw H.265 input uses the exact packed storage extent;
- H.265 preparation succeeds with a larger emitted coded height;
- the prepared and serialized manifests retain the smaller decoded storage
  and exact color/alpha rectangles;
- VP9 retains its exact codec-neutral coded surface;
- asset validation and packed-alpha output qualification still pass.

Existing H.264 padding/crop, VP9, AV1, normalized manifest, decoder padding,
and runtime rendering tests must remain unchanged and pass.

## Example Update

After the compiler regression passes, change both lend/borrow renditions from
the explicit workaround `3072x536` to native `3840x670` and regenerate only
the VP9 and H.265 assets and report.

Expected native geometry:

- VP9: coded `3840x1348`;
- H.265 with the current `veryslow` toolchain: SPS-coded `3840x1352`, bottom
  crop four, decoded storage `3840x1348`;
- player-visible RGBA: `3840x670` for both.

The build report must continue to show CRF 40 / deadline `best` for VP9 and CRF
30 / preset `veryslow` for H.265. The pixel-level browser regression must pass
with transparency, idle/active frame sequencing, completion return, and zero
underflows.

## Non-goals

- changing packed-alpha's eight-row gutter;
- adding native-alpha codec profiles or a separate alpha stream;
- changing player rendering or decoder contracts;
- making omitted authored rendition dimensions default to the canvas;
- changing CRF, bit depth, preset, deadline, or thread defaults;
- treating one observed x265 padding value as a permanent compiler constant.
