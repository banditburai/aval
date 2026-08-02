import type {
  GraphPresentation,
  MotionGraphDefinition,
  MotionGraphSnapshot
} from "@pixel-point/aval-graph";
import { describe, expect, it } from "vitest";

import { AvalPlaybackError } from "../src/errors.js";
import type { Metadata, PlayerInput } from "../src/player-contract.js";
import type {
  PlayerMediaAcquisition,
  PlayerMediaContextEvent,
  PlayerMediaDrawFinalization,
  PlayerMediaDrawReceipt,
  PlayerMediaDrawResult,
  PlayerMediaLease,
  PlayerMediaRouteDecision,
  PlayerMediaRuntimePort,
  PlayerMediaSnapshot
} from "../src/player-media-contract.js";
import { PublicationGate } from "../src/player-publication-gate.js";
import type { PlayerSessionHost } from "../src/player-session-contract.js";
import { PlayerSession } from "../src/player-session.js";
import { PlayerTelemetry } from "../src/player-telemetry.js";
import { PreparationDeadline } from "../src/preparation-deadline.js";

describe("PlayerSession ownership", () => {
  it("coordinates one animated session without owning concrete media", async () => {
    const publications: string[] = [];
    const input = playerInput(publications);
    const publicationGate = new PublicationGate(input);
    const media = new TestMediaRuntime();
    const session = new PlayerSession(Object.freeze({
      candidate: Object.freeze({
        staticReason: null,
        candidateReports: Object.freeze([]),
        candidateRank: 0
      }),
      host: sessionHost(publicationGate.input),
      publications: publicationGate,
      preparationDeadline: PreparationDeadline.begin({
        parent: input.signal,
        timeoutMs: input.preparationTimeoutMs,
        platform: input.platform
      }),
      media,
      telemetry: new PlayerTelemetry()
    }));

    session.activate({ publish: false });
    session.completeCandidateInstallation();
    const result = await session.prepare();

    expect(result).toEqual(expect.objectContaining({
      mode: "animated",
      report: expect.objectContaining({
        readiness: "interactiveReady",
        selectedRendition: "main"
      })
    }));
    expect(publications).toEqual([]);
    expect(media.operations).toEqual([
      "graph:idle/idle",
      "qualify",
      "prepare:idle",
      "acquire:idle-body@0",
      "draw:idle-body@0",
      "graph:idle/idle",
      "finalize",
      "routes:idle"
    ]);

    session.publish();

    expect(publications).toEqual([
      "metadata:idle",
      "readiness:metadataReady",
      "event:requestedstatechange",
      "event:visualstatechange",
      "readiness:visualReady",
      "readiness:interactiveReady"
    ]);
    expect(session.snapshot(true)).toEqual(expect.objectContaining({
      requestedState: "idle",
      visualState: "idle",
      selectedRendition: "main",
      selectedCodec: "av1",
      selectedBitDepth: 8,
      trace: expect.arrayContaining([
        expect.objectContaining({ media: expect.objectContaining({
          frame: expect.objectContaining({
            unit: "idle-body",
            localFrame: 0
          })
        }) })
      ])
    }));

    await session.dispose();
    await session.dispose();

    expect(media.retirements).toBe(1);
  });

  it("settles a state command only after drawing and publishing its effects", async () => {
    const operations: string[] = [];
    const timing = new ControlledTiming();
    const input = playerInput([], {
      platform: timingPlatform(timing),
      visible: true,
      onEvent: (type) => operations.push(`event:${type}`)
    });
    const media = new TestMediaRuntime({ graph: LOOP_GRAPH, operations });
    const session = createSession(input, media);
    session.activate();
    session.completeCandidateInstallation();
    await session.prepare();
    operations.length = 0;

    expect(session.canSend("hover")).toBe(true);
    expect(session.canSend("unknown")).toBe(false);
    expect(session.readyFor("hover")).toBe(true);
    await expect(session.setState("missing")).rejects.toThrow("Unknown AVAL state");

    const stateChange = session.setState("hover");
    await flushMicrotasks();
    timing.fireNextAnimationFrame(16);
    await stateChange;

    const draw = operations.findIndex((value) =>
      value.startsWith("draw:hover-body@")
    );
    const visualEffect = operations.indexOf("event:visualstatechange");
    const finalization = operations.indexOf("finalize", draw);
    expect(draw).toBeGreaterThan(-1);
    expect(visualEffect).toBeGreaterThan(draw);
    expect(finalization).toBeGreaterThan(visualEffect);
    expect(operations).toContain("event:transitionstart");
    expect(operations).toContain("event:transitionend");
    expect(session.snapshot(false)).toEqual(expect.objectContaining({
      requestedState: "hover",
      visualState: "hover",
      transitioning: false
    }));

    await session.dispose();
  });

  it("finalizes a draw when post-draw publication fails without masking it", async () => {
    const operations: string[] = [];
    const playbackFailures: string[] = [];
    const timing = new ControlledTiming();
    const canonicalFailure = new AvalPlaybackError(Object.freeze({
      code: "worker-decode-failure",
      message: "canonical playback failure",
      operation: "playback"
    }), 1);
    let failPublication = false;
    const input = playerInput([], {
      platform: timingPlatform(timing),
      visible: true,
      onEvent: (type) => {
        operations.push(`event:${type}`);
        if (failPublication && type === "visualstatechange") {
          throw new Error("publication failed");
        }
      },
      onPlaybackFailure: (code, operation) => {
        playbackFailures.push(`${code}:${operation}`);
        return canonicalFailure;
      }
    });
    const media = new TestMediaRuntime({
      graph: LOOP_GRAPH,
      operations,
      failFinalizeAt: 2
    });
    const session = createSession(input, media);
    session.activate();
    session.completeCandidateInstallation();
    await session.prepare();
    operations.length = 0;
    failPublication = true;

    const stateChange = session.setState("hover");
    await flushMicrotasks();
    timing.fireNextAnimationFrame(16);
    await flushMicrotasks();
    await expect(stateChange).rejects.toBe(canonicalFailure);
    await session.settled();

    const draw = operations.findIndex((value) =>
      value.startsWith("draw:hover-body@")
    );
    const failedEffect = operations.indexOf("event:visualstatechange");
    const finalization = operations.indexOf("finalize", draw);
    expect(draw).toBeGreaterThan(-1);
    expect(failedEffect).toBeGreaterThan(draw);
    expect(finalization).toBeGreaterThan(failedEffect);
    expect(operations).not.toContain("cancel");
    expect(playbackFailures).toEqual(["worker-decode-failure:playback"]);
    expect(session.snapshot(false).cleanupFailureCount).toBe(1);

    await session.dispose();
  });

  it("invalidates stale animation callbacks across pause and visibility", async () => {
    const timing = new ControlledTiming();
    const input = playerInput([], {
      platform: timingPlatform(timing),
      visible: true
    });
    const media = new TestMediaRuntime({ graph: LOOP_GRAPH });
    const session = createSession(input, media);
    session.activate();
    session.completeCandidateInstallation();
    await session.prepare();
    const initialDraws = drawCount(media.operations);

    const pausedCallback = timing.captureNextAnimationFrame();
    session.pause();
    await session.resume();
    expect(timing.pendingAnimationFrames).toBe(1);
    pausedCallback(16);
    await flushMicrotasks();
    expect(drawCount(media.operations)).toBe(initialDraws);
    session.setVisibility(true);
    expect(timing.pendingAnimationFrames).toBe(1);

    const hiddenCallback = timing.captureNextAnimationFrame();
    session.setVisibility(false);
    expect(timing.pendingAnimationFrames).toBe(0);
    hiddenCallback(32);
    await flushMicrotasks();
    expect(drawCount(media.operations)).toBe(initialDraws);

    session.setVisibility(true);
    expect(() => timing.captureNextAnimationFrame()).not.toThrow();
    expect(timing.cancelledAnimationFrames).toHaveLength(2);

    await session.dispose();
  });

  it("reschedules after pause and resume invalidate a busy frame", async () => {
    const timing = new ControlledTiming();
    const input = playerInput([], {
      platform: timingPlatform(timing),
      visible: true
    });
    const media = new TestMediaRuntime({
      graph: LOOP_GRAPH,
      blockDrawAt: 2
    });
    const session = createSession(input, media);
    session.activate();
    session.completeCandidateInstallation();
    await session.prepare();

    timing.fireNextAnimationFrame(16);
    await flushMicrotasks();
    session.pause();
    await session.resume();
    expect(timing.pendingAnimationFrames).toBe(0);

    media.releaseBlockedDraw();
    await flushMicrotasks();

    expect(timing.pendingAnimationFrames).toBe(1);
    await session.dispose();
  });

  it("retires animation ownership for reduced motion and requests restart", async () => {
    const publications: string[] = [];
    const input = playerInput(publications, {
      onRestart: (state) => publications.push(`restart:${state}`)
    });
    const media = new TestMediaRuntime({ graph: LOOP_GRAPH });
    const session = createSession(input, media);
    session.activate({ publish: false });
    session.completeCandidateInstallation();
    await session.prepare();
    session.publish();

    await session.setMotion("reduce", true);

    expect(media.retirements).toBe(1);
    expect(publications).toContain("readiness:staticReady:reduced-motion");
    expect(session.snapshot(false)).toEqual(expect.objectContaining({
      selectedRendition: null,
      selectedCodec: null,
      requestedState: "idle",
      visualState: "idle"
    }));

    await session.setMotion("full", false);
    expect(publications).toContain("restart:idle");
    await session.setMotion("full", false);
    expect(publications.filter((value) => value === "restart:idle")).toHaveLength(1);

    await session.dispose();
    expect(media.retirements).toBe(1);
  });

  it("retries reduced-motion retirement and replaces the animated result", async () => {
    const input = playerInput([]);
    const media = new TestMediaRuntime({
      graph: LOOP_GRAPH,
      retirementFailures: 1
    });
    const session = createSession(input, media);
    session.activate();
    session.completeCandidateInstallation();
    await session.prepare();

    await expect(session.setMotion("reduce", true)).rejects.toThrow(
      "retirement failed"
    );
    await session.setMotion("reduce", true);

    expect(media.retirements).toBe(2);
    await expect(session.prepare()).resolves.toEqual(expect.objectContaining({
      mode: "static",
      reason: "reduced-motion"
    }));
    await session.dispose();
  });

  it("routes resize and context lifecycle while retaining terminal priority", async () => {
    const publications: string[] = [];
    const timing = new ControlledTiming();
    const playbackFailures: string[] = [];
    const canonicalFailure = new AvalPlaybackError(Object.freeze({
      code: "renderer-failure",
      message: "canonical playback failure",
      operation: "render"
    }), 1);
    const input = playerInput(publications, {
      platform: timingPlatform(timing),
      onFailure: (code, operation, fatal) => publications.push(
        `failure:${code}:${operation}:${String(fatal)}`
      ),
      onRestart: (state) => publications.push(`restart:${state}`),
      onPlaybackFailure: (code, operation) => {
        playbackFailures.push(`${code}:${operation}`);
        return canonicalFailure;
      }
    });
    const media = new TestMediaRuntime({ retirementFailures: 2 });
    const telemetry = new PlayerTelemetry();
    const session = createSession(input, media, telemetry);
    session.activate();
    session.completeCandidateInstallation();
    await session.prepare();

    session.resize(40, 20, 2, "cover");
    const clearedBeforeContextLoss = timing.clearedTimers.length;
    media.emitContext(Object.freeze({ state: "lost" }));
    media.emitContext(Object.freeze({ state: "restored" }));
    await session.settled();

    expect(media.operations).toContain("resize:40x20@2:cover");
    expect(media.settlements).toBe(1);
    expect(publications).toContain("failure:context-loss:render:false");
    expect(publications).toContain("restart:idle");
    expect(timing.clearedTimers).toHaveLength(clearedBeforeContextLoss + 1);

    media.emitContext(Object.freeze({
      state: "error",
      error: new Error("renderer exploded")
    }));
    await flushMicrotasks();
    await session.settled();

    expect(playbackFailures).toEqual(["renderer-failure:render"]);
    expect(media.retirements).toBe(2);
    expect(session.snapshot(false).cleanupFailureCount).toBe(2);
    await expect(session.prepare()).rejects.toBe(canonicalFailure);

    await session.dispose();
    expect(media.retirements).toBe(3);
  });

  it("finalizes an in-flight draw without publishing after context loss", async () => {
    const operations: string[] = [];
    const playbackFailures: string[] = [];
    const timing = new ControlledTiming();
    const input = playerInput([], {
      platform: timingPlatform(timing),
      visible: true,
      onEvent: (type) => operations.push(`event:${type}`),
      onPlaybackFailure: (code, operation) => {
        playbackFailures.push(`${code}:${operation}`);
        return new AvalPlaybackError(Object.freeze({
          code,
          message: "unexpected terminal failure",
          operation
        }), 1);
      },
      onRestart: (state) => operations.push(`restart:${state}`)
    });
    const media = new TestMediaRuntime({
      graph: LOOP_GRAPH,
      operations,
      blockDrawAt: 2
    });
    const session = createSession(input, media);
    session.activate();
    session.completeCandidateInstallation();
    await session.prepare();
    operations.length = 0;

    expect(session.send("hover")).toBe(true);
    timing.fireNextAnimationFrame(16);
    await flushMicrotasks();
    media.emitContext(Object.freeze({ state: "lost" }));
    media.emitContext(Object.freeze({ state: "restored" }));
    media.releaseBlockedDraw();
    await flushMicrotasks();

    expect(operations).toContain("finalize");
    expect(operations).not.toContain("event:transitionstart");
    expect(operations).not.toContain("event:visualstatechange");
    expect(playbackFailures).toEqual([]);
    expect(timing.pendingAnimationFrames).toBe(0);
    expect(operations).toContain("restart:hover");
    await session.dispose();
  });

  it("reacquires and redraws after initial-draw context recovery", async () => {
    const operations: string[] = [];
    const playbackFailures: string[] = [];
    const timing = new ControlledTiming();
    const input = playerInput([], {
      platform: timingPlatform(timing),
      visible: true,
      onEvent: (type) => operations.push(`event:${type}`),
      onReadiness: (value) => operations.push(`readiness:${value}`),
      onRestart: (state) => operations.push(`restart:${state}`),
      onPlaybackFailure: (code, operation) => {
        playbackFailures.push(`${code}:${operation}`);
        return new AvalPlaybackError(Object.freeze({
          code,
          message: "unexpected terminal failure",
          operation
        }), 1);
      }
    });
    const media = new TestMediaRuntime({
      graph: LOOP_GRAPH,
      operations,
      blockDrawAt: 1
    });
    const session = createSession(input, media);
    session.activate();
    operations.length = 0;
    session.completeCandidateInstallation();

    const preparation = session.prepare();
    await flushMicrotasks();
    media.emitContext(Object.freeze({ state: "lost" }));
    media.releaseBlockedDraw();
    await flushMicrotasks();

    expect(operations.filter((value) => value.startsWith("draw:"))).toHaveLength(1);
    expect(operations).not.toContain("readiness:visualReady");

    media.emitContext(Object.freeze({ state: "restored" }));

    await expect(preparation).resolves.toEqual(expect.objectContaining({
      mode: "animated"
    }));
    expect(operations.filter((value) => value.startsWith("acquire:"))).toHaveLength(2);
    expect(operations.filter((value) => value.startsWith("draw:"))).toHaveLength(2);
    expect(operations.filter((value) => value === "finalize")).toHaveLength(2);
    expect(operations).not.toContain("restart:idle");
    expect(operations).toContain("readiness:visualReady");
    expect(operations).toContain("readiness:interactiveReady");
    expect(playbackFailures).toEqual([]);

    await session.dispose();
  });
});

interface TestMediaOptions {
  readonly graph?: Readonly<MotionGraphDefinition>;
  readonly operations?: string[];
  readonly blockDrawAt?: number;
  readonly failFinalizeAt?: number;
  readonly retirementFailures?: number;
}

class TestMediaRuntime implements PlayerMediaRuntimePort {
  public readonly descriptor: PlayerMediaRuntimePort["descriptor"];
  public readonly operations: string[];
  public retirements = 0;
  public settlements = 0;
  public edgeIsReady = true;
  readonly #failure: Promise<never>;
  readonly #rejectFailure: (reason: unknown) => void;
  readonly #blockDrawAt: number | undefined;
  readonly #failFinalizeAt: number | undefined;
  #retirementFailures: number;
  #contextObserver: ((event: PlayerMediaContextEvent) => void) | null = null;
  #drawCount = 0;
  #releaseBlockedDraw: (() => void) | null = null;
  #finalizationCount = 0;
  #retired = false;

  public constructor(options: Readonly<TestMediaOptions> = {}) {
    const graph = options.graph ?? GRAPH;
    this.operations = options.operations ?? [];
    this.#blockDrawAt = options.blockDrawAt;
    this.#failFinalizeAt = options.failFinalizeAt;
    this.#retirementFailures = options.retirementFailures ?? 0;
    this.descriptor = Object.freeze({
      metadata: metadataFor(graph),
      graph,
      frameDurationMs: 16,
      rendition: Object.freeze({
        id: "main",
        codec: "av1",
        bitDepth: 8 as const,
        sourceIndex: 0
      })
    });
    let rejectFailure!: (reason: unknown) => void;
    this.#failure = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    this.#rejectFailure = rejectFailure;
  }

  public connectContextObserver(
    observer: (event: PlayerMediaContextEvent) => void
  ): void {
    this.#contextObserver = observer;
  }

  public failure(): Promise<never> {
    return this.#failure;
  }

  public fail(reason: unknown): void { this.#rejectFailure(reason); }

  public emitContext(event: Readonly<PlayerMediaContextEvent>): void {
    this.#contextObserver?.(event);
  }

  public updateGraphDiagnostic(input: Readonly<{
    requestedState: string | null;
    visualState: string | null;
  }>): void {
    this.operations.push(`graph:${input.requestedState}/${input.visualState}`);
  }

  public async qualifyOutput(_signal: AbortSignal): Promise<void> {
    this.operations.push("qualify");
  }

  public async prepare(input: Readonly<{
    initialState: string;
    initialBody: boolean;
    signal: AbortSignal;
  }>): Promise<void> {
    this.operations.push(`prepare:${input.initialState}`);
  }

  public routeDecision(
    _snapshot: Readonly<MotionGraphSnapshot>
  ): Readonly<PlayerMediaRouteDecision> {
    return Object.freeze({
      ready: this.edgeIsReady,
      blocksPresentation: false
    });
  }

  public prepareRoutes(
    snapshot: Readonly<MotionGraphSnapshot>,
    _required?: Readonly<GraphPresentation>
  ): void {
    this.operations.push(`routes:${snapshot.requestedState}`);
  }

  public edgeReady(_edgeId: string): boolean { return this.edgeIsReady; }

  public acquirePresentation(
    presentation: Readonly<GraphPresentation>
  ): Readonly<PlayerMediaAcquisition> {
    this.operations.push(`acquire:${presentationLabel(presentation)}`);
    return Object.freeze({
      kind: "ready" as const,
      lease: Object.freeze({ token: Symbol("test-lease") })
    });
  }

  public cancelPresentation(_lease: PlayerMediaLease | null): void {
    this.operations.push("cancel");
  }

  public async draw(input: Readonly<{
    presentation: Readonly<GraphPresentation>;
    lease: PlayerMediaLease | null;
  }>): Promise<Readonly<PlayerMediaDrawResult>> {
    this.operations.push(`draw:${presentationLabel(input.presentation)}`);
    this.#drawCount += 1;
    if (this.#drawCount === this.#blockDrawAt) {
      await new Promise<void>((resolve) => {
        this.#releaseBlockedDraw = resolve;
      });
      this.#releaseBlockedDraw = null;
    }
    return Object.freeze({
      receipt: Object.freeze({
        drew: true,
        unitId: "idle-body",
        localFrame: 0,
        logicalRunId: 1,
        openFrames: 1,
        readbackTag: "none"
      }) satisfies Readonly<PlayerMediaDrawReceipt>,
      finalization: Object.freeze({ token: Symbol("test-finalization") })
    });
  }

  public releaseBlockedDraw(): void {
    const release = this.#releaseBlockedDraw;
    if (release === null) throw new Error("No blocked AVAL draw");
    release();
  }

  public finalizeDraw(
    _finalization: Readonly<PlayerMediaDrawFinalization>
  ): void {
    this.operations.push("finalize");
    this.#finalizationCount += 1;
    if (this.#finalizationCount === this.#failFinalizeAt) {
      throw new Error("finalization failed");
    }
  }

  public resize(_input: Readonly<{
    width: number;
    height: number;
    dpr: number;
    fit: string;
  }>): void {
    this.operations.push(
      `resize:${String(_input.width)}x${String(_input.height)}` +
      `@${String(_input.dpr)}:${_input.fit}`
    );
  }

  public snapshot(): Readonly<PlayerMediaSnapshot> { return MEDIA_SNAPSHOT; }
  public async settled(): Promise<void> {
    this.settlements += 1;
    this.operations.push("settled");
  }

  public async retire(): Promise<void> {
    if (this.#retired) return;
    this.retirements += 1;
    this.operations.push(`retire:${String(this.retirements)}`);
    if (this.#retirementFailures > 0) {
      this.#retirementFailures -= 1;
      throw new Error("retirement failed");
    }
    this.#retired = true;
  }
}

const GRAPH = Object.freeze({
  initialState: "idle",
  states: Object.freeze([Object.freeze({
    id: "idle",
    body: Object.freeze({
      unitId: "idle-body",
      kind: "finite" as const,
      frameCount: 1,
      ports: Object.freeze([Object.freeze({
        id: "handoff",
        entryFrame: 0 as const,
        portalFrames: Object.freeze([0])
      })])
    })
  })]),
  edges: Object.freeze([])
}) satisfies Readonly<MotionGraphDefinition>;

const LOOP_GRAPH = Object.freeze({
  initialState: "idle",
  states: Object.freeze([
    graphState("idle"),
    graphState("hover")
  ]),
  edges: Object.freeze([Object.freeze({
    id: "idle-hover",
    from: "idle",
    to: "hover",
    trigger: Object.freeze({ type: "event" as const, name: "hover" }),
    start: Object.freeze({
      type: "cut" as const,
      targetPort: "handoff",
      maxWaitFrames: 1 as const
    }),
    continuity: "cut" as const
  })])
}) satisfies Readonly<MotionGraphDefinition>;

const MEDIA_SNAPSHOT = Object.freeze({
  transportMode: "range" as const,
  declaredFileBytes: 0,
  metadataBytes: 0,
  verifiedBytes: 0,
  residentBlobBytes: 0,
  activeTransportBodies: 0,
  pendingLoads: 0,
  interestedWaiters: 0,
  workerCount: 0,
  openFrames: 1,
  rendererBackend: "webgl2" as const,
  presentation: Object.freeze({
    cssWidth: 16,
    cssHeight: 16,
    backingWidth: 16,
    backingHeight: 16,
    effectiveDprX: 1,
    effectiveDprY: 1
  }),
  contextLossCount: 0,
  contextRecoveryCount: 0
}) satisfies Readonly<PlayerMediaSnapshot>;

function presentationLabel(presentation: Readonly<GraphPresentation>): string {
  return "unitId" in presentation
    ? `${presentation.unitId}@${presentation.frameIndex}`
    : presentation.state;
}

function playerInput(
  publications: string[],
  overrides: Partial<PlayerInput> = {}
): Readonly<PlayerInput> {
  const controller = new AbortController();
  const input = {
    canvas: new EventTarget() as HTMLCanvasElement,
    platform: Object.freeze({
      fetch: globalThis.fetch,
      Worker: null,
      VideoDecoder: null,
      VideoFrame: null,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
      now: () => 0,
      setTimeout: (callback, delay) =>
        globalThis.setTimeout(callback, delay) as unknown as number,
      clearTimeout: (handle) => globalThis.clearTimeout(handle),
      crypto: globalThis.crypto
    }),
    initialPresentation: Object.freeze({
      width: 16,
      height: 16,
      dpr: 1,
      fit: "contain" as const
    }),
    baseUrl: "https://example.test/",
    sources: Object.freeze([]),
    credentials: "same-origin" as const,
    signal: controller.signal,
    preparationTimeoutMs: 1_000,
    motion: "full" as const,
    reduced: false,
    initialState: null,
    initialBody: false,
    visible: false,
    decoderReady: () => true,
    onResourceBytes: () => undefined,
    onMetadata: (metadata) => publications.push(
      `metadata:${metadata.initialState}`
    ),
    onReadiness: (value, reason) => publications.push(
      `readiness:${value}${reason === undefined ? "" : `:${reason}`}`
    ),
    onAnimationResourcesRetired: () => publications.push("retired"),
    onDraw: () => publications.push("draw"),
    onRestart: () => undefined,
    onEvent: (type) => publications.push(`event:${type}`),
    onFailure: () => undefined,
    onPlaybackFailure: (code, operation) => new AvalPlaybackError(Object.freeze({
      code,
      message: "unused",
      operation
    }), 1)
  } satisfies PlayerInput;
  return Object.freeze({ ...input, ...overrides });
}

function sessionHost(input: Readonly<PlayerInput>): Readonly<PlayerSessionHost> {
  return Object.freeze({
    signal: input.signal,
    initialState: input.initialState,
    initialBody: input.initialBody,
    visible: input.visible,
    timing: Object.freeze({
      requestAnimationFrame: input.platform.requestAnimationFrame,
      cancelAnimationFrame: input.platform.cancelAnimationFrame,
      now: input.platform.now,
      setTimeout: input.platform.setTimeout,
      clearTimeout: input.platform.clearTimeout
    }),
    publication: Object.freeze({
      onMetadata: input.onMetadata,
      onReadiness: input.onReadiness,
      onRestart: input.onRestart,
      onEvent: input.onEvent,
      onFailure: input.onFailure,
      onPlaybackFailure: input.onPlaybackFailure
    })
  });
}

function metadataFor(
  graph: Readonly<MotionGraphDefinition>
): Readonly<Metadata> {
  return Object.freeze({
    initialState: graph.initialState,
    stateNames: Object.freeze(graph.states.map(({ id }) => id)),
    eventNames: Object.freeze(graph.edges.flatMap(({ trigger }) =>
      trigger?.type === "event" ? [trigger.name] : []
    )),
    bindings: Object.freeze([]),
    canvas: Object.freeze({
      width: 16,
      height: 16,
      pixelAspect: Object.freeze([1, 1] as const),
      fit: "contain" as const
    })
  });
}

function graphState(id: string) {
  return Object.freeze({
    id,
    body: Object.freeze({
      unitId: `${id}-body`,
      kind: "loop" as const,
      frameCount: 3,
      ports: Object.freeze([Object.freeze({
        id: "handoff",
        entryFrame: 0 as const,
        portalFrames: Object.freeze([0, 2])
      })])
    })
  });
}

class ControlledTiming {
  public nowValue = 0;
  public readonly cancelledAnimationFrames: number[] = [];
  public readonly clearedTimers: number[] = [];
  readonly #animationFrames = new Map<number, FrameRequestCallback>();
  readonly #timers = new Map<number, () => void>();
  #nextAnimationFrame = 0;
  #nextTimer = 0;

  public get pendingAnimationFrames(): number {
    return this.#animationFrames.size;
  }

  public readonly requestAnimationFrame = (
    callback: FrameRequestCallback
  ): number => {
    const handle = ++this.#nextAnimationFrame;
    this.#animationFrames.set(handle, callback);
    return handle;
  };

  public readonly cancelAnimationFrame = (handle: number): void => {
    this.cancelledAnimationFrames.push(handle);
    this.#animationFrames.delete(handle);
  };

  public readonly now = (): number => this.nowValue;

  public readonly setTimeout = (
    callback: () => void,
    _delay: number
  ): number => {
    const handle = ++this.#nextTimer;
    this.#timers.set(handle, callback);
    return handle;
  };

  public readonly clearTimeout = (handle: number): void => {
    this.clearedTimers.push(handle);
    this.#timers.delete(handle);
  };

  public captureNextAnimationFrame(): FrameRequestCallback {
    const callback = this.#animationFrames.values().next().value;
    if (callback === undefined) throw new Error("No scheduled animation frame");
    return callback;
  }

  public fireNextAnimationFrame(time: number): void {
    const entry = this.#animationFrames.entries().next().value;
    if (entry === undefined) throw new Error("No scheduled animation frame");
    const [handle, callback] = entry;
    this.#animationFrames.delete(handle);
    this.nowValue = time;
    callback(time);
  }
}

function timingPlatform(
  timing: ControlledTiming
): Readonly<PlayerInput["platform"]> {
  return Object.freeze({
    fetch: globalThis.fetch,
    Worker: null,
    VideoDecoder: null,
    VideoFrame: null,
    requestAnimationFrame: timing.requestAnimationFrame,
    cancelAnimationFrame: timing.cancelAnimationFrame,
    now: timing.now,
    setTimeout: timing.setTimeout,
    clearTimeout: timing.clearTimeout,
    crypto: globalThis.crypto
  });
}

function createSession(
  input: Readonly<PlayerInput>,
  media: PlayerMediaRuntimePort,
  telemetry = new PlayerTelemetry(),
  staticReason: "reduced-motion" | "visibility-suspended" |
    "decoder-queued" | null = null
): PlayerSession {
  const publications = new PublicationGate(input);
  return new PlayerSession(Object.freeze({
    candidate: Object.freeze({
      staticReason,
      candidateReports: Object.freeze([]),
      candidateRank: 0
    }),
    host: sessionHost(publications.input),
    publications,
    preparationDeadline: PreparationDeadline.begin({
      parent: input.signal,
      timeoutMs: input.preparationTimeoutMs,
      platform: input.platform
    }),
    media,
    telemetry
  }));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function drawCount(operations: readonly string[]): number {
  return operations.filter((operation) => operation.startsWith("draw:")).length;
}
