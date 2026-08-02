import { describe, expect, it, vi } from "vitest";

import {
  createAvalAdapterConfiguration,
  normalizeAvalSources,
  sameAvalRenderOptions,
  type AvalSources
} from "../src/adapter-options.js";
import type {
  AvalCrossOrigin,
  AvalFit,
  AvalMotion
} from "../src/public-types.js";

describe("AVAL adapter options", () => {
  it("normalizes URL strings in fixed codec priority", () => {
    expect(normalizeAvalSources({
      h264: "/motion/h264.avl",
      av1: "/motion/av1.avl",
      h265: "/motion/h265.avl",
      vp9: "/motion/vp9.avl"
    })).toEqual([
      { codec: "av1", src: "/motion/av1.avl" },
      { codec: "vp9", src: "/motion/vp9.avl" },
      { codec: "h265", src: "/motion/h265.avl" },
      { codec: "h264", src: "/motion/h264.avl" }
    ]);
  });

  it("rejects invalid runtime source shapes", () => {
    expect(() => normalizeAvalSources({} as AvalSources)).toThrow(
      /at least one codec URL/u
    );
    expect(() => normalizeAvalSources(null as unknown as AvalSources)).toThrow(
      /codec-keyed object/u
    );
    expect(() => normalizeAvalSources([] as unknown as AvalSources)).toThrow(
      /codec-keyed object/u
    );
    expect(() => normalizeAvalSources({ h264: "  " })).toThrow(
      /non-empty URL string/u
    );
    expect(() => normalizeAvalSources({
      h264: { src: "/motion.avl" }
    } as unknown as AvalSources)).toThrow(/URL string/u);
    expect(() => normalizeAvalSources({
      gif: "/motion.gif"
    } as unknown as AvalSources)).toThrow(/unsupported/u);
    expect(() => normalizeAvalSources({
      h264: undefined
    } as unknown as AvalSources)).toThrow(/URL string/u);
    expect(() => normalizeAvalSources({
      h264: "/motion.avl",
      [Symbol("codec")]: "/symbol.avl"
    } as unknown as AvalSources)).toThrow(/unsupported/u);
  });

  it("validates adapter booleans and applies their defaults", () => {
    expect(createAvalAdapterConfiguration({
      sources: { h264: "/motion.avl" }
    }).render).toMatchObject({ autoplay: "visible", bindings: "auto" });
    const manual = createAvalAdapterConfiguration({
      sources: { h264: "/motion.avl" },
      autoplay: false,
      autoBind: false
    }).render;
    expect(manual).toMatchObject({ autoplay: "manual", bindings: "none" });
    expect(manual).not.toHaveProperty("autoBind");
    expect(() => createAvalAdapterConfiguration({
      sources: { h264: "/motion.avl" },
      autoplay: "yes"
    } as unknown as Parameters<typeof createAvalAdapterConfiguration>[0]))
      .toThrow(/autoplay must be a boolean/u);
    expect(() => createAvalAdapterConfiguration({
      sources: { h264: "/motion.avl" },
      autoBind: 1
    } as unknown as Parameters<typeof createAvalAdapterConfiguration>[0]))
      .toThrow(/autoBind must be a boolean/u);
  });

  it("separates callbacks from semantic render options", () => {
    const onError = vi.fn();
    const configuration = createAvalAdapterConfiguration({
      sources: { h264: "/motion.avl" },
      onError
    });

    expect(configuration.callbacks.onError).toBe(onError);
    expect(configuration.render).not.toHaveProperty("onError");
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.render)).toBe(true);
    expect(Object.isFrozen(configuration.callbacks)).toBe(true);
  });

  it("passes element-owned option values through without duplicating policy", () => {
    const configuration = createAvalAdapterConfiguration({
      sources: { h264: "/motion.avl" },
      motion: "future-motion" as AvalMotion,
      fit: "future-fit" as AvalFit,
      crossOrigin: "future-origin" as AvalCrossOrigin
    });

    expect(configuration.render).toMatchObject({
      motion: "future-motion",
      fit: "future-fit",
      crossOrigin: "future-origin"
    });
  });

  it("uses stable source keys and compares render options semantically", () => {
    const first = createAvalAdapterConfiguration({
      sources: { h264: "/motion.avl", av1: "/motion-av1.avl" }
    });
    const second = createAvalAdapterConfiguration({
      sources: { av1: "/motion-av1.avl", h264: "/motion.avl" }
    });
    const changed = createAvalAdapterConfiguration({
      sources: { h264: "/other.avl", av1: "/motion-av1.avl" }
    });
    const changedTokens = createAvalAdapterConfiguration({
      sources: { h264: "/motion.avl", av1: "/motion-av1.avl" },
      autoplay: false,
      autoBind: false
    });

    expect(first.render.sourceKey).toBe(second.render.sourceKey);
    expect(first.render).not.toBe(second.render);
    expect(sameAvalRenderOptions(first.render, second.render)).toBe(true);
    expect(sameAvalRenderOptions(first.render, changed.render)).toBe(false);
    expect(sameAvalRenderOptions(first.render, changedTokens.render)).toBe(
      false
    );
  });
});
