import {
  serializeElementOwnershipSnapshot,
  serializeElementTerminalCleanupProof,
  serializeSourceCleanupReceipt,
  type ElementOwnershipSnapshot,
  type ElementTerminalCleanupProof,
  type SourceCleanupReceipt
} from "./element-cleanup-proof.js";
import type { ElementHostEnvironmentSnapshot } from "./element-host-environment.js";
import type { ElementPageResourceOwnerSnapshot } from "./element-page-resource-owner.js";
import { ElementTrace } from "./element-trace.js";
import { ELEMENT_DECODER_CAPACITY } from "./decoder-capacity.js";
import { addElementCount, nextElementSequence } from "./element-sequence.js";
import type {
  PlayerDecoderDiagnostic,
  PlayerRendererDiagnostic,
  PlayerSnapshot
} from "./player-contract.js";
import {
  emptyPlaybackLifecycleCounters,
  retainPlaybackLifecycleCounters
} from "./playback-lifecycle.js";
import type {
  AvalAutoplay,
  AvalDecoderColorSpaceDiagnostic,
  AvalDecoderDiagnostic,
  AvalDecoderExpectedOutputDiagnostic,
  AvalDecoderFrameDiagnostic,
  AvalDecoderObservedOutputDiagnostic,
  AvalDecoderOutputFailureDiagnostic,
  AvalDiagnostics,
  AvalDiagnosticsCounters,
  AvalFit,
  AvalMotion,
  AvalPlaybackLifecycleCounters,
  AvalRendererDiagnostic,
  AvalSnapshot,
  BindingSource
} from "./public-types.js";

const MAX_RETAINED_SOURCES = 128;

export type ElementDiagnosticsCounter = keyof AvalDiagnosticsCounters;

export interface ElementDiagnosticsAccounting {
  readonly timerCount: number;
  readonly stalePublicationCount: number;
}

export interface ElementDiagnosticsSessionSnapshot {
  readonly elementGeneration: number;
  readonly inputGeneration: number;
  readonly motionGeneration: number;
  readonly visibilityGeneration: number;
  readonly resizeGeneration: number;
  readonly runtime: Readonly<PlayerSnapshot> | null;
  readonly runtimeIsActive: boolean;
  readonly runtimeSuspending: boolean;
  readonly runtimeSuspended: boolean;
  readonly rebuildPending: boolean;
  readonly presentationFit: AvalFit | null;
}

export interface ElementDiagnosticsSnapshotInput {
  readonly publicSnapshot: Readonly<AvalSnapshot>;
  readonly configuredMotion: AvalMotion;
  readonly autoplay: AvalAutoplay;
  readonly fit: AvalFit | null;
  readonly host: Readonly<ElementHostEnvironmentSnapshot>;
  readonly page: Readonly<ElementPageResourceOwnerSnapshot>;
  readonly ownership: Readonly<ElementOwnershipSnapshot>;
  readonly session: Readonly<ElementDiagnosticsSessionSnapshot>;
  readonly trace: boolean;
}

/** Retains bounded, immutable observations without owning runtime decisions. */
export class ElementDiagnostics {
  readonly #trace = new ElementTrace();
  readonly #counters: Record<ElementDiagnosticsCounter, number> = {
    prepare: 0,
    sourceReplacement: 0,
    pause: 0,
    resume: 0,
    underflow: 0,
    contextRecovery: 0,
    cleanup: 0
  };
  #timerCount = 0;
  #stalePublicationCount = 0;
  #cleanupFailureCount = 0;
  #decoderLimit = 0;
  #decoderDiagnostics: readonly Readonly<AvalDecoderDiagnostic>[] =
    Object.freeze([]);
  #rendererLimit = 0;
  #rendererDiagnostics: readonly Readonly<AvalRendererDiagnostic>[] =
    Object.freeze([]);
  #playbackLifecycle: Readonly<AvalPlaybackLifecycleCounters> =
    emptyPlaybackLifecycleCounters();
  #cleanup: Readonly<SourceCleanupReceipt> | null = null;
  #terminalCleanup: Readonly<ElementTerminalCleanupProof> | null = null;
  #sourceGeneration = 0;

  public recordLifecycle(
    kind: "connect" | "disconnect" | "adopt" | "dispose" | "pagehide" |
      "bfcache-restore",
    generation: number
  ): void {
    this.#trace.record(kind, generation);
  }

  public recordInput(source: BindingSource, generation: number): void {
    this.#trace.record(`input-${source.replaceAll(".", "-")}`, generation);
  }

  public recordPublication(type: string, generation: number): void {
    this.#trace.record(`publish-${type}`, generation);
  }

  public recordPrepare(): void { this.#increment("prepare"); }
  public recordSourceReplacement(): void { this.#increment("sourceReplacement"); }
  public recordPause(): void { this.#increment("pause"); }
  public recordResume(): void { this.#increment("resume"); }
  public recordUnderflow(): void { this.#increment("underflow"); }

  public recordCleanup(): void { this.#increment("cleanup"); }

  public observeRetiredContextRecoveries(
    sourceGeneration: number,
    count: number
  ): void {
    if (sourceGeneration !== this.#sourceGeneration) return;
    this.#counters.contextRecovery = addElementCount(
      this.#counters.contextRecovery,
      count,
      "context recovery"
    );
  }

  public timerStarted(): void {
    this.#timerCount = nextElementSequence(this.#timerCount, "timer");
  }

  public timerSettled(): void {
    if (this.#timerCount === 0) throw new Error("element timer count underflow");
    this.#timerCount -= 1;
  }

  public recordStalePublication(): void {
    this.#stalePublicationCount = nextElementSequence(
      this.#stalePublicationCount,
      "stale publication"
    );
  }

  public beginSource(
    sourceGeneration: number,
    preservePlaybackLifecycle: boolean
  ): void {
    this.#sourceGeneration = sourceGeneration;
    this.#trace.record("source-start", sourceGeneration);
    this.#cleanupFailureCount = 0;
    this.#decoderLimit = 0;
    this.#rendererLimit = 0;
    this.#decoderDiagnostics = Object.freeze([]);
    this.#rendererDiagnostics = Object.freeze([]);
    if (!preservePlaybackLifecycle) {
      this.#playbackLifecycle = emptyPlaybackLifecycleCounters();
    }
  }

  public configureSourceCapacity(
    sourceGeneration: number,
    sourceCount: number
  ): void {
    if (sourceGeneration !== this.#sourceGeneration) return;
    if (!Number.isSafeInteger(sourceCount) || sourceCount < 0) {
      throw new RangeError("element diagnostic source count is invalid");
    }
    this.#decoderLimit = Math.min(sourceCount, MAX_RETAINED_SOURCES) *
      ELEMENT_DECODER_CAPACITY.workerCount;
    this.#rendererLimit = Math.min(sourceCount, MAX_RETAINED_SOURCES);
  }

  public observeRuntime(
    runtime: Readonly<PlayerSnapshot> | null,
    sourceGeneration: number
  ): void {
    if (runtime === null || sourceGeneration !== this.#sourceGeneration) return;
    this.#cleanupFailureCount = Math.max(
      this.#cleanupFailureCount,
      runtime.cleanupFailureCount ?? 0
    );
    const lifecycle = retainPlaybackLifecycleCounters(
      this.#playbackLifecycle,
      runtime.playbackLifecycle
    );
    if (!samePlaybackLifecycle(this.#playbackLifecycle, lifecycle)) {
      this.#playbackLifecycle = lifecycle;
    }
    this.#retainDecoderDiagnostics(runtime.decoderDiagnostics, sourceGeneration);
    this.#retainRendererDiagnostics(runtime.rendererDiagnostics, sourceGeneration);
  }

  public observeDecoderDiagnostics(
    sourceGeneration: number,
    diagnostics: readonly Readonly<PlayerDecoderDiagnostic>[]
  ): void {
    if (sourceGeneration !== this.#sourceGeneration) return;
    this.#retainDecoderDiagnostics(diagnostics, sourceGeneration);
  }

  public observeRendererDiagnostics(
    sourceGeneration: number,
    diagnostics: readonly Readonly<PlayerRendererDiagnostic>[]
  ): void {
    if (sourceGeneration !== this.#sourceGeneration) return;
    this.#retainRendererDiagnostics(diagnostics, sourceGeneration);
  }

  public observeCleanup(receipt: Readonly<SourceCleanupReceipt>): void {
    this.#cleanup = receipt;
  }

  public accounting(): Readonly<ElementDiagnosticsAccounting> {
    return Object.freeze({
      timerCount: this.#timerCount,
      stalePublicationCount: this.#stalePublicationCount
    });
  }

  public observeTerminalCleanup(
    proof: Readonly<ElementTerminalCleanupProof>
  ): void {
    if (this.#terminalCleanup?.completed === true && !proof.completed) return;
    this.#terminalCleanup = proof;
  }

  public snapshot(
    input: Readonly<ElementDiagnosticsSnapshotInput>
  ): Readonly<AvalDiagnostics> {
    const { publicSnapshot, session, host, page } = input;
    const runtime = session.runtime ?? emptyRuntime();
    const reduced = input.configuredMotion === "reduce" ||
      input.configuredMotion === "auto" && host.reducedMotion;
    const participant = page.ownership;
    return Object.freeze({
      elementGeneration: session.elementGeneration,
      sourceGeneration: publicSnapshot.generation,
      inputGeneration: session.inputGeneration,
      motionGeneration: session.motionGeneration,
      visibilityGeneration: session.visibilityGeneration,
      resizeGeneration: session.resizeGeneration,
      connected: publicSnapshot.connected,
      finalDisposed: this.#terminalCleanup?.completed === true,
      readiness: publicSnapshot.readiness,
      mode: publicSnapshot.mode,
      assurance: publicSnapshot.assurance,
      staticReason: publicSnapshot.staticReason,
      requestedState: publicSnapshot.requestedState,
      visualState: publicSnapshot.visualState,
      isTransitioning: publicSnapshot.isTransitioning,
      paused: publicSnapshot.paused,
      effectivelyVisible: publicSnapshot.effectivelyVisible,
      stateNames: Object.freeze([...publicSnapshot.stateNames]),
      eventNames: Object.freeze([...publicSnapshot.eventNames]),
      inputBindings: Object.freeze(publicSnapshot.inputBindings.map((binding) =>
        Object.freeze({ ...binding })
      )),
      configuredMotion: input.configuredMotion,
      hostReducedMotion: host.observedReducedMotion,
      autoplay: input.autoplay,
      fit: input.fit,
      lastFailure: publicSnapshot.lastError?.failure ?? null,
      counters: Object.freeze({
        ...this.#counters,
        contextRecovery: contextRecoveryCount(
          this.#counters.contextRecovery,
          session.runtimeIsActive ? runtime.contextRecoveryCount : 0
        )
      }),
      cleanup: this.#cleanup === null
        ? null : serializeSourceCleanupReceipt(this.#cleanup),
      elementOwnership: serializeElementOwnershipSnapshot(input.ownership),
      terminalCleanup: this.#terminalCleanup === null
        ? null : serializeElementTerminalCleanupProof(this.#terminalCleanup),
      outstanding: Object.freeze({
        player: session.runtime === null ? 0 : 1,
        decoder: outstandingDecoder(runtime.workerCount, participant.decoderState),
        bytes: participant.logicalBytes
      }),
      runtime: Object.freeze({
        selectedRendition: runtime.selectedRendition,
        selectedCodec: runtime.selectedCodec,
        rendererBackend: runtime.rendererBackend,
        selectedBitDepth: runtime.selectedBitDepth,
        transportMode: runtime.transportMode,
        declaredFileBytes: runtime.declaredFileBytes,
        metadataBytes: runtime.metadataBytes,
        verifiedBytes: runtime.verifiedBytes,
        residentBlobBytes: runtime.residentBlobBytes,
        activeTransportBodies: runtime.activeTransportBodies,
        pendingLoads: runtime.pendingLoads,
        interestedWaiters: runtime.interestedWaiters,
        stalePublicationCount: this.#stalePublicationCount,
        playerTrackedBytes: participant.logicalBytes,
        pagePhysicalBytes: page.page.physicalBytes,
        activeLeaseCount: participant.activeLeaseCount,
        decoderLeaseState: participant.decoderState,
        pageActiveDecoderSlotCount: page.page.active,
        pageQueuedDecoderTicketCount: page.page.queued,
        pageParkedDecoderTicketCount: page.page.parked,
        pageParticipantCount: page.page.participants,
        reclamationCount: 0,
        contextLossCount: runtime.contextLossCount,
        contextRecoveryCount: runtime.contextRecoveryCount,
        cleanupFailureCount: Math.max(
          this.#cleanupFailureCount,
          runtime.cleanupFailureCount ?? 0
        ),
        playbackLifecycle: this.#playbackLifecycle,
        decoderDiagnostics: this.#decoderDiagnostics,
        rendererDiagnostics: this.#rendererDiagnostics
      }),
      motion: Object.freeze({
        configured: input.configuredMotion,
        hostReducedMotion: host.observedReducedMotion,
        effective: reduced ? "reduce" : "full",
        actual: publicSnapshot.mode
      }),
      playIntent: Object.freeze({
        autoplay: input.autoplay,
        manualPlaying: !publicSnapshot.paused,
        paused: publicSnapshot.paused
      }),
      visibility: Object.freeze({
        documentVisible: host.documentVisible,
        intersecting: host.intersecting,
        positiveBox: host.positiveBox,
        effectivelyVisible: publicSnapshot.effectivelyVisible,
        observerSupported: host.observerSupported,
        runtimeVisibility: runtimeVisibility(
          session.runtime !== null,
          publicSnapshot.effectivelyVisible
        ),
        runtimeSuspension: runtimeSuspension(
          session.runtime !== null,
          session.runtimeSuspending,
          session.runtimeSuspended
        ),
        rebuildPending: session.rebuildPending
      }),
      presentation: Object.freeze({
        fit: input.fit ?? session.presentationFit,
        ...runtime.presentation
      }),
      ...(input.trace ? {
        elementTrace: this.#trace.snapshot(),
        runtimeTrace: runtime.trace
      } : {})
    } satisfies AvalDiagnostics);
  }

  #retainDecoderDiagnostics(
    diagnostics: readonly Readonly<PlayerDecoderDiagnostic>[],
    generation: number
  ): void {
    if (diagnostics.length === 0 || this.#decoderLimit === 0) return;
    const retained = new Map<string, Readonly<AvalDecoderDiagnostic>>(
      this.#decoderDiagnostics.map((diagnostic) => [
        `${String(diagnostic.sourceIndex)}:${String(diagnostic.lane)}`,
        diagnostic
      ] as const)
    );
    let changed = false;
    for (const diagnostic of diagnostics) {
      const key = `${String(diagnostic.sourceIndex)}:${String(diagnostic.lane)}`;
      if (!retained.has(key)) {
        retained.set(key, freezeDecoder(diagnostic, generation));
        changed = true;
      }
    }
    if (!changed) return;
    this.#decoderDiagnostics = Object.freeze([...retained.values()].sort(
      (left, right) => left.sourceIndex - right.sourceIndex || left.lane - right.lane
    ).slice(-this.#decoderLimit));
  }

  #retainRendererDiagnostics(
    diagnostics: readonly Readonly<PlayerRendererDiagnostic>[],
    generation: number
  ): void {
    if (diagnostics.length === 0 || this.#rendererLimit === 0) return;
    const retained = new Map(this.#rendererDiagnostics.map((diagnostic) => [
      diagnostic.sourceIndex,
      diagnostic
    ] as const));
    let changed = false;
    for (const diagnostic of diagnostics) {
      if (!retained.has(diagnostic.sourceIndex)) {
        retained.set(diagnostic.sourceIndex, freezeRenderer(diagnostic, generation));
        changed = true;
      }
    }
    if (!changed) return;
    this.#rendererDiagnostics = Object.freeze([...retained.values()].sort(
      (left, right) => left.sourceIndex - right.sourceIndex
    ).slice(-this.#rendererLimit));
  }

  #increment(counter: ElementDiagnosticsCounter): void {
    this.#counters[counter] = nextElementSequence(
      this.#counters[counter],
      counter
    );
  }
}

export function outstandingDecoder(workerCount: number, ticketState: string | null): number {
  return Math.max(
    workerCount,
    ticketState === null ? 0 : ELEMENT_DECODER_CAPACITY.workerCount
  );
}

export function contextRecoveryCount(retiredCount: number, liveCount: number): number {
  return retiredCount + liveCount;
}

export function runtimeVisibility(
  hasRuntime: boolean,
  effectivelyVisible: boolean
): "visible" | "hidden" | null {
  return hasRuntime ? effectivelyVisible ? "visible" : "hidden" : null;
}

export function runtimeSuspension(
  hasRuntime: boolean,
  suspending: boolean,
  suspended: boolean
): "active" | "suspending" | "suspended" | null {
  if (!hasRuntime) return null;
  return suspending ? "suspending" : suspended ? "suspended" : "active";
}

function freezeDecoder(
  diagnostic: Readonly<PlayerDecoderDiagnostic>,
  sourceGeneration: number
): Readonly<AvalDecoderDiagnostic> {
  return Object.freeze({
    ...diagnostic,
    sourceGeneration,
    exception: diagnostic.exception === null
      ? null : Object.freeze({ ...diagnostic.exception }),
    firstFrame: freezeFrame(diagnostic.firstFrame),
    lastGoodFrame: freezeFrame(diagnostic.lastGoodFrame),
    outputFailure: freezeOutputFailure(diagnostic.outputFailure),
    graph: Object.freeze({ ...diagnostic.graph })
  });
}

function freezeFrame(
  frame: Readonly<AvalDecoderFrameDiagnostic> | null
): Readonly<AvalDecoderFrameDiagnostic> | null {
  if (frame === null) return null;
  return Object.freeze({
    ...frame,
    visibleRect: frame.visibleRect === null
      ? null : Object.freeze({ ...frame.visibleRect }),
    colorSpace: freezeColorSpace(frame.colorSpace)
  });
}

function freezeOutputFailure(
  failure: Readonly<AvalDecoderOutputFailureDiagnostic> | null
): Readonly<AvalDecoderOutputFailureDiagnostic> | null {
  if (failure === null) return null;
  return Object.freeze({
    ...failure,
    expected: freezeExpected(failure.expected),
    actual: freezeObserved(failure.actual)
  });
}

function freezeExpected(
  value: Readonly<AvalDecoderExpectedOutputDiagnostic> | null
): Readonly<AvalDecoderExpectedOutputDiagnostic> | null {
  if (value === null) return null;
  return Object.freeze({
    ...value,
    visibleRect: Object.freeze({ ...value.visibleRect }),
    colorSpace: freezeColorSpace(value.colorSpace)
  });
}

function freezeObserved(
  value: Readonly<AvalDecoderObservedOutputDiagnostic> | null
): Readonly<AvalDecoderObservedOutputDiagnostic> | null {
  if (value === null) return null;
  return Object.freeze({
    ...value,
    visibleRect: value.visibleRect === null
      ? null : Object.freeze({ ...value.visibleRect }),
    colorSpace: freezeColorSpace(value.colorSpace)
  });
}

function freezeColorSpace(
  value: AvalDecoderColorSpaceDiagnostic | null
): AvalDecoderColorSpaceDiagnostic | null {
  return value === null ? null : Object.freeze([...value]) as AvalDecoderColorSpaceDiagnostic;
}

function freezeRenderer(
  diagnostic: Readonly<PlayerRendererDiagnostic>,
  sourceGeneration: number
): Readonly<AvalRendererDiagnostic> {
  return Object.freeze({
    ...diagnostic,
    sourceGeneration,
    exception: diagnostic.exception === null
      ? null : Object.freeze({ ...diagnostic.exception }),
    layout: Object.freeze({ ...diagnostic.layout }),
    backing: Object.freeze({ ...diagnostic.backing }),
    bytes: Object.freeze({ ...diagnostic.bytes }),
    limits: Object.freeze({ ...diagnostic.limits }),
    contextAttributes: diagnostic.contextAttributes === null
      ? null : Object.freeze({ ...diagnostic.contextAttributes })
  });
}

function samePlaybackLifecycle(
  left: Readonly<AvalPlaybackLifecycleCounters>,
  right: Readonly<AvalPlaybackLifecycleCounters>
): boolean {
  return left.outputsAccepted === right.outputsAccepted &&
    left.drawsCompleted === right.drawsCompleted &&
    left.logicalRunsCreated === right.logicalRunsCreated &&
    left.candidateCommits === right.candidateCommits &&
    left.runsClosed === right.runsClosed &&
    left.transitionStarts === right.transitionStarts &&
    left.transitionEnds === right.transitionEnds &&
    left.loopCrossings === right.loopCrossings &&
    left.nativeDecoderCreatesByLane[0] === right.nativeDecoderCreatesByLane[0] &&
    left.nativeDecoderCreatesByLane[1] === right.nativeDecoderCreatesByLane[1] &&
    left.nativeDecoderClosesByLane[0] === right.nativeDecoderClosesByLane[0] &&
    left.nativeDecoderClosesByLane[1] === right.nativeDecoderClosesByLane[1];
}

function emptyRuntime(): PlayerSnapshot {
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
    cleanupFailureCount: 0,
    playbackLifecycle: emptyPlaybackLifecycleCounters(),
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
