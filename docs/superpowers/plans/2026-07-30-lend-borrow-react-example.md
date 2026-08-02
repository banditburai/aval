# Lend/Borrow React Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal React example that renders the 69-frame true-alpha Lend/Borrow animation through a two-codec packed-alpha AVAL bundle and exposes active-state and background-color controls.

**Architecture:** A Vite/React workspace owns one AVAL project and its generated VP9/H.265 assets. `@pixel-point/aval-react` renders the codec bundle and routes a button request from the looping idle unit into a finite active unit, whose completion edge returns to idle. React owns only the page background, control state, and application error boundary.

**Tech Stack:** React 19, TypeScript 7, Vite 8, `@pixel-point/aval-react`, `@pixel-point/aval-compiler`, FFmpeg/FFprobe

---

## File map

- `examples/lend-borrow-react/motion.json`: canonical AVAL source, codec, range, and graph authoring.
- `examples/lend-borrow-react/source/lend-borrow-test.mov`: local ignored copy of the exact requested source.
- `examples/lend-borrow-react/scripts/verify-playback.mjs`: frame-order, pixel-motion, and transparency browser regression.
- `examples/lend-borrow-react/public/lend-borrow/{vp9.avl,h265.avl,build.json}`: generated browser assets and exact build provenance.
- `examples/lend-borrow-react/src/main.tsx`: React integration, active-state request, color state, and fatal-error UI.
- `examples/lend-borrow-react/src/styles.css`: full-viewport stage and compact accessible controls.
- `examples/lend-borrow-react/{index.html,package.json,tsconfig.json,.gitignore,README.md}`: Vite workspace shell and operator instructions.
- `package.json`: root workspace, build, dev, and compile entry points.
- `package-lock.json`: npm workspace resolution.

### Task 1: Scaffold the example workspace

**Files:**
- Create: `examples/lend-borrow-react/.gitignore`
- Create: `examples/lend-borrow-react/package.json`
- Create: `examples/lend-borrow-react/tsconfig.json`
- Create: `examples/lend-borrow-react/index.html`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add the package manifest**

```json
{
  "name": "@pixel-point/aval-lend-borrow-react-example",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "compile": "avl compile motion.json --out public/lend-borrow --force",
    "dev": "vite --host 127.0.0.1",
    "test:playback": "node scripts/verify-playback.mjs",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@pixel-point/aval-react": "1.0.0",
    "react": "19.2.7",
    "react-dom": "19.2.7"
  },
  "devDependencies": {
    "@pixel-point/aval-compiler": "1.0.0",
    "@playwright/test": "1.61.1",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "typescript": "7.0.2",
    "vite": "8.1.4"
  }
}
```

- [ ] **Step 2: Add the strict TypeScript/Vite shell**

Create `tsconfig.json` with DOM libraries, `moduleResolution: "Bundler"`,
`jsx: "react-jsx"`, strict mode, and no output. Create `index.html` with
`<meta name="color-scheme" content="dark">`, a `#root` mount, and
`<script type="module" src="/src/main.tsx">`.

- [ ] **Step 3: Ignore generated site output and the large source MOV**

```gitignore
dist/
source/*.mov
```

The compiled AVAL files under `public/` remain tracked.

- [ ] **Step 4: Register the first-class root workspace**

Add `examples/lend-borrow-react` to `workspaces`, append
`npm run build -w @pixel-point/aval-lend-borrow-react-example` to the explicit
root `build` script, and add:

```json
"lend-borrow-react": "npm run build:public-packages && npm run dev -w @pixel-point/aval-lend-borrow-react-example --",
"compile:lend-borrow-react": "npm run build:public-packages && npm run compile -w @pixel-point/aval-lend-borrow-react-example",
"test:lend-borrow-react": "npm run build:public-packages && npm run test:playback -w @pixel-point/aval-lend-borrow-react-example"
```

- [ ] **Step 5: Refresh npm workspace metadata**

Run:

```sh
npm install --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` gains the new workspace without dependency
version upgrades.

- [ ] **Step 6: Verify the shell**

Run:

```sh
npm run typecheck -w @pixel-point/aval-lend-borrow-react-example
```

Expected: TypeScript reaches the source include and reports no configuration
errors after Task 3 adds `src/main.tsx`.

### Task 2: Author and compile the two-codec packed-alpha asset

**Files:**
- Create: `examples/lend-borrow-react/motion.json`
- Create locally/ignored: `examples/lend-borrow-react/source/lend-borrow-test.mov`
- Generate: `examples/lend-borrow-react/public/lend-borrow/vp9.avl`
- Generate: `examples/lend-borrow-react/public/lend-borrow/h265.avl`
- Generate: `examples/lend-borrow-react/public/lend-borrow/build.json`

- [ ] **Step 1: Place and validate the exact requested source**

Copy
`/Users/alex/Movies/polyester/lend-borrow-page/lend-borrow-test.mov`
to `examples/lend-borrow-react/source/lend-borrow-test.mov`, then run:

```sh
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,pix_fmt,avg_frame_rate,nb_frames \
  -of json examples/lend-borrow-react/source/lend-borrow-test.mov
ffmpeg -v error \
  -i examples/lend-borrow-react/source/lend-borrow-test.mov \
  -vf alphaextract -frames:v 1 -f null -
```

Expected probe:

```text
input: 3840x670, yuva444p12le, 24/1 fps, 69 frames
alphaextract: succeeds
```

Compile this source directly. Do not derive alpha with a color key and do not
create a second MOV.

- [ ] **Step 2: Author the AVAL project**

```json
{
  "projectVersion": "1.0",
  "alpha": "packed",
  "canvas": {
    "width": 3840,
    "height": 670,
    "fit": "contain",
    "pixelAspect": [1, 1],
    "colorSpace": "srgb"
  },
  "frameRate": { "numerator": 24, "denominator": 1 },
  "sources": [
    {
      "id": "lend-borrow",
      "type": "video",
      "path": "source/lend-borrow-test.mov",
      "timing": { "mode": "exact" }
    }
  ],
  "encodings": [
    {
      "codec": "vp9",
      "cpuUsed": 4,
      "threads": 8,
      "renditions": [
        { "id": "video.1x", "width": 3840, "height": 670, "crf": 40 }
      ]
    },
    {
      "codec": "h265",
      "threads": 8,
      "renditions": [
        { "id": "video.1x", "width": 3840, "height": 670, "crf": 30 }
      ]
    }
  ],
  "units": [
    {
      "id": "idle.body",
      "kind": "body",
      "source": "lend-borrow",
      "range": [0, 36],
      "playback": "loop",
      "ports": [
        { "id": "default", "entryFrame": 0, "portalFrames": [35] }
      ]
    },
    {
      "id": "active.body",
      "kind": "body",
      "source": "lend-borrow",
      "range": [36, 69],
      "playback": "finite",
      "ports": [
        { "id": "default", "entryFrame": 0, "portalFrames": [32] }
      ]
    }
  ],
  "initialState": "idle",
  "states": [
    { "id": "idle", "bodyUnit": "idle.body" },
    { "id": "active", "bodyUnit": "active.body" }
  ],
  "edges": [
    {
      "id": "idle.active",
      "from": "idle",
      "to": "active",
      "start": {
        "type": "portal",
        "sourcePort": "default",
        "targetPort": "default",
        "maxWaitFrames": 35
      },
      "continuity": "exact-authored"
    },
    {
      "id": "active.idle",
      "from": "active",
      "to": "idle",
      "trigger": { "type": "completion" },
      "start": {
        "type": "finish",
        "targetPort": "default",
        "maxWaitFrames": 35
      },
      "continuity": "exact-authored"
    }
  ],
  "bindings": []
}
```

VP9 and H.265 are fixed to 8-bit by the AVAL compiler; codec-specific
`bitDepth` fields must not be added. Both visible renditions remain at the
native 3840×670 resolution, producing 3840×1348 decoded packed storage. VP9
codes that surface directly. With the current `veryslow` x265 toolchain, H.265
publishes an SPS-coded 3840×1352 surface with a four-row bottom conformance crop
to the exact 3840×1348 decoded storage. Encoder padding does not alter the
authored visible resolution. Omitting VP9 `deadline` and H.265 `preset` is
intentional: project normalization must materialize the compiler defaults
`best` and `veryslow`, and `build.json` must record them explicitly.

- [ ] **Step 3: Build the public packages and compile**

Run:

```sh
npm run build:public-packages
npm run compile -w @pixel-point/aval-lend-borrow-react-example
```

Expected: exactly `vp9.avl`, `h265.avl`, and `build.json` appear under
`public/lend-borrow`.

- [ ] **Step 4: Validate each generated asset**

Run:

```sh
npm run avl -- validate examples/lend-borrow-react/public/lend-borrow/vp9.avl
npm run avl -- validate examples/lend-borrow-react/public/lend-borrow/h265.avl
```

Expected: both assets validate successfully.

- [ ] **Step 5: Audit generated codec and alpha metadata**

Read `build.json` and require:

```text
assets/codecs: vp9, h265 only
rendition bitDepth: 8 for both
rendition layout: packed-alpha for both
visible rendition: 3840x670 for both
VP9 coded surface: 3840x1348
H.265 coded surface: 3840x1352 with a four-row bottom crop to 3840x1348
VP9 CRF: 40
H.265 CRF: 30
VP9 normalized deadline: best
H.265 normalized preset: veryslow
```

### Task 3: Implement the React interaction

**Files:**
- Create: `examples/lend-borrow-react/src/main.tsx`
- Create: `examples/lend-borrow-react/src/styles.css`

- [ ] **Step 1: Implement the AVAL-bound component**

Use the two-source map and keep decoded frames outside React:

```tsx
const LEND_BORROW_SOURCES = {
  vp9: "/lend-borrow/vp9.avl",
  h265: "/lend-borrow/h265.avl"
} satisfies AvalSources;

const { aval, AvalComponent } = useAval({
  sources: LEND_BORROW_SOURCES,
  autoplay: true,
  autoBind: false
});
```

Render `AvalComponent` at its logical 3840×670 dimensions. Derive availability
from `aval.readiness` and `aval.lastError`; never seek an HTML video element.

- [ ] **Step 2: Add the active-state request**

The button handler sets a local pending flag, awaits
`aval.setState("active")`, ignores a superseding `AbortError`, and reports any
other request failure through application-owned UI. Disable it before
`interactiveReady`, while a request is pending, while `visualState` is
`active`, or while a transition is running.

- [ ] **Step 3: Add the page background picker**

Initialize React color state to `#000000`, bind it to the full-viewport stage's
`backgroundColor`, and update it from a labeled native
`<input type="color">`.

- [ ] **Step 4: Add the minimal responsive styling**

The stage fills `100svh`; the player retains `aspect-ratio: 3840 / 670` and
scales to the viewport width. The controls use a compact dark translucent
pill at the safe-area-aware bottom edge. Include visible keyboard focus, a
44-pixel minimum button target, and remove nonessential transitions under
`prefers-reduced-motion`.

- [ ] **Step 5: Typecheck and build**

Run:

```sh
npm run typecheck -w @pixel-point/aval-lend-borrow-react-example
npm run build -w @pixel-point/aval-lend-borrow-react-example
```

Expected: both commands pass and Vite copies the two `.avl` files and
`build.json` into `dist/lend-borrow`.

### Task 4: Document and verify the finished example

**Files:**
- Create: `examples/lend-borrow-react/README.md`

- [ ] **Step 1: Document operator commands and authored behavior**

Describe the exact local true-alpha source, `npm run
compile:lend-borrow-react`, `npm run lend-borrow-react`, the `[0,36)` idle
loop, the `[36,69)` one-shot active state, and the generated-asset directory.
Do not place FFmpeg command equivalents in the page or README.

- [ ] **Step 2: Run repository checks**

Run:

```sh
npm run docs:check
npm run typecheck -w @pixel-point/aval-lend-borrow-react-example
npm run build -w @pixel-point/aval-lend-borrow-react-example
git diff --check
```

Expected: all checks pass.

- [ ] **Step 3: Browser-verify the complete flow**

Start the example and verify:

1. exactly two direct AVAL sources exist (`vp9`, `h265`);
2. the player reaches `interactiveReady`;
3. the initial visual state is `idle`;
4. clicking `Activate` presents every active local frame `0…32` and later
   returns to `idle`;
5. changing the color input updates the page background;
6. the chosen background is visible through transparent motion pixels;
7. pixel measurements prove a smooth idle seam and visibly distinct active
   peak;
8. there are no console or page errors.

Run the automated version:

```sh
npm run test:lend-borrow-react
```

- [ ] **Step 4: Extract final FFmpeg equivalents**

From `public/lend-borrow/build.json.invocations`, select the representative
`:encode` invocation for each codec and substitute readable input/output
labels for AVAL's raw-video pipes. Report those commands only in the
final handoff, noting that AVAL executes one independent encode per graph unit.

- [ ] **Step 5: Review the final change set**

Run:

```sh
git status --short
git diff --stat
git diff --check
```

Expected: only the new example, root workspace metadata, generated AVAL
assets, and the implementation plan are changed.
