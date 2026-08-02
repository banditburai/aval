import type {
  PlayerDecoderDiagnostic,
  PlayerRendererDiagnostic
} from "./player-contract.js";

const MAX_RETAINED_DIAGNOSTICS = 16;

export function mergePlayerDecoderDiagnostics(
  current: readonly Readonly<PlayerDecoderDiagnostic>[],
  incoming: readonly Readonly<PlayerDecoderDiagnostic>[]
): readonly Readonly<PlayerDecoderDiagnostic>[] {
  if (incoming.length === 0) return current;
  const bySourceLane = new Map<string, Readonly<PlayerDecoderDiagnostic>>(
    current.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic] as const)
  );
  let changed = false;
  for (const diagnostic of incoming) {
    const key = diagnosticKey(diagnostic);
    if (bySourceLane.has(key)) continue;
    bySourceLane.set(key, diagnostic);
    changed = true;
  }
  if (!changed) return current;
  return Object.freeze(
    [...bySourceLane.values()]
      .sort((left, right) =>
        left.sourceIndex - right.sourceIndex || left.lane - right.lane
      )
      .slice(-MAX_RETAINED_DIAGNOSTICS)
  );
}

export function mergePlayerRendererDiagnostics(
  current: readonly Readonly<PlayerRendererDiagnostic>[],
  incoming: readonly Readonly<PlayerRendererDiagnostic>[]
): readonly Readonly<PlayerRendererDiagnostic>[] {
  if (incoming.length === 0) return current;
  const retained = new Set(current);
  const merged = [...current];
  for (const diagnostic of incoming) {
    if (retained.has(diagnostic)) continue;
    retained.add(diagnostic);
    merged.push(diagnostic);
  }
  if (merged.length === current.length) return current;
  return Object.freeze(merged.slice(-MAX_RETAINED_DIAGNOSTICS));
}

function diagnosticKey(
  diagnostic: Readonly<PlayerDecoderDiagnostic>
): string {
  return `${String(diagnostic.sourceIndex)}:${String(diagnostic.lane)}`;
}
