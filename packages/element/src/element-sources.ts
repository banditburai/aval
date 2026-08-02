import { normalizeIntegrity, normalizeSource } from "./element-configuration.js";
import type { Source } from "./player-contract.js";
import {
  compareSourceCodec,
  sourceCodec
} from "./source-codec-policy.js";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SOURCE_ATTRIBUTES = new Set(["src", "data-codec", "integrity"]);

export interface SourceFailure {
  readonly sourceIndex: number;
  readonly attribute: "src" | "data-codec" | "integrity";
}

export interface SourceRead {
  readonly sources: readonly Readonly<Source>[];
  readonly failures: readonly Readonly<SourceFailure>[];
}

/** Reads and validates the host's direct HTML `<source>` children. */
export function readElementSources(host: Element): Readonly<SourceRead> {
  const sources: Readonly<Source>[] = [];
  const codecDeclarations: Array<Readonly<{
    codec: Source["codec"];
    sourceIndex: number;
  }>> = [];
  const failures: Readonly<SourceFailure>[] = [];
  let sourceIndex = 0;

  const children = host.children;
  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const element = children.item(childIndex);
    if (element === null || !isHtmlSource(element)) continue;

    let src = "";
    let codec: Source["codec"] | undefined;
    let integrity = "";
    let valid = true;
    try { src = normalizeSource(element.getAttribute("src") ?? ""); }
    catch {
      valid = false;
      failures.push(Object.freeze({ sourceIndex, attribute: "src" }));
    }
    try {
      codec = sourceCodec(element.getAttribute("data-codec"));
      if (codec === undefined) throw new TypeError();
      codecDeclarations.push(Object.freeze({ codec, sourceIndex }));
    } catch {
      valid = false;
      failures.push(Object.freeze({ sourceIndex, attribute: "data-codec" }));
    }
    try {
      const value = element.getAttribute("integrity");
      integrity = value === null ? "" : normalizeIntegrity(value);
    } catch {
      valid = false;
      failures.push(Object.freeze({ sourceIndex, attribute: "integrity" }));
    }
    if (valid && codec !== undefined) {
      sources.push(Object.freeze({ src, codec, integrity, sourceIndex }));
    }
    sourceIndex += 1;
  }

  const codecCounts = new Map<Source["codec"], number>();
  for (const declaration of codecDeclarations) {
    codecCounts.set(
      declaration.codec,
      (codecCounts.get(declaration.codec) ?? 0) + 1
    );
  }
  const duplicateCodecs = new Set(
    [...codecCounts]
      .filter(([, count]) => count > 1)
      .map(([codec]) => codec)
  );
  for (const declaration of codecDeclarations) {
    if (!duplicateCodecs.has(declaration.codec)) continue;
    failures.push(Object.freeze({
      sourceIndex: declaration.sourceIndex,
      attribute: "data-codec"
    }));
  }

  failures.sort((left, right) => left.sourceIndex - right.sourceIndex);
  const prioritized = sources
    .filter((source) => !duplicateCodecs.has(source.codec))
    .sort((left, right) => compareSourceCodec(left.codec, right.codec));
  return Object.freeze({
    sources: Object.freeze(prioritized),
    failures: Object.freeze(failures)
  });
}

/** Reports whether a mutation can change the host's direct source set. */
export function isElementSourceMutation(
  host: Element,
  record: MutationRecord
): boolean {
  if (record.type === "childList") {
    return record.target === host &&
      [...record.addedNodes, ...record.removedNodes].some((node) =>
        node.nodeType === 1 && isHtmlSource(node as Element)
      );
  }
  if (
    record.type !== "attributes" ||
    record.attributeName !== null && record.attributeName !== undefined &&
      !SOURCE_ATTRIBUTES.has(record.attributeName)
  ) return false;
  const target = record.target as Element;
  return isHtmlSource(target) && target.parentElement === host;
}

function isHtmlSource(element: Element): boolean {
  return element.localName === "source" &&
    element.namespaceURI === HTML_NAMESPACE;
}
