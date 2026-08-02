import { describe, expect, it } from "vitest";

import {
  createElementOwnershipSnapshot,
  createElementTerminalCleanupProof,
  createPageResourceOwnership,
  createSourceCleanupReceipt
} from "../src/element-cleanup-proof.js";
import {
  ElementDiagnostics,
  type ElementDiagnosticsSnapshotInput
} from "../src/element-diagnostics.js";
import type { ElementHostEnvironmentSnapshot } from "../src/element-host-environment.js";
import type { ElementInputBindingSnapshot } from "../src/element-input-binding.js";
import type {
  PlayerDecoderDiagnostic,
  PlayerRendererDiagnostic,
  PlayerSnapshot
} from "../src/player-contract.js";
import type { AvalErrorDetail, AvalSnapshot } from "../src/public-types.js";

describe("ElementDiagnostics", () => {
  it("assembles fresh frozen snapshots while retaining observation identity", () => {
    const diagnostics = new ElementDiagnostics();
    diagnostics.beginSource(1, false);
    diagnostics.configureSourceCapacity(1, 1);
    diagnostics.recordPrepare();
    diagnostics.recordPause();
    diagnostics.recordResume();
    diagnostics.recordUnderflow();
    diagnostics.recordStalePublication();
    diagnostics.timerStarted();
    diagnostics.recordLifecycle("connect", 1);
    diagnostics.recordInput("pointer.enter", 1);
    diagnostics.recordPublication("readinesschange", 1);
    diagnostics.observeRuntime(runtime({ outputsAccepted: 2 }), 1);

    const first = diagnostics.snapshot(snapshotInput(diagnostics, 1, false));
    const second = diagnostics.snapshot(snapshotInput(diagnostics, 1, false));

    expect(first).not.toBe(second);
    expect(first.runtime.playbackLifecycle).toBe(
      second.runtime.playbackLifecycle
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.runtime)).toBe(true);
    expect("elementTrace" in first).toBe(false);
    expect(first.counters).toMatchObject({
      prepare: 1,
      pause: 1,
      resume: 1,
      underflow: 1
    });
    expect(first.runtime.stalePublicationCount).toBe(1);
    expect(first.elementOwnership.timerCount).toBe(1);

    const traced = diagnostics.snapshot(snapshotInput(diagnostics, 1, true));
    expect(traced.elementTrace?.map(({ kind }) => kind)).toEqual([
      "source-start",
      "connect",
      "input-pointer-enter",
      "publish-readinesschange"
    ]);

    diagnostics.timerSettled();
    expect(() => diagnostics.timerSettled()).toThrow(/underflow/u);
  });

  it("rejects stale observations and reads canonical failure identity", () => {
    const diagnostics = new ElementDiagnostics();
    diagnostics.beginSource(3, false);
    const failure = Object.freeze({
      code: "readiness-failure" as const,
      message: "failed",
      operation: "prepare"
    });
    const detail: Readonly<AvalErrorDetail> = Object.freeze({
      generation: 3,
      failure,
      fatal: true
    });
    diagnostics.observeRuntime(runtime({ outputsAccepted: 4 }), 2);

    const current = diagnostics.snapshot(
      snapshotInput(diagnostics, 3, false, detail)
    );
    expect(current.lastFailure).toBe(failure);
    expect(current.runtime.playbackLifecycle.outputsAccepted).toBe(0);

    diagnostics.beginSource(4, false);
    const next = diagnostics.snapshot(snapshotInput(diagnostics, 4, false));
    expect(next.lastFailure).toBeNull();
  });

  it("observes canonical cleanup proofs without becoming their authority", () => {
    const diagnostics = new ElementDiagnostics();
    diagnostics.beginSource(1, false);
    diagnostics.configureSourceCapacity(1, 1);
    const pageResources = createPageResourceOwnership(true, 0, null);
    const cleanup = createSourceCleanupReceipt({
      generation: 1,
      sourceGeneration: 1,
      runtime: runtime(),
      page: pageSnapshot(),
      retiredDeclaredFileBytes: 0,
      operationFailed: false,
      pageResources,
      terminal: true,
      stalePublicationCount: 0
    });
    const ownership = createElementOwnershipSnapshot({
      terminal: true,
      input: inputSnapshot(),
      host: hostSnapshot(),
      deferredOperationCount: 0,
      timerCount: diagnostics.accounting().timerCount
    });
    const terminal = createElementTerminalCleanupProof(
      cleanup.completed,
      true,
      ownership
    );

    diagnostics.observeCleanup(cleanup);
    diagnostics.recordCleanup();
    diagnostics.observeTerminalCleanup(terminal);
    const first = diagnostics.snapshot(snapshotInput(diagnostics, 1, false));
    const second = diagnostics.snapshot(snapshotInput(diagnostics, 1, false));

    expect(first.cleanup).toBe(second.cleanup);
    expect(first.terminalCleanup).toBe(second.terminalCleanup);
    expect(first.finalDisposed).toBe(true);
    expect(first.counters.cleanup).toBe(1);
  });

  it("caps element trace observations", () => {
    const diagnostics = new ElementDiagnostics();
    diagnostics.beginSource(1, false);
    diagnostics.configureSourceCapacity(1, 0);
    for (let index = 0; index < 520; index += 1) {
      diagnostics.recordLifecycle("connect", 1);
    }
    const trace = diagnostics.snapshot(
      snapshotInput(diagnostics, 1, true)
    ).elementTrace;
    expect(trace).toHaveLength(512);
    expect(trace?.[0]?.index).toBe(10);
  });

  it("merges lifecycle high-water marks and resets source-scoped failures", () => {
    const diagnostics = new ElementDiagnostics();
    diagnostics.beginSource(1, false);
    diagnostics.configureSourceCapacity(1, 1);
    diagnostics.observeRuntime(runtime({ outputsAccepted: 2 }, 3), 1);
    const retained = diagnostics.snapshot(
      snapshotInput(diagnostics, 1, false)
    ).runtime.playbackLifecycle;
    diagnostics.observeRuntime(runtime({ outputsAccepted: 1 }, 1), 1);
    const unchanged = diagnostics.snapshot(
      snapshotInput(diagnostics, 1, false)
    );
    expect(unchanged.runtime.playbackLifecycle).toBe(retained);
    expect(unchanged.runtime.cleanupFailureCount).toBe(3);

    diagnostics.beginSource(2, true);
    const preserved = diagnostics.snapshot(
      snapshotInput(diagnostics, 2, false)
    );
    expect(preserved.runtime.playbackLifecycle.outputsAccepted).toBe(2);
    expect(preserved.runtime.cleanupFailureCount).toBe(0);

    diagnostics.beginSource(3, false);
    expect(diagnostics.snapshot(
      snapshotInput(diagnostics, 3, false)
    ).runtime.playbackLifecycle.outputsAccepted).toBe(0);
  });

  it("caps, deduplicates, freezes, and generation-gates runtime evidence", () => {
    const diagnostics = new ElementDiagnostics();
    diagnostics.beginSource(5, false);
    diagnostics.configureSourceCapacity(5, 1);
    diagnostics.observeDecoderDiagnostics(4, [decoderDiagnostic(0, 0)]);
    diagnostics.observeRendererDiagnostics(4, [rendererDiagnostic(0)]);
    expect(diagnostics.snapshot(
      snapshotInput(diagnostics, 5, false)
    ).runtime.decoderDiagnostics).toHaveLength(0);

    diagnostics.observeDecoderDiagnostics(5, [
      decoderDiagnostic(0, 0),
      decoderDiagnostic(1, 0),
      decoderDiagnostic(2, 1)
    ]);
    diagnostics.observeRendererDiagnostics(5, [
      rendererDiagnostic(0),
      rendererDiagnostic(1)
    ]);
    const first = diagnostics.snapshot(snapshotInput(diagnostics, 5, false));
    expect(first.runtime.decoderDiagnostics.map(({ sourceIndex }) => sourceIndex))
      .toEqual([1, 2]);
    expect(first.runtime.rendererDiagnostics.map(({ sourceIndex }) => sourceIndex))
      .toEqual([1]);
    expect(Object.isFrozen(first.runtime.decoderDiagnostics[0])).toBe(true);
    expect(Object.isFrozen(first.runtime.decoderDiagnostics[0]?.graph)).toBe(true);
    expect(Object.isFrozen(first.runtime.rendererDiagnostics[0]?.bytes)).toBe(true);

    diagnostics.observeDecoderDiagnostics(5, [decoderDiagnostic(1, 0)]);
    diagnostics.observeRendererDiagnostics(5, [rendererDiagnostic(1)]);
    const second = diagnostics.snapshot(snapshotInput(diagnostics, 5, false));
    expect(second.runtime.decoderDiagnostics).toBe(
      first.runtime.decoderDiagnostics
    );
    expect(second.runtime.rendererDiagnostics).toBe(
      first.runtime.rendererDiagnostics
    );
  });
});

function snapshotInput(
  diagnostics: ElementDiagnostics,
  generation: number,
  trace: boolean,
  lastError: Readonly<AvalErrorDetail> | null = null
): Readonly<ElementDiagnosticsSnapshotInput> {
  const host = hostSnapshot();
  return Object.freeze({
    publicSnapshot: publicSnapshot(generation, lastError),
    configuredMotion: "auto",
    autoplay: "visible",
    fit: null,
    host,
    page: Object.freeze({
      ownership: createPageResourceOwnership(true, 0, null),
      page: pageSnapshot()
    }),
    ownership: createElementOwnershipSnapshot({
      terminal: false,
      input: inputSnapshot(),
      host,
      deferredOperationCount: 0,
      timerCount: diagnostics.accounting().timerCount
    }),
    session: Object.freeze({
      elementGeneration: 1,
      inputGeneration: 0,
      motionGeneration: 0,
      visibilityGeneration: 0,
      resizeGeneration: 0,
      runtime: null,
      runtimeIsActive: false,
      runtimeSuspending: false,
      runtimeSuspended: false,
      rebuildPending: false,
      presentationFit: "contain"
    }),
    trace
  });
}

function publicSnapshot(
  generation: number,
  lastError: Readonly<AvalErrorDetail> | null
): Readonly<AvalSnapshot> {
  return Object.freeze({
    revision: 0,
    generation,
    connected: true,
    readiness: "unready",
    mode: null,
    assurance: null,
    staticReason: null,
    requestedState: null,
    visualState: null,
    isTransitioning: false,
    paused: false,
    effectivelyVisible: true,
    stateNames: Object.freeze([]),
    eventNames: Object.freeze([]),
    inputBindings: Object.freeze([]),
    lastError
  });
}

function hostSnapshot(): Readonly<ElementHostEnvironmentSnapshot> {
  return Object.freeze({
    installed: true,
    documentVisible: true,
    intersectionKnown: true,
    intersecting: true,
    positiveBox: true,
    effectivelyVisible: true,
    reducedMotion: false,
    observedReducedMotion: false,
    observerSupported: true,
    activeListenerCount: 0,
    activeObserverCount: 0,
    failedListenerReleaseCount: 0,
    failedObserverReleaseCount: 0,
    failedReleaseCount: 0,
    listenerCount: 0,
    observerCount: 0
  });
}

function inputSnapshot(): Readonly<ElementInputBindingSnapshot> {
  return Object.freeze({
    activeListenerCount: 0,
    failedReleaseCount: 0,
    listenerCount: 0,
    bindingEpoch: 0,
    bound: false,
    hovered: false,
    focused: false,
    closed: false
  });
}

function pageSnapshot() {
  return Object.freeze({
    active: 0,
    queued: 0,
    parked: 0,
    participants: 0,
    physicalBytes: 0
  });
}

function runtime(
  lifecycle: Readonly<Partial<PlayerSnapshot["playbackLifecycle"]>> = {},
  cleanupFailureCount = 0
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
    playbackLifecycle: Object.freeze({
      outputsAccepted: lifecycle.outputsAccepted ?? 0,
      drawsCompleted: lifecycle.drawsCompleted ?? 0,
      logicalRunsCreated: lifecycle.logicalRunsCreated ?? 0,
      candidateCommits: lifecycle.candidateCommits ?? 0,
      runsClosed: lifecycle.runsClosed ?? 0,
      transitionStarts: lifecycle.transitionStarts ?? 0,
      transitionEnds: lifecycle.transitionEnds ?? 0,
      loopCrossings: lifecycle.loopCrossings ?? 0,
      nativeDecoderCreatesByLane: lifecycle.nativeDecoderCreatesByLane ??
        Object.freeze([0, 0] as const),
      nativeDecoderClosesByLane: lifecycle.nativeDecoderClosesByLane ??
        Object.freeze([0, 0] as const)
    }),
    decoderDiagnostics: Object.freeze([]),
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
  });
}

function decoderDiagnostic(
  sourceIndex: number,
  lane: 0 | 1
): Readonly<PlayerDecoderDiagnostic> {
  return Object.freeze({
    sourceIndex,
    rendition: `rendition-${String(sourceIndex)}`,
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
    phase: "decode",
    code: "decoder-operation",
    run: null,
    decodeOrdinal: null,
    exception: Object.freeze({ name: "Error", message: "failure" }),
    firstFrame: null,
    lastGoodFrame: null,
    outputFailure: null
  });
}

function rendererDiagnostic(
  sourceIndex: number
): Readonly<PlayerRendererDiagnostic> {
  return Object.freeze({
    sourceIndex,
    rendition: `rendition-${String(sourceIndex)}`,
    codec: "avc1.42E01E",
    backend: "webgl2",
    phase: "draw",
    operation: "runtime",
    operationOrdinal: 1,
    exception: Object.freeze({ name: "Error", message: "failure" }),
    glError: null,
    contextLost: false,
    uploadPath: "native",
    textureOrdinal: null,
    layout: Object.freeze({
      codedWidth: 1,
      codedHeight: 1,
      storageWidth: 1,
      storageHeight: 1,
      logicalWidth: 1,
      logicalHeight: 1
    }),
    backing: Object.freeze({ width: 1, height: 1 }),
    bytes: Object.freeze({
      stagingBytes: 0,
      residentBytes: 0,
      textureBytes: 0,
      backingBytes: 4,
      runtimeBytes: 4,
      maxTextureBytes: 4,
      maxBackingBytes: 4,
      maxRuntimeBytes: 4
    }),
    limits: Object.freeze({
      maxTextureSize: 1,
      maxViewportWidth: 1,
      maxViewportHeight: 1,
      maxResidentTextures: 1
    }),
    contextAttributes: null,
    vendor: null,
    renderer: null
  });
}
