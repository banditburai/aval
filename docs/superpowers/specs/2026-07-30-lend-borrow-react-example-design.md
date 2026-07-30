# Lend/Borrow React Example Design

## Goal

Add a focused React example under `examples/` that renders the supplied
Lend/Borrow motion through AVAL, demonstrates authored state playback, and
makes packed transparency easy to inspect against arbitrary page colors.

## Source media decision

The requested
`/Users/alex/Movies/polyester/lend-borrow-page/lend-borrow-test.mov` is ProRes
4444, 3840×670, 24 fps, and exactly 72 frames, but FFmpeg decodes it as
`yuv444p12le`. It contains no alpha plane; `alphaextract` fails because the
fourth plane is absent.

The sibling
`/Users/alex/Movies/polyester/lend-borrow-page/lend-borrow-transparent.mov`
has the same dimensions, frame rate, duration, and frame count, and decodes as
`yuva444p12le` with a real alpha plane. Use that source so the example can
fulfill the transparency requirement. Keep the large source MOV ignored by
Git while committing the reproducible AVAL project and compiled browser
assets.

## Architecture

Create `examples/lend-borrow-react` as a small Vite, React, and TypeScript
workspace. Its AVAL project compiles only VP9 and H.265 renditions. Both codec
families are fixed to 8-bit by AVAL; VP9 uses CRF 40 and H.265 uses CRF 30.
The project explicitly requests packed alpha.

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
- `active`: frames `[36, 72)`, a finite body.

The button requests `active` through `aval.setState("active")`. A cut edge
makes the control respond immediately. When the finite active body completes,
an explicit completion edge returns to `idle`, allowing the interaction to be
repeated.

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
- a browser smoke test for interactive readiness, the two codec sources,
  active-state completion, background color changes, and visible
  transparency.

The final handoff reports the effective per-codec FFmpeg encode commands from
the compiler-generated `build.json`. Those commands do not appear in the demo.
