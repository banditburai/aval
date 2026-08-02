<script lang="ts">
  import { defineAvalElement } from "@pixel-point/aval-element";
  import { AvalComponent, createAval } from "../../src/index.js";

  defineAvalElement();

  let configured = $state(true);
  let mounted = $state(true);
  let controllerProbe = $state("not-run");
  const aval = createAval(() => ({
    sources: { h264: "/missing-motion.avl" },
    autoplay: false,
    autoBind: false,
    ...(configured ? {
      state: "idle",
      motion: "full" as const,
      fit: "contain" as const,
      crossOrigin: "anonymous" as const
    } : {})
  }));
  let invalidConfigurationErrors = $state(0);
  const invalidAval = createAval(() => ({
    sources: { h264: "/missing-invalid-motion.avl" },
    state: "not an authored identifier",
    autoplay: false,
    autoBind: false,
    onError(detail) {
      if (
        detail.failure.code === "invalid-configuration" &&
        detail.failure.operation === "state"
      ) invalidConfigurationErrors += 1;
    }
  }));
</script>

<button type="button" onclick={() => { configured = false; }}>
  Clear optional attributes
</button>
<button type="button" onclick={() => { mounted = false; }}>
  Unmount player
</button>
<button type="button" onclick={() => { mounted = true; }}>
  Remount player
</button>
<button type="button" onclick={() => {
  controllerProbe = aval.getDiagnostics() === null ? "detached" : "attached";
}}>
  Inspect controller
</button>
{#if mounted}
  <AvalComponent
    {aval}
    width={configured ? 160 : undefined}
    height={configured ? 90 : undefined}
    data-testid="player"
  />
{/if}
<output data-testid="controller-probe">{controllerProbe}</output>
<output data-testid="controller-readiness">{$aval.readiness}</output>
<output data-testid="invalid-configuration-errors">
  {invalidConfigurationErrors}
</output>
<AvalComponent aval={invalidAval} data-testid="invalid-player" />
