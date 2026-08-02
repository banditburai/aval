# Svelte integration

Install the dedicated Svelte 5 adapter:

```sh
npm install @pixel-point/aval-svelte@1.0.0
```

The package renders the AVAL custom element, owns its ordered source markup,
and connects AVAL's semantic state to a read-only Svelte store. Its root export
is intended for Svelte-aware build and server-rendering tools.

## Basic usage

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

  let state = $state("idle");
  const aval = createAval(() => ({
    sources,
    state,
    autoplay: true,
    autoBind: true,
    onError(detail) {
      if (detail.fatal) reportPlaybackFailure(detail.failure.code);
    }
  }));
</script>

<AvalComponent {aval} width={160} height={160} aria-hidden={true} />
<button onclick={() => void aval.setState("favorite")}>Favorite</button>
<p>Requested: {$aval.requestedState ?? "none"}</p>
<p>Visible: {$aval.visualState ?? "none"}</p>
```

Read reactive options inside the function passed to `createAval`. The adapter
re-evaluates that function in the component's reactive scope and updates the
same `<aval-player>` host when options or source URLs change. `sources`
requires at least one URL; selection always follows AV1, VP9, H.265, then H.264.

## Controller and component ownership

`createAval()` returns one stable object that is both a read-only Svelte store
and the command controller. `$aval` exposes readiness, requested and visual
state, transition status, pause and effective visibility, authored names, and
the latest normalized error. Commands include `prepare()`, `setState()`,
`send()`, `readyFor()`, `play()`, `pause()`, and `getDiagnostics()`.

Mount one `AvalComponent` for a controller at a time. The component accepts
Svelte-native HTML and ARIA attributes, `width`, `height`, and `bindTo`. It owns
its direct `<source>` children, so it intentionally does not accept a child
snippet.

Use `bindTo` when authored automatic bindings should follow another semantic
element:

```svelte
<script lang="ts">
  let button: HTMLButtonElement | null = $state(null);
  const aval = createAval(() => ({
    sources: FAVORITE_SOURCES,
    autoBind: true
  }));
</script>

<button bind:this={button} type="button" aria-pressed={favorite}>
  <AvalComponent {aval} bindTo={button} aria-hidden={true} />
  <span>Favorite</span>
</button>
```

## SSR, cleanup, and fallback UI

Server rendering produces inert `<aval-player>` markup with direct ordered
sources. In the browser, the adapter installs native listeners before custom
element registration and readiness preparation. Component teardown removes
adapter subscriptions without terminally calling `dispose()`; DOM
disconnection remains AVAL's resource-retirement authority.

`staticReady` is a successful reduced-motion, visibility, or decoder-admission
outcome, not a fatal fallback signal. AVAL never creates alternate UI.
Applications retain ownership of sibling fallback content and should reveal it
only for fatal errors, then recover at interactive readiness.
