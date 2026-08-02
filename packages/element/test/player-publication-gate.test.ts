import { describe, expect, it, vi } from "vitest";

import { AvalPlaybackError } from "../src/errors.js";
import type {
  Metadata,
  PlayerInput
} from "../src/player-contract.js";
import { PublicationGate } from "../src/player-publication-gate.js";

const metadata = Object.freeze({
  initialState: "idle",
  stateNames: Object.freeze(["idle"]),
  eventNames: Object.freeze([]),
  bindings: Object.freeze([]),
  canvas: Object.freeze({
    width: 1,
    height: 1,
    pixelAspect: Object.freeze([1, 1] as const),
    fit: "contain" as const
  })
}) satisfies Readonly<Metadata>;

describe("PublicationGate", () => {
  it("publishes buffered callbacks in order only after activation", () => {
    const events: string[] = [];
    const target = input(events);
    const gate = new PublicationGate(target, provisionalFailure);

    gate.input.onMetadata(metadata);
    gate.input.onReadiness("interactiveReady");
    expect(events).toEqual([]);
    gate.activate();
    gate.commit();

    expect(events).toEqual(["metadata", "readiness:interactiveReady"]);
  });

  it("keeps resource and diagnostic accounting immediate", () => {
    const events: string[] = [];
    const target = input(events);
    const gate = new PublicationGate(target);

    gate.input.onResourceBytes(42);
    gate.input.onDecoderDiagnostics?.([]);
    gate.input.onRendererDiagnostics?.([]);

    expect(events).toEqual(["resources:42", "decoders", "renderers"]);
  });

  it("replaces provisional playback failure only when committed", () => {
    const target = input([]);
    const gate = new PublicationGate(target, provisionalFailure);

    expect(gate.input.onPlaybackFailure("renderer-failure", "prepare").failure)
      .toMatchObject({ message: "provisional" });
    gate.commit();
    expect(gate.input.onPlaybackFailure("renderer-failure", "prepare").failure)
      .toMatchObject({ message: "target" });
  });

  it("selectively drops animated presentation and retains static callbacks", () => {
    const events: string[] = [];
    const gate = new PublicationGate(input(events));

    gate.input.onMetadata(metadata);
    gate.input.onReadiness("visualReady");
    gate.input.onReadiness("staticReady", "reduced-motion");
    gate.input.onDraw();
    gate.input.onEvent("settled", {});
    gate.input.onFailure("underflow", "playback", false);
    gate.discardAnimatedPresentation();
    gate.activate();

    expect(events).toEqual([
      "metadata",
      "readiness:staticReady",
      "event:settled",
      "failure:underflow"
    ]);
  });

  it("fully discards an unpublished candidate and makes cleanup repetition safe", () => {
    const events: string[] = [];
    const gate = new PublicationGate(input(events));

    gate.input.onMetadata(metadata);
    gate.discard();
    expect(() => {
      gate.discard();
      gate.discardAnimatedPresentation();
      gate.activate();
      gate.commit();
    }).not.toThrow();
    expect(events).toEqual([]);
  });

  it("treats discard operations after activation as idempotent no-ops", () => {
    const events: string[] = [];
    const gate = new PublicationGate(input(events));

    gate.input.onMetadata(metadata);
    gate.activate();
    gate.discardAnimatedPresentation();
    gate.discard();
    gate.input.onDraw();

    expect(events).toEqual(["metadata", "draw"]);
  });

  it("drains buffered and reentrant publications in FIFO order before rethrowing", () => {
    const events: string[] = [];
    const failure = new Error("readiness callback failed");
    const laterFailure = new Error("draw callback failed");
    const base = input(events);
    let gate: PublicationGate;
    const target = Object.freeze({
      ...base,
      onMetadata: () => {
        events.push("metadata");
        gate.input.onEvent("reentrant", {});
      },
      onReadiness: (value: string) => {
        events.push(`readiness:${value}`);
        throw failure;
      },
      onDraw: () => {
        events.push("draw");
        throw laterFailure;
      },
      onEvent: (type: string) => events.push(`event:${type}`)
    } satisfies PlayerInput);
    gate = new PublicationGate(target);
    gate.input.onMetadata(metadata);
    gate.input.onReadiness("interactiveReady");
    gate.input.onDraw();

    expect(() => gate.activate()).toThrow(failure);
    expect(events).toEqual([
      "metadata",
      "readiness:interactiveReady",
      "draw",
      "event:reentrant"
    ]);

    gate.input.onRestart("idle");
    expect(events.at(-1)).toBe("restart:idle");
    expect(() => gate.activate()).not.toThrow();
  });
});

function input(events: string[]): Readonly<PlayerInput> {
  const playbackFailure = (
    code: Parameters<PlayerInput["onPlaybackFailure"]>[0],
    operation: string
  ): AvalPlaybackError => new AvalPlaybackError(Object.freeze({
    code,
    message: "target",
    operation
  }), 1);
  return Object.freeze({
    canvas: {} as HTMLCanvasElement,
    platform: {
      fetch: globalThis.fetch,
      Worker: null,
      VideoDecoder: null,
      VideoFrame: null,
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
      now: () => 0,
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      crypto: globalThis.crypto
    },
    initialPresentation: {
      width: 1,
      height: 1,
      dpr: 1,
      fit: "contain" as const
    },
    baseUrl: "https://example.test/",
    sources: [],
    credentials: "same-origin",
    signal: new AbortController().signal,
    preparationTimeoutMs: 1_000,
    motion: "auto",
    reduced: false,
    initialState: null,
    initialBody: false,
    visible: true,
    decoderReady: () => true,
    onResourceBytes: (bytes) => events.push(`resources:${String(bytes)}`),
    onMetadata: () => events.push("metadata"),
    onReadiness: (value) => events.push(`readiness:${value}`),
    onAnimationResourcesRetired: () => events.push("retired"),
    onDraw: () => events.push("draw"),
    onRestart: (state) => events.push(`restart:${state}`),
    onEvent: (type) => events.push(`event:${type}`),
    onFailure: (code) => events.push(`failure:${code}`),
    onPlaybackFailure: playbackFailure,
    onDecoderDiagnostics: () => events.push("decoders"),
    onRendererDiagnostics: () => events.push("renderers")
  } satisfies PlayerInput);
}

function provisionalFailure(
  code: Parameters<PlayerInput["onPlaybackFailure"]>[0],
  operation: string
): AvalPlaybackError {
  return new AvalPlaybackError(Object.freeze({
    code,
    message: "provisional",
    operation
  }), 1);
}
