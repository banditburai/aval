# High-quality Encoder Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default omitted H.265 presets to `veryslow` and omitted VP9 deadlines to `best`, while preserving explicit overrides and strict normalized build reports.

**Architecture:** Compiler-owned typed constants define the policy once. Direct lowering and authored-project validation use those defaults; normalized encoding/report validation still requires explicit resolved values. Authored project types expose only these two controls as optional.

**Tech Stack:** TypeScript, Node.js, Vitest, FFmpeg/libx265/libvpx, canonical JSON fixtures.

---

### Task 1: Prove authored and normalized policy behavior

**Files:**
- Modify: `packages/compiler/test/video-encoding-policy.test.ts`
- Modify: `packages/compiler/test/source-project-schema.test.ts`
- Modify: `packages/compiler/test/public-api.compile.ts`

- [ ] **Step 1: Add a failing policy-normalization test**

Add a test that calls `cloneVideoEncodings` with an H.265 encoding lacking
`preset` and a VP9 encoding lacking `deadline`, then expects resolved values:

```ts
expect(authored).toMatchObject([
  { codec: "h265", preset: "veryslow" },
  { codec: "vp9", deadline: "best" }
]);
```

In the same test, pass equivalent unresolved objects to
`cloneNormalizedVideoEncodings` and expect `CompilerError`. This protects the
strict `build.json` contract.

- [ ] **Step 2: Add a failing source-project test**

Delete `deadline` and `preset` from the VP9 and H.265 entries returned by the
existing `project()` fixture. Expect `validateSourceProject` to return explicit
`best` and `veryslow` values.

- [ ] **Step 3: Add a failing public typecheck witness**

Create a `SourceProject["encodings"]` value whose H.265 member omits `preset`
and whose VP9 member omits `deadline`. Keep `VideoEncoding` witnesses explicit
to prove normalized types remain required.

- [ ] **Step 4: Run the focused tests and confirm failure**

Run:

```sh
npx vitest run packages/compiler/test/video-encoding-policy.test.ts packages/compiler/test/source-project-schema.test.ts
npm run typecheck -w @pixel-point/aval-compiler
```

Expected: runtime validation rejects the omitted controls and the public
typecheck rejects the authored witnesses.

### Task 2: Centralize and apply compiler defaults

**Files:**
- Modify: `packages/compiler/src/model.ts`
- Modify: `packages/compiler/src/compile/video-encoding-policy.ts`
- Modify: `packages/compiler/src/compile/direct-project.ts`

- [ ] **Step 1: Add typed internal defaults**

After the encoder-control type aliases in `model.ts`, add:

```ts
export const DEFAULT_H265_ENCODER_PRESET: H265EncoderPreset = "veryslow";
export const DEFAULT_VP9_DEADLINE: Vp9Deadline = "best";
```

- [ ] **Step 2: Distinguish authored encoding types**

Add source-only aliases:

```ts
export type SourceH265Encoding =
  Omit<H265Encoding, "preset"> & { readonly preset?: H265EncoderPreset };
export type SourceVp9Encoding =
  Omit<Vp9Encoding, "deadline"> & { readonly deadline?: Vp9Deadline };
export type SourceVideoEncoding =
  | H264Encoding
  | SourceH265Encoding
  | SourceVp9Encoding
  | Av1Encoding;
```

Change `SourceProject.encodings` to `readonly SourceVideoEncoding[]`. Do not
weaken `VideoEncoding` or `NormalizedVideoEncoding`.

- [ ] **Step 3: Default only authored project controls**

Pass whether the clone is authored into the H.265 and VP9 clone helpers. For
authored input, put `preset`/`deadline` in `exactKeys`' optional list and resolve
an absent value from the typed constants. For normalized input, keep those
fields required and validate them with `oneOf`.

- [ ] **Step 4: Change direct lowering defaults**

Export the pure internal `directEncoding` helper as `lowerDirectEncoding` for a
focused test and replace:

```ts
preset: options.preset ?? DEFAULT_H265_ENCODER_PRESET
deadline: options.deadline ?? DEFAULT_VP9_DEADLINE
```

Keep the H.264 `medium` default unchanged.

- [ ] **Step 5: Run the focused tests**

Run:

```sh
npx vitest run packages/compiler/test/video-encoding-policy.test.ts packages/compiler/test/source-project-schema.test.ts
npm run typecheck -w @pixel-point/aval-compiler
```

Expected: PASS.

### Task 3: Prove direct defaults and explicit overrides

**Files:**
- Create: `packages/compiler/test/direct-encoding-defaults.test.ts`
- Modify: `packages/compiler/src/compile/direct-project.ts`

- [ ] **Step 1: Write direct-lowering assertions**

Call `lowerDirectEncoding` with minimal H.265 and VP9
`DirectArtifactOptions`. Assert omitted controls resolve to
`veryslow`/`best`, while explicit `medium`/`good` values remain unchanged.
Also assert H.264 still defaults to `medium`.

- [ ] **Step 2: Run the test**

Run:

```sh
npx vitest run packages/compiler/test/direct-encoding-defaults.test.ts
```

Expected: PASS with no media encoding.

### Task 4: Update generated and example policies

**Files:**
- Modify: `packages/compiler/src/commands/init.ts`
- Modify: `packages/compiler/test/init-starter.test.ts`
- Modify: `fixtures/starter/v1-idle-hover/motion.json`
- Modify: `fixtures/starter/v1-idle-hover/provenance.json`
- Modify: `examples/lend-borrow-react/motion.json`
- Modify: `docs/superpowers/plans/2026-07-30-lend-borrow-react-example.md`

- [ ] **Step 1: Update explicit policies**

Set generated starter and lend/borrow VP9 to `deadline: "best"` and H.265 to
`preset: "veryslow"`. Leave H.264 unchanged.

- [ ] **Step 2: Refresh starter provenance**

Calculate the exact byte length and SHA-256 of the canonical
`fixtures/starter/v1-idle-hover/motion.json`, then update only
`provenance.json.project.bytes` and `.sha256`.

- [ ] **Step 3: Verify the starter**

Run:

```sh
npx vitest run packages/compiler/test/init-starter.test.ts
node scripts/fixtures/verify-all.mjs
```

Expected: PASS and the generated starter exactly matches the committed fixture.

### Task 5: Document the defaults

**Files:**
- Modify: `packages/compiler/src/cli.ts`
- Modify: `docs/compiler/authoring-video-and-states.md`

- [ ] **Step 1: Update CLI help**

State that direct H.265 defaults to `veryslow`, direct H.264 remains `medium`,
and VP9 defaults to `best`.

- [ ] **Step 2: Update authoring documentation**

Document that authored project JSON may omit H.265 `preset` and VP9 `deadline`,
that validation materializes the new defaults, and that slow defaults can
substantially increase compile time. Preserve the statement that normalized
build reports record explicit policies.

- [ ] **Step 3: Run documentation checks**

Run:

```sh
npm run docs:check
```

Expected: PASS.

### Task 6: Recompile and verify the lend/borrow example

**Files:**
- Modify: `examples/lend-borrow-react/public/lend-borrow/vp9.avl`
- Modify: `examples/lend-borrow-react/public/lend-borrow/h265.avl`
- Modify: `examples/lend-borrow-react/public/lend-borrow/build.json`

- [ ] **Step 1: Recompile with the requested quality modes**

Run:

```sh
npm run compile:lend-borrow-react
```

Expected: the report records VP9 `deadline: "best"` and H.265
`preset: "veryslow"`, while retaining VP9 CRF 40, H.265 CRF 30, 8-bit output,
and exactly two assets.

- [ ] **Step 2: Validate both assets**

Run:

```sh
npm run avl -- validate examples/lend-borrow-react/public/lend-borrow/vp9.avl --json
npm run avl -- validate examples/lend-borrow-react/public/lend-borrow/h265.avl --json
```

Expected: both assets validate with 72 chunks and no failure.

- [ ] **Step 3: Run browser playback regression**

Run:

```sh
npm run test:lend-borrow-react
```

Expected: full idle and active frame sequences, zero transition underflows,
working transparency, and passing status.

### Task 7: Full regression verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run focused compiler suites**

```sh
npx vitest run packages/compiler/test/video-encoding-policy.test.ts packages/compiler/test/source-project-schema.test.ts packages/compiler/test/direct-encoding-defaults.test.ts packages/compiler/test/init-starter.test.ts packages/compiler/test/video-encode-unit.test.ts packages/format/test/compile-bundle-report.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository build**

```sh
npm run build
```

Expected: PASS.

- [ ] **Step 3: Check diff hygiene**

```sh
git diff --check
git status --short
```

Expected: no whitespace errors and only intentional compiler-default/example
changes plus the pre-existing lend/borrow worktree changes.
