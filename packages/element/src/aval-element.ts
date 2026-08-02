import {
  IDENTIFIER_PATTERN
} from "@pixel-point/aval-format";

import { ElementAttributeReflection } from "./element-attribute-reflection.js";
import { AVAL_ATTRIBUTES, AVAL_UPGRADE_PROPERTIES } from "./element-attributes.js";
import { ElementEventMutationGate } from "./element-event-mutation-gate.js";
import {
  createDomHostEnvironmentPort,
  ElementHostEnvironment,
  type ElementHostGeometry,
  type ElementHostVisibilityChange
} from "./element-host-environment.js";
import {
  createElementOwnershipSnapshot,
  createElementTerminalCleanupProof,
  createSourceCleanupReceipt,
  playerSnapshotDisposed,
  proveSourceRetirement,
  serializeElementOwnershipSnapshot,
  serializeSourceCleanupReceipt,
  serializeElementTerminalCleanupProof,
  type ElementOwnershipSnapshot,
  type ElementTerminalCleanupProof,
  type SourceCleanupReceipt
} from "./element-cleanup-proof.js";
import { ElementInputBinding } from "./element-input-binding.js";
import { ElementPageResourceOwner } from "./element-page-resource-owner.js";
import { ElementPublicEvents } from "./element-public-events.js";
import {
  ElementSnapshotStore,
  type ElementSnapshotState
} from "./element-snapshot-store.js";
import { ElementTrace } from "./element-trace.js";
import { ELEMENT_DECODER_CAPACITY } from "./decoder-capacity.js";
import type {
  Metadata,
  Player,
  PlayerDecoderDiagnostic,
  PlayerInput,
  PlayerRendererDiagnostic,
  PlayerSnapshot,
  Source
} from "./player-contract.js";
import { LifecycleLane } from "./lifecycle-lane.js";
import {
  AvalNotReadyError,
  AvalPlaybackError,
  ElementCleanupIncompleteError
} from "./errors.js";
import { ShadowLayerOwner } from "./shadow-layers.js";
import type {
  AvalAutoplay,
  AvalBindings,
  AvalCrossOrigin,
  AvalDecoderDiagnostic,
  AvalDecoderExpectedOutputDiagnostic,
  AvalDecoderFrameDiagnostic,
  AvalDecoderObservedOutputDiagnostic,
  AvalDecoderOutputFailureDiagnostic,
  AvalDiagnostics,
  AvalElement,
  AvalElementConstructor,
  AvalErrorDetail,
  AvalFit,
  AvalMode,
  AvalMotion,
  AvalPlaybackLifecycleCounters,
  AvalPublicFailure,
  AvalReadinessChangeDetail,
  AvalRendererDiagnostic,
  AvalSnapshot,
  Binding,
  RuntimeReadiness,
  RuntimeReadinessResult,
  StaticReason
} from "./public-types.js";
import {
  emptyPlaybackLifecycleCounters,
  retainPlaybackLifecycleCounters
} from "./playback-lifecycle.js";
import {
  isElementSourceMutation,
  readElementSources
} from "./element-sources.js";
import {
  ELEMENT_SETUP_TIMEOUT_MS,
  preparationBudgetMs
} from "./preparation-budget.js";

let runtimeModule: Promise<typeof import("./player.js")> | null = null;
const MAX_RETAINED_DECODER_SOURCES = 128;
type FailureInput = AvalPublicFailure["code"];
type ElementTiming = Readonly<{
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (handle: number) => void;
  timeoutError: () => DOMException;
  abortError: () => DOMException;
}>;

export function createAvalElementClass(
  Base: typeof HTMLElement
): AvalElementConstructor {
  class AvalElementImpl extends Base implements AvalElement {
    public static get observedAttributes(): readonly string[] {
      return AVAL_ATTRIBUTES;
    }

    readonly #attributes: ElementAttributeReflection;
    readonly #layers: ShadowLayerOwner;
    readonly #lifecycle = new LifecycleLane();
    readonly #events: ElementPublicEvents;
    readonly #eventMutations: ElementEventMutationGate;
    readonly #hostEnvironment: ElementHostEnvironment<MutationRecord>;
    readonly #inputBinding: ElementInputBinding<Element>;
    readonly #pageResources: ElementPageResourceOwner;
    readonly #snapshots: ElementSnapshotStore;
    readonly #trace = new ElementTrace();
    readonly #counters = {
      prepare: 0,
      sourceReplacement: 0,
      pause: 0,
      resume: 0,
      underflow: 0,
      contextRecovery: 0,
      cleanup: 0
    };
    #player: Player | null = null;
    #retiringPlayer: Player | null = null;
    #retiringDeclaredFileBytes = 0;
    #visibilityPlayer: Player | null = null;
    #preparingPlayer: Player | null = null;
    #suspendingPlayer: Player | null = null;
    #suspension: Promise<RuntimeReadinessResult> | null = null;
    #suspendedPlayer: Player | null = null;
    #restartPlayer: Player | null = null;
    #restartState: string | null = null;
    #restartInitialBody = false;
    #restartVisibleOnly = false;
    #load: Promise<RuntimeReadinessResult> | null = null;
    #controller: AbortController | null = null;
    #metadata: Readonly<Metadata> | null = null;
    #finalDisposed = false;
    #disposePromise: Promise<void> | null = null;
    #reloadQueued = false;
    #reloadReplace = false;
    #timerCount = 0;
    #stalePublicationCount = 0;
    #elementGeneration = 1;
    #inputGeneration = 0;
    #motionGeneration = 0;
    #visibilityGeneration = 0;
    #resizeGeneration = 0;
    #terminalError: AvalPlaybackError | null = null;
    #cleanupFailureCount = 0;
    #decoderDiagnosticLimit = 0;
    #decoderDiagnostics: readonly Readonly<AvalDecoderDiagnostic>[] =
      Object.freeze([]);
    #rendererDiagnosticLimit = 0;
    #rendererDiagnostics: readonly Readonly<AvalRendererDiagnostic>[] =
      Object.freeze([]);
    #playbackLifecycle: Readonly<AvalPlaybackLifecycleCounters> =
      emptyPlaybackLifecycleCounters();
    #cleanup: Readonly<SourceCleanupReceipt> | null = null;
    #terminalCleanup: Readonly<ElementTerminalCleanupProof> | null = null;
    #playSequence = 0;

    public constructor() {
      super();
      this.#attributes = new ElementAttributeReflection(this);
      this.#layers = new ShadowLayerOwner(this);
      this.#events = new ElementPublicEvents(this);
      this.#eventMutations = new ElementEventMutationGate(this.#events);
      this.#inputBinding = new ElementInputBinding({
        host: this,
        documentTarget: () => this.ownerDocument,
        activeElement: () => this.ownerDocument.activeElement,
        rootOf: (target) => target.getRootNode(),
        resolveById: (id) => {
          const root = this.getRootNode();
          if (
            "getElementById" in root &&
            typeof root.getElementById === "function"
          ) return root.getElementById(id);
          return null;
        },
        isCurrentRealmTarget: (target) => {
          const Constructor = this.ownerDocument.defaultView?.Element;
          return Constructor !== undefined && target instanceof Constructor;
        },
        contains: (target, node) => target.contains(node),
        matchesHover: (target) => target.matches(":hover"),
        blur: (target) => {
          const blur = Reflect.get(target, "blur");
          if (typeof blur === "function") Reflect.apply(blur, target, []);
        },
        currentMode: () => this.bindings,
        currentInteractionFor: () => this.interactionFor,
        currentBindings: () =>
          this.#metadata !== null && this.#player !== null
            ? this.#metadata.bindings : null,
        isTransitioning: () => this.#transitioning,
        dispatchBinding: (event) => this.send(event),
        recordSource: (source) => this.#trace.record(
          `input-${source.replaceAll(".", "-")}`,
          Math.max(1, this.#sourceGeneration)
        ),
        onTargetUnavailable: () => this.#publishFailure(
          "interaction-target-unavailable",
          "bind-inputs",
          false,
          Math.max(1, this.#sourceGeneration)
        ),
        queueOwnedMicrotask: (operation) =>
          this.#eventMutations.queueOwnedMicrotask(operation),
        queueEventFollowup: (operation) =>
          this.#eventMutations.queueEventFollowup(operation)
      });
      this.#pageResources = new ElementPageResourceOwner({
        currentRealm: () => this.ownerDocument.defaultView ?? globalThis,
        currentVisibility: () => this.effectivelyVisible,
        onDecoderGranted: (generation) => this.#decoderGranted(generation)
      });
      this.#hostEnvironment = new ElementHostEnvironment({
        environment: createDomHostEnvironmentPort(
          this,
          (record) => isElementSourceMutation(this, record)
        ),
        callbacks: {
          sourcesChanged: () => this.#scheduleReload(),
          geometryChanged: (geometry) => this.#resize(geometry),
          visibilityChanged: (change) => this.#hostVisibilityChanged(change),
          motionPreferenceChanged: () => this.#hostMotionPreferenceChanged(),
          realmChanged: () => {
            this.#inputBinding.realmChanged();
            rebindAdoptedStyles(this.#layers, this.ownerDocument);
          }
        }
      });
      this.#attributes.upgrade(AVAL_UPGRADE_PROPERTIES);
      this.#snapshots = new ElementSnapshotStore({
        generation: 0,
        connected: false,
        readiness: "unready",
        mode: null,
        assurance: null,
        staticReason: null,
        requestedState: null,
        visualState: null,
        isTransitioning: false,
        paused: this.autoplay !== "visible",
        effectivelyVisible: false,
        stateNames: [],
        eventNames: [],
        inputBindings: [],
        lastError: null
      });
      this.#applyIntrinsic();
    }

    get #sourceGeneration(): number { return this.getSnapshot().generation; }
    get #connected(): boolean { return this.getSnapshot().connected; }
    get #readiness(): RuntimeReadiness { return this.getSnapshot().readiness; }
    get #mode(): AvalMode { return this.getSnapshot().mode; }
    get #staticReason(): StaticReason | null {
      return this.getSnapshot().staticReason;
    }
    get #requestedState(): string | null {
      return this.getSnapshot().requestedState;
    }
    get #visualState(): string | null { return this.getSnapshot().visualState; }
    get #transitioning(): boolean { return this.getSnapshot().isTransitioning; }
    get #manualPlaying(): boolean { return !this.getSnapshot().paused; }

    public connectedCallback(): void {
      if (this.#finalDisposed) return;
      const wasConnected = this.#connected;
      const rootChanged = this.#hostEnvironment.rootChanged();
      if (rootChanged) {
        this.#inputBinding.realmChanged();
        this.#hostEnvironment.remove();
      }
      this.#commitPublicState({
        connected: true,
        effectivelyVisible: this.#hostEnvironment.snapshot().effectivelyVisible
      });
      if (!wasConnected) {
        this.#trace.record("connect", Math.max(1, this.#sourceGeneration));
      }
      if (!this.#hostEnvironment.install()) return;
      if (rootChanged) this.#inputBinding.refresh();
      if (!wasConnected || this.#load === null && this.#player === null &&
        this.#retiringPlayer === null) this.#scheduleReload(false);
    }

    public disconnectedCallback(): void {
      queueMicrotask(() => {
        if (this.isConnected || this.#finalDisposed) return;
        this.#hostEnvironment.remove();
        this.#inputBinding.disconnect();
        this.#commitPublicState({
          connected: false,
          effectivelyVisible: this.#hostEnvironment.snapshot().effectivelyVisible
        });
        this.#trace.record("disconnect", Math.max(1, this.#sourceGeneration));
        this.#load = null;
        const retirement = this.#queueRetirement(false);
        const finish = (): void => {
          if (!this.#connected && !this.#finalDisposed) {
            const from = this.readiness;
            this.#commitPublicState({
              readiness: "unready",
              mode: null,
              assurance: null,
              staticReason: null
            });
            this.#dispatchReadinessChange(from, "unready");
          }
        };
        void retirement.then(finish, finish);
      });
    }

    public adoptedCallback(): void {
      if (this.#finalDisposed) return;
      const adoption = this.#hostEnvironment.beginAdoption();
      this.#trace.record("adopt", Math.max(1, this.#sourceGeneration));
      this.#load = null;
      this.#commitPublicState({
        connected: this.isConnected,
        effectivelyVisible: this.#hostEnvironment.snapshot().effectivelyVisible
      });
      const retirement = this.#queueRetirement(false);
      const finish = (): void => {
        if (
          adoption.current() && this.#connected &&
          this.isConnected && !this.#finalDisposed &&
          this.#hostEnvironment.install()
        ) {
          this.#scheduleReload(false);
        }
      };
      void retirement.then(finish, finish);
    }

    public attributeChangedCallback(
      name: string,
      previous: string | null,
      next: string | null
    ): void {
      if (previous === next || this.#finalDisposed) return;
      if (this.#events.active) {
        this.#eventMutations.deferAttribute(
          name,
          () => this.getAttribute(name),
          (current) => {
            if (!this.#finalDisposed) this.#applyAttributeChange(name, current);
          }
        );
        return;
      }
      this.#applyAttributeChange(name, next);
    }

    #applyAttributeChange(name: string, next: string | null): void {
      if (name === "crossorigin") {
        this.#scheduleReload();
      } else if (name === "motion") {
        this.#motionGeneration += 1;
        this.#applyMotion();
      } else if (name === "state") {
        if (next !== null && !IDENTIFIER_PATTERN.test(next)) {
          this.#publishFailure(
            "invalid-configuration",
            "state",
            false,
            Math.max(1, this.#sourceGeneration)
          );
        } else if (next !== null && this.#connected) {
          this.#applyDeclarativeState(next);
        }
      } else if (name === "fit" || name === "width" || name === "height") {
        this.#applyIntrinsic();
        this.#resize();
      } else if (name === "bindings" || name === "interaction-for") {
        this.#inputBinding.refresh();
      } else if (name === "autoplay") {
        this.#commitPublicState({ paused: this.autoplay !== "visible" });
        this.#playSequence += 1;
        this.#updatePlayback();
      }
    }

    public get crossOrigin(): AvalCrossOrigin { return this.#attributes.crossOrigin; }
    public set crossOrigin(value: AvalCrossOrigin) { this.#attributes.crossOrigin = value; }
    public get motion(): AvalMotion { return this.#attributes.motion; }
    public set motion(value: AvalMotion) { this.#attributes.motion = value; }
    public get autoplay(): AvalAutoplay { return this.#attributes.autoplay; }
    public set autoplay(value: AvalAutoplay) { this.#attributes.autoplay = value; }
    public get fit(): AvalFit | null { return this.#attributes.fit; }
    public set fit(value: AvalFit | null) { this.#attributes.fit = value; }
    public get bindings(): AvalBindings { return this.#attributes.bindings; }
    public set bindings(value: AvalBindings) { this.#attributes.bindings = value; }
    public get state(): string | null { return this.#attributes.state; }
    public set state(value: string | null) { this.#attributes.state = value; }
    public get interactionFor(): string { return this.#attributes.interactionFor; }
    public set interactionFor(value: string) { this.#attributes.interactionFor = value; }
    public get interactionTarget(): Element | null {
      return this.#inputBinding.interactionTarget;
    }
    public set interactionTarget(value: Element | null) {
      if (this.#finalDisposed) return;
      const target = this.#inputBinding.validateInteractionTarget(value);
      if (this.#eventMutations.deferCommand(
        () => { this.interactionTarget = target; }
      )) return;
      this.#inputBinding.setInteractionTarget(target);
    }
    public get width(): number | null { return this.#attributes.width; }
    public set width(value: number | null) { this.#attributes.width = value; }
    public get height(): number | null { return this.#attributes.height; }
    public set height(value: number | null) { this.#attributes.height = value; }

    public get readiness(): RuntimeReadiness { return this.getSnapshot().readiness; }
    public get mode(): AvalMode { return this.getSnapshot().mode; }
    public get assurance(): "best-effort" | null {
      return this.getSnapshot().assurance;
    }
    public get staticReason(): StaticReason | null {
      return this.getSnapshot().staticReason;
    }
    public get requestedState(): string | null {
      return this.getSnapshot().requestedState;
    }
    public get visualState(): string | null { return this.getSnapshot().visualState; }
    public get isTransitioning(): boolean {
      return this.getSnapshot().isTransitioning;
    }
    public get paused(): boolean { return this.getSnapshot().paused; }
    public get effectivelyVisible(): boolean {
      return this.getSnapshot().effectivelyVisible;
    }
    public get stateNames(): readonly string[] {
      return this.getSnapshot().stateNames;
    }
    public get eventNames(): readonly string[] {
      return this.getSnapshot().eventNames;
    }
    public get inputBindings(): readonly Readonly<Binding>[] {
      return this.getSnapshot().inputBindings;
    }

    public getSnapshot(): Readonly<AvalSnapshot> {
      return this.#snapshots.getSnapshot();
    }

    public subscribe(listener: () => void): () => void {
      return this.#snapshots.subscribe(listener);
    }

    #commitPublicState(
      patch: Readonly<Partial<ElementSnapshotState>>
    ): void {
      this.#events.transaction(true);
      try {
        this.#snapshots.transition((current) => ({
          ...current,
          ...patch
        }));
      }
      finally { this.#events.transaction(false); }
    }

    public prepare(
      options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}
    ): Promise<RuntimeReadinessResult> {
      if (
        options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
      ) return Promise.reject(new RangeError("timeoutMs must be a positive integer"));
      if (options.signal?.aborted) return Promise.reject(options.signal.reason);
      if (this.#finalDisposed) return Promise.reject(abortError());
      const deferred = this.#eventMutations.deferCommandPromise(
        () => this.prepare(options)
      );
      if (deferred !== null) return deferred;
      const view = this.ownerDocument.defaultView;
      if (view === null) {
        return Promise.reject(new AvalNotReadyError("AVAL owner window is unavailable"));
      }
      this.#flushSourceMutations();
      this.#counters.prepare += 1;
      const operation = this.#ensure();
      return withLimits(
        operation,
        options.signal,
        options.timeoutMs,
        (delta) => { this.#timerCount += delta; },
        createElementTiming(view)
      );
    }

    public async setState(name: string): Promise<void> {
      if (!IDENTIFIER_PATTERN.test(name)) {
        throw new TypeError("state must be an authored identifier");
      }
      if (this.#finalDisposed) throw abortError();
      const deferred = this.#eventMutations.deferCommandPromise(
        () => this.setState(name)
      );
      if (deferred !== null) return deferred;
      this.#flushSourceMutations();
      await this.#ensure();
      const preparedTerminal = this.#retainedTerminalError();
      if (preparedTerminal !== null) throw preparedTerminal;
      const player = this.#player;
      if (player === null) throw new AvalNotReadyError();
      try {
        await player.setState(name);
      } catch (error) {
        throw this.#retainedTerminalError() ?? error;
      }
      const settledTerminal = this.#retainedTerminalError();
      if (settledTerminal !== null) throw settledTerminal;
    }

    #applyDeclarativeState(name: string): void {
      void this.setState(name).catch((error) => {
        if (isAbort(error) || this.#finalDisposed || !this.#connected) return;
        this.#publishFailure(
          "invalid-configuration",
          "state",
          false,
          Math.max(1, this.#sourceGeneration)
        );
      });
    }

    #applyDeclarativeStateToPlayer(
      player: Player,
      name: string,
      generation: number,
      token: number
    ): void {
      void player.setState(name).catch((error) => {
        if (
          isAbort(error) || player !== this.#player ||
          !this.#current(generation, token)
        ) return;
        this.#publishFailure(
          "invalid-configuration",
          "state",
          false,
          generation
        );
      });
    }

    public send(event: string): boolean {
      if (this.#finalDisposed) return false;
      try {
        const player = this.#player;
        if (this.#events.active) {
          return player !== null && deferAcceptedSend(
            () => player.canSend(event),
            (operation) => this.#eventMutations.deferCommand(operation),
            () => {
              if (
                this.#player === player && !this.#finalDisposed &&
                !this.#flushSourceMutations()
              ) player.send(event);
            }
          );
        }
        if (this.#flushSourceMutations()) return false;
        return player?.send(event) ?? false;
      } catch { return false; }
    }

    public readyFor(state: string): boolean {
      if (this.#finalDisposed) return false;
      if (this.#events.active) return this.#player?.readyFor(state) ?? false;
      if (this.#flushSourceMutations()) return false;
      return this.#player?.readyFor(state) ?? false;
    }

    public pause(): void {
      if (this.#finalDisposed) return;
      if (this.#eventMutations.deferCommand(() => this.pause())) return;
      this.#flushSourceMutations();
      this.#commitPublicState({ paused: true });
      this.#playSequence += 1;
      this.#counters.pause += 1;
      this.#player?.pause();
    }

    public async resume(): Promise<void> {
      if (this.#finalDisposed) throw abortError();
      const deferred = this.#eventMutations.deferCommandPromise(
        () => this.resume()
      );
      if (deferred !== null) return deferred;
      this.#flushSourceMutations();
      const previous = this.#manualPlaying;
      this.#commitPublicState({ paused: false });
      const sequence = ++this.#playSequence;
      let attempted: Player | null = null;
      this.#counters.resume += 1;
      try {
        await this.#ensure();
        const preparedTerminal = this.#retainedTerminalError();
        if (preparedTerminal !== null) throw preparedTerminal;
        if (sequence !== this.#playSequence || !this.#manualPlaying) {
          throw abortError();
        }
        const player = this.#player;
        if (player === null) throw new AvalNotReadyError();
        if (
          this.effectivelyVisible &&
          player !== this.#suspendedPlayer && player !== this.#suspendingPlayer
        ) {
          attempted = player;
          await player.resume();
          const resumedTerminal = this.#retainedTerminalError();
          if (resumedTerminal !== null) throw resumedTerminal;
          if (!resumeCurrent(
            sequence,
            this.#playSequence,
            this.#manualPlaying,
            this.effectivelyVisible,
            player,
            this.#player,
            this.#suspendedPlayer,
            this.#suspendingPlayer
          )) throw abortError();
          attempted = null;
        }
      } catch (error) {
        if (
          attempted !== null && (
            sequence === this.#playSequence ||
            attempted !== this.#player || !this.#manualPlaying ||
            !this.effectivelyVisible || attempted === this.#suspendedPlayer ||
            attempted === this.#suspendingPlayer
          )
        ) attempted.pause();
        if (sequence === this.#playSequence) {
          this.#commitPublicState({ paused: !previous });
        }
        throw this.#retainedTerminalError() ?? error;
      }
    }

    public getDiagnostics(
      options: Readonly<{ trace?: boolean }> = {}
    ): Readonly<AvalDiagnostics> {
      if (!this.#events.active) this.#flushSourceMutations();
      return this.#diagnostics(options.trace === true);
    }

    public dispose(): Promise<void> {
      if (this.#disposePromise !== null) return this.#disposePromise;
      if (this.#events.active) {
        let resolve!: () => void;
        let reject!: (reason: unknown) => void;
        const deferred = new Promise<void>((accept, decline) => {
          resolve = accept;
          reject = decline;
        });
        if (this.#eventMutations.deferCommand(() => {
          try { void this.#createDisposeOperation().then(resolve, reject); }
          catch (error) { reject(error); }
        })) return this.#retainDisposeOperation(deferred);
      }
      return this.#retainDisposeOperation(this.#createDisposeOperation());
    }

    #createDisposeOperation(): Promise<void> {
      if (!this.#finalDisposed) {
        this.#finalDisposed = true;
        this.#trace.record("dispose", Math.max(1, this.#sourceGeneration));
      }
      this.#load = null;
      this.#hostEnvironment.remove();
      this.#inputBinding.close();
      this.#commitPublicState({
        connected: false,
        effectivelyVisible: this.#hostEnvironment.snapshot().effectivelyVisible
      });
      const finish = (retirementCompleted: boolean): void => {
        const presentationCleanupCompleted = this.#layers.dispose();
        const from = this.readiness;
        this.#commitPublicState({ readiness: "disposed" });
        this.#dispatchReadinessChange(from, "disposed");
        const ownership = this.#ownershipSnapshot(true);
        const pageResources = this.#pageResources.snapshot().ownership;
        const sourceCleanupCompleted = retirementCompleted &&
          this.#player === null && this.#retiringPlayer === null &&
          this.#controller === null && pageResources.participantDisposed &&
          pageResources.logicalBytes === 0 &&
          pageResources.decoderState === null &&
          this.#cleanup?.completed !== false;
        this.#terminalCleanup = createElementTerminalCleanupProof(
          sourceCleanupCompleted,
          presentationCleanupCompleted,
          ownership
        );
        if (!this.#terminalCleanup.completed) {
          throw new ElementCleanupIncompleteError();
        }
        this.#eventMutations.close();
      };
      const operation = this.#queueRetirement(true).then(
        () => finish(true),
        (error) => {
          try { finish(false); } catch { /* preserve the retirement failure */ }
          throw error;
        }
      );
      return operation;
    }

    #retainDisposeOperation(operation: Promise<void>): Promise<void> {
      this.#disposePromise = operation;
      void operation.catch(() => {
        if (this.#disposePromise === operation) this.#disposePromise = null;
      });
      return operation;
    }

    #scheduleReload(replace = true, resetRestart = true): void {
      if (!this.#connected || this.#finalDisposed) return;
      if (resetRestart) {
        this.#clearRestart();
        if (replace) this.#pageResources.invalidateRequest();
      }
      this.#reloadReplace ||= replace;
      if (this.#reloadQueued) return;
      this.#reloadQueued = true;
      queueMicrotask(() => {
        this.#reloadQueued = false;
        const shouldReplace = this.#reloadReplace;
        this.#reloadReplace = false;
        if (!this.#connected || this.#finalDisposed) return;
        if (this.#restartVisibleOnly && !this.effectivelyVisible) {
          this.#restartPlayer = null;
          return;
        }
        if (!shouldReplace && this.#load !== null) return;
        this.#trackLoad(this.#queueGeneration());
      });
    }

    #flushSourceMutations(): boolean {
      const changed = this.#hostEnvironment.takeSourceChanges();
      if (changed) {
        this.#clearRestart();
        this.#pageResources.invalidateRequest();
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

    #scheduleRestart(player: Player, state: string): void {
      if (this.#finalDisposed || !this.#connected || player !== this.#player) return;
      if (this.#restartPlayer === player) {
        this.#restartState = state;
        return;
      }
      this.#restartPlayer = player;
      this.#restartState = state;
      this.#restartInitialBody = true;
      this.#restartVisibleOnly = true;
      this.#scheduleReload(true, false);
    }

    #clearRestart(): void {
      this.#restartPlayer = null;
      this.#restartState = null;
      this.#restartInitialBody = false;
      this.#restartVisibleOnly = false;
    }

    #captureRestart(visibleOnly: boolean): void {
      const player = this.#player;
      let state = this.#requestedState ?? this.#metadata?.initialState ?? this.state;
      try { state = player?.snapshot(false).requestedState ?? state; }
      catch { /* retain the last published intent */ }
      if (state === null || state === undefined) return;
      this.#restartPlayer = player;
      this.#restartState = state;
      this.#restartInitialBody = true;
      this.#restartVisibleOnly = visibleOnly;
    }

    #ensure(): Promise<RuntimeReadinessResult> {
      if (this.#finalDisposed) return Promise.reject(abortError());
      if (this.#load === null) {
        if (!this.#connected) return Promise.reject(new AvalNotReadyError());
        const operation = this.#queueGeneration();
        this.#trackLoad(operation);
        return operation;
      }
      return this.#load;
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
      this.#pageResources.invalidateRequest();
      return this.#lifecycle.retirement(
        () => this.#controller?.abort(),
        () => this.#retireGeneration(terminal)
      );
    }

    async #startGeneration(token: number): Promise<RuntimeReadinessResult> {
      const preservePlaybackLifecycle = this.#restartPlayer !== null;
      let restartState = this.#restartState;
      if (this.#restartPlayer !== null && this.#restartPlayer === this.#player) {
        restartState = this.#restartPlayer.snapshot(false).requestedState ??
          restartState;
      }
      const initialBody = this.#restartInitialBody;
      await this.#retireGeneration(false);
      if (
        !this.#lifecycle.current(token) ||
        !this.#connected || this.#finalDisposed
      ) throw abortError();
      this.#clearRestart();
      const generation = this.#sourceGeneration + 1;
      const fromReadiness = this.readiness;
      this.#trace.record("source-start", generation);
      if (generation > 1) this.#counters.sourceReplacement += 1;
      this.#controller = new AbortController();
      this.#metadata = null;
      this.#terminalError = null;
      this.#cleanupFailureCount = 0;
      this.#decoderDiagnosticLimit = 0;
      this.#decoderDiagnostics = Object.freeze([]);
      this.#rendererDiagnosticLimit = 0;
      this.#rendererDiagnostics = Object.freeze([]);
      if (!preservePlaybackLifecycle) {
        this.#playbackLifecycle = emptyPlaybackLifecycleCounters();
      }
      this.#layers.resetSource(generation);
      this.#commitPublicState({
        generation,
        readiness: "unready",
        mode: null,
        assurance: null,
        staticReason: null,
        requestedState: null,
        visualState: null,
        isTransitioning: false,
        stateNames: [],
        eventNames: [],
        inputBindings: [],
        lastError: null
      });
      this.#dispatchReadinessChange(fromReadiness, "unready");
      const document = this.ownerDocument;
      const sourceRead = readElementSources(this);
      for (const failure of sourceRead.failures) {
        this.#publishFailure(
          "invalid-configuration",
          `source[${String(failure.sourceIndex)}].${failure.attribute}`,
          false,
          generation
        );
      }
      const sources = sourceRead.sources;
      if (sources.length === 0) return this.#configurationFailure(generation);
      this.#decoderDiagnosticLimit = Math.min(
        sources.length,
        MAX_RETAINED_DECODER_SOURCES
      ) * ELEMENT_DECODER_CAPACITY.workerCount;
      this.#rendererDiagnosticLimit = Math.min(
        sources.length,
        MAX_RETAINED_DECODER_SOURCES
      );
      const view = document.defaultView;
      if (!runtimeHostSupported(this.#layers.stylesSupported, view)) {
        throw this.#publishTerminalFailure(
          "unsupported-browser",
          "configure",
          generation
        );
      }
      const clock = view.performance;
      const timing = createElementTiming(view);
      const startedAt = clock.now();
      const setupDeadline = startedAt + ELEMENT_SETUP_TIMEOUT_MS;
      const preparationDeadline = startedAt + preparationBudgetMs(sources.length);
      try {
        if (this.#hostEnvironment.needsIntersectionSample()) {
          await withLimits(
            this.#hostEnvironment.waitForIntersection(),
            this.#controller.signal,
            remainingElementPreparationMs(setupDeadline, clock, timing),
            (delta) => { this.#timerCount += delta; },
            timing
          );
        }
        runtimeModule ??= import("./player.js");
        const module = await withLimits(
          runtimeModule,
          this.#controller.signal,
          remainingElementPreparationMs(setupDeadline, clock, timing),
          (delta) => { this.#timerCount += delta; },
          timing
        );
        const preparationTimeoutMs = remainingElementPreparationMs(
          preparationDeadline,
          clock,
          timing
        );
        const initialRect = this.getBoundingClientRect();
        const selectedMotion = this.motion;
        const selectedReduced = this.#motionReduced(selectedMotion);
        const platform = createRealmPlatform(view);
        const player = await module.createPlayer({
          canvas: this.#layers.animatedCanvas,
          platform,
          initialPresentation: initialPresentation(
            initialRect,
            view.devicePixelRatio,
            this.fit
          ),
          baseUrl: document.baseURI,
          sources,
          credentials: this.crossOrigin === "use-credentials"
            ? "include" : "same-origin",
          signal: this.#controller.signal,
          preparationTimeoutMs,
          motion: selectedMotion,
          reduced: selectedReduced,
          initialState: restartState,
          initialBody,
          visible: this.effectivelyVisible,
          decoderReady: () => this.#current(generation, token) &&
            this.#pageResources.claimDecoder(generation),
          onCandidate: async (candidate) => {
            if (!this.#current(generation, token)) throw abortError();
            this.#player = candidate;
            this.#preparingPlayer = candidate;
            if (this.#visibilityPlayer !== candidate) this.#visibilityPlayer = null;
            if (this.#suspendedPlayer !== candidate) this.#suspendedPlayer = null;
            if (this.#suspendingPlayer !== candidate) {
              this.#suspendingPlayer = null;
              this.#suspension = null;
            }
            if (this.#restartPlayer !== candidate) this.#restartPlayer = null;
            candidate.activate({ publish: false });
            this.#setMetadata(candidate.metadata);
            this.#applyIntrinsic();
            await this.#reconcileSelectionMotion(
              candidate,
              selectedMotion,
              selectedReduced,
              generation,
              token
            );
            if (!this.#current(generation, token)) throw abortError();
            this.#inputBinding.refresh();
            this.#resize();
            this.#updatePlayback();
            if (this.#suspendingPlayer === candidate && this.#suspension !== null) {
              await this.#suspension;
            }
            if (!this.#current(generation, token)) throw abortError();
          },
          onResourceBytes: (bytes) => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#pageResources.setResourceBytes(bytes);
          },
          onMetadata: (metadata) => {
            if (!this.#publicationCurrent(generation, token)) return;
            if (this.#metadata === metadata) return;
            this.#setMetadata(metadata);
            this.#applyIntrinsic();
            this.#inputBinding.refresh();
            this.#resize();
          },
          onReadiness: (value, reason) => {
            if (!this.#publicationCurrent(generation, token)) return;
            const readiness = value as RuntimeReadiness;
            const from = this.readiness;
            if (value === "staticReady") {
              this.#commitPublicState({
                readiness,
                mode: "static",
                assurance: null,
                staticReason: reason as StaticReason
              });
            } else if (value === "interactiveReady" || value === "visualReady") {
              this.#commitPublicState({
                readiness,
                mode: "animated",
                assurance: "best-effort"
              });
            } else {
              this.#commitPublicState({ readiness });
            }
            this.#dispatchReadinessChange(
              from,
              readiness,
              reason as StaticReason
            );
          },
          onAnimationResourcesRetired: () => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#pageResources.animationResourcesRetired(
              this.#staticReason === "decoder-queued"
            );
          },
          onDraw: () => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#hostEnvironment.reconcileMotionPreference();
            this.#layers.markAnimatedDrawn(generation);
            this.#layers.revealAnimated(generation);
          },
          onRestart: (state) => {
            if (!this.#publicationCurrent(generation, token)) return;
            const current = this.#player;
            if (current !== null) this.#scheduleRestart(current, state);
          },
          onEvent: (type, detail) => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#runtimeEvent(type, detail, generation);
          },
          onFailure: (code, operation, fatal) => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#publishFailure(code, operation, fatal, generation);
          },
          onPlaybackFailure: (code, operation) => {
            if (!this.#publicationCurrent(generation, token)) {
              return this.#createPlaybackError(code, operation, generation);
            }
            const activePlayer = this.#player;
            const preparing = activePlayer !== null &&
              this.#preparingPlayer === activePlayer;
            const error = this.#publishTerminalFailure(
              code,
              operation,
              generation
            );
            if (activePlayer !== null && !preparing) {
              queueMicrotask(() => {
                if (
                  this.#terminalError !== error ||
                  this.#player !== activePlayer ||
                  !this.#generationCurrent(generation, token) ||
                  this.#finalDisposed
                ) return;
                void this.#queueRetirement(false).catch(() => undefined);
              });
            }
            return error;
          },
          onDecoderDiagnostics: (diagnostics) => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#retainDecoderDiagnostics(diagnostics, generation);
          },
          onRendererDiagnostics: (diagnostics) => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#retainRendererDiagnostics(diagnostics, generation);
          }
        });
        if (!this.#current(generation, token)) {
          this.#retiringPlayer = player;
          await this.#retireGeneration(false);
          throw abortError();
        }
        if (this.#player !== player) {
          throw new Error("AVAL startup candidate handoff was not completed");
        }
        let result: RuntimeReadinessResult;
        try {
          result = this.#suspendingPlayer === player && this.#suspension !== null
            ? await this.#suspension
            : await player.prepare();
        }
        finally {
          if (this.#preparingPlayer === player) this.#preparingPlayer = null;
        }
        if (!this.#current(generation, token)) throw abortError();
        if (!this.effectivelyVisible) {
          if (result.mode === "static" && result.reason === "visibility-suspended") {
            this.#completeVisibilitySuspension(player, result);
          } else {
            result = await this.#suspendForVisibility(player);
          }
        }
        if (!this.#current(generation, token)) throw abortError();
        player.publish();
        if (!this.#current(generation, token)) throw abortError();
        if (restartState === null) {
          const declarative = this.state;
          if (declarative !== null) {
            this.#applyDeclarativeStateToPlayer(
              player,
              declarative,
              generation,
              token
            );
          }
        }
        return result;
      } catch (error) {
        if (!this.#current(generation, token)) throw abortError();
        if (isAbort(error)) throw error;
        const playbackError = error instanceof AvalPlaybackError
          ? error : null;
        const timedOut = isPreparationTimeout(error);
        try {
          await failedGenerationCleanup(
            this.#player !== null,
            () => this.#retireGeneration(false),
            () => this.#pageResources.releaseAll()
          );
        } catch (cleanupError) {
          if (!this.#generationCurrent(generation, token)) throw abortError();
          if (playbackError !== null) throw playbackError;
          if (timedOut) {
            throw this.#publishTerminalFailure(
              "watchdog-timeout",
              "prepare",
              generation
            );
          }
          throw this.#publishTerminalFailure(
            "element-cleanup-incomplete",
            "prepare-cleanup",
            generation
          );
        }
        if (!this.#generationCurrent(generation, token)) throw abortError();
        if (playbackError !== null) throw playbackError;
        if (timedOut) {
          throw this.#publishTerminalFailure(
            "watchdog-timeout",
            "prepare",
            generation
          );
        }
        throw this.#publishTerminalFailure(
          "readiness-failure",
          "prepare",
          generation
        );
      }
    }

    #configurationFailure(generation: number): Promise<RuntimeReadinessResult> {
      return Promise.reject(this.#publishTerminalFailure(
        "invalid-configuration",
        "configure",
        generation
      ));
    }

    async #retireGeneration(terminal: boolean): Promise<void> {
      const controller = this.#controller;
      const player = this.#player ?? this.#retiringPlayer;
      const suspension = this.#suspendingPlayer === player
        ? this.#suspension : null;
      this.#controller = null;
      this.#player = null;
      if (this.#visibilityPlayer === player) this.#visibilityPlayer = null;
      controller?.abort();
      this.#inputBinding.disconnect();
      if (player === null) {
        this.#pageResources.releaseAll();
        return;
      }
      const retry = this.#retiringPlayer === player;
      this.#retiringPlayer = player;
      let failed = false;
      let caught = false;
      let failure: unknown;
      if (!retry || this.#retiringDeclaredFileBytes === 0) {
        this.#retiringDeclaredFileBytes = 0;
        try {
          const retired = player.snapshot(false);
          this.#captureCleanupFailures(retired);
          this.#retainDecoderDiagnostics(
            retired.decoderDiagnostics,
            this.#sourceGeneration
          );
          this.#retainRendererDiagnostics(
            retired.rendererDiagnostics,
            this.#sourceGeneration
          );
          this.#retainPlaybackLifecycle(retired.playbackLifecycle);
          this.#retiringDeclaredFileBytes = retired.declaredFileBytes;
          this.#counters.contextRecovery += retired.contextRecoveryCount;
        } catch {
          failed = true;
        }
      }
      let disposed = false;
      try {
        if (suspension !== null) await Promise.allSettled([suspension]);
        await player.dispose();
        await player.settled();
        disposed = true;
      } catch (error) {
        failed = true;
        caught = true;
        failure = error;
      }
      if (this.#preparingPlayer === player) this.#preparingPlayer = null;
      if (this.#suspendingPlayer === player) {
        this.#suspendingPlayer = null;
        this.#suspension = null;
      }
      if (this.#suspendedPlayer === player) this.#suspendedPlayer = null;
      if (this.#restartPlayer === player) this.#restartPlayer = null;
      let snapshot: Readonly<PlayerSnapshot> | null = null;
      try { snapshot = player.snapshot(false); }
      catch (error) {
        failed = true;
        if (!caught) {
          caught = true;
          failure = error;
        }
      }
      this.#captureCleanupFailures(snapshot);
      this.#retainDecoderDiagnostics(
        snapshot?.decoderDiagnostics ?? Object.freeze([]),
        this.#sourceGeneration
      );
      this.#retainRendererDiagnostics(
        snapshot?.rendererDiagnostics ?? Object.freeze([]),
        this.#sourceGeneration
      );
      this.#retainPlaybackLifecycle(snapshot?.playbackLifecycle);
      if (disposed && !failed && playerSnapshotDisposed(snapshot)) {
        try {
          this.#pageResources.setResourceBytes(0);
          this.#pageResources.releaseAll();
        } catch (error) {
          failed = true;
          if (!caught) {
            caught = true;
            failure = error;
          }
        }
      }
      const pageResources = this.#pageResources.snapshot();
      this.#cleanup = createSourceCleanupReceipt({
        generation: this.#elementGeneration,
        sourceGeneration: this.#sourceGeneration,
        runtime: snapshot,
        page: pageResources.page,
        retiredDeclaredFileBytes: this.#retiringDeclaredFileBytes,
        operationFailed: failed,
        pageResources: pageResources.ownership,
        terminal,
        stalePublicationCount: this.#stalePublicationCount
      });
      this.#counters.cleanup += 1;
      try {
        if (proveSourceRetirement(disposed, this.#cleanup)) {
          this.#retiringPlayer = null;
          this.#retiringDeclaredFileBytes = 0;
          return;
        }
      } catch (error) {
        if (!caught) {
          caught = true;
          failure = error;
        }
      }
      if (caught) throw failure;
      throw new ElementCleanupIncompleteError();
    }

    #runtimeEvent(
      type: string,
      detail: Readonly<Record<string, unknown>>,
      generation: number
    ): void {
      if (type === "requestedstatechange") {
        this.#inputGeneration += 1;
      } else if (type === "underflow") {
        this.#counters.underflow += 1;
      }
      this.#commitPublicState({
        ...(type === "requestedstatechange"
          ? { requestedState: String(detail.to) }
          : {}),
        ...(type === "visualstatechange"
          ? { visualState: String(detail.to) }
          : {}),
        isTransitioning: transitioningState(
          this.#transitioning,
          type,
          detail
        )
      });
      this.#dispatch(type, detail, generation);
      if (type === "transitionend") this.#inputBinding.transitionEnded();
    }

    #publishFailure(
      code: FailureInput,
      operation: string,
      fatal: boolean,
      generation: number
    ): void {
      if (fatal) {
        this.#publishTerminalFailure(code, operation, generation);
        return;
      }
      if (this.#terminalError?.generation === generation) return;
      const publicCode = publicFailureCode(code);
      const failure = Object.freeze({
        code: publicCode,
        message: `AVAL operation failed (${publicCode})`,
        operation
      }) as Readonly<AvalPublicFailure>;
      this.#commitPublicState({
        lastError: Object.freeze({ generation, failure, fatal })
      });
      this.#dispatch("error", { failure, fatal }, generation);
    }

    #publishTerminalFailure(
      code: FailureInput,
      operation: string,
      generation: number
    ): AvalPlaybackError {
      if (this.#terminalError?.generation === generation) {
        return this.#terminalError;
      }
      const error = this.#createPlaybackError(code, operation, generation);
      this.#terminalError = error;
      const retainedLoad = Promise.reject(error);
      void retainedLoad.catch(() => undefined);
      this.#load = retainedLoad;
      const from = this.readiness;
      const lastError: Readonly<AvalErrorDetail> = Object.freeze({
        generation,
        failure: error.failure,
        fatal: true
      });
      this.#commitPublicState({
        readiness: "error",
        mode: null,
        assurance: null,
        staticReason: null,
        lastError
      });
      this.#dispatchReadinessChange(from, "error");
      this.#dispatch("error", { failure: error.failure, fatal: true }, generation);
      return error;
    }

    #createPlaybackError(
      code: FailureInput,
      operation: string,
      generation: number
    ): AvalPlaybackError {
      const publicCode = publicFailureCode(code);
      return new AvalPlaybackError(Object.freeze({
        code: publicCode,
        message: `AVAL operation failed (${publicCode})`,
        operation
      }), generation);
    }

    #dispatchReadinessChange(
      from: RuntimeReadiness,
      value: RuntimeReadiness,
      reason?: StaticReason
    ): void {
      if (from === value) return;
      this.#dispatch("readinesschange", {
        from,
        to: value,
        ...(reason === undefined ? {} : { reason })
      } satisfies Omit<AvalReadinessChangeDetail, "generation">,
      this.#sourceGeneration);
    }

    #dispatch(
      type: string,
      detail: Readonly<Record<string, unknown>>,
      generation = this.#sourceGeneration
    ): void {
      if (generation < 1) return;
      this.#trace.record(`publish-${type}`, generation);
      try {
        this.#events.dispatch(this.#events.create(
          type,
          Object.freeze({ generation, ...detail })
        ));
      } catch { /* public observers cannot break runtime authority */ }
    }

    #resize(
      geometry: Readonly<ElementHostGeometry> = this.#hostEnvironment.measure()
    ): void {
      this.#resizeGeneration += 1;
      const fit = this.fit ?? this.#metadata?.canvas.fit ?? "contain";
      this.#player?.resize(
        Math.max(1, geometry.width),
        Math.max(1, geometry.height),
        geometry.dpr,
        fit
      );
      this.#visibilityChanged();
    }

    #hostVisibilityChanged(
      change: Readonly<ElementHostVisibilityChange>
    ): void {
      if (change.reason === "pagehide") {
        this.#trace.record("pagehide", Math.max(1, this.#sourceGeneration));
      }
      if (change.reason !== "bfcache-restore") {
        this.#visibilityChanged(change.reason === "pagehide");
        return;
      }
      this.#commitPublicState({
        effectivelyVisible: this.#hostEnvironment.snapshot().effectivelyVisible
      });
      this.#trace.record("bfcache-restore", Math.max(1, this.#sourceGeneration));
      this.#pageResources.setVisible(this.effectivelyVisible);
      this.#pageResources.invalidateRequest();
      this.#captureRestart(false);
      this.#scheduleReload(true, false);
    }

    #hostMotionPreferenceChanged(): void {
      if (this.motion !== "auto") return;
      this.#motionGeneration += 1;
      this.#applyMotion();
    }

    #applyIntrinsic(): void {
      const width = this.width;
      const height = this.height;
      const canvas = this.#metadata?.canvas;
      const ratio = intrinsicRatio(width, height, canvas);
      this.#layers.setIntrinsicSize({ aspectRatio: ratio, width, height });
    }

    #setMetadata(metadata: Readonly<Metadata>): void {
      this.#metadata = metadata;
      this.#commitPublicState({
        stateNames: metadata.stateNames,
        eventNames: metadata.eventNames,
        inputBindings: metadata.bindings
      });
    }

    #visibilityChanged(force = false): void {
      const environment = this.#hostEnvironment.snapshot();
      if (!environment.intersectionKnown && !force) return;
      const visible = environment.effectivelyVisible;
      const previous = this.effectivelyVisible;
      this.#commitPublicState({ effectivelyVisible: visible });
      const player = this.#player;
      const edge = visible !== previous;
      const playerChanged = player !== this.#visibilityPlayer;
      if (!edge && !playerChanged) return;
      if (edge) {
        this.#visibilityGeneration += 1;
        this.#pageResources.setVisible(visible);
      }
      this.#visibilityPlayer = player;
      if (player === null) return;
      player.setVisibility(visible);
      this.#updatePlayback();
      const source = visible ? "visible" : "hidden";
      this.#inputBinding.send(source);
      if (!visible) {
        if (
          this.#suspendedPlayer !== player &&
          this.#suspendingPlayer !== player
        ) {
          const suspension = this.#suspendForVisibility(player);
          this.#load = suspension;
          void suspension.catch(() => undefined);
        }
        return;
      }
      if (this.#suspendedPlayer === player) {
        const state = this.#restartState ??
          player.snapshot(false).requestedState ??
          this.#requestedState ?? this.#metadata?.initialState;
        if (state !== undefined && state !== null) {
          this.#scheduleRestart(player, state);
        }
      }
    }

    #playIntent(): boolean {
      return this.#manualPlaying;
    }

    #applyMotion(): void {
      const player = this.#player;
      if (player === null) return;
      const generation = this.#sourceGeneration;
      const reduced = this.#motionReduced(this.motion);
      if (reduced) this.#pageResources.cancelDecoderTicket();
      void player.setMotion(this.motion, reduced).then(() => {
        if (player === this.#player) this.#updatePlayback();
      }, (error) => {
        if (player === this.#player && !isAbort(error)) {
          this.#publishFailure("readiness-failure", "motion", false, generation);
        }
      });
    }

    async #reconcileSelectionMotion(
      player: Player,
      selectedMotion: AvalMotion,
      selectedReduced: boolean,
      generation: number,
      token: number
    ): Promise<void> {
      let appliedMotion = selectedMotion;
      let appliedReduced = selectedReduced;
      while (this.#current(generation, token) && player === this.#player) {
        const motion = this.motion;
        const reduced = this.#motionReduced(motion);
        if (!motionSelectionChanged(
          appliedMotion,
          appliedReduced,
          motion,
          reduced
        )) return;
        await player.setMotion(motion, reduced);
        appliedMotion = motion;
        appliedReduced = reduced;
      }
    }

    #motionReduced(policy: AvalMotion): boolean {
      return policy === "reduce" ||
        policy === "auto" && this.#hostEnvironment.snapshot().reducedMotion;
    }

    #updatePlayback(): void {
      const player = this.#player;
      if (player === null) return;
      if (!this.#playIntent() || !this.effectivelyVisible) {
        player.pause();
      } else if (
        player !== this.#suspendedPlayer &&
        player !== this.#suspendingPlayer
      ) {
        void player.resume().catch(() => undefined);
      }
    }

    #suspendForVisibility(player: Player): Promise<RuntimeReadinessResult> {
      if (this.#suspendingPlayer === player && this.#suspension !== null) {
        return this.#suspension;
      }
      const operation = player.suspend("visibility-suspended");
      this.#suspendingPlayer = player;
      const tracked = operation.then((result) => {
        this.#completeVisibilitySuspension(player, result);
        return result;
      }, (error) => {
        if (this.#suspendingPlayer === player) {
          this.#suspendingPlayer = null;
          this.#suspension = null;
        }
        throw error;
      });
      this.#suspension = tracked;
      return tracked;
    }

    #completeVisibilitySuspension(
      player: Player,
      result: RuntimeReadinessResult
    ): void {
      if (result.mode !== "static" || result.reason !== "visibility-suspended") {
        throw new Error("Invalid AVAL visibility suspension result");
      }
      if (this.#suspendingPlayer === player) {
        this.#suspendingPlayer = null;
        this.#suspension = null;
      }
      if (player !== this.#player) return;
      this.#suspendedPlayer = player;
      if (!this.effectivelyVisible) return;
      const state = this.#restartState ?? player.snapshot(false).requestedState ??
        this.#requestedState ?? this.#metadata?.initialState;
      if (state !== undefined && state !== null) this.#scheduleRestart(player, state);
    }

    #current(generation: number, token: number): boolean {
      return this.#generationCurrent(generation, token) &&
        this.#controller?.signal.aborted === false;
    }

    #retainedTerminalError(): AvalPlaybackError | null {
      const error = this.#terminalError;
      return error?.generation === this.#sourceGeneration ? error : null;
    }

    #generationCurrent(generation: number, token: number): boolean {
      return !this.#finalDisposed &&
        this.#lifecycle.current(token) &&
        generation === this.#sourceGeneration;
    }

    #publicationCurrent(generation: number, token: number): boolean {
      if (this.#current(generation, token)) return true;
      this.#stalePublicationCount += 1;
      return false;
    }

    #decoderGranted(generation: number): void {
      if (
        this.#finalDisposed || !this.#connected ||
        generation !== this.#sourceGeneration
      ) return;
      const player = this.#player;
      if (player !== null && !this.#reloadQueued) {
        const state = player.snapshot(false).requestedState ??
          this.#requestedState ?? this.#metadata?.initialState;
        if (state !== undefined && state !== null) {
          this.#scheduleRestart(player, state);
        }
      }
    }

    #captureCleanupFailures(snapshot: Readonly<PlayerSnapshot> | null): void {
      this.#cleanupFailureCount = Math.max(
        this.#cleanupFailureCount,
        snapshot?.cleanupFailureCount ?? 0
      );
    }

    #retainPlaybackLifecycle(
      lifecycle: Readonly<AvalPlaybackLifecycleCounters> | undefined
    ): void {
      if (lifecycle === undefined) return;
      this.#playbackLifecycle = retainPlaybackLifecycleCounters(
        this.#playbackLifecycle,
        lifecycle
      );
    }

    #retainDecoderDiagnostics(
      diagnostics: readonly Readonly<PlayerDecoderDiagnostic>[],
      generation: number
    ): void {
      if (
        generation !== this.#sourceGeneration ||
        diagnostics.length === 0 ||
        this.#decoderDiagnosticLimit === 0
      ) return;
      const bySourceLane = new Map<string, Readonly<AvalDecoderDiagnostic>>(
        this.#decoderDiagnostics.map((diagnostic) => [
          `${String(diagnostic.sourceIndex)}:${String(diagnostic.lane)}`,
          diagnostic
        ] as const)
      );
      for (const diagnostic of diagnostics) {
        const key = `${String(diagnostic.sourceIndex)}:${String(diagnostic.lane)}`;
        if (!bySourceLane.has(key)) {
          bySourceLane.set(
            key,
            freezeAvalDecoderDiagnostic(diagnostic, generation)
          );
        }
      }
      const retained = [...bySourceLane.values()].sort((left, right) =>
        left.sourceIndex - right.sourceIndex || left.lane - right.lane
      );
      this.#decoderDiagnostics = Object.freeze(
        retained.slice(-this.#decoderDiagnosticLimit)
      );
    }

    #retainRendererDiagnostics(
      diagnostics: readonly Readonly<PlayerRendererDiagnostic>[],
      generation: number
    ): void {
      if (
        generation !== this.#sourceGeneration ||
        diagnostics.length === 0 ||
        this.#rendererDiagnosticLimit === 0
      ) return;
      const bySource = new Map<number, Readonly<AvalRendererDiagnostic>>(
        this.#rendererDiagnostics.map((diagnostic) => [
          diagnostic.sourceIndex,
          diagnostic
        ] as const)
      );
      for (const diagnostic of diagnostics) {
        if (!bySource.has(diagnostic.sourceIndex)) {
          bySource.set(
            diagnostic.sourceIndex,
            freezeAvalRendererDiagnostic(diagnostic, generation)
          );
        }
      }
      const retained = [...bySource.values()].sort((left, right) =>
        left.sourceIndex - right.sourceIndex
      );
      this.#rendererDiagnostics = Object.freeze(
        retained.slice(-this.#rendererDiagnosticLimit)
      );
    }

    #ownershipSnapshot(terminal: boolean): Readonly<ElementOwnershipSnapshot> {
      const host = this.#hostEnvironment.snapshot();
      const input = this.#inputBinding.snapshot();
      const pendingCommandCount = this.#lifecycle.pending +
        Number(this.#reloadQueued) + Number(this.#suspension !== null) +
        Number(this.#restartPlayer !== null) +
        this.#eventMutations.pendingOperationCount;
      return createElementOwnershipSnapshot({
        terminal,
        input,
        host,
        deferredOperationCount: pendingCommandCount,
        timerCount: this.#timerCount
      });
    }

    #diagnostics(trace: boolean): Readonly<AvalDiagnostics> {
      const runtimePlayer = this.#player ?? this.#retiringPlayer;
      const runtime = runtimePlayer?.snapshot(trace) ?? emptyRuntime();
      this.#retainPlaybackLifecycle(runtime.playbackLifecycle);
      if (runtime.decoderDiagnostics.length > 0) {
        this.#retainDecoderDiagnostics(
          runtime.decoderDiagnostics,
          this.#sourceGeneration
        );
      }
      if (runtime.rendererDiagnostics.length > 0) {
        this.#retainRendererDiagnostics(
          runtime.rendererDiagnostics,
          this.#sourceGeneration
        );
      }
      const ownership = this.#ownershipSnapshot(this.#finalDisposed);
      const pageResources = this.#pageResources.snapshot();
      const page = pageResources.page;
      const participant = pageResources.ownership;
      const host = this.#hostEnvironment.snapshot();
      const reduced = this.motion === "reduce" ||
        this.motion === "auto" && host.reducedMotion;
      const diagnostics = {
        elementGeneration: this.#elementGeneration,
        sourceGeneration: this.#sourceGeneration,
        inputGeneration: this.#inputGeneration,
        motionGeneration: this.#motionGeneration,
        visibilityGeneration: this.#visibilityGeneration,
        resizeGeneration: this.#resizeGeneration,
        connected: this.#connected,
        finalDisposed: this.#terminalCleanup?.completed === true,
        readiness: this.#readiness,
        mode: this.#mode,
        assurance: this.assurance,
        staticReason: this.#staticReason,
        requestedState: this.#requestedState,
        visualState: this.#visualState,
        isTransitioning: this.#transitioning,
        paused: this.paused,
        effectivelyVisible: this.effectivelyVisible,
        stateNames: Object.freeze([...this.stateNames]),
        eventNames: Object.freeze([...this.eventNames]),
        inputBindings: Object.freeze(this.inputBindings.map((binding) =>
          Object.freeze({ ...binding })
        )),
        configuredMotion: this.motion,
        hostReducedMotion: host.observedReducedMotion,
        autoplay: this.autoplay,
        fit: this.fit,
        lastFailure: this.getSnapshot().lastError?.failure ?? null,
        counters: Object.freeze({
          ...this.#counters,
          contextRecovery: contextRecoveryCount(
            this.#counters.contextRecovery,
            this.#player === runtimePlayer ? runtime.contextRecoveryCount : 0
          )
        }),
        cleanup: this.#cleanup === null
          ? null
          : serializeSourceCleanupReceipt(this.#cleanup),
        elementOwnership: serializeElementOwnershipSnapshot(ownership),
        terminalCleanup: this.#terminalCleanup === null
          ? null
          : serializeElementTerminalCleanupProof(this.#terminalCleanup),
        outstanding: Object.freeze({
          player: runtimePlayer === null ? 0 : 1,
          decoder: outstandingDecoder(
            runtime.workerCount,
            participant.decoderState
          ),
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
          pagePhysicalBytes: page.physicalBytes,
          activeLeaseCount: participant.activeLeaseCount,
          decoderLeaseState: participant.decoderState,
          pageActiveDecoderSlotCount: page.active,
          pageQueuedDecoderTicketCount: page.queued,
          pageParkedDecoderTicketCount: page.parked,
          pageParticipantCount: page.participants,
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
          configured: this.motion,
          hostReducedMotion: host.observedReducedMotion,
          effective: reduced ? "reduce" : "full",
          actual: this.#mode
        }),
        playIntent: Object.freeze({
          autoplay: this.autoplay,
          manualPlaying: this.#manualPlaying,
          paused: this.paused
        }),
        visibility: Object.freeze({
          documentVisible: host.documentVisible,
          intersecting: host.intersecting,
          positiveBox: host.positiveBox,
          effectivelyVisible: this.effectivelyVisible,
          observerSupported: host.observerSupported,
          runtimeVisibility: runtimeVisibility(
            runtimePlayer !== null,
            this.effectivelyVisible
          ),
          runtimeSuspension: runtimeSuspension(
            runtimePlayer !== null,
            this.#suspendingPlayer !== null,
            this.#suspendedPlayer !== null
          ),
          rebuildPending: this.#reloadQueued || this.#restartPlayer !== null
        }),
        presentation: Object.freeze({
          fit: this.fit ?? this.#metadata?.canvas.fit ?? null,
          ...runtime.presentation
        }),
        ...(trace
          ? {
              elementTrace: this.#trace.snapshot(),
              runtimeTrace: runtime.trace
            }
          : {})
      } satisfies AvalDiagnostics;
      return Object.freeze(diagnostics);
    }
  }

  return AvalElementImpl as unknown as AvalElementConstructor;
}

export function runtimeHostSupported(
  stylesSupported: boolean,
  view: Window | null
): view is Window {
  if (!stylesSupported || view === null) return false;
  try {
    return view.isSecureContext === true &&
      typeof view.crypto?.subtle?.digest === "function";
  } catch {
    return false;
  }
}

export function createRealmPlatform(
  view: Window
): Readonly<PlayerInput["platform"]> {
  const realm = view as Window & Partial<Pick<
    typeof globalThis,
    "Worker" | "VideoDecoder" | "VideoFrame"
  >>;
  return Object.freeze({
    fetch: view.fetch.bind(view),
    Worker: typeof realm.Worker === "function" ? realm.Worker : null,
    VideoDecoder: typeof realm.VideoDecoder === "function" ? realm.VideoDecoder : null,
    VideoFrame: typeof realm.VideoFrame === "function" ? realm.VideoFrame : null,
    requestAnimationFrame: view.requestAnimationFrame.bind(view),
    cancelAnimationFrame: view.cancelAnimationFrame.bind(view),
    now: view.performance.now.bind(view.performance),
    setTimeout: (callback, delay) => view.setTimeout(callback, delay),
    clearTimeout: (handle) => view.clearTimeout(handle),
    crypto: view.crypto
  });
}

export function createElementTiming(
  view: Window
): ElementTiming {
  const realm = view as Window & Pick<typeof globalThis, "DOMException">;
  return Object.freeze({
    setTimeout: (callback, delay) => view.setTimeout(callback, delay),
    clearTimeout: (handle) => view.clearTimeout(handle),
    timeoutError: () => new realm.DOMException(
      "AVAL preparation timed out",
      "TimeoutError"
    ),
    abortError: () => new realm.DOMException(
      "AVAL operation was aborted",
      "AbortError"
    )
  });
}

export function deferAcceptedSend(
  canSend: () => boolean,
  defer: (operation: () => void) => boolean,
  send: () => void
): boolean {
  if (!canSend()) return false;
  if (!defer(send)) return false;
  return true;
}

export async function failedGenerationCleanup(
  published: boolean,
  retirePublished: () => Promise<void>,
  releaseUnpublished: () => void
): Promise<void> {
  if (published) await retirePublished();
  else releaseUnpublished();
}

export function rebindAdoptedStyles(
  layers: Pick<ShadowLayerOwner, "rebindStyles">,
  document: Document
): boolean {
  return layers.rebindStyles(document);
}

export function initialPresentation(
  rect: Readonly<Pick<DOMRectReadOnly, "width" | "height">>,
  dpr: number,
  fit: AvalFit | null
): Readonly<{
  width: number;
  height: number;
  dpr: number;
  fit: AvalFit | null;
}> {
  return Object.freeze({ width: rect.width, height: rect.height, dpr, fit });
}

export function motionSelectionChanged(
  selectedPolicy: AvalMotion,
  selectedReduced: boolean,
  currentPolicy: AvalMotion,
  currentReduced: boolean
): boolean {
  return selectedPolicy !== currentPolicy || selectedReduced !== currentReduced;
}

export function publicFailureCode(
  code: FailureInput
): AvalPublicFailure["code"] {
  return code;
}

export function outstandingDecoder(
  workerCount: number,
  ticketState: string | null
): number {
  return Math.max(
    workerCount,
    ticketState === null ? 0 : ELEMENT_DECODER_CAPACITY.workerCount
  );
}

export function contextRecoveryCount(
  retiredCount: number,
  liveCount: number
): number {
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

export function resumeCurrent(
  expectedSequence: number,
  currentSequence: number,
  manualPlaying: boolean,
  effectivelyVisible: boolean,
  expectedPlayer: object,
  currentPlayer: object | null,
  suspendedPlayer: object | null,
  suspendingPlayer: object | null
): boolean {
  return expectedSequence === currentSequence && manualPlaying &&
    effectivelyVisible && expectedPlayer === currentPlayer &&
    expectedPlayer !== suspendedPlayer && expectedPlayer !== suspendingPlayer;
}

export function transitioningState(
  current: boolean,
  type: string,
  detail: Readonly<Record<string, unknown>>
): boolean {
  if (typeof detail.isTransitioning === "boolean") return detail.isTransitioning;
  if (type === "transitionstart") return true;
  if (type === "transitionend") return false;
  return current;
}

export function intrinsicRatio(
  width: number | null,
  height: number | null,
  canvas: Readonly<Metadata["canvas"]> | undefined
): number | null {
  if (width !== null && height !== null) return width / height;
  if (canvas === undefined) return null;
  return canvas.width * canvas.pixelAspect[0] /
    canvas.pixelAspect[1] / canvas.height;
}

function freezeAvalDecoderDiagnostic(
  diagnostic: Readonly<PlayerDecoderDiagnostic>,
  sourceGeneration: number
): Readonly<AvalDecoderDiagnostic> {
  const firstFrame = freezeAvalDecoderFrame(diagnostic.firstFrame);
  const lastGoodFrame = freezeAvalDecoderFrame(diagnostic.lastGoodFrame);
  const outputFailure = freezeAvalDecoderOutputFailure(diagnostic.outputFailure);
  return Object.freeze({
    ...diagnostic,
    sourceGeneration,
    exception: diagnostic.exception === null
      ? null
      : Object.freeze({ ...diagnostic.exception }),
    firstFrame,
    lastGoodFrame,
    outputFailure,
    graph: Object.freeze({ ...diagnostic.graph })
  }) satisfies Readonly<AvalDecoderDiagnostic>;
}

function freezeAvalDecoderFrame(
  frame: Readonly<AvalDecoderFrameDiagnostic> | null
): Readonly<AvalDecoderFrameDiagnostic> | null {
  if (frame === null) return null;
  return Object.freeze({
    ...frame,
    visibleRect: frame.visibleRect === null
      ? null
      : Object.freeze({ ...frame.visibleRect }),
    colorSpace: freezeAvalDecoderColorSpace(frame.colorSpace)
  });
}

function freezeAvalDecoderOutputFailure(
  failure: Readonly<AvalDecoderOutputFailureDiagnostic> | null
): Readonly<AvalDecoderOutputFailureDiagnostic> | null {
  if (failure === null) return null;
  return Object.freeze({
    ...failure,
    expected: freezeAvalDecoderExpectedOutput(failure.expected),
    actual: freezeAvalDecoderObservedOutput(failure.actual)
  });
}

function freezeAvalDecoderExpectedOutput(
  metadata: Readonly<AvalDecoderExpectedOutputDiagnostic> | null
): Readonly<AvalDecoderExpectedOutputDiagnostic> | null {
  if (metadata === null) return null;
  return Object.freeze({
    ...metadata,
    visibleRect: Object.freeze({ ...metadata.visibleRect }),
    colorSpace: freezeAvalDecoderColorSpace(metadata.colorSpace)
  });
}

function freezeAvalDecoderObservedOutput(
  metadata: Readonly<AvalDecoderObservedOutputDiagnostic> | null
): Readonly<AvalDecoderObservedOutputDiagnostic> | null {
  if (metadata === null) return null;
  return Object.freeze({
    ...metadata,
    visibleRect: metadata.visibleRect === null
      ? null
      : Object.freeze({ ...metadata.visibleRect }),
    colorSpace: freezeAvalDecoderColorSpace(metadata.colorSpace)
  });
}

function freezeAvalDecoderColorSpace(
  colorSpace: readonly [
    string | null,
    string | null,
    string | null,
    boolean | null
  ] | null
): readonly [
  string | null,
  string | null,
  string | null,
  boolean | null
] | null {
  return colorSpace === null
    ? null
    : Object.freeze([...colorSpace]) as readonly [
        string | null,
        string | null,
        string | null,
        boolean | null
      ];
}

function freezeAvalRendererDiagnostic(
  diagnostic: Readonly<PlayerRendererDiagnostic>,
  sourceGeneration: number
): Readonly<AvalRendererDiagnostic> {
  return Object.freeze({
    ...diagnostic,
    sourceGeneration,
    exception: diagnostic.exception === null
      ? null
      : Object.freeze({ ...diagnostic.exception }),
    layout: Object.freeze({ ...diagnostic.layout }),
    backing: Object.freeze({ ...diagnostic.backing }),
    bytes: Object.freeze({ ...diagnostic.bytes }),
    limits: Object.freeze({ ...diagnostic.limits }),
    contextAttributes: diagnostic.contextAttributes === null
      ? null
      : Object.freeze({ ...diagnostic.contextAttributes })
  }) satisfies Readonly<AvalRendererDiagnostic>;
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

function remainingElementPreparationMs(
  deadline: number,
  clock: Performance,
  timing: ElementTiming
): number {
  const remaining = Math.floor(deadline - clock.now());
  if (remaining < 1) throw timing.timeoutError();
  return remaining;
}

function withLimits<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
  timerChanged?: (delta: 1 | -1) => void,
  timing?: ElementTiming
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    return Promise.reject(new RangeError("timeoutMs must be a positive integer"));
  }
  if (signal === undefined && timeoutMs === undefined) return operation;
  if (timing === undefined && timeoutMs !== undefined) {
    return Promise.reject(new AvalNotReadyError("AVAL owner window is unavailable"));
  }
  return new Promise<T>((resolve, reject) => {
    let timer: number | null = null;
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      if (timer !== null) {
        timing!.clearTimeout(timer);
        timer = null;
        timerChanged?.(-1);
      }
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const abort = (): void => rejectOnce(
      signal?.reason ?? timing?.abortError() ?? abortError()
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== undefined) {
      timer = timing!.setTimeout(() => rejectOnce(timing!.timeoutError()), timeoutMs);
      timerChanged?.(1);
    }
    operation.then(resolveOnce, rejectOnce);
  });
}

function abortError(): Error {
  return new DOMException("AVAL operation was aborted", "AbortError");
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "AbortError";
}

function isPreparationTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "TimeoutError";
}
