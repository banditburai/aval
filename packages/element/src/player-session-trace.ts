import type { MotionGraphDefinition, MotionGraphResult } from
  "@pixel-point/aval-graph";

import { ELEMENT_DECODER_CAPACITY } from "./decoder-capacity.js";
import type { PlayerMediaDrawReceipt } from "./player-media-contract.js";
import type { PlayerTraceObservation } from "./player-telemetry.js";

export interface PlayerSessionTraceInput {
  readonly graph: Readonly<MotionGraphDefinition>;
  readonly result: Readonly<MotionGraphResult>;
  readonly routeReady: boolean;
  readonly callbackStart: number;
  readonly submissionComplete: number;
  readonly rationalDeadlineUs: number | null;
  readonly media: Readonly<PlayerMediaDrawReceipt>;
}

export function createPlayerSessionTrace(
  input: Readonly<PlayerSessionTraceInput>
): Readonly<PlayerTraceObservation> {
  const { result, media } = input;
  if (media.unitId === null) throw new Error("Invalid AVAL media state");
  const presentation = result.presentation === null
    ? null : Object.freeze({ ...result.presentation });
  const graphPresentation = result.presentation;
  const edgeId = graphPresentation !== null &&
    (graphPresentation.kind === "locked" || graphPresentation.kind === "reversible")
    ? graphPresentation.edgeId
    : result.effects.find((effect) => effect.type === "transitionstart")?.edgeId;
  const edge = edgeId === undefined ? null : input.graph.edges.find(({ id }) =>
    id === edgeId
  );
  const path = edge?.id ?? (graphPresentation !== null &&
    (graphPresentation.kind === "body" || graphPresentation.kind === "intro" ||
      graphPresentation.kind === "static") ? graphPresentation.state : "graph");
  const frame = graphPresentation !== null && graphPresentation.kind !== "static"
    ? graphPresentation.frameIndex : 0;
  return Object.freeze({
    kind: result.operation === "tick" ? "content-tick" as const : "operation" as const,
    presentationOrdinal: result.snapshot.contentOrdinal?.toString() ?? null,
    rationalDeadlineUs: input.rationalDeadlineUs,
    callbackStartMicroseconds: Math.round(input.callbackStart * 1000),
    canvasSubmissionCompleteMicroseconds: Math.round(
      input.submissionComplete * 1000
    ),
    eligibleAnimationFrameOrdinal: null,
    graph: Object.freeze({
      operation: result.operation,
      snapshot: Object.freeze({
        ...result.snapshot,
        contentOrdinal: result.snapshot.contentOrdinal?.toString() ?? null
      }),
      presentation,
      effects: Object.freeze(result.effects.map((effect) =>
        Object.freeze({ ...effect })))
    }),
    routeReady: input.routeReady,
    selectedBoundary: edge?.start.type ?? null,
    scheduler: Object.freeze({
      generation: media.logicalRunId,
      activePath: path,
      sourceCursor: null,
      submittedCursor: null,
      decodedCursor: null,
      displayedCursor: Object.freeze({
        path,
        unit: media.unitId,
        unitInstance: media.logicalRunId ?? 0,
        localFrame: frame
      }),
      ringSize: media.openFrames,
      ringCapacity: ELEMENT_DECODER_CAPACITY.totalDecodedSurfaces
    }),
    submitted: Object.freeze([]),
    media: Object.freeze({
      kind: "frame",
      frame: Object.freeze({ unit: media.unitId, localFrame: frame })
    }),
    readbackTag: `${graphPresentation?.kind ?? "static"}:${path}:${media.unitId}:${String(frame)}`,
    readiness: "interactiveReady" as const,
    decodeLeadFrames: null,
    settledRequestIds: Object.freeze(result.effects.flatMap((effect) =>
      effect.type === "settle" ? effect.requestIds : []))
  });
}
