import { describe, expect, it } from "vitest";

import {
  createAval,
  getControllerRecord
} from "../src/controller.js";

describe("createAval", () => {
  it("immediately subscribes with the stable adapter status", () => {
    const aval = createAval(() => ({
      sources: { h264: "/motion.avl" }
    }));
    const received: object[] = [];

    const unsubscribe = aval.subscribe((status) => received.push(status));

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(getControllerRecord(aval).binding.getStatus());
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(received[0]).toMatchObject({
      mounted: false,
      readiness: "unready",
      paused: true,
      effectivelyVisible: false
    });
    unsubscribe();
    unsubscribe();
  });

  it("delegates its complete command surface to the opaque binding", () => {
    const aval = createAval(() => ({
      sources: { h264: "/motion.avl" }
    }));
    const { binding } = getControllerRecord(aval);

    expect(Object.isFrozen(aval)).toBe(true);
    expect(aval.prepare).toBe(binding.prepare);
    expect(aval.setState).toBe(binding.setState);
    expect(aval.send).toBe(binding.send);
    expect(aval.readyFor).toBe(binding.readyFor);
    expect(aval.play).toBe(binding.play);
    expect(aval.pause).toBe(binding.pause);
    expect(aval.getDiagnostics).toBe(binding.getDiagnostics);
  });

  it("retains safe pre-mount command behavior", async () => {
    const aval = createAval(() => ({
      sources: { h264: "/motion.avl" }
    }));

    expect(aval.send("retry")).toBe(false);
    expect(aval.readyFor("idle")).toBe(false);
    expect(aval.getDiagnostics()).toBeNull();
    expect(() => aval.pause()).not.toThrow();
    await expect(aval.prepare()).rejects.toMatchObject({
      name: "NotReadyError"
    });
    await expect(aval.setState("idle")).rejects.toMatchObject({
      name: "NotReadyError"
    });
    await expect(aval.play()).rejects.toMatchObject({
      name: "NotReadyError"
    });
  });

  it("rejects missing option getters and foreign controller objects", () => {
    expect(() => createAval(null as never)).toThrow(/option getter/u);
    expect(() => getControllerRecord(Object.freeze({
      subscribe() {
        return () => undefined;
      }
    }))).toThrow(/created by createAval/u);
  });
});
