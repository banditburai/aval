# AVAL Svelte Integration Design

**Date:** 2026-08-02  
**Status:** Approved by the request for autonomous brainstorming

## Objective

Add a public `@pixel-point/aval-svelte` package and a dedicated Svelte example.
The adapter should preserve the useful public concepts and runtime guarantees of
`@pixel-point/aval-react` while using Svelte's native component and store model.

```svelte
<script lang="ts">
  import {
    AvalComponent,
    createAval,
    type AvalSources
  } from "@pixel-point/aval-svelte";

  const sources = {
    vp9: "/motion/vp9.avl",
    h264: "/motion/h264.avl"
  } satisfies AvalSources;
  const aval = createAval(() => ({
    sources,
    state: "idle",
    autoplay: true,
    autoBind: true
  }));
</script>

<AvalComponent {aval} />
<button onclick={() => void aval.setState("active")}>Activate</button>
<p>{$aval.visualState}</p>
```

## API decision

Three shapes were considered:

1. An exact React-shaped factory returning a closure-bound component. This
   would require calling unsupported Svelte component internals or hiding live
   options in non-reactive objects.
2. A component-only API with `bind:aval`. This is concise but makes the
   controller absent until child initialization and weakens explicit ownership.
3. An explicit controller store passed to an exported component. A getter
   supplies options so Svelte can track live dependencies without generated
   component wrappers. This keeps ownership visible and supports multiple
   independent players without context.

Choose option 3. `createAval(() => options)` returns one stable
`AvalSvelteInstance` that is both a read-only Svelte store and the command
surface. The getter is evaluated inside `AvalComponent`'s reactive scope, so
changes to Svelte state used by `sources`, `state`, or callbacks update the
existing host. `AvalComponent` requires the instance through its `aval` prop. A
controller may be attached to one host at a time.

The subscribed value, `AvalSvelteStatus`, contains the same semantic fields as
the React instance:

- `mounted`
- `readiness`
- `requestedState`
- `visualState`
- `isTransitioning`
- `paused`
- `effectivelyVisible`
- `stateNames`
- `eventNames`
- `lastError`

The stable controller exposes the same commands: `prepare`, `setState`, `send`,
`readyFor`, `play`, `pause`, and `getDiagnostics`. Before mount, async commands
reject with `AvalNotReadyError`, boolean commands return `false`, `pause()` is a
no-op, and diagnostics return `null`.

The option getter preserves the React option names and meanings: `sources`,
`state`, `autoplay`, `autoBind`, `motion`, `fit`, `crossOrigin`, and the six
semantic callbacks. Defaults remain `autoplay: true` and `autoBind: true`.
Component props contain `aval`, `bindTo`, `width`, `height`, and Svelte-native
HTML and ARIA attributes forwarded to the host. The adapter exclusively owns
direct children, so it exposes no child snippet or raw-HTML escape hatch.

`bindTo` is `Element | null` because Svelte's `bind:this` already resolves an
element; React ref objects do not cross the framework boundary.

## Architecture

### Framework-neutral adapter core

The existing React source normalization and attachment state machine are
framework-neutral apart from ref resolution and React-branded names. Move that
logic into two focused modules in `@pixel-point/aval-element`: source/option
normalization and one host binding. A narrow, explicitly infrastructural
`@pixel-point/aval-element/adapter` subpath exposes an opaque binding factory,
configuration factory, and the contracts framework packages need. The element
root remains an end-user custom-element API. Environment injection, node ports,
implementation classes, and render-equality helpers stay internal. React keeps
its public API unchanged, and its only binding-target adapter resolves a React
ref to `Element | null`.

The shared core validates only the codec-keyed URL map and boolean adapter
options; element-authored values continue to be enforced by the element. It
does not render DOM or import either framework.

The shared binding owns one attachment record and one current readiness operation.
It installs native semantic and error listeners before calling
`defineAvalElement()`, subscribes to the element's stable `AvalSnapshot`, and
publishes a new store value only for a new snapshot identity. One close path
aborts readiness work, unsubscribes, clears `interactionTarget`, removes native
listeners, and restores the canonical unmounted status. It never calls
`dispose()`.

Callbacks are replaceable independently of the attachment, so reactive callback
props do not remount the host. A readiness operation is current only while its
identity, attachment, and source key remain current; stale or aborted completion
cannot call `onReady`.

The custom element remains the only playback and media-runtime owner. Neither
framework imports player internals or `@pixel-point/aval-element/auto`.

### Component rendering

`AvalComponent.svelte` renders one persistent `<aval-player>` and direct
`<source>` children in `SOURCE_CODEC_PRIORITY` order. Reactive URL changes
replace source attributes in place and create a new source key without remounting
the player. Declarative element attributes update through normal Svelte commits.

The host action performs the attach/upgrade sequence and owns teardown. Effects
update callbacks, binding target, and readiness preparation after committed prop
changes. Server rendering performs none of these effects and emits deterministic
inert markup.

## Package and release boundary

`@pixel-point/aval-svelte` is ESM-only and side-effect free. It has an exact
runtime dependency on `@pixel-point/aval-element` and a Svelte 5 peer dependency.
It exports one Svelte-aware root with `AvalComponent`, `createAval`, adapter
types, and the relevant re-exported element types. The root uses `types` and
`svelte` export conditions. It does not claim direct Node ESM support because
its JavaScript entry re-exports a raw `.svelte` component; SSR consumers load it
through Svelte-aware tooling.

The package is built with the official Svelte library packager so consumers
receive normal `.svelte` component source plus generated JavaScript and
declarations. The release provenance model gains an explicit Svelte-package
build kind instead of bypassing its existing fresh-build and tarball checks.
The fresh build receives a generated temporary tsconfig whose paths resolve
internal dependencies to the already-staged release declarations, matching the
existing TypeScript provenance guarantee. Only reviewed `.svelte`, JavaScript,
and declaration outputs are accepted for this package.

It joins the lockstep public release set, API classification, license policy,
SBOM, packed-consumer checks, and API report.

## Dedicated example

Create `examples/grass-rabbit-svelte` as a small Svelte 5, Vite, and TypeScript
application. It reuses the checked-in Grass Rabbit compiled assets through the
same asset-preparation pattern as the React example, avoiding duplicate binary
fixtures.

The page uses only the public Svelte package root. It creates one controller,
passes it to `AvalComponent`, displays semantic readiness/state, exercises an
authored interaction, and owns fatal fallback UI. The example is added to the
explicit workspace, root build/dev/typecheck scripts, and browser verification.

## Error and lifecycle semantics

- Native error detail is forwarded without wrapping.
- Callback exceptions are rethrown in a microtask so they do not corrupt
  element lifecycle work.
- Expected `AbortError` supersession remains a rejected command promise.
- `staticReady` is a successful readiness outcome.
- Component teardown retires only adapter resources; element disconnection
  remains runtime-retirement authority.
- Rendering the same controller in two components is a development-time error.
- No framework fallback is rendered or placed inside the player.

## Verification

Verification covers:

- source validation, fixed priority, boolean defaults, and source-key identity;
- stable pre-mount commands and store status;
- listener-before-registration ordering;
- attachment resource cleanup without disposal;
- one-host enforcement and binding-target replacement;
- snapshot-identity publication and stale readiness suppression;
- reactive component props and callbacks without host remount;
- deterministic SSR output through Svelte-aware SSR compilation;
- public Svelte type contracts;
- dedicated example typecheck, production build, and real browser interaction;
- workspace unit/browser tests, fresh public builds, API extraction,
  documentation checks, packed consumers, release policy, licenses, and SBOM.
