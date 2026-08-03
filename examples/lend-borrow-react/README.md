# Lend/Borrow React example

This React example displays a native 3840×2160 logical canvas and visible
rendition at 24 fps using the source's authored alpha plane. AVAL stores color
and alpha in a 3840×4328 packed surface internally; encoder conformance padding
does not change the player-visible 3840×2160 geometry.

The example publishes only 8-bit VP9 (CRF 40) and H.265/HEVC (CRF 30). The
manifest does not override encoder quality policies, so compilation uses the
compiler defaults: VP9 `deadline=best` and H.265 `preset=veryslow`.

## Source

The 136-frame source is intentionally not committed. Place the requested video
at:

```text
examples/lend-borrow-react/source/lend-borrow-test-2.mov
```

It must be the 3840×2160, 24 fps ProRes 4444 export with a real alpha plane.
The example compiles it directly and never derives transparency with a color
key.

## Compile and run

From the repository root:

```sh
npm run compile:lend-borrow-react
npm run lend-borrow-react
```

Generated assets are written to
`examples/lend-borrow-react/public/lend-borrow/`.

## Graph and frame ranges

All source ranges are zero-based and half-open:

- Idle loop: `[0,36)`
- Active from displayed loop frame 12: `[64,100)`
- Active from displayed loop frame 24: `[100,136)`
- Active from displayed loop frame 36: `[36,64)`

Internally, the logical loop consists of three finite phases: `[0,12)`,
`[12,24)`, and `[24,36)`. They completion-cycle continuously and are presented
as one idle loop in the UI. Pressing Activate waits for the current phase's
safety frame, then chooses the corresponding active body:

| Activation window | Safety frame | Active source range | Loop return |
| --- | --- | --- | --- |
| Displayed frames 1–12 | zero-based 11 | `[64,100)` | zero-based frame 12 |
| Displayed frames 13–24 | zero-based 23 | `[100,136)` | zero-based frame 24 |
| Displayed frames 25–36 | zero-based 35 | `[36,64)` | zero-based frame 0 |

The button reads `Queued` during the boundary wait and `Active` during the
active body. Each active body returns directly to the next authored loop frame,
without replaying its departure safety frame. The button returns to `Activate`
in that next idle phase. The background picker changes the full-page color for
checking alpha.

The `[36,64)` source clip contains authored held-frame pairs and its return to
the loop is an authored visual jump. The compiler and player preserve those
frames exactly; they do not interpolate or repair the source.

## Verification

Run:

```sh
npm run test:lend-borrow-react
```

The browser regression uses fresh pages to test both early and exact-boundary
activation in all three phases. It verifies the selected branch, every active
frame, the direct next-idle return, absence of an extra loop, transparency over
purple, 8-bit VP9 selection, and playback/error counters. Chromium selects VP9
on this host; the compile workflow structurally validates H.265 separately.
