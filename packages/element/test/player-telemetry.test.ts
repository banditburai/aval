import { describe, expect, it } from "vitest";

import { emptyPlaybackLifecycleCounters } from
  "../src/playback-lifecycle.js";
import type {
  PlayerDecoderDiagnostic,
  PlayerRendererDiagnostic
} from "../src/player-contract.js";
import {
  PlayerTelemetry,
  type PlayerTraceObservation
} from "../src/player-telemetry.js";

describe("PlayerTelemetry", () => {
  it("keeps snapshot identity stable until one observation changes", () => {
    const telemetry = new PlayerTelemetry();
    const initial = telemetry.snapshot(true);
    const initialWithoutTrace = telemetry.snapshot(false);

    expect(telemetry.snapshot(true)).toBe(initial);
    expect(telemetry.snapshot(false)).toBe(initialWithoutTrace);
    expect(initialWithoutTrace.trace).toEqual([]);
    telemetry.recordSettledRequests(0);
    expect(telemetry.snapshot(true)).toBe(initial);
    telemetry.recordDraw();
    const changed = telemetry.snapshot(true);

    expect(changed).not.toBe(initial);
    expect(telemetry.snapshot(false)).not.toBe(initialWithoutTrace);
    expect(changed.playbackLifecycle.drawsCompleted).toBe(1);
    expect(telemetry.snapshot()).toBe(changed);
    expect(Object.isFrozen(changed)).toBe(true);
  });

  it("accumulates lifecycle and runtime counters monotonically", () => {
    const telemetry = new PlayerTelemetry();
    telemetry.captureDecoderLifecycle(Object.freeze({
      ...emptyPlaybackLifecycleCounters(),
      outputsAccepted: 7,
      logicalRunsCreated: 3,
      nativeDecoderCreatesByLane: Object.freeze([2, 1] as const)
    }));
    telemetry.captureDecoderLifecycle(Object.freeze({
      ...emptyPlaybackLifecycleCounters(),
      outputsAccepted: 4,
      runsClosed: 2,
      nativeDecoderCreatesByLane: Object.freeze([1, 4] as const)
    }));
    telemetry.recordDraw();
    telemetry.recordTransitionStart();
    telemetry.recordTransitionEnd();
    telemetry.recordLoopCrossing();
    telemetry.recordSettledRequests(3);
    telemetry.recordCleanedFrame();
    const underflow = telemetry.recordUnderflow();
    telemetry.recordContextLoss();
    telemetry.recordContextRecovery();
    telemetry.recordCleanupFailure();

    expect(underflow).toEqual({ incident: 1, cumulativeCount: 1 });
    expect(telemetry.snapshot()).toMatchObject({
      underflows: 1,
      settledRequests: 3,
      cleanedFrames: 1,
      incidents: 1,
      contextLossCount: 1,
      contextRecoveryCount: 1,
      cleanupFailureCount: 1,
      playbackLifecycle: {
        outputsAccepted: 7,
        drawsCompleted: 1,
        logicalRunsCreated: 3,
        runsClosed: 2,
        transitionStarts: 1,
        transitionEnds: 1,
        loopCrossings: 1,
        nativeDecoderCreatesByLane: [2, 4]
      }
    });
  });

  it("owns trace identity, counters, indexing, and bounded retention", () => {
    const telemetry = new PlayerTelemetry();
    telemetry.recordUnderflow();
    telemetry.recordSettledRequests(2);
    telemetry.recordCleanedFrame();
    for (let index = 0; index < 515; index += 1) {
      telemetry.recordTrace(traceObservation(index));
    }

    const { trace } = telemetry.snapshot();
    expect(trace).toHaveLength(512);
    expect(trace[0]?.index).toBe(4);
    expect(trace.at(-1)).toMatchObject({
      index: 515,
      scheduler: { smoothSession: false },
      counters: { underflows: 1, settledRequests: 2, cleanedFrames: 1 }
    });
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace.at(-1)?.counters)).toBe(true);
  });

  it("retains at most sixteen decoder and renderer diagnostics", () => {
    const telemetry = new PlayerTelemetry();
    const decoders = Object.freeze(Array.from(
      { length: 20 },
      (_, sourceIndex) => decoderDiagnostic(sourceIndex)
    ));
    const renderers = Object.freeze(Array.from(
      { length: 20 },
      (_, operationOrdinal) => rendererDiagnostic(operationOrdinal)
    ));

    telemetry.captureDecoderDiagnostics(decoders);
    telemetry.captureRendererDiagnostics(renderers);
    const retained = telemetry.snapshot();

    expect(retained.decoderDiagnostics).toHaveLength(16);
    expect(retained.decoderDiagnostics.map(({ sourceIndex }) => sourceIndex))
      .toEqual(Array.from({ length: 16 }, (_, index) => index + 4));
    expect(retained.rendererDiagnostics).toHaveLength(16);
    expect(retained.rendererDiagnostics.map(({ operationOrdinal }) =>
      operationOrdinal
    )).toEqual(Array.from({ length: 16 }, (_, index) => index + 4));
  });

  it("preserves captured diagnostics after later observations and ignores duplicates", () => {
    const initial = decoderDiagnostic(0);
    const telemetry = new PlayerTelemetry(Object.freeze({
      initialDecoderDiagnostics: Object.freeze([initial])
    }));
    const captured = telemetry.snapshot();

    telemetry.captureDecoderDiagnostics(Object.freeze([initial]));
    expect(telemetry.snapshot()).toBe(captured);
    telemetry.recordCleanupFailure();
    expect(telemetry.snapshot()).toMatchObject({
      decoderDiagnostics: [initial],
      cleanupFailureCount: 1
    });
  });
});

function traceObservation(index: number): Readonly<PlayerTraceObservation> {
  return Object.freeze({
    kind: "content-tick",
    presentationOrdinal: String(index),
    rationalDeadlineUs: index,
    callbackStartMicroseconds: index,
    canvasSubmissionCompleteMicroseconds: index,
    eligibleAnimationFrameOrdinal: null,
    graph: null,
    routeReady: true,
    selectedBoundary: null,
    scheduler: Object.freeze({
      generation: null,
      activePath: "idle",
      sourceCursor: null,
      submittedCursor: null,
      decodedCursor: null,
      displayedCursor: null,
      ringSize: 0,
      ringCapacity: 6
    }),
    submitted: Object.freeze([]),
    media: null,
    readbackTag: null,
    readiness: "interactiveReady",
    decodeLeadFrames: null,
    settledRequestIds: Object.freeze([])
  });
}

function decoderDiagnostic(sourceIndex: number): Readonly<PlayerDecoderDiagnostic> {
  return Object.freeze({
    sourceIndex,
    rendition: `rendition-${String(sourceIndex)}`,
    codec: "avc1.42E01E",
    unit: null,
    lane: sourceIndex % 2 === 0 ? 0 : 1,
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
    exception: null,
    firstFrame: null,
    lastGoodFrame: null,
    outputFailure: null
  });
}

function rendererDiagnostic(
  operationOrdinal: number
): Readonly<PlayerRendererDiagnostic> {
  return Object.freeze({
    sourceIndex: 0,
    rendition: "main",
    codec: "avc1.42E01E",
    backend: "webgl2",
    phase: "draw",
    operation: "runtime",
    operationOrdinal,
    exception: null,
    glError: null,
    contextLost: false,
    uploadPath: "rgba-copy",
    textureOrdinal: null,
    layout: Object.freeze({
      codedWidth: 16,
      codedHeight: 16,
      storageWidth: 16,
      storageHeight: 16,
      logicalWidth: 16,
      logicalHeight: 16
    }),
    backing: Object.freeze({ width: 16, height: 16 }),
    bytes: Object.freeze({
      stagingBytes: 0,
      residentBytes: 0,
      textureBytes: 0,
      backingBytes: 0,
      runtimeBytes: 0,
      maxTextureBytes: 1,
      maxBackingBytes: 1,
      maxRuntimeBytes: 1
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
