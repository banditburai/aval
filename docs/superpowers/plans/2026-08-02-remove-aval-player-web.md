# Remove AVAL Player Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `@pixel-point/aval-player-web` completely, make `@pixel-point/aval-element` the sole browser runtime, migrate its two real consumers, reduce the synchronized release to six packages, and leave no compatibility code or live package reference.

**Architecture:** Certification consumes element-owned decoder capacity and public element diagnostics. The codec comparison example uses one example-local advisory `VideoDecoder.isConfigSupported()` boundary while actual `<aval-player>` preparation remains authoritative. The compiler development server exposes element, format, and graph modules only. Release, schema, consumer, documentation, and workspace authorities describe the exact six-package product.

**Tech Stack:** TypeScript 7, JavaScript ESM, WebCodecs, Custom Elements, Vitest 4, Playwright 1.61, Vite 8, API Extractor, npm workspaces.

---

## Scope and deletion rule

Delete all tracked files under `packages/player-web` and `etc/api/player-web.api.md`. Do not keep a private package, placeholder README, deprecated export, alias, copied utility folder, or package-name tombstone. Dated `docs/superpowers/**` and `docs/evidence/**` are historical records and are excluded from the live-reference cleanup.

### Task 1: Capture and fix certification resource admission

**Files:**
- Create: `tests/browser/certification-resource-soak.spec.ts`
- Modify: `apps/playground/src/certification/resource-soak.ts`
- Modify: `apps/playground/src/certification/app.ts`
- Modify: `apps/playground/package.json`
- Modify: `apps/playground/vite.config.ts`

- [ ] **Step 1: Add the failing three-element soak test**

Open `/certification.html`, call `window.avalCertification.runPublicHarness()` with minimal functional counts and `soakPlayers: 3`, and assert:

```text
the call settles before the test timeout;
report.soak.status is "passed";
all three terminal counter records are zero;
report.soak.failures is empty;
reported capacity matches ELEMENT_DECODER_CAPACITY.
```

Run:

```sh
npx playwright test tests/browser/certification-resource-soak.spec.ts --project=chromium
```

Expected before implementation: FAIL or time out because two connected elements prepare within the same `Promise.all` while one element lease owns both page decoder workers.

- [ ] **Step 2: Replace stale player-web policy with element capacity**

Import `ELEMENT_DECODER_CAPACITY` from `@pixel-point/aval-element`. Delete imports and uses of `DEFAULT_MAXIMUM_DECODER_LEASES`, `DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES`, `DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES`, and `createRuntimePageResourcePolicy`.

Prepare one connected autoplay element per soak batch. Report an immutable `runtimeCapacity` containing:

```ts
{
  preparationBatchSize: 1,
  decoderWorkersPerActiveElement: ELEMENT_DECODER_CAPACITY.workerCount,
  decoderRingSize: ELEMENT_DECODER_CAPACITY.ringSize,
  decodedSurfacesPerActiveElement:
    ELEMENT_DECODER_CAPACITY.workerCount * ELEMENT_DECODER_CAPACITY.ringSize
}
```

Use the same capacity model in `browserCapabilities()` and `emptySoak()`. Continue measuring page bytes, active slots, queued tickets, and terminal settlement through public `AvalDiagnostics`; do not transplant the old byte-limit policy into element.

- [ ] **Step 3: Remove playground package/alias dependencies**

Remove `@pixel-point/aval-player-web` from `apps/playground/package.json` and its Vite aliases. Keep the playground on public element entry points.

- [ ] **Step 4: Verify certification admission**

```sh
npm run typecheck -w @pixel-point/aval-playground
npx playwright test tests/browser/certification-resource-soak.spec.ts --project=chromium
```

Expected: PASS with three sequentially admitted players and zero terminal counters.

- [ ] **Step 5: Commit certification migration**

```sh
git add tests/browser/certification-resource-soak.spec.ts apps/playground
git commit -m "refactor(certification): use element resource admission"
```

### Task 2: Replace the codec-demo worker probe

**Files:**
- Create: `examples/grass-rabbit-codecs/video-decoder-support.js`
- Create: `tests/grass-rabbit-codecs/video-decoder-support.test.ts`
- Modify: `examples/grass-rabbit-codecs/codec-demo-controller.js`
- Modify: `examples/grass-rabbit-codecs/package.json`

- [ ] **Step 1: Write the failing platform-boundary tests**

Test that the helper returns false when `VideoDecoder.isConfigSupported` is unavailable, passes the exact config through, returns only `result.supported === true`, and propagates probe rejection so the controller can mark current and remaining codecs unavailable.

```sh
npx vitest run --config vitest.m9.config.ts tests/grass-rabbit-codecs/video-decoder-support.test.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 2: Implement one direct WebCodecs helper**

```js
export async function probeVideoDecoderSupport(config) {
  const decoder = globalThis.VideoDecoder;
  if (
    typeof decoder !== "function" ||
    typeof decoder.isConfigSupported !== "function"
  ) return false;
  const result = await decoder.isConfigSupported(config);
  return result.supported === true;
}
```

Do not add a worker owner, lifecycle wrapper, support-probe framework, or cache.

- [ ] **Step 3: Simplify probeAllCodecs**

Remove `createSourceSupportProbe` and worker creation/disposal. Call the local helper sequentially with `exactProbeConfig(asset.codecString)`. Preserve the existing supported/unsupported/unavailable result mapping and leave actual element preparation as the playback authority.

- [ ] **Step 4: Remove the example package dependency and verify**

```sh
npx vitest run --config vitest.m9.config.ts tests/grass-rabbit-codecs/video-decoder-support.test.ts tests/grass-rabbit-codecs/codec-demo-model.test.ts
npm run build -w @pixel-point/aval-grass-rabbit-codecs-example
npm run test:grass-rabbit-codecs
```

Expected: unit tests and Chromium/Firefox/WebKit codec-demo projects pass.

- [ ] **Step 5: Run the first thermo-nuclear review and commit**

Invoke `thermo-nuclear-code-quality-review` on Tasks 1–2. Fix valid findings involving copied player-web policy, obsolete byte limits, compatibility layers, a generic probe framework, new scattered conditions, or unjustified growth. Rerun Steps 1–4, then commit:

```sh
git add examples/grass-rabbit-codecs tests/grass-rabbit-codecs
git commit -m "refactor(example): use direct decoder support probe"
```

### Task 3: Remove player-web from the compiler development server

**Files:**
- Modify: `packages/compiler/test/dev-server.test.ts`
- Modify: `packages/compiler/package.json`
- Modify: `packages/compiler/src/commands/dev-package-modules.ts`
- Modify: `packages/compiler/src/commands/dev-server-router.ts`
- Modify: `packages/compiler/src/commands/dev-worker-entries.json`

- [ ] **Step 1: Change tests to the three-package dev-module contract**

Require only `element`, `format`, and `graph`. Prove an element module's format import rewrites to the opaque session URL, `modules/element/decoder-worker.js?no-inline` is the sole strict-CSP worker entry, any `modules/player-web/...` request returns 404, isolated nested layouts contain only the three packages, and the compiler manifest has no player-web dependency.

- [ ] **Step 2: Run the compiler test against the old router**

```sh
npx vitest run --config vitest.m9.config.ts packages/compiler/test/dev-server.test.ts
```

Expected: FAIL because the old module and worker remain admitted.

- [ ] **Step 3: Narrow module serving and worker entries**

Remove `player-web` from `DEV_MODULE_PACKAGES`, the `DevModulePackage` union, import-rewrite patterns, route admission, and `dev-worker-entries.json`. Remove `@pixel-point/aval-player-web` from compiler dependencies.

- [ ] **Step 4: Verify compiler behavior**

```sh
npm run typecheck -w @pixel-point/aval-compiler
npm run build -w @pixel-point/aval-element
npm run build -w @pixel-point/aval-compiler
npx vitest run --config vitest.m9.config.ts packages/compiler/test/dev-server.test.ts tests/package/fresh-public-build.test.ts
```

Expected: PASS; element decoder worker serving and import rewriting remain functional.

- [ ] **Step 5: Commit compiler migration**

```sh
git add packages/compiler
git commit -m "refactor(compiler): remove player web module serving"
```

### Task 4: Reduce release authorities from seven packages to six

**Files:**
- Modify: `packages/certification/test/compatibility.test.ts`
- Modify: `packages/certification/test/release-policy.test.ts`
- Modify: `packages/certification/test/publication-ledger.test.ts`
- Create: `packages/certification/test/publication-ledger-schema.test.ts`
- Modify: `tests/package/release-set.test.ts`
- Modify: `tests/package/fresh-public-build.test.ts`
- Modify: `tests/package/publication-metadata.test.ts`
- Modify: `packages/certification/src/compatibility.ts`
- Modify: `config/release/release-policy.json`
- Modify: `config/release/api-classification.json`
- Modify: `schemas/publication-ledger.schema.json`
- Modify: `scripts/release/release-set-model.mjs`
- Modify: `scripts/release/release-set-model.d.mts`
- Modify: `package.json`

- [ ] **Step 1: Update tests to the exact canonical release set**

Use this order everywhere:

```text
@pixel-point/aval-graph
@pixel-point/aval-format
@pixel-point/aval-element
@pixel-point/aval-compiler
@pixel-point/aval-react
@pixel-point/aval-svelte
```

Rename seven-package assertions, change exact counts to six, remove player-web archive/worker fixtures, inject the atomic-install rollback failure at compiler to retain a mid-install rollback, and use `graph, format, element, compiler, react, svelte` in publication metadata tests.

- [ ] **Step 2: Add schema-to-authority parity coverage**

In `publication-ledger-schema.test.ts`, assert the schema package enum exactly equals `PUBLIC_RELEASE_PACKAGES`. This removes player-web and repairs existing React/Svelte schema drift in one canonical assertion.

- [ ] **Step 3: Run the release tests against old authorities**

```sh
npx vitest run --config vitest.m9.config.ts packages/certification/test/compatibility.test.ts packages/certification/test/release-policy.test.ts packages/certification/test/publication-ledger.test.ts packages/certification/test/publication-ledger-schema.test.ts tests/package/release-set.test.ts tests/package/fresh-public-build.test.ts tests/package/publication-metadata.test.ts tests/package/package-contents.test.ts
```

Expected: FAIL until every authority uses the six-package set.

- [ ] **Step 4: Update all canonical release authorities**

Delete the player-web release contract/spec/type union and remove it from compiler dependencies. Update policy, API classification, ledger schema, release-set model and declarations, and `build:public-packages` to the exact ordered set above.

- [ ] **Step 5: Verify and commit release migration**

```sh
npx vitest run --config vitest.m9.config.ts packages/certification/test/compatibility.test.ts packages/certification/test/release-policy.test.ts packages/certification/test/publication-ledger.test.ts packages/certification/test/publication-ledger-schema.test.ts tests/package/release-set.test.ts tests/package/fresh-public-build.test.ts tests/package/publication-metadata.test.ts tests/package/package-contents.test.ts
```

Expected: PASS.

```sh
git add packages/certification config/release schemas/publication-ledger.schema.json scripts/release/release-set-model.mjs scripts/release/release-set-model.d.mts tests/package package.json
git commit -m "refactor(release): publish six canonical packages"
```

### Task 5: Add a permanent sole-runtime architecture guard

**Files:**
- Create: `scripts/architecture/check-browser-runtime-boundaries.mjs`
- Create: `tests/architecture/browser-runtime-boundaries.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing repository guard**

Build removed strings from fragments so the guard does not match itself:

```ts
const removedPackage = ["@pixel-point/aval", "player-web"].join("-");
const removedDirectory = ["packages", "player-web"].join("/");
```

Assert the removed directory and API report do not exist and no live source, config, package metadata, current documentation, example, release, workflow, schema, or consumer file contains either identity. Scan `.github`, `apps`, `config`, `examples`, `fixtures`, `packages`, `schemas`, `scripts`, `tests`, `etc/api`, current docs, and root manifests/configuration. Exclude `.git`, `node_modules`, build output, artifacts, dated `docs/superpowers`, dated `docs/evidence`, and the guard itself.

- [ ] **Step 2: Run the guard against the current tree**

```sh
npx vitest run --config vitest.m9.config.ts tests/architecture/browser-runtime-boundaries.test.ts
```

Expected: FAIL first because the checker is not implemented.

- [ ] **Step 3: Implement the deterministic scanner**

Export a repository-root-relative check from
`scripts/architecture/check-browser-runtime-boundaries.mjs`, call it from the
test, and add root script `architecture:check`. The checker reports every
matching live path in sorted order and throws once with the complete list.

Run:

```sh
npx vitest run --config vitest.m9.config.ts tests/architecture/browser-runtime-boundaries.test.ts
```

Expected: FAIL and list the package plus remaining live references.

- [ ] **Step 4: Keep the guard red until the package deletion is complete**

Do not weaken the scan or add per-file exceptions to make it pass. Historical directory exclusions above are the only intentional exclusions.

### Task 6: Delete the package and finish workspace migration

**Files:**
- Delete: `packages/player-web/**`
- Delete: `etc/api/player-web.api.md`
- Modify: `tsconfig.json`
- Modify: `vitest.m9.config.ts`
- Modify: `examples/grass-rabbit/package.json`
- Modify: `tests/consumers/node-esm/index.mjs`
- Modify: `tests/consumers/typescript-nodenext/index.ts`
- Modify: `README.md`
- Modify: `docs/releases/1.0.0.md`
- Modify: `docs/releases/publication-runbook.md`
- Modify: `package-lock.json` through npm lock regeneration

- [ ] **Step 1: Delete the full tracked implementation with apply_patch**

Use batched `apply_patch` delete operations for all tracked files under `packages/player-web` and for `etc/api/player-web.api.md`. Do not copy any implementation elsewhere unless an earlier task named the exact replacement and test.

- [ ] **Step 2: Remove workspace, test, build, example, and consumer references**

Remove the TS project reference and Vitest aliases. Remove player-web from
grass-rabbit's Vercel build. Remove the Node ESM player-module smoke and
`IntegratedPlayer` from the NodeNext consumer. Keep the consumer's negative
source-private import proof by constructing a real element-private specifier
from `"@pixel-point/aval-element"` and `"src/page-resources.js"` joined with
`"/"`; do not place a literal source-private package import in documentation.

- [ ] **Step 3: Update current product and publication documentation**

Describe element as the sole browser loader/decoder/scheduler/renderer/page-resource owner. Document the exact six packages and their publication order in the 1.0 release and runbook. Leave historical dated design/evidence files unchanged.

- [ ] **Step 4: Regenerate the lockfile mechanically**

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
```

Expected: the workspace package and every dependency edge to it disappear from `package-lock.json`.

- [ ] **Step 5: Run the architecture guard and exact scans**

```sh
npx vitest run --config vitest.m9.config.ts tests/architecture/browser-runtime-boundaries.test.ts
rg -n --hidden --glob '!node_modules/**' --glob '!**/dist/**' --glob '!docs/superpowers/**' --glob '!docs/evidence/**' '(@pixel-point/aval-player-web|packages/player-web|player-web)' .
git ls-files packages/player-web
```

Expected: the guard passes and both searches print nothing.

- [ ] **Step 6: Run the second thermo-nuclear review**

Invoke `thermo-nuclear-code-quality-review` on the complete deletion diff. Fix valid findings involving a tombstone, copied legacy, stale identity, release/schema divergence, new pass-through abstractions, random compatibility branches, casts, or touched giant files. Rerun the focused gate for every fix.

- [ ] **Step 7: Verify the removal phase**

```sh
npm run typecheck
npm run test:unit
npm run build:public-packages
npm run api:check
npm run test:consumers
npm run test:grass-rabbit-codecs
npm run test:playground
```

Expected: all commands pass and no built artifact/package archive identifies player-web.

- [ ] **Step 8: Commit clean deletion**

```sh
git add -A packages/player-web etc/api/player-web.api.md package-lock.json tsconfig.json vitest.m9.config.ts examples/grass-rabbit/package.json tests/consumers README.md docs/releases scripts/architecture/check-browser-runtime-boundaries.mjs tests/architecture/browser-runtime-boundaries.test.ts package.json
git commit -m "refactor: remove parallel browser runtime"
```

### Task 7: Prove the six-package release and examples

**Files:**
- Modify only if a valid defect appears in files already migrated above.

- [ ] **Step 1: Run workspace and policy checks**

```sh
npm run typecheck
npm run test:unit
npm run test:mutation
npm run build
npm run check:generated
npm run api:check
npm run fixtures:verify
npm run fixtures:regeneration-check
npm run docs:check
npm run security:check
npm run licenses:check
```

Expected: every command exits zero.

- [ ] **Step 2: Run browser and example suites**

```sh
npm run test:browser
npm run test:browser:reference
npm run test:browser:production
npm run test:playground
npm run test:grass-rabbit
npm run test:grass-rabbit-react
npm run test:grass-rabbit-svelte
npm run test:grass-rabbit-codecs
npm run test:kinetic-orb
npm run test:lend-borrow-react
npm run build:vercel -w @pixel-point/aval-grass-rabbit-example
```

Expected: all configured browser engines and example suites pass.

- [ ] **Step 3: Run package, consumer, release, and SBOM proof**

```sh
npm run release:pack
npm run release:inspect-packages
npm run test:consumers
npm run test:examples
npm run test:packed
npm run release:publish-dry-run
npm run release:rollback-drill
npm run sbom:generate
npm run sbom:validate
```

Expected: exactly six release archives, all consumers/examples pass, and generated manifests/SBOMs contain no removed identity.

- [ ] **Step 4: Return to the integration plan**

Complete the actual in-app-browser matrix and final independent thermo-nuclear review in `docs/superpowers/plans/2026-08-02-canonical-browser-runtime-refactor.md`; automated Playwright output does not satisfy that manual verification task.
