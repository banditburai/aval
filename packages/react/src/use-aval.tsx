"use client";

import {
  createElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type HTMLAttributes,
  type RefCallback
} from "react";
import {
  createAvalAdapterBinding,
  createAvalAdapterConfiguration,
  type AvalAdapterBinding,
  type AvalAdapterRenderOptions
} from "@pixel-point/aval-element/adapter";

import type {
  AvalBindingTarget,
  AvalComponentProps,
  AvalReactInstance,
  UseAvalOptions,
  UseAvalResult
} from "./types.js";

const useCommitEffect = typeof document === "undefined"
  ? useEffect
  : useLayoutEffect;

export function useAval(options: Readonly<UseAvalOptions>): UseAvalResult {
  const configuration = createAvalAdapterConfiguration(options);
  const [binding] = useState(() => createAvalAdapterBinding(configuration));

  useCommitEffect(() => {
    binding.commit(configuration);
  }, [binding, configuration]);

  const status = useSyncExternalStore(
    binding.subscribeStatus,
    binding.getStatus,
    binding.getServerStatus
  );
  const AvalComponent = useMemo<ComponentType<AvalComponentProps>>(() => {
    function BoundAvalComponent(props: AvalComponentProps) {
      return createElement(AvalHost, { ...props, binding });
    }
    BoundAvalComponent.displayName = "AvalComponent";
    return BoundAvalComponent;
  }, [binding]);
  const aval = useMemo<AvalReactInstance>(() => Object.freeze({
    ...status,
    prepare: binding.prepare,
    setState: binding.setState,
    send: binding.send,
    readyFor: binding.readyFor,
    play: binding.play,
    pause: binding.pause,
    getDiagnostics: binding.getDiagnostics
  }), [binding, status]);

  return useMemo(() => Object.freeze({ aval, AvalComponent }), [
    aval,
    AvalComponent
  ]);
}

interface AvalHostProps extends AvalComponentProps {
  readonly binding: AvalAdapterBinding;
}

function AvalHost({
  binding,
  bindTo,
  width,
  height,
  ...htmlProps
}: AvalHostProps) {
  const render = useSyncExternalStore(
    binding.subscribeOptions,
    binding.getRenderOptions,
    binding.getRenderOptions
  );

  useEffect(() => {
    binding.finalizeBindingTarget(resolveBindingTarget(bindTo));
  });
  useCommitEffect(
    () => () => binding.clearBindingTarget(),
    [binding]
  );
  useEffect(
    () => binding.beginReadyPreparation(),
    [binding, render.sourceKey]
  );

  return createElement(
    "aval-player",
    hostProperties(binding.attach, render, width, height, htmlProps),
    ...render.sources.map(({ codec, src }) => createElement("source", {
      key: codec,
      src,
      "data-codec": codec
    }))
  );
}

type AvalHostProperties = HTMLAttributes<HTMLElement> & Readonly<{
  ref: RefCallback<HTMLElement>;
  state: AvalAdapterRenderOptions["state"];
  motion: AvalAdapterRenderOptions["motion"];
  fit: AvalAdapterRenderOptions["fit"];
  crossorigin: AvalAdapterRenderOptions["crossOrigin"];
  autoplay: "visible" | "manual";
  bindings: "auto" | "none";
  width: number | undefined;
  height: number | undefined;
}>;

function hostProperties(
  ref: RefCallback<HTMLElement>,
  render: Readonly<AvalAdapterRenderOptions>,
  width: number | undefined,
  height: number | undefined,
  htmlProps: Omit<AvalComponentProps, "bindTo" | "width" | "height">
): AvalHostProperties {
  return {
    ...stringifyBooleanAria({ ...htmlProps }),
    ref,
    state: render.state,
    motion: render.motion,
    fit: render.fit,
    crossorigin: render.crossOrigin,
    autoplay: render.autoplay ? "visible" : "manual",
    bindings: render.autoBind ? "auto" : "none",
    width,
    height
  };
}

function stringifyBooleanAria(
  properties: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([name, value]) => [
    name,
    name.startsWith("aria-") && typeof value === "boolean"
      ? String(value)
      : value
  ]));
}

function resolveBindingTarget(
  target: AvalBindingTarget | undefined
): Element | null {
  if (target == null) return null;
  return "current" in target ? target.current : target;
}
