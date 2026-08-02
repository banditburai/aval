# Canonical browser runtime refactor — browser evidence

Date: 2026-08-02

Browser surface: Codex in-app browser (Chromium)

Branch: `polyester-test`

## Scope

This acceptance pass verifies the refactor that removes the parallel
`@pixel-point/aval-player-web` package, keeps `@pixel-point/aval-element` as the
canonical browser runtime, and makes the React and Svelte packages framework
adapters over that runtime.

Every runnable example directory was opened in the actual in-app browser.
Maintained asset-backed examples were exercised through their public controls.
The small documentation examples that intentionally omit assets were checked
for their documented application-owned fallback behavior.

## Maintained examples

| Surface | Browser observation | Console | Screenshot |
| --- | --- | --- | --- |
| End-user playground | One stable `<aval-player>` reached `Interactive · idle`; the Favorite control changed it to `Interactive · engaged`, with fallback hidden. | No warnings or errors | [end-user-playground.png](browser-runtime-refactor/end-user-playground.png) |
| Grass Rabbit | One rendered host moved from `idle` through `entering` to settled `hover` after focus. | No warnings or errors | [grass-rabbit.png](browser-runtime-refactor/grass-rabbit.png) |
| Grass Rabbit codecs | Browser reported 4/4 codecs supported; switching from the automatic AV1 view to H.264 kept one rendered host and settled in `hover`. | No warnings or errors | [grass-rabbit-codecs.png](browser-runtime-refactor/grass-rabbit-codecs.png) |
| Kinetic Orb | One rendered host moved from `idle` to `hover`; the page reported AV1 at 24 FPS. | No warnings or errors | [kinetic-orb.png](browser-runtime-refactor/kinetic-orb.png) |
| React Grass Rabbit | Exactly one core `<aval-player>` remained mounted while the React view changed from `Interactive / Idle / At rest` to `Interactive / Hover / At rest`. | No warnings or errors | [grass-rabbit-react.png](browser-runtime-refactor/grass-rabbit-react.png) |
| Svelte Grass Rabbit | Exactly one core `<aval-player>` remained mounted while the Svelte view changed from `Interactive / Idle / At rest` to `Interactive / Hover / At rest`. | No warnings or errors | [grass-rabbit-svelte.png](browser-runtime-refactor/grass-rabbit-svelte.png) |
| React lend/borrow | Background input accepted a new color. Activation visibly progressed `Queued` → `Active` → `Activate`, and the status returned to `Animation ready`, with one host throughout. | No warnings or errors | [lend-borrow-react.png](browser-runtime-refactor/lend-borrow-react.png) |
| Browser playground | Automatic ladder reached `interactiveReady` on AV1. Selecting H.264 changed the public status to single-codec mode and remained `interactiveReady`. | No warnings or errors | [playground.png](browser-runtime-refactor/playground.png) |

## Certification harness

The visible **Run public harness** control produced a passed bounded report
(`d79ed355968313a2c7d0809732be44a53e7e194032076402e4bd282df7d9c006`).
It covered public element routing, 32/32 rapid inputs, visibility transitions,
three-player soak behavior, two lifecycle cycles, and zero terminal byte,
decoder, and player counters. Runtime trace coverage reported zero underflows,
trace gaps, or wrong content identities.

The visible **Run resource/fault profile** control also passed
(`cae82f2ee23db7c18076a10379b68a051e57c0ac869c8cf52a894c4e2d02d85e`).
Its fatal-boundary network scenario observed the expected terminal error while
all outstanding transport, player, decoder, renderer, and byte counters
settled to zero. The browser console had no warnings or errors.

[Certification screenshot](browser-runtime-refactor/certification.png)

## Intentional fallback examples

These examples deliberately point at assets that are not checked into their
example folders. Success means the shared runtime reports failure through its
public boundary and the application reveals its own fallback without an
unhandled page error.

| Example | Browser observation | Console | Screenshot |
| --- | --- | --- | --- |
| Zero-config loop | The application-owned “Orbiting status illustration” fallback was unhidden. | No warnings or errors | [zero-config-loop.png](browser-runtime-refactor/zero-config-loop.png) |
| Idle/hover states | The Favorite control remained present and disabled with its `☆` fallback presentation. | No warnings or errors | [idle-hover-states.png](browser-runtime-refactor/idle-hover-states.png) |
| Network integrity | The fallback image and “Animation unavailable; the application revealed its image.” status were visible. | No warnings or errors | [network-integrity.png](browser-runtime-refactor/network-integrity.png) |
| Plain HTML | The fallback image was unhidden and the public Pause control remained operable. | No warnings or errors | [plain-html.png](browser-runtime-refactor/plain-html.png) |
| React ref | One stable host remained mounted; React controls changed the requested presentation from `idle` to `loading` and `done` while the alternate-status fallback stayed visible. | No warnings or errors | [react-ref.png](browser-runtime-refactor/react-ref.png) |

## Automated verification paired with this pass

- Workspace unit suite: 236 files, 1,889 tests passed.
- Element suite: 67 files, 687 tests passed.
- Mutation suite: 27/27 passed.
- Workspace typecheck and build passed, including every React and Svelte example.
- API checks passed for six release packages and seven entry points.
- Exact-archive consumer proof passed for all six packages and six consumers.
- Automated browser suites passed for core, React, Svelte, production,
  reference, playground, Grass Rabbit, codec, Kinetic Orb, and lend/borrow
  surfaces; capability-dependent skips were reviewed.
- Architecture, generated-fixture, documentation, security, and workflow checks
  passed.

The repository license gate remains a policy-review gate for dependencies whose
SPDX identifiers are marked `reviewRequired`; this refactor does not alter that
legal policy.
