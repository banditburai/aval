import { describe, expect, it, vi } from "vitest";

import type {
  ElementRuntimeDiagnosticEvent,
  ElementRuntimePageSnapshot,
  ElementRuntimeReadSnapshot
} from "../src/element-runtime-contract.js";
import {
  ElementRuntimeSession,
  type ElementRuntimeModule,
  type ElementRuntimeSessionInput
} from "../src/element-runtime-session.js";
import type {
  Player,
  PlayerInput,
  PlayerSnapshot,
  Source
} from "../src/player-contract.js";
import type {
  AvalPublicFailure,
  AvalSnapshot,
  RuntimeReadiness,
  StaticReason
} from "../src/public-types.js";
import { createElementTestRealm } from "./support/element-test-realm.js";

describe("ElementRuntimeSession", () => {
  it("does not load the runtime when the session is imported or constructed", () => {
    const harness = createHarness([]);
    const session = new ElementRuntimeSession(harness.input, harness.loader);

    expect(session.snapshot(false).runtime).toBeNull();
    expect(harness.loader).not.toHaveBeenCalled();
    expect(harness.createPlayer).not.toHaveBeenCalled();
  });

  it("rejects an empty source set before loading the runtime", async () => {
    const harness = createHarness([]);
    const session = new ElementRuntimeSession(harness.input, harness.loader);

    await expect(session.prepare()).rejects.toMatchObject({
      name: "AvalPlaybackError",
      failure: {
        code: "invalid-configuration",
        operation: "configure"
      }
    });

    expect(harness.loader).not.toHaveBeenCalled();
    expect(harness.createPlayer).not.toHaveBeenCalled();
    expect(harness.diagnostics.map(({ kind }) => kind)).toEqual([
      "prepare",
      "source-started",
      "source-capacity"
    ]);
  });

  it("rejects a loader resolution that arrives after terminal disposal", async () => {
    let resolveModule!: (module: Readonly<ElementRuntimeModule>) => void;
    const modulePending = new Promise<Readonly<ElementRuntimeModule>>((resolve) => {
      resolveModule = resolve;
    });
    const harness = createHarness([source()], () => modulePending);
    const session = new ElementRuntimeSession(harness.input, harness.loader);

    const preparation = session.prepare();
    await eventually(() => harness.loader.mock.calls.length === 1);
    const disposal = session.dispose();

    await expect(preparation).rejects.toMatchObject({ name: "AbortError" });
    await expect(disposal).resolves.toBeUndefined();
    expect(session.finalDisposed).toBe(true);
    expect(harness.disposalCompleted).toHaveBeenCalledWith(true, 0);

    resolveModule(Object.freeze({ createPlayer: harness.createPlayer }));
    await settleMicrotasks();

    expect(harness.createPlayer).not.toHaveBeenCalled();
    expect(session.snapshot(false)).toMatchObject({
      runtime: null,
      pendingOperationCount: 0
    });
  });

  it("retires an accepted candidate before a current generation abort escapes", async () => {
    const harness = createHarness([source()]);
    const candidate = provisionalPlayer();
    const createPlayer = vi.fn(async (
      input: Readonly<PlayerInput>
    ): Promise<Player> => {
      await input.onCandidate?.(candidate.player);
      throw new DOMException("synthetic startup invalidation", "AbortError");
    });
    harness.loader.mockResolvedValue(Object.freeze({ createPlayer }));
    const session = new ElementRuntimeSession(harness.input, harness.loader);

    await expect(session.prepare()).rejects.toMatchObject({ name: "AbortError" });

    expect(createPlayer).toHaveBeenCalledTimes(1);
    expect(candidate.dispose).toHaveBeenCalledTimes(1);
    expect(candidate.settled).toHaveBeenCalledTimes(1);
    expect(candidate.publish).not.toHaveBeenCalled();
    expect(harness.releaseAll).toHaveBeenCalled();
    expect(session.snapshot(false)).toMatchObject({
      runtime: null,
      runtimeIsActive: false,
      pendingOperationCount: 0
    });
  });
});

function createHarness(
  sources: readonly Readonly<Source>[],
  implementation?: () => Promise<Readonly<ElementRuntimeModule>>
): Readonly<{
  input: Readonly<ElementRuntimeSessionInput>;
  loader: ReturnType<typeof vi.fn<() => Promise<Readonly<ElementRuntimeModule>>>>;
  createPlayer: ReturnType<typeof vi.fn<(
    input: Readonly<PlayerInput>
  ) => Promise<never>>>;
  diagnostics: ElementRuntimeDiagnosticEvent[];
  disposalCompleted: ReturnType<typeof vi.fn<(
    sourceCleanupCompleted: boolean,
    sessionPending: number
  ) => boolean>>;
  releaseAll: ReturnType<typeof vi.fn<() => void>>;
}> {
  const { document, view } = createElementTestRealm();
  let publicSnapshot = initialSnapshot();
  const diagnostics: ElementRuntimeDiagnosticEvent[] = [];
  const createPlayer = vi.fn(async (_input: Readonly<PlayerInput>): Promise<never> => {
    throw new Error("createPlayer should not be reached by this harness");
  });
  const defaultLoader = async (): Promise<Readonly<ElementRuntimeModule>> =>
    Object.freeze({ createPlayer });
  const loader = vi.fn(implementation ?? defaultLoader);
  const disposalCompleted = vi.fn((_source, _pending) => true);
  const releaseAll = vi.fn();
  const readSnapshot = (): Readonly<ElementRuntimeReadSnapshot> => Object.freeze({
    publicSnapshot,
    view: view as unknown as Window,
    baseUrl: document.baseURI,
    crossOrigin: "anonymous",
    motion: "auto",
    autoplay: "visible",
    fit: null,
    declarativeState: null,
    geometry: Object.freeze({ width: 16, height: 16, dpr: 1 }),
    reducedMotion: false,
    intersectionKnown: true,
    effectivelyVisible: true
  });
  const input: ElementRuntimeSessionInput = Object.freeze({
    read: Object.freeze({
      snapshot: readSnapshot,
      sources: () => Object.freeze({
        sources,
        failures: Object.freeze([])
      }),
      takeSourceChanges: () => false,
      needsIntersectionSample: () => false,
      waitForIntersection: async () => undefined
    }),
    publish: Object.freeze({
      commit: (patch: Readonly<Partial<Omit<AvalSnapshot, "revision">>>) => {
        publicSnapshot = Object.freeze({ ...publicSnapshot, ...patch });
      },
      diagnostic: (event: Readonly<ElementRuntimeDiagnosticEvent>) => {
        diagnostics.push(event);
      },
      readinessChanged: (
        readiness: RuntimeReadiness,
        reason: StaticReason | undefined
      ) => {
        publicSnapshot = Object.freeze({
          ...publicSnapshot,
          readiness,
          mode: readiness === "staticReady" ? "static" :
            readiness === "visualReady" || readiness === "interactiveReady"
              ? "animated" : null,
          assurance: readiness === "visualReady" || readiness === "interactiveReady"
            ? "best-effort" : null,
          staticReason: readiness === "staticReady" ? reason ?? null : null
        });
      },
      runtimeEvent: () => undefined,
      failure: (
        failure: Readonly<AvalPublicFailure>,
        fatal: boolean,
        generation: number
      ) => {
        publicSnapshot = Object.freeze({
          ...publicSnapshot,
          lastError: Object.freeze({ generation, failure, fatal })
        });
      },
      metadataChanged: () => undefined,
      refreshInputs: () => undefined,
      disconnectInputs: () => undefined,
      sendInput: () => undefined,
      transitionEnded: () => undefined,
      disposalStarted: () => {
        publicSnapshot = Object.freeze({
          ...publicSnapshot,
          connected: false,
          effectivelyVisible: false
        });
      },
      disposalCompleted,
      cleanupObserved: () => undefined,
      stalePublicationCount: () => 0
    }),
    presentation: Object.freeze({
      canvas: document.createElement("canvas") as unknown as HTMLCanvasElement,
      stylesSupported: () => true,
      resetSource: () => undefined,
      metadataChanged: () => undefined,
      reconcileMotionPreference: () => undefined,
      animatedDrawn: () => undefined
    }),
    pageResources: Object.freeze({
      invalidateRequest: () => undefined,
      claimDecoder: () => true,
      setResourceBytes: () => undefined,
      animationResourcesRetired: () => undefined,
      cancelDecoderTicket: () => undefined,
      setVisible: () => undefined,
      releaseAll,
      snapshot: emptyPageSnapshot
    })
  });
  return Object.freeze({
    input,
    loader,
    createPlayer,
    diagnostics,
    disposalCompleted,
    releaseAll
  });
}

function provisionalPlayer(): Readonly<{
  player: Player;
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  settled: ReturnType<typeof vi.fn<() => Promise<void>>>;
  publish: ReturnType<typeof vi.fn<() => void>>;
}> {
  let disposed = false;
  const dispose = vi.fn(async () => { disposed = true; });
  const settled = vi.fn(async () => undefined);
  const publish = vi.fn();
  const metadata: Player["metadata"] = Object.freeze({
    initialState: "idle",
    stateNames: Object.freeze(["idle"]),
    eventNames: Object.freeze([]),
    bindings: Object.freeze([]),
    canvas: Object.freeze({
      width: 16,
      height: 16,
      pixelAspect: Object.freeze([1, 1] as const),
      fit: "contain"
    })
  });
  const player: Player = Object.freeze({
    metadata,
    activate: () => undefined,
    publish,
    prepare: async () => animatedResult(),
    setState: async () => undefined,
    canSend: () => false,
    send: () => false,
    readyFor: () => true,
    pause: () => undefined,
    resume: async () => undefined,
    setMotion: async () => undefined,
    suspend: async () => suspendedResult(),
    setVisibility: () => undefined,
    resize: () => undefined,
    snapshot: () => playerSnapshot(disposed),
    settled,
    dispose
  });
  return Object.freeze({ player, dispose, settled, publish });
}

function playerSnapshot(disposed: boolean): Readonly<PlayerSnapshot> {
  return Object.freeze({
    requestedState: disposed ? null : "idle",
    visualState: disposed ? null : "idle",
    transitioning: false,
    selectedRendition: disposed ? null : "main",
    selectedCodec: disposed ? null : "avc1.42E01E",
    rendererBackend: disposed ? null : "webgl2",
    selectedBitDepth: disposed ? null : 8,
    transportMode: disposed ? null : "range",
    declaredFileBytes: disposed ? 0 : 1_024,
    metadataBytes: disposed ? 0 : 128,
    verifiedBytes: 0,
    residentBlobBytes: 0,
    activeTransportBodies: 0,
    pendingLoads: 0,
    interestedWaiters: 0,
    workerCount: 0,
    openFrames: 0,
    contextLossCount: 0,
    contextRecoveryCount: 0,
    playbackLifecycle: Object.freeze({
      outputsAccepted: 0,
      drawsCompleted: 0,
      logicalRunsCreated: 0,
      candidateCommits: 0,
      runsClosed: 0,
      transitionStarts: 0,
      transitionEnds: 0,
      loopCrossings: 0,
      nativeDecoderCreatesByLane: Object.freeze([0, 0] as const),
      nativeDecoderClosesByLane: Object.freeze([0, 0] as const)
    }),
    decoderDiagnostics: Object.freeze([]),
    rendererDiagnostics: Object.freeze([]),
    presentation: Object.freeze({
      cssWidth: disposed ? 0 : 16,
      cssHeight: disposed ? 0 : 16,
      backingWidth: disposed ? 0 : 16,
      backingHeight: disposed ? 0 : 16,
      effectiveDprX: disposed ? 0 : 1,
      effectiveDprY: disposed ? 0 : 1,
      stagingBytes: 0,
      residentBytes: 0,
      textureBytes: 0,
      runtimeBytes: 0,
      pendingOperations: 0,
      sourceCopiesInFlight: 0,
      resourceCount: 0,
      contextListenerCount: 0
    }),
    trace: Object.freeze([])
  });
}

function animatedResult() {
  return Object.freeze({
    mode: "animated" as const,
    assurance: "best-effort" as const,
    report: Object.freeze({
      readiness: "interactiveReady" as const,
      selectedRendition: "main",
      candidates: Object.freeze([])
    })
  });
}

function suspendedResult() {
  return Object.freeze({
    mode: "static" as const,
    reason: "visibility-suspended" as const,
    report: Object.freeze({
      readiness: "staticReady" as const,
      selectedRendition: null,
      candidates: Object.freeze([])
    })
  });
}

function initialSnapshot(): Readonly<AvalSnapshot> {
  return Object.freeze({
    revision: 0,
    generation: 0,
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
    lastError: null
  });
}

function emptyPageSnapshot(): Readonly<ElementRuntimePageSnapshot> {
  return Object.freeze({
    ownership: Object.freeze({
      kind: "page-resources",
      participantDisposed: true,
      participantRegistered: false,
      logicalBytes: 0,
      activeLeaseCount: 0,
      decoderTicketCount: 0,
      decoderState: null
    }),
    page: Object.freeze({
      active: 0,
      queued: 0,
      parked: 0,
      participants: 0,
      physicalBytes: 0
    })
  });
}

function source(): Readonly<Source> {
  return Object.freeze({
    src: "https://example.test/motion.avl",
    codec: "h264",
    integrity: ""
  });
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 32; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}
