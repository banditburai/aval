import type { Unit } from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import type { DecodeRun } from "../src/decoder.js";
import type { DecoderPoolCandidate } from "../src/decoder-pool.js";
import { PlayerMediaStreamOwner } from "../src/player-media-stream.js";

describe("PlayerMediaStreamOwner", () => {
  it("keeps a drawn frame and lease alive until its opaque finalization", async () => {
    const operations: string[] = [];
    const run = decodeRun(operations);
    const owner = new PlayerMediaStreamOwner();
    owner.installInitial(UNIT, run);
    const lease = owner.acquire(UNIT, null);
    const reservation = owner.reservation(lease);
    const active = owner.streamFor(UNIT, 0, reservation);
    owner.commitStream(active, reservation, () => {
      throw new Error("initial media cannot commit a candidate");
    });

    const release = await owner.drawStreamFrame(
      active,
      0,
      async (_frame, newDecoderRun) => {
        operations.push(`draw:${String(newDecoderRun)}`);
      },
      (_ownedRun, frame) => operations.push(`release:${frameLabel(frame)}`)
    );
    const finalization = owner.holdFinalization(lease, release);

    expect(operations).toEqual(["take:0", "draw:true"]);
    owner.finalize(Object.freeze({ token: Symbol("forged") }));
    expect(operations).toEqual(["take:0", "draw:true"]);

    owner.finalize(finalization);
    owner.finalize(finalization);

    expect(operations).toEqual(["take:0", "draw:true", "release:0"]);
    expect(() => owner.reservation(lease)).toThrow("Invalid AVAL media lease");

    await owner.retire();
    await owner.retire();
    expect(operations).toEqual([
      "take:0",
      "draw:true",
      "release:0",
      "close"
    ]);
  });

  it("finalizes held frames before retiring a committed candidate run", async () => {
    const operations: string[] = [];
    const run = decodeRun(operations);
    const candidate = decoderCandidate("next", run, operations);
    const owner = new PlayerMediaStreamOwner();
    const unit = Object.freeze({ ...UNIT, id: "next" });
    const lease = owner.acquire(unit, candidate);
    const reservation = owner.reservation(lease);
    const active = owner.streamFor(unit, 0, reservation);
    owner.commitStream(active, reservation, (committed) => {
      operations.push(`installed:${committed.unitId}`);
    });
    owner.holdFinalization(lease, () => operations.push("release:held"));

    await owner.retire();

    expect(operations).toEqual([
      "candidate:commit",
      "installed:next",
      "release:held",
      "close"
    ]);
  });

  it("releases skipped and failed frames without transferring ownership", async () => {
    const operations: string[] = [];
    const run = decodeRun(operations);
    const owner = new PlayerMediaStreamOwner();
    owner.installInitial(UNIT, run);
    const lease = owner.acquire(UNIT, null);
    const reservation = owner.reservation(lease);
    const active = owner.streamFor(UNIT, 2, reservation);
    owner.commitStream(active, reservation, () => undefined);

    await expect(owner.drawStreamFrame(
      active,
      2,
      async () => {
        operations.push("draw:failed");
        throw new Error("draw failed");
      },
      (_ownedRun, frame) => operations.push(`release:${frameLabel(frame)}`)
    )).rejects.toThrow("draw failed");

    expect(operations).toEqual([
      "take:0",
      "release:0",
      "take:1",
      "release:1",
      "take:2",
      "draw:failed",
      "release:2"
    ]);
    owner.cancel(lease);
    expect(operations.at(-1)).toBe("close");
  });

  it("drains every retirement authority when one finalizer fails", async () => {
    const operations: string[] = [];
    const owner = new PlayerMediaStreamOwner();
    owner.installInitial(UNIT, decodeRun(operations));
    const failure = new Error("release failed");
    owner.holdFinalization(null, () => {
      operations.push("release:failed");
      throw failure;
    });
    owner.holdFinalization(null, () => operations.push("release:remaining"));

    await expect(owner.retire()).rejects.toBe(failure);
    await expect(owner.retire()).resolves.toBeUndefined();

    expect(operations).toEqual([
      "release:failed",
      "release:remaining",
      "close"
    ]);
  });
});

const UNIT = Object.freeze({
  id: "idle",
  kind: "body" as const,
  playback: "loop" as const,
  frameCount: 3,
  ports: Object.freeze([Object.freeze({
    id: "entry",
    entryFrame: 0 as const,
    portalFrames: Object.freeze([0])
  })]),
  chunks: Object.freeze([])
}) satisfies Unit;

function decodeRun(operations: string[]): DecodeRun {
  return Object.freeze({
    take: async (index: number) => {
      operations.push(`take:${String(index)}`);
      return Object.freeze({ index }) as unknown as VideoFrame;
    },
    close: () => operations.push("close")
  }) as unknown as DecodeRun;
}

function decoderCandidate(
  unitId: string,
  run: DecodeRun,
  operations: string[]
): DecoderPoolCandidate {
  return Object.freeze({
    unitId,
    run,
    ready: async () => undefined,
    commit: () => operations.push("candidate:commit"),
    cancel: () => operations.push("candidate:cancel")
  });
}

function frameLabel(frame: VideoFrame): string {
  return String((frame as unknown as { readonly index: number }).index);
}
