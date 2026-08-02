import type { CompiledManifest as Manifest, ProductionRendition as Rendition } from
  "@pixel-point/aval-format";

import { createGraphDefinition } from "./graph.js";
import type { Metadata, PlayerSnapshot } from "./player-contract.js";
import type { PlayerCandidateDescriptor } from "./player-media-contract.js";
import type { Renderer } from "./renderer.js";

export const EMPTY_MEDIA_PRESENTATION: PlayerSnapshot["presentation"] =
  Object.freeze({
    cssWidth: 0,
    cssHeight: 0,
    backingWidth: 0,
    backingHeight: 0,
    effectiveDprX: 0,
    effectiveDprY: 0,
    stagingBytes: 0,
    residentBytes: 0,
    textureBytes: 0,
    runtimeBytes: 0,
    pendingOperations: 0,
    sourceCopiesInFlight: 0,
    resourceCount: 0,
    contextListenerCount: 0
  });

export function createPlayerCandidateDescriptor(
  manifest: Readonly<Manifest>,
  rendition: Readonly<Rendition>,
  sourceIndex: number,
  initialState: string,
  initialBody: boolean
): Readonly<PlayerCandidateDescriptor> {
  const eventNames = [...new Set(manifest.edges.flatMap((edge) =>
    edge.trigger?.type === "event" ? [edge.trigger.name] : []
  ))];
  const metadata = Object.freeze({
    initialState: manifest.initialState,
    stateNames: Object.freeze(manifest.states.map(({ id }) => id)),
    eventNames: Object.freeze(eventNames),
    bindings: Object.freeze(manifest.bindings.map((binding) =>
      Object.freeze({ ...binding })
    )),
    canvas: Object.freeze({
      width: manifest.canvas.width,
      height: manifest.canvas.height,
      fit: manifest.canvas.fit,
      pixelAspect: Object.freeze([
        manifest.canvas.pixelAspect[0],
        manifest.canvas.pixelAspect[1]
      ] as const)
    })
  }) satisfies Readonly<Metadata>;
  return Object.freeze({
    metadata,
    graph: createGraphDefinition(manifest, initialState, initialBody),
    frameDurationMs: 1_000 * manifest.frameRate.denominator /
      manifest.frameRate.numerator,
    rendition: Object.freeze({
      id: rendition.id,
      codec: rendition.codec,
      bitDepth: rendition.bitDepth,
      sourceIndex
    })
  });
}

export function rendererPresentation(
  snapshot: ReturnType<Renderer["snapshot"]>
): PlayerSnapshot["presentation"] {
  const {
    backendDetails: _backendDetails,
    failure: _failure,
    contextLossCount: _contextLossCount,
    contextRecoveryCount: _contextRecoveryCount,
    ...presentation
  } = snapshot;
  return Object.freeze(presentation);
}
