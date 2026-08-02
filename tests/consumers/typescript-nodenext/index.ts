import { defineAvalElement, type AvalElement } from "@pixel-point/aval-element";
import { parseFrontIndex } from "@pixel-point/aval-format";
import type { MotionGraphDefinition } from "@pixel-point/aval-graph";
import { useAval, type AvalSources } from "@pixel-point/aval-react";

defineAvalElement();
const parse: typeof parseFrontIndex = parseFrontIndex;
const element: AvalElement | null = null;
const graph: MotionGraphDefinition | null = null;
const hook: typeof useAval = useAval;
const sources: AvalSources = { av1: "/motion.avl" };
void [parse, element, graph, hook, sources];

// @ts-expect-error source-private paths are not public package API.
import("@pixel-point/aval-element/src/page-resources.js");
