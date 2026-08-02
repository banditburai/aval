import { describe, expect, it } from "vitest";

import {
  isElementSourceMutation,
  readElementSources
} from "../src/element-sources.js";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

describe("element sources", () => {
  it("validates, de-duplicates, and prioritizes direct HTML sources", () => {
    const host = element("aval-player", [
      source("/h264.avl", "h264"),
      source("/invalid-src\navl", "av1"),
      source("/vp9.avl", "vp9"),
      source("/duplicate-vp9.avl", "vp9"),
      element("div", [source("/nested.avl", "av1")]),
      source("/h265.avl", "h265")
    ]);

    const read = readElementSources(host);

    expect(read.sources).toEqual([
      { src: "/h265.avl", codec: "h265", integrity: "", sourceIndex: 4 },
      { src: "/h264.avl", codec: "h264", integrity: "", sourceIndex: 0 }
    ]);
    expect(read.failures).toEqual([
      { sourceIndex: 1, attribute: "src" },
      { sourceIndex: 2, attribute: "data-codec" },
      { sourceIndex: 3, attribute: "data-codec" }
    ]);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.sources)).toBe(true);
    expect(Object.isFrozen(read.failures)).toBe(true);
  });

  it("normalizes absent integrity and rejects missing or invalid attributes", () => {
    const canonicalIntegrity = `sha256-${"A".repeat(42)}A=`;
    const host = element("aval-player", [
      source(null, "av1"),
      source("/codec.avl", "AV1"),
      source("/integrity.avl", "h264", `sha256-${"A".repeat(42)}B=`),
      source("/valid.avl", "vp9", canonicalIntegrity)
    ]);

    expect(readElementSources(host)).toEqual({
      sources: [{
        src: "/valid.avl",
        codec: "vp9",
        integrity: canonicalIntegrity,
        sourceIndex: 3
      }],
      failures: [
        { sourceIndex: 0, attribute: "src" },
        { sourceIndex: 1, attribute: "data-codec" },
        { sourceIndex: 2, attribute: "integrity" }
      ]
    });
  });

  it("recognizes only direct source membership and relevant source attributes", () => {
    const direct = source("/direct.avl", "av1");
    const nested = source("/nested.avl", "vp9");
    const container = element("div", [nested]);
    const host = element("aval-player", [direct, container]);
    const unrelated = element("span");

    expect(isElementSourceMutation(host, mutation("childList", host, {
      addedNodes: [direct]
    }))).toBe(true);
    expect(isElementSourceMutation(host, mutation("childList", host, {
      removedNodes: [direct]
    }))).toBe(true);
    expect(isElementSourceMutation(host, mutation("childList", host, {
      addedNodes: [unrelated]
    }))).toBe(false);
    expect(isElementSourceMutation(host, mutation("childList", container, {
      addedNodes: [nested]
    }))).toBe(false);
    expect(isElementSourceMutation(host, mutation(
      "attributes",
      direct,
      { attributeName: "src" }
    ))).toBe(true);
    expect(isElementSourceMutation(host, mutation(
      "attributes",
      direct,
      { attributeName: "class" }
    ))).toBe(false);
    expect(isElementSourceMutation(host, mutation("attributes", nested))).toBe(false);
  });
});

function element(
  localName: string,
  children: readonly Element[] = [],
  attributes: Readonly<Record<string, string>> = {}
): Element {
  const value = {
    nodeType: 1,
    localName,
    namespaceURI: HTML_NAMESPACE,
    parentElement: null,
    children: {
      length: children.length,
      item: (index: number) => children[index] ?? null
    },
    getAttribute: (name: string) => attributes[name] ?? null
  } as unknown as Element;
  for (const child of children) {
    (child as unknown as { parentElement: Element | null }).parentElement = value;
  }
  return value;
}

function source(
  src: string | null,
  codec: string,
  integrity?: string
): Element {
  return element("source", [], {
    ...(src === null ? {} : { src }),
    "data-codec": codec,
    ...(integrity === undefined ? {} : { integrity })
  });
}

function mutation(
  type: "attributes" | "childList",
  target: Node,
  nodes: Readonly<{
    addedNodes?: readonly Node[];
    removedNodes?: readonly Node[];
    attributeName?: string;
  }> = {}
): MutationRecord {
  return {
    type,
    target,
    addedNodes: nodes.addedNodes ?? [],
    removedNodes: nodes.removedNodes ?? [],
    attributeName: nodes.attributeName
  } as unknown as MutationRecord;
}
