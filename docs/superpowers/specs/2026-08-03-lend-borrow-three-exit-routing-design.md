# Lend/Borrow Three-Exit Routing Design

**Date:** 2026-08-03

## Goal

Update the React lend/borrow example to compile
`lend-borrow-test-2.mov` at its native visible resolution and route one
Activate interaction through one of three authored active clips according to
the current twelve-frame phase of the idle loop. Playback must use the current
canonical AVAL element runtime and must not miss a safety boundary and wait an
extra loop.

## Source facts and frame convention

The replacement source is a 136-frame, 24 fps, 3840×2160 ProRes 4444 MOV. All
frames expose an authored `yuva444p12le` alpha plane. Source and unit ranges are
zero-based and half-open:

| Purpose | Range | Displayed source frames |
| --- | --- | --- |
| Idle loop | `[0, 36)` | `0…35` |
| Active from displayed loop frame 36 | `[36, 64)` | `36…63` |
| Active from displayed loop frame 12 | `[64, 100)` | `64…99` |
| Active from displayed loop frame 24 | `[100, 136)` | `100…135` |

The user's safety labels are one-based display labels. They map to zero-based
idle frames 11, 23, and 35. Activation windows are therefore `0…11`, `12…23`,
and `24…35`, without overlap.

The source has a clean `35 → 0` idle seam. The `[64, 100)` clip returns
smoothly through idle frame 11, and `[100, 136)` returns smoothly through idle
frame 23. The `[36, 64)` clip has an authored discontinuity at its return and
contains repeated held frames. The user explicitly approved preserving those
pixels and returning through idle frame 35 before the loop restarts at frame
0. The compiler and player must not synthesize, remove, interpolate, or retime
these frames.

## Architecture constraint

Current AVAL graph edges select one fixed source port, optional transition
unit, and target state. Multiple portal frames on one port are alternative
departure boundaries for that same route; they cannot select different target
units. Target ports also enter their body at local frame zero. Extending the
source schema, compiled format, graph indexes, readiness planning, and runtime
to add portal-conditioned targets is outside this example's scope.

The prior single-loop example also exposes a late-request regression after the
canonical runtime refactor: when a route is requested while the only loop
portal is already displayed and its target is not ready, the loop advances and
cannot depart until the next lap. Underflow counters remain zero, so the old
test does not detect the additional loop.

## Graph design

Represent the logical idle loop as three finite graph phases. Transitionless
completion edges cycle those phases forever:

```text
idle.12 [0,12) → idle.24 [12,24) → idle.36 [24,36) → idle.12
```

The React UI presents all three as one logical idle state. An Activate press
maps the currently committed phase to one explicit active destination:

| Current phase | Finish boundary | Active state and source range |
| --- | --- | --- |
| `idle.12` | source frame 11 | `active.12`, `[64,100)` |
| `idle.24` | source frame 23 | `active.24`, `[100,136)` |
| `idle.36` | source frame 35 | `active.36`, `[36,64)` |

Each activation route uses `start.type: "finish"`. A request made anywhere in
the phase waits for that phase's final safety frame. If decoding is not ready
at the boundary, finite-body runtime policy retains that boundary rather than
wrapping through another logical loop phase and selecting a later exit.

Each active body is finite and completes through a one-frame resume body that
restores the authored loop pose before normal idle playback continues:

```text
active.12 → resume.12 [11,12) → idle.24
active.24 → resume.24 [23,24) → idle.36
active.36 → resume.36 [35,36) → idle.12
```

The one-frame resume states are internal graph states, not synthetic video.
They reuse exact source pixels and make every target entry a valid local frame
zero under the existing graph contract. The approved `active.36 → resume.36`
source discontinuity is retained.

## React behavior

The page remains visually empty except for the animation, Activate button, and
background color picker. It uses the canonical `useAval` adapter returned by
`@pixel-point/aval-react`.

The UI groups states as follows:

- `idle.*` states are logical idle states.
- `active.*`, `resume.*`, a pending active request, or an active transition is
  logical active/busy behavior. The one-frame resume checkpoint is not an
  interactive state.
- Activate reads the controller's current committed state and requests the
  corresponding `active.*` destination synchronously in the click handler.
- The button displays `Queued` while waiting for a safety boundary, `Active`
  during the active and resume bodies, and returns to `Activate` upon the next
  idle phase.
- The button is disabled while the accepted activation is pending or active.

No raw wall-clock time or `<video>` current time participates in routing.

## Encoding

Compile the new MOV directly; do not derive alpha or preprocess its pixels.
The logical canvas and every visible rendition remain exactly 3840×2160.
Packed-alpha storage may be taller internally, and an encoder may add coded
conformance padding, but player-visible geometry must remain native.

Publish only:

- 8-bit VP9, CRF 40, compiler-default `deadline=best`;
- 8-bit H.265, CRF 30, compiler-default `preset=veryslow`.

Audio is omitted. The build report must record the normalized defaults and the
literal FFmpeg invocations.

## Verification

The browser regression runs isolated, fresh-page activation scenarios so one
scenario cannot warm another route accidentally. It covers at least one early
request and the exact safety boundary for all three phases.

For every case it verifies:

1. the request remains in the current phase through its safety frame;
2. no later idle phase or complete extra loop appears before active frame zero;
3. the selected active unit is exactly `active.12`, `active.24`, or
   `active.36` for that window;
4. every active local frame is presented in order without `Set` deduplication;
5. the corresponding resume frame appears, followed by the correct next idle
   phase and its next frame;
6. the decoded animation remains transparent over a non-black background;
7. no console error, page error, fatal playback failure, or underflow delta is
   introduced;
8. the browser-selected rendition is 8-bit VP9;
9. the button returns to its enabled Activate state.

Pixel comparisons cover each departure seam and return seam. The test treats
the known `active.36` return discontinuity as an expected source witness: it
must reproduce the source jump rather than claim it is smooth. Structural
validation and inspection cover both VP9 and H.265 assets; Chromium playback
covers VP9 because that is the codec Chromium selects on this host.

Compilation verification also checks all unit frame counts, native visible
geometry, alpha layout, CRFs, default encoder policies, output hashes, and that
only VP9 and H.265 assets are published.

## Out of scope

- A new portal-conditioned routing field in AVAL's public graph format.
- Changing global loop-portal readiness semantics for other projects.
- Repairing the source-level `active.36` return jump or its held frames.
- Adding codecs, bit depths, controls, labels, or demo content not requested
  for transparency and activation testing.
