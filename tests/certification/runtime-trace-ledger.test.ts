import { describe, expect, it } from "vitest";

import { PublicRuntimeTraceCollector } from "../../apps/playground/src/certification/runtime-trace-ledger.js";

describe("public runtime trace collector", () => {
  it("primes a post-warm-up cursor without grading earlier underflows", () => {
    const collector = new PublicRuntimeTraceCollector();
    collector.prime([{ index: 5, kind: "content-tick" }]);
    expect(collector.drain([{ index: 5, kind: "content-tick" }])).toBe(0);
    expect(collector.snapshot().coverage).toMatchObject({ frameCount: 0, underflows: 0, traceGaps: 0 });
  });
  it("drains overlapping bounded batches into exact identities and boundary classes", () => {
    const collector = new PublicRuntimeTraceCollector(10);
    const first = tick(0, 1, { unit: "idle-body", localFrame: 7, unitInstance: 0 });
    const wrap = tick(1, 2, { unit: "idle-body", localFrame: 0, unitInstance: 1 });
    const portal = tick(2, 3, { unit: "hover-shift", localFrame: 0, unitInstance: 0, boundary: "idle-hover", direction: "forward" });
    expect(collector.drain([first, wrap])).toBe(2);
    expect(collector.drain([wrap, portal])).toBe(1);
    const report = collector.snapshot();
    expect(report.coverage).toMatchObject({
      frameCount: 3,
      loopBoundaries: 1,
      routeBoundaries: 1,
      portalSelections: 1,
      routeClasses: ["portal:reversible"],
      underflows: 0,
      wrongContentIdentities: 0,
      traceGaps: 0
    });
    expect(report.frames.every(({ identitySource }) => identitySource === "public-runtime-trace")).toBe(true);
  });

  it("detects adjacent reversible direction changes, trace gaps, and wrong identity", () => {
    const collector = new PublicRuntimeTraceCollector(10);
    const forward = tick(4, 5, { unit: "hover-shift", localFrame: 3, unitInstance: 0, boundary: "idle-hover", direction: "forward" });
    const reverse = tick(6, 6, { unit: "hover-shift", localFrame: 2, unitInstance: 0, boundary: "hover-idle", direction: "reverse", contentOrdinal: 99 });
    collector.drain([forward, reverse]);
    expect(collector.snapshot().coverage).toMatchObject({
      inverseBoundaries: 1,
      traceGaps: 1,
      wrongContentIdentities: 1
    });
  });

  it("does not turn an underflow or missing timing record into a submitted frame", () => {
    const collector = new PublicRuntimeTraceCollector(10);
    const underflow = { ...tick(0, 1, { unit: "idle-body", localFrame: 0, unitInstance: 0 }), media: null, canvasSubmissionCompleteMicroseconds: null };
    collector.drain([underflow]);
    expect(collector.snapshot().coverage).toMatchObject({ frameCount: 0, underflows: 1 });
  });

  it("collects canonical element traces without inventing animation-frame eligibility", () => {
    const collector = new PublicRuntimeTraceCollector(10);
    collector.drain([tick(0, 1, {
      unit: "idle-body",
      localFrame: 0,
      unitInstance: 7,
      eligibleAnimationFrameOrdinal: null
    })]);

    expect(collector.snapshot()).toMatchObject({
      coverage: {
        frameCount: 1,
        underflows: 0,
        wrongContentIdentities: 0
      },
      frames: [{
        deadlineOrdinal: 1,
        expectedContentOrdinal: 1,
        submittedContentOrdinal: 1,
        eligibleAnimationFrameOrdinal: null,
        state: "idle",
        unit: "idle-body",
        localFrame: 0
      }]
    });
  });
});

function tick(index: number, presentationOrdinal: number, options: Readonly<{
  unit: string;
  localFrame: number;
  unitInstance: number;
  boundary?: string;
  direction?: string;
  contentOrdinal?: number;
  eligibleAnimationFrameOrdinal?: number | null;
}>): Readonly<Record<string, unknown>> {
  const contentOrdinal = options.contentOrdinal ?? presentationOrdinal;
  return Object.freeze({
    index,
    kind: "content-tick",
    presentationOrdinal: String(presentationOrdinal),
    rationalDeadlineUs: presentationOrdinal * 33_333,
    callbackStartMicroseconds: presentationOrdinal * 33_333 + 100,
    canvasSubmissionCompleteMicroseconds: presentationOrdinal * 33_333 + 200,
    eligibleAnimationFrameOrdinal: options.eligibleAnimationFrameOrdinal === undefined
      ? presentationOrdinal * 2
      : options.eligibleAnimationFrameOrdinal,
    graph: {
      snapshot: {
        contentOrdinal: String(contentOrdinal),
        visualState: "idle",
        activeEdgeId: options.boundary ?? null
      },
      presentation: {
        kind: options.unit === "hover-shift" ? "reversible" : "body",
        unitId: options.unit,
        frameIndex: options.localFrame,
        ...(options.direction === undefined ? {} : { direction: options.direction })
      }
    },
    routeReady: true,
    selectedBoundary: options.boundary === undefined ? null : "portal",
    scheduler: {
      displayedCursor: {
        path: options.boundary ?? "idle",
        unit: options.unit,
        unitInstance: options.unitInstance,
        localFrame: options.localFrame
      }
    },
    media: {
      kind: "frame",
      frame: { unit: options.unit, localFrame: options.localFrame }
    },
    counters: { underflows: 0 }
  });
}
