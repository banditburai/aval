import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import AvalComponent from "../src/AvalComponent.svelte";
import { createAval } from "../src/controller.js";

describe("AvalComponent SSR", () => {
  it("renders deterministic inert player markup in codec priority order", () => {
    const aval = createAval(() => ({
      sources: {
        h264: "/h264.avl",
        av1: "/av1.avl",
        vp9: "/vp9.avl"
      },
      autoplay: false,
      autoBind: false
    }));

    const { body, head } = render(AvalComponent, {
      props: {
        aval,
        width: 160,
        height: 90,
        "aria-label": "Motion",
        "aria-hidden": true
      }
    });

    expect(head).toBe("");
    expect(body).toBe(
      '<!--[--><aval-player aria-label="Motion" aria-hidden="true" ' +
      'autoPlay="manual" bindings="none" width="160" height="90">' +
      '<!--[--><source src="/av1.avl" data-codec="av1"/>' +
      '<source src="/vp9.avl" data-codec="vp9"/>' +
      '<source src="/h264.avl" data-codec="h264"/>' +
      "<!--]--></aval-player><!--]-->"
    );
  });

  it("rejects controllers not created by createAval", () => {
    expect(() => render(AvalComponent, {
      props: {
        aval: Object.freeze({}) as never
      }
    }).body).toThrow(/created by createAval/u);
  });
});
