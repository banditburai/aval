import { describe, expect, it, vi } from "vitest";

import { emptyPlaybackLifecycleCounters } from
  "../src/playback-lifecycle.js";
import type {
  Metadata,
  PlayerDecoderDiagnostic,
  PlayerInput,
  PlayerSnapshot
} from "../src/player-contract.js";
import { PublicationGate } from "../src/player-publication-gate.js";
import {
  PlayerCandidateSelector,
  type PlayerCandidateHandle,
  type PlayerCandidateProbeInput,
  type PlayerCandidateProbeResult
} from "../src/player-selection.js";

const metadata = Object.freeze({
  initialState: "idle",
  stateNames: Object.freeze(["idle"]),
  eventNames: Object.freeze([]),
  bindings: Object.freeze([]),
  canvas: Object.freeze({
    width: 1,
    height: 1,
    pixelAspect: Object.freeze([1, 1] as const),
    fit: "contain" as const
  })
}) satisfies Readonly<Metadata>;

describe("PlayerCandidateSelector", () => {
  it("owns candidate identity, cursor, reports, diagnostics, and exhaustion", async () => {
    const calls: Readonly<PlayerCandidateProbeInput>[] = [];
    const diagnostic = decoderDiagnostic(0, 1, "high");
    const selectedPlayer = candidatePlayer();
    const foreignGate = publicationGate([]);
    const selector = new PlayerCandidateSelector(2, async (request) => {
      calls.push(request);
      if (calls.length === 1) return Object.freeze({
        kind: "rendition-rejected" as const,
        renditionId: "high",
        renditionCount: 2,
        reason: "codec-unsupported" as const,
        decoderDiagnostics: Object.freeze([diagnostic])
      });
      if (calls.length === 2) {
        return Object.freeze({
          ...candidateProbeResult("low", selectedPlayer, 2),
          candidateRank: 999,
          publications: foreignGate
        });
      }
      return Object.freeze({
        kind: "source-rejected" as const,
        reason: "no-video-rendition" as const
      });
    });
    const firstGate = publicationGate([]);

    const result = await selector.next(firstGate);

    expect(result).toMatchObject({
      player: selectedPlayer,
      candidateRank: 1,
      renditionId: "low",
      requiresQualification: true,
      publications: firstGate
    });
    expect(calls.map(({ sourceInputIndex, renditionIndex, candidateRank }) =>
      [sourceInputIndex, renditionIndex, candidateRank]
    )).toEqual([[0, 0, 0], [0, 1, 1]]);
    expect(calls[1]?.candidateReports).toMatchObject([{
      rendition: "high",
      rank: 0,
      outcome: "rejected",
      failure: { code: "unsupported-profile" }
    }]);
    expect(calls[1]?.decoderDiagnostics).toEqual([diagnostic]);

    selector.reject(result, Object.freeze({
      stage: "decode",
      cause: "decode-progress-timeout"
    }));
    const events: string[] = [];
    const exhaustedGate = publicationGate(events);
    exhaustedGate.input.onMetadata(metadata);
    await expect(selector.next(exhaustedGate)).rejects.toMatchObject({
      name: "NotSupportedError",
      failureCode: "unsupported-profile"
    });

    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({
      sourceInputIndex: 1,
      renditionIndex: 0,
      candidateRank: 2
    });
    expect(calls[2]?.candidateReports).toMatchObject([
      { rendition: "high", rank: 0, failure: { code: "unsupported-profile" } },
      { rendition: "low", rank: 1, failure: { code: "worker-decode-failure" } }
    ]);
    expect(calls[2]?.decoderDiagnostics).toEqual([diagnostic]);
    exhaustedGate.activate();
    expect(events).toEqual([]);
  });

  it("retires a candidate before carrying its diagnostics to the next probe", async () => {
    const operations: string[] = [];
    const diagnostic = decoderDiagnostic(0, 0, "main");
    const laterProbes: Readonly<PlayerCandidateProbeInput>[] = [];
    const selector = new PlayerCandidateSelector(2, async (request) => {
      if (request.sourceInputIndex === 0) return Object.freeze({
        ...candidateProbeResult("main", candidatePlayer({
          snapshot: () => {
            operations.push("snapshot");
            return playerSnapshot([diagnostic], 0);
          },
          dispose: async () => { operations.push("dispose"); }
        }))
      });
      laterProbes.push(request);
      return Object.freeze({
        kind: "source-rejected" as const,
        reason: "no-video-rendition" as const
      });
    });
    const events: string[] = [];
    const firstGate = publicationGate(events);
    firstGate.input.onMetadata(metadata);
    const first = await selector.next(firstGate);

    await expect(selector.retire(first)).resolves.toEqual({ retryAllowed: true });
    firstGate.activate();
    expect(events).toEqual([]);
    expect(operations).toEqual(["snapshot", "dispose"]);

    await expect(selector.next(publicationGate([]))).rejects.toMatchObject({
      name: "NotSupportedError"
    });
    expect(laterProbes[0]?.decoderDiagnostics).toEqual([diagnostic]);
  });

  it("always disposes and gives disposal failure precedence over snapshot failure", async () => {
    const snapshotError = new Error("snapshot failed");
    const disposalError = new Error("dispose failed");
    const operations: string[] = [];
    const selector = new PlayerCandidateSelector(1, async () =>
      candidateProbeResult("main", candidatePlayer({
          snapshot: () => {
            operations.push("snapshot");
            throw snapshotError;
          },
          dispose: async () => {
            operations.push("dispose");
            throw disposalError;
          }
        }))
    );
    const selected = await selector.next(publicationGate([]));

    await expect(selector.retire(selected)).rejects.toBe(disposalError);
    expect(operations).toEqual(["snapshot", "dispose"]);
  });

  it("fails closed when a probe returns an invalid rendition count", async () => {
    const events: string[] = [];
    const gate = publicationGate(events);
    gate.input.onMetadata(metadata);
    const selector = new PlayerCandidateSelector(1, async () =>
      candidateProbeResult("main", candidatePlayer(), 0)
    );

    await expect(selector.next(gate)).rejects.toThrow(
      "AVAL candidate probe returned an invalid rendition count"
    );
    gate.activate();
    expect(events).toEqual([]);
  });
});

function candidateProbeResult(
  renditionId: string,
  player: Readonly<PlayerCandidateHandle>,
  renditionCount = 1
): Readonly<PlayerCandidateProbeResult> {
  return Object.freeze({
    kind: "candidate",
    player,
    renditionId,
    requiresQualification: true,
    renditionCount
  });
}

function candidatePlayer(
  override: Readonly<{
    snapshot?: () => Readonly<PlayerSnapshot>;
    dispose?: () => Promise<void>;
  }> = {}
): Readonly<PlayerCandidateHandle> {
  return Object.freeze({
    metadata,
    activate: () => undefined,
    publish: () => undefined,
    prepare: async () => { throw new Error("unused prepare"); },
    setState: async () => undefined,
    canSend: () => false,
    send: () => false,
    readyFor: () => false,
    pause: () => undefined,
    resume: async () => undefined,
    setMotion: async () => undefined,
    suspend: async () => { throw new Error("unused suspend"); },
    setVisibility: () => undefined,
    resize: () => undefined,
    snapshot: override.snapshot ?? (() => playerSnapshot([], 0)),
    settled: async () => undefined,
    dispose: override.dispose ?? (async () => undefined),
    adoptPreparationParent: () => undefined,
    provisionalFailure: () => null,
    completeCandidateInstallation: () => undefined,
    failCandidateInstallation: () => undefined
  } satisfies PlayerCandidateHandle);
}

function playerSnapshot(
  decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[],
  cleanupFailureCount: number
): Readonly<PlayerSnapshot> {
  return Object.freeze({
    requestedState: null,
    visualState: null,
    transitioning: false,
    selectedRendition: null,
    selectedCodec: null,
    rendererBackend: null,
    selectedBitDepth: null,
    transportMode: null,
    declaredFileBytes: 0,
    metadataBytes: 0,
    verifiedBytes: 0,
    residentBlobBytes: 0,
    activeTransportBodies: 0,
    pendingLoads: 0,
    interestedWaiters: 0,
    workerCount: 0,
    openFrames: 0,
    contextLossCount: 0,
    contextRecoveryCount: 0,
    cleanupFailureCount,
    playbackLifecycle: emptyPlaybackLifecycleCounters(),
    decoderDiagnostics,
    rendererDiagnostics: Object.freeze([]),
    presentation: Object.freeze({
      cssWidth: 0,
      cssHeight: 0,
      backingWidth: 0,
      backingHeight: 0,
      effectiveDprX: 0,
      effectiveDprY: 0
    }),
    trace: Object.freeze([])
  } satisfies PlayerSnapshot);
}

function decoderDiagnostic(
  sourceIndex: number,
  lane: 0 | 1,
  rendition: string
): Readonly<PlayerDecoderDiagnostic> {
  return Object.freeze({
    sourceIndex,
    rendition,
    codec: "avc1.42E01E",
    unit: null,
    lane,
    logicalRunId: null,
    role: null,
    graph: Object.freeze({
      requestedState: null,
      visualState: null,
      activeUnit: null,
      pendingUnit: null
    }),
    phase: "probe",
    code: "unsupported-config",
    run: null,
    decodeOrdinal: null,
    exception: Object.freeze({
      name: "NotSupportedError",
      message: "decoder configuration is unsupported"
    }),
    firstFrame: null,
    lastGoodFrame: null,
    outputFailure: null
  });
}

function publicationGate(events: string[]): PublicationGate {
  const controller = new AbortController();
  return new PublicationGate(Object.freeze({
    canvas: new EventTarget() as HTMLCanvasElement,
    platform: Object.freeze({
      fetch: globalThis.fetch,
      Worker: null,
      VideoDecoder: null,
      VideoFrame: null,
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
      now: () => 0,
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      crypto: globalThis.crypto
    }),
    initialPresentation: Object.freeze({
      width: 1,
      height: 1,
      dpr: 1,
      fit: "contain" as const
    }),
    baseUrl: "https://example.test/",
    sources: Object.freeze([]),
    credentials: "same-origin" as const,
    signal: controller.signal,
    preparationTimeoutMs: 1_000,
    motion: "auto" as const,
    reduced: false,
    initialState: null,
    initialBody: false,
    visible: true,
    decoderReady: () => true,
    onResourceBytes: () => undefined,
    onMetadata: () => events.push("metadata"),
    onReadiness: () => undefined,
    onAnimationResourcesRetired: () => undefined,
    onDraw: () => undefined,
    onRestart: () => undefined,
    onEvent: () => undefined,
    onFailure: () => undefined,
    onPlaybackFailure: () => { throw new Error("unused playback failure"); }
  } satisfies PlayerInput));
}
