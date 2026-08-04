# `motion.json` Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a complete, accurate `motion.json` reference immediately discoverable from the README compile flow and show a short project that can actually be compiled.

**Architecture:** Keep `docs/project/1.0.md` as the single versioned schema authority and expand it into a practical reference. Keep the README concise with one complete loop project, a direct link, and the scoped compiler command. Add executable documentation checks so the link, TOC label, example, and reference sections cannot silently disappear.

**Tech Stack:** Markdown, Node.js documentation checks, TypeScript, Vitest, AVAL compiler project-schema validator.

---

### Task 1: Add regression coverage for the README project example

**Files:**
- Create: `packages/compiler/test/documented-project.test.ts`
- Modify: `README.md:31`

- [x] **Step 1: Write the failing schema test**

Create a test that extracts the marked README JSON block and validates the
complete project with the production schema:

```ts
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { validateSourceProject } from "../src/source-project-schema.js";

describe("documented motion project", () => {
  it("keeps the README example valid and compilable", async () => {
    const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
    const source = readme.match(
      /<!-- BEGIN README MOTION PROJECT -->\n```json\n([\s\S]*?)\n```\n<!-- END README MOTION PROJECT -->/u
    )?.[1];

    expect(source).toBeDefined();
    const project = validateSourceProject(JSON.parse(source!));
    expect(project.projectVersion).toBe("1.0");
    expect(project.initialState).toBe("idle");
    expect(project.encodings.map(({ codec }) => codec)).toEqual(["vp9"]);
  });
});
```

- [x] **Step 2: Run the test and verify the missing example fails**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/compiler/test/documented-project.test.ts
```

Expected: FAIL because the README does not contain the marked complete project.

- [x] **Step 3: Add the compact project beside the first compile command**

In `README.md`, link the first `motion.json` mention to
`docs/project/1.0.md`, explain that the sample media is a 1920×1080 30 fps file
with at least 120 frames, and insert a complete single-state VP9 project between
the exact marker comments. Keep the scoped command directly below it:

```sh
npx @pixel-point/aval-compiler compile motion.json --out dist/motion
```

- [x] **Step 4: Run the schema test and verify it passes**

Run the focused Vitest command from Step 2.

Expected: one test passes and the parsed project contains the VP9 encoding.

### Task 2: Expand the authoritative project reference

**Files:**
- Modify: `docs/project/1.0.md`

- [x] **Step 1: Replace the terse introduction with a practical entry point**

Title the page ``# `motion.json` format and options``. Explain that paths are
relative to the project file, show the same minimal project and scoped compile
command, and state that unknown or missing fields are rejected.

- [x] **Step 2: Document every top-level field**

Add a table for the exact required fields:

```text
projectVersion, alpha, canvas, frameRate, sources, encodings, units,
initialState, states, edges, bindings
```

Document `alpha`, all canvas fields and values, reduced frame-rate fractions up
to 60 fps, the identifier pattern, and the half-open range convention.

- [x] **Step 3: Document source and encoding variants**

Add complete JSON shapes for video and PNG-sequence sources. Add one shared
rendition table plus codec-specific tables covering required fields, accepted
ranges, and the H.265/VP9 authored defaults. Include the exact preset list and
AV1 tile constraints.

- [x] **Step 4: Document graph variants**

Add field tables and JSON shapes for body, bridge, reversible, and one-shot
units; states; event/completion triggers; portal/finish/cut starts;
locked/reversible transitions; and every binding source. Explain reference and
unit-usage invariants and link to the dedicated state-authoring guides.

- [x] **Step 5: Add additional examples and commands**

Add a PNG-sequence source example and link to the checked-in two-state project.
End with scoped compile, inspect, validate, and dev commands.

### Task 3: Make the reference discoverable and enforce its structure

**Files:**
- Modify: `README.md:182`
- Modify: `scripts/docs/check-docs.mjs:117`

- [x] **Step 1: Rename the README TOC entry**

Use the visible label ``motion.json format and options`` with the target
`docs/project/1.0.md`.

- [x] **Step 2: Add documentation-gate assertions**

Read `README.md` and `docs/project/1.0.md` and require:

```js
const motionProjectLink = ["[`motion.json`]", "(docs/project/1.0.md)"].join("");
const motionProjectToc = [
  "[`motion.json` format and options]",
  "(docs/project/1.0.md)"
].join("");
for (const claim of [
  "## Top-level fields",
  "## Sources",
  "## Encodings and renditions",
  "## Units",
  "## States, edges, and bindings",
  "## Validate and compile"
]) {
  if (!projectReference.includes(claim)) {
    failures.push(`docs/project/1.0.md: missing motion project reference section: ${claim}`);
  }
}
```

Also fail when the README lacks the immediate link or the renamed TOC entry.

- [x] **Step 3: Run the documentation gate**

Run:

```sh
npm run docs:check
```

Result: the new reference assertions and links pass. The complete command still
reports pre-existing example dependencies at `1.0.1` while the gate expects
`1.0.0`; those release-version files are outside this documentation change.

### Task 4: Complete verification

**Files:**
- Test: `packages/compiler/test/documented-project.test.ts`
- Test: `packages/compiler/test/source-project-schema.test.ts`
- Test: `README.md`
- Test: `docs/project/1.0.md`

- [x] **Step 1: Run focused compiler schema tests**

```sh
npx vitest run --config vitest.m9.config.ts \
  packages/compiler/test/documented-project.test.ts \
  packages/compiler/test/source-project-schema.test.ts
```

Expected: all tests pass.

- [x] **Step 2: Run the workspace documentation gate**

```sh
npm run docs:check
```

Result: the motion-project documentation checks pass; the command remains
nonzero only for the pre-existing example dependency-version mismatch described
in Task 3.

- [x] **Step 3: Check formatting and the final diff**

```sh
git diff --check
git diff -- README.md docs/project/1.0.md scripts/docs/check-docs.mjs packages/compiler/test/documented-project.test.ts
```

Expected: no whitespace errors; the README remains concise and the reference
matches the production schema.
