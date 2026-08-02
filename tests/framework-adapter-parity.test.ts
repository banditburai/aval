import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render as renderSvelte } from "svelte/server";
import { describe, expect, it } from "vitest";

import {
  useAval,
  type AvalReactInstance,
  type UseAvalOptions
} from "@pixel-point/aval-react";
import {
  AvalComponent as SvelteAvalComponent,
  createAval,
  type AvalSvelteInstance,
  type AvalSvelteStatus,
  type CreateAvalOptions
} from "@pixel-point/aval-svelte";

const COMMAND_NAMES = Object.freeze([
  "prepare",
  "setState",
  "send",
  "readyFor",
  "play",
  "pause",
  "getDiagnostics"
] as const);

const SOURCES = Object.freeze({
  h264: "/motion/h264.avl",
  h265: "/motion/h265.avl",
  vp9: "/motion/vp9.avl",
  av1: "/motion/av1.avl"
});

describe("framework adapter parity", () => {
  it("renders the same codec priority and canonical default tokens", () => {
    const react = renderReact({ sources: SOURCES });
    const svelte = renderSvelteController({ sources: SOURCES });

    expect(sourceOrder(react.markup)).toEqual(["av1", "vp9", "h265", "h264"]);
    expect(sourceOrder(svelte.markup)).toEqual(["av1", "vp9", "h265", "h264"]);
    expect(elementTokens(react.markup)).toEqual({
      autoplay: "visible",
      bindings: "auto"
    });
    expect(elementTokens(svelte.markup)).toEqual({
      autoplay: "visible",
      bindings: "auto"
    });
  });

  it("renders the same explicit tokens and exposes one command contract", () => {
    const options = Object.freeze({
      sources: SOURCES,
      autoplay: false,
      autoBind: false
    });
    const react = renderReact(options);
    const svelte = renderSvelteController(options);

    expect(elementTokens(react.markup)).toEqual({
      autoplay: "manual",
      bindings: "none"
    });
    expect(elementTokens(svelte.markup)).toEqual({
      autoplay: "manual",
      bindings: "none"
    });
    expect(commandNames(react.controller)).toEqual(COMMAND_NAMES);
    expect(commandNames(svelte.controller)).toEqual(COMMAND_NAMES);
    expect(readSvelteStatus(svelte.controller)).toEqual(
      reactStatus(react.controller)
    );
  });
});

function renderReact(options: Readonly<UseAvalOptions>): Readonly<{
  markup: string;
  controller: AvalReactInstance;
}> {
  let controller: AvalReactInstance | undefined;
  function Fixture() {
    const result = useAval(options);
    controller = result.aval;
    return createElement(result.AvalComponent);
  }
  const markup = renderToStaticMarkup(createElement(Fixture));
  if (controller === undefined) throw new Error("React controller was not rendered");
  return Object.freeze({ markup, controller });
}

function renderSvelteController(options: Readonly<CreateAvalOptions>): Readonly<{
  markup: string;
  controller: AvalSvelteInstance;
}> {
  const controller = createAval(() => options);
  const { body } = renderSvelte(SvelteAvalComponent, {
    props: { aval: controller }
  });
  return Object.freeze({ markup: body, controller });
}

function sourceOrder(markup: string): readonly string[] {
  return [...markup.matchAll(/data-codec="([^"]+)"/gu)].map((match) => match[1]!);
}

function elementTokens(markup: string): Readonly<{
  autoplay: string | null;
  bindings: string | null;
}> {
  const element = /<aval-player\b([^>]*)>/iu.exec(markup)?.[1] ?? "";
  return Object.freeze({
    autoplay: /\bautoplay="([^"]+)"/iu.exec(element)?.[1] ?? null,
    bindings: /\bbindings="([^"]+)"/u.exec(element)?.[1] ?? null
  });
}

function commandNames(controller: object): readonly string[] {
  const functions = Object.entries(controller)
    .filter(([name, value]) => name !== "subscribe" && typeof value === "function")
    .map(([name]) => name);
  return Object.freeze(functions);
}

function readSvelteStatus(controller: AvalSvelteInstance): Readonly<AvalSvelteStatus> {
  let status: Readonly<AvalSvelteStatus> | undefined;
  const unsubscribe = controller.subscribe((value) => {
    status = value;
  });
  unsubscribe();
  if (status === undefined) throw new Error("Svelte controller did not publish status");
  return status;
}

function reactStatus(controller: AvalReactInstance): Readonly<AvalSvelteStatus> {
  return Object.freeze({
    mounted: controller.mounted,
    readiness: controller.readiness,
    requestedState: controller.requestedState,
    visualState: controller.visualState,
    isTransitioning: controller.isTransitioning,
    paused: controller.paused,
    effectivelyVisible: controller.effectivelyVisible,
    stateNames: controller.stateNames,
    eventNames: controller.eventNames,
    lastError: controller.lastError
  });
}
