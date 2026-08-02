# @pixel-point/aval-svelte

Svelte 5 integration for AVAL interactive motion. The package renders the
public AVAL custom element while keeping playback and media ownership in the
element runtime.

```svelte
<script lang="ts">
  import {
    AvalComponent,
    createAval,
    type AvalSources
  } from "@pixel-point/aval-svelte";

  const sources = {
    av1: "/motion/favorite/av1.avl",
    vp9: "/motion/favorite/vp9.avl",
    h265: "/motion/favorite/h265.avl",
    h264: "/motion/favorite/h264.avl"
  } satisfies AvalSources;
  const aval = createAval(() => ({
    sources,
    state: "idle",
    autoplay: true,
    autoBind: true
  }));
</script>

<AvalComponent {aval} width={160} height={160} aria-hidden={true} />
<button onclick={() => void aval.setState("favorite")}>Favorite</button>
<p>Readiness: {$aval.readiness}</p>
```

`sources` requires at least one codec URL and accepts URL strings only. The
browser preference order is AV1, VP9, H.265, then H.264. Put reactive option
reads inside the function passed to `createAval`; changing a source URL or
callback updates the same player element in place.

`AvalComponent` requires the controller returned by `createAval`. One
controller can be mounted by one component at a time. The component accepts
Svelte-native HTML and ARIA attributes plus `width`, `height`, and `bindTo` for
associating authored automatic input bindings with another element. It owns its
direct `<source>` children, so it intentionally has no child snippet prop.

The controller is a read-only Svelte store. `$aval` exposes readiness,
requested and visual state, transition status, pause and visibility state,
authored names, and the last error. The same stable object provides commands
for preparation, state changes, authored events, playback, and diagnostics.

The root export is intended for Svelte-aware tooling and server rendering. SSR
emits inert `<aval-player>` markup; custom-element registration and readiness
work begin only after the component mounts in a browser. Component teardown
releases adapter resources without terminally disposing the AVAL element.

AVAL does not render fallback UI. Applications should own sibling alternate
content and reveal it only for fatal errors, then recover according to their
interactive-readiness policy.
