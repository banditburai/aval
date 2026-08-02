import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvalPlaybackError } from "../src/errors.js";
import type { PlayerInput } from "../src/player-contract.js";
import { PlayerMediaCandidateProbe } from
  "../src/player-media-candidate.js";
import { PublicationGate } from "../src/player-publication-gate.js";
import { createPlayer } from "../src/player.js";
import { PreparationDeadline } from "../src/preparation-deadline.js";
import {
  CODECS,
  SyntheticAsset
} from "./support/provisional-startup-harness.js";

const ownership = vi.hoisted(() => ({
  asset: null as SyntheticAsset | null,
  constructorFailure: null as Error | null,
  decoderSupported: true,
  decoderDisposeFailures: 0,
  rendererConstructionFailure: null as Error | null,
  rendererAdmissionFailure: null as Error | null,
  rendererDisposeFailures: 0,
  admissionOperations: [] as string[],
  retireCalls: 0,
  retireFailures: 0
}));

vi.mock("../src/decoder-pool.js", () => ({
  DecoderPool: class {
    public readonly encodedBytes = 0;

    public constructor() {
      ownership.admissionOperations.push("decoder:create");
    }

    public async supported(): Promise<boolean> {
      ownership.admissionOperations.push("decoder:supported");
      return ownership.decoderSupported;
    }

    public snapshot() {
      return Object.freeze({ decoderDiagnostics: Object.freeze([]) });
    }

    public dispose(): void {
      ownership.admissionOperations.push("decoder:dispose");
      if (ownership.decoderDisposeFailures > 0) {
        ownership.decoderDisposeFailures -= 1;
        throw new Error("synthetic decoder cleanup failure");
      }
    }
  }
}));

vi.mock("../src/renderer.js", () => ({
  Renderer: class {
    public constructor() {
      ownership.admissionOperations.push("renderer:create");
      if (ownership.rendererConstructionFailure !== null) {
        throw ownership.rendererConstructionFailure;
      }
    }

    public admit(): Readonly<{ runtimeBytes: number }> {
      ownership.admissionOperations.push("renderer:admit");
      if (ownership.rendererAdmissionFailure !== null) {
        throw ownership.rendererAdmissionFailure;
      }
      return Object.freeze({ runtimeBytes: 0 });
    }

    public snapshot(): Readonly<{ runtimeBytes: number }> {
      return Object.freeze({ runtimeBytes: 0 });
    }

    public dispose(): void {
      ownership.admissionOperations.push("renderer:dispose");
      if (ownership.rendererDisposeFailures > 0) {
        ownership.rendererDisposeFailures -= 1;
        throw new Error("synthetic renderer cleanup failure");
      }
    }
  }
}));

vi.mock("../src/asset.js", () => ({
  Asset: class {
    public static async open(): Promise<SyntheticAsset> {
      if (ownership.asset === null) throw new Error("missing synthetic asset");
      return ownership.asset;
    }
  }
}));

vi.mock("../src/player-media-runtime.js", () => ({
  PlayerMediaRuntime: class {
    readonly #asset: SyntheticAsset;

    public constructor(input: Readonly<{ asset: SyntheticAsset }>) {
      if (ownership.constructorFailure !== null) {
        throw ownership.constructorFailure;
      }
      this.#asset = input.asset;
    }

    public contextChanged(): void {}

    public async retire(): Promise<void> {
      ownership.retireCalls += 1;
      if (ownership.retireFailures > 0) {
        ownership.retireFailures -= 1;
        throw new Error("synthetic runtime retirement failure");
      }
      await this.#asset.dispose();
    }
  }
}));

describe("PlayerMediaCandidateProbe ownership", () => {
  const deadlines: PreparationDeadline[] = [];
  let cleanupFailures: Set<string>;
  let disposals: string[];

  beforeEach(() => {
    cleanupFailures = new Set();
    disposals = [];
    ownership.asset = new SyntheticAsset({
      disposals,
      operations: [],
      cleanupFailures,
      witnessFrames: new Map()
    }, "av1", CODECS.av1);
    ownership.constructorFailure = null;
    ownership.decoderSupported = true;
    ownership.decoderDisposeFailures = 0;
    ownership.rendererConstructionFailure = null;
    ownership.rendererAdmissionFailure = null;
    ownership.rendererDisposeFailures = 0;
    ownership.admissionOperations.length = 0;
    ownership.retireCalls = 0;
    ownership.retireFailures = 0;
  });

  afterEach(() => {
    for (const deadline of deadlines.splice(0)) deadline.dispose();
    vi.restoreAllMocks();
  });

  it("records asset authority before resource publication can fail", async () => {
    const failure = new Error("synthetic resource report failure");
    const input = playerInput({
      onResourceBytes: (bytes) => {
        if (bytes > 0) throw failure;
      }
    });
    const { probe, request } = candidate(input, deadlines);

    await expect(probe.probe(request)).rejects.toBe(failure);

    expect(disposals).toEqual(["av1"]);
    await expect(probe.dispose()).resolves.toBeUndefined();
  });

  it("retires transferred runtime authority when acceptance throws", async () => {
    const failure = new Error("synthetic candidate acceptance failure");
    ownership.retireFailures = 1;
    const input = playerInput();
    const { probe, request } = candidate(input, deadlines);

    await expect(probe.probeWith(request, () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(ownership.retireCalls).toBe(1);
    expect(disposals).toEqual([]);
    await expect(probe.dispose()).resolves.toBeUndefined();
    expect(ownership.retireCalls).toBe(2);
    expect(disposals).toEqual(["av1"]);
  });

  it("cleans transferring authority when runtime construction throws", async () => {
    const failure = new Error("synthetic runtime construction failure");
    ownership.constructorFailure = failure;
    const input = playerInput();
    const { probe, request } = candidate(input, deadlines);

    await expect(probe.probe(request)).rejects.toBe(failure);

    expect(disposals).toEqual(["av1"]);
    await expect(probe.dispose()).resolves.toBeUndefined();
  });

  it("keeps retained authority when disposal fails and retries it", async () => {
    const failure = new Error("synthetic resource report failure");
    cleanupFailures.add("av1");
    const input = playerInput({
      onResourceBytes: (bytes) => {
        if (bytes > 0) throw failure;
      }
    });
    const { probe, request } = candidate(input, deadlines);

    await expect(probe.probe(request)).rejects.toBe(failure);
    expect(disposals).toEqual(["av1"]);

    cleanupFailures.delete("av1");
    await expect(probe.dispose()).resolves.toBeUndefined();
    expect(disposals).toEqual(["av1", "av1"]);
  });

  it("preserves support rejection when decoder cleanup fails", async () => {
    ownership.decoderSupported = false;
    ownership.decoderDisposeFailures = 1;
    const input = playerInput({ visible: true });
    const { probe, request } = candidate(input, deadlines);

    await expect(probe.probe(request)).resolves.toEqual(expect.objectContaining({
      kind: "rendition-rejected",
      reason: "codec-unsupported"
    }));

    expect(ownership.admissionOperations).toEqual([
      "decoder:create",
      "decoder:supported",
      "decoder:dispose"
    ]);
    expect(disposals).toEqual(["av1"]);
    await expect(probe.dispose()).resolves.toBeUndefined();
    expect(ownership.admissionOperations.filter((operation) =>
      operation === "decoder:dispose"
    )).toHaveLength(2);
    expect(disposals).toEqual(["av1"]);
  });

  it("preserves renderer construction failure when decoder cleanup fails", async () => {
    const failure = new Error("synthetic renderer construction failure");
    ownership.rendererConstructionFailure = failure;
    ownership.decoderDisposeFailures = 1;
    const input = playerInput({ visible: true });
    const { probe, request } = candidate(input, deadlines);

    await expect(probe.probe(request)).rejects.toBe(failure);

    expect(ownership.admissionOperations).toEqual(expect.arrayContaining([
      "decoder:dispose",
      "renderer:create"
    ]));
    expect(disposals).toEqual(["av1"]);
    await expect(probe.dispose()).resolves.toBeUndefined();
  });

  it("drains renderer after decoder cleanup fails during admission", async () => {
    const failure = new Error("synthetic renderer admission failure");
    ownership.rendererAdmissionFailure = failure;
    ownership.decoderDisposeFailures = 1;
    const input = playerInput({ visible: true });
    const { probe, request } = candidate(input, deadlines);

    await expect(probe.probe(request)).rejects.toBe(failure);

    expect(ownership.admissionOperations).toEqual(expect.arrayContaining([
      "renderer:admit",
      "decoder:dispose",
      "renderer:dispose"
    ]));
    expect(disposals).toEqual(["av1"]);
    await expect(probe.dispose()).resolves.toBeUndefined();
  });

  it("drains all admission resources without replacing deadline-fork failure", async () => {
    const failure = new Error("synthetic deadline fork failure");
    ownership.decoderDisposeFailures = 1;
    ownership.rendererDisposeFailures = 1;
    vi.spyOn(PreparationDeadline.prototype, "forkDeferred")
      .mockImplementationOnce(() => { throw failure; });
    const input = playerInput({ visible: true });
    const { probe, request } = candidate(input, deadlines);

    await expect(probe.probe(request)).rejects.toBe(failure);

    expect(ownership.admissionOperations).toEqual(expect.arrayContaining([
      "decoder:dispose",
      "renderer:dispose"
    ]));
    expect(disposals).toEqual(["av1"]);
    await expect(probe.dispose()).resolves.toBeUndefined();
  });

  it("disposes the probe without replacing the factory's canonical failure", async () => {
    const cleanupFailure = new Error("synthetic probe cleanup failure");
    const publicFailure = new AvalPlaybackError(Object.freeze({
      code: "unsupported-profile",
      message: "canonical startup failure",
      operation: "prepare"
    }), 1);
    const dispose = vi.spyOn(PlayerMediaCandidateProbe.prototype, "dispose")
      .mockRejectedValueOnce(cleanupFailure);
    const input = playerInput({
      sources: Object.freeze([]),
      onPlaybackFailure: () => publicFailure
    });

    await expect(createPlayer(input)).rejects.toBe(publicFailure);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

function candidate(
  input: Readonly<PlayerInput>,
  deadlines: PreparationDeadline[]
): Readonly<{
  probe: PlayerMediaCandidateProbe;
  request: Readonly<Parameters<PlayerMediaCandidateProbe["probe"]>[0]>;
}> {
  const deadline = PreparationDeadline.begin({
    parent: input.signal,
    timeoutMs: input.preparationTimeoutMs,
    platform: input.platform
  });
  deadlines.push(deadline);
  return Object.freeze({
    probe: new PlayerMediaCandidateProbe(input, deadline),
    request: Object.freeze({
      sourceInputIndex: 0,
      renditionIndex: 0,
      candidateRank: 0,
      publications: new PublicationGate(input),
      candidateReports: Object.freeze([]),
      decoderDiagnostics: Object.freeze([])
    })
  });
}

function playerInput(options: Readonly<{
  sources?: PlayerInput["sources"];
  onResourceBytes?: PlayerInput["onResourceBytes"];
  onPlaybackFailure?: PlayerInput["onPlaybackFailure"];
  visible?: boolean;
}> = {}): Readonly<PlayerInput> {
  const controller = new AbortController();
  const WorkerConstructor = options.visible === true
    ? class {} as unknown as typeof Worker : null;
  const VideoDecoderConstructor = options.visible === true
    ? class {} as unknown as typeof VideoDecoder : null;
  const VideoFrameConstructor = options.visible === true
    ? class {} as unknown as typeof VideoFrame : null;
  return Object.freeze({
    canvas: new EventTarget() as HTMLCanvasElement,
    platform: Object.freeze({
      fetch: globalThis.fetch,
      Worker: WorkerConstructor,
      VideoDecoder: VideoDecoderConstructor,
      VideoFrame: VideoFrameConstructor,
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
    sources: options.sources ?? Object.freeze([Object.freeze({
      src: "asset.avl",
      codec: "av1" as const,
      integrity: "",
      sourceIndex: 0
    })]),
    credentials: "same-origin" as const,
    signal: controller.signal,
    preparationTimeoutMs: 1_000,
    motion: "full" as const,
    reduced: false,
    initialState: null,
    initialBody: false,
    visible: options.visible ?? false,
    decoderReady: () => true,
    onResourceBytes: options.onResourceBytes ?? (() => undefined),
    onMetadata: () => undefined,
    onReadiness: () => undefined,
    onAnimationResourcesRetired: () => undefined,
    onDraw: () => undefined,
    onRestart: () => undefined,
    onEvent: () => undefined,
    onFailure: () => undefined,
    onPlaybackFailure: options.onPlaybackFailure ?? ((code, operation) =>
      new AvalPlaybackError(Object.freeze({
        code,
        message: "unused",
        operation
      }), 1))
  } satisfies PlayerInput);
}
