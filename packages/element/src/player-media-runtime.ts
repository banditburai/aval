import type { GraphPresentation, MotionGraphSnapshot } from
  "@pixel-point/aval-graph";
import type { CompiledManifest as Manifest, Edge,
  ProductionRendition as Rendition, Unit } from "@pixel-point/aval-format";

import { Asset } from "./asset.js";
import { createCodecValidator, type CodecValidator } from
  "./codec-validator.js";
import type { DecodeRun, DecodeSample } from "./decoder.js";
import { ELEMENT_DECODER_CAPACITY } from "./decoder-capacity.js";
import { DecoderPool, type DecoderPoolCandidate,
  type DecoderPoolDiagnostic } from "./decoder-pool.js";
import type { PlayerDecoderDiagnostic, PlayerInput } from "./player-contract.js";
import type { PlayerCandidateDescriptor, PlayerMediaAcquisition,
  PlayerMediaContextEvent, PlayerMediaDrawFinalization,
  PlayerMediaDrawReceipt, PlayerMediaDrawResult, PlayerMediaLease,
  PlayerMediaRouteDecision, PlayerMediaRuntimePort,
  PlayerMediaSnapshot } from "./player-media-contract.js";
import { PlayerMediaFailure } from "./player-media-contract.js";
import { PlayerTelemetry } from "./player-telemetry.js";
import type { PreparationDeadline } from "./preparation-deadline.js";
import { playerResourceBytes, publishPlayerDecoderDiagnostics,
  publishPlayerRendererDiagnostics, reportCurrentPlayerResourceBytes } from
  "./player-media-observability.js";
import { createPlayerCandidateDescriptor, EMPTY_MEDIA_PRESENTATION,
  rendererPresentation } from "./player-media-descriptor.js";
import { PlayerMediaStreamOwner, type StreamReservation } from
  "./player-media-stream.js";
import { assertPlayerResourceBudget, assertRuntimeResourceBudget,
  checkedResourceTotal, encodedUnitCopyBytes, renditionRenderLayout } from
  "./player-resource-budget.js";
import { Renderer } from "./renderer.js";
import type { RendererContextChange } from "./renderer-contract.js";
import { RendererFailureError, type RendererFailureDiagnostic } from
  "./renderer-diagnostics.js";
import { createReadinessPlan, type ReadinessPlan } from "./readiness.js";
import { MAX_ROUTE_PREFETCH_INTENTS, planRoutePrefetch,
  routeWaitBlocksPresentation, RoutePrefetchQueue } from "./route-prefetch.js";
import { qualifyProvisionalOutput, withProvisionalCandidateFrame } from
  "./provisional-startup.js";

type State = Manifest["states"][number];

interface PlayerMediaRuntimeInput {
  readonly input: Readonly<PlayerInput>;
  readonly asset: Asset;
  readonly rendition: Readonly<Rendition>;
  readonly sourceIndex: number;
  readonly decoders: DecoderPool | null;
  readonly renderer: Renderer | null;
  readonly deadline: PreparationDeadline;
  readonly telemetry: PlayerTelemetry;
}

/** Sole owner of one candidate's concrete transport, decode, frame and render resources. */
export class PlayerMediaRuntime implements PlayerMediaRuntimePort {
  public readonly descriptor: Readonly<PlayerCandidateDescriptor>;
  readonly #input: Readonly<PlayerInput>;
  readonly #asset: Asset;
  readonly #manifest: Readonly<Manifest>;
  readonly #rendition: Readonly<Rendition>;
  readonly #sourceIndex: number;
  readonly #deadline: PreparationDeadline;
  readonly #telemetry: PlayerTelemetry;
  readonly #states: ReadonlyMap<string, State>;
  readonly #units: ReadonlyMap<string, Unit>;
  readonly #edges: readonly Readonly<Edge>[];
  readonly #edgesById: ReadonlyMap<string, Readonly<Edge>>;
  readonly #validator: CodecValidator;
  readonly #routePrefetch: RoutePrefetchQueue<DecoderPoolCandidate>;
  readonly #resident = new Map<string, Promise<void>>();
  readonly #residentReady = new Set<string>();
  readonly #residentFrames = new Map<string, Set<number>>();
  readonly #validated = new Set<string>();
  readonly #operations = new Set<Promise<unknown>>();
  #decoders: DecoderPool | null;
  #renderer: Renderer | null;
  #retiredRenderer: Renderer | null = null;
  #plan: Readonly<ReadinessPlan> | null = null;
  readonly #streams = new PlayerMediaStreamOwner();
  #contextObserver: ((event: PlayerMediaContextEvent) => void) | null = null;
  readonly #pendingContextEvents: PlayerMediaContextEvent[] = [];
  #resourcesRetired = false;
  #retiring = false;
  #retirement: Promise<void> | null = null;
  #generation = 0;
  #lastDraw = "";
  #retiredActiveUnit: string | null = null;
  #failureSettled = false;
  #graphDiagnostic: Readonly<{
    requestedState: string | null;
    visualState: string | null;
  }> = Object.freeze({ requestedState: null, visualState: null });
  #capturedPoolDiagnostics: readonly Readonly<DecoderPoolDiagnostic>[] =
    Object.freeze([]);
  readonly #decoderUnitByLane: [
    Readonly<{
      logicalRunId: number;
      unit: string;
      role: "foreground" | "candidate";
    }> | null,
    Readonly<{
      logicalRunId: number;
      unit: string;
      role: "foreground" | "candidate";
    }> | null
  ] = [null, null];
  #failure: Promise<never>;
  #rejectFailure!: (reason: unknown) => void;

  public constructor(input: Readonly<PlayerMediaRuntimeInput>) {
    this.#input = input.input;
    this.#asset = input.asset;
    this.#manifest = input.asset.manifest;
    this.#rendition = input.rendition;
    this.#sourceIndex = input.sourceIndex;
    this.#deadline = input.deadline;
    this.#telemetry = input.telemetry;
    this.#decoders = input.decoders;
    this.#renderer = input.renderer;
    this.#states = new Map(this.#manifest.states.map((state) => [state.id, state]));
    this.#units = new Map(this.#manifest.units.map((unit) => [unit.id, unit]));
    this.#edges = this.#manifest.edges;
    this.#edgesById = new Map(this.#edges.map((edge) => [edge.id, edge]));
    const layout = renditionRenderLayout(this.#manifest, this.#rendition);
    this.#validator = createCodecValidator({
      codec: this.#rendition.codec,
      bitDepth: this.#rendition.bitDepth,
      codedWidth: this.#rendition.codedWidth,
      codedHeight: this.#rendition.codedHeight,
      visibleWidth: layout.storageWidth,
      visibleHeight: layout.storageHeight,
      frameRate: this.#manifest.frameRate,
      averageBitrate: this.#rendition.bitrate.average
    });
    this.descriptor = createPlayerCandidateDescriptor(
      this.#manifest,
      this.#rendition,
      this.#sourceIndex,
      input.input.initialState ?? this.#manifest.initialState,
      input.input.initialBody
    );
    this.#failure = new Promise<never>((_resolve, reject) => {
      this.#rejectFailure = reject;
    });
    void this.#failure.catch(() => undefined);
    this.#routePrefetch = new RoutePrefetchQueue({
      signal: input.deadline.signal,
      preload: (unit, signal) => this.#preloadRun(unit, signal),
      admit: (unit) => this.#createLoadedRun(unit, "candidate"),
      canAdmit: () => this.#decoders?.candidateAvailable === true,
      onFailure: (error) => this.#reportFailure(error)
    });
    if (this.#decoders !== null) {
      void this.#decoders.failure().catch((error) => this.#reportFailure(error));
    }
  }

  public connectContextObserver(
    observer: (event: PlayerMediaContextEvent) => void
  ): void {
    if (this.#contextObserver !== null) {
      throw new Error("AVAL media context observer is already connected");
    }
    this.#contextObserver = observer;
    for (const event of this.#pendingContextEvents.splice(0)) observer(event);
  }

  public failure(): Promise<never> { return this.#failure; }

  public updateGraphDiagnostic(input: Readonly<{
    requestedState: string | null;
    visualState: string | null;
  }>): void {
    this.#graphDiagnostic = Object.freeze({ ...input });
  }

  public qualifyOutput(signal: AbortSignal): Promise<void> {
    return this.#track(this.#performOutputQualification(signal));
  }

  public prepare(input: Readonly<{
    initialState: string;
    initialBody: boolean;
    signal: AbortSignal;
  }>): Promise<void> {
    return this.#track(this.#performPreparation(input));
  }

  public routeDecision(
    snapshot: Readonly<MotionGraphSnapshot>
  ): Readonly<PlayerMediaRouteDecision> {
    const departure = this.#departure(snapshot);
    const ready = departure === null || this.#departureReady(departure);
    const unit = snapshot.presentation?.kind === "body"
      ? this.#unit(snapshot.presentation.unitId)
      : null;
    return Object.freeze({
      ready,
      blocksPresentation: !ready && routeWaitBlocksPresentation(
        snapshot.presentation,
        departure,
        unit
      )
    });
  }

  public prepareRoutes(
    snapshot: Readonly<MotionGraphSnapshot>,
    required?: Readonly<GraphPresentation>
  ): void {
    if (this.#retiring || this.#failureSettled) return;
    const active = this.#streams.activeDescriptor();
    const pending = this.#edge(snapshot.pendingEdgeId);
    const plan = planRoutePrefetch(
      this.#manifest,
      snapshot,
      active,
      ELEMENT_DECODER_CAPACITY.ringSize,
      pending !== null && this.#departureReady(pending)
    );
    for (const unit of plan.resident) void this.#ensureResident(unit);
    const requiredUnit = required === undefined
      ? null : this.#streams.requiredUnit(
          required,
          this.#lastDraw,
          (id) => this.#unit(id)
        );
    if (requiredUnit === null) {
      this.#routePrefetch.reconcile(plan.decode);
      return;
    }
    const planned = plan.decode.find(({ unit }) => unit.id === requiredUnit.id);
    const priority = planned ?? Object.freeze({
      unit: requiredUnit,
      reason: "presentation-continuation" as const
    });
    this.#routePrefetch.reconcile([
      priority,
      ...plan.decode.filter(({ unit }) => unit.id !== requiredUnit.id)
    ].slice(0, MAX_ROUTE_PREFETCH_INTENTS));
  }

  public edgeReady(edgeId: string): boolean {
    const edge = this.#edge(edgeId);
    return edge !== null && this.#departureReady(edge);
  }

  public acquirePresentation(
    presentation: Readonly<GraphPresentation>
  ): Readonly<PlayerMediaAcquisition> {
    this.#routePrefetch.wake();
    const unit = this.#streams.requiredUnit(
      presentation,
      this.#lastDraw,
      (id) => this.#unit(id)
    );
    if (unit === null) return Object.freeze({ kind: "ready", lease: null });
    if (this.#streams.initialUnitId !== unit.id &&
      !this.#routePrefetch.isReady(unit.id)) {
      return Object.freeze({ kind: "waiting" });
    }
    const candidate = this.#streams.initialUnitId === unit.id
      ? null : this.#routePrefetch.claim(unit.id) ?? null;
    return Object.freeze({
      kind: "ready",
      lease: this.#streams.acquire(unit, candidate)
    });
  }

  public cancelPresentation(lease: PlayerMediaLease | null): void {
    this.#streams.cancel(lease);
  }

  public draw(input: Readonly<{
    presentation: Readonly<GraphPresentation>;
    lease: PlayerMediaLease | null;
  }>): Promise<Readonly<PlayerMediaDrawResult>> {
    let reservation: StreamReservation | null;
    try { reservation = this.#streams.reservation(input.lease); }
    catch (error) { return Promise.reject(error); }
    const operation = this.#performDraw(input.presentation, reservation);
    return this.#track(operation).then(({ receipt, release }) => {
      try {
        return Object.freeze({
          receipt,
          finalization: this.#streams.holdFinalization(input.lease, release)
        });
      } catch (error) {
        release();
        throw error;
      }
    });
  }

  public finalizeDraw(
    finalization: Readonly<PlayerMediaDrawFinalization>
  ): void {
    this.#streams.finalize(finalization);
  }

  public resize(input: Readonly<{
    width: number;
    height: number;
    dpr: number;
    fit: string;
  }>): void {
    const renderer = this.#renderer;
    if (renderer === null) return;
    try {
      renderer.resize(input.width, input.height, input.dpr, input.fit);
      this.#reportResourceBytes();
    } catch (error) {
      if (error instanceof RendererFailureError) {
        this.#captureRendererDiagnostic(error.diagnostic);
      }
      this.#reportFailure(error, "resize");
    }
  }

  public snapshot(): Readonly<PlayerMediaSnapshot> {
    const asset = this.#asset.snapshot();
    const decoders = this.#decoders?.snapshot();
    this.#telemetry.captureDecoderLifecycle(decoders?.playbackLifecycle);
    this.#captureDecoderDiagnostics(
      decoders?.decoderDiagnostics ?? Object.freeze([])
    );
    const renderer = this.#renderer ?? this.#retiredRenderer;
    const rendererSnapshot = renderer?.snapshot();
    this.#captureRendererDiagnostic(rendererSnapshot?.failure ?? null);
    return Object.freeze({
      transportMode: asset.mode,
      declaredFileBytes: asset.declaredFileBytes,
      metadataBytes: asset.metadataBytes,
      verifiedBytes: asset.verifiedBytes,
      residentBlobBytes: asset.residentBlobBytes,
      activeTransportBodies: asset.activeTransportBodies,
      pendingLoads: asset.pendingLoads,
      interestedWaiters: asset.interestedWaiters,
      workerCount: decoders?.workerCount ?? 0,
      openFrames: decoders?.openFrames ?? 0,
      rendererBackend: rendererSnapshot?.backendDetails.kind ?? null,
      presentation: rendererSnapshot === undefined
        ? EMPTY_MEDIA_PRESENTATION
        : rendererPresentation(rendererSnapshot),
      contextLossCount: rendererSnapshot?.contextLossCount ?? 0,
      contextRecoveryCount: rendererSnapshot?.contextRecoveryCount ?? 0
    });
  }

  public async settled(): Promise<void> {
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
    await Promise.allSettled([
      ...this.#resident.values(),
      this.#routePrefetch.settled(),
      this.#streams.settled()
    ]);
    await (this.#renderer ?? this.#retiredRenderer)?.settled();
  }

  public contextChanged(change: Readonly<RendererContextChange>): void {
    if (change.state === "error") {
      this.#captureRendererDiagnostic(change.error.diagnostic);
      this.#reportFailure(change.error);
      return;
    }
    const event = Object.freeze({ state: change.state }) satisfies
      PlayerMediaContextEvent;
    if (this.#contextObserver === null) this.#pendingContextEvents.push(event);
    else this.#contextObserver(event);
  }

  public retire(): Promise<void> {
    if (this.#resourcesRetired) return Promise.resolve();
    if (this.#retirement !== null) return this.#retirement;
    const operation = this.#performRetirement();
    this.#retirement = operation;
    void operation.finally(() => {
      if (this.#retirement === operation) this.#retirement = null;
    }).catch(() => undefined);
    return operation;
  }

  async #performOutputQualification(signal: AbortSignal): Promise<void> {
    const { decoders, renderer, generation } = this.#animation();
    await qualifyProvisionalOutput({
      manifest: this.#manifest,
      renditionId: this.#rendition.id,
      layout: renditionRenderLayout(this.#manifest, this.#rendition),
      withDecodedFrame: async (unitId, localFrame, use) => {
        const unit = this.#unit(unitId);
        await this.#preloadRun(unit, signal);
        this.#assertActive(generation, renderer, decoders);
        const candidate = this.#createLoadedRun(unit, "candidate");
        await withProvisionalCandidateFrame({
          candidate,
          localFrame,
          signal,
          use: async (frame) => {
            this.#assertActive(generation, renderer, decoders);
            await use(frame);
            this.#assertActive(generation, renderer, decoders);
          }
        });
      },
      inspectAndPrime: (frame, inspect) =>
        renderer.inspectAndPrime(frame, inspect)
    });
  }

  async #performPreparation(input: Readonly<{
    initialState: string;
    initialBody: boolean;
    signal: AbortSignal;
  }>): Promise<void> {
    const { decoders, renderer, generation } = this.#animation();
    const plan = createReadinessPlan(
      this.#manifest,
      this.#rendition.id,
      this.#asset.blobs
    );
    this.#plan = plan;
    for (const resident of plan.resident) {
      input.signal.throwIfAborted();
      const unit = this.#unit(resident.unit);
      await this.#cacheResidentFrames(unit, new Set(resident.frames), input.signal);
      this.#assertActive(generation, renderer, decoders);
      if (unit.kind === "reversible") this.#residentReady.add(unit.id);
      this.#reportResourceBytes();
    }
    const state = this.#state(input.initialState);
    const initial = this.#unit(
      input.initialBody || state.initialUnit === undefined
        ? state.bodyUnit : state.initialUnit
    );
    const run = await this.#newRun(initial, input.signal);
    try {
      await run.ready();
      this.#assertActive(generation, renderer, decoders);
      this.#assertRuntimeBudget();
      this.#streams.installInitial(initial, run);
    } catch (error) {
      run.close();
      throw error;
    }
  }

  async #cacheResidentFrames(
    unit: Unit,
    keep: ReadonlySet<number>,
    signal: AbortSignal
  ): Promise<void> {
    const { decoders, renderer, generation } = this.#animation();
    const run = await this.#newRun(unit, signal);
    this.#assertActive(generation, renderer, decoders);
    let qualifiesRun = true;
    try {
      for (let index = 0; index < run.frameCount; index += 1) {
        signal.throwIfAborted();
        const frame = await run.take(index);
        this.#assertActive(generation, renderer, decoders);
        try {
          if (keep.has(index) && !this.#hasResident(unit.id, index)) {
            await renderer.store(unit.id, index, frame, qualifiesRun);
            this.#assertActive(generation, renderer, decoders);
            qualifiesRun = false;
            this.#reportResourceBytes();
            const frames = this.#residentFrames.get(unit.id) ?? new Set<number>();
            frames.add(index);
            this.#residentFrames.set(unit.id, frames);
          }
        } finally { this.#release(run, frame); }
      }
      await run.complete();
      this.#assertActive(generation, renderer, decoders);
    } finally { run.close(); }
  }

  #ensureResident(unit: Unit): Promise<void> {
    if (this.#residentReady.has(unit.id)) return Promise.resolve();
    const existing = this.#resident.get(unit.id);
    if (existing !== undefined) return existing;
    const operation = this.#track((async () => {
      const { decoders, renderer, generation } = this.#animation();
      const run = await this.#newRun(unit, this.#deadline.signal);
      this.#assertActive(generation, renderer, decoders);
      let qualifiesRun = true;
      try {
        for (let index = 0; index < unit.frameCount; index += 1) {
          this.#deadline.signal.throwIfAborted();
          const frame = await run.take(index);
          this.#assertActive(generation, renderer, decoders);
          try {
            if (!this.#hasResident(unit.id, index)) {
              await renderer.store(unit.id, index, frame, qualifiesRun);
              this.#assertActive(generation, renderer, decoders);
              qualifiesRun = false;
              this.#reportResourceBytes();
              const frames = this.#residentFrames.get(unit.id) ?? new Set<number>();
              frames.add(index);
              this.#residentFrames.set(unit.id, frames);
            }
          } finally { this.#release(run, frame); }
        }
        await run.complete();
        this.#assertActive(generation, renderer, decoders);
        this.#residentReady.add(unit.id);
      } finally { run.close(); }
    })());
    this.#resident.set(unit.id, operation);
    void operation.catch((error) => this.#reportFailure(error));
    return operation;
  }

  async #performDraw(
    presentation: Readonly<GraphPresentation>,
    replacement: StreamReservation | null
  ): Promise<Readonly<{
    receipt: Readonly<PlayerMediaDrawReceipt>;
    release: () => void;
  }>> {
    if (presentation.kind === "static") {
      if (replacement !== null) throw new Error("Invalid AVAL stream replacement");
      return Object.freeze({ receipt: emptyDrawReceipt(), release: noop });
    }
    const { decoders, renderer, generation } = this.#animation();
    const key = `${presentation.kind}\0${presentation.unitId}\0${String(presentation.frameIndex)}`;
    if (key === this.#lastDraw) {
      if (replacement !== null) throw new Error("Invalid AVAL stream replacement");
      return Object.freeze({
        receipt: this.#drawReceipt(false, presentation),
        release: noop
      });
    }
    const unit = this.#unit(presentation.unitId);
    let release = noop;
    try {
      if (presentation.kind === "reversible") {
        if (replacement !== null) {
          throw new Error("Invalid AVAL stream replacement");
        }
        await this.#ensureResident(unit);
        this.#assertActive(generation, renderer, decoders);
        await renderer.drawStored(unit.id, presentation.frameIndex);
        this.#assertActive(generation, renderer, decoders);
        const resident = this.#streams.activateResident(unit);
        this.#streams.markStoredFrame(resident, presentation.frameIndex);
      } else {
        const active = this.#streams.streamFor(
          unit,
          presentation.frameIndex,
          replacement
        );
        if (this.#hasResident(unit.id, presentation.frameIndex)) {
          await renderer.drawStored(unit.id, presentation.frameIndex);
          this.#assertActive(generation, renderer, decoders);
          this.#streams.markStoredFrame(active, presentation.frameIndex);
        } else {
          release = await this.#streams.drawStreamFrame(
            active,
            presentation.frameIndex,
            async (frame, qualifiesRun) => {
              this.#assertActive(generation, renderer, decoders);
              await renderer.draw(frame, qualifiesRun);
              this.#assertActive(generation, renderer, decoders);
            },
            (run, frame) => this.#release(run, frame)
          );
          this.#assertActive(generation, renderer, decoders);
        }
        this.#streams.commitStream(active, replacement, (candidate) => {
          this.#rememberDecoderUnit(
            candidate.run,
            candidate.unitId,
            "foreground"
          );
        });
        if (this.#hasResident(unit.id, presentation.frameIndex)) {
          const drain = this.#track(this.#streams.drainStoredStream(
            active,
            presentation.frameIndex,
            (run, frame) => this.#release(run, frame)
          ));
          void drain.catch((error) => this.#reportFailure(error));
        }
      }
      this.#assertActive(generation, renderer, decoders);
      this.#lastDraw = key;
      this.#telemetry.recordDraw();
      this.#input.onDraw();
      return Object.freeze({
        receipt: this.#drawReceipt(true, presentation),
        release
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  #drawReceipt(
    drew: boolean,
    presentation: Exclude<Readonly<GraphPresentation>, { readonly kind: "static" }>
  ): Readonly<PlayerMediaDrawReceipt> {
    const unitId = this.#streams.activeUnitId;
    if (unitId === null) throw new Error("Invalid AVAL media state");
    const run = this.#streams.activeRun();
    const logicalRunId = run !== null && this.#decoders !== null
      ? this.#decoders.identity(run).logicalId : null;
    return Object.freeze({
      drew,
      unitId,
      localFrame: presentation.frameIndex,
      logicalRunId,
      openFrames: this.#decoders?.snapshot().openFrames ?? 0,
      readbackTag: `${presentation.kind}:${unitId}:${String(presentation.frameIndex)}`
    });
  }

  #departure(snapshot: Readonly<MotionGraphSnapshot>): Readonly<Edge> | null {
    const pending = this.#edge(snapshot.pendingEdgeId);
    if (pending !== null) return pending;
    const presentation = snapshot.presentation;
    if (snapshot.phase !== "stable" || presentation?.kind !== "body") return null;
    const unit = this.#unit(presentation.unitId);
    if (presentation.frameIndex !== unit.frameCount - 1) return null;
    return this.#edges.find((edge) =>
      edge.from === presentation.state && edge.trigger?.type === "completion"
    ) ?? null;
  }

  #departureReady(edge: Readonly<Edge>): boolean {
    if (edge.start.type === "cut") {
      const route = this.#plan?.routes.find(({ edge: id }) => id === edge.id);
      if (route === undefined || !route.targetFrames.every((frame) =>
        this.#hasResident(route.targetUnit, frame))) return false;
      return edge.transition?.kind === "reversible"
        ? this.#residentReady.has(edge.transition.unit)
        : this.#routePrefetch.isReady(edge.transition?.unit ?? route.targetUnit);
    }
    if (edge.transition?.kind === "reversible") {
      return this.#residentReady.has(edge.transition.unit);
    }
    return this.#routePrefetch.isReady(
      edge.transition?.unit ?? this.#state(edge.to).bodyUnit
    );
  }

  async #newRun(unit: Unit, signal: AbortSignal): Promise<DecodeRun> {
    await this.#preloadRun(unit, signal);
    signal.throwIfAborted();
    return this.#createLoadedRun(unit, "foreground");
  }

  async #preloadRun(unit: Unit, signal: AbortSignal): Promise<void> {
    if (this.#decoders === null) throw new Error("AVAL decoder is unavailable");
    this.#unitSpan(unit);
    await this.#asset.unitBytes(this.#rendition.id, unit.id, signal);
    signal.throwIfAborted();
    this.#reportResourceBytes();
  }

  #createLoadedRun(unit: Unit, role: "foreground"): DecodeRun;
  #createLoadedRun(unit: Unit, role: "candidate"): DecoderPoolCandidate;
  #createLoadedRun(
    unit: Unit,
    role: "foreground" | "candidate"
  ): DecodeRun | DecoderPoolCandidate {
    const decoders = this.#decoders;
    if (decoders === null) throw new Error("AVAL decoder is unavailable");
    const span = this.#unitSpan(unit);
    const copyBytes = encodedUnitCopyBytes(this.#asset.records, span);
    assertPlayerResourceBudget(playerResourceBytes(
      this.#asset,
      checkedResourceTotal([
        decoders.snapshot().openFrameBytes,
        decoders.encodedBytes,
        copyBytes
      ]),
      this.#renderer
    ));
    const samples: DecodeSample[] = [];
    for (let index = 0; index < span.chunkCount; index += 1) {
      const record = this.#asset.records[span.chunkStart + index];
      if (record === undefined) throw new Error("Invalid AVAL asset");
      samples.push({
        data: this.#asset.chunkBytes(this.#rendition.id, unit.id, index),
        timestamp: record.presentationTimestamp,
        duration: record.duration,
        key: record.randomAccess,
        displayedFrames: record.displayedFrameCount
      });
    }
    if (!this.#validated.has(unit.id)) {
      this.#validator.validate(samples.map((sample) => ({
        bytes: new Uint8Array(sample.data),
        timestamp: sample.timestamp,
        key: sample.key,
        displayedFrames: sample.displayedFrames
      })));
      this.#validated.add(unit.id);
      if (this.#validated.size === this.#units.size) this.#validator.complete();
    }
    if (role === "foreground") {
      const run = decoders.createForegroundRun(samples);
      this.#rememberDecoderUnit(run, unit.id, role);
      this.#reportResourceBytes();
      if (run.frameCount !== unit.frameCount) {
        run.close();
        throw new Error("Invalid AVAL asset");
      }
      return run;
    }
    const candidate = decoders.createCandidate(unit.id, samples);
    this.#rememberDecoderUnit(candidate.run, unit.id, role);
    this.#reportResourceBytes();
    if (candidate.run.frameCount !== unit.frameCount) {
      candidate.cancel();
      throw new Error("Invalid AVAL asset");
    }
    return candidate;
  }

  #unitSpan(unit: Unit): Unit["chunks"][number] {
    const span = unit.chunks.find(({ rendition }) =>
      rendition === this.#rendition.id
    );
    if (span === undefined) throw new Error("Invalid AVAL asset");
    return span;
  }

  #rememberDecoderUnit(
    run: DecodeRun,
    unit: string,
    role: "foreground" | "candidate"
  ): void {
    const decoders = this.#decoders;
    if (decoders === null) return;
    const { lane, logicalId } = decoders.identity(run);
    this.#decoderUnitByLane[lane] = Object.freeze({
      logicalRunId: logicalId,
      unit,
      role
    });
  }

  #assertRuntimeBudget(): void {
    const asset = this.#asset.snapshot();
    const renderer = this.#renderer?.snapshot();
    if (renderer === undefined) throw new Error("AVAL renderer is unavailable");
    const decoders = this.#decoders?.snapshot();
    assertRuntimeResourceBudget({
      manifest: this.#manifest,
      rendition: this.#rendition,
      unitBlobs: this.#asset.blobs,
      metadataBytes: asset.metadataBytes,
      residentBlobBytes: asset.residentBlobBytes,
      decoderOpenFrameBytes: decoders?.openFrameBytes ?? 0,
      rendererRuntimeBytes: renderer.runtimeBytes
    });
  }

  #reportResourceBytes(): void {
    reportCurrentPlayerResourceBytes(
      this.#input,
      this.#asset,
      checkedResourceTotal([
        this.#decoders?.snapshot().openFrameBytes ?? 0,
        this.#decoders?.encodedBytes ?? 0
      ]),
      this.#renderer,
      true
    );
  }

  #release(run: DecodeRun, frame: VideoFrame): void {
    run.release(frame);
    this.#telemetry.recordCleanedFrame();
  }

  #captureDecoderDiagnostics(
    diagnostics: readonly Readonly<DecoderPoolDiagnostic>[]
  ): void {
    if (diagnostics === this.#capturedPoolDiagnostics) return;
    this.#capturedPoolDiagnostics = diagnostics;
    if (diagnostics.length === 0) return;
    this.#telemetry.captureDecoderDiagnostics(publishPlayerDecoderDiagnostics(
      this.#input,
      diagnostics,
      this.#sourceIndex,
      this.#rendition,
      (diagnostic) => {
        const current = this.#decoderUnitByLane[diagnostic.lane];
        return current?.logicalRunId === diagnostic.logicalRunId
          ? current.unit : null;
      },
      this.#decoderGraphDiagnostic()
    ));
  }

  #decoderGraphDiagnostic(): Readonly<PlayerDecoderDiagnostic["graph"]> {
    const pending = this.#decoderUnitByLane.find((entry) =>
      entry?.role === "candidate"
    );
    return Object.freeze({
      ...this.#graphDiagnostic,
      activeUnit: this.#streams.activeUnitId ?? this.#streams.initialUnitId ??
        this.#retiredActiveUnit,
      pendingUnit: pending?.unit ?? null
    });
  }

  #captureRendererDiagnostic(
    diagnostic: Readonly<RendererFailureDiagnostic> | null
  ): void {
    if (diagnostic === null ||
      this.#telemetry.snapshot(false).rendererDiagnostics.length > 0) return;
    this.#telemetry.captureRendererDiagnostics(publishPlayerRendererDiagnostics(
      this.#input,
      Object.freeze([diagnostic]),
      this.#sourceIndex,
      this.#rendition
    ));
  }

  #reportFailure(reason: unknown, operation = "playback"): void {
    if (this.#failureSettled || isAbort(reason) && (
      this.#retiring || this.#deadline.signal.aborted
    )) return;
    this.#failureSettled = true;
    if (reason instanceof RendererFailureError) {
      this.#captureRendererDiagnostic(reason.diagnostic);
    }
    this.#rejectFailure(new PlayerMediaFailure(reason, operation));
  }

  #animation(): Readonly<{
    decoders: DecoderPool;
    renderer: Renderer;
    generation: number;
  }> {
    const decoders = this.#decoders;
    const renderer = this.#renderer;
    if (decoders === null || renderer === null) {
      throw new Error("AVAL animation resources are unavailable");
    }
    return Object.freeze({ decoders, renderer, generation: this.#generation });
  }

  #assertActive(
    generation: number,
    renderer: Renderer,
    decoders: DecoderPool
  ): void {
    if (this.#retiring || this.#failureSettled ||
      this.#generation !== generation || this.#renderer !== renderer ||
      this.#decoders !== decoders) throw abortException();
  }

  #state(id: string): State {
    const state = this.#states.get(id);
    if (state === undefined) throw new Error("Invalid AVAL graph");
    return state;
  }

  #unit(id: string): Unit {
    const unit = this.#units.get(id);
    if (unit === undefined) throw new Error("Invalid AVAL graph");
    return unit;
  }

  #edge(id: string | null): Readonly<Edge> | null {
    if (id === null) return null;
    const edge = this.#edgesById.get(id);
    if (edge === undefined) throw new Error("Invalid AVAL graph");
    return edge;
  }

  #hasResident(unit: string, frame: number): boolean {
    return this.#residentFrames.get(unit)?.has(frame) === true;
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    void operation.finally(() => this.#operations.delete(operation))
      .catch(() => undefined);
    return operation;
  }

  async #performRetirement(): Promise<void> {
    if (!this.#retiring) {
      this.#retiring = true;
      this.#generation += 1;
      this.#deadline.cancel(abortException());
      this.#retiredActiveUnit = this.#streams.activeUnitId ??
        this.#streams.initialUnitId;
    }
    const streamed = this.#streams.retire();
    const prefetched = this.#routePrefetch.retire();
    const renderer = this.#renderer;
    const [, cleanupSettlements] = await Promise.all([
      Promise.allSettled([
        ...this.#operations,
        ...this.#resident.values()
      ]),
      Promise.allSettled([
        streamed,
        prefetched,
        ...(renderer === null ? [] : [renderer.settled()])
      ])
    ]);
    if (renderer !== null) {
      this.#captureRendererDiagnostic(renderer.snapshot().failure);
    }
    const decoders = this.#decoders;
    if (decoders !== null) {
      const snapshot = decoders.snapshot();
      this.#captureDecoderDiagnostics(snapshot.decoderDiagnostics);
      this.#telemetry.captureDecoderLifecycle(snapshot.playbackLifecycle);
      decoders.dispose();
    }
    this.#decoders = null;
    renderer?.dispose();
    this.#renderer = null;
    if (renderer !== null) this.#retiredRenderer = renderer;
    this.#resident.clear();
    this.#residentReady.clear();
    this.#residentFrames.clear();
    await this.#asset.dispose();
    reportCurrentPlayerResourceBytes(this.#input, null);
    this.#input.onAnimationResourcesRetired();
    this.#resourcesRetired = true;
    const cleanupFailure = cleanupSettlements.find((result) =>
      result.status === "rejected"
    );
    if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
  }
}

function emptyDrawReceipt(): Readonly<PlayerMediaDrawReceipt> {
  return Object.freeze({
    drew: false,
    unitId: null,
    localFrame: null,
    logicalRunId: null,
    openFrames: 0,
    readbackTag: "static"
  });
}

function noop(): void {}

function abortException(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError" ||
    reason instanceof Error && reason.name === "AbortError";
}
