import type { ProductionRendition as Rendition } from
  "@pixel-point/aval-format";

import { Asset } from "./asset.js";
import type { DecoderPoolDiagnostic } from "./decoder-pool.js";
import type {
  PlayerDecoderDiagnostic,
  PlayerInput,
  PlayerRendererDiagnostic
} from "./player-contract.js";
import type { RendererFailureDiagnostic } from
  "./renderer-diagnostics.js";
import { Renderer } from "./renderer.js";
import {
  reportPlayerResourceBytes,
  type PlayerResourceBytes
} from "./player-resource-budget.js";

const MAX_RETAINED_RENDERER_DIAGNOSTICS = 16;
const EMPTY_GRAPH_DIAGNOSTIC = Object.freeze({
  requestedState: null,
  visualState: null,
  activeUnit: null,
  pendingUnit: null
}) satisfies Readonly<PlayerDecoderDiagnostic["graph"]>;

export function publishPlayerDecoderDiagnostics(
  input: Readonly<PlayerInput>,
  diagnostics: readonly Readonly<DecoderPoolDiagnostic>[],
  sourceIndex: number,
  rendition: Readonly<Rendition>,
  unitFor: (diagnostic: Readonly<DecoderPoolDiagnostic>) => string | null =
    () => null,
  graph: Readonly<PlayerDecoderDiagnostic["graph"]> = EMPTY_GRAPH_DIAGNOSTIC
): readonly Readonly<PlayerDecoderDiagnostic>[] {
  const enriched = Object.freeze(diagnostics.map((diagnostic) => Object.freeze({
    ...diagnostic,
    sourceIndex,
    rendition: rendition.id,
    codec: rendition.codec,
    unit: unitFor(diagnostic),
    graph
  }) satisfies Readonly<PlayerDecoderDiagnostic>));
  if (enriched.length > 0) {
    try { input.onDecoderDiagnostics?.(enriched); }
    catch { /* diagnostics cannot replace the playback outcome */ }
  }
  return enriched;
}

export function publishPlayerRendererDiagnostics(
  input: Readonly<PlayerInput>,
  diagnostics: readonly Readonly<RendererFailureDiagnostic>[],
  sourceIndex: number,
  rendition: Readonly<Rendition>
): readonly Readonly<PlayerRendererDiagnostic>[] {
  const enriched = Object.freeze(
    diagnostics.slice(-MAX_RETAINED_RENDERER_DIAGNOSTICS).map((diagnostic) =>
      Object.freeze({
        ...diagnostic,
        sourceIndex,
        rendition: rendition.id,
        codec: rendition.codec
      }) satisfies Readonly<PlayerRendererDiagnostic>
    )
  );
  if (enriched.length > 0) {
    try { input.onRendererDiagnostics?.(enriched); }
    catch { /* diagnostics cannot replace the playback outcome */ }
  }
  return enriched;
}

export function reportCurrentPlayerResourceBytes(
  input: Readonly<Pick<PlayerInput, "onResourceBytes">>,
  asset: Asset | null,
  decoderBytes = 0,
  renderer: Renderer | null = null,
  enforceMaximum = false
): void {
  reportPlayerResourceBytes(input, asset === null ? null : playerResourceBytes(
    asset,
    decoderBytes,
    renderer,
    enforceMaximum
  ));
}

export function playerResourceBytes(
  asset: Asset,
  decoderBytes: number,
  renderer: Renderer | null,
  enforceMaximum = false
): Readonly<PlayerResourceBytes> {
  const snapshot = asset.snapshot();
  return Object.freeze({
    metadataBytes: snapshot.metadataBytes,
    residentBlobBytes: snapshot.residentBlobBytes,
    decoderBytes,
    rendererRuntimeBytes: renderer?.snapshot().runtimeBytes ?? 0,
    maximumBytes: asset.manifest.limits.maxRuntimeBytes,
    enforceMaximum
  });
}
