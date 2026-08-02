import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ loads: 0 }));

vi.mock("../src/player.js", () => {
  runtime.loads += 1;
  return {
    createPlayer: () => Promise.reject(new Error("runtime should stay lazy"))
  };
});

describe("element root", () => {
  it("imports without DOM globals or registration side effects", async () => {
    const before = Reflect.get(globalThis, "customElements");
    const module = await import("../src/index.js");
    expect(module.AVAL_TAG_NAME).toBe("aval-player");
    expect(runtime.loads).toBe(0);
    expect(Reflect.get(globalThis, "customElements")).toBe(before);
    expect(() => module.defineAvalElement()).toThrowError(
      expect.objectContaining({ name: "NotSupportedError" })
    );
  });
});
