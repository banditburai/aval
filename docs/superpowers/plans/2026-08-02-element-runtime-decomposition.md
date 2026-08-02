# Custom-Element Runtime Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `aval-element.ts` from a 3,000-line owner of unrelated lifetimes into a focused `<aval-player>` facade composed from explicit source, mutation, environment, input, page-resource, cleanup, diagnostics, and runtime-session owners.

**Architecture:** The custom element retains the public DOM contract: lifecycle callbacks, reflected properties, snapshots/events, shadow-layer composition, and terminal disposal. Extracted classes own complete lifetimes and communicate through narrow typed ports. `ElementRuntimeSession` is the only owner of active/retiring players and generation work; `ElementHostEnvironment`, `ElementInputBinding`, and `ElementPageResourceOwner` are the only owners of their listeners/observers, input listeners, and page admission resources respectively.

**Tech Stack:** TypeScript 7, Custom Elements, Shadow DOM, Mutation/Resize/Intersection observers, WebCodecs page admission, Vitest 4, Playwright 1.61.

---

## Required ownership boundaries

```text
aval-element.ts (public DOM facade)
  |-> element-sources.ts (pure source parsing/mutation)
  |-> element-event-mutation-gate.ts (serialized public effects)
  |-> owned-releases.ts (typed retry queues per listener owner)
  |-> element-host-environment.ts (observer/listener lifetime)
  |-> element-input-binding.ts (interaction-target/listener lifetime)
  |-> element-page-resource-owner.ts (participant/ticket/lease/bytes)
  |-> element-cleanup-proof.ts (typed receipts/proofs)
  |-> element-diagnostics.ts (bounded observations)
  `-> element-runtime-session.ts (generation/player lifetime)
```

No extracted owner receives the element instance as a mutable generic context. DOM-dependent owners receive a specific host plus typed callbacks. The runtime session receives explicit ports and cannot reach into observer, input, diagnostic, or resource-owner fields.

### Task 1: Characterize facade, lifecycle, and cleanup invariants

**Files:**
- Modify: `packages/element/test/element-lifecycle-regressions.test.ts`
- Modify: `packages/element/test/element-cleanup-regressions.test.ts`
- Modify: `packages/element/test/element-inputs.test.ts`
- Modify: `packages/element/test/diagnostics.test.ts`
- Modify: `packages/element/test/aval-element-snapshot.test.ts`
- Modify: `packages/element/test/accessibility-contract.test.ts`

- [ ] **Step 1: Add explicit callback and mutation-order characterization**

Prove listener-before-upgrade, connected/disconnected microtask reuse, adoption across documents, source-mutation coalescing, deferred command order during event dispatch, snapshot-before-listener visibility, and event-follow-up order.

```ts
expect(order).toEqual([
  "snapshot-committed",
  "event-listener-enter",
  "event-listener-exit",
  "deferred-command",
  "event-follow-up"
]);
```

- [ ] **Step 2: Add stale-generation and resource characterization**

Cover stale player callbacks, stale decoder-ticket grants, stale intersection resolution, stale source observer records, rapid source replacement, disconnect/reconnect, adoption, and queued second-element admission after the first retires.

- [ ] **Step 3: Add ownership-proof characterization**

Assert repeated dispose returns the same operation while active; observer/listener removal retries after a one-time failure; player settlement precedes proof completion; page participant, ticket, lease, and bytes are zero at terminal completion; canonical playback error survives cleanup failure.

- [ ] **Step 4: Run the focused baseline**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/element-cleanup-regressions.test.ts packages/element/test/element-inputs.test.ts packages/element/test/diagnostics.test.ts packages/element/test/aval-element-snapshot.test.ts packages/element/test/accessibility-contract.test.ts
```

Expected: PASS against the monolith.

- [ ] **Step 5: Commit characterization tests**

```sh
git add packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/element-cleanup-regressions.test.ts packages/element/test/element-inputs.test.ts packages/element/test/diagnostics.test.ts packages/element/test/aval-element-snapshot.test.ts packages/element/test/accessibility-contract.test.ts
git commit -m "test(element): lock custom element ownership invariants"
```

### Task 2: Extract source parsing and typed cleanup proof

**Files:**
- Create: `packages/element/src/element-sources.ts`
- Create: `packages/element/src/element-cleanup-proof.ts`
- Create: `packages/element/test/element-sources.test.ts`
- Create: `packages/element/test/element-cleanup-proof.test.ts`
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/test/element-cleanup-regressions.test.ts`

- [ ] **Step 1: Write direct source tests**

Move the existing observable behavior into direct tests for:

```ts
export interface SourceRead {
  readonly sources: readonly Readonly<Source>[];
  readonly failures: readonly Readonly<SourceFailure>[];
}

export function readElementSources(host: Element): Readonly<SourceRead>;
export function isElementSourceMutation(host: Element, record: MutationRecord): boolean;
```

Cover priority ordering, duplicate codec rejection, missing/invalid `src`, integrity normalization, irrelevant subtree mutations, source insertion/removal, and relevant attribute changes.

- [ ] **Step 2: Write direct cleanup-proof tests**

Define discriminated immutable types for element resource ownership and cleanup:

```ts
export interface ElementOwnershipSnapshot {
  readonly completed: boolean;
  readonly observers: Readonly<ObserverOwnership>;
  readonly inputs: Readonly<InputOwnership>;
  readonly pageResources: Readonly<PageResourceOwnership>;
  readonly timers: number;
  readonly deferredOperations: number;
}

export interface ElementCleanupReceipt {
  readonly completed: boolean;
  readonly generation: number;
  readonly sourceGeneration: number;
  readonly player: Readonly<PlayerCleanupProof> | null;
  readonly element: Readonly<ElementOwnershipSnapshot>;
}
```

Test successful proof, each incomplete ownership kind, failed player disposal/settlement, stale publications, missing frame cleanup, retry receipts, and terminal composition.

- [ ] **Step 3: Move pure source and cleanup logic**

Move `readSources`, `sourceMutation`, `createCleanupReceipt`, `proveRetirement`, `playerSnapshotDisposed`, ownership snapshot types, and proof-only helpers. Replace internal `Readonly<Record<string, unknown>>` cleanup values with the typed contracts above. Keep public diagnostics serialization unchanged.

- [ ] **Step 4: Run focused tests and typecheck**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/element-sources.test.ts packages/element/test/element-cleanup-proof.test.ts packages/element/test/element-cleanup-regressions.test.ts
npm run typecheck -w @pixel-point/aval-element
```

Expected: PASS; `aval-element.ts` contains no source parser/proof implementation and no untyped cleanup receipt.

- [ ] **Step 5: Commit pure extraction**

```sh
git add packages/element/src/element-sources.ts packages/element/src/element-cleanup-proof.ts packages/element/src/aval-element.ts packages/element/test/element-sources.test.ts packages/element/test/element-cleanup-proof.test.ts packages/element/test/element-cleanup-regressions.test.ts
git commit -m "refactor(element): extract sources and cleanup proof"
```

### Task 3: Expand the event mutation gate into the sole serializer

**Files:**
- Modify: `packages/element/src/element-event-mutation-gate.ts`
- Modify: `packages/element/test/element-event-mutation-gate.test.ts`
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/test/element-lifecycle-regressions.test.ts`

- [ ] **Step 1: Add failing gate tests for every deferred operation kind**

Test synchronous command deferral, promise-returning command deferral, per-attribute coalescing to the latest value, owned microtasks, event follow-ups, nested transactions, rejected deferred promises, close/dispose behavior, and accurate pending-operation count.

- [ ] **Step 2: Give ElementEventMutationGate complete serialization ownership**

The gate owns deferred attribute names, command count, queued microtasks, and follow-ups. Expose domain methods:

```ts
deferCommand(operation: () => void): boolean;
deferCommandPromise<T>(operation: () => Promise<T>): Promise<T> | null;
deferAttribute(name: string, read: () => string | null, apply: (value: string | null) => void): boolean;
queueOwnedMicrotask(operation: () => void): void;
get pendingOperationCount(): number;
```

The facade must not retain a parallel `Set`, counter, or queue.

- [ ] **Step 3: Migrate facade calls and preserve event boundaries**

Replace `#deferredAttributes`, `#deferredCommandCount`, `#deferPublicMutation`, `#deferPublicMutationPromise`, and `#queueOwnedMicrotask`. Keep public event transactions around snapshot transitions.

- [ ] **Step 4: Run mutation/lifecycle tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/element-event-mutation-gate.test.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/aval-element-snapshot.test.ts
npm run typecheck -w @pixel-point/aval-element
```

Expected: PASS with one pending-operation authority.

- [ ] **Step 5: Commit mutation ownership**

```sh
git add packages/element/src/element-event-mutation-gate.ts packages/element/src/aval-element.ts packages/element/test/element-event-mutation-gate.test.ts packages/element/test/element-lifecycle-regressions.test.ts
git commit -m "refactor(element): centralize event mutation serialization"
```

### Task 4: Extract page decoder and byte ownership

**Files:**
- Create: `packages/element/src/element-page-resource-owner.ts`
- Create: `packages/element/test/element-page-resource-owner.test.ts`
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/test/page-resources.test.ts`
- Modify: `packages/element/test/element-cleanup-regressions.test.ts`

- [ ] **Step 1: Write resource-owner state-machine tests**

Cover lazy participant creation per realm, decoder request/grant, queued request, cancellation, lease release, byte reporting, realm adoption, source-epoch invalidation, stale grant rejection with immediate local release, terminal release, and repeated release.

- [ ] **Step 2: Implement ElementPageResourceOwner**

Use a narrow environment port for `createPageDecoderParticipant()` and snapshots. Expose:

```ts
claimDecoder(generation: number, requestEpoch: number): boolean;
setResourceBytes(bytes: number): void;
invalidateRequest(): void;
releaseDecoderLease(): void;
releaseAll(options?: Readonly<{ forgetRealm?: boolean }>): void;
snapshot(): Readonly<PageResourceOwnership>;
```

The constructor receives a typed
`onDecoderGranted(generation, requestEpoch)` callback. `claimDecoder()` stays
synchronous to satisfy `PlayerInput.decoderReady`: it returns true only for an
already held current lease, otherwise queues a ticket internally and returns
false. A valid later grant invokes the callback so the facade/session can
schedule a restart; a stale grant is released locally without callback. The
owner stores participant, realm, ticket, lease, bytes, and request epoch. No
other module stores any of them.

- [ ] **Step 3: Migrate callbacks and cleanup proof**

Route player `decoderReady`, `onResourceBytes`, and
`onAnimationResourcesRetired` callbacks through the owner. Wire
`onDecoderGranted` to the runtime session's explicit grant event; runtime
generation checks remain in the session and the owner independently
rejects/releases stale grants.

- [ ] **Step 4: Run resource, cleanup, and rapid-replacement tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/element-page-resource-owner.test.ts packages/element/test/page-resources.test.ts packages/element/test/element-cleanup-regressions.test.ts packages/element/test/element-lifecycle-regressions.test.ts
npm run typecheck -w @pixel-point/aval-element
```

Expected: PASS; participant/ticket/lease/byte fields exist only in the new owner and page-resource primitives.

- [ ] **Step 5: Commit page-resource ownership**

```sh
git add packages/element/src/element-page-resource-owner.ts packages/element/src/aval-element.ts packages/element/test/element-page-resource-owner.test.ts packages/element/test/page-resources.test.ts packages/element/test/element-cleanup-regressions.test.ts
git commit -m "refactor(element): isolate page resource ownership"
```

### Task 5: Extract input target and engagement binding

**Files:**
- Create: `packages/element/src/owned-releases.ts`
- Create: `packages/element/test/owned-releases.test.ts`
- Create: `packages/element/src/element-input-binding.ts`
- Create: `packages/element/test/element-input-binding.test.ts`
- Modify: `packages/element/src/element-engagement-binding.ts`
- Modify: `packages/element/test/element-engagement-binding.test.ts`
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/test/element-inputs.test.ts`
- Modify: `packages/element/test/accessibility-contract.test.ts`

- [ ] **Step 1: Write direct input-owner tests**

Test explicit target validation, `interaction-for` resolution, target
replacement, shadow/root boundaries, listener install/remove, hover/focus
changes, click/keyboard binding dispatch, authored binding changes, engagement
retries after transition end, epoch invalidation, adoption, disconnect,
repeated close, and a one-time input-listener removal failure that succeeds on
the owner's retry path.

- [ ] **Step 2: Implement ElementInputBinding**

First implement a focused `OwnedReleaseTracker` in `owned-releases.ts` with
typed release kind, attempt, retry, pending-count, and snapshot operations.
Test it directly. Compose the existing `ElementEngagementBinding`; do not
duplicate its transition logic. The input owner has its own release tracker and
stores explicit/resolved target, listener records, binding epoch, hover/focus,
and engagement state. It receives typed callbacks for current
metadata/bindings, current transition state, binding dispatch, and snapshot
publication.

- [ ] **Step 3: Move all input listener ownership**

Move `#inputListeners`, `#boundInputTarget`, `#bindingEpoch`, `#explicitTarget`, `#hovered`, `#focused`, `#bindInputs`, `#unbindInputs`, `#engagement`, `#queueEngagementRetry`, `#sendBinding`, and target resolution. The facade public `interactionTarget` property delegates to the owner.

- [ ] **Step 4: Run input, engagement, and accessibility tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/owned-releases.test.ts packages/element/test/element-input-binding.test.ts packages/element/test/element-engagement-binding.test.ts packages/element/test/element-inputs.test.ts packages/element/test/accessibility-contract.test.ts
npm run typecheck -w @pixel-point/aval-element
```

Expected: PASS with all input listener installation/removal and failed-release
retry performed by one input owner.

- [ ] **Step 5: Commit input ownership**

```sh
git add packages/element/src/owned-releases.ts packages/element/src/element-input-binding.ts packages/element/src/element-engagement-binding.ts packages/element/src/aval-element.ts packages/element/test/owned-releases.test.ts packages/element/test/element-input-binding.test.ts packages/element/test/element-engagement-binding.test.ts packages/element/test/element-inputs.test.ts packages/element/test/accessibility-contract.test.ts
git commit -m "refactor(element): isolate interaction binding ownership"
```

### Task 6: Extract host environment observation and adoption

**Files:**
- Create: `packages/element/src/element-host-environment.ts`
- Create: `packages/element/test/element-host-environment.test.ts`
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/test/element-lifecycle-regressions.test.ts`

- [ ] **Step 1: Write environment-owner tests**

Use two test realms to cover source observer records, resize, intersection first sample/gate, document visibility, reduced-motion media changes, pagehide/pageshow, window resize, root replacement, adoption, one-time release failure and retry, stale observer epoch, and repeated install/remove.

- [ ] **Step 2: Reuse OwnedReleaseTracker in ElementHostEnvironment**

Give the environment owner its own `OwnedReleaseTracker` instance from
`owned-releases.ts`; never share one mutable tracker between input and host
lifetimes. The environment owner stores all Mutation/Resize/Intersection
observers, document/window/media listeners, installed realm/root,
page-hidden/intersection/positive-box state, and observer/adoption epochs.

- [ ] **Step 3: Expose a narrow environment snapshot and callbacks**

```ts
export interface ElementHostEnvironmentSnapshot {
  readonly installed: boolean;
  readonly documentVisible: boolean;
  readonly intersecting: boolean;
  readonly positiveBox: boolean;
  readonly effectivelyVisible: boolean;
  readonly reducedMotion: boolean;
  readonly failedReleaseCount: number;
}
```

Callbacks report `sourcesChanged`, `geometryChanged`, `visibilityChanged`, `motionPreferenceChanged`, and `realmChanged`. The owner does not call player commands or mutate snapshots.

- [ ] **Step 4: Migrate lifecycle callbacks**

Have `connectedCallback`, `disconnectedCallback`, and `adoptedCallback` delegate install/remove/adopt work. Preserve the disconnect microtask that allows framework reuse. Recreate source observation through the environment owner after adoption.

- [ ] **Step 5: Run environment, lifecycle, motion, and cleanup tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/element-host-environment.test.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/element-cleanup-regressions.test.ts packages/element/test/element-inputs.test.ts
npm run typecheck -w @pixel-point/aval-element
npm run build -w @pixel-point/aval-element
```

Expected: PASS; host observer/listener fields and their failed releases exist
only in the environment owner, while input listener failures remain isolated in
the input owner. Cleanup proof composes both typed ownership snapshots.

- [ ] **Step 6: Run the scheduled thermo-nuclear review and commit**

Invoke `thermo-nuclear-code-quality-review` over the source, cleanup, mutation, page-resource, input, environment owners, facade, and tests. Fix valid findings and rerun Step 5, then commit:

```sh
git add packages/element/src/element-host-environment.ts packages/element/src/aval-element.ts packages/element/test/element-host-environment.test.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/element-cleanup-regressions.test.ts
git commit -m "refactor(element): isolate host environment ownership"
```

### Task 7: Extract bounded element diagnostics

**Files:**
- Create: `packages/element/src/element-diagnostics.ts`
- Create: `packages/element/test/element-diagnostics.test.ts`
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/test/diagnostics.test.ts`

- [ ] **Step 1: Write direct diagnostic-store tests**

Test counters, stale-publication count, timer count, terminal error retention, decoder and renderer diagnostic caps, playback lifecycle merging, cleanup receipts, trace inclusion/exclusion, immutable result assembly, and stable identity between unchanged reads.

- [ ] **Step 2: Implement ElementDiagnostics**

Move element trace, counters, terminal failure observation, cleanup failure count, decoder/renderer limits and arrays, playback lifecycle, current/terminal cleanup receipt, and public diagnostics assembly. Expose domain methods rather than writable counters or generic patches.

- [ ] **Step 3: Preserve public failure authority in the facade/session boundary**

The runtime session selects and publishes errors through a typed facade port; diagnostics observes the final event. The diagnostics owner must never initiate retirement or change readiness.

- [ ] **Step 4: Run diagnostics and snapshot tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/element-diagnostics.test.ts packages/element/test/diagnostics.test.ts packages/element/test/aval-element-snapshot.test.ts packages/element/test/playback-error.test.ts
npm run typecheck -w @pixel-point/aval-element
```

Expected: PASS with unchanged public `AvalDiagnostics` content, identity, and caps.

- [ ] **Step 5: Commit diagnostic ownership**

```sh
git add packages/element/src/element-diagnostics.ts packages/element/src/aval-element.ts packages/element/test/element-diagnostics.test.ts packages/element/test/diagnostics.test.ts
git commit -m "refactor(element): isolate custom element diagnostics"
```

### Task 8: Extract the generation/player runtime session

**Files:**
- Create: `packages/element/src/element-runtime-session.ts`
- Create: `packages/element/test/element-runtime-session.test.ts`
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/test/element-lifecycle-regressions.test.ts`
- Modify: `packages/element/test/element-cleanup-regressions.test.ts`
- Modify: `packages/element/test/element-inputs.test.ts`
- Modify: `packages/element/test/diagnostics.test.ts`

- [ ] **Step 1: Write direct runtime-session tests with typed fakes**

Test generation queueing, replacement retirement, lazy player import, preparation deadline, candidate handoff, metadata/readiness/draw/event publication, resource callbacks, restart capture, visibility suspension/resume, declarative state, commands, failure priority, settlement, cleanup proof, and terminal disposal.

- [ ] **Step 2: Define explicit collaborator ports**

The named input contains:

```ts
export interface ElementRuntimeSessionInput {
  readonly read: Readonly<ElementRuntimeReadPort>;
  readonly publish: Readonly<ElementRuntimePublicationPort>;
  readonly presentation: Readonly<ElementRuntimePresentationPort>;
  readonly pageResources: Readonly<ElementPageResourcePort>;
}
```

`ElementRuntimeReadPort` exposes only immutable current configuration, source,
geometry, visibility, and realm snapshots. `ElementRuntimePublicationPort`
exposes exact domain outputs: commit public-state patch, dispatch public event,
metadata changed, readiness changed, animated frame drawn, terminal failure,
cleanup receipt, and diagnostic event. The presentation port exposes the
canvas and source/draw layer operations; the page-resource port exposes
synchronous decoder admission, byte reporting, release, and an ownership
snapshot. None has an index signature or exposes an owner's private fields.

The facade wires `ElementHostEnvironment` callbacks into explicit session
methods `sourcesChanged`, `geometryChanged`, `visibilityChanged`,
`motionPreferenceChanged`, and `realmChanged`. It wires input bindings into
`sendBinding` and valid asynchronous decoder grants into `decoderGranted`.
The session does not hold `ElementHostEnvironment`, `ElementInputBinding`, or
`ElementDiagnostics`. It creates and owns its own `LifecycleLane`; diagnostic
domain events leave through the publication port.

- [ ] **Step 3: Move all generation and player authority**

Move active/retiring/preparing/suspending/suspended/restart/visibility player references, generation counters, load/controller, metadata, reload queue, restart capture, `#ensure`, generation start/retirement, runtime callbacks, command delegation, visibility suspension, motion reconciliation, and terminal retirement.

- [ ] **Step 4: Keep lazy loading inside the runtime session**

The module-level `Promise<typeof import("./player.js")>` remains lazy and is initialized only after a connected element with valid sources passes host support and intersection setup. Importing or registering `@pixel-point/aval-element` must not load `player.js`.

- [ ] **Step 5: Reduce aval-element.ts to its public facade**

Retain only custom-element class construction, lifecycle callbacks, reflected public properties, snapshot/event transaction publication, collaborator composition, intrinsic shadow-layer surface, and public `prepare/setState/send/readyFor/pause/resume/getDiagnostics/dispose` delegation. Target 500–750 lines; hard cap 800.

- [ ] **Step 6: Run the complete element suite and browser smoke tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test
npm run typecheck -w @pixel-point/aval-element
npm run build -w @pixel-point/aval-element
npx playwright test --project=chromium
wc -l packages/element/src/aval-element.ts packages/element/src/owned-releases.ts packages/element/src/element-sources.ts packages/element/src/element-event-mutation-gate.ts packages/element/src/element-host-environment.ts packages/element/src/element-input-binding.ts packages/element/src/element-page-resource-owner.ts packages/element/src/element-cleanup-proof.ts packages/element/src/element-diagnostics.ts packages/element/src/element-runtime-session.ts
```

Expected: all tests pass; `aval-element.ts` is at most 800 lines; `element-runtime-session.ts` targets 700–900 and is at most 1,000; every other extracted owner is at most 600 lines.

- [ ] **Step 7: Run the scheduled thermo-nuclear review**

Invoke `thermo-nuclear-code-quality-review` over all element owners, the facade, and tests. Fix every valid finding concerning cross-owner mutation, callback webs, generic contexts, duplicated lifecycle authority, pass-through abstractions, giant files, or weaker types. Rerun Step 6.

- [ ] **Step 8: Commit the completed decomposition**

```sh
git add packages/element/src/element-runtime-session.ts packages/element/src/aval-element.ts packages/element/test/element-runtime-session.test.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/element-cleanup-regressions.test.ts packages/element/test/element-inputs.test.ts packages/element/test/diagnostics.test.ts
git commit -m "refactor(element): split custom element runtime ownership"
```

### Task 9: Verify facade focus and one-way ownership

**Files:**
- Modify only if this audit identifies a valid issue in files above.

- [ ] **Step 1: Search for forbidden generic ownership and leaked fields**

```sh
npm run architecture:check
rg -n 'ElementContext|RuntimeContext|as unknown as' packages/element/src/aval-element.ts packages/element/src/element-*.ts
rg -n 'PageDecoder(Participant|Ticket|Lease)|#resourceBytes' packages/element/src/aval-element.ts packages/element/src/element-*.ts
rg -n 'MutationObserver|ResizeObserver|IntersectionObserver|addEventListener' packages/element/src/aval-element.ts packages/element/src/element-runtime-session.ts
rg -n '#player|#retiringPlayer|#controller|#load' packages/element/src/aval-element.ts packages/element/src/element-*.ts
```

Expected: the AST-backed owner/input guard passes; the named context/unsafe-cast
search is empty; page resource state appears only in its owner; observers and
listeners appear only in host/input owners; player generation state appears
only in runtime session.

- [ ] **Step 2: Inspect dependency direction**

Ensure source/cleanup modules import no stateful owner; host/input/resource/diagnostics owners do not import runtime session or facade; runtime session imports collaborators but neither collaborators nor player modules import it; `aval-element.ts` is the sole composition root.

- [ ] **Step 3: Run the phase gate**

```sh
npm run typecheck
npm run test:unit
npm run build:public-packages
npm run api:check
git diff --check
```

Expected: all commands pass with no public custom-element behavior regression.
