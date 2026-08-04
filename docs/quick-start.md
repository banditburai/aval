# Quick start

Compile an existing project directly through the scoped npm CLI, then install
the browser runtime in the consuming application:

```sh
npx @pixel-point/aval-compiler compile motion.json --out dist/motion
npm install @pixel-point/aval-element@1.0.0
```

npx downloads the compiler into npm's cache and runs its sole `avl` binary
without adding it to the project. Serve the emitted bundle through the
application's normal package-aware development and production workflow, then
register the element once and use ordinary markup like this illustrative
snippet:

## Required consumer failure handling

Using AVAL requires an application-owned fatal-error boundary. Unsupported
browsers and exhausted codec qualification reject `prepare()` with
`AvalPlaybackError` and raise one fatal `error` event. AVAL never supplies or
activates alternate presentation, so the application must decide whether to
show a sibling video, image, text, another renderer, or nothing. Install the
direct `error` listener before registering the element, and branch on
`failure.code` such as `unsupported-profile` or `unsupported-browser` rather
than parsing the message.

```html
<script type="module" src="/motion.js"></script>

<aval-player id="motion" width="320" height="320">
  <source src="/my-motion/av1.avl" data-codec="av1">
  <source src="/my-motion/vp9.avl" data-codec="vp9">
  <source src="/my-motion/h265.avl" data-codec="h265">
  <source src="/my-motion/h264.avl" data-codec="h264">
</aval-player>
<img id="motion-unavailable" src="/my-motion.png" alt="" hidden>
```

Use the exact `sourceMarkup` emitted in your bundle's `build.json`.
`data-codec` is a family declaration; exact codec levels remain inside each
asset manifest. Candidate selection ignores markup order and always attempts
AV1, VP9, H.265, then H.264. H.264 is therefore used only after all present
modern families are unavailable or fail closed provisional codec/output checks.

```js
// motion.js, resolved by your package-aware web build
import { AvalPlaybackError, defineAvalElement } from "@pixel-point/aval-element";

const motion = document.querySelector("#motion");
const unavailable = document.querySelector("#motion-unavailable");
motion.addEventListener("error", (event) => {
  if (event.detail.fatal) unavailable.hidden = false;
});
motion.addEventListener("readinesschange", () => {
  if (motion.readiness === "interactiveReady") unavailable.hidden = true;
});
defineAvalElement();

try {
  await motion.prepare();
} catch (error) {
  if (!(error instanceof AvalPlaybackError)) throw error;
}
```

A one-state compiled body loops without JavaScript seeking or a loop range.
The package root is SSR-safe and has no registration side effect. Client-only
pages may instead import `@pixel-point/aval-element/auto`.

## React applications

Install `@pixel-point/aval-react@1.0.0` and pass the compiled asset URLs
directly to `useAval()`:

```tsx
import { useAval } from "@pixel-point/aval-react";

export function Motion() {
  const { aval, AvalComponent } = useAval({
    sources: {
      av1: "/my-motion/av1.avl",
      vp9: "/my-motion/vp9.avl",
      h265: "/my-motion/h265.avl",
      h264: "/my-motion/h264.avl"
    },
    state: "idle",
    autoplay: true,
    autoBind: true
  });

  return (
    <>
      <AvalComponent width={320} height={320} aria-hidden />
      {aval.lastError?.fatal && <img src="/my-motion.png" alt="" />}
    </>
  );
}
```

The adapter renders the direct source children, installs failure listeners
before registration, and is safe to import during server rendering. See the
[React integration guide](element/react.md) for state timing, authored events,
manual playback, and binding a motion to another semantic control.

## Svelte applications

Install `@pixel-point/aval-svelte@1.0.0` and create a controller from a reactive
option getter:

```svelte
<script lang="ts">
  import { AvalComponent, createAval } from "@pixel-point/aval-svelte";

  const aval = createAval(() => ({
    sources: {
      av1: "/my-motion/av1.avl",
      vp9: "/my-motion/vp9.avl",
      h265: "/my-motion/h265.avl",
      h264: "/my-motion/h264.avl"
    },
    state: "idle",
    autoplay: true,
    autoBind: true
  }));
</script>

<AvalComponent {aval} width={320} height={320} aria-hidden={true} />
{#if $aval.lastError?.fatal}<img src="/my-motion.png" alt="" />{/if}
```

The controller is a read-only Svelte store plus the same state, event,
preparation, and playback commands as the React adapter. See the
[Svelte integration guide](element/svelte.md) for reactive options, SSR,
automatic bindings, and cleanup.

The compiler requires a caller-installed FFmpeg/FFprobe build with libx264. It
never downloads or bundles native tools. See [compiler setup](compiler.md) and
[browser support](browser-support.md). See
[failure handling and reduced motion](element/fallback-and-reduced-motion.md)
for the complete consumer-owned fallback contract.
