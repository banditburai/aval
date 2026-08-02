import {
  MotionGraphEngine,
  sameGraphPresentation,
  type MotionGraphDefinition,
  type MotionGraphResult,
  type MotionGraphSnapshot
} from "@pixel-point/aval-graph";

import type { AvalPlaybackError } from "./errors.js";
import { graphLoopCrossed } from "./graph.js";
import { reducedMotionSelected, type Metadata, type PlayerSnapshot } from
  "./player-contract.js";
import type {
  PlayerMediaContextEvent,
  PlayerMediaDrawFinalization,
  PlayerMediaLease,
  PlayerMediaRuntimePort
} from "./player-media-contract.js";
import { PlayerMediaFailure } from "./player-media-contract.js";
import {
  PreparationDeadline,
  PreparationGate,
  preparationTimeout
} from "./preparation-deadline.js";
import {
  abortError,
  candidateReport,
  isAbort,
  limit,
  playbackFailureCode,
  playerAbortReason,
  preparationOperationFailureCode,
  rendererFailureOperation,
  type CandidateReport
} from "./player-failures.js";
import { PublicationGate } from "./player-publication-gate.js";
import type { PlayerCandidateHandle } from "./player-candidate-contract.js";
import type { PlayerSessionHost, PlayerSessionPublicationPort } from
  "./player-session-contract.js";
import { PlayerSessionEffects } from "./player-session-effects.js";
import { PlayerSessionScheduler, type PlayerAdvanceOutcome,
  type PlayerScheduledAdvance } from "./player-session-scheduler.js";
import { PlayerTelemetry } from "./player-telemetry.js";
import { createPlayerSessionTrace } from "./player-session-trace.js";
import type { RuntimeReadinessResult, StaticReason } from "./public-types.js";

type PrepareResult = RuntimeReadinessResult;

const CONTEXT_RESTORE_MS = 5_000;
const NO_FAILURE = Symbol("no-player-session-failure");
const SESSION_ANIMATION_INVALIDATED = Object.freeze(new DOMException(
  "The AVAL session animation was invalidated",
  "AbortError"
));

export interface PlayerSessionInput {
  readonly candidate: Readonly<{
    staticReason: StaticReason | null;
    candidateReports: readonly Readonly<CandidateReport>[];
    candidateRank: number;
    reportCurrent?: boolean;
  }>;
  readonly host: Readonly<PlayerSessionHost>;
  readonly publications: PublicationGate;
  readonly preparationDeadline: PreparationDeadline;
  readonly media: PlayerMediaRuntimePort;
  readonly telemetry: PlayerTelemetry;
}

export class PlayerSession implements PlayerCandidateHandle {
  public readonly metadata: Readonly<Metadata>;
  readonly #host: Readonly<PlayerSessionHost>;
  readonly #preparationDeadline: PreparationDeadline;
  readonly #publications: PublicationGate;
  readonly #candidateRank: number;
  readonly #candidateReports: readonly Readonly<CandidateReport>[];
  readonly #reportCurrent: boolean;
  readonly #telemetry: PlayerTelemetry;
  readonly #media: PlayerMediaRuntimePort;
  readonly #effects: PlayerSessionEffects;
  readonly #scheduler: PlayerSessionScheduler;
  readonly #terminalSignal: Promise<never>;
  readonly #rejectTerminalSignal: (reason: unknown) => void;
  readonly #candidateInstallation = new PreparationGate();
  #preparationParent: PreparationDeadline | null = null;
  #staticReason: StaticReason | null;
  #preparation: Promise<PrepareResult> | null = null;
  #provisionalFailure: unknown = undefined;
  #recovery: Promise<PrepareResult> | null = null;
  #terminalWork: Promise<AvalPlaybackError> | null = null;
  #graph: MotionGraphEngine | null = null;
  #animationGeneration = 0;
  #disposed = false;
  #failed = false;
  #prepared = false;
  #activated = false;
  #published = false;
  #inUnderflow = false;
  #awaitingContextRestore = false;
  #contextRestoreTimer: number | null = null;
  #contextRestoreWait: Promise<void> | null = null;
  #resolveContextRestoreWait: (() => void) | null = null;
  #restartRequested = false;
  #animationResourcesRetired = false;
  #animationResourceRetirement: Promise<void> | null = null;

  public constructor(input: Readonly<PlayerSessionInput>) {
    let rejectTerminalSignal!: (reason: unknown) => void;
    this.#terminalSignal = new Promise<never>((_resolve, reject) => {
      rejectTerminalSignal = reject;
    });
    this.#rejectTerminalSignal = rejectTerminalSignal;
    void this.#terminalSignal.catch(() => undefined);
    this.#host = input.host;
    this.#preparationDeadline = input.preparationDeadline;
    this.#publications = input.publications;
    this.#telemetry = input.telemetry;
    this.#media = input.media;
    this.#candidateRank = input.candidate.candidateRank;
    this.#candidateReports = Object.freeze([
      ...input.candidate.candidateReports
    ]);
    this.#reportCurrent = input.candidate.reportCurrent ?? true;
    this.#staticReason = input.candidate.staticReason;
    this.#effects = new PlayerSessionEffects(
      input.host.publication,
      input.telemetry
    );
    this.#scheduler = new PlayerSessionScheduler(Object.freeze({
      timing: input.host.timing,
      frameDurationMs: input.media.descriptor.frameDurationMs,
      initiallyVisible: input.host.visible,
      shouldRun: () => this.#shouldSchedule(),
      advance: (scheduled: Readonly<PlayerScheduledAdvance>) =>
        this.#advance(scheduled),
      onFailure: (error: unknown) => this.#fail(error)
    }));
    this.metadata = input.media.descriptor.metadata;
    this.#host.publication.onMetadata(this.metadata);
    this.#host.publication.onReadiness("metadataReady");
    input.media.connectContextObserver((event) => this.contextChanged(event));
    void input.media.failure().catch((error) => {
      if (error instanceof PlayerMediaFailure) {
        this.#fail(error.reason, error.operation);
      } else this.#fail(error);
    });
  }

  public activate(options: Readonly<{ publish?: boolean }> = {}): void {
    if (this.#disposed || this.#failed) return;
    if (!this.#activated) {
      this.#installGraph();
      this.#activated = true;
    }
    if (options.publish !== false) this.publish();
  }

  public publish(): void {
    if (!this.#activated || this.#published || this.#disposed || this.#failed) return;
    this.#publications.activate();
    if (this.#disposed || this.#failed) return;
    this.#published = true;
    this.#scheduler.enable(this.#prepared);
  }

  public adoptPreparationParent(parent: PreparationDeadline): void {
    if (this.#preparationParent !== null || this.#disposed) {
      throw new Error("AVAL preparation parent ownership is invalid");
    }
    this.#preparationParent = parent;
  }

  public provisionalFailure(): unknown {
    return this.#provisionalFailure;
  }

  public completeCandidateInstallation(): void {
    this.#candidateInstallation.complete();
  }

  public failCandidateInstallation(reason: unknown): void {
    this.#candidateInstallation.fail(reason);
  }

  public prepare(options: Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
  }> = {}): Promise<PrepareResult> {
    if (this.#terminalWork !== null) {
      return limit(
        this.#terminalWork.then((error) => Promise.reject(error)),
        options.signal,
        options.timeoutMs,
        this.#host.timing
      );
    }
    if (this.#preparation === null) {
      this.#preparation = this.#prepareAfterCandidateInstallation();
    }
    const operation = Promise.race([this.#preparation, this.#terminalSignal]);
    return limit(operation, options.signal, options.timeoutMs, this.#host.timing);
  }

  public async setState(state: string): Promise<void> {
    if (!this.#hasState(state)) throw new RangeError("Unknown AVAL state");
    await this.prepare();
    const preparedTerminal = this.#terminalWork;
    if (preparedTerminal !== null) throw await preparedTerminal;
    try {
      const result = this.#requireGraph().request(state);
      const promise = this.#effects.register(result);
      this.#applyWithoutDraw(result);
      this.#media.prepareRoutes(this.#requireGraph().snapshot());
      this.#scheduler.schedule();
      await promise;
    } catch (error) {
      const terminal = this.#terminalWork;
      if (terminal !== null) throw await terminal;
      throw error;
    }
    const settledTerminal = this.#terminalWork;
    if (settledTerminal !== null) throw await settledTerminal;
  }

  public send(event: string): boolean {
    const graph = this.#graph;
    if (!this.#activated || this.#disposed || this.#failed || graph === null) {
      return false;
    }
    const result = graph.send(event);
    this.#applyWithoutDraw(result);
    if (this.#prepared) this.#media.prepareRoutes(graph.snapshot());
    this.#scheduler.schedule();
    return result.accepted === true;
  }

  public canSend(event: string): boolean {
    return this.#activated && !this.#disposed && !this.#failed &&
      (this.#graph?.canSend(event) ?? false);
  }

  public readyFor(state: string): boolean {
    if (this.#disposed || this.#failed || !this.#prepared ||
      this.#staticReason !== null ||
      !this.#hasState(state)) return false;
    const graph = this.#graph;
    if (graph === null) return false;
    const from = graph.snapshot().requestedState;
    if (from === null) return false;
    if (from === state) return true;
    const edge = this.#media.descriptor.graph.edges.find((candidate) =>
      candidate.from === from && candidate.to === state
    );
    return edge !== undefined && this.#media.edgeReady(edge.id);
  }

  public pause(): void {
    this.#scheduler.pause();
  }

  public async resume(): Promise<void> {
    if (!this.#candidateInstallation.settled) {
      this.#scheduler.resumeBeforeInstallation();
      return;
    }
    const epoch = this.#scheduler.pauseEpoch;
    await this.prepare();
    const preparedTerminal = this.#terminalWork;
    if (preparedTerminal !== null) throw await preparedTerminal;
    if (!this.#scheduler.resumeIfCurrent(epoch)) return;
    const resumedTerminal = this.#terminalWork;
    if (resumedTerminal !== null) throw await resumedTerminal;
  }

  public async setMotion(
    policy: "auto" | "reduce" | "full",
    reducedMotion: boolean
  ): Promise<void> {
    if (this.#terminalWork !== null) throw await this.#terminalWork;
    if (reducedMotionSelected(policy, reducedMotion)) {
      if (this.#staticReason === "reduced-motion") {
        if (!this.#animationResourcesRetired) {
          await this.#recoverStatic("reduced-motion");
        }
        return;
      }
      this.#installGraph();
      this.#staticReason = "reduced-motion";
      this.#preparationDeadline.cancel(abortError());
      await this.#recoverStatic("reduced-motion");
      return;
    }
    if (this.#staticReason === "reduced-motion") {
      if (this.#restartRequested) return;
      const state = this.#requireGraph().snapshot().requestedState;
      if (state !== null) {
        this.#restartRequested = true;
        this.#host.publication.onRestart(state);
      }
      return;
    }
    if (this.#staticReason === null) await this.resume();
  }

  public async suspend(
    reason: "visibility-suspended"
  ): Promise<RuntimeReadinessResult> {
    if (this.#terminalWork !== null) throw await this.#terminalWork;
    if (this.#disposed) throw abortError();
    this.#installGraph();
    this.#staticReason = reason;
    this.#preparationDeadline.cancel(abortError());
    const result = await this.#recoverStatic(reason);
    this.#preparation = Promise.resolve(result);
    return result;
  }

  public setVisibility(visible: boolean): void {
    this.#scheduler.setVisible(visible);
  }

  public contextChanged(change: Readonly<PlayerMediaContextEvent>): void {
    if (this.#disposed || this.#failed || this.#staticReason !== null) return;
    if (change.state === "error") {
      this.#fail(change.error, "render");
      return;
    }
    if (change.state === "lost") {
      if (this.#awaitingContextRestore) return;
      this.#awaitingContextRestore = true;
      this.#beginContextRestoreWait();
      this.#animationGeneration += 1;
      this.#telemetry.recordContextLoss();
      this.#scheduler.cancel();
      this.#host.publication.onFailure("context-loss", "render", false);
      this.#contextRestoreTimer = this.#host.timing.setTimeout(() => {
        this.#contextRestoreTimer = null;
        if (
          !this.#awaitingContextRestore ||
          this.#disposed ||
          this.#failed ||
          this.#staticReason !== null
        ) return;
        void this.#terminate("context-loss", "render");
      }, CONTEXT_RESTORE_MS);
      return;
    }
    if (!this.#awaitingContextRestore) return;
    this.#clearContextRestoreTimer();
    this.#awaitingContextRestore = false;
    this.#completeContextRestoreWait();
    this.#telemetry.recordContextRecovery();
    if (!this.#prepared) return;
    const state = this.#graph?.snapshot().requestedState;
    if (state !== null && state !== undefined && !this.#restartRequested) {
      this.#restartRequested = true;
      this.#host.publication.onRestart(state);
    }
  }

  public resize(width: number, height: number, dpr: number, fit: string): void {
    this.#media.resize(Object.freeze({ width, height, dpr, fit }));
  }

  public snapshot(trace: boolean): Readonly<PlayerSnapshot> {
    const media = this.#media.snapshot();
    const graph = this.#graph?.snapshot();
    const telemetry = this.#telemetry.snapshot(trace);
    return Object.freeze({
      requestedState: graph?.requestedState ?? null,
      visualState: graph?.visualState ?? null,
      transitioning: graph?.isTransitioning ?? false,
      selectedRendition: this.#staticReason === null
        ? this.#media.descriptor.rendition.id : null,
      selectedCodec: this.#staticReason === null
        ? this.#media.descriptor.rendition.codec : null,
      rendererBackend: media.rendererBackend,
      selectedBitDepth: this.#staticReason === null
        ? this.#media.descriptor.rendition.bitDepth : null,
      transportMode: media.transportMode,
      declaredFileBytes: media.declaredFileBytes,
      metadataBytes: media.metadataBytes,
      verifiedBytes: media.verifiedBytes,
      residentBlobBytes: media.residentBlobBytes,
      activeTransportBodies: media.activeTransportBodies,
      pendingLoads: media.pendingLoads,
      interestedWaiters: media.interestedWaiters,
      workerCount: media.workerCount,
      openFrames: media.openFrames,
      contextLossCount: Math.max(
        telemetry.contextLossCount,
        media.contextLossCount
      ),
      contextRecoveryCount: Math.max(
        telemetry.contextRecoveryCount,
        media.contextRecoveryCount
      ),
      cleanupFailureCount: telemetry.cleanupFailureCount,
      playbackLifecycle: telemetry.playbackLifecycle,
      decoderDiagnostics: telemetry.decoderDiagnostics,
      rendererDiagnostics: telemetry.rendererDiagnostics,
      presentation: media.presentation,
      trace: telemetry.trace
    });
  }

  public async settled(): Promise<void> {
    await Promise.allSettled([
      this.#media.settled(),
      ...(this.#terminalWork === null ? [] : [this.#terminalWork])
    ]);
  }

  public async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.failCandidateInstallation(abortError());
      this.#clearContextRestoreTimer();
      this.#awaitingContextRestore = false;
      this.#completeContextRestoreWait();
      this.#animationGeneration += 1;
      this.#preparationDeadline.dispose();
      this.#preparationParent?.dispose();
      this.#preparationParent = null;
      this.#scheduler.dispose();
      const graph = this.#graph;
      if (graph !== null && graph.snapshot().readiness !== "disposed") {
        this.#applyWithoutDraw(graph.dispose({
          ...(graph.snapshot().visualState === null
            ? {}
            : { retainedVisualState: graph.snapshot().visualState! })
        }));
      }
      this.#effects.rejectAll("AbortError");
    }
    if (this.#animationResourcesRetired) return;
    await this.#retireAnimationResources();
  }

  async #prepareAfterCandidateInstallation(): Promise<PrepareResult> {
    await this.#candidateInstallation.wait();
    return this.#prepareBounded();
  }

  async #prepareBounded(): Promise<PrepareResult> {
    try {
      this.#preparationDeadline.start();
      this.#preparationDeadline.signal.throwIfAborted();
      const result = await limit(this.#start(), this.#preparationDeadline.signal);
      this.#prepared = true;
      this.#preparationDeadline.complete();
      return result;
    } catch (error) {
      if (this.#provisionalFailure === undefined) {
        this.#provisionalFailure = error;
      }
      if (error === SESSION_ANIMATION_INVALIDATED) {
        await (this.#contextRestoreWait ?? Promise.resolve());
        if (this.#disposed || this.#host.signal.aborted) {
          throw playerAbortReason(this.#host.signal);
        }
        if (this.#terminalWork !== null) throw await this.#terminalWork;
        if (this.#staticReason !== null) {
          return this.#recoverStatic(this.#staticReason);
        }
        throw error;
      }
      if (this.#disposed || this.#host.signal.aborted) {
        throw playerAbortReason(this.#host.signal);
      }
      if (this.#terminalWork !== null) throw await this.#terminalWork;
      if (this.#staticReason !== null) {
        return this.#recoverStatic(this.#staticReason);
      }
      const code = preparationOperationFailureCode(
        error,
        this.#preparationDeadline.timedOut
      );
      throw await this.#terminate(code, "prepare");
    }
  }

  #installGraph(): MotionGraphEngine {
    if (this.#graph !== null) return this.#graph;
    const graph = new MotionGraphEngine();
    graph.install(this.#media.descriptor.graph);
    this.#graph = graph;
    this.#effects.seed(graph.snapshot());
    this.#syncMediaGraph(graph.snapshot());
    return graph;
  }

  async #start(): Promise<PrepareResult> {
    const graph = this.#installGraph();
    if (this.#preparationDeadline.timedOut) throw preparationTimeout();
    if (this.#staticReason !== null) {
      this.#applyWithoutDraw(graph.beginStatic(this.#staticReason));
      await this.#retireAnimationResources();
      const terminal = this.#terminalWork;
      if (terminal !== null) throw await terminal;
      return this.#result();
    }
    this.#preparationDeadline.signal.throwIfAborted();
    await this.#media.qualifyOutput(this.#preparationDeadline.signal);
    this.#preparationDeadline.signal.throwIfAborted();
    await this.#media.prepare(Object.freeze({
      initialState: this.#host.initialState ?? this.metadata.initialState,
      initialBody: this.#host.initialBody,
      signal: this.#preparationDeadline.signal
    }));
    this.#preparationDeadline.signal.throwIfAborted();
    const animated = graph.beginAnimated();
    await this.#drawInitialPresentation(animated);
    this.#media.prepareRoutes(graph.snapshot());
    this.#host.publication.onReadiness("visualReady");
    this.#host.publication.onReadiness("interactiveReady");
    this.#scheduler.resetClock();
    this.#scheduler.schedule();
    return this.#result();
  }

  async #drawInitialPresentation(
    animated: Readonly<MotionGraphResult>
  ): Promise<void> {
    if (animated.presentation === null) {
      throw new Error("Invalid AVAL graph presentation");
    }
    for (;;) {
      this.#preparationDeadline.signal.throwIfAborted();
      const acquired = this.#media.acquirePresentation(animated.presentation);
      if (acquired.kind !== "ready") {
        throw new Error("AVAL initial media is unavailable");
      }
      try {
        await this.#applyWithDraw(
          animated,
          true,
          this.#host.timing.now(),
          null,
          acquired.lease
        );
        return;
      } catch (error) {
        if (error !== SESSION_ANIMATION_INVALIDATED) throw error;
        await limit(
          this.#contextRestoreWait ?? Promise.resolve(),
          this.#preparationDeadline.signal
        );
        if (this.#disposed || this.#host.signal.aborted) {
          throw playerAbortReason(this.#host.signal);
        }
        if (this.#terminalWork !== null) throw await this.#terminalWork;
        if (this.#staticReason !== null) throw error;
      }
    }
  }

  #recoverStatic(reason: StaticReason): Promise<PrepareResult> {
    if (this.#recovery !== null) return this.#recovery;
    this.#animationGeneration += 1;
    const operation = Promise.resolve().then(() => this.#performRecovery(reason));
    this.#recovery = operation;
    void operation.finally(() => {
      if (this.#recovery === operation) this.#recovery = null;
    }).catch(() => undefined);
    return operation;
  }

  async #performRecovery(reason: StaticReason): Promise<PrepareResult> {
    if (this.#disposed) throw abortError();
    if (!this.#published) this.#publications.discardAnimatedPresentation();
    this.#staticReason = reason;
    this.#scheduler.cancel();
    const graph = this.#installGraph();
    const snapshot = graph.snapshot();
    let recovery: Readonly<MotionGraphResult> | null = null;
    if (snapshot.readiness === "preparing") {
      recovery = graph.beginStatic(reason);
    } else if (snapshot.readiness !== "disposed" && snapshot.readiness !== "error") {
      recovery = graph.recoverStatic(reason, {
        ...(snapshot.visualState === null
          ? {}
          : { retainedVisualState: snapshot.visualState })
      });
    }
    if (recovery !== null) this.#applyWithoutDraw(recovery);
    await this.#retireAnimationResources();
    const terminal = this.#terminalWork;
    if (terminal !== null) throw await terminal;
    this.#prepared = true;
    this.#preparationDeadline.complete();
    const result = this.#result();
    this.#preparation = Promise.resolve(result);
    return result;
  }

  #retireAnimationResources(): Promise<void> {
    if (this.#animationResourcesRetired) return Promise.resolve();
    if (this.#animationResourceRetirement !== null) {
      return this.#animationResourceRetirement;
    }
    const operation = this.#performAnimationResourceRetirement();
    this.#animationResourceRetirement = operation;
    const clear = (): void => {
      if (this.#animationResourceRetirement === operation) {
        this.#animationResourceRetirement = null;
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  async #performAnimationResourceRetirement(): Promise<void> {
    this.#clearContextRestoreTimer();
    this.#awaitingContextRestore = false;
    this.#completeContextRestoreWait();
    this.#scheduler.cancel();
    this.#preparationDeadline.cancel(abortError());
    await this.#media.retire();
    this.#animationResourcesRetired = true;
  }

  #clearContextRestoreTimer(): void {
    const timer = this.#contextRestoreTimer;
    if (timer === null) return;
    this.#contextRestoreTimer = null;
    this.#host.timing.clearTimeout(timer);
  }

  #beginContextRestoreWait(): void {
    if (this.#contextRestoreWait !== null) return;
    this.#contextRestoreWait = new Promise<void>((resolve) => {
      this.#resolveContextRestoreWait = resolve;
    });
  }

  #completeContextRestoreWait(): void {
    this.#resolveContextRestoreWait?.();
    this.#resolveContextRestoreWait = null;
    this.#contextRestoreWait = null;
  }

  #result() {
    const candidates = Object.freeze([
      ...this.#candidateReports,
          ...(this.#reportCurrent
        ? [candidateReport(
            this.#media.descriptor.rendition.id,
            this.#candidateRank,
            this.#staticReason
          )]
        : [])
    ]);
    if (this.#staticReason !== null) {
      return Object.freeze({
        mode: "static" as const,
        reason: this.#staticReason,
        report: Object.freeze({
          readiness: "staticReady" as const,
          selectedRendition: null,
          candidates
        })
      });
    }
    return Object.freeze({
      mode: "animated" as const,
      assurance: "best-effort" as const,
      report: Object.freeze({
        readiness: "interactiveReady" as const,
        selectedRendition: this.#media.descriptor.rendition.id,
        candidates
      })
    });
  }

  #shouldSchedule(): boolean {
    const graph = this.#graph;
    const snapshot = graph?.snapshot();
    return !(
      !this.#activated || !this.#published || this.#disposed || this.#failed ||
      this.#staticReason !== null || this.#awaitingContextRestore ||
      this.#restartRequested || graph === null ||
      snapshot?.readiness !== "animated" || !this.#needsTick(snapshot)
    );
  }

  async #advance(
    scheduled: Readonly<PlayerScheduledAdvance>
  ): Promise<PlayerAdvanceOutcome> {
    const graph = this.#requireGraph();
    const before = graph.snapshot();
    const route = this.#media.routeDecision(before);
    if (route.blocksPresentation) return this.#waitForRoute(before);
    const tick = {
      contentOrdinal: scheduled.ordinal,
      routeReady: route.ready
    };
    const preview = graph.previewTick(tick);
    if (preview.presentation === null) {
      throw new Error("Invalid AVAL graph presentation");
    }
    const acquired = this.#media.acquirePresentation(preview.presentation);
    if (acquired.kind === "waiting") {
      this.#media.prepareRoutes(before, preview.presentation);
      return this.#waitForRoute(before);
    }
    this.#inUnderflow = false;
    let leaseTransferred = false;
    try {
      const result = graph.tick(tick);
      if (!sameGraphPresentation(preview.presentation, result.presentation)) {
        throw new Error("AVAL graph preview diverged from its committed tick");
      }
      this.#scheduler.commitTick();
      leaseTransferred = true;
      await this.#applyWithDraw(
        result,
        route.ready,
        scheduled.callbackStart,
        scheduled.rationalDeadlineUs,
        acquired.lease
      );
      if (graphLoopCrossed(
        before.presentation,
        result.presentation,
        this.#media.descriptor.graph
      )) {
        this.#telemetry.recordLoopCrossing();
      }
      this.#media.prepareRoutes(graph.snapshot());
      return "progressed";
    } catch (error) {
      if (!leaseTransferred) this.#media.cancelPresentation(acquired.lease);
      throw error;
    }
  }

  #waitForRoute(
    snapshot: Readonly<MotionGraphSnapshot>
  ): PlayerAdvanceOutcome {
    if (!this.#inUnderflow) {
      this.#inUnderflow = true;
      const { incident, cumulativeCount } = this.#telemetry.recordUnderflow();
      this.#host.publication.onEvent("underflow", Object.freeze({
        incident,
        heldPresentationOrdinal: this.#scheduler.ordinal.toString(),
        cumulativeCount,
        isTransitioning: snapshot.isTransitioning
      }));
    }
    return "waiting-route";
  }

  #needsTick(snapshot: Readonly<MotionGraphSnapshot>): boolean {
    if (snapshot.phase !== "stable") return snapshot.phase !== "static";
    if (snapshot.pendingEdgeId !== null || snapshot.activeEdgeId !== null ||
      snapshot.followOnEdgeId !== null) return true;
    const presentation = snapshot.presentation;
    if (presentation?.kind !== "body") return presentation !== null;
    const unit = this.#bodyUnit(presentation.state, presentation.unitId);
    if (unit.kind === "loop" || presentation.frameIndex < unit.frameCount - 1) {
      return true;
    }
    return this.#media.descriptor.graph.edges.some((edge) =>
      edge.from === presentation.state && edge.trigger?.type === "completion"
    );
  }

  #applyWithoutDraw(result: Readonly<MotionGraphResult>): void {
    this.#effects.applyAll(result);
    this.#syncMediaGraph(result.snapshot);
  }

  async #applyWithDraw(
    result: Readonly<MotionGraphResult>,
    routeReady: boolean,
    callbackStart: number,
    rationalDeadlineUs: number | null,
    lease: PlayerMediaLease | null
  ): Promise<void> {
    const generation = this.#animationGeneration;
    const presentation = result.presentation;
    if (presentation === null) throw new Error("Invalid AVAL graph presentation");
    let finalization: Readonly<PlayerMediaDrawFinalization> | null = null;
    let primaryFailure: unknown = NO_FAILURE;
    try {
      const post = this.#effects.applyBeforeDraw(result);
      const draw = await this.#media.draw(Object.freeze({
        presentation,
        lease
      }));
      finalization = draw.finalization;
      this.#assertSessionAnimation(generation);
      const submissionComplete = this.#host.timing.now();
      this.#effects.applyAfterDraw(
        post,
        result.snapshot,
        () => this.#assertSessionAnimation(generation)
      );
      this.#assertSessionAnimation(generation);
      this.#syncMediaGraph(result.snapshot);
      this.#telemetry.recordTrace(createPlayerSessionTrace(Object.freeze({
        graph: this.#media.descriptor.graph,
        result,
        routeReady,
        callbackStart,
        submissionComplete,
        rationalDeadlineUs,
        media: draw.receipt
      })));
    } catch (error) {
      primaryFailure = error;
      if (finalization === null) this.#media.cancelPresentation(lease);
      throw error;
    } finally {
      if (finalization !== null) {
        try { this.#media.finalizeDraw(finalization); }
        catch (error) {
          if (primaryFailure === NO_FAILURE) throw error;
          this.#telemetry.recordCleanupFailure();
        }
      }
    }
  }

  #syncMediaGraph(snapshot: Readonly<MotionGraphSnapshot>): void {
    this.#media.updateGraphDiagnostic(Object.freeze({
      requestedState: snapshot.requestedState,
      visualState: snapshot.visualState
    }));
  }

  #assertSessionAnimation(generation: number): void {
    if (this.#disposed || this.#failed || this.#awaitingContextRestore ||
      this.#staticReason !== null ||
      this.#animationGeneration !== generation) {
      throw SESSION_ANIMATION_INVALIDATED;
    }
  }

  #hasState(id: string): boolean {
    return this.#media.descriptor.graph.states.some((state) => state.id === id);
  }

  #bodyUnit(
    stateId: string,
    unitId: string
  ): Readonly<MotionGraphDefinition["states"][number]["body"]> {
    const state = this.#media.descriptor.graph.states.find(({ id }) =>
      id === stateId
    );
    if (state === undefined || state.body.unitId !== unitId) {
      throw new Error("Invalid AVAL graph");
    }
    return state.body;
  }

  #requireGraph(): MotionGraphEngine {
    const graph = this.#graph;
    if (graph === null) throw new Error("AVAL graph is not prepared");
    return graph;
  }

  #fail(reason: unknown, operation = "playback"): void {
    if (this.#disposed || this.#failed) return;
    if (reason === SESSION_ANIMATION_INVALIDATED) return;
    if (isAbort(reason) && (
      this.#host.signal.aborted ||
      this.#awaitingContextRestore ||
      this.#staticReason !== null ||
      this.#animationResourceRetirement !== null ||
      this.#animationResourcesRetired
    )) return;
    if (!this.#prepared && this.#provisionalFailure === undefined) {
      this.#provisionalFailure = reason;
    }
    void this.#terminate(
      playbackFailureCode(reason),
      rendererFailureOperation(reason, operation)
    );
  }

  #terminate(
    code: Parameters<PlayerSessionPublicationPort["onPlaybackFailure"]>[0],
    operation: string
  ): Promise<AvalPlaybackError> {
    if (this.#terminalWork !== null) return this.#terminalWork;
    let resolveTerminal!: (error: AvalPlaybackError) => void;
    let rejectTerminal!: (reason: unknown) => void;
    const work = new Promise<AvalPlaybackError>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    this.#terminalWork = work;
    void work.catch(() => undefined);
    this.#failed = true;
    if (!this.#published) this.#publications.discard();
    this.#animationGeneration += 1;
    void this.#finishTerminal(code, operation).then(
      resolveTerminal,
      rejectTerminal
    );
    return work;
  }

  async #finishTerminal(
    code: Parameters<PlayerSessionPublicationPort["onPlaybackFailure"]>[0],
    operation: string
  ): Promise<AvalPlaybackError> {
    this.#scheduler.dispose();
    this.#clearContextRestoreTimer();
    this.#awaitingContextRestore = false;
    this.#completeContextRestoreWait();
    const graph = this.#graph;
    if (graph !== null && graph.snapshot().readiness !== "disposed") {
      try { graph.dispose(); }
      catch { /* cleanup cannot replace the canonical playback error */ }
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.#retireAnimationResources();
        break;
      } catch {
        this.#telemetry.recordCleanupFailure();
      }
    }
    if (this.#disposed || this.#host.signal.aborted) {
      const error = playerAbortReason(this.#host.signal);
      this.#effects.rejectAll(error);
      this.#rejectTerminalSignal(error);
      throw error;
    }
    const error = this.#host.publication.onPlaybackFailure(code, operation);
    this.#effects.rejectAll(error);
    this.#rejectTerminalSignal(error);
    return error;
  }
}
