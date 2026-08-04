# Remove Compiler Init Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the compiler's project-generator command and every active repository path that exposes or regenerates it.

**Architecture:** Keep the compiler focused on compiling, inspecting, validating, unpacking, and developing author-provided projects. Delete the isolated generator modules, remove their CLI/type wiring, retain the independent static packed-browser fixture, and make clean compiler builds eliminate stale deleted output.

**Tech Stack:** TypeScript, Node.js ESM, npm scripts, Vitest, Markdown.

---

### Task 1: Lock the removed CLI contract with tests

**Files:**
- Modify: `packages/compiler/test/cli-args.test.ts`

- [x] **Step 1: Replace the positive parser assertion with rejection**

Remove the `init` object expectation from the workflow-command test and add:

```ts
it("rejects the removed init command", () => {
  expect(() => parseCliArguments(["init", "starter"]))
    .toThrowError(/Unknown command "init"/u);
});
```

- [x] **Step 2: Assert help does not advertise the command**

Import `HELP_TEXT` from the compiler CLI module in `cli-args.test.ts` and assert:

```ts
expect(HELP_TEXT).not.toContain(["avl", "init"].join(" "));
```

- [x] **Step 3: Run the tests and confirm the help assertion fails**

Run:
`npx vitest run --config vitest.m9.config.ts packages/compiler/test/cli-args.test.ts`

Expected: FAIL because the current parser accepts `init` and help lists it.

### Task 2: Remove the implementation and public surface

**Files:**
- Delete: `packages/compiler/src/commands/init.ts`
- Delete: `packages/compiler/src/commands/init-publication.ts`
- Delete: `packages/compiler/test/init-starter.test.ts`
- Modify: `packages/compiler/src/cli-args.ts`
- Modify: `packages/compiler/src/cli.ts`
- Modify: `packages/compiler/src/index.ts`
- Modify: `packages/compiler/package.json`

- [x] **Step 1: Remove the command from the argument union and parser**

Delete `InitCliArguments`, remove it from `CliArguments`, remove `"init"` from
the command allowlist/switch, and delete `parseInit`. Unknown `init` input then
uses the existing `usage("Unknown command …")` path.

- [x] **Step 2: Remove dispatch, help, and the public type export**

Delete the `runInitCommand` import and dispatch branch, delete the help usage
line, and remove `InitCliArguments` from `src/index.ts`.

- [x] **Step 3: Delete generator-owned modules and tests**

Delete both generator source modules and the generator-specific test file. No
replacement compatibility alias or deprecation shim is created.

- [x] **Step 4: Clean distribution output before compilation**

Change the compiler build script to clean TypeScript outputs before emitting:

```json
"build": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\" && tsc -p tsconfig.json && node ../../scripts/release/compiler-cli-mode.mjs dist/cli.js"
```

- [x] **Step 5: Run focused tests and type checking**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/compiler/test/cli-args.test.ts
npm run typecheck -w @pixel-point/aval-compiler
```

Expected: PASS with `init` rejected as `CLI_USAGE`.

### Task 3: Remove active repository guidance and generator verification

**Files:**
- Modify: `README.md`
- Modify: `packages/compiler/README.md`
- Modify: `docs/compiler.md`
- Modify: `docs/quick-start.md`
- Modify: `docs/compiler/user-defined-states.md`
- Modify: `examples/plain-html/README.md`
- Modify: `examples/network-integrity/README.md`
- Modify: `examples/idle-hover-states/README.md`
- Modify: `examples/zero-config-loop/README.md`
- Modify: `scripts/docs/check-docs.mjs`
- Modify: `scripts/fixtures/verify-all.mjs`

- [x] **Step 1: Present direct scoped-package compilation everywhere**

Use this as the canonical command:

```sh
npx @pixel-point/aval-compiler compile motion.json --out dist/motion
```

Remove every active suggestion to install the compiler locally or generate a
starter. Example READMEs direct readers to create/compile a project rather than
to the removed command.

- [x] **Step 2: Update documentation policy checks**

Replace the old install/init sequence assertions with assertions that the root
and compiler READMEs contain the scoped direct compile command and do not
contain the removed invocation.

- [x] **Step 3: Stop regenerating the static fixture**

Remove `verifyStarter`, its temporary-directory imports, and the `starter`
result field from `scripts/fixtures/verify-all.mjs`. Keep fixture layout and
provenance verification because other packed-browser tests still consume the
static fixture.

- [x] **Step 4: Run documentation and fixture checks**

Run:

```sh
npm run docs:check
npm run fixtures:verify
```

Expected: PASS without importing `dist/commands/init.js`.

### Task 4: Verify fresh build and package absence

**Files:**
- Generated and ignored: `packages/compiler/dist/`
- Generated and ignored: `artifacts/1.0.0/packages/`

- [x] **Step 1: Build from a cleaned compiler distribution**

Run: `npm run build -w @pixel-point/aval-compiler`

Expected: PASS and no `packages/compiler/dist/commands/init*` files.

- [x] **Step 2: Run compiler and package regression suites**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/compiler/test tests/package/package-contents.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 3: Inspect source and built surfaces**

Run:

```sh
rg -n 'avl init|command: "init"|runInitCommand|InitCliArguments' README.md packages/compiler/src packages/compiler/README.md docs/compiler.md docs/quick-start.md docs/compiler examples scripts
find packages/compiler/dist/commands -maxdepth 1 -name 'init*' -print
git diff --check
```

Expected: both searches print nothing and diff hygiene passes.
