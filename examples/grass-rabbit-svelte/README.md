# Grass Rabbit for Svelte

This Vite application renders the canonical Grass Rabbit asset through the
public `@pixel-point/aval-svelte` package. It demonstrates the controller store,
reactive status UI, authored hover and focus behavior, and application-owned
static and fatal fallbacks.

## Run it

From the repository root:

```sh
npm run grass-rabbit-svelte
```

Open the printed local URL. Hover the rabbit, or focus it with the keyboard, to
enter its authored hover state.

Create a production build with:

```sh
npm run build:public-packages
npm run build -w @pixel-point/aval-grass-rabbit-svelte-example
```

The production site is written to `examples/grass-rabbit-svelte/dist`.

## Component recipe

The page creates one stable controller and passes it to the exported component:

```svelte
<script lang="ts">
  import { AvalComponent, createAval } from "@pixel-point/aval-svelte";

  const aval = createAval(() => ({
    sources: {
      av1: "/grass-rabbit/av1.avl",
      vp9: "/grass-rabbit/vp9.avl",
      h265: "/grass-rabbit/h265.avl",
      h264: "/grass-rabbit/h264.avl"
    },
    autoplay: true,
    autoBind: true
  }));
</script>

<AvalComponent
  {aval}
  width={640}
  height={360}
  role="img"
  aria-label="Grass rabbit animation"
/>

<p>{$aval.readiness}</p>
<p>{$aval.visualState}</p>
```

`AvalComponent` keeps one player host and its ordered codec sources mounted.
The controller is a read-only Svelte store, so `$aval` updates only the status
labels while AVAL owns playback and authored input bindings.

## Assets and fallback UI

The checked-in compiled assets remain canonical in `examples/grass-rabbit`.
The example's `predev` and `prebuild` scripts copy the four codec renditions and
interaction marker into its ignored `public` directory. Update the canonical
assets and rerun either command instead of editing the copies.

AVAL owns the motion host. This application owns the surrounding instructions,
static policy explanation, and fatal-error message as component siblings.
