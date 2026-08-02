import { describe, expect, it } from "vitest";

import {
  createElementOwnershipSnapshot,
  createElementTerminalCleanupProof,
  createPageResourceOwnership,
  createSourceCleanupReceipt,
  playerSnapshotDisposed,
  serializeElementOwnershipSnapshot,
  proveSourceRetirement,
  serializeSourceCleanupReceipt,
  serializeElementTerminalCleanupProof
} from "../src/element-cleanup-proof.js";
import type { PlayerSnapshot } from "../src/player-contract.js";

const EMPTY_PAGE = Object.freeze({
  active: 0,
  queued: 0,
  parked: 0,
  participants: 0,
  physicalBytes: 0
});

describe("element cleanup proof", () => {
  it("proves and serializes complete retirement without changing public diagnostics", () => {
    const proof = cleanup();
    const serialized = serializeSourceCleanupReceipt(proof);

    expect(proof).toMatchObject({
      completed: true,
      generation: 3,
      sourceGeneration: 7,
      failureCount: 0,
      player: { kind: "player", completed: true },
      pageResources: {
        kind: "page-resources",
        participantDisposed: true
      }
    });
    expect(serialized).toMatchObject({
      elementGeneration: 3,
      sourceGeneration: 7,
      completed: true,
      playerDisposed: true,
      participantDisposed: true,
      participantRegistered: false,
      workerCount: 0,
      openFrames: 0,
      stalePublicationCount: 0,
      terminal: true,
      retiredDeclaredFileBytes: 1_024
    });
    expect(serializeSourceCleanupReceipt(proof)).toBe(serialized);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(serialized)).toBe(true);
    expect(proveSourceRetirement(true, proof)).toBe(true);
  });

  it("fails closed for missing or unsettled player resources", () => {
    expect(cleanup({ runtime: null })).toMatchObject({
      completed: false,
      player: null
    });
    for (const runtime of [
      player({ workerCount: 1 }),
      player({ openFrames: 1 }),
      player({ pendingOperations: 1 }),
      player({ sourceCopiesInFlight: 1 }),
      player({ backingWidth: 1, backingHeight: 1 }),
      player({ resourceCount: 1 }),
      player({ contextListenerCount: 1 })
    ]) {
      const proof = cleanup({ runtime });
      expect(proof.completed).toBe(false);
      expect(proof.player?.completed).toBe(false);
      expect(() => proveSourceRetirement(true, proof)).toThrow(
        "aval-player element cleanup was incomplete"
      );
    }
    expect(proveSourceRetirement(false, cleanup())).toBe(false);
    expect(playerSnapshotDisposed(player())).toBe(true);
    expect(playerSnapshotDisposed(player({ openFrames: 1 }))).toBe(false);
  });

  it("keeps operation, participant, ticket, lease, bytes, and stale evidence typed", () => {
    const failed = cleanup({
      operationFailed: true,
      participantDisposed: false,
      participantLogicalBytes: 4_096,
      participantDecoderState: "granted",
      stalePublicationCount: 5
    });

    expect(failed).toMatchObject({
      completed: false,
      operationFailed: true,
      stalePublicationCount: 5,
      pageResources: {
        participantDisposed: false,
        participantRegistered: true,
        logicalBytes: 4_096,
        activeLeaseCount: 1,
        decoderTicketCount: 1,
        decoderState: "granted"
      }
    });
    expect(serializeSourceCleanupReceipt(failed)).toMatchObject({
      participantLogicalBytes: 4_096,
      participantActiveLeaseCount: 1,
      participantDecoderTicketCount: 1,
      stalePublicationCount: 5
    });
  });

  it("reports every incomplete element ownership kind through one serializer", () => {
    const cases = [
      ownership({ terminal: false }),
      ownership({ listenerCount: 1 }),
      ownership({ observerCount: 1 }),
      ownership({ deferredOperationCount: 1 }),
      ownership({ timerCount: 1 }),
      ownership({ failedListenerReleaseCount: 1 }),
      ownership({ failedObserverReleaseCount: 1 }),
    ];
    for (const snapshot of cases) expect(snapshot.completed).toBe(false);

    const complete = ownership();
    expect(complete.completed).toBe(true);
    expect(serializeElementOwnershipSnapshot(complete)).toEqual({
      listenerCount: 0,
      observerCount: 0,
      brokerSubscriptionCount: 0,
      timerCount: 0,
      pendingCommandCount: 0,
      failedReleaseCount: 0,
      retainedRetryCount: 0,
      releaseFailureCount: 0,
      completed: true
    });
  });

  it("keeps live host/input ownership separate from live page resources", () => {
    const element = ownership({
      terminal: false,
      listenerCount: 6,
      observerCount: 3,
      deferredOperationCount: 2,
      timerCount: 1
    });
    const source = cleanup({
      participantDisposed: false,
      participantLogicalBytes: 2_048,
      participantDecoderState: "parked"
    });

    expect(element).toMatchObject({
      completed: false,
      terminal: false,
      input: { kind: "input-binding", listenerCount: 6 },
      host: { kind: "host-environment", observerCount: 3 },
      deferredOperations: 2,
      timers: 1
    });
    expect(source).not.toHaveProperty("element");
    expect(source).toMatchObject({
      completed: false,
      pageResources: {
        kind: "page-resources",
        participantRegistered: true,
        logicalBytes: 2_048,
        decoderState: "parked"
      }
    });
  });

  it("composes stable terminal proof only after source, presentation, and ownership cleanup", () => {
    const completeOwnership = ownership();
    const complete = createElementTerminalCleanupProof(
      true,
      true,
      completeOwnership
    );
    const serialized = serializeElementTerminalCleanupProof(complete);
    expect(serialized).toMatchObject({
      completed: true,
      sourceCleanupCompleted: true,
      presentationCleanupCompleted: true,
      elementOwnership: { completed: true }
    });
    expect(serializeElementTerminalCleanupProof(complete)).toBe(serialized);

    expect(createElementTerminalCleanupProof(
      false,
      true,
      completeOwnership
    ).completed).toBe(false);
    expect(createElementTerminalCleanupProof(
      true,
      false,
      completeOwnership
    ).completed).toBe(false);
    expect(createElementTerminalCleanupProof(
      true,
      true,
      ownership({ timerCount: 1 })
    ).completed).toBe(false);
  });

  it("supports a failed receipt followed by a successful retry receipt", () => {
    const failed = cleanup({
      operationFailed: true,
      runtime: player({ openFrames: 1 })
    });
    expect(() => proveSourceRetirement(true, failed)).toThrow(
      "aval-player element cleanup was incomplete"
    );

    const retried = cleanup();
    expect(proveSourceRetirement(true, retried)).toBe(true);
    expect(retried.generation).toBe(failed.generation);
    expect(retried.sourceGeneration).toBe(failed.sourceGeneration);
  });
});

function cleanup(
  override: Readonly<{
    runtime?: Readonly<PlayerSnapshot> | null;
    operationFailed?: boolean;
    participantDisposed?: boolean;
    participantLogicalBytes?: number;
    participantDecoderState?: Parameters<typeof createPageResourceOwnership>[2];
    stalePublicationCount?: number;
  }> = {}
) {
  return createSourceCleanupReceipt({
    generation: 3,
    sourceGeneration: 7,
    runtime: override.runtime === undefined ? player() : override.runtime,
    page: EMPTY_PAGE,
    retiredDeclaredFileBytes: 1_024,
    operationFailed: override.operationFailed ?? false,
    pageResources: createPageResourceOwnership(
      override.participantDisposed ?? true,
      override.participantLogicalBytes ?? 0,
      override.participantDecoderState ?? null
    ),
    terminal: true,
    ...(override.stalePublicationCount === undefined
      ? {}
      : { stalePublicationCount: override.stalePublicationCount })
  });
}

function ownership(
  override: Readonly<{
    terminal?: boolean;
    listenerCount?: number;
    observerCount?: number;
    deferredOperationCount?: number;
    timerCount?: number;
    failedListenerReleaseCount?: number;
    failedObserverReleaseCount?: number;
  }> = {}
) {
  return createElementOwnershipSnapshot({
    terminal: override.terminal ?? true,
    input: {
      listenerCount: override.listenerCount ?? 0,
      failedReleaseCount: override.failedListenerReleaseCount ?? 0
    },
    host: {
      listenerCount: 0,
      observerCount: override.observerCount ?? 0,
      failedListenerReleaseCount: 0,
      failedObserverReleaseCount: override.failedObserverReleaseCount ?? 0
    },
    deferredOperationCount: override.deferredOperationCount ?? 0,
    ...(override.timerCount === undefined
      ? {}
      : { timerCount: override.timerCount })
  });
}

function player(
  override: Readonly<{
    workerCount?: number;
    openFrames?: number;
    pendingOperations?: number;
    sourceCopiesInFlight?: number;
    backingWidth?: number;
    backingHeight?: number;
    resourceCount?: number;
    contextListenerCount?: number;
  }> = {}
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
    workerCount: override.workerCount ?? 0,
    openFrames: override.openFrames ?? 0,
    contextLossCount: 0,
    contextRecoveryCount: 0,
    playbackLifecycle: Object.freeze({
      outputsAccepted: 0,
      drawsCompleted: 0,
      logicalRunsCreated: 0,
      candidateCommits: 0,
      runsClosed: 0,
      transitionStarts: 0,
      transitionEnds: 0,
      loopCrossings: 0,
      nativeDecoderCreatesByLane: Object.freeze([0, 0] as const),
      nativeDecoderClosesByLane: Object.freeze([0, 0] as const)
    }),
    decoderDiagnostics: Object.freeze([]),
    rendererDiagnostics: Object.freeze([]),
    presentation: Object.freeze({
      cssWidth: 0,
      cssHeight: 0,
      backingWidth: override.backingWidth ?? 0,
      backingHeight: override.backingHeight ?? 0,
      effectiveDprX: 0,
      effectiveDprY: 0,
      stagingBytes: 0,
      residentBytes: 0,
      textureBytes: 0,
      runtimeBytes: 0,
      pendingOperations: override.pendingOperations ?? 0,
      sourceCopiesInFlight: override.sourceCopiesInFlight ?? 0,
      resourceCount: override.resourceCount ?? 0,
      contextListenerCount: override.contextListenerCount ?? 0
    }),
    trace: Object.freeze([])
  });
}
