<script lang="ts">
  import { defineAvalElement } from "@pixel-point/aval-element";
  import { AvalComponent, createAval } from "../../src/index.js";

  defineAvalElement();

  let configured = $state(true);
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
<AvalComponent
  {aval}
  width={configured ? 160 : undefined}
  height={configured ? 90 : undefined}
  data-testid="player"
/>
<output data-testid="invalid-configuration-errors">
  {invalidConfigurationErrors}
</output>
<AvalComponent aval={invalidAval} data-testid="invalid-player" />
