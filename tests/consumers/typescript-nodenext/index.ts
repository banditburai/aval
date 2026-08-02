import { defineAvalElement, type AvalElement } from "@pixel-point/aval-element";
import type {
  AvalAdapterCommands,
  AvalAdapterOptions
} from "@pixel-point/aval-element/adapter";
import { parseFrontIndex } from "@pixel-point/aval-format";
import type { MotionGraphDefinition } from "@pixel-point/aval-graph";
import { useAval, type AvalSources } from "@pixel-point/aval-react";
import type {
  AvalSvelteInstance,
  CreateAvalOptions
} from "@pixel-point/aval-svelte";

defineAvalElement();
const parse: typeof parseFrontIndex = parseFrontIndex;
const element: AvalElement | null = null;
const graph: MotionGraphDefinition | null = null;
const hook: typeof useAval = useAval;
const sources: AvalSources = { av1: "/motion.avl" };
const svelteOptions: CreateAvalOptions = { sources };
const sharedOptions: AvalAdapterOptions = svelteOptions;

function exerciseSvelteController(
  controller: AvalSvelteInstance
): AvalAdapterCommands {
  void controller.send("control.engage");
  controller.pause();
  return controller;
}

void [parse, element, graph, hook, sharedOptions, exerciseSvelteController];

// @ts-expect-error source-private paths are not public package API.
import("@pixel-point/aval-element/src/page-resources.js");
