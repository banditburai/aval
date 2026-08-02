import { afterEach, describe, expect, it, vi } from "vitest";

import { AvalPlaybackError } from "../src/errors.js";
import type { PlayerInput } from "../src/player-contract.js";
import { PlayerMediaCandidateProbe } from
  "../src/player-media-candidate.js";
import { PublicationGate } from "../src/player-publication-gate.js";
import { PreparationDeadline } from "../src/preparation-deadline.js";
import {
  CODECS,
  SyntheticAsset
} from "./support/provisional-startup-harness.js";

const ownership = vi.hoisted(() => ({
  asset: null as SyntheticAsset | null,
  mediaOperations: [] as string[],
  nextRunId: 1
}));

vi.mock("../src/asset.js", () => ({
  Asset: class {
    public static async open(): Promise<SyntheticAsset> {
      if (ownership.asset === null) throw new Error("missing synthetic asset");
      return ownership.asset;
    }
  }
}));

vi.mock("../src/codec-validator.js", () => ({
  createCodecValidator: () => ({
    validate: () => undefined,
    complete: () => undefined
  })
}));

vi.mock("../src/decoder-pool.js", () => {
  class SyntheticRun {
    public readonly frameCount: number;
    public readonly id = ownership.nextRunId++;
    public closed = false;

    public constructor(frameCount: number) { this.frameCount = frameCount; }
    public async ready(): Promise<void> {
      ownership.mediaOperations.push(`run-ready:${String(this.id)}`);
    }
    public async take(index: number): Promise<VideoFrame> {
      ownership.mediaOperations.push(
        `run-take:${String(this.id)}@${String(index)}`
      );
      return Object.freeze({ index }) as unknown as VideoFrame;
    }
    public release(_frame: VideoFrame): void {
      ownership.mediaOperations.push(`run-release:${String(this.id)}`);
    }
    public async complete(): Promise<void> {}
    public close(): void {
      if (this.closed) return;
      this.closed = true;
      ownership.mediaOperations.push(`run-close:${String(this.id)}`);
    }
  }

  return {
    DecoderPool: class {
      public readonly encodedBytes = 0;
      public readonly candidateAvailable = true;
      public async supported(): Promise<boolean> {
        ownership.mediaOperations.push("decoder-supported");
        return true;
      }
      public failure(): Promise<never> {
        return new Promise(() => undefined);
      }
      public createForegroundRun(
        samples: readonly unknown[]
      ): SyntheticRun {
        ownership.mediaOperations.push("run-create:foreground");
        return new SyntheticRun(samples.length);
      }
      public createCandidate(): never {
        throw new Error("candidate route was not expected");
      }
      public identity(run: SyntheticRun): Readonly<{
        logicalId: number;
        lane: 0;
      }> {
        return Object.freeze({ logicalId: run.id, lane: 0 as const });
      }
      public snapshot() {
        return Object.freeze({
          workerCount: 2,
          openFrames: 0,
          openFrameBytes: 0,
          playbackLifecycle: Object.freeze({
            outputsAccepted: 1,
            drawsCompleted: 0,
            logicalRunsCreated: 1,
            candidateCommits: 0,
            runsClosed: 0,
            transitionStarts: 0,
            transitionEnds: 0,
            loopCrossings: 0,
            nativeDecoderCreatesByLane: Object.freeze([1, 1]),
            nativeDecoderClosesByLane: Object.freeze([0, 0])
          }),
          decoderDiagnostics: Object.freeze([])
        });
      }
      public dispose(): void {
        ownership.mediaOperations.push("decoder-dispose");
      }
    }
  };
});

vi.mock("../src/renderer.js", () => ({
  Renderer: class {
    public constructor() {
      ownership.mediaOperations.push("renderer-create");
    }
    public admit(): Readonly<{ textureBytes: number; runtimeBytes: number }> {
      ownership.mediaOperations.push("renderer-admit");
      return Object.freeze({ textureBytes: 0, runtimeBytes: 0 });
    }
    public async inspectAndPrime(): Promise<void> {}
    public async store(): Promise<void> {}
    public async drawStored(): Promise<void> {}
    public async draw(_frame: VideoFrame, qualifiesRun: boolean): Promise<void> {
      ownership.mediaOperations.push(`renderer-draw:${String(qualifiesRun)}`);
    }
    public resize(): void {}
    public async settled(): Promise<void> {}
    public snapshot() {
      return Object.freeze({
        backendDetails: Object.freeze({
          kind: "webgl2" as const,
          uploadMode: "native" as const,
          nativeProbeAttempts: 1,
          probeReadbackBytes: 0,
          nativeProbeInFlight: false
        }),
        cssWidth: 16,
        cssHeight: 16,
        backingWidth: 16,
        backingHeight: 16,
        effectiveDprX: 1,
        effectiveDprY: 1,
        contextLossCount: 0,
        contextRecoveryCount: 0,
        stagingBytes: 0,
        residentBytes: 0,
        textureBytes: 0,
        runtimeBytes: 0,
        pendingOperations: 0,
        sourceCopiesInFlight: 0,
        resourceCount: 1,
        contextListenerCount: 1,
        failure: null
      });
    }
    public dispose(): void {
      ownership.mediaOperations.push("renderer-dispose");
    }
  }
}));

afterEach(() => vi.unstubAllGlobals());

describe("PlayerMediaRuntime ownership", () => {
  it("transfers one probed asset and retires it exactly once", async () => {
    const disposals: string[] = [];
    const operations: string[] = [];
    ownership.asset = new SyntheticAsset({
      disposals,
      operations,
      cleanupFailures: new Set(),
      witnessFrames: new Map()
    }, "av1", CODECS.av1);
    const resources: number[] = [];
    let retirements = 0;
    const input = playerInput(resources, () => { retirements += 1; });
    const deadline = PreparationDeadline.begin({
      parent: input.signal,
      timeoutMs: input.preparationTimeoutMs,
      platform: input.platform
    });
    const publications = new PublicationGate(input);
    const probe = new PlayerMediaCandidateProbe(input, deadline);

    const result = await probe.probe(Object.freeze({
      sourceInputIndex: 0,
      renditionIndex: 0,
      candidateRank: 0,
      candidateReports: Object.freeze([]),
      decoderDiagnostics: Object.freeze([]),
      publications
    }));

    expect(result.kind).toBe("candidate");
    if (result.kind !== "candidate") throw new Error("candidate expected");
    expect(Object.isFrozen(result.media.descriptor)).toBe(true);
    expect(Object.isFrozen(result.media.descriptor.metadata)).toBe(true);
    expect(Object.isFrozen(
      result.media.descriptor.metadata.canvas.pixelAspect
    )).toBe(true);
    expect(Object.isFrozen(result.media.descriptor.graph)).toBe(true);
    expect(Object.isFrozen(result.media.descriptor.graph.states)).toBe(true);
    expect(Object.isFrozen(result.media.descriptor.graph.states[0])).toBe(true);
    expect(Object.isFrozen(
      result.media.descriptor.graph.states[0]?.body
    )).toBe(true);
    expect(Object.isFrozen(
      result.media.descriptor.graph.states[0]?.body.ports
    )).toBe(true);
    expect(Object.isFrozen(result.media.descriptor.graph.edges)).toBe(true);
    expect(result.media.descriptor.rendition).toEqual(expect.objectContaining({
      id: "main",
      codec: CODECS.av1,
      sourceIndex: 0
    }));

    publications.activate();
    await result.media.retire();
    await result.media.retire();
    await probe.dispose();

    expect(disposals).toEqual(["av1"]);
    expect(retirements).toBe(1);
    expect(resources.at(-1)).toBe(0);
  });

  it("prepares, leases, draws, and retires animated media directly", async () => {
    const disposals: string[] = [];
    const assetOperations: string[] = [];
    ownership.mediaOperations.length = 0;
    ownership.nextRunId = 1;
    ownership.asset = new SyntheticAsset({
      disposals,
      operations: assetOperations,
      cleanupFailures: new Set(),
      witnessFrames: new Map()
    }, "av1", CODECS.av1);
    const resources: number[] = [];
    let draws = 0;
    let retirements = 0;
    const input = playerInput(
      resources,
      () => { retirements += 1; },
      { visible: true, onDraw: () => { draws += 1; } }
    );
    const deadline = PreparationDeadline.begin({
      parent: input.signal,
      timeoutMs: input.preparationTimeoutMs,
      platform: input.platform
    });
    const publications = new PublicationGate(input);
    const probe = new PlayerMediaCandidateProbe(input, deadline);
    const result = await probe.probe(Object.freeze({
      sourceInputIndex: 0,
      renditionIndex: 0,
      candidateRank: 0,
      candidateReports: Object.freeze([]),
      decoderDiagnostics: Object.freeze([]),
      publications
    }));

    expect(result.kind).toBe("candidate");
    if (result.kind !== "candidate") throw new Error("candidate expected");
    expect(result.requiresQualification).toBe(true);
    publications.activate();
    await result.media.qualifyOutput(deadline.signal);
    await result.media.prepare(Object.freeze({
      initialState: "av1",
      initialBody: false,
      signal: deadline.signal
    }));
    const presentation = Object.freeze({
      kind: "body" as const,
      state: "av1",
      unitId: "av1-body",
      frameIndex: 0
    });
    const acquisition = result.media.acquirePresentation(presentation);

    expect(acquisition.kind).toBe("ready");
    if (acquisition.kind !== "ready") throw new Error("lease expected");
    const draw = await result.media.draw(Object.freeze({
      presentation,
      lease: acquisition.lease
    }));

    expect(draw.receipt).toEqual(expect.objectContaining({
      drew: true,
      unitId: "av1-body",
      localFrame: 0,
      logicalRunId: 1
    }));
    expect(draws).toBe(1);
    expect(ownership.mediaOperations).toEqual([
      "decoder-supported",
      "renderer-create",
      "renderer-admit",
      "run-create:foreground",
      "run-ready:1",
      "run-take:1@0",
      "renderer-draw:true"
    ]);

    result.media.finalizeDraw(draw.finalization);
    result.media.finalizeDraw(draw.finalization);

    expect(ownership.mediaOperations.at(-1)).toBe("run-release:1");

    await result.media.retire();
    await result.media.retire();
    await probe.dispose();

    expect(disposals).toEqual(["av1"]);
    expect(assetOperations).toContain("asset-fetch:av1");
    expect(ownership.mediaOperations.slice(-3)).toEqual([
      "run-close:1",
      "decoder-dispose",
      "renderer-dispose"
    ]);
    expect(retirements).toBe(1);
    expect(resources.at(-1)).toBe(0);
  });
});

function playerInput(
  resources: number[],
  onRetired: () => void,
  options: Readonly<{
    visible?: boolean;
    onDraw?: () => void;
  }> = {}
): Readonly<PlayerInput> {
  const controller = new AbortController();
  if (options.visible) {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    vi.stubGlobal("VideoFrame", class {});
  }
  const platform: PlayerInput["platform"] = Object.freeze({
    fetch: globalThis.fetch,
    Worker: options.visible ? globalThis.Worker : null,
    VideoDecoder: options.visible ? globalThis.VideoDecoder : null,
    VideoFrame: options.visible ? globalThis.VideoFrame : null,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    now: () => 0,
    setTimeout: (callback, delay) =>
      globalThis.setTimeout(callback, delay) as unknown as number,
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    crypto: globalThis.crypto
  });
  return Object.freeze({
    canvas: new EventTarget() as HTMLCanvasElement,
    platform,
    initialPresentation: Object.freeze({
      width: 16,
      height: 16,
      dpr: 1,
      fit: "contain" as const
    }),
    baseUrl: "https://example.test/",
    sources: Object.freeze([Object.freeze({
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
    onResourceBytes: (bytes) => resources.push(bytes),
    onMetadata: () => undefined,
    onReadiness: () => undefined,
    onAnimationResourcesRetired: onRetired,
    onDraw: options.onDraw ?? (() => undefined),
    onRestart: () => undefined,
    onEvent: () => undefined,
    onFailure: () => undefined,
    onPlaybackFailure: (code, operation) => new AvalPlaybackError(Object.freeze({
      code,
      message: "unused",
      operation
    }), 1)
  } satisfies PlayerInput);
}
