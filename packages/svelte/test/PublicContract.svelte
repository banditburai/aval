<script lang="ts">
  import type { ComponentProps } from "svelte";
  import {
    AvalComponent,
    createAval,
    type AvalErrorDetail,
    type AvalSources,
    type AvalSvelteStatus
  } from "../src/index.js";

  const sources = {
    av1: "/motion/av1.avl",
    h264: "/motion/h264.avl"
  } satisfies AvalSources;
  const aval = createAval(() => ({
    sources,
    state: "idle",
    autoplay: true,
    autoBind: true,
    onError: (detail: Readonly<AvalErrorDetail>) => {
      void detail.failure.code;
    }
  }));
  let target: HTMLButtonElement | null = $state(null);

  function visualState(status: Readonly<AvalSvelteStatus>): string | null {
    return status.visualState;
  }

  type Props = ComponentProps<typeof AvalComponent>;
  type AssertFalse<Value extends false> = Value;
  type ComponentOwnsChildren = AssertFalse<
    "children" extends keyof Props ? true : false
  >;

  // @ts-expect-error at least one codec URL is required
  const emptySources: AvalSources = {};
  void emptySources;

  createAval(() => ({
    sources: {
      // @ts-expect-error Svelte source values are URL strings only
      h264: { src: "/motion.avl" }
    }
  }));

  // @ts-expect-error createAval accepts an option getter
  createAval({ sources });
</script>

<button bind:this={target} type="button">Activate</button>
<AvalComponent
  {aval}
  bindTo={target}
  width={160}
  height={90}
  class="motion"
  aria-label="Motion"
  aria-hidden={true}
/>
<p>{visualState($aval)}</p>
