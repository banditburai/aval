<script lang="ts">
  import { AvalComponent, createAval } from "@pixel-point/aval-svelte";

  const RABBIT_SOURCES = {
    av1: "/grass-rabbit/av1.avl",
    vp9: "/grass-rabbit/vp9.avl",
    h265: "/grass-rabbit/h265.avl",
    h264: "/grass-rabbit/h264.avl"
  } as const;

  const READINESS_LABELS = {
    unready: "Loading",
    metadataReady: "Loading media",
    visualReady: "Visual ready",
    interactiveReady: "Interactive",
    staticReady: "Static",
    disposed: "Unavailable",
    error: "Error"
  } as const;

  const EXPERIENCE_LABELS = {
    unready: "Preparing",
    metadataReady: "Preparing",
    visualReady: "Starting",
    interactiveReady: "Live",
    staticReady: "Motion inactive",
    disposed: "Unavailable",
    error: "Unavailable"
  } as const;

  let requestedState = $state("idle");
  let showHint = $state(true);
  let fatalMessage = $state<string | null>(null);

  const aval = createAval(() => ({
    sources: RABBIT_SOURCES,
    state: requestedState,
    autoplay: true,
    autoBind: true,
    onRequestedStateChange({ to }) {
      requestedState = to;
    },
    onVisualStateChange({ to }) {
      if (to !== "idle") showHint = false;
    },
    onError(detail) {
      if (detail.fatal) fatalMessage = detail.failure.message;
    }
  }));

  const presented = $derived(
    $aval.readiness === "visualReady" ||
      $aval.readiness === "interactiveReady"
  );
  const interactive = $derived($aval.readiness === "interactiveReady");
  const staticReady = $derived($aval.readiness === "staticReady");
  const unavailable = $derived(
    fatalMessage !== null ||
      $aval.readiness === "disposed" ||
      $aval.readiness === "error"
  );
  const readinessLabel = $derived(READINESS_LABELS[$aval.readiness]);
  const experienceLabel = $derived(
    unavailable ? "Unavailable" : EXPERIENCE_LABELS[$aval.readiness]
  );
  const visualStateLabel = $derived(stateLabel($aval.visualState));
  const instruction = $derived(
    unavailable
      ? "Motion is unavailable for this preview."
      : staticReady
        ? "Motion is inactive for this preview."
        : interactive
          ? "Hover or focus the rabbit to run its authored interaction."
          : "Preparing the animation."
  );
  const failureMessage = $derived(
    fatalMessage ?? "The runtime is unavailable. Refresh the page to try again."
  );

  function stateLabel(state: string | null): string {
    if (state === null) return "Waiting";
    const words = state
      .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
      .replaceAll(/[-_]/g, " ");
    return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  }
</script>

<svelte:head>
  <meta name="theme-color" content="#f2efe7" />
</svelte:head>

<div class="site-shell">
  <header class="site-header">
    <div class="header-inner">
      <div class="brand-lockup">
        <a class="brand" href="/" aria-label="Homepage">AVAL</a>
        <span class="framework-label">Svelte example</span>
      </div>
      <a
        class="repository-link"
        href="https://github.com/pixel-point/aval"
        target="_blank"
        rel="noreferrer"
      >
        View repository
      </a>
    </div>
  </header>

  <main id="main-content">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Svelte 5 + Vite</p>
        <div class="hero-heading">
          <h1>AVAL, at home in Svelte.</h1>
          <p>
            Create one motion controller, render its component, and let Svelte
            observe state changes without owning the animation loop.
          </p>
        </div>
        <dl class="hero-details">
          <div>
            <dt>One store</dt>
            <dd>The controller and its reactive status share one identity.</dd>
          </div>
          <div>
            <dt>Authored input</dt>
            <dd>Hover and focus behavior stays inside the asset.</dd>
          </div>
        </dl>
      </div>

      <section class="rabbit-card" aria-labelledby="demo-title">
        <div class="rabbit-card-header">
          <div>
            <h2 id="demo-title">Grass Rabbit</h2>
            <p id="rabbit-instructions">{instruction}</p>
          </div>
          <span class="experience-status" data-testid="rabbit-experience-status">
            <span class:live={interactive} aria-hidden="true"></span>
            {experienceLabel}
          </span>
        </div>

        <div
          class="rabbit-stage"
          data-ready={presented ? "true" : "false"}
          data-failed={unavailable ? "true" : "false"}
        >
          {#if showHint && interactive && !unavailable}
            <span class="rabbit-interaction-hint" aria-hidden="true">
              <img
                src="/interaction-hotspot.svg"
                alt=""
                width="44"
                height="44"
                draggable="false"
              />
            </span>
          {/if}

          <AvalComponent
            {aval}
            class="rabbit-player"
            width={640}
            height={360}
            tabindex={interactive ? 0 : -1}
            role="img"
            aria-label="Grass rabbit animation"
            aria-describedby="rabbit-instructions"
            aria-hidden={unavailable || staticReady}
            data-testid="grass-rabbit-player"
          />

          {#if staticReady && !unavailable}
            <div class="stage-fallback" data-kind="static">
              <div>
                <p>Motion is inactive.</p>
                <p>This animation is inactive under the current runtime policy.</p>
              </div>
            </div>
          {/if}

          {#if unavailable}
            <div class="stage-fallback" data-kind="error" role="alert">
              <div>
                <p>The motion could not load.</p>
                <p>{failureMessage}</p>
              </div>
            </div>
          {/if}
        </div>

        <dl class="status-grid" aria-live="polite">
          <div>
            <dt>Readiness</dt>
            <dd data-testid="rabbit-readiness">{readinessLabel}</dd>
          </div>
          <div>
            <dt>Visual state</dt>
            <dd data-testid="rabbit-visual-state">{visualStateLabel}</dd>
          </div>
          <div>
            <dt>Transition</dt>
            <dd data-testid="rabbit-transition">
              {$aval.isTransitioning ? "Transitioning" : "At rest"}
            </dd>
          </div>
        </dl>
      </section>
    </section>

    <section class="ownership-section" aria-labelledby="ownership-title">
      <div class="ownership-inner">
        <div>
          <p class="section-kicker">Clear ownership</p>
          <h2 id="ownership-title">Svelte observes. AVAL performs.</h2>
        </div>
        <dl class="ownership-grid">
          <div>
            <dt>Readiness</dt>
            <dd>Know when the asset can paint, respond, or present a static frame.</dd>
          </div>
          <div>
            <dt>Visual state</dt>
            <dd>Reflect the authored state that viewers actually see right now.</dd>
          </div>
          <div>
            <dt>Transitions</dt>
            <dd>React to graph movement without subscribing to DOM events yourself.</dd>
          </div>
        </dl>
      </div>
    </section>
  </main>

  <footer>
    <div>
      <p>Built with Svelte, Vite, and the public AVAL Svelte package.</p>
      <p>Grass Rabbit · Technical preview</p>
    </div>
  </footer>
</div>
