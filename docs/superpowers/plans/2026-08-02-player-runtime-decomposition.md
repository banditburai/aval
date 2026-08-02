# Player Runtime Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3,000-line player implementation with cohesive candidate-selection, publication, policy, telemetry, media-resource, and session owners while preserving the lazy runtime boundary and every playback invariant.

**Architecture:** `player.ts` remains the lazily imported factory and provisional candidate orchestrator. `PlayerCandidateSelector` owns the fallback cursor and receives a narrow candidate factory, `PublicationGate` owns provisional visibility, `PlayerMediaRuntime` exclusively owns asset/decoder/renderer/frame lifetimes, `PlayerTelemetry` owns retained observations, and `PlayerSession` implements the public `Player` contract and owns graph/scheduling/commands. The factory composes selection and session; neither concrete owner depends on the other or back toward the facade.

**Tech Stack:** TypeScript 7, ESM private fields, WebCodecs, WebGL2/Canvas2D renderers, Vitest 4, Playwright 1.61.

---

## Required ownership boundaries

```text
player.ts
  |-> player-selection.ts
  |    -> player-publication-gate.ts
  `-> player-session.ts
       -> player-media-runtime.ts
       -> player-telemetry.ts
       -> player-resource-budget.ts
       -> player-failures.ts
       -> existing graph/readiness/route policy modules

player-selection.ts <- injected PlayerCandidateFactory
```

`PlayerMediaRuntime` is the only owner of `Asset`, `DecoderPool`, `Renderer`, resident frames, active streams, route-prefetch media, validation, and media retirement. `PlayerSession` may request operations through a narrow media interface but may not read or mutate those collections. `PlayerTelemetry` is a state owner with bounded retention, not a mutable record passed between modules.

### Task 1: Lock down factory and player-session behavior

**Files:**
- Modify: `packages/element/test/player.test.ts`
- Modify: `packages/element/test/player-selection.test.ts`
- Modify: `packages/element/test/player-startup-source-fallback.test.ts`
- Modify: `packages/element/test/player-decoder-run-qualification.test.ts`
- Modify: `packages/element/test/player-prefetch.test.ts`
- Modify: `packages/element/test/playback-error.test.ts`
- Modify: `packages/element/test/route-prefetch.test.ts`

- [ ] **Step 1: Add explicit lazy-factory and provisional-publication characterization**

Cover these observable sequences with the existing player harnesses:

```ts
expect(events).toEqual([
  "candidate-created",
  "candidate-activated",
  "candidate-committed",
  "snapshot-published"
]);
```

Also prove that a rejected provisional candidate publishes no buffered snapshot, error, or static callback, while resource-byte and diagnostic accounting remain immediate.

- [ ] **Step 2: Add high-risk scheduling and cleanup characterization**

Add or strengthen tests for:

```text
candidate deadline <= generation deadline;
previewed graph tick is the committed tick;
before-draw effects precede draw and after-draw effects follow draw;
retirement abort does not publish terminal failure;
canonical playback failure outranks cleanup failure;
dispose/settled/resource retirement are idempotent;
stale async work cannot publish after disposal.
```

- [ ] **Step 3: Run the focused baseline tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/player.test.ts packages/element/test/player-selection.test.ts packages/element/test/player-startup-source-fallback.test.ts packages/element/test/player-decoder-run-qualification.test.ts packages/element/test/player-prefetch.test.ts packages/element/test/playback-error.test.ts packages/element/test/route-prefetch.test.ts
```

Expected: PASS against the monolith, proving the characterization does not change behavior.

- [ ] **Step 4: Commit the invariant coverage**

```sh
git add packages/element/test/player.test.ts packages/element/test/player-selection.test.ts packages/element/test/player-startup-source-fallback.test.ts packages/element/test/player-decoder-run-qualification.test.ts packages/element/test/player-prefetch.test.ts packages/element/test/playback-error.test.ts packages/element/test/route-prefetch.test.ts
git commit -m "test(element): lock player lifecycle invariants"
```

### Task 2: Extract pure resource and failure policy

**Files:**
- Create: `packages/element/src/player-resource-budget.ts`
- Create: `packages/element/src/player-failures.ts`
- Create: `packages/element/test/player-resource-budget.test.ts`
- Create: `packages/element/test/player-failures.test.ts`
- Modify: `packages/element/src/route-prefetch.ts`
- Modify: `packages/element/test/route-prefetch.test.ts`
- Modify: `packages/element/src/player.ts`

- [ ] **Step 1: Write failing resource-policy tests**

Exercise exact layout byte totals, overflow rejection, encoded-copy ceilings, candidate admission, runtime admission, and the null-resource report used during retirement. The public shape is:

```ts
export function renditionRenderLayout(rendition: Readonly<Rendition>): Readonly<RenderLayout>;
export function reportPlayerResourceBytes(input: Readonly<PlayerInput>, resources: Readonly<PlayerResourceBytes> | null): void;
export function assertCandidateResourceBudget(input: Readonly<CandidateBudgetInput>): void;
export function assertRuntimeResourceBudget(input: Readonly<RuntimeBudgetInput>): void;
export function encodedCopyCeilingForUnits(unitCopyBytes: readonly number[]): number;
```

- [ ] **Step 2: Write failing failure-policy tests**

Test failure-code precedence for unsupported profile, resource admission, renderer operation, worker decode, selection exhaustion, abort, and timeout. Test `limit()` with success, abort-before-start, abort-during-operation, deadline timeout, and cleanup of listeners/timers.

- [ ] **Step 3: Move route wait policy to its existing policy module**

Move `routeWaitBlocksPresentation()` from `player.ts` to `route-prefetch.ts`; keep its exact arguments and truth table. Do not create another one-function module.

- [ ] **Step 4: Implement the policy modules by moving behavior without semantic edits**

Move checked arithmetic, layout/resource math, failure classification, abort construction, bounded-operation logic, and selection-exhaustion error construction. Keep current error names, messages, and failure codes so public diagnostics do not drift.

- [ ] **Step 5: Run policy and player regression tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/player-resource-budget.test.ts packages/element/test/player-failures.test.ts packages/element/test/route-prefetch.test.ts packages/element/test/player.test.ts packages/element/test/player-selection.test.ts
npm run typecheck -w @pixel-point/aval-element
```

Expected: PASS; `player.ts` contains none of the moved policy implementations.

- [ ] **Step 6: Commit pure policy extraction**

```sh
git add packages/element/src/player-resource-budget.ts packages/element/src/player-failures.ts packages/element/src/route-prefetch.ts packages/element/src/player.ts packages/element/test/player-resource-budget.test.ts packages/element/test/player-failures.test.ts packages/element/test/route-prefetch.test.ts
git commit -m "refactor(element): extract player policies"
```

### Task 3: Extract provisional publication and candidate selection

**Files:**
- Create: `packages/element/src/player-publication-gate.ts`
- Create: `packages/element/src/player-selection.ts`
- Create: `packages/element/test/player-publication-gate.test.ts`
- Modify: `packages/element/test/player-selection.test.ts`
- Modify: `packages/element/test/player-startup-source-fallback.test.ts`
- Modify: `packages/element/src/player.ts`

- [ ] **Step 1: Write direct PublicationGate tests**

Test the state machine using callback spies:

```ts
const gate = new PublicationGate(targetInput, provisionalPlaybackFailure);
gate.input.onMetadata(metadata);
gate.input.onReadiness("interactiveReady");
gate.activate();
gate.commit();
expect(order).toEqual(["metadata", "interactiveReady"]);
```

Cover the exact target-input/gated-input contract, provisional playback-failure
replacement on `commit()`, `discardAnimatedPresentation()` retaining metadata,
static readiness, events, and failures while removing animated readiness/draw,
full `discard()`, and immediate resource/decoder/renderer diagnostic callbacks.
Document and test the state table: repeated activate/commit/discard operations
and discard calls after activation are deliberate idempotent no-ops; malformed
construction is invalid, but cleanup repetition must never throw.

- [ ] **Step 2: Implement the publication owner**

Move the transformed `input`, callback buffering, activation, commit,
selective animated discard, and full discard state out of `player.ts`. The
owner stores only publication state and typed callback queues; it does not know
sources, assets, graph state, decoders, or renderers.

- [ ] **Step 3: Define and test PlayerCandidateSelector**

Use this lifecycle contract:

```ts
export interface ProvisionalPlayerCandidate {
  readonly player: PlayerCandidateHandle;
  readonly sourceIndex: number;
  readonly candidateRank: number;
  readonly publications: PublicationGate;
}

export interface PlayerCandidateHandle extends Player {
  adoptPreparationParent(parent: PreparationDeadline): void;
  provisionalFailure(): unknown;
  completeCandidateInstallation(): void;
  failCandidateInstallation(reason: unknown): void;
  contextChanged(change: Readonly<RendererContextChange>): void;
}

export type PlayerCandidateFactory = (
  input: Readonly<PlayerCandidateFactoryInput>
) => PlayerCandidateHandle;

export class PlayerCandidateSelector {
  next(publications: PublicationGate): Promise<ProvisionalPlayerCandidate>;
  reject(candidate: Readonly<ProvisionalPlayerCandidate>, rejection: unknown): void;
  retire(candidate: Readonly<ProvisionalPlayerCandidate>): Promise<Readonly<{ retryAllowed: boolean }>>;
}
```

Construct the selector with a `PlayerCandidateFactory`. During this task the
factory wraps the existing `PlayerImpl`; Task 6 replaces that implementation
with `PlayerSession` without changing selector behavior or its capability
contract. Tests cover codec/source priority, validation failure, renderer
rejection, resource rejection, preparation failure, retry exhaustion,
candidate report ordering, and retirement before fallback.

- [ ] **Step 4: Move selection state atomically**

Move `SelectionCursor`, `SelectionState`, asset probing/candidate construction,
candidate report production, rejection tracking, and fallback retirement into
`player-selection.ts`. Pass a named candidate-factory input; do not preserve
the monolith's positional argument list and do not import the not-yet-created
`PlayerSession` concrete class.

- [ ] **Step 5: Reduce player.ts to factory orchestration for this phase**

`createPlayer()` constructs a selector, requests candidates, activates/prepares them, commits exactly one, and rejects/retires failures. It must not access selector cursor fields or publication queues.

- [ ] **Step 6: Run selection, startup, and browser smoke tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/player-publication-gate.test.ts packages/element/test/player-selection.test.ts packages/element/test/player-startup-source-fallback.test.ts packages/element/test/player.test.ts
npm run typecheck -w @pixel-point/aval-element
npm run build -w @pixel-point/aval-element
npx playwright test --project=chromium
```

Expected: all tests pass; fallback produces one committed candidate and no provisional callback leakage.

- [ ] **Step 7: Run the scheduled thermo-nuclear review and commit**

Invoke `thermo-nuclear-code-quality-review` on the factory, selector, publication gate, and tests. Fix valid findings, rerun Step 6, then commit:

```sh
git add packages/element/src/player.ts packages/element/src/player-selection.ts packages/element/src/player-publication-gate.ts packages/element/test/player-publication-gate.test.ts packages/element/test/player-selection.test.ts packages/element/test/player-startup-source-fallback.test.ts
git commit -m "refactor(element): isolate player candidate selection"
```

### Task 4: Extract player telemetry as a bounded state owner

**Files:**
- Create: `packages/element/src/player-telemetry.ts`
- Create: `packages/element/test/player-telemetry.test.ts`
- Modify: `packages/element/test/diagnostics.test.ts`
- Modify: `packages/element/test/player-decoder-run-qualification.test.ts`
- Modify: `packages/element/src/player.ts`

- [ ] **Step 1: Write diagnostic identity and cap tests**

Prove stable snapshot identity when no observations change, new identity after one change, trace retention, maximum 16 decoder diagnostics, maximum 16 renderer diagnostics, lifecycle counter accumulation, and preservation of captured diagnostics after resource retirement.

- [ ] **Step 2: Implement PlayerTelemetry**

The owner accepts domain events such as `recordTrace`, `captureDecoderLifecycle`, `captureDecoderDiagnostic`, `captureRendererDiagnostic`, `recordIncident`, and `recordCleanupFailure`. It publishes immutable snapshots and owns the retained arrays/counters. It must not expose its arrays or a generic `patch()` method.

- [ ] **Step 3: Replace monolith telemetry fields and helpers**

Move trace, decoder/renderer diagnostics, lifecycle counters, incidents, underflows, draws, transition counts, loop crossings, cleanup failure count, and diagnostic merge logic. Scheduling and media owners report domain events; they do not mutate counters directly.

- [ ] **Step 4: Run diagnostics and player tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/player-telemetry.test.ts packages/element/test/diagnostics.test.ts packages/element/test/player-decoder-run-qualification.test.ts packages/element/test/player.test.ts
npm run typecheck -w @pixel-point/aval-element
```

Expected: PASS with unchanged public diagnostic shapes and retention limits.

- [ ] **Step 5: Commit telemetry ownership**

```sh
git add packages/element/src/player-telemetry.ts packages/element/src/player.ts packages/element/test/player-telemetry.test.ts packages/element/test/diagnostics.test.ts packages/element/test/player-decoder-run-qualification.test.ts
git commit -m "refactor(element): isolate player telemetry"
```

### Task 5: Extract the media-resource runtime

**Files:**
- Create: `packages/element/src/player-media-runtime.ts`
- Create: `packages/element/test/player-media-runtime.test.ts`
- Modify: `packages/element/test/player-decoder-run-qualification.test.ts`
- Modify: `packages/element/test/player-prefetch.test.ts`
- Modify: `packages/element/test/renderer-operation-coordinator.test.ts`
- Modify: `packages/element/src/player.ts`

- [ ] **Step 1: Write owner-level media lifetime tests**

Cover:

```text
asset/manifest/rendition installation;
validator then decoder-pool then renderer readiness;
resident-frame caching and release;
foreground/candidate stream reservation and cancellation;
route prefetch creation and retirement;
draw ownership and renderer diagnostics;
context loss/recovery resource transitions;
resource-budget reporting after each material change;
single idempotent retirement of every frame/run/pool/renderer/asset.
```

- [ ] **Step 2: Define a narrow named input and operation surface**

Use a named constructor input containing immutable platform/configuration/publication/telemetry collaborators. Expose media operations required by the session: prepare, qualify output, prepare routes, test route readiness, seed/resolve active media, draw, resize, handle context change, settle, and retire. Do not expose `DecoderPool`, `Renderer`, `Asset`, `Map`, `Set`, or mutable media records.

- [ ] **Step 3: Move all media state into PlayerMediaRuntime**

Move asset, rendition, decoder pool, renderer, codec validator, resident promises/sets/frames, active media, stream reservations, route prefetch, unit-to-decoder tracking, output qualification, frame release, renderer context recovery resources, resource reporting, and animation-resource retirement.

- [ ] **Step 4: Preserve session/media event ordering explicitly**

Use request/response methods whose tests prove: graph preview happens before media acquisition; draw happens before after-draw effects; frame release happens after draw; route candidate promotion is atomic; terminal retirement rejects outstanding media work before closing resources.

- [ ] **Step 5: Run media, decoder, renderer, prefetch, and player tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/player-media-runtime.test.ts packages/element/test/player-decoder-run-qualification.test.ts packages/element/test/player-prefetch.test.ts packages/element/test/decoder-pool.test.ts packages/element/test/renderer-operation-coordinator.test.ts packages/element/test/player.test.ts
npm run typecheck -w @pixel-point/aval-element
npm run build -w @pixel-point/aval-element
```

Expected: PASS; `player.ts` no longer owns any concrete media resource or frame collection.

- [ ] **Step 6: Commit media ownership**

```sh
git add packages/element/src/player-media-runtime.ts packages/element/src/player.ts packages/element/test/player-media-runtime.test.ts packages/element/test/player-decoder-run-qualification.test.ts packages/element/test/player-prefetch.test.ts packages/element/test/renderer-operation-coordinator.test.ts
git commit -m "refactor(element): isolate player media resources"
```

### Task 6: Extract PlayerSession and finish the lazy factory

**Files:**
- Create: `packages/element/src/player-session.ts`
- Create: `packages/element/test/player-session.test.ts`
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/test/player.test.ts`
- Modify: `packages/element/test/playback-error.test.ts`
- Modify: `packages/element/test/player-prefetch.test.ts`

- [ ] **Step 1: Write direct session tests**

Construct `PlayerSession` from a named discriminated input and fake media/telemetry collaborators. Test prepare, activate/publish, setState, send/canSend/readyFor, pause/resume, setMotion, suspend, visibility, resize, context changes, snapshot, settled, and dispose. Include RAF-generation invalidation and terminal-error priority.

Also assert that `PlayerSession` satisfies the existing
`PlayerCandidateHandle` capability contract. The selector tests remain
unchanged; only its injected candidate factory changes from `PlayerImpl` to
`PlayerSession`.

- [ ] **Step 2: Move graph and scheduling ownership**

Move motion graph, states/units/edges lookup, preparation plan, request tracking, ordinal, RAF/clock/deadline state, advance/register/apply/effect ordering, pause/resume, visibility, static recovery policy, and terminal coordination into `player-session.ts`.

- [ ] **Step 3: Use one named constructor contract**

Replace the positional constructor with:

```ts
export interface PlayerSessionInput {
  readonly candidate: Readonly<PlayerCandidateDescriptor>;
  readonly publications: PublicationGate;
  readonly preparationDeadline: PreparationDeadline;
  readonly media: PlayerMediaRuntime;
  readonly telemetry: PlayerTelemetry;
  readonly platform: Readonly<PlayerPlatform>;
}
```

Keep the input immutable and domain-specific. Do not add an index signature or a generic context/service container.

- [ ] **Step 4: Finish player.ts as the lazy factory**

The file exports `createPlayer()` plus only factory-local orchestration helpers. It imports selection/session constructors but does not own session state. Target 100–160 lines; hard cap 200.

- [ ] **Step 5: Run the full element and browser suites**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test
npm run typecheck -w @pixel-point/aval-element
npm run build -w @pixel-point/aval-element
npm run test:browser
wc -l packages/element/src/player.ts packages/element/src/player-selection.ts packages/element/src/player-publication-gate.ts packages/element/src/player-resource-budget.ts packages/element/src/player-failures.ts packages/element/src/player-telemetry.ts packages/element/src/player-media-runtime.ts packages/element/src/player-session.ts
```

Expected: all tests pass; `player.ts` is at most 200 lines; every extracted module is at most 1,000 lines; media/session targets are below 1,000 and all other new player modules are below 500.

- [ ] **Step 6: Run the scheduled thermo-nuclear review**

Invoke `thermo-nuclear-code-quality-review` over all player modules and tests. Fix every valid finding concerning cyclic ownership, duplicated state, pass-through methods, callback-order drift, scattered failure policy, giant files, or type erosion. Rerun Step 5.

- [ ] **Step 7: Commit the completed decomposition**

```sh
git add packages/element/src/player.ts packages/element/src/player-session.ts packages/element/test/player-session.test.ts packages/element/test/player.test.ts packages/element/test/playback-error.test.ts packages/element/test/player-prefetch.test.ts
git commit -m "refactor(element): split player runtime ownership"
```

### Task 7: Verify there is no disguised monolith

**Files:**
- Modify only if the audit identifies a valid issue in the files above.

- [ ] **Step 1: Run structural searches**

```sh
rg -n 'PlayerContext|RuntimeContext|Record<string, unknown>|as unknown as' packages/element/src/player*.ts
rg -n 'new (Asset|DecoderPool|Renderer)|new Map|new Set' packages/element/src/player.ts packages/element/src/player-session.ts
rg -n 'DecoderPool|Renderer|Asset|VideoFrame' packages/element/src/player-session.ts
```

Expected: the first search has no generic owner bag or unsafe cast; the factory/session searches reveal no concrete media ownership outside `player-media-runtime.ts`, apart from type-only domain contracts deliberately documented in the session input.

- [ ] **Step 2: Confirm dependency direction**

Inspect imports and ensure `player-media-runtime.ts`, `player-telemetry.ts`, and policy modules never import `player-session.ts`, `player-selection.ts`, or `player.ts`. `player-session.ts` never imports `player-selection.ts` or `player.ts`.

- [ ] **Step 3: Run the phase gate**

```sh
npm run typecheck
npm run test:unit
npm run build:public-packages
npm run api:check
git diff --check
```

Expected: all commands pass with no public API change outside regenerated reports caused by intentional internal export cleanup.
