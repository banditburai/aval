import { describe, expect, it } from "vitest";
import { createAvalAdapterConfiguration } from "@pixel-point/aval-element/adapter";

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
    expect(Object.isFrozen(binding.commands)).toBe(true);
    expect(aval.prepare).toBe(binding.commands.prepare);
    expect(aval.setState).toBe(binding.commands.setState);
    expect(aval.send).toBe(binding.commands.send);
    expect(aval.readyFor).toBe(binding.commands.readyFor);
    expect(aval.play).toBe(binding.commands.play);
    expect(aval.pause).toBe(binding.commands.pause);
    expect(aval.getDiagnostics).toBe(binding.commands.getDiagnostics);

    const commands = binding.commands;
    binding.commit(createAvalAdapterConfiguration({
      sources: { h264: "/updated-motion.avl" },
      state: "engaged",
      autoplay: false,
      autoBind: false
    }));
    expect(binding.commands).toBe(commands);
    expect(aval.prepare).toBe(commands.prepare);
    expect(aval.getDiagnostics).toBe(commands.getDiagnostics);
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
