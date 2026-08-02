# AVAL Svelte Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-quality `@pixel-point/aval-svelte` package with React-parity semantics, a shared framework adapter core, and a verified Grass Rabbit Svelte example.

**Architecture:** Move codec-option normalization and the one-host attachment/preparation state machine from the React package into focused framework-neutral modules behind `@pixel-point/aval-element/adapter`. The subpath exposes narrow opaque factories and contracts; test seams and implementation classes stay internal. React keeps its public API but consumes that canonical core. Svelte exposes `createAval(() => options)`, a read-only controller store, and an `AvalComponent` that renders reactive inert custom-element markup and activates the shared binding only on the client.

**Tech Stack:** TypeScript 7, Svelte 5.56.8, `@sveltejs/package` 2.5.8, `@sveltejs/vite-plugin-svelte` 7.2.0, `svelte-check` 4.7.4, Vite 8, Vitest 4, Playwright 1.61, API Extractor.

---

## File map

- `packages/element/src/adapter-options.ts`: shared source/options normalization.
- `packages/element/src/adapter-binding.ts`: shared attachment, semantic status, callbacks, commands, and readiness operation.
- `packages/element/src/adapter.ts`: narrow framework-infrastructure subpath entry.
- `packages/element/test/adapter-options.test.ts`: normalization contract.
- `packages/element/test/adapter-binding.test.ts`: lifecycle state-machine contract.
- `packages/react/src/use-aval.tsx`: React-only rendering, effects, and ref resolution.
- `packages/react/src/types.ts`: public aliases/extensions over the shared contracts.
- `packages/svelte/src/controller.ts`: Svelte readable controller and private controller-to-binding ownership record.
- `packages/svelte/src/AvalComponent.svelte`: Svelte rendering and committed lifecycle effects.
- `packages/svelte/src/index.ts`: public Svelte-aware exports.
- `packages/svelte/test/*`: public typing, SSR, and controller tests.
- `scripts/release/release-set-model.mjs`: canonical Svelte package/build contract.
- `scripts/release/fresh-public-build.mjs`: reviewed `svelte-package` fresh build and exact output provenance.
- `scripts/release/build-packages.mjs`, `scripts/release/inspect-tarball.mjs`: build-kind-derived allowed distribution files.
- `examples/grass-rabbit-svelte/*`: dedicated public-package consumer.
- `playwright.grass-rabbit-svelte.config.ts`, `tests/grass-rabbit-svelte/*`: real browser proof.
- Existing release, certification, docs, security, consumer, workspace, and lock files: add the seventh public package without package-name branches.

### Task 1: Extract canonical adapter options

**Files:**
- Create: `packages/element/src/adapter-options.ts`
- Create: `packages/element/test/adapter-options.test.ts`

- [ ] **Step 1: Write the failing normalization tests**

Cover fixed AV1/VP9/H.265/H.264 ordering, at-least-one runtime validation,
unknown/symbol/empty/descriptor rejection, boolean defaults, callback separation,
pass-through element enums, stable source keys, and semantic equality.

```ts
expect(createAvalAdapterConfiguration({
  sources: { h264: "/h264.avl", av1: "/av1.avl" }
}).render.sources).toEqual([
  { codec: "av1", src: "/av1.avl" },
  { codec: "h264", src: "/h264.avl" }
]);
```

- [ ] **Step 2: Run the focused tests and confirm the missing module failure**

Run: `npm run test:unit -- packages/element/test/adapter-options.test.ts`

Expected: FAIL because `adapter-options.ts` does not exist.

- [ ] **Step 3: Implement the shared option model**

Define `AvalSources`, `AvalAdapterOptions`, `AvalAdapterCallbacks`,
`NormalizedAvalSource`, `NormalizedAvalRenderOptions`, and
`AvalAdapterConfiguration`. The module exports these internally testable
functions; only the configuration factory is re-exported by the adapter subpath
in Task 2:

```ts
export function normalizeAvalSources(
  sources: AvalSources
): readonly Readonly<NormalizedAvalSource>[];

export function createAvalAdapterConfiguration(
  options: Readonly<AvalAdapterOptions>
): Readonly<AvalAdapterConfiguration>;

export function sameAvalRenderOptions(
  left: Readonly<NormalizedAvalRenderOptions>,
  right: Readonly<NormalizedAvalRenderOptions>
): boolean;
```

Keep validation limited to the adapter-owned source shape and booleans. Reuse
`SOURCE_CODEC_PRIORITY`; do not duplicate element enum policy.

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:unit -- packages/element/test/adapter-options.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/element/src/adapter-options.ts packages/element/test/adapter-options.test.ts
git commit -m "refactor: centralize framework adapter options"
```

### Task 2: Extract the binding and migrate React atomically

**Files:**
- Create: `packages/element/src/adapter-binding.ts`
- Create: `packages/element/src/adapter.ts`
- Create: `packages/element/test/adapter-binding.test.ts`
- Modify: `packages/element/package.json`
- Modify: `packages/element/tsconfig.release.json`
- Modify: `scripts/release/release-set-model.mjs`
- Modify: `scripts/release/release-set-model.d.mts`
- Modify: `packages/react/src/types.ts`
- Modify: `packages/react/src/use-aval.tsx`
- Modify: `packages/react/src/ssr.test.tsx`
- Modify: `packages/react/src/public-api.compile.tsx`
- Delete: `packages/react/src/aval-binding.ts`
- Delete: `packages/react/src/aval-binding.test.ts`
- Delete: `packages/react/src/sources.ts`
- Delete: `packages/react/src/sources.test.ts`

- [ ] **Step 1: Move and generalize the existing binding tests**

Preserve the current fake element port and verify pre-mount commands, semantic
option publication, listener-before-upgrade ordering, atomic close, stale ready
suppression, target replacement, one-host enforcement, callback replacement,
and snapshot identity gating. Tests import the internal implementation by
relative path, so environment injection never enters the public subpath.

```ts
const binding = new AvalAdapterBindingImplementation(configuration, {
  upgrade(node) {
    expect(node.nativeListenerCount).toBe(5);
    return node;
  }
});
```

- [ ] **Step 2: Run the focused binding tests against the missing implementation**

Run: `npm run test:unit -- packages/element/test/adapter-binding.test.ts`

Expected: FAIL because the implementation is not defined.

- [ ] **Step 3: Implement the internal state machine and narrow public entry**

Adapt the reviewed React implementation with generic names and an
`Element | null | undefined` binding target. Keep one attachment record and one
preparation record. `adapter.ts` exports only opaque contracts and factories:

```ts
export interface AvalAdapterBinding {
  readonly getStatus: () => Readonly<AvalAdapterStatus>;
  readonly getServerStatus: () => Readonly<AvalAdapterStatus>;
  readonly getRenderOptions: () => Readonly<AvalAdapterRenderOptions>;
  readonly subscribeStatus: (listener: () => void) => () => void;
  readonly subscribeOptions: (listener: () => void) => () => void;
  commit(configuration: Readonly<AvalAdapterConfiguration>): void;
  readonly attach: (node: HTMLElement | null) => void;
  finalizeBindingTarget(target: Element | null | undefined): void;
  beginReadyPreparation(): () => void;
  // prepare/setState/send/readyFor/play/pause/getDiagnostics
}

export function createAvalAdapterBinding(
  configuration: Readonly<AvalAdapterConfiguration>
): AvalAdapterBinding;
```

The subpath also exports `createAvalAdapterConfiguration` and the source,
options, configuration, render, status, and callback types. It does not export
the implementation class, binding node/element ports, environment injection, or
render equality. Attach five native listeners before `defineAvalElement()`.
Teardown never calls `dispose()`.

- [ ] **Step 4: Add the reviewed `/adapter` element export**

Add `./adapter` to the element package exports and release entry model, and add
`src/adapter.ts` to the element release build. The end-user root remains
unchanged.

- [ ] **Step 5: Migrate React in the same working change**

Keep `AvalBindingTarget = Element | RefObject<Element | null> | null`. Import
the two factories and public contracts from `@pixel-point/aval-element/adapter`.
Retain the stable component closure, `useSyncExternalStore`, layout-effect
commit, source markup, ARIA conversion, and `AvalReactInstance` shape.

```ts
function resolveBindingTarget(target: AvalBindingTarget | undefined) {
  if (target == null) return null;
  return "current" in target ? target.current : target;
}
```

Only after React compiles against the subpath, delete its duplicate binding and
source modules.

- [ ] **Step 6: Run shared-core and React checks before committing**

Run:

```bash
npm run test:unit -- packages/element/test/adapter-options.test.ts packages/element/test/adapter-binding.test.ts packages/react
npm run build -w @pixel-point/aval-element
npm run typecheck -w @pixel-point/aval-react
npm run build -w @pixel-point/aval-react
```

Expected: all PASS and React SSR markup remains byte-for-byte unchanged.

- [ ] **Step 7: Commit the atomic extraction/migration**

```bash
git add packages/element packages/react scripts/release/release-set-model.mjs scripts/release/release-set-model.d.mts
git commit -m "refactor: share aval framework binding"
```

### Task 3: Add the Svelte controller and component package

**Files:**
- Create: `packages/svelte/src/controller.ts`
- Create: `packages/svelte/src/types.ts`
- Create: `packages/svelte/src/AvalComponent.svelte`
- Create: `packages/svelte/src/index.ts`
- Create: `packages/svelte/test/controller.test.ts`
- Create: `packages/svelte/test/ssr.test.ts`
- Create: `packages/svelte/test/PublicContract.svelte`
- Create: `packages/svelte/package.json`
- Create: `packages/svelte/tsconfig.json`
- Create: `packages/svelte/svelte.config.js`
- Create: `packages/svelte/api-extractor.json`
- Create: `packages/svelte/README.md`
- Create: `packages/svelte/LICENSE`
- Create: `packages/svelte/THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: Write controller and public-contract failures**

Test immediate Svelte-store subscription, stable status identity, command
delegation, invalid controller rejection, one controller per host, required
option getter, at-least-one source typing, and no child snippet prop.

```svelte
<script lang="ts">
  import { AvalComponent, createAval } from "@pixel-point/aval-svelte";
  const aval = createAval(() => ({ sources: { h264: "/motion.avl" } }));
</script>
<AvalComponent {aval} width={160} height={90} aria-label="Motion" />
```

- [ ] **Step 2: Implement the controller record**

`createAval(readOptions)` normalizes once, calls `createAvalAdapterBinding`, and
returns a frozen command object implementing Svelte's `Readable` contract.
A module-private `WeakMap<AvalSvelteInstance, ControllerRecord>` lets the
component retrieve the binding and option getter without leaking lifecycle
methods into the public instance.

```ts
export interface AvalSvelteInstance extends Readable<Readonly<AvalSvelteStatus>> {
  prepare(options?: Readonly<AvalPrepareOptions>): Promise<RuntimeReadinessResult>;
  setState(name: string): Promise<void>;
  send(event: string): boolean;
  readyFor(state: string): boolean;
  play(): Promise<void>;
  pause(): void;
  getDiagnostics(options?: Readonly<{ trace?: boolean }>): Readonly<AvalDiagnostics> | null;
}
```

- [ ] **Step 3: Implement `AvalComponent.svelte`**

Use runes-mode props. Derive normalized options by invoking the controller's
getter inside component reactivity. Render one `<aval-player>` with normalized
attributes and ordered source children. A host action attaches the binding and
detaches on destroy. Effects commit options, resolve `bindTo`, and start/cancel
readiness preparation keyed by `sourceKey`.

- [ ] **Step 4: Add deterministic SSR coverage**

Use `render` from `svelte/server` through the Svelte-aware Vitest transform.
Assert exact inert markup with ordered sources, `autoplay="manual"`,
`bindings="none"`, dimensions, and ARIA values.

- [ ] **Step 5: Add package metadata and official build**

Use exact `@pixel-point/aval-element` dependency, `svelte: ^5.0.0` peer, and
exact dev pins. The component-bearing root export has only `types` and `svelte`
conditions; it does not claim plain Node loading for raw `.svelte` output.
Build with:

```json
"build": "svelte-package -i src -o dist --tsconfig tsconfig.json"
```

- [ ] **Step 6: Install and run focused Svelte checks**

Run:

```bash
npm install
npm run typecheck -w @pixel-point/aval-svelte
npm run build -w @pixel-point/aval-svelte
npm run test:unit -- packages/svelte
```

Expected: package output includes `index.js`, `index.d.ts`,
`AvalComponent.svelte`, and `AvalComponent.svelte.d.ts`; all checks PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/svelte package.json package-lock.json vitest.m9.config.ts
git commit -m "feat: add Aval Svelte package"
```

### Task 4: Teach the release provenance model about Svelte packages

**Files:**
- Modify: `scripts/release/release-set-model.mjs`
- Modify: `scripts/release/release-set-model.d.mts`
- Modify: `scripts/release/fresh-public-build.mjs`
- Modify: `scripts/release/build-packages.mjs`
- Modify: `scripts/release/inspect-tarball.mjs`
- Modify: `tests/package/fresh-public-build.test.ts`
- Modify: `tests/package/release-set.test.ts`

- [ ] **Step 1: Add failing generic build-kind tests**

Assert that TypeScript specs retain current output rules, the Svelte spec has a
`svelte-package` build kind, `.svelte` is accepted only when the owning spec
declares it, missing/unexpected generated files fail closed, and no package-name
conditional is introduced.

- [ ] **Step 2: Model build kinds explicitly**

Use a discriminated union:

```ts
type ReleaseBuildConfig = TypeScriptBuildConfig | SveltePackageBuildConfig;
```

Add the Svelte package with element dependency, Svelte peer, root export
conditions, production entry, and exact source/output rules. Make build-info
required only for TypeScript builds. Production-entry resolution selects the
runtime condition declared by the build kind (`import` for TypeScript and
`svelte` for Svelte packages) instead of hard-coding `.import`.

- [ ] **Step 3: Add reviewed fresh Svelte packaging**

Run `@sveltejs/package` from the repository installation against
`packages/svelte/src` with a temporary output. Enumerate production `.ts` and
`.svelte` inputs, derive the exact expected JS/declaration/component outputs,
and reject extra, test, map, or source-leak output before atomic installation.
Replace the TypeScript runner's root-only paths map with one shared staged-path
generator derived from every reviewed production entry. It maps both package
roots and subpaths, including
`@pixel-point/aval-element/adapter -> <staged element>/adapter.d.ts`. Use that
same map in a temporary Svelte tsconfig passed to `svelte-package`. Add
regressions that remove/stale the checked-in element dist and prove both the
React TypeScript build and Svelte build use staged root and adapter declarations.

- [ ] **Step 4: Derive tar/build allowlists from the build spec**

Replace global `js|d.ts` assumptions with a small helper that permits the exact
extensions declared by the package's build kind. Keep all existing path,
symlink, executable, hidden-file, and archive bounds checks.

- [ ] **Step 5: Run release-focused tests**

Run:

```bash
npm run test:unit -- tests/package/fresh-public-build.test.ts tests/package/release-set.test.ts
npm run build:public-packages
```

Expected: PASS; all seven dist directories are rebuilt through reviewed paths.

- [ ] **Step 6: Commit**

```bash
git add scripts/release tests/package
git commit -m "build: support reviewed Svelte package output"
```

### Task 5: Integrate the seventh public package generically

**Files:**
- Modify: `config/release/release-policy.json`
- Modify: `config/release/api-classification.json`
- Modify: `config/release/license-policy.json`
- Modify: `packages/certification/src/compatibility.ts`
- Modify: `packages/certification/test/compatibility.test.ts`
- Modify: `packages/certification/test/release-manifest.test.ts`
- Modify: `packages/certification/test/publication-ledger.test.ts`
- Modify: `tests/package/publication-metadata.test.ts`
- Modify: `tests/package/public-entry-authority.test.ts`
- Modify: `tests/package/verify-registry.test.ts`
- Modify: `tests/security/supply-chain.test.ts`
- Modify: `scripts/release/test-consumers.mjs`
- Modify: `scripts/release/test-packed-dev.mjs`
- Modify: `scripts/docs/test-examples.mjs`
- Modify: `tests/consumers/*`
- Create: `etc/api/svelte.api.md`

- [ ] **Step 1: Add failing seven-package policy expectations**

Update exact-set tests to include `@pixel-point/aval-svelte` and its reviewed
Svelte peer contract. Add a negative test for peer drift.

- [ ] **Step 2: Update canonical release/certification/security contracts**

Add the package through existing maps and derived loops. Do not add scattered
`if (name === "@pixel-point/aval-svelte")` branches.

- [ ] **Step 3: Generalize packed peer closure preparation**

Replace React-only peer archive variables with one manifest-derived set of
installed external peers from `RELEASE_PACKAGE_SPECS`. Pack each closure once
and reuse it for docs, consumer, and packed-dev installs.

- [ ] **Step 4: Add Svelte-aware consumer coverage and API extraction**

Add a dedicated Svelte/Vite consumer fixture that imports the component-bearing
root through its `svelte` condition, verifies public types, renders it, and runs
an SSR compile. Plain Node ESM fixtures do not import this raw-component root.
Generate the API report with `npm run api:report`.

- [ ] **Step 5: Run release and consumer checks**

Run:

```bash
npm run test:unit -- packages/certification tests/package tests/security
npm run api:check
npm run test:consumers
npm run test:packed
```

Expected: PASS with seven exact release artifacts and no peer-resolution network access.

- [ ] **Step 6: Commit**

```bash
git add config packages/certification scripts tests etc/api/svelte.api.md
git commit -m "chore: integrate Svelte into release policy"
```

### Task 6: Build the dedicated Grass Rabbit Svelte example

**Files:**
- Create: `examples/grass-rabbit-svelte/.gitignore`
- Create: `examples/grass-rabbit-svelte/README.md`
- Create: `examples/grass-rabbit-svelte/index.html`
- Create: `examples/grass-rabbit-svelte/package.json`
- Create: `examples/grass-rabbit-svelte/svelte.config.js`
- Create: `examples/grass-rabbit-svelte/tsconfig.json`
- Create: `examples/grass-rabbit-svelte/vite.config.ts`
- Create: `examples/grass-rabbit-svelte/scripts/prepare-assets.mjs`
- Create: `examples/grass-rabbit-svelte/src/App.svelte`
- Create: `examples/grass-rabbit-svelte/src/main.ts`
- Create: `examples/grass-rabbit-svelte/src/styles.css`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Scaffold the explicit Vite workspace**

Pin Svelte 5.56.8, plugin 7.2.0, svelte-check 4.7.4, Vite 8.1.4, and TypeScript
7.0.2. Add `predev`, `prebuild`, `dev`, `build`, and `typecheck` scripts. Copy
canonical `.avl` and hotspot assets from `examples/grass-rabbit/public`.

- [ ] **Step 2: Implement the public-package-only demo**

Create one controller with `createAval(() => ({ sources, state, autoplay,
autoBind, onError }))`, render `<AvalComponent {aval}>`, show `$aval` readiness
and visual state, exercise authored hover/focus bindings, and render fatal
fallback as a sibling owned by the app.

- [ ] **Step 3: Add root workspace/build/dev scripts**

Add the example to the explicit workspace array, root build chain,
`grass-rabbit-svelte`, and `test:grass-rabbit-svelte` commands.

- [ ] **Step 4: Verify the clean example**

Run:

```bash
npm run typecheck -w @pixel-point/aval-grass-rabbit-svelte-example
npm run build -w @pixel-point/aval-grass-rabbit-svelte-example
```

Expected: PASS with a production `dist/index.html` and copied assets.

- [ ] **Step 5: Commit**

```bash
git add examples/grass-rabbit-svelte package.json package-lock.json
git commit -m "feat: add Grass Rabbit Svelte example"
```

### Task 7: Verify the example in real browsers

**Files:**
- Create: `playwright.grass-rabbit-svelte.config.ts`
- Create: `tests/grass-rabbit-svelte/grass-rabbit-svelte.spec.ts`
- Modify: `scripts/browser-compatibility/test/browser-script-contract.test.ts`

- [ ] **Step 1: Port the behavior-level browser expectations**

Across Chromium, Firefox, and WebKit, verify ordered sources, one persistent
host, `bindings="auto"`, interactive readiness, store-driven status text,
focus/hover authored transitions, accessibility attributes, reduced motion,
and absence of page/console errors.

- [ ] **Step 2: Run the browser test and fix only product defects**

Run: `npm run test:grass-rabbit-svelte`

Expected: PASS in all configured browsers.

- [ ] **Step 3: Commit**

```bash
git add playwright.grass-rabbit-svelte.config.ts tests/grass-rabbit-svelte scripts/browser-compatibility
git commit -m "test: verify Svelte example playback"
```

### Task 8: Documentation, final thermo review, and full verification

**Files:**
- Modify: `README.md`
- Create: `docs/element/svelte.md`
- Modify: `docs/quick-start.md`
- Modify: `scripts/docs/check-docs.mjs`
- Modify: `tests/docs/examples.test.ts`

- [ ] **Step 1: Document the final public contract**

Explain the getter, `$aval` store access, commands, reactive sources/state,
`bindTo`, SSR, lifecycle ownership, source order, errors, and fallback policy.
Link the dedicated example and use only public root imports.

- [ ] **Step 2: Extend docs guards generically**

Scan `.svelte` public boundaries, include the new docs/example, and replace the
current fixed example-count assertion with a count derived from the canonical
example matrix already assembled by the test.

- [ ] **Step 3: Run the thermo-nuclear review against the complete diff**

Audit for duplicate lifecycle policy, package-name release branches, thin
wrappers, cast-heavy boundaries, oversized files, source/output loopholes,
sequential peer packing, and unnecessary optionality. Apply every valid finding.

- [ ] **Step 4: Run focused checks after review fixes**

Run:

```bash
npm run docs:check
npm run api:check
npm run typecheck
npm run test:unit
npm run build
npm run test:grass-rabbit-svelte
git diff --check
```

Expected: all PASS and the worktree contains only intentional changes.

- [ ] **Step 5: Run high-cost release checks**

Run:

```bash
npm run test:consumers
npm run test:packed
npm run licenses:check
npm run sbom:generate
```

Expected: all PASS; if SBOM generation changes the canonical artifact, validate
and include that intentional generated update.

- [ ] **Step 6: Commit the final reviewed result**

```bash
git add README.md docs scripts tests packages examples package.json package-lock.json config etc
git commit -m "docs: document Aval Svelte integration"
```
