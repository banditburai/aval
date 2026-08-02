import {
  createSourceCleanupReceipt,
  playerSnapshotDisposed,
  proveSourceRetirement,
  type SourceCleanupReceipt
} from "./element-cleanup-proof.js";
import type {
  ElementRuntimeGeometry,
  ElementRuntimePageResourcePort,
  ElementRuntimePresentationPort,
  ElementRuntimePublicationPort,
  ElementRuntimeReadPort,
  ElementRuntimeSessionSnapshot
} from "./element-runtime-contract.js";
import { LifecycleLane } from "./lifecycle-lane.js";
import {
  AvalNotReadyError,
  AvalPlaybackError,
  ElementCleanupIncompleteError,
  createAvalPublicFailure
} from "./errors.js";
import { createRealmPlatform, runtimeHostSupported } from "./element-host-environment.js";
import type {
  Metadata,
  Player,
  PlayerInput,
  PlayerSnapshot
} from "./player-contract.js";
import type {
  AvalMotion,
  AvalPublicFailure,
  AvalSnapshot,
  Binding,
  RuntimeReadinessResult,
  StaticReason
} from "./public-types.js";
import { ELEMENT_SETUP_TIMEOUT_MS, preparationBudgetMs } from "./preparation-budget.js";
import {
  createElementOperationTiming,
  elementAbortError,
  isElementAbort,
  isElementPreparationTimeout,
  remainingElementPreparationMs,
  withElementOperationLimits
} from "./preparation-deadline.js";
import { resumeCurrent } from "./playback-lifecycle.js";

let runtimeModule: Promise<Readonly<ElementRuntimeModule>> | null = null;
type FailureInput = AvalPublicFailure["code"];
export interface ElementRuntimeModule {
  createPlayer(input: Readonly<PlayerInput>): Promise<Player>;
}
export type ElementRuntimeLoader = () => Promise<Readonly<ElementRuntimeModule>>;
const loadRuntime: ElementRuntimeLoader = () =>
  runtimeModule ??= import("./player.js");

export interface ElementRuntimeSessionInput {
  readonly read: Readonly<ElementRuntimeReadPort>;
  readonly publish: Readonly<ElementRuntimePublicationPort>;
  readonly presentation: Readonly<ElementRuntimePresentationPort>;
  readonly pageResources: Readonly<ElementRuntimePageResourcePort>;
}

interface ElementRestartIntent {
  readonly player: Player | null;
  readonly state: string;
  readonly visibleOnly: boolean;
}

export class ElementRuntimeSession {
  readonly #read: Readonly<ElementRuntimeReadPort>;
  readonly #publish: Readonly<ElementRuntimePublicationPort>;
  readonly #presentation: Readonly<ElementRuntimePresentationPort>;
  readonly #page: Readonly<ElementRuntimePageResourcePort>;
  readonly #loadRuntime: ElementRuntimeLoader;
  readonly #lifecycle = new LifecycleLane();
  #player: Player | null = null;
  #retiringPlayer: Player | null = null;
  #retiringDeclaredFileBytes = 0;
  #visibilityPlayer: Player | null = null;
  #preparingPlayer: Player | null = null;
  #suspendingPlayer: Player | null = null;
  #suspension: Promise<RuntimeReadinessResult> | null = null;
  #suspendedPlayer: Player | null = null;
  #restart: Readonly<ElementRestartIntent> | null = null;
  #load: Promise<RuntimeReadinessResult> | null = null;
  #controller: AbortController | null = null;
  #metadata: Readonly<Metadata> | null = null;
  #finalDisposed = false;
  #disposePromise: Promise<void> | null = null;
  #reloadQueued = false;
  #reloadReplace = false;
  #inputGeneration = 0;
  #motionGeneration = 0;
  #visibilityGeneration = 0;
  #resizeGeneration = 0;
  #terminalError: AvalPlaybackError | null = null;
  #cleanup: Readonly<SourceCleanupReceipt> | null = null;
  #playSequence = 0;

  public constructor(
    input: Readonly<ElementRuntimeSessionInput>, loader: ElementRuntimeLoader = loadRuntime
  ) {
    this.#read = input.read;
    this.#publish = input.publish;
    this.#presentation = input.presentation;
    this.#page = input.pageResources;
    this.#loadRuntime = loader;
  }

  public get finalDisposed(): boolean { return this.#finalDisposed; }
  public get hasDisposeOperation(): boolean { return this.#disposePromise !== null; }
  public get metadata(): Readonly<Metadata> | null { return this.#metadata; }
  public get inputBindings(): readonly Readonly<Binding>[] | null {
    return this.#metadata !== null && this.#player !== null
      ? this.#metadata.bindings : null;
  }
  public get sourceGeneration(): number {
    return this.#publicState.generation;
  }
  public connected(connectionEdge = false): void {
    if (this.#finalDisposed) return;
    if (connectionEdge ||
      this.#load === null && this.#player === null &&
      this.#retiringPlayer === null
    ) this.scheduleReload(false);
  }
  public disconnected(): void {
    this.#load = null;
    const retirement = this.#queueRetirement(false);
    const finish = (): void => {
      const state = this.#publicState;
      if (!state.connected && !this.#finalDisposed) {
        this.#publish.readinessChanged(
          "unready",
          undefined,
          this.sourceGeneration
        );
      }
    };
    void retirement.then(finish, finish);
  }
  public adopted(): Promise<void> {
    this.#load = null;
    return this.#queueRetirement(false);
  }
  public scheduleReload(replace = true, resetRestart = true): void {
    if (!this.#connected || this.#finalDisposed) return;
    if (resetRestart) {
      this.#restart = null;
      if (replace) this.#page.invalidateRequest();
    }
    this.#reloadReplace ||= replace;
    if (this.#reloadQueued) return;
    this.#reloadQueued = true;
    queueMicrotask(() => {
      this.#reloadQueued = false;
      const shouldReplace = this.#reloadReplace;
      this.#reloadReplace = false;
      if (!this.#connected || this.#finalDisposed) return;
      if (this.#restart?.visibleOnly === true && !this.#effectivelyVisible) {
        this.#restart = null;
        return;
      }
      if (!shouldReplace && this.#load !== null) return;
      this.#trackLoad(this.#queueGeneration());
    });
  }
  public flushSourceMutations(): boolean {
    const changed = this.#read.takeSourceChanges();
    if (changed) {
      this.#restart = null;
      this.#page.invalidateRequest();
      this.#reloadReplace = true;
    }
    if (!changed && !this.#reloadQueued) return false;
    this.#reloadQueued = false;
    const replace = this.#reloadReplace;
    this.#reloadReplace = false;
    if (replace && this.#connected && !this.#finalDisposed) {
      this.#trackLoad(this.#queueGeneration());
    }
    return replace;
  }
  public prepare(): Promise<RuntimeReadinessResult> {
    if (this.#finalDisposed) return Promise.reject(elementAbortError());
    this.flushSourceMutations();
    this.#publish.diagnostic({ kind: "prepare" });
    return this.#ensure();
  }
  public async setState(name: string): Promise<void> {
    if (this.#finalDisposed) throw elementAbortError();
    this.flushSourceMutations();
    await this.#ensure();
    const terminal = this.#retainedTerminalError();
    if (terminal !== null) throw terminal;
    const player = this.#player;
    if (player === null) throw new AvalNotReadyError();
    try { await player.setState(name); }
    catch (error) { throw this.#retainedTerminalError() ?? error; }
    const settled = this.#retainedTerminalError();
    if (settled !== null) throw settled;
  }
  public applyDeclarativeState(name: string): void {
    void this.setState(name).catch((error) => {
      if (isElementAbort(error) || this.#finalDisposed || !this.#connected) return;
      this.publishFailure(
        "invalid-configuration",
        "state",
        false,
        Math.max(1, this.sourceGeneration)
      );
    });
  }
  public send(event: string): boolean {
    if (this.#finalDisposed) return false;
    try {
      const player = this.#player;
      if (this.flushSourceMutations()) return false;
      return player?.send(event) ?? false;
    } catch { return false; }
  }
  public deferSend(event: string, defer: (operation: () => void) => boolean): boolean {
    if (this.#finalDisposed) return false;
    try {
      const player = this.#player;
      if (player === null || !player.canSend(event)) return false;
      return defer(() => {
        if (this.#player === player && !this.#finalDisposed &&
          !this.flushSourceMutations()) player.send(event);
      });
    } catch { return false; }
  }
  public readyFor(state: string): boolean {
    if (this.#finalDisposed) return false;
    if (this.flushSourceMutations()) return false;
    return this.#player?.readyFor(state) ?? false;
  }
  public peekReadyFor(state: string): boolean {
    return !this.#finalDisposed && (this.#player?.readyFor(state) ?? false);
  }
  public pause(): void {
    if (this.#finalDisposed) return;
    this.flushSourceMutations();
    this.#publish.commit({ paused: true });
    this.#playSequence += 1;
    this.#publish.diagnostic({ kind: "pause" });
    this.#player?.pause();
  }
  public async resume(): Promise<void> {
    if (this.#finalDisposed) throw elementAbortError();
    this.flushSourceMutations();
    const previous = this.#manualPlaying;
    this.#publish.commit({ paused: false });
    const sequence = ++this.#playSequence;
    let attempted: Player | null = null;
    this.#publish.diagnostic({ kind: "resume" });
    try {
      await this.#ensure();
      const terminal = this.#retainedTerminalError();
      if (terminal !== null) throw terminal;
      if (sequence !== this.#playSequence || !this.#manualPlaying) {
        throw elementAbortError();
      }
      const player = this.#player;
      if (player === null) throw new AvalNotReadyError();
      if (this.#effectivelyVisible &&
        player !== this.#suspendedPlayer && player !== this.#suspendingPlayer) {
        attempted = player;
        await player.resume();
        const resumed = this.#retainedTerminalError();
        if (resumed !== null) throw resumed;
        if (!resumeCurrent(
          sequence, this.#playSequence, this.#manualPlaying,
          this.#effectivelyVisible, player, this.#player,
          this.#suspendedPlayer, this.#suspendingPlayer
        )) throw elementAbortError();
        attempted = null;
      }
    } catch (error) {
      if (attempted !== null && (
        sequence === this.#playSequence || attempted !== this.#player ||
        !this.#manualPlaying || !this.#effectivelyVisible ||
        attempted === this.#suspendedPlayer || attempted === this.#suspendingPlayer
      )) attempted.pause();
      if (sequence === this.#playSequence) this.#publish.commit({ paused: !previous });
      throw this.#retainedTerminalError() ?? error;
    }
  }
  public autoplayChanged(): void {
    this.#publish.commit({ paused: this.#read.snapshot().autoplay !== "visible" });
    this.#playSequence += 1;
    this.#updatePlayback();
  }
  public motionChanged(): void {
    this.#motionGeneration += 1;
    this.#applyMotion();
  }
  public resize(geometry: Readonly<ElementRuntimeGeometry> =
    this.#read.snapshot().geometry): void {
    this.#resizeGeneration += 1;
    const read = this.#read.snapshot();
    const fit = read.fit ?? this.#metadata?.canvas.fit ?? "contain";
    this.#player?.resize(
      Math.max(1, geometry.width),
      Math.max(1, geometry.height),
      geometry.dpr,
      fit
    );
    this.visibilityChanged();
  }
  public dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    return this.#retainDisposeOperation(this.#createDisposeOperation());
  }
  #createDisposeOperation(): Promise<void> {
    this.#finalDisposed = true;
    this.#load = null;
    this.#publish.disposalStarted();
    const finish = (retirementCompleted: boolean): void => {
      const page = this.#page.snapshot().ownership;
      const sourceCompleted = retirementCompleted &&
        this.#player === null && this.#retiringPlayer === null &&
        this.#controller === null && page.participantDisposed &&
        page.logicalBytes === 0 && page.decoderState === null &&
        this.#cleanup?.completed !== false;
      if (!this.#publish.disposalCompleted(
        sourceCompleted,
        this.#pendingOperationCount
      )) throw new ElementCleanupIncompleteError();
    };
    return this.#queueRetirement(true).then(
      () => finish(true),
      (error) => {
        try { finish(false); } catch { /* preserve retirement failure */ }
        throw error;
      }
    );
  }
  #retainDisposeOperation(operation: Promise<void>): Promise<void> {
    this.#disposePromise = operation;
    void operation.catch(() => {
      if (this.#disposePromise === operation) this.#disposePromise = null;
    });
    return operation;
  }
  #scheduleRestart(player: Player, state: string): void {
    if (this.#finalDisposed || !this.#connected || player !== this.#player) return;
    const retained = this.#restart;
    if (retained?.player === player) {
      this.#restart = Object.freeze({ ...retained, state });
      return;
    }
    this.#restart = Object.freeze({
      player,
      state,
      visibleOnly: true
    });
    this.scheduleReload(true, false);
  }
  public captureRestart(visibleOnly: boolean): void {
    const player = this.#player;
    let state = this.#requestedState ?? this.#metadata?.initialState ??
      this.#read.snapshot().declarativeState;
    try { state = player?.snapshot(false).requestedState ?? state; }
    catch { /* retain last published intent */ }
    if (state === null || state === undefined) return;
    this.#restart = Object.freeze({
      player,
      state,
      visibleOnly
    });
  }
  #ensure(): Promise<RuntimeReadinessResult> {
    if (this.#finalDisposed) return Promise.reject(elementAbortError());
    if (this.#load !== null) return this.#load;
    if (!this.#connected) return Promise.reject(new AvalNotReadyError());
    const operation = this.#queueGeneration();
    this.#trackLoad(operation);
    return operation;
  }
  #trackLoad(operation: Promise<RuntimeReadinessResult>): void {
    this.#load = operation;
    void operation.catch((error: unknown) => {
      if (
        this.#load === operation && !this.#finalDisposed &&
        error !== this.#terminalError
      ) this.#load = null;
    });
  }
  #queueGeneration(): Promise<RuntimeReadinessResult> {
    return this.#lifecycle.generation(
      () => this.#controller?.abort(),
      (token) => this.#startGeneration(token)
    );
  }
  #queueRetirement(terminal: boolean): Promise<void> {
    this.#page.invalidateRequest();
    return this.#lifecycle.retirement(
      () => this.#controller?.abort(),
      () => this.#retireGeneration(terminal)
    );
  }
  async #startGeneration(token: number): Promise<RuntimeReadinessResult> {
    const restart = this.#restart;
    const preserveLifecycle = restart !== null && restart.player !== null;
    let restartState = restart?.state ?? null;
    if (restart !== null && restart.player !== null &&
      restart.player === this.#player) {
      restartState = restart.player.snapshot(false).requestedState ?? restartState;
    }
    const initialBody = restart !== null;
    await this.#retireGeneration(false);
    if (!this.#lifecycle.current(token) || !this.#connected || this.#finalDisposed) {
      throw elementAbortError();
    }
    this.#restart = null;
    const generation = this.sourceGeneration + 1;
    if (generation > 1) this.#publish.diagnostic({ kind: "source-replacement" });
    this.#publish.diagnostic({
      kind: "source-started",
      generation,
      preservePlaybackLifecycle: preserveLifecycle
    });
    this.#controller = new AbortController();
    this.#metadata = null;
    this.#terminalError = null;
    this.#presentation.resetSource(generation);
    this.#publish.commit({
      generation,
      requestedState: null,
      visualState: null,
      isTransitioning: false,
      stateNames: [],
      eventNames: [],
      inputBindings: [],
      lastError: null
    });
    this.#publish.readinessChanged("unready", undefined, generation);
    const sourceRead = this.#read.sources();
    for (const failure of sourceRead.failures) this.publishFailure(
      "invalid-configuration",
      `source[${String(failure.sourceIndex)}].${failure.attribute}`,
      false,
      generation
    );
    const sources = sourceRead.sources;
    this.#publish.diagnostic({
      kind: "source-capacity",
      generation,
      sourceCount: sources.length
    });
    if (sources.length === 0) return Promise.reject(
      this.#publishTerminalFailure("invalid-configuration", "configure", generation)
    );
    const read = this.#read.snapshot();
    const view = read.view;
    if (!runtimeHostSupported(this.#presentation.stylesSupported(), view)) {
      throw this.#publishTerminalFailure("unsupported-browser", "configure", generation);
    }
    const timing = createElementOperationTiming(view);
    const startedAt = view.performance.now();
    const setupDeadline = startedAt + ELEMENT_SETUP_TIMEOUT_MS;
    const preparationDeadline = startedAt + preparationBudgetMs(sources.length);
    try {
      if (this.#read.needsIntersectionSample()) await withElementOperationLimits(
        this.#read.waitForIntersection(),
        this.#controller.signal,
        remainingElementPreparationMs(setupDeadline, view.performance, timing),
        (kind) => this.#publish.diagnostic({ kind }),
        timing
      );
      const module = await withElementOperationLimits(
        this.#loadRuntime(),
        this.#controller.signal,
        remainingElementPreparationMs(setupDeadline, view.performance, timing),
        (kind) => this.#publish.diagnostic({ kind }),
        timing
      );
      if (!this.#current(generation, token)) throw elementAbortError();
      const preparationTimeoutMs = remainingElementPreparationMs(
        preparationDeadline,
        view.performance,
        timing
      );
      const selectedMotion = read.motion;
      const selectedReduced = this.#motionReduced(selectedMotion);
      const geometry = read.geometry;
      const player = await module.createPlayer({
        canvas: this.#presentation.canvas,
        platform: createRealmPlatform(view),
        initialPresentation: {
          width: geometry.width,
          height: geometry.height,
          dpr: geometry.dpr,
          fit: read.fit
        },
        baseUrl: read.baseUrl,
        sources,
        credentials: read.crossOrigin === "use-credentials" ? "include" : "same-origin",
        signal: this.#controller.signal,
        preparationTimeoutMs,
        motion: selectedMotion,
        reduced: selectedReduced,
        initialState: restartState,
        initialBody,
        visible: this.#effectivelyVisible,
        decoderReady: () => this.#current(generation, token) &&
          this.#page.claimDecoder(generation),
        onCandidate: async (candidate) => {
          if (!this.#current(generation, token)) throw elementAbortError();
          this.#acceptCandidate(candidate);
          candidate.activate({ publish: false });
          this.#setMetadata(candidate.metadata);
          await this.#reconcileSelectionMotion(
            candidate,
            selectedMotion,
            selectedReduced,
            generation,
            token
          );
          if (!this.#current(generation, token)) throw elementAbortError();
          this.#publish.refreshInputs();
          this.resize();
          this.#updatePlayback();
          if (this.#suspendingPlayer === candidate && this.#suspension !== null) {
            await this.#suspension;
          }
          if (!this.#current(generation, token)) throw elementAbortError();
        },
        onResourceBytes: (bytes) => {
          if (this.#publicationCurrent(generation, token)) this.#page.setResourceBytes(bytes);
        },
        onMetadata: (metadata) => {
          if (!this.#publicationCurrent(generation, token) ||
            this.#metadata === metadata) return;
          this.#setMetadata(metadata);
          this.#publish.refreshInputs();
          this.resize();
        },
        onReadiness: (value, reason) => {
          if (!this.#publicationCurrent(generation, token)) return;
          this.#publish.readinessChanged(value, reason, generation);
        },
        onAnimationResourcesRetired: () => {
          if (this.#publicationCurrent(generation, token)) {
            this.#page.animationResourcesRetired(
              this.#staticReason === "decoder-queued"
            );
          }
        },
        onDraw: () => {
          if (!this.#publicationCurrent(generation, token)) return;
          this.#presentation.reconcileMotionPreference();
          this.#presentation.animatedDrawn(generation);
        },
        onRestart: (state) => {
          if (!this.#publicationCurrent(generation, token)) return;
          const current = this.#player;
          if (current !== null) this.#scheduleRestart(current, state);
        },
        onEvent: (type, detail) => {
          if (!this.#publicationCurrent(generation, token)) return;
          if (type === "requestedstatechange") this.#inputGeneration += 1;
          else if (type === "underflow") this.#publish.diagnostic({ kind: "underflow" });
          this.#publish.runtimeEvent(type, detail, generation);
          if (type === "transitionend") this.#publish.transitionEnded();
        },
        onFailure: (code, operation, fatal) => {
          if (this.#publicationCurrent(generation, token)) {
            this.publishFailure(code, operation, fatal, generation);
          }
        },
        onPlaybackFailure: (code, operation) =>
          this.#playbackFailure(code, operation, generation, token),
        onDecoderDiagnostics: (diagnostics) => {
          if (this.#publicationCurrent(generation, token)) this.#publish.diagnostic({
            kind: "decoder",
            generation,
            diagnostics
          });
        },
        onRendererDiagnostics: (diagnostics) => {
          if (this.#publicationCurrent(generation, token)) this.#publish.diagnostic({
            kind: "renderer",
            generation,
            diagnostics
          });
        }
      });
      if (!this.#current(generation, token)) {
        this.#retiringPlayer = player;
        await this.#retireGeneration(false);
        throw elementAbortError();
      }
      if (this.#player !== player) {
        throw new Error("AVAL startup candidate handoff was not completed");
      }
      let result: RuntimeReadinessResult;
      try {
        result = this.#suspendingPlayer === player && this.#suspension !== null
          ? await this.#suspension : await player.prepare();
      } finally {
        if (this.#preparingPlayer === player) this.#preparingPlayer = null;
      }
      if (!this.#current(generation, token)) throw elementAbortError();
      if (!this.#effectivelyVisible) {
        if (result.mode === "static" && result.reason === "visibility-suspended") {
          this.#completeVisibilitySuspension(player, result);
        } else result = await this.#suspendForVisibility(player);
      }
      if (!this.#current(generation, token)) throw elementAbortError();
      player.publish();
      if (!this.#current(generation, token)) throw elementAbortError();
      if (restartState === null) {
        const state = this.#read.snapshot().declarativeState;
        if (state !== null) this.#applyDeclarativeStateToPlayer(
          player,
          state,
          generation,
          token
        );
      }
      return result;
    } catch (error) {
      return this.#generationFailed(error, generation, token);
    }
  }
  #acceptCandidate(candidate: Player): void {
    this.#player = candidate;
    this.#preparingPlayer = candidate;
    if (this.#visibilityPlayer !== candidate) this.#visibilityPlayer = null;
    if (this.#suspendedPlayer !== candidate) this.#suspendedPlayer = null;
    if (this.#suspendingPlayer !== candidate) {
      this.#suspendingPlayer = null;
      this.#suspension = null;
    }
  }
  #applyDeclarativeStateToPlayer(player: Player, name: string,
    generation: number, token: number): void {
    void player.setState(name).catch((error) => {
      if (isElementAbort(error) || player !== this.#player ||
        !this.#current(generation, token)) return;
      this.publishFailure("invalid-configuration", "state", false, generation);
    });
  }
  async #generationFailed(error: unknown, generation: number,
    token: number): Promise<never> {
    if (!this.#current(generation, token)) throw elementAbortError();
    const aborted = isElementAbort(error);
    const playback = error instanceof AvalPlaybackError ? error : null;
    const timedOut = isElementPreparationTimeout(error);
    try {
      if (this.#player !== null) await this.#retireGeneration(false);
      else this.#page.releaseAll();
    } catch {
      if (!this.#generationCurrent(generation, token)) throw elementAbortError();
      if (playback !== null) throw playback;
      throw this.#publishTerminalFailure(
        timedOut ? "watchdog-timeout" : "element-cleanup-incomplete",
        timedOut ? "prepare" : "prepare-cleanup",
        generation
      );
    }
    if (!this.#generationCurrent(generation, token)) throw elementAbortError();
    if (aborted) throw error;
    if (playback !== null) throw playback;
    throw this.#publishTerminalFailure(
      timedOut ? "watchdog-timeout" : "readiness-failure",
      "prepare",
      generation
    );
  }
  async #retireGeneration(terminal: boolean): Promise<void> {
    const controller = this.#controller;
    const player = this.#player ?? this.#retiringPlayer;
    const suspension = this.#suspendingPlayer === player ? this.#suspension : null;
    this.#controller = null;
    this.#player = null;
    if (this.#visibilityPlayer === player) this.#visibilityPlayer = null;
    controller?.abort();
    this.#publish.disconnectInputs();
    if (player === null) {
      this.#page.releaseAll();
      return;
    }
    const retry = this.#retiringPlayer === player;
    this.#retiringPlayer = player;
    let failed = false;
    let failure: unknown;
    if (!retry || this.#retiringDeclaredFileBytes === 0) {
      this.#retiringDeclaredFileBytes = 0;
      try {
        const before = player.snapshot(false);
        this.#publish.diagnostic({
          kind: "runtime",
          generation: this.sourceGeneration,
          snapshot: before
        });
        this.#retiringDeclaredFileBytes = before.declaredFileBytes;
        this.#publish.diagnostic({
          kind: "retired-context",
          generation: this.sourceGeneration,
          count: before.contextRecoveryCount
        });
      } catch { failed = true; }
    }
    let disposed = false;
    try {
      if (suspension !== null) await Promise.allSettled([suspension]);
      await player.dispose();
      await player.settled();
      disposed = true;
    } catch (error) {
      failed = true;
      failure = error;
    }
    this.#clearPlayerReferences(player);
    let snapshot: Readonly<PlayerSnapshot> | null = null;
    try { snapshot = player.snapshot(false); }
    catch (error) {
      failed = true;
      failure ??= error;
    }
    this.#publish.diagnostic({
      kind: "runtime",
      generation: this.sourceGeneration,
      snapshot
    });
    if (disposed && !failed && playerSnapshotDisposed(snapshot)) {
      try {
        this.#page.setResourceBytes(0);
        this.#page.releaseAll();
      } catch (error) {
        failed = true;
        failure ??= error;
      }
    }
    const page = this.#page.snapshot();
    const cleanup = createSourceCleanupReceipt({
      generation: 1,
      sourceGeneration: this.sourceGeneration,
      runtime: snapshot,
      page: page.page,
      retiredDeclaredFileBytes: this.#retiringDeclaredFileBytes,
      operationFailed: failed,
      pageResources: page.ownership,
      terminal,
      stalePublicationCount: this.#publish.stalePublicationCount()
    });
    this.#cleanup = cleanup;
    this.#publish.cleanupObserved(cleanup);
    this.#publish.diagnostic({ kind: "cleanup" });
    if (proveSourceRetirement(disposed, cleanup)) {
      this.#retiringPlayer = null;
      this.#retiringDeclaredFileBytes = 0;
      return;
    }
    if (failure !== undefined) throw failure;
    throw new ElementCleanupIncompleteError();
  }
  #clearPlayerReferences(player: Player): void {
    if (this.#preparingPlayer === player) this.#preparingPlayer = null;
    if (this.#suspendingPlayer === player) {
      this.#suspendingPlayer = null;
      this.#suspension = null;
    }
    if (this.#suspendedPlayer === player) this.#suspendedPlayer = null;
    if (this.#restart?.player === player) this.#restart = null;
  }
  public publishFailure(code: FailureInput, operation: string,
    fatal: boolean, generation: number): void {
    if (fatal) {
      this.#publishTerminalFailure(code, operation, generation);
      return;
    }
    if (this.#terminalError?.generation === generation) return;
    this.#publish.failure(createAvalPublicFailure(code, operation), false, generation);
  }
  #playbackFailure(code: FailureInput, operation: string,
    generation: number, token: number): AvalPlaybackError {
    if (!this.#publicationCurrent(generation, token)) {
      return this.#createPlaybackError(code, operation, generation);
    }
    const player = this.#player;
    const preparing = player !== null && this.#preparingPlayer === player;
    const error = this.#publishTerminalFailure(code, operation, generation);
    if (player !== null && !preparing) queueMicrotask(() => {
      if (this.#terminalError !== error || this.#player !== player ||
        !this.#generationCurrent(generation, token) || this.#finalDisposed) return;
      void this.#queueRetirement(false).catch(() => undefined);
    });
    return error;
  }
  #publishTerminalFailure(code: FailureInput, operation: string,
    generation: number): AvalPlaybackError {
    if (this.#terminalError?.generation === generation) return this.#terminalError;
    const error = this.#createPlaybackError(code, operation, generation);
    this.#terminalError = error;
    const retained = Promise.reject<RuntimeReadinessResult>(error);
    void retained.catch(() => undefined);
    this.#load = retained;
    this.#publish.failure(error.failure, true, generation);
    return error;
  }
  #createPlaybackError(code: FailureInput, operation: string,
    generation: number): AvalPlaybackError {
    return new AvalPlaybackError(createAvalPublicFailure(code, operation), generation);
  }
  #setMetadata(metadata: Readonly<Metadata>): void {
    this.#metadata = metadata;
    this.#publish.metadataChanged(metadata);
    this.#presentation.metadataChanged(metadata);
  }
  #current(generation: number, token: number): boolean {
    return this.#generationCurrent(generation, token) &&
      this.#controller?.signal.aborted === false;
  }
  #generationCurrent(generation: number, token: number): boolean {
    return !this.#finalDisposed && this.#lifecycle.current(token) &&
      generation === this.sourceGeneration;
  }
  #publicationCurrent(generation: number, token: number): boolean {
    if (this.#current(generation, token)) return true;
    this.#publish.diagnostic({ kind: "stale-publication" });
    return false;
  }
  #retainedTerminalError(): AvalPlaybackError | null {
    const error = this.#terminalError;
    return error?.generation === this.sourceGeneration ? error : null;
  }
  public decoderGranted(generation: number): void {
    if (this.#finalDisposed || !this.#connected || generation !== this.sourceGeneration) return;
    const player = this.#player;
    if (player !== null && !this.#reloadQueued) {
      const state = player.snapshot(false).requestedState ??
        this.#requestedState ?? this.#metadata?.initialState;
      if (state !== undefined && state !== null) this.#scheduleRestart(player, state);
    }
  }
  public snapshot(trace: boolean): Readonly<ElementRuntimeSessionSnapshot> {
    const player = this.#player ?? this.#retiringPlayer;
    const runtime = player?.snapshot(trace) ?? null;
    return Object.freeze({
      elementGeneration: 1,
      inputGeneration: this.#inputGeneration,
      motionGeneration: this.#motionGeneration,
      visibilityGeneration: this.#visibilityGeneration,
      resizeGeneration: this.#resizeGeneration,
      runtime,
      runtimeIsActive: player !== null && this.#player === player,
      runtimeSuspending: this.#suspendingPlayer !== null,
      runtimeSuspended: this.#suspendedPlayer !== null,
      rebuildPending: this.#reloadQueued || this.#restart !== null,
      presentationFit: this.#metadata?.canvas.fit ?? null,
      pendingOperationCount: this.#pendingOperationCount
    });
  }
  public visibilityChanged(force = false): void {
    const read = this.#read.snapshot();
    if (!read.intersectionKnown && !force) return;
    const visible = read.effectivelyVisible;
    const previous = this.#effectivelyVisible;
    this.#publish.commit({ effectivelyVisible: visible });
    const player = this.#player;
    const edge = visible !== previous;
    if (!edge && player === this.#visibilityPlayer) return;
    if (edge) {
      this.#visibilityGeneration += 1;
      this.#page.setVisible(visible);
    }
    this.#visibilityPlayer = player;
    if (player === null) return;
    player.setVisibility(visible);
    this.#updatePlayback();
    this.#publish.sendInput(visible ? "visible" : "hidden");
    if (!visible) {
      if (this.#suspendedPlayer !== player && this.#suspendingPlayer !== player) {
        const suspension = this.#suspendForVisibility(player);
        this.#load = suspension;
        void suspension.catch(() => undefined);
      }
      return;
    }
    if (this.#suspendedPlayer === player) {
      const state = this.#restart?.state ?? player.snapshot(false).requestedState ??
        this.#requestedState ?? this.#metadata?.initialState;
      if (state !== undefined && state !== null) this.#scheduleRestart(player, state);
    }
  }
  public restoreFromPageCache(): void {
    this.#page.setVisible(this.#effectivelyVisible);
    this.#page.invalidateRequest();
    this.captureRestart(false);
    this.scheduleReload(true, false);
  }
  public motionPreferenceChanged(): void {
    if (this.#read.snapshot().motion === "auto") this.motionChanged();
  }
  #applyMotion(): void {
    const player = this.#player;
    if (player === null) return;
    const generation = this.sourceGeneration;
    const read = this.#read.snapshot();
    const reduced = this.#motionReduced(read.motion);
    if (reduced) this.#page.cancelDecoderTicket();
    void player.setMotion(read.motion, reduced).then(
      () => { if (player === this.#player) this.#updatePlayback(); },
      (error) => {
        if (player === this.#player && !isElementAbort(error)) {
          this.publishFailure("readiness-failure", "motion", false, generation);
        }
      }
    );
  }
  async #reconcileSelectionMotion(player: Player, selectedMotion: AvalMotion,
    selectedReduced: boolean, generation: number, token: number): Promise<void> {
    let policy = selectedMotion;
    let reduced = selectedReduced;
    while (this.#current(generation, token) && player === this.#player) {
      const current = this.#read.snapshot().motion;
      const currentReduced = this.#motionReduced(current);
      if (policy === current && reduced === currentReduced) return;
      await player.setMotion(current, currentReduced);
      policy = current;
      reduced = currentReduced;
    }
  }
  #motionReduced(policy: AvalMotion): boolean {
    return policy === "reduce" ||
      policy === "auto" && this.#read.snapshot().reducedMotion;
  }
  #updatePlayback(): void {
    const player = this.#player;
    if (player === null) return;
    if (!this.#manualPlaying || !this.#effectivelyVisible) player.pause();
    else if (player !== this.#suspendedPlayer && player !== this.#suspendingPlayer) {
      void player.resume().catch(() => undefined);
    }
  }
  #suspendForVisibility(player: Player): Promise<RuntimeReadinessResult> {
    if (this.#suspendingPlayer === player && this.#suspension !== null) {
      return this.#suspension;
    }
    this.#suspendingPlayer = player;
    const operation = player.suspend("visibility-suspended").then(
      (result) => {
        this.#completeVisibilitySuspension(player, result);
        return result;
      },
      (error) => {
        if (this.#suspendingPlayer === player) {
          this.#suspendingPlayer = null;
          this.#suspension = null;
        }
        throw error;
      }
    );
    this.#suspension = operation;
    return operation;
  }
  #completeVisibilitySuspension(player: Player,
    result: RuntimeReadinessResult): void {
    if (result.mode !== "static" || result.reason !== "visibility-suspended") {
      throw new Error("Invalid AVAL visibility suspension result");
    }
    if (this.#suspendingPlayer === player) {
      this.#suspendingPlayer = null;
      this.#suspension = null;
    }
    if (player !== this.#player) return;
    this.#suspendedPlayer = player;
    if (!this.#effectivelyVisible) return;
    const state = this.#restart?.state ?? player.snapshot(false).requestedState ??
      this.#requestedState ?? this.#metadata?.initialState;
    if (state !== undefined && state !== null) this.#scheduleRestart(player, state);
  }
  get #publicState(): Readonly<AvalSnapshot> {
    return this.#read.snapshot().publicSnapshot;
  }
  get #connected(): boolean { return this.#publicState.connected; }
  get #staticReason(): StaticReason | null { return this.#publicState.staticReason; }
  get #requestedState(): string | null { return this.#publicState.requestedState; }
  get #manualPlaying(): boolean { return !this.#publicState.paused; }
  get #effectivelyVisible(): boolean {
    return this.#publicState.effectivelyVisible;
  }
  get #pendingOperationCount(): number {
    return this.#lifecycle.pending + Number(this.#reloadQueued) +
      Number(this.#suspension !== null) + Number(this.#restart !== null);
  }
}
