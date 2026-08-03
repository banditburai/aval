# Lend/Borrow Three-Exit Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recompile the React lend/borrow example from the native 3840×2160 alpha MOV and route activation through the authored frame-12, frame-24, or frame-36 branch.

**Architecture:** Split the logical 36-frame idle loop into three finite twelve-frame states whose completion edges cycle continuously. Each phase owns a finish-bound activation edge to one finite active state; each active state returns directly to the next idle phase so the already-presented safety frame is not replayed. React presents the internal phases as one interaction, while a fresh-page browser matrix proves every route and exact boundary.

**Tech Stack:** AVAL source graph JSON, `@pixel-point/aval-react`, React 19, TypeScript, Vite, Node.js, Playwright/Chromium, FFmpeg/FFprobe, VP9, H.265.

---

### Task 1: Install the replacement source and author the phase graph

**Files:**
- Copy: `/Users/alex/Movies/polyester/lend-borrow-page/lend-borrow-test-2.mov` to `examples/lend-borrow-react/source/lend-borrow-test-2.mov`
- Modify: `examples/lend-borrow-react/motion.json`

- [ ] **Step 1: Verify and copy the source without changing bytes**

Run `ffprobe` and require ProRes `yuva444p12le`, 3840×2160, 24 fps, and 136 frames. Copy the MOV, then run `shasum -a 256` on both paths and require identical hashes.

- [ ] **Step 2: Set native canvas and encoding policy**

Set the source path to `source/lend-borrow-test-2.mov`. Set the canvas and both rendition sizes to 3840×2160. Retain only VP9 CRF 40 and H.265 CRF 30, both 8-bit by omission. Do not set `deadline` or `preset`, so compiler defaults materialize as VP9 `best` and H.265 `veryslow`.

- [ ] **Step 3: Define exact source-backed units**

Create these body units; every range is half-open and every port enters at zero and exposes its final local frame:

```text
idle.12.body   [0,12)    finite portal 11
idle.24.body   [12,24)   finite portal 11
idle.36.body   [24,36)   finite portal 11
active.12.body [64,100)  finite portal 35
active.24.body [100,136) finite portal 35
active.36.body [36,64)   finite portal 27
```

- [ ] **Step 4: Define six states and nine finish edges**

Use the unit-prefix names as state IDs and `idle.12` as initial state. Add:

```text
automatic idle cycle:
  idle.12→idle.24, idle.24→idle.36, idle.36→idle.12
requested activation:
  idle.12→active.12, idle.24→active.24, idle.36→active.36
automatic active return:
  active.12→idle.24, active.24→idle.36, active.36→idle.12
```

All starts are `finish` and all continuities are `exact-authored`. Use `maxWaitFrames` 11 for idle sources and 35/35/27 for active sources.

- [ ] **Step 5: Run fast validation**

Build the compiler, parse the manifest through the production source schema,
and check formatting:

```sh
npm run build -w @pixel-point/aval-compiler
node --input-type=module -e 'import { readFile } from "node:fs/promises"; import { parseSourceProject } from "./packages/compiler/dist/source-project-schema.js"; parseSourceProject(new Uint8Array(await readFile("examples/lend-borrow-react/motion.json"))); console.log("source graph passed");'
git diff --check
```

Expect `source graph passed`. Full media analysis in Task 4 may report only
the approved `active.36 → idle.12` continuity review.

### Task 2: Route one React action through internal graph phases

**Files:**
- Modify: `examples/lend-borrow-react/src/main.tsx`
- Modify: `examples/lend-borrow-react/src/styles.css`

- [ ] **Step 1: Add explicit phase-to-branch routing**

Add:

```ts
const ACTIVE_STATE_BY_IDLE_STATE = Object.freeze({
  "idle.12": "active.12",
  "idle.24": "active.24",
  "idle.36": "active.36"
} as const);

function isActiveState(state: string | null): boolean {
  return state?.startsWith("active.") === true;
}
```

Initialize `useAval` with `state: "idle.12"`. In the click callback, map the current committed `aval.visualState` and synchronously call `aval.setState(target)`. Do not route from wall-clock time or a video timestamp.

- [ ] **Step 2: Preserve one-button user semantics**

Keep `Activate`, `Queued`, and `Active`. Treat active requests, `active.*`, and transitions as busy; keep the button disabled until the next `idle.*` state. Keep the existing error and accessibility behavior.

- [ ] **Step 3: Set native geometry**

Set `<AvalComponent width={3840} height={2160}>` and CSS `aspect-ratio: 3840 / 2160`. Preserve responsive containment, the empty dark page, and the background picker.

- [ ] **Step 4: Typecheck**

Run `npm run typecheck -w @pixel-point/aval-lend-borrow-react-example`; expect PASS.

### Task 3: Replace the stale single-route browser regression

**Files:**
- Modify: `examples/lend-borrow-react/scripts/verify-playback.mjs`

- [ ] **Step 1: Write six isolated scenarios**

Run early local frame 2 and exact boundary local frame 11 for each idle phase. Expected routes are:

```text
idle.12.body → active.12.body frames 0…35 → idle.24.body:0,1
idle.24.body → active.24.body frames 0…35 → idle.36.body:0,1
idle.36.body → active.36.body frames 0…27 → idle.12.body:0,1
```

Open a fresh page for every scenario so decoded route work cannot leak between cases.

- [ ] **Step 2: Make trigger capture atomic**

Inside one page polling callback, detect the exact unit/frame and call `pause()` before resolving. Record trace index, graph presentation, media cursor, unit instance, and underflow baseline. Click the actual React button while paused, assert its requested branch and `Queued`, then resume.

- [ ] **Step 3: Assert content without deduplication**

Do not use `Set`. Assert the active local-frame array is exactly the full ordered range, content ordinals advance, and one unit instance owns the active body. Exact-boundary cases may retain the current safety frame while decoding becomes ready, but must never present a later idle unit or a complete extra loop before active frame zero.

- [ ] **Step 4: Assert return, transparency, codec, and errors**

Require correct next idle frames zero and one with no replayed safety-frame unit, no underflow delta, no fatal/page/console errors, and an enabled Activate button. Over background `#7c3aed`, require corner RGB `[124,58,237]`. Assert selected bit depth 8 and a `vp09.` codec string. Pixel-check ordinary seams; treat the large `active.36 → idle.12` difference as an expected source witness.

- [ ] **Step 5: Confirm the test fails on stale assets**

Run the example browser test before recompilation. Expect failure because the old assets lack the new states and units.

### Task 4: Compile and structurally validate both codecs

**Files:**
- Modify: `packages/compiler/src/ffmpeg/video-encode-unit.ts`
- Modify: `packages/compiler/test/video-encode-unit.test.ts`
- Replace generated: `examples/lend-borrow-react/public/lend-borrow/vp9.avl`
- Replace generated: `examples/lend-borrow-react/public/lend-borrow/h265.avl`
- Replace generated: `examples/lend-borrow-react/public/lend-borrow/build.json`

- [ ] **Step 0: Keep one-frame H.265 units on the shared Main profile**

Add a failing argv regression for a one-frame H.265 unit. Retain
`-frames:v 1`, but use a minimum H.265 GOP/keyframe interval of two for `-g`,
`-keyint_min`, `keyint`, and `min-keyint`. Prove synthetic one-frame and normal
units emit byte-identical VPS/SPS/PPS, then run the compiler unit/type checks.

- [ ] **Step 1: Compile**

Run `npm run compile:lend-borrow-react`. Expect VP9 CRF 40 with normalized `deadline=best`, H.265 CRF 30 with normalized `preset=veryslow`, native visible 3840×2160 geometry, and only the approved `active.36` return discontinuity.

- [ ] **Step 2: Validate and inspect both assets**

Run the built compiler CLI `validate --json` and `inspect --json` on each asset. Require valid packed alpha, 8-bit payloads, correct graph units/frame counts, and native visible geometry. Accept H.265 coded conformance padding only when metadata crops it back to packed storage and 3840×2160 visible output.

- [ ] **Step 3: Audit literal encoder commands and outputs**

Read `build.json`. Require VP9 `libvpx-vp9`, `-crf 40`, `-deadline best`; require H.265 `libx265`, `-crf 30`, `-preset veryslow`. Require the output directory to contain only `vp9.avl`, `h265.avl`, and `build.json`.

### Task 5: Verify, document, and hand off

**Files:**
- Modify: `examples/lend-borrow-react/README.md`

- [ ] **Step 1: Run the six-scenario real-browser regression**

Run `npm run test:lend-borrow-react`. All routes, including exact-boundary cases, must select the intended branch without an extra idle phase.

- [ ] **Step 2: Update README**

Document the 136-frame native-alpha source, half-open ranges, one-based safety labels, phase graph, direct next-frame returns, approved `active.36` jump/holds, native 3840×2160 visible geometry, CRFs/default policies, and compile/run/test commands. State that Chromium plays VP9 while H.265 receives structural validation.

- [ ] **Step 3: Run repository checks**

Run the production example build, full typecheck, API check, docs check, generated-file check, fixture verification, and `git diff --check`. Every command must pass.

- [ ] **Step 4: Review and commit**

Confirm no unrelated files changed, no old source path remains in manifest/docs, no alpha synthesis returned, and the browser test does not mask repeated frames. Stage only the example and this plan, then commit with `feat: route lend borrow through three safety exits`.
