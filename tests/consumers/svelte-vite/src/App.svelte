<script lang="ts">
  import type {
    AvalAdapterCommands,
    AvalAdapterOptions
  } from "@pixel-point/aval-element/adapter";
  import {
    AvalComponent,
    createAval,
    type AvalSources,
    type AvalSvelteInstance,
    type CreateAvalOptions
  } from "@pixel-point/aval-svelte";

  const sources = {
    h264: "/motion/h264.avl"
  } satisfies AvalSources;
  const options: CreateAvalOptions = {
    sources,
    autoplay: false,
    autoBind: false
  };
  const sharedOptions: AvalAdapterOptions = options;
  const optionsFromShared: CreateAvalOptions = sharedOptions;
  const aval: AvalSvelteInstance = createAval(() => optionsFromShared);
  const commands: AvalAdapterCommands = aval;
</script>

<AvalComponent {aval} width={160} height={90} aria-label="Motion" />
<button type="button" onclick={() => { commands.pause(); }}>Pause motion</button>
<output>{$aval.readiness}</output>
