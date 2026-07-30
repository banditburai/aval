# Lend/Borrow React Example Design

## Goal

Add a focused React example under `examples/` that renders the supplied
Lend/Borrow motion through AVAL, demonstrates authored state playback, and
makes packed transparency easy to inspect against arbitrary page colors.

## Source media decision

The requested
`/Users/alex/Movies/polyester/lend-borrow-page/lend-borrow-test.mov` is ProRes
4444, 3840×670, 24 fps, and exactly 69 frames. FFmpeg decodes all 69 frames as
`yuva444p12le`, and `alphaextract` succeeds. Compile that source directly and
preserve its authored alpha; the example must not derive transparency with a
color key or create an alpha-prepared intermediate.

Its `[0,36)` frames form the authored idle loop and `[36,69)` contains the
finite active state. Keep the large source MOV ignored by Git while committing
the AVAL project and compiled browser assets.

## Architecture

Create `examples/lend-borrow-react` as a small Vite, React, and TypeScript
workspace. Its AVAL project compiles only VP9 and H.265 renditions. Both codec
families are fixed to 8-bit by AVAL; VP9 uses CRF 40 and H.265 uses CRF 30.
The project omits codec speed fields so normalization applies the compiler
defaults: VP9 deadline `best` and H.265 preset `veryslow`.
The project explicitly requests packed alpha and keeps the logical canvas and
both visible renditions at the native 3840×670 resolution. VP9 codes the
3840×1348 packed surface directly. With the current `veryslow` x265 toolchain,
H.265 publishes an SPS-coded 3840×1352 surface with a four-row bottom
conformance crop that exposes decoded storage at 3840×1348. Encoder padding
does not alter the authored 3840×670 visible resolution.

The React component uses `@pixel-point/aval-react` with this partial source
map:

```ts
{
  vp9: "/lend-borrow/vp9.avl",
  h265: "/lend-borrow/h265.avl"
}
```

AVAL therefore tries VP9 first and H.265 second. The page does not implement
media seeking or frame loops itself.

## Authored motion graph

Frame ranges are zero-based and half-open:

- `idle`: frames `[0, 36)`, a looping body.
- `active`: frames `[36, 69)`, a finite body.

The button requests `active` through `aval.setState("active")`. A portal edge
queues the request until idle reaches authored frame 35, then enters active at
its local frame 0 (source frame 36). The control exposes this wait as
`Queued`. When the finite active body completes, a finish edge returns to idle
at local frame 0, allowing the interaction to be repeated without a cut.

## Interface

The page fills the viewport with an initial `#000000` background. The
3840×670 AVAL canvas is centered and scales down responsively without changing
its aspect ratio.

A compact floating control bar contains:

- an `Activate` button, disabled until AVAL can route to `active` and while the
  active run is in progress;
- a labeled native color input that updates the page background immediately.

There is no marketing content, codec readout, command display, or other demo
chrome. Fatal playback errors use a concise application-owned alert in the
control area. Focus indicators, labels, touch targets, and reduced-motion
behavior remain accessible.

## Build and validation

The example owns `motion.json`, the two compiled `.avl` files, and
`build.json`. The root workspace includes the example in its explicit
workspace and build lists.

Verification covers:

- AVAL compilation and validation for VP9 and H.265 only;
- manifest inspection proving packed alpha, 8-bit output, and the requested
  CRFs;
- TypeScript and Vite production builds;
- a pixel-level browser regression test proving idle frames `0…35`, a smooth
  `35→0` seam, active frames `0…32`, strong active displacement, completion
  back to idle, 8-bit playback, and visible transparency over purple.

The final handoff reports the effective per-codec FFmpeg encode commands from
the compiler-generated `build.json`. Those commands do not appear in the demo.
