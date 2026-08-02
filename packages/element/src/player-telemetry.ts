import {
  emptyPlaybackLifecycleCounters,
  freezePlaybackLifecycleCounters,
  retainPlaybackLifecycleCounters,
  saturatingIncrement
} from "./playback-lifecycle.js";
import type {
  PlayerDecoderDiagnostic,
  PlayerRendererDiagnostic
} from "./player-contract.js";
import {
  mergePlayerDecoderDiagnostics,
  mergePlayerRendererDiagnostics
} from "./player-diagnostic-retention.js";
import type {
  AvalPlaybackLifecycleCounters,
  AvalRuntimeTraceRecord
} from "./public-types.js";

const MAX_RETAINED_TRACE_RECORDS = 512;
const MAXIMUM = Number.MAX_SAFE_INTEGER;
const EMPTY_TRACE: readonly Readonly<AvalRuntimeTraceRecord>[] = Object.freeze([]);

type TraceScheduler = AvalRuntimeTraceRecord["scheduler"];

export interface PlayerTraceObservation extends Omit<
  AvalRuntimeTraceRecord,
  "index" | "scheduler" | "counters"
> {
  readonly scheduler: Omit<TraceScheduler, "smoothSession">;
}

export interface PlayerTelemetryInput {
  readonly initialDecoderDiagnostics?:
    readonly Readonly<PlayerDecoderDiagnostic>[];
  readonly initialRendererDiagnostics?:
    readonly Readonly<PlayerRendererDiagnostic>[];
}

export interface PlayerTelemetrySnapshot {
  readonly trace: readonly Readonly<AvalRuntimeTraceRecord>[];
  readonly playbackLifecycle: Readonly<AvalPlaybackLifecycleCounters>;
  readonly decoderDiagnostics:
    readonly Readonly<PlayerDecoderDiagnostic>[];
  readonly rendererDiagnostics:
    readonly Readonly<PlayerRendererDiagnostic>[];
  readonly underflows: number;
  readonly settledRequests: number;
  readonly cleanedFrames: number;
  readonly incidents: number;
  readonly contextLossCount: number;
  readonly contextRecoveryCount: number;
  readonly cleanupFailureCount: number;
}

/** Owns immutable, bounded observations for one player generation. */
export class PlayerTelemetry {
  #trace: Readonly<AvalRuntimeTraceRecord>[] = [];
  #playbackLifecycle = emptyPlaybackLifecycleCounters();
  #decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[];
  #rendererDiagnostics: readonly Readonly<PlayerRendererDiagnostic>[];
  #underflows = 0;
  #settledRequests = 0;
  #cleanedFrames = 0;
  #incidents = 0;
  #contextLossCount = 0;
  #contextRecoveryCount = 0;
  #cleanupFailureCount = 0;
  #nextTraceIndex = 1;
  #snapshotWithTrace: Readonly<PlayerTelemetrySnapshot> | null = null;
  #snapshotWithoutTrace: Readonly<PlayerTelemetrySnapshot> | null = null;

  public constructor(input: Readonly<PlayerTelemetryInput> = {}) {
    this.#decoderDiagnostics = mergePlayerDecoderDiagnostics(
      Object.freeze([]),
      input.initialDecoderDiagnostics ?? Object.freeze([])
    );
    this.#rendererDiagnostics = mergePlayerRendererDiagnostics(
      Object.freeze([]),
      input.initialRendererDiagnostics ?? Object.freeze([])
    );
  }

  public snapshot(includeTrace = true): Readonly<PlayerTelemetrySnapshot> {
    const cached = includeTrace
      ? this.#snapshotWithTrace : this.#snapshotWithoutTrace;
    if (cached !== null) return cached;
    const snapshot = Object.freeze({
      trace: includeTrace ? Object.freeze([...this.#trace]) : EMPTY_TRACE,
      playbackLifecycle: this.#playbackLifecycle,
      decoderDiagnostics: this.#decoderDiagnostics,
      rendererDiagnostics: this.#rendererDiagnostics,
      underflows: this.#underflows,
      settledRequests: this.#settledRequests,
      cleanedFrames: this.#cleanedFrames,
      incidents: this.#incidents,
      contextLossCount: this.#contextLossCount,
      contextRecoveryCount: this.#contextRecoveryCount,
      cleanupFailureCount: this.#cleanupFailureCount
    });
    if (includeTrace) this.#snapshotWithTrace = snapshot;
    else this.#snapshotWithoutTrace = snapshot;
    return snapshot;
  }

  public recordTrace(observation: Readonly<PlayerTraceObservation>): void {
    const record = Object.freeze({
      ...observation,
      index: this.#nextTraceIndex,
      scheduler: Object.freeze({
        ...observation.scheduler,
        smoothSession: this.#incidents === 0
      }),
      counters: Object.freeze({
        underflows: this.#underflows,
        settledRequests: this.#settledRequests,
        cleanedFrames: this.#cleanedFrames
      })
    }) satisfies Readonly<AvalRuntimeTraceRecord>;
    this.#nextTraceIndex = saturatingIncrement(this.#nextTraceIndex);
    this.#trace.push(record);
    if (this.#trace.length > MAX_RETAINED_TRACE_RECORDS) {
      this.#trace.splice(0, this.#trace.length - MAX_RETAINED_TRACE_RECORDS);
    }
    this.#invalidate();
  }

  public captureDecoderLifecycle(
    lifecycle: Readonly<AvalPlaybackLifecycleCounters> | undefined
  ): void {
    if (lifecycle === undefined) return;
    const retained = retainPlaybackLifecycleCounters(
      this.#playbackLifecycle,
      lifecycle
    );
    if (samePlaybackLifecycle(this.#playbackLifecycle, retained)) return;
    this.#playbackLifecycle = retained;
    this.#invalidate();
  }

  public captureDecoderDiagnostics(
    diagnostics: readonly Readonly<PlayerDecoderDiagnostic>[]
  ): void {
    const retained = mergePlayerDecoderDiagnostics(
      this.#decoderDiagnostics,
      diagnostics
    );
    if (retained === this.#decoderDiagnostics) return;
    this.#decoderDiagnostics = retained;
    this.#invalidate();
  }

  public captureRendererDiagnostics(
    diagnostics: readonly Readonly<PlayerRendererDiagnostic>[]
  ): void {
    const retained = mergePlayerRendererDiagnostics(
      this.#rendererDiagnostics,
      diagnostics
    );
    if (retained === this.#rendererDiagnostics) return;
    this.#rendererDiagnostics = retained;
    this.#invalidate();
  }

  public recordDraw(): void {
    this.#incrementLifecycle("drawsCompleted");
  }

  public recordTransitionStart(): void {
    this.#incrementLifecycle("transitionStarts");
  }

  public recordTransitionEnd(): void {
    this.#incrementLifecycle("transitionEnds");
  }

  public recordLoopCrossing(): void {
    this.#incrementLifecycle("loopCrossings");
  }

  public recordSettledRequests(count: number): void {
    const settledRequests = saturatingAdd(this.#settledRequests, count);
    if (settledRequests === this.#settledRequests) return;
    this.#settledRequests = settledRequests;
    this.#invalidate();
  }

  public recordCleanedFrame(): void {
    this.#cleanedFrames = saturatingIncrement(this.#cleanedFrames);
    this.#invalidate();
  }

  public recordUnderflow(): Readonly<{
    incident: number;
    cumulativeCount: number;
  }> {
    this.#incidents = saturatingIncrement(this.#incidents);
    this.#underflows = saturatingIncrement(this.#underflows);
    this.#invalidate();
    return Object.freeze({
      incident: this.#incidents,
      cumulativeCount: this.#underflows
    });
  }

  public recordContextLoss(): void {
    this.#contextLossCount = saturatingIncrement(this.#contextLossCount);
    this.#invalidate();
  }

  public recordContextRecovery(): void {
    this.#contextRecoveryCount = saturatingIncrement(
      this.#contextRecoveryCount
    );
    this.#invalidate();
  }

  public recordCleanupFailure(): void {
    this.#cleanupFailureCount = saturatingIncrement(this.#cleanupFailureCount);
    this.#invalidate();
  }

  #incrementLifecycle(
    field: "drawsCompleted" | "transitionStarts" | "transitionEnds" |
      "loopCrossings"
  ): void {
    const value = saturatingIncrement(this.#playbackLifecycle[field]);
    if (value === this.#playbackLifecycle[field]) return;
    this.#playbackLifecycle = freezePlaybackLifecycleCounters({
      ...this.#playbackLifecycle,
      [field]: value
    });
    this.#invalidate();
  }

  #invalidate(): void {
    this.#snapshotWithTrace = null;
    this.#snapshotWithoutTrace = null;
  }
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

function saturatingAdd(current: number, added: number): number {
  if (!Number.isSafeInteger(added) || added < 0) {
    throw new RangeError("AVAL telemetry count is invalid");
  }
  return current >= MAXIMUM - added ? MAXIMUM : current + added;
}
