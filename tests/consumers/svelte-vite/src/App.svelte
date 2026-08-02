<script lang="ts">
  import {
    AvalComponent,
    createAval,
    type AvalSources
  } from "@pixel-point/aval-svelte";

  const sources = {
    h264: "/motion/h264.avl"
  } satisfies AvalSources;
  const aval = createAval(() => ({
    sources,
    autoplay: false,
    autoBind: false
  }));
</script>

<AvalComponent {aval} width={160} height={90} aria-label="Motion" />
<output>{$aval.readiness}</output>
