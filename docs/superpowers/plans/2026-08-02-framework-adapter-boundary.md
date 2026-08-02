# Framework Adapter Boundary Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make React and Svelte visibly thin wrappers over one canonical element adapter by sharing option normalization, element tokens, status, and one stable command facade while keeping JSX/Svelte rendering and lifecycle code framework-native.

**Architecture:** `@pixel-point/aval-element/adapter` exports framework infrastructure only: configuration/binding factories and narrow source, option, render, status, command, controller, and binding contracts. The adapter owns semantic values and element-facing `autoplay`/`bindings` tokens. React translates subscriptions through `useSyncExternalStore`; Svelte translates them through a readable store. Neither wrapper repeats command delegation or imports element runtime implementation modules.

**Tech Stack:** TypeScript 7, Web Components, React 19, Svelte 5, Vitest 4, Playwright 1.61, API Extractor.

---

### Task 1: Make render tokens and command contracts canonical

**Files:**
- Modify: `packages/element/src/adapter-options.ts`
- Modify: `packages/element/src/adapter-binding.ts`
- Modify: `packages/element/src/adapter.ts`
- Modify: `packages/element/test/adapter-options.test.ts`
- Modify: `packages/element/test/adapter-binding.test.ts`
- Create: `packages/element/test/adapter-public-api.compile.ts`
- Modify: `packages/element/tsconfig.test.json`
- Modify: `packages/element/test/public-api.test.ts`

- [ ] **Step 1: Add failing render-token tests**

Change the normalized-render expectation from framework booleans to element tokens:

```ts
expect(createAvalAdapterConfiguration({
  sources: { h264: "/motion.avl" },
  autoplay: false,
  autoBind: false
}).render).toMatchObject({
  autoplay: "manual",
  bindings: "none"
});
```

Add the default expectation `autoplay: "visible"` and `bindings: "auto"`. Keep option input booleans and validation unchanged.

- [ ] **Step 2: Add failing canonical-command tests**

Require one stable frozen command object from the binding:

```ts
const binding = createTestBinding();
expect(binding.commands).toBe(binding.commands);
expect(Object.isFrozen(binding.commands)).toBe(true);
expect(Object.keys(binding.commands)).toEqual([
  "prepare", "setState", "send", "readyFor", "play", "pause",
  "getDiagnostics"
]);
```

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/adapter-options.test.ts packages/element/test/adapter-binding.test.ts
```

Expected: FAIL because render options still contain booleans and commands are individual binding fields.

- [ ] **Step 3: Change the render contract once**

Define:

```ts
export interface AvalAdapterRenderOptions {
  readonly sources: readonly Readonly<{
    readonly codec: AvalSourceCodec;
    readonly src: string;
  }>[];
  readonly sourceKey: string;
  readonly state: string | undefined;
  readonly autoplay: AvalAutoplay;
  readonly bindings: AvalBindings;
  readonly motion: AvalMotion | undefined;
  readonly fit: AvalFit | undefined;
  readonly crossOrigin: AvalCrossOrigin | undefined;
}
```

`createAvalAdapterConfiguration()` maps booleans once. `sameAvalRenderOptions()` compares `bindings` instead of `autoBind`. Source ordering/key generation remains canonical and unchanged.

- [ ] **Step 4: Define one command and controller contract**

Add:

```ts
export interface AvalAdapterCommands {
  readonly prepare: (options?: Readonly<AvalPrepareOptions>) => Promise<RuntimeReadinessResult>;
  readonly setState: (name: string) => Promise<void>;
  readonly send: (event: string) => boolean;
  readonly readyFor: (state: string) => boolean;
  readonly play: () => Promise<void>;
  readonly pause: () => void;
  readonly getDiagnostics: (options?: Readonly<{ readonly trace?: boolean }>) => Readonly<AvalDiagnostics> | null;
}

export type AvalAdapterController =
  Readonly<AvalAdapterStatus> & Readonly<AvalAdapterCommands>;
```

`AvalAdapterBinding` exposes `readonly commands: Readonly<AvalAdapterCommands>` and no longer repeats the seven command members at binding top level. Construct and freeze the command object once in `AvalAdapterBindingImplementation`.

- [ ] **Step 5: Export only framework infrastructure from /adapter**

Export configuration/binding factories and these contracts:

```text
AvalSources; AvalAdapterOptions; AvalAdapterCallbacks;
AvalAdapterRenderOptions; AvalAdapterConfiguration; AvalAdapterStatus;
AvalAdapterCommands; AvalAdapterController; AvalAdapterBinding.
```

Delete the current bulk re-export of element diagnostics, failures, trace, cleanup, readiness, and binding-domain types from `adapter.ts`. Those public types remain available from `@pixel-point/aval-element` and are referenced internally by the adapter contracts.

Keep normalized source descriptors structural inside `AvalAdapterRenderOptions`
instead of exporting `AvalAdapterSource` as another public name. Add
`adapter-public-api.compile.ts` to `tsconfig.test.json` and assert that the
intended adapter contracts compile while representative root-only types such
as `AvalErrorDetail` and `AvalDecoderDiagnostic` fail when imported from
`/adapter` under `@ts-expect-error`.

- [ ] **Step 6: Run focused and public-boundary tests**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/adapter-options.test.ts packages/element/test/adapter-binding.test.ts packages/element/test/public-api.test.ts
npm run typecheck -w @pixel-point/aval-element
npm run build -w @pixel-point/aval-element
```

Expected: PASS; `/adapter` has a small deliberate export surface and the stable command object preserves not-mounted behavior and mounted delegation.

- [ ] **Step 7: Commit the canonical adapter contract**

```sh
git add packages/element/src/adapter-options.ts packages/element/src/adapter-binding.ts packages/element/src/adapter.ts packages/element/test/adapter-options.test.ts packages/element/test/adapter-binding.test.ts packages/element/test/adapter-public-api.compile.ts packages/element/test/public-api.test.ts packages/element/tsconfig.test.json
git commit -m "refactor(element): narrow framework adapter contracts"
```

### Task 2: Convert React to shared types, tokens, and commands

**Files:**
- Modify: `packages/react/src/types.ts`
- Modify: `packages/react/src/use-aval.tsx`
- Modify: `packages/react/src/public-api.compile.tsx`
- Modify: `packages/react/src/ssr.test.tsx`
- Modify: `packages/react/test/browser/fixture.tsx`
- Modify: `packages/react/test/browser/listener-timing.spec.ts`

- [ ] **Step 1: Add React public-type parity assertions**

In `public-api.compile.tsx`, assert both assignment directions:

```ts
declare const reactOptions: UseAvalOptions;
declare const adapterOptions: AvalAdapterOptions;
const adapterFromReact: AvalAdapterOptions = reactOptions;
const reactFromAdapter: UseAvalOptions = adapterOptions;

declare const reactInstance: AvalReactInstance;
const controller: AvalAdapterController = reactInstance;
```

Keep negative source-shape and owned-child compile tests.

- [ ] **Step 2: Change React type definitions to aliases/composition**

Use:

```ts
export type AvalSources = AdapterAvalSources;
export type UseAvalOptions = AvalAdapterOptions;
export type AvalReactInstance = AvalAdapterController;
```

Keep only React-owned `AvalBindingTarget`, `AvalComponentProps`, and `UseAvalResult` locally. Import element-domain types from the element root only when they are part of React-owned props; do not restate adapter status or command members.

- [ ] **Step 3: Consume the stable command object**

Build the public instance as:

```ts
const aval = useMemo<AvalReactInstance>(
  () => Object.freeze({ ...status, ...binding.commands }),
  [binding.commands, status]
);
```

Do not copy a seven-property forwarding list into React.

- [ ] **Step 4: Serialize canonical render tokens directly**

Set `autoplay: render.autoplay` and `bindings: render.bindings` in `hostProperties()`. Retain React-owned ref resolution, `useSyncExternalStore`, effects, source elements, optional props, and boolean ARIA conversion.

- [ ] **Step 5: Run React type, SSR, and browser tests**

Extend the browser fixture with a command that removes `state`, `motion`,
`fit`, `crossorigin`, `width`, and `height`. Prove those optional attributes
disappear without replacing the host, defaults remain `autoplay="visible"` and
`bindings="auto"`, and no page error occurs.

```sh
npm run typecheck -w @pixel-point/aval-react
npx vitest run --config vitest.m9.config.ts packages/react/src/ssr.test.tsx
npm run build -w @pixel-point/aval-react
npm run test:browser -w @pixel-point/aval-react
```

Expected: PASS; SSR emits `autoplay="visible|manual"` and `bindings="auto|none"`; listeners still attach before upgrade; Strict Mode mount/unmount remains reusable.

- [ ] **Step 6: Commit the React migration**

```sh
git add packages/react/src/types.ts packages/react/src/use-aval.tsx packages/react/src/public-api.compile.tsx packages/react/src/ssr.test.tsx packages/react/test/browser/fixture.tsx packages/react/test/browser/listener-timing.spec.ts
git commit -m "refactor(react): consume canonical element adapter"
```

### Task 3: Convert Svelte to shared commands and tokens

**Files:**
- Modify: `packages/svelte/src/types.ts`
- Modify: `packages/svelte/src/controller.ts`
- Modify: `packages/svelte/src/AvalComponent.svelte`
- Modify: `packages/svelte/test/PublicContract.svelte`
- Modify: `packages/svelte/test/controller.test.ts`
- Modify: `packages/svelte/test/ssr.test.ts`
- Modify: `packages/svelte/test/browser/App.svelte`
- Modify: `packages/svelte/test/browser/optional-attribute-removal.spec.ts`

- [ ] **Step 1: Add Svelte controller command identity tests**

Assert the public controller exposes the same command function identities as its private binding's frozen command object, subscription emits status, and option commits do not replace commands.

- [ ] **Step 2: Compose the Svelte public type from shared contracts**

Use:

```ts
export type AvalSources = AdapterAvalSources;
export type CreateAvalOptions = AvalAdapterOptions;
export type AvalSvelteStatus = AvalAdapterStatus;
export type AvalSvelteInstance =
  Readable<Readonly<AvalSvelteStatus>> & Readonly<AvalAdapterCommands>;
```

Keep Svelte-owned binding target and component props locally.

- [ ] **Step 3: Compose the controller without a forwarding list**

Create the frozen controller with:

```ts
const aval: AvalSvelteInstance = Object.freeze({
  subscribe,
  ...binding.commands
});
```

Keep the private WeakMap record so `AvalComponent` can own binding/configuration lifecycle without exposing the binding.

- [ ] **Step 4: Serialize canonical tokens directly**

Use `renderOptions.autoplay` and `renderOptions.bindings` in server markup and client attributes. Retain the Svelte-specific `autoPlay` property-name workaround, `$derived` option reads, `$effect` commit/attach/preparation cleanup, keyed source children, optional-attribute removal, and Svelte-owned boolean ARIA conversion.

- [ ] **Step 5: Run Svelte type, unit, SSR, and browser tests**

Extend the browser fixture with an explicit unmount/remount toggle that reuses
the same controller. Prove detach removes the host, remount succeeds, optional
attributes remain removable, explicit values serialize as
`autoplay="manual"` and `bindings="none"`, and no page error occurs.

```sh
npm run typecheck -w @pixel-point/aval-svelte
npx vitest run --config vitest.m9.config.ts packages/svelte/test/controller.test.ts packages/svelte/test/ssr.test.ts
npm run build -w @pixel-point/aval-svelte
npm run test:browser -w @pixel-point/aval-svelte
```

Expected: PASS; reactive option updates preserve the controller, optional attributes are removed correctly, and SSR tokens match React/element semantics.

- [ ] **Step 6: Commit the Svelte migration**

```sh
git add packages/svelte/src/types.ts packages/svelte/src/controller.ts packages/svelte/src/AvalComponent.svelte packages/svelte/test/PublicContract.svelte packages/svelte/test/controller.test.ts packages/svelte/test/ssr.test.ts packages/svelte/test/browser/App.svelte packages/svelte/test/browser/optional-attribute-removal.spec.ts
git commit -m "refactor(svelte): consume canonical element adapter"
```

### Task 4: Add cross-framework contract proof

**Files:**
- Create: `tests/framework-adapter-parity.test.ts`
- Modify: `scripts/architecture/check-browser-runtime-boundaries.mjs`
- Modify: `tests/architecture/browser-runtime-boundaries.test.ts`
- Modify: `tests/consumers/browser-vite/src/main.ts`
- Modify: `tests/consumers/svelte-vite/src/App.svelte`
- Modify: `tests/consumers/typescript-bundler/index.ts`
- Modify: `tests/consumers/typescript-nodenext/index.ts`
- Modify: `etc/api/element-adapter.api.md` through API report generation
- Modify: `etc/api/react.api.md` through API report generation
- Modify: `etc/api/svelte.api.md` through API report generation

- [ ] **Step 1: Complete compile-time public-type parity**

Use the adapter compile contract plus React's and Svelte's public compile
fixtures to prove both option types are assignable to `AvalAdapterOptions`,
both controller command surfaces derive from `AvalAdapterCommands`, and root
diagnostic/event types are unavailable from `/adapter`.

- [ ] **Step 2: Add SSR runtime parity through public package roots**

Use public React and Svelte package roots in one Vitest file. Avoid JSX by
using React's `createElement()`/`renderToStaticMarkup()` and import Svelte's SSR
`render` explicitly from `svelte/server`. Assert:

```text
both wrappers preserve AV1/VP9/H.265/H.264 source order;
both wrappers expose visible/auto defaults and manual/none explicit tokens;
both wrappers expose identical unmounted status and exact command names.
```

- [ ] **Step 3: Enforce source-import provenance structurally**

Extend the architecture checker's source scan to prove React and Svelte
production AVAL imports are limited to `@pixel-point/aval-element` and
`@pixel-point/aval-element/adapter`, neither wrapper imports player/decoder/
renderer/graph/format implementation modules, neither framework declares its
own seven-command list, and `adapter.ts` does not bulk re-export element runtime
types. Do not claim source provenance from runtime imports in the parity test.

- [ ] **Step 4: Exercise current packed consumer entry points**

Update consumer fixtures to compile shared aliases and call representative commands from both wrappers. Do not import adapter implementation classes in consumers.

- [ ] **Step 5: Generate and inspect API reports**

```sh
npm run api:report
git diff -- etc/api/element-adapter.api.md etc/api/react.api.md etc/api/svelte.api.md
```

Expected: the element adapter report adds `AvalAdapterCommands`/`AvalAdapterController` and loses unrelated diagnostic re-exports; React/Svelte preserve their intended names through aliases/composition.

- [ ] **Step 6: Run the adapter integration gate**

```sh
npx vitest run --config vitest.m9.config.ts tests/framework-adapter-parity.test.ts tests/architecture/browser-runtime-boundaries.test.ts packages/element/test/adapter-options.test.ts packages/element/test/adapter-binding.test.ts packages/react/src/ssr.test.tsx packages/svelte/test/controller.test.ts packages/svelte/test/ssr.test.ts
npm run typecheck
npm run build:public-packages
npm run test:consumers
npm run test:browser -w @pixel-point/aval-react
npm run test:browser -w @pixel-point/aval-svelte
npm run api:check
```

Expected: every command passes.

- [ ] **Step 7: Run the scheduled thermo-nuclear review**

Invoke `thermo-nuclear-code-quality-review` over the adapter and both wrappers. Fix valid findings involving duplicated command lists, duplicated element token policy, type reimplementation, pass-through abstraction, framework logic leaking into element, or element runtime logic leaking into a wrapper. Rerun Step 4.

- [ ] **Step 8: Commit parity proof and API reports**

```sh
git add tests/framework-adapter-parity.test.ts scripts/architecture/check-browser-runtime-boundaries.mjs tests/architecture/browser-runtime-boundaries.test.ts tests/consumers packages/element packages/react packages/svelte etc/api/element-adapter.api.md etc/api/react.api.md etc/api/svelte.api.md
git commit -m "test: enforce framework adapter parity"
```

### Task 5: Verify the wrapper-only package graph

**Files:**
- Modify only if the audit reveals a valid issue above.

- [ ] **Step 1: Inspect production imports**

```sh
rg -n 'from "@pixel-point/aval-' packages/react/src packages/svelte/src
rg -n 'decoder|renderer|player\.js|graph\.js|format' packages/react/src packages/svelte/src
rg -n 'prepare\(|setState\(|readyFor\(|getDiagnostics\(' packages/react/src/types.ts packages/svelte/src/types.ts packages/react/src/use-aval.tsx packages/svelte/src/controller.ts
```

Expected: imports point only to element root or `/adapter`; runtime implementation search is empty; command method declarations live only in the shared adapter contract and framework code composes `binding.commands`.

- [ ] **Step 2: Confirm framework-owned behavior remains local**

React alone owns JSX/ref/effect scheduling and `useSyncExternalStore`. Svelte alone owns runes/actions/SSR attribute application/readable-store subscription. Each owns its source-child markup and ARIA conversion because those are renderer semantics, not playback policy.

- [ ] **Step 3: Run final package checks**

```sh
npm ls @pixel-point/aval-element -w @pixel-point/aval-react -w @pixel-point/aval-svelte
npm run typecheck -w @pixel-point/aval-react
npm run typecheck -w @pixel-point/aval-svelte
git diff --check
```

Expected: both wrappers resolve the same workspace element package and all checks pass.
