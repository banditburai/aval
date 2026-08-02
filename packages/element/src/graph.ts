import {
  MotionGraphEngine,
  type GraphPresentation,
  type GraphEdgeDefinition,
  type GraphStateDefinition,
  type GraphTransitionDefinition,
  type MotionGraphDefinition
} from "@pixel-point/aval-graph";

import type {
  CompiledManifest as Manifest,
  Edge,
  Unit
} from "@pixel-point/aval-format";

type GraphManifest = Pick<
  Manifest,
  "initialState" | "states" | "edges" | "units"
>;

/**
 * Install the canonical graph reducer over an already validated AVAL
 * manifest. Keeping routing in the canonical reducer preserves request
 * joining, supersession, and transition semantics.
 */
export function createGraphEngine(
  manifest: Readonly<GraphManifest>,
  initialState = manifest.initialState,
  initialBody = false
): MotionGraphEngine {
  const engine = new MotionGraphEngine();
  engine.install(createGraphDefinition(manifest, initialState, initialBody));
  return engine;
}

export function graphLoopCrossed(
  before: Readonly<GraphPresentation> | null,
  after: Readonly<GraphPresentation> | null,
  graph: Readonly<MotionGraphDefinition>
): boolean {
  if (
    before?.kind !== "body" || after?.kind !== "body" ||
    before.state !== after.state || before.unitId !== after.unitId ||
    after.frameIndex !== 0
  ) return false;
  const unit = graph.states.find(({ id }) => id === after.state)?.body;
  return unit?.unitId === after.unitId && unit.kind === "loop" &&
    before.frameIndex === unit.frameCount - 1;
}

export function createGraphDefinition(
  manifest: Readonly<GraphManifest>,
  initialState: string,
  initialBody: boolean
): MotionGraphDefinition {
  const units = new Map(manifest.units.map((unit) => [unit.id, unit]));
  if (!manifest.states.some((state) => state.id === initialState)) {
    throw new RangeError("Unknown initial AVAL state");
  }
  const states = manifest.states.map((state): GraphStateDefinition => {
    const body = bodyUnit(units, state.bodyUnit);
    const base: GraphStateDefinition = Object.freeze({
      id: state.id,
      body: Object.freeze({
        unitId: body.id,
        kind: body.playback,
        frameCount: body.frameCount,
        ports: Object.freeze(body.ports.map((port) => Object.freeze({
          ...port,
          portalFrames: Object.freeze([...port.portalFrames])
        })))
      })
    });
    if (initialBody || state.id !== initialState || state.initialUnit === undefined) return base;
    const intro = unit(units, state.initialUnit);
    return Object.freeze({
      ...base,
      initialUnit: Object.freeze({
        unitId: intro.id,
        frameCount: intro.frameCount
      })
    });
  });
  return Object.freeze({
    initialState,
    states: Object.freeze(states),
    edges: Object.freeze(manifest.edges.map((edge) => graphEdge(edge, units)))
  });
}

function graphEdge(
  edge: Readonly<Edge>,
  units: ReadonlyMap<string, Unit>
): GraphEdgeDefinition {
  const common = {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    ...(edge.trigger === undefined
      ? {}
      : { trigger: Object.freeze({ ...edge.trigger }) }),
    start: Object.freeze({ ...edge.start }),
    continuity: edge.continuity
  };
  return Object.freeze(edge.transition === undefined
    ? common
    : { ...common, transition: graphTransition(edge.transition, units) });
}

function graphTransition(
  transition: NonNullable<Edge["transition"]>,
  units: ReadonlyMap<string, Unit>
): GraphTransitionDefinition {
  const media = unit(units, transition.unit);
  if (transition.kind === "locked") {
    return Object.freeze({
      kind: "locked",
      unitId: media.id,
      frameCount: media.frameCount
    });
  }
  return Object.freeze({
    kind: "reversible",
    unitId: media.id,
    frameCount: media.frameCount,
    direction: transition.direction,
    ...(transition.reverseOf === undefined
      ? {}
      : { reverseOf: transition.reverseOf })
  });
}

function bodyUnit(
  units: ReadonlyMap<string, Unit>,
  id: string
): Extract<Unit, { readonly kind: "body" }> {
  const value = unit(units, id);
  if (value.kind !== "body") throw new Error("Invalid AVAL asset");
  return value;
}

function unit(
  units: ReadonlyMap<string, Unit>,
  id: string
): Unit {
  const value = units.get(id);
  if (value === undefined) throw new Error("Invalid AVAL asset");
  return value;
}
