import { IDENTIFIER_PATTERN } from "@pixel-point/aval-format";

import { ElementAttributeReflection } from "./element-attribute-reflection.js";
import { AVAL_ATTRIBUTES, AVAL_UPGRADE_PROPERTIES } from "./element-attributes.js";
import {
  createElementOwnershipSnapshot,
  createElementTerminalCleanupProof
} from "./element-cleanup-proof.js";
import { ElementDiagnostics } from "./element-diagnostics.js";
import { ElementEventMutationGate } from "./element-event-mutation-gate.js";
import {
  createDomHostEnvironmentPort,
  ElementHostEnvironment,
  type ElementHostGeometry,
  type ElementHostVisibilityChange
} from "./element-host-environment.js";
import { ElementInputBinding } from "./element-input-binding.js";
import { ElementPageResourceOwner } from "./element-page-resource-owner.js";
import { ElementPublicEvents } from "./element-public-events.js";
import type { ElementRuntimeDiagnosticEvent } from "./element-runtime-contract.js";
import { ElementRuntimeSession } from "./element-runtime-session.js";
import {
  ElementSnapshotStore,
  transitioningState,
  type ElementSnapshotState
} from "./element-snapshot-store.js";
import { AvalNotReadyError } from "./errors.js";
import type { Metadata } from "./player-contract.js";
import {
  createElementOperationTiming,
  elementAbortError,
  withElementOperationLimits
} from "./preparation-deadline.js";
import type {
  AvalAutoplay,
  AvalBindings,
  AvalCrossOrigin,
  AvalDiagnostics,
  AvalElement,
  AvalElementConstructor,
  AvalErrorDetail,
  AvalFit,
  AvalMode,
  AvalMotion,
  AvalPublicFailure,
  AvalReadinessChangeDetail,
  AvalSnapshot,
  Binding,
  RuntimeReadiness,
  RuntimeReadinessResult,
  StaticReason
} from "./public-types.js";
import {
  intrinsicRatio,
  ShadowLayerOwner
} from "./shadow-layers.js";
import { isElementSourceMutation, readElementSources } from "./element-sources.js";

export function createAvalElementClass(
  Base: typeof HTMLElement
): AvalElementConstructor {
  class AvalElementImpl extends Base implements AvalElement {
    public static get observedAttributes(): readonly string[] {
      return AVAL_ATTRIBUTES;
    }

    readonly #attributes: ElementAttributeReflection;
    readonly #layers: ShadowLayerOwner;
    readonly #events: ElementPublicEvents;
    readonly #eventMutations: ElementEventMutationGate;
    readonly #hostEnvironment: ElementHostEnvironment<MutationRecord>;
    readonly #inputBinding: ElementInputBinding<Element>;
    readonly #pageResources: ElementPageResourceOwner;
    readonly #snapshots: ElementSnapshotStore;
    readonly #diagnostics = new ElementDiagnostics();
    readonly #runtime: ElementRuntimeSession;
    #deferredDispose: Promise<void> | null = null;
    #disposalObserved = false;

    public constructor() {
      super();
      this.#attributes = new ElementAttributeReflection(this);
      this.#layers = new ShadowLayerOwner(this);
      this.#events = new ElementPublicEvents(this);
      this.#eventMutations = new ElementEventMutationGate(this.#events);
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
      this.#inputBinding = new ElementInputBinding({
        host: this,
        documentTarget: () => this.ownerDocument,
        activeElement: () => this.ownerDocument.activeElement,
        rootOf: (target) => target.getRootNode(),
        resolveById: (id) => {
          const root = this.getRootNode();
          if ("getElementById" in root && typeof root.getElementById === "function") {
            return root.getElementById(id);
          }
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
        currentBindings: () => this.#runtime.inputBindings,
        isTransitioning: () => this.isTransitioning,
        dispatchBinding: (event) => this.send(event),
        recordSource: (source) => this.#diagnostics.recordInput(
          source,
          Math.max(1, this.#runtime.sourceGeneration)
        ),
        onTargetUnavailable: () => this.#runtime.publishFailure(
          "interaction-target-unavailable",
          "bind-inputs",
          false,
          Math.max(1, this.#runtime.sourceGeneration)
        ),
        queueOwnedMicrotask: (operation) =>
          this.#eventMutations.queueOwnedMicrotask(operation),
        queueEventFollowup: (operation) =>
          this.#eventMutations.queueEventFollowup(operation)
      });
      this.#pageResources = new ElementPageResourceOwner({
        currentRealm: () => this.ownerDocument.defaultView ?? globalThis,
        currentVisibility: () => this.effectivelyVisible,
        onDecoderGranted: (generation) => this.#runtime.decoderGranted(generation)
      });
      this.#hostEnvironment = new ElementHostEnvironment({
        environment: createDomHostEnvironmentPort(
          this,
          (record) => isElementSourceMutation(this, record)
        ),
        callbacks: {
          sourcesChanged: () => this.#runtime.scheduleReload(),
          geometryChanged: (geometry) => this.#runtime.resize(geometry),
          visibilityChanged: (change) => this.#hostVisibilityChanged(change),
          motionPreferenceChanged: () => this.#runtime.motionPreferenceChanged(),
          realmChanged: () => {
            this.#inputBinding.realmChanged();
            this.#layers.rebindStyles(this.ownerDocument);
          }
        }
      });
      this.#runtime = new ElementRuntimeSession({
        read: {
          snapshot: () => {
            const host = this.#hostEnvironment.snapshot();
            return Object.freeze({
              publicSnapshot: this.getSnapshot(),
              view: this.ownerDocument.defaultView,
              baseUrl: this.ownerDocument.baseURI,
              crossOrigin: this.crossOrigin,
              motion: this.motion,
              autoplay: this.autoplay,
              fit: this.fit,
              declarativeState: this.state,
              geometry: this.#hostEnvironment.geometry,
              reducedMotion: host.reducedMotion,
              intersectionKnown: host.intersectionKnown,
              effectivelyVisible: host.effectivelyVisible
            });
          },
          sources: () => readElementSources(this),
          takeSourceChanges: () => this.#hostEnvironment.takeSourceChanges(),
          needsIntersectionSample: () =>
            this.#hostEnvironment.needsIntersectionSample(),
          waitForIntersection: () => this.#hostEnvironment.waitForIntersection()
        },
        publish: {
          commit: (patch) => this.#commitPublicState(patch),
          diagnostic: (event) => this.#recordRuntimeDiagnostic(event),
          readinessChanged: (value, reason, generation) =>
            this.#publishReadiness(value, reason, generation),
          runtimeEvent: (type, detail, generation) =>
            this.#runtimeEvent(type, detail, generation),
          failure: (failure, fatal, generation) =>
            this.#publishFailure(failure, fatal, generation),
          metadataChanged: (metadata) => this.#publishMetadata(metadata),
          refreshInputs: () => this.#inputBinding.refresh(),
          disconnectInputs: () => this.#inputBinding.disconnect(),
          sendInput: (source) => this.#inputBinding.send(source),
          transitionEnded: () => this.#inputBinding.transitionEnded(),
          disposalStarted: () => this.#beginDisposal(),
          disposalCompleted: (sourceCompleted, pending) =>
            this.#completeDisposal(sourceCompleted, pending),
          cleanupObserved: (receipt) => this.#diagnostics.observeCleanup(receipt),
          stalePublicationCount: () =>
            this.#diagnostics.accounting().stalePublicationCount
        },
        presentation: {
          canvas: this.#layers.animatedCanvas,
          stylesSupported: () => this.#layers.stylesSupported,
          resetSource: (generation) => this.#layers.resetSource(generation),
          metadataChanged: (metadata) => this.#applyIntrinsic(metadata.canvas),
          reconcileMotionPreference: () =>
            this.#hostEnvironment.reconcileMotionPreference(),
          animatedDrawn: (generation) => {
            this.#layers.markAnimatedDrawn(generation);
            this.#layers.revealAnimated(generation);
          }
        },
        pageResources: {
          invalidateRequest: () => this.#pageResources.invalidateRequest(),
          claimDecoder: (generation) => this.#pageResources.claimDecoder(generation),
          setResourceBytes: (bytes) => this.#pageResources.setResourceBytes(bytes),
          animationResourcesRetired: (retain) =>
            this.#pageResources.animationResourcesRetired(retain),
          cancelDecoderTicket: () => this.#pageResources.cancelDecoderTicket(),
          setVisible: (visible) => this.#pageResources.setVisible(visible),
          releaseAll: () => this.#pageResources.releaseAll(),
          snapshot: () => this.#pageResources.snapshot()
        }
      });
      this.#attributes.upgrade(AVAL_UPGRADE_PROPERTIES);
      this.#applyIntrinsic();
    }

    public connectedCallback(): void {
      if (this.#runtime.finalDisposed) return;
      const wasConnected = this.getSnapshot().connected;
      const rootChanged = this.#hostEnvironment.rootChanged();
      if (rootChanged) {
        this.#inputBinding.realmChanged();
        this.#hostEnvironment.remove();
      }
      this.#commitPublicState({
        connected: true,
        effectivelyVisible: this.#hostEnvironment.snapshot().effectivelyVisible
      });
      if (!wasConnected) this.#diagnostics.recordLifecycle(
        "connect",
        Math.max(1, this.#runtime.sourceGeneration)
      );
      if (!this.#hostEnvironment.install()) return;
      if (rootChanged) this.#inputBinding.refresh();
      this.#runtime.connected(!wasConnected);
    }

    public disconnectedCallback(): void {
      queueMicrotask(() => {
        if (this.isConnected || this.#runtime.finalDisposed) return;
        this.#hostEnvironment.remove();
        this.#inputBinding.disconnect();
        this.#commitPublicState({
          connected: false,
          effectivelyVisible: this.#hostEnvironment.snapshot().effectivelyVisible
        });
        this.#diagnostics.recordLifecycle(
          "disconnect",
          Math.max(1, this.#runtime.sourceGeneration)
        );
        this.#runtime.disconnected();
      });
    }

    public adoptedCallback(): void {
      if (this.#runtime.finalDisposed) return;
      const adoption = this.#hostEnvironment.beginAdoption();
      this.#diagnostics.recordLifecycle(
        "adopt",
        Math.max(1, this.#runtime.sourceGeneration)
      );
      this.#commitPublicState({
        connected: this.isConnected,
        effectivelyVisible: this.#hostEnvironment.snapshot().effectivelyVisible
      });
      const retirement = this.#runtime.adopted();
      const finish = (): void => {
        if (
          adoption.current() && this.getSnapshot().connected && this.isConnected &&
          !this.#runtime.finalDisposed && this.#hostEnvironment.install()
        ) this.#runtime.connected(true);
      };
      void retirement.then(finish, finish);
    }

    public attributeChangedCallback(
      name: string,
      previous: string | null,
      next: string | null
    ): void {
      if (previous === next || this.#runtime.finalDisposed) return;
      if (this.#events.active) {
        this.#eventMutations.deferAttribute(
          name,
          () => this.getAttribute(name),
          (current) => {
            if (!this.#runtime.finalDisposed) this.#applyAttributeChange(name, current);
          }
        );
      } else this.#applyAttributeChange(name, next);
    }

    #applyAttributeChange(name: string, next: string | null): void {
      if (name === "crossorigin") this.#runtime.scheduleReload();
      else if (name === "motion") this.#runtime.motionChanged();
      else if (name === "state") {
        if (next !== null && !IDENTIFIER_PATTERN.test(next)) this.#runtime.publishFailure(
          "invalid-configuration",
          "state",
          false,
          Math.max(1, this.#runtime.sourceGeneration)
        );
        else if (next !== null && this.getSnapshot().connected) {
          this.#runtime.applyDeclarativeState(next);
        }
      } else if (name === "fit" || name === "width" || name === "height") {
        this.#applyIntrinsic();
        this.#runtime.resize(this.#hostEnvironment.measure());
      } else if (name === "bindings" || name === "interaction-for") {
        this.#inputBinding.refresh();
      } else if (name === "autoplay") this.#runtime.autoplayChanged();
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
      if (this.#runtime.finalDisposed) return;
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
    public get stateNames(): readonly string[] { return this.getSnapshot().stateNames; }
    public get eventNames(): readonly string[] { return this.getSnapshot().eventNames; }
    public get inputBindings(): readonly Readonly<Binding>[] {
      return this.getSnapshot().inputBindings;
    }
    public getSnapshot(): Readonly<AvalSnapshot> { return this.#snapshots.getSnapshot(); }
    public subscribe(listener: () => void): () => void {
      return this.#snapshots.subscribe(listener);
    }

    public prepare(
      options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}
    ): Promise<RuntimeReadinessResult> {
      if (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
        return Promise.reject(new RangeError("timeoutMs must be a positive integer"));
      }
      if (options.signal?.aborted) return Promise.reject(options.signal.reason);
      if (this.#runtime.finalDisposed) return Promise.reject(elementAbortError());
      const deferred = this.#eventMutations.deferCommandPromise(
        () => this.prepare(options)
      );
      if (deferred !== null) return deferred;
      const view = this.ownerDocument.defaultView;
      if (view === null) return Promise.reject(
        new AvalNotReadyError("AVAL owner window is unavailable")
      );
      return withElementOperationLimits(
        this.#runtime.prepare(),
        options.signal,
        options.timeoutMs,
        (kind) => this.#recordRuntimeDiagnostic({ kind }),
        createElementOperationTiming(view)
      );
    }

    public setState(name: string): Promise<void> {
      if (!IDENTIFIER_PATTERN.test(name)) {
        return Promise.reject(new TypeError("state must be an authored identifier"));
      }
      if (this.#runtime.finalDisposed) return Promise.reject(elementAbortError());
      const deferred = this.#eventMutations.deferCommandPromise(
        () => this.setState(name)
      );
      return deferred ?? this.#runtime.setState(name);
    }

    public send(event: string): boolean {
      return this.#events.active
        ? this.#runtime.deferSend(
            event,
            (operation) => this.#eventMutations.deferCommand(operation)
          )
        : this.#runtime.send(event);
    }

    public readyFor(state: string): boolean {
      return this.#events.active
        ? this.#runtime.peekReadyFor(state) : this.#runtime.readyFor(state);
    }

    public pause(): void {
      if (this.#runtime.finalDisposed) return;
      if (!this.#eventMutations.deferCommand(() => this.pause())) this.#runtime.pause();
    }

    public resume(): Promise<void> {
      if (this.#runtime.finalDisposed) return Promise.reject(elementAbortError());
      const deferred = this.#eventMutations.deferCommandPromise(() => this.resume());
      return deferred ?? this.#runtime.resume();
    }

    public getDiagnostics(
      options: Readonly<{ trace?: boolean }> = {}
    ): Readonly<AvalDiagnostics> {
      if (!this.#events.active) this.#runtime.flushSourceMutations();
      const trace = options.trace === true;
      const session = this.#runtime.snapshot(trace);
      this.#diagnostics.observeRuntime(session.runtime, this.#runtime.sourceGeneration);
      const host = this.#hostEnvironment.snapshot();
      const page = this.#pageResources.snapshot();
      return this.#diagnostics.snapshot({
        publicSnapshot: this.getSnapshot(),
        configuredMotion: this.motion,
        autoplay: this.autoplay,
        fit: this.fit,
        host,
        page,
        ownership: this.#ownershipSnapshot(
          this.#runtime.finalDisposed,
          session.pendingOperationCount
        ),
        session,
        trace
      });
    }

    public dispose(): Promise<void> {
      if (this.#deferredDispose !== null) return this.#deferredDispose;
      if (this.#events.active && !this.#runtime.hasDisposeOperation) {
        let resolve!: () => void;
        let reject!: (reason: unknown) => void;
        const deferred = new Promise<void>((accept, decline) => {
          resolve = accept;
          reject = decline;
        });
        if (this.#eventMutations.deferCommand(() => {
          try { void this.#runtime.dispose().then(resolve, reject); }
          catch (error) { reject(error); }
        })) {
          this.#deferredDispose = deferred;
          void deferred.catch(() => {
            if (this.#deferredDispose === deferred) this.#deferredDispose = null;
          });
          return deferred;
        }
      }
      return this.#runtime.dispose();
    }

    #commitPublicState(patch: Readonly<Partial<ElementSnapshotState>>): void {
      this.#events.transaction(true);
      try {
        this.#snapshots.transition((current) => ({ ...current, ...patch }));
      } finally { this.#events.transaction(false); }
    }

    #publishReadiness(
      value: RuntimeReadiness,
      reason: StaticReason | undefined,
      generation: number
    ): void {
      const from = this.readiness;
      if (value === "staticReady") this.#commitPublicState({
        readiness: value,
        mode: "static",
        assurance: null,
        staticReason: reason ?? null
      });
      else if (value === "interactiveReady" || value === "visualReady") {
        this.#commitPublicState({
          readiness: value,
          mode: "animated",
          assurance: "best-effort"
        });
      } else this.#commitPublicState({
        readiness: value,
        mode: null,
        assurance: null,
        staticReason: null
      });
      this.#dispatchReadinessChange(from, value, reason, generation);
    }

    #runtimeEvent(
      type: string,
      detail: Readonly<Record<string, unknown>>,
      generation: number
    ): void {
      this.#commitPublicState({
        ...(type === "requestedstatechange"
          ? { requestedState: String(detail.to) } : {}),
        ...(type === "visualstatechange"
          ? { visualState: String(detail.to) } : {}),
        isTransitioning: transitioningState(this.isTransitioning, type, detail)
      });
      this.#dispatch(type, detail, generation);
    }

    #publishFailure(
      failure: Readonly<AvalPublicFailure>,
      fatal: boolean,
      generation: number
    ): void {
      const lastError: Readonly<AvalErrorDetail> = Object.freeze({
        generation,
        failure,
        fatal
      });
      if (fatal) {
        const from = this.readiness;
        this.#commitPublicState({
          readiness: "error",
          mode: null,
          assurance: null,
          staticReason: null,
          lastError
        });
        this.#dispatchReadinessChange(from, "error", undefined, generation);
      } else this.#commitPublicState({ lastError });
      this.#dispatch("error", { failure, fatal }, generation);
    }

    #publishMetadata(metadata: Readonly<Metadata>): void {
      this.#commitPublicState({
        stateNames: metadata.stateNames,
        eventNames: metadata.eventNames,
        inputBindings: metadata.bindings
      });
    }

    #recordRuntimeDiagnostic(event: Readonly<ElementRuntimeDiagnosticEvent>): void {
      switch (event.kind) {
        case "prepare": this.#diagnostics.recordPrepare(); break;
        case "source-replacement": this.#diagnostics.recordSourceReplacement(); break;
        case "pause": this.#diagnostics.recordPause(); break;
        case "resume": this.#diagnostics.recordResume(); break;
        case "underflow": this.#diagnostics.recordUnderflow(); break;
        case "cleanup": this.#diagnostics.recordCleanup(); break;
        case "timer-started": this.#diagnostics.timerStarted(); break;
        case "timer-settled": this.#diagnostics.timerSettled(); break;
        case "stale-publication": this.#diagnostics.recordStalePublication(); break;
        case "source-started": this.#diagnostics.beginSource(
          event.generation,
          event.preservePlaybackLifecycle
        ); break;
        case "source-capacity": this.#diagnostics.configureSourceCapacity(
          event.generation,
          event.sourceCount
        ); break;
        case "runtime": this.#diagnostics.observeRuntime(
          event.snapshot,
          event.generation
        ); break;
        case "decoder": this.#diagnostics.observeDecoderDiagnostics(
          event.generation,
          event.diagnostics
        ); break;
        case "renderer": this.#diagnostics.observeRendererDiagnostics(
          event.generation,
          event.diagnostics
        ); break;
        case "retired-context": this.#diagnostics.observeRetiredContextRecoveries(
          event.generation,
          event.count
        ); break;
      }
    }

    #beginDisposal(): void {
      if (!this.#disposalObserved) {
        this.#disposalObserved = true;
        this.#diagnostics.recordLifecycle(
          "dispose",
          Math.max(1, this.#runtime.sourceGeneration)
        );
      }
      this.#hostEnvironment.remove();
      this.#inputBinding.close();
      this.#commitPublicState({
        connected: false,
        effectivelyVisible: this.#hostEnvironment.snapshot().effectivelyVisible
      });
    }

    #completeDisposal(sourceCompleted: boolean, sessionPending: number): boolean {
      const presentationCompleted = this.#layers.dispose();
      const from = this.readiness;
      this.#commitPublicState({ readiness: "disposed" });
      this.#dispatchReadinessChange(
        from,
        "disposed",
        undefined,
        Math.max(1, this.#runtime.sourceGeneration)
      );
      const terminal = createElementTerminalCleanupProof(
        sourceCompleted,
        presentationCompleted,
        this.#ownershipSnapshot(true, sessionPending)
      );
      this.#diagnostics.observeTerminalCleanup(terminal);
      if (terminal.completed) this.#eventMutations.close();
      return terminal.completed;
    }

    #ownershipSnapshot(terminal: boolean, sessionPending: number) {
      return createElementOwnershipSnapshot({
        terminal,
        input: this.#inputBinding.snapshot(),
        host: this.#hostEnvironment.snapshot(),
        deferredOperationCount: sessionPending +
          this.#eventMutations.pendingOperationCount,
        timerCount: this.#diagnostics.accounting().timerCount
      });
    }

    #hostVisibilityChanged(change: Readonly<ElementHostVisibilityChange>): void {
      const generation = Math.max(1, this.#runtime.sourceGeneration);
      if (change.reason === "pagehide") {
        this.#diagnostics.recordLifecycle("pagehide", generation);
      }
      if (change.reason !== "bfcache-restore") {
        this.#runtime.visibilityChanged(change.reason === "pagehide");
        return;
      }
      this.#commitPublicState({
        effectivelyVisible: this.#hostEnvironment.snapshot().effectivelyVisible
      });
      this.#diagnostics.recordLifecycle("bfcache-restore", generation);
      this.#runtime.restoreFromPageCache();
    }

    #applyIntrinsic(canvas = this.#runtime.metadata?.canvas): void {
      const width = this.width;
      const height = this.height;
      this.#layers.setIntrinsicSize({
        aspectRatio: intrinsicRatio(width, height, canvas),
        width,
        height
      });
    }

    #dispatchReadinessChange(
      from: RuntimeReadiness,
      value: RuntimeReadiness,
      reason: StaticReason | undefined,
      generation: number
    ): void {
      if (from === value) return;
      this.#dispatch("readinesschange", {
        from,
        to: value,
        ...(reason === undefined ? {} : { reason })
      } satisfies Omit<AvalReadinessChangeDetail, "generation">, generation);
    }

    #dispatch(
      type: string,
      detail: Readonly<Record<string, unknown>>,
      generation = this.#runtime.sourceGeneration
    ): void {
      if (generation < 1) return;
      this.#diagnostics.recordPublication(type, generation);
      try {
        this.#events.dispatch(this.#events.create(
          type,
          Object.freeze({ generation, ...detail })
        ));
      } catch { /* public observers cannot break runtime authority */ }
    }
  }

  return AvalElementImpl as unknown as AvalElementConstructor;
}
