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
import type { PlayerInput, Source } from "../src/player-contract.js";
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
      releaseAll: () => undefined,
      snapshot: emptyPageSnapshot
    })
  });
  return Object.freeze({
    input,
    loader,
    createPlayer,
    diagnostics,
    disposalCompleted
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
