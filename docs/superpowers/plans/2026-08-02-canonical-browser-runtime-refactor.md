# Canonical Browser Runtime Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@pixel-point/aval-element` the only browser runtime, delete the unpublished parallel player package, keep React and Svelte as thin adapters, split the two 3,000-line runtime coordinators into cohesive owners, and prove every maintained package and example still works.

**Architecture:** Execute four independently green workstreams in dependency order: remove `@pixel-point/aval-player-web`, narrow the element adapter consumed by React and Svelte, decompose player ownership behind the existing lazy boundary, and decompose custom-element ownership behind the existing public facade. Each workstream has its own detailed plan and thermo-nuclear review gate; this plan owns integration, release, cross-engine, example, and in-app-browser proof.

**Tech Stack:** TypeScript 7, ESM, Web Components, React 19, Svelte 5, Vitest 4, Playwright 1.61, Vite 8, API Extractor, npm workspaces, Node.js 22, Codex in-app Browser.

---

## Workstream plans

- `docs/superpowers/plans/2026-08-02-remove-aval-player-web.md`
- `docs/superpowers/plans/2026-08-02-framework-adapter-boundary.md`
- `docs/superpowers/plans/2026-08-02-player-runtime-decomposition.md`
- `docs/superpowers/plans/2026-08-02-element-runtime-decomposition.md`

### Task 1: Record a green baseline and an invariant ledger

**Files:**
- Create: `docs/evidence/2026-08-02-canonical-browser-runtime-refactor-baseline.md`
- Reference: `docs/superpowers/specs/2026-08-02-canonical-browser-runtime-refactor-design.md`

- [ ] **Step 1: Record the starting revision and production file sizes**

Run:

```sh
git status --short
git rev-parse HEAD
wc -l packages/element/src/player.ts packages/element/src/aval-element.ts packages/element/src/decoder.ts
```

Expected: the approved planning commit is present and the working tree is clean;
`player.ts` and `aval-element.ts` are each above 3,000 lines. Copy the exact
revision, status, and line counts into the baseline evidence file.

- [ ] **Step 2: Run the pre-refactor contract baseline**

Run:

```sh
npm run typecheck
npm run test:unit
npm run build:public-packages
npm run api:check
npm run test:browser
```

Expected: all commands pass before structural changes. Record command, exit status, and test totals in the baseline evidence file. Stop and diagnose any baseline failure before changing production code.

- [ ] **Step 3: Add the lifecycle invariant ledger**

Record these explicit invariants in the evidence file so each extraction can cite them:

```text
lazy player import; listener-before-upgrade; provisional callback order;
candidate deadline nesting; graph preview/commit identity; effect order;
abort suppression; canonical-error priority; idempotent cleanup;
stale-generation rejection; diagnostic identity/caps;
React Strict Mode reuse; Svelte mount/unmount reuse.
```

- [ ] **Step 4: Commit the baseline evidence**

```sh
git add docs/evidence/2026-08-02-canonical-browser-runtime-refactor-baseline.md
git commit -m "test: record browser runtime refactor baseline"
```

### Task 2: Remove the parallel runtime

**Files:**
- Follow: `docs/superpowers/plans/2026-08-02-remove-aval-player-web.md`

- [ ] **Step 1: Execute every checkbox in the removal plan**

Expected: `packages/player-web` is absent; live source, workspace, release, compiler, consumer, current documentation, and example files contain no `player-web` package reference; historical dated evidence remains untouched.

- [ ] **Step 2: Run the first thermo-nuclear review**

Invoke the `thermo-nuclear-code-quality-review` skill against the complete removal diff. Fix every valid P0-P2 finding and rerun the removal plan's focused tests. Do not advance while the codec probe or certification scheduler duplicates element runtime policy.

- [ ] **Step 3: Verify the phase boundary**

```sh
npm run typecheck
npm run test:unit
npm run build:public-packages
npm run api:check
npm run test:consumers
```

Expected: all commands pass and release/consumer models agree on the reduced public package set.

### Task 3: Narrow the framework adapter boundary

**Files:**
- Follow: `docs/superpowers/plans/2026-08-02-framework-adapter-boundary.md`

- [ ] **Step 1: Execute every checkbox in the adapter plan**

Expected: React and Svelte import their canonical option, status, command, and controller contracts from `@pixel-point/aval-element/adapter`; neither framework imports runtime implementation modules; both retain framework-native lifecycle and rendering code.

- [ ] **Step 2: Run the second thermo-nuclear review**

Invoke the strict review on `packages/element/src/adapter*`, `packages/react`, and `packages/svelte`. Fix valid findings, especially repeated forwarding lists, duplicate token policy, diagnostic type leakage, or a generic framework abstraction that owns JSX/Svelte behavior.

- [ ] **Step 3: Verify the phase boundary**

```sh
npm run typecheck -w @pixel-point/aval-element
npm run typecheck -w @pixel-point/aval-react
npm run typecheck -w @pixel-point/aval-svelte
npm run test:unit -- packages/element/test/adapter-options.test.ts packages/element/test/adapter-binding.test.ts packages/react/src packages/svelte/test
npm run test:browser -w @pixel-point/aval-react
npm run test:browser -w @pixel-point/aval-svelte
npm run api:check
```

Expected: all focused tests and both framework browser suites pass, and API reports expose the deliberately narrowed shared contracts.

### Task 4: Decompose the player runtime

**Files:**
- Follow: `docs/superpowers/plans/2026-08-02-player-runtime-decomposition.md`

- [ ] **Step 1: Execute the selection and publication tasks**

Expected: candidate selection and provisional publication have isolated state owners while `player.ts` remains the lazy `createPlayer()` entry.

- [ ] **Step 2: Run the third thermo-nuclear review**

Review the selection/publication diff. Fix valid findings before extracting media/session ownership; reject pass-through classes, state bags, callbacks that bypass the publication gate, and duplicated failure selection.

- [ ] **Step 3: Execute the resource, failure, telemetry, media, and session tasks**

Expected: media resources have one owner, session scheduling has one owner, public `Player` behavior remains stable, and focused modules are below their plan limits.

- [ ] **Step 4: Run the fourth thermo-nuclear review**

Review all player modules and their tests. Fix valid findings, then rerun the full element test suite and browser smoke tests.

### Task 5: Decompose the custom-element runtime

**Files:**
- Follow: `docs/superpowers/plans/2026-08-02-element-runtime-decomposition.md`

- [ ] **Step 1: Execute source, cleanup, mutation, resource, input, and host-environment tasks**

Expected: DOM and page-lifetime resources have explicit state owners; stale epochs release locally; source changes and command/event follow-ups retain serialization.

- [ ] **Step 2: Run the fifth thermo-nuclear review**

Review the newly extracted owners and facade composition. Fix valid findings, especially bidirectional dependencies, cross-owner mutation, untyped cleanup records, or observer/listener cleanup split across owners.

- [ ] **Step 3: Execute diagnostics and runtime-session tasks**

Expected: `element-runtime-session.ts` owns generation/player lifecycle and `aval-element.ts` is a focused custom-element facade.

- [ ] **Step 4: Run the sixth thermo-nuclear review**

Review the complete element decomposition. Fix valid findings and rerun the element unit/type/build gates before integration testing.

### Task 6: Enforce the architecture and size boundaries

**Files:**
- Modify: `scripts/architecture/check-browser-runtime-boundaries.mjs`
- Modify: `tests/architecture/browser-runtime-boundaries.test.ts`
- Modify: `package.json`
- Modify: `scripts/release/check-generated.mjs`

- [ ] **Step 1: Add a failing architecture test**

Extend the sole-runtime guard created by the removal plan. The test must also
assert:

```text
no packages/player-web directory;
no live manifest dependency named @pixel-point/aval-player-web;
React/Svelte production imports from AVAL are limited to @pixel-point/aval-element and /adapter;
player.ts <= 200 lines;
aval-element.ts <= 800 lines;
each new player/element owner <= 1,000 lines;
no PlayerContext, ElementContext, RuntimeContext, or generic constructor/input owner bag.
```

Run:

```sh
npx vitest run --config vitest.m9.config.ts tests/architecture/browser-runtime-boundaries.test.ts
```

Expected: FAIL until the checker covers and the refactor satisfies every final
file/import boundary.

- [ ] **Step 2: Implement one deterministic checker**

Extend `scripts/architecture/check-browser-runtime-boundaries.mjs` with the
import, symbol-name, and line-count checks. Use the TypeScript compiler API for
the owner-bag rule: reject the named context declarations above, string index
signatures on constructor/input interfaces, and constructor/input properties
typed exactly as `Record<string, unknown>`. Do not textually ban legitimate
public event-detail records. Keep the existing removed-package scan in the same
checker and existing `architecture:check` root script. Add the checker to
`check:generated` so release validation cannot bypass it.

- [ ] **Step 3: Run the architecture gate**

```sh
npm run architecture:check
npm run check:generated
```

Expected: both pass with explicit output naming the canonical runtime and checked size caps.

- [ ] **Step 4: Commit the integration guard**

```sh
git add scripts/architecture/check-browser-runtime-boundaries.mjs tests/architecture/browser-runtime-boundaries.test.ts package.json scripts/release/check-generated.mjs
git commit -m "test: enforce canonical browser runtime boundaries"
```

### Task 7: Run the complete automated release and example matrix

**Files:**
- Modify only if a test reveals a valid defect in files already owned by this refactor.

- [ ] **Step 1: Run static, unit, API, and generated gates**

```sh
npm run typecheck
npm run test:unit
npm run build:public-packages
npm run api:check
npm run check:generated
npm run docs:check
npm run security:check
npm run licenses:check
```

Expected: every command exits zero.

- [ ] **Step 2: Build and inspect the exact release package set**

```sh
npm run release:pack
npm run release:inspect-packages
npm run test:consumers
npm run test:packed
npm run test:examples
```

Expected: package inspection reports no player-web archive; Node ESM, both TypeScript modes, browser Vite, Svelte Vite, compiler CLI, and packed examples pass.

- [ ] **Step 3: Run core and framework browser suites**

```sh
npm run test:browser
npm run test:browser:production
npm run test:browser:reference
```

Expected: Chromium, Firefox, and WebKit projects pass wherever configured; React and Svelte adapter browser suites pass.

- [ ] **Step 4: Run every dedicated example suite**

```sh
npm run test:playground
npm run test:grass-rabbit
npm run test:grass-rabbit-react
npm run test:grass-rabbit-svelte
npm run test:grass-rabbit-codecs
npm run test:kinetic-orb
npm run test:lend-borrow-react
```

Expected: all maintained example suites pass, including codec activation, interactions, reload/soak behavior, React behavior, Svelte reactivity, and lend/borrow playback.

- [ ] **Step 5: Build the entire workspace**

```sh
npm run build
```

Expected: public packages, certification, playgrounds, and every workspace example build successfully using the new package graph.

### Task 8: Verify every runnable example in the in-app Browser

**Files:**
- Create: `docs/evidence/2026-08-02-canonical-browser-runtime-refactor-browser.md`
- Create screenshots under: `docs/evidence/browser-runtime-refactor/`

- [ ] **Step 1: Initialize the in-app Browser correctly**

Use the `browser:control-in-app-browser` skill. Initialize its runtime through the persistent Node REPL, select the browser with `agent.browsers.get("iab")`, and read the full in-app Browser documentation before interaction. Do not substitute Playwright automation for this task.

- [ ] **Step 2: Verify the workspace examples one server at a time**

Start and test each maintained application using its exact command and fixed
local port; stop it before starting the next:

```sh
npm run playground -- --port 4175 --strictPort
npm run grass-rabbit -- --port 4176 --strictPort
npm --prefix examples/grass-rabbit-codecs run dev -- --port 4178 --strictPort
npm run dev -w @pixel-point/aval-kinetic-orb-example -- --port 4194 --strictPort
npm run grass-rabbit-react -- --port 4195
npm run grass-rabbit-svelte -- --port 4196 --strictPort
npm run lend-borrow-react -- --port 4197 --strictPort
npm run dev -w @pixel-point/aval-playground -- --port 4198 --strictPort
```

For each page: wait for visible AVAL output; perform its primary
hover/click/play/pause/state interaction; confirm the visible status or
diagnostic response changes; inspect failed network requests, page errors, and
console error/warning output; capture one screenshot. For React and Svelte,
additionally change state through the framework UI and confirm the same
`<aval-player>` host updates without replacement or terminal disposal. On port
4198, verify both `/` and `/certification.html`; run the three-player resource
soak on the certification page and confirm it settles successfully.

- [ ] **Step 3: Verify the packed-documentation examples**

These five source examples intentionally contain placeholder assets, so their
documented working behavior is a normalized unavailable/fallback state rather
than successful animation. Serve and visit them one at a time:

```sh
npx vite examples/zero-config-loop --host 127.0.0.1 --port 4199 --strictPort
npx vite examples/idle-hover-states --host 127.0.0.1 --port 4200 --strictPort
npx vite examples/network-integrity --host 127.0.0.1 --port 4201 --strictPort
npx vite examples/plain-html --host 127.0.0.1 --port 4202 --strictPort
npx vite examples/react-ref --host 127.0.0.1 --port 4203 --strictPort
```

For each page: confirm the package code loads, `<aval-player>` upgrades, the
missing/invalid placeholder source becomes the documented normalized fatal
state, and the consumer-owned fallback/status becomes visible where provided.
Exercise any still-enabled control, distinguish expected source 404/DNS or
integrity failure from unexpected module/page errors, and capture a screenshot.
`network-integrity` must show its intentional integrity/unavailable state
without an unhandled page error; do not claim successful playback for assets
the repository explicitly does not contain.

- [ ] **Step 4: Record browser evidence**

In the evidence file, add one row per URL with server command, observed output, interaction, reactive result, page-error count, unexpected console-error/warning count, and screenshot path. Any unexplained error or missing visual blocks completion.

- [ ] **Step 5: Stop all example servers**

Terminate only the exact server sessions launched for this task and record that no refactor verification server remains running.

### Task 9: Final thermo-nuclear review and handoff

**Files:**
- Modify: `docs/evidence/2026-08-02-canonical-browser-runtime-refactor-browser.md`

- [ ] **Step 1: Run the seventh thermo-nuclear review**

Invoke the strict review on the complete branch diff. Include package graph, module ownership, every changed production file, architecture checker, tests, examples, release metadata, and browser evidence. Fix all valid findings and rerun the smallest affected tests followed by the complete automated matrix in Task 7.

- [ ] **Step 2: Scan for incomplete work and stale live references**

```sh
rg -n 'TBD|implement later|similar to Task|appropriate error handling|write tests for' packages apps examples scripts tests config schemas README.md docs/certification docs/compiler docs/element docs/format docs/project docs/releases
rg -n '@pixel-point/aval-player-web|packages/player-web' package.json package-lock.json packages apps examples scripts tests config schemas README.md docs/certification docs/compiler docs/element docs/format docs/project docs/releases
git diff --check
git status --short
```

Expected: both searches return no live implementation placeholders or player-web references; `git diff --check` passes; status contains only intentional refactor files.

- [ ] **Step 3: Confirm final size and dependency results**

```sh
npm run architecture:check
wc -l packages/element/src/player.ts packages/element/src/aval-element.ts packages/element/src/player-*.ts packages/element/src/element-*.ts
npm ls @pixel-point/aval-element @pixel-point/aval-react @pixel-point/aval-svelte --all
```

Expected: the lazy factory/facade and extracted owners satisfy their caps; both framework packages resolve the same element adapter; player-web is absent.

- [ ] **Step 4: Commit final evidence and any review fixes**

```sh
git add docs/evidence/2026-08-02-canonical-browser-runtime-refactor-browser.md docs/evidence/browser-runtime-refactor
git commit -m "test: verify canonical browser runtime refactor"
```

- [ ] **Step 5: Prepare the final report**

Report the exact package graph, deleted package, final module sizes, automated commands and totals, in-app-browser URLs and screenshots, thermo-nuclear findings fixed, and final revision. Do not claim completion unless every checkbox in all five plans is complete.
