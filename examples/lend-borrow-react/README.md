# Lend/Borrow React example

This React example displays a packed-alpha, native 3840×670 logical canvas and
visible rendition at 24 fps. VP9 codes the 3840×1348 packed surface directly.
With the current `veryslow` x265 toolchain, H.265 uses an SPS-coded 3840×1352
surface with a four-row bottom conformance crop that exposes the same
3840×1348 decoded storage. This encoder padding does not change the authored
3840×670 visible resolution. The example publishes only 8-bit VP9 (CRF 40) and
H.265/HEVC (CRF 30) AVAL assets. Because the manifest does not override encoder
quality policies, compilation uses the compiler defaults: VP9 `deadline=best`
and H.265 `preset=veryslow`.

The 69-frame source is intentionally not committed. Place the exact requested
video at `examples/lend-borrow-react/source/lend-borrow-test.mov` before
compiling. The file must contain an authored alpha plane; the example compiles
it directly and never derives transparency with a color key.

From the repository root, compile the animation with:

```sh
npm run compile:lend-borrow-react
```

Generated assets are written to
`examples/lend-borrow-react/public/lend-borrow/`. Run the example with:

```sh
npm run lend-borrow-react
```

The authored frame ranges are zero-based and half-open:

- `idle`: `[0, 36)`, looping
- `active`: `[36, 69)`, finite

The Activate button queues the active state, finishes the current idle pass
through frame 35, and then enters active at frame 36. The button reads
`Queued` during that boundary wait. Completion of the active range returns to
idle at frame 0, so the interaction can be repeated. The background color
picker changes the full-page color for visually checking transparency.

Run the pixel-level browser regression check with:

```sh
npm run test:lend-borrow-react
```

It verifies the full local-frame sequences, the idle loop seam, the visible
active displacement, the return to idle, 8-bit selection, and a transparent
corner over the selected purple background.
