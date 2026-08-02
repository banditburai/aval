# Canonical Browser Runtime Refactor Design

**Date:** 2026-08-02

**Status:** Approved for implementation planning

## Outcome

AVAL will expose one browser runtime: `@pixel-point/aval-element`. The React,
Svelte, and future browser-framework packages remain thin lifecycle and
presentation adapters over `@pixel-point/aval-element/adapter`. The unpublished
`@pixel-point/aval-player-web` package, its duplicate runtime, and all live
release and tooling dependencies on it are deleted without a compatibility
package or deprecated aliases.

The same program decomposes the two largest element-runtime coordinators by
state ownership. `player.ts` remains the intentional lazy runtime entry but no
longer owns the entire player. `aval-element.ts` remains the public custom
element facade but no longer owns environment observation, input binding,
resource admission, diagnostics, and player-generation state directly.

## Constraints

- The repository has not been publicly released, so the change is a clean
  break. No legacy exports, package tombstones, re-export shims, or compatibility
  branches are permitted.
- Public element, React, and Svelte behavior stays stable unless this design
  explicitly changes an unpublished type boundary.
- The element remains the sole owner of browser loading, decoding, scheduling,
  rendering, resource accounting, and custom-element behavior.
- Framework packages never import player, decoder, renderer, graph, or format
  implementation modules.
- Refactoring proceeds in independently testable phases. The repository must be
  green before the next phase starts.
- No newly created or materially rewritten production file may exceed 1,000
  lines. `player.ts` targets 100–160 lines and `aval-element.ts` targets
  500–750 lines.
- Historical dated specifications and evidence may continue to describe
  `player-web`; live code, package metadata, release policy, current docs, and
  runnable examples may not depend on it.

## Target Package Architecture

```text
@pixel-point/aval-graph ─┐
                         ├─> @pixel-point/aval-element
@pixel-point/aval-format ┘          ├─> root: <aval-player>
                                   └─> /adapter
                                         ├─> @pixel-point/aval-react
                                         ├─> @pixel-point/aval-svelte
                                         └─> future DOM frameworks

@pixel-point/aval-graph ─┐
@pixel-point/aval-format ├─> @pixel-point/aval-compiler
@pixel-point/aval-element┘
```

There is no public headless browser package in this release. If a concrete
non-custom-element consumer appears later, it receives a separate design based
on the proven current element runtime rather than preserving the orphaned
`player-web` implementation.

## Phase 1: Delete the Parallel Runtime

Delete `packages/player-web` and remove it from every live package graph,
release model, schema, API report, build command, compiler dev-module route,
consumer fixture, Vite alias, example manifest, and lockfile entry.

Only two current behaviors require replacement:

1. The codec comparison example retains its advisory support labels through a
   small example-local `VideoDecoder.isConfigSupported()` probe. Actual
   `<aval-player>` preparation remains the authoritative playback result.
2. The certification harness stops importing the stale player-web page policy.
   It uses element-owned decoder capacity and serializes element preparation
   according to the element resource owner. A dedicated test proves that a
   queued second element proceeds after the first retires, avoiding the current
   two-element `Promise.all` stall.

The compiler retains module serving for `element`, `format`, and `graph` only.
Its player-web worker entry and production dependency are deleted.

## Phase 2: Narrow the Framework Adapter

The adapter subpath exposes only framework infrastructure:

- `createAvalAdapterConfiguration()`;
- `createAvalAdapterBinding()`;
- option, callback, render, status, command, controller, and binding contracts;
- the codec-keyed `AvalSources` model.

`AvalAdapterCommands` becomes the canonical command contract. React and Svelte
compose their public controller types from shared option, status, and command
contracts instead of independently spelling the same methods. Render options
carry element-facing `autoplay` and `bindings` tokens, so wrappers do not repeat
the same boolean-to-token policy.

The adapter no longer re-exports the large diagnostic type closure from the
element implementation. Element-facing types continue to come from the element
root. JSX, Svelte markup, refs/actions, effect scheduling, SSR serialization,
ARIA handling, and optional-attribute application remain framework-owned.

## Phase 3: Decompose Player Ownership

`player.ts` stays as the lazy import boundary and owns only `createPlayer()` and
provisional-candidate orchestration. The implementation is divided by state
authority:

- `player-selection.ts`: source/rendition cursor, probing, candidate creation,
  fallback reports, and rejected-candidate retirement;
- `player-publication-gate.ts`: provisional callback buffering, activation,
  commit, and discard;
- `player-resource-budget.ts`: layout, checked byte arithmetic, reporting, and
  candidate/runtime admission;
- `player-failures.ts`: typed failure classification and bounded abort/timeout
  operations;
- `player-telemetry.ts`: trace, counters, and diagnostic retention;
- `player-media-runtime.ts`: sole ownership of assets, decoder pool, renderer,
  validation, resident frames, active streams, prefetch, drawing, settlement,
  and media retirement;
- `player-session.ts`: the public `Player` implementation, graph/effect order,
  clock and RAF scheduling, public commands, static recovery, context policy,
  terminal failure priority, and disposal.

The dependency direction is one-way:

```text
player.ts |-> player-selection.ts -> player-publication-gate.ts
          `-> player-session.ts
                |-> player-media-runtime.ts
                |-> player-telemetry.ts
                `-> focused policy modules
```

The factory injects a narrow candidate factory into selection, so selection
does not depend on the concrete session class. There is no generic
`PlayerContext`, exported mutable state bag, or collection of one-method
wrappers. Extracted classes must own a coherent state lifetime.

## Phase 4: Decompose Custom-Element Ownership

`aval-element.ts` retains custom-element callbacks, reflected public
properties, snapshot/event publication, composition, and terminal disposal.
The following owners absorb cohesive state:

- `element-sources.ts`: source parsing, uniqueness, codec order, and relevant
  mutation detection;
- expanded `element-event-mutation-gate.ts`: deferred attributes, commands,
  microtasks, event follow-ups, and pending-operation accounting;
- `element-host-environment.ts`: source/resize/intersection observers,
  document/window listeners, visibility, motion preference, adoption,
  intersection readiness, and geometry;
- `owned-releases.ts`: typed retryable release tracking instantiated
  independently by environment and input owners;
- `element-input-binding.ts`: interaction target, listener ownership,
  hover/focus state, authored bindings, and engagement;
- `element-page-resource-owner.ts`: participant, decoder ticket/lease, bytes,
  cancellation, and stale-grant rejection;
- `element-cleanup-proof.ts`: typed cleanup receipts, ownership snapshots, and
  retirement proof;
- `element-diagnostics.ts`: trace, counters, retained diagnostics, and public
  diagnostic assembly;
- `element-runtime-session.ts`: active/retiring player authority, generation
  lifecycle, reload/restart, visibility suspension, command delegation, and
  terminal retirement.

The runtime session consumes only explicit read, publication, presentation,
and page-resource capability ports. Environment and input owners deliver
events through facade-wired session methods; the session owns its lifecycle
lane and never receives a generic element context or concrete owner container.

## Error and Lifecycle Invariants

The refactor preserves these high-risk guarantees:

- runtime code remains lazily imported only after a mounted element needs it;
- native error listeners attach before custom-element upgrade;
- provisional callbacks preserve activation/commit/discard order while
  resource accounting and diagnostics retain their deliberate immediate path;
- candidate deadlines remain subordinate to the generation preparation
  deadline;
- graph preview equals the committed tick and effects retain their
  before-draw/after-draw order;
- expected aborts during retirement never become terminal playback errors;
- the canonical playback error wins over subsequent cleanup errors;
- cleanup, settlement, and disposal remain idempotent;
- stale generation callbacks, decoder grants, readiness results, and source
  publications cannot mutate the current generation;
- diagnostic object identity, retention limits, and trace caps remain stable;
- React Strict Mode and Svelte mount/unmount cleanup never terminally dispose a
  reusable element.

## Testing Strategy

Each extraction starts with a failing or characterization test at the narrowest
public or owner boundary. Focused tests run after every small edit. Element
typechecking and building run after every ownership transfer. Full unit, API,
package, and browser suites run at phase boundaries.

The final gate includes:

- workspace typecheck and unit tests;
- public-package builds and API extraction;
- packed and isolated consumers;
- release package creation and inspection;
- Chromium, Firefox, and WebKit browser tests;
- all maintained example builds and their dedicated Playwright suites;
- documentation, security, license, and generated-file checks;
- a real in-app-browser pass over every maintained runnable example and the
  playground, including visible rendering, representative interactions,
  reactive status, page errors, console errors, and screenshots.

Automated Playwright evidence does not replace the in-app-browser pass, and the
in-app-browser pass does not replace cross-engine automation.

## Thermo-Nuclear Review Cadence

Run the thermo-nuclear quality review:

1. after player-web deletion;
2. after adapter boundary cleanup;
3. after player selection/publication extraction;
4. after player media/session extraction;
5. after element environment/resource/input extraction;
6. after element runtime-session extraction; and
7. after the complete branch diff and all tests pass.

Every valid finding is fixed before the next phase. A review blocks progress if
it finds a file above 1,000 lines, a generic state bag, cyclic ownership,
pass-through abstractions, new scattered conditionals, duplicated canonical
policy, or a refactor that merely redistributes the same god object.

## Completion Criteria

- `packages/player-web` and all live references are gone.
- The element is the only browser runtime and framework packages depend only on
  its root/types and adapter subpath.
- `player.ts` is a focused lazy factory and `aval-element.ts` is a focused DOM
  facade.
- No new or materially rewritten production module exceeds 1,000 lines.
- Public element, React, and Svelte behavior and examples remain functional.
- All automated gates and the in-app-browser verification pass.
- The final thermo-nuclear review has no unresolved valid findings.
