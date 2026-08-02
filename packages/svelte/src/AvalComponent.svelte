<script lang="ts">
  import {
    createAvalAdapterConfiguration,
    type AvalAdapterBinding
  } from "@pixel-point/aval-element/adapter";

  import { getControllerRecord } from "./controller.js";
  import type { AvalComponentProps } from "./types.js";

  let {
    aval,
    bindTo = null,
    width,
    height,
    ...htmlAttributes
  }: AvalComponentProps = $props();
  let attachedBinding = $state<AvalAdapterBinding | null>(null);
  const isServer = typeof document === "undefined";

  const record = $derived(getControllerRecord(aval));
  const configuration = $derived(
    createAvalAdapterConfiguration(record.readOptions())
  );
  const renderOptions = $derived(configuration.render);
  const hostAttributes = $derived({
    ...stringifyBooleanAria(htmlAttributes),
    ...(isServer ? {
      state: renderOptions.state,
      motion: renderOptions.motion,
      fit: renderOptions.fit,
      crossorigin: renderOptions.crossOrigin
    } : {}),
    // Svelte otherwise applies native video's boolean autoplay serializer.
    // HTML attribute names are case-insensitive, so this becomes `autoplay`
    // in the DOM while retaining AVAL's string token in server markup.
    autoPlay: renderOptions.autoplay ? "visible" : "manual",
    bindings: renderOptions.autoBind ? "auto" : "none",
    ...(isServer ? { width, height } : {})
  });

  $effect(() => {
    record.binding.commit(configuration);
  });

  $effect(() => {
    attachedBinding?.finalizeBindingTarget(bindTo);
  });

  $effect(() => {
    const binding = attachedBinding;
    void renderOptions.sourceKey;
    return binding?.beginReadyPreparation();
  });

  function attach(node: HTMLElement) {
    $effect(() => {
      const binding = record.binding;
      binding.attach(node);
      attachedBinding = binding;
      return () => {
        binding.attach(null);
        attachedBinding = null;
      };
    });

    $effect(() => {
      setOptionalAttribute(node, "state", renderOptions.state);
      setOptionalAttribute(node, "motion", renderOptions.motion);
      setOptionalAttribute(node, "fit", renderOptions.fit);
      setOptionalAttribute(node, "crossorigin", renderOptions.crossOrigin);
      setOptionalAttribute(node, "width", width);
      setOptionalAttribute(node, "height", height);
    });
  }

  function setOptionalAttribute(
    node: HTMLElement,
    name: string,
    value: string | number | undefined
  ): void {
    if (value === undefined) node.removeAttribute(name);
    else node.setAttribute(name, String(value));
  }

  function stringifyBooleanAria(
    attributes: object
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(attributes).map(([name, value]) => [
        name,
        name.startsWith("aria-") && typeof value === "boolean"
          ? String(value)
          : value
      ])
    );
  }
</script>

<aval-player
  use:attach
  {...hostAttributes}
>
  {#each renderOptions.sources as source (source.codec)}
    <source src={source.src} data-codec={source.codec} />
  {/each}
</aval-player>
