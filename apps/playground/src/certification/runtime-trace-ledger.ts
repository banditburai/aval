import { BrowserFrameLedger } from "./frame-ledger.js";

const BOUNDARY_STARTS = Object.freeze(["portal", "finish", "cut"] as const);
const PRESENTATION_KINDS = Object.freeze([
  "static",
  "intro",
  "body",
  "locked",
  "reversible"
] as const);

type BoundaryStart = (typeof BOUNDARY_STARTS)[number];
type PresentationKind = (typeof PRESENTATION_KINDS)[number];

export interface RuntimeTraceCoverage {
  readonly frameCount: number;
  readonly loopBoundaries: number;
  readonly routeBoundaries: number;
  readonly inverseBoundaries: number;
  readonly portalSelections: number;
  readonly routeClasses: readonly string[];
  readonly underflows: number;
  readonly wrongContentIdentities: number;
  readonly traceGaps: number;
  readonly firstPresentationOrdinal: number | null;
  readonly lastPresentationOrdinal: number | null;
  readonly firstSubmissionMicroseconds: number | null;
  readonly lastSubmissionMicroseconds: number | null;
}

export interface RuntimeTraceCollection {
  readonly coverage: RuntimeTraceCoverage;
  readonly frames: ReturnType<BrowserFrameLedger["snapshot"]>;
}

interface ParsedContentTick {
  readonly presentationOrdinal: number;
  readonly requiredContentOrdinal: number;
  readonly submittedContentOrdinal: number | null;
  readonly callbackStartMicroseconds: number;
  readonly canvasSubmissionCompleteMicroseconds: number;
  readonly eligibleAnimationFrameOrdinal: number | null;
  readonly selectedBoundary: BoundaryStart | null;
  readonly presentationKind: PresentationKind;
  readonly state: string | null;
  readonly route: string | null;
  readonly unit: string;
  readonly localFrame: number;
  readonly unitInstance: number;
  readonly direction: string | null;
  readonly routeReady: boolean;
  readonly underflows: number;
}

export class PublicRuntimeTraceCollector {
  readonly #frames: BrowserFrameLedger;
  readonly #routeClasses = new Set<string>();
  #lastTraceIndex: number | null = null;
  #lastTick: ParsedContentTick | null = null;
  #lastSelectedBoundary: string | null = null;
  #loopBoundaries = 0;
  #routeBoundaries = 0;
  #inverseBoundaries = 0;
  #portalSelections = 0;
  #underflows = 0;
  #wrongContentIdentities = 0;
  #traceGaps = 0;
  #firstPresentationOrdinal: number | null = null;
  #lastPresentationOrdinal: number | null = null;
  #firstSubmissionMicroseconds: number | null = null;
  #lastSubmissionMicroseconds: number | null = null;

  public constructor(maximumFrames = 100_000) {
    this.#frames = new BrowserFrameLedger(maximumFrames);
  }

  /** Establishes the post-warm-up trace cursor without grading old records. */
  public prime(records: readonly Readonly<Record<string, unknown>>[]): void {
    if (this.#lastTraceIndex !== null || this.#frames.snapshot().length !== 0) throw new Error("runtime trace collector was already started");
    if (!Array.isArray(records) || records.length > 512) throw new RangeError("public runtime trace batch is invalid");
    for (const record of records) {
      const index = integer(record.index, "trace.index");
      if (this.#lastTraceIndex === null || index > this.#lastTraceIndex) this.#lastTraceIndex = index;
    }
  }

  public drain(records: readonly Readonly<Record<string, unknown>>[]): number {
    if (!Array.isArray(records) || records.length > 512) throw new RangeError("public runtime trace batch is invalid");
    let drained = 0;
    for (const record of records) {
      const index = integer(record.index, "trace.index");
      if (this.#lastTraceIndex !== null && index <= this.#lastTraceIndex) continue;
      if (this.#lastTraceIndex !== null && index !== this.#lastTraceIndex + 1) this.#traceGaps += index - this.#lastTraceIndex - 1;
      this.#lastTraceIndex = index;
      drained += 1;
      if (record.kind !== "content-tick") continue;
      const tick = parseContentTick(record);
      if (tick === null) {
        this.#underflows += 1;
        continue;
      }
      this.#appendTick(tick);
    }
    return drained;
  }

  public snapshot(): RuntimeTraceCollection {
    return Object.freeze({
      coverage: Object.freeze({
        frameCount: this.#frames.snapshot().length,
        loopBoundaries: this.#loopBoundaries,
        routeBoundaries: this.#routeBoundaries,
        inverseBoundaries: this.#inverseBoundaries,
        portalSelections: this.#portalSelections,
        routeClasses: Object.freeze([...this.#routeClasses].sort()),
        underflows: this.#underflows,
        wrongContentIdentities: this.#wrongContentIdentities,
        traceGaps: this.#traceGaps,
        firstPresentationOrdinal: this.#firstPresentationOrdinal,
        lastPresentationOrdinal: this.#lastPresentationOrdinal,
        firstSubmissionMicroseconds: this.#firstSubmissionMicroseconds,
        lastSubmissionMicroseconds: this.#lastSubmissionMicroseconds
      }),
      frames: this.#frames.snapshot()
    });
  }

  #appendTick(tick: ParsedContentTick): void {
    const previous = this.#lastTick;
    const loopBoundary = previous !== null && tick.presentationKind === "body" &&
      previous.unit === tick.unit && (
        tick.unitInstance > previous.unitInstance || tick.localFrame < previous.localFrame
      );
    if (loopBoundary) this.#loopBoundaries += 1;
    const newRouteBoundary = tick.selectedBoundary !== null && tick.selectedBoundary !== this.#lastSelectedBoundary;
    if (newRouteBoundary) {
      this.#routeBoundaries += 1;
      const transition = tick.presentationKind === "reversible" ||
        tick.presentationKind === "locked"
        ? tick.presentationKind
        : "none";
      this.#routeClasses.add(`${tick.selectedBoundary}:${transition}`);
      if (tick.selectedBoundary === "portal") this.#portalSelections += 1;
    }
    if (
      previous !== null &&
      previous.unit === tick.unit &&
      tick.presentationKind === "reversible" &&
      previous.direction !== null && tick.direction !== null &&
      previous.direction !== tick.direction &&
      Math.abs(previous.localFrame - tick.localFrame) <= 1
    ) this.#inverseBoundaries += 1;
    if (tick.submittedContentOrdinal !== tick.requiredContentOrdinal) this.#wrongContentIdentities += 1;
    this.#frames.append({
      deadlineOrdinal: tick.presentationOrdinal,
      expectedContentOrdinal: tick.requiredContentOrdinal,
      submittedContentOrdinal: tick.submittedContentOrdinal,
      boundary: loopBoundary || newRouteBoundary,
      eventAvailableBeforeCutoff: tick.selectedBoundary !== null,
      framePreparedBeforeCutoff: tick.routeReady,
      eligibleAnimationFrameOrdinal: tick.eligibleAnimationFrameOrdinal,
      callbackStartMicroseconds: tick.callbackStartMicroseconds,
      canvasSubmissionCompleteMicroseconds: tick.canvasSubmissionCompleteMicroseconds,
      gpuFence: "not-used",
      state: tick.state,
      route: tick.route,
      port: "default",
      unit: tick.unit,
      localFrame: tick.localFrame,
      identitySource: "public-runtime-trace"
    });
    this.#firstPresentationOrdinal ??= tick.presentationOrdinal;
    this.#lastPresentationOrdinal = tick.presentationOrdinal;
    this.#firstSubmissionMicroseconds ??= tick.canvasSubmissionCompleteMicroseconds;
    this.#lastSubmissionMicroseconds = tick.canvasSubmissionCompleteMicroseconds;
    this.#underflows = Math.max(this.#underflows, tick.underflows);
    this.#lastTick = tick;
    this.#lastSelectedBoundary = tick.selectedBoundary;
  }
}

function parseContentTick(record: Readonly<Record<string, unknown>>): ParsedContentTick | null {
  const media = nullableRecord(record.media, "trace.media");
  const callbackStartMicroseconds = nullableInteger(record.callbackStartMicroseconds, "trace.callbackStartMicroseconds");
  const submission = nullableInteger(record.canvasSubmissionCompleteMicroseconds, "trace.canvasSubmissionCompleteMicroseconds");
  const eligible = nullableInteger(record.eligibleAnimationFrameOrdinal, "trace.eligibleAnimationFrameOrdinal");
  if (media === null || media.kind !== "frame" || callbackStartMicroseconds === null || submission === null) return null;
  const presentationOrdinal = decimalOrdinal(record.presentationOrdinal, "trace.presentationOrdinal");
  integer(record.rationalDeadlineUs, "trace.rationalDeadlineUs");
  const graph = recordValue(record.graph, "trace.graph");
  const snapshot = recordValue(graph.snapshot, "trace.graph.snapshot");
  const graphPresentation = recordValue(graph.presentation, "trace.graph.presentation");
  const frame = recordValue(media.frame, "trace.media.frame");
  const scheduler = recordValue(record.scheduler, "trace.scheduler");
  const displayedCursor = recordValue(
    scheduler.displayedCursor,
    "trace.scheduler.displayedCursor"
  );
  const counters = recordValue(record.counters, "trace.counters");
  const submittedContentOrdinal = snapshot.contentOrdinal === null
    ? null
    : decimalOrdinal(snapshot.contentOrdinal, "trace.graph.snapshot.contentOrdinal");
  const unit = text(frame.unit, "trace.media.frame.unit");
  const localFrame = integer(frame.localFrame, "trace.media.frame.localFrame");
  const graphUnit = text(graphPresentation.unitId, "trace.graph.presentation.unitId");
  const graphFrame = integer(graphPresentation.frameIndex, "trace.graph.presentation.frameIndex");
  const cursorUnit = text(displayedCursor.unit, "trace.scheduler.displayedCursor.unit");
  const cursorFrame = integer(
    displayedCursor.localFrame,
    "trace.scheduler.displayedCursor.localFrame"
  );
  const graphIdentityMatched = graphUnit === unit && graphFrame === localFrame &&
    cursorUnit === unit && cursorFrame === localFrame;
  const presentationKind = enumeration(
    graphPresentation.kind,
    PRESENTATION_KINDS,
    "trace.graph.presentation.kind"
  );
  return Object.freeze({
    presentationOrdinal,
    requiredContentOrdinal: presentationOrdinal,
    submittedContentOrdinal: graphIdentityMatched ? submittedContentOrdinal : null,
    callbackStartMicroseconds,
    canvasSubmissionCompleteMicroseconds: submission,
    eligibleAnimationFrameOrdinal: eligible,
    selectedBoundary: nullableEnumeration(
      record.selectedBoundary,
      BOUNDARY_STARTS,
      "trace.selectedBoundary"
    ),
    presentationKind,
    state: nullableText(snapshot.visualState, "trace.graph.snapshot.visualState"),
    route: nullableText(snapshot.activeEdgeId, "trace.graph.snapshot.activeEdgeId"),
    unit,
    localFrame,
    unitInstance: integer(
      displayedCursor.unitInstance,
      "trace.scheduler.displayedCursor.unitInstance"
    ),
    direction: nullableText(graphPresentation.direction, "trace.graph.presentation.direction"),
    routeReady: record.routeReady === true,
    underflows: integer(counters.underflows, "trace.counters.underflows")
  });
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function nullableRecord(value: unknown, name: string): Record<string, unknown> | null {
  return value === null ? null : recordValue(value, name);
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
  return value as number;
}

function nullableInteger(value: unknown, name: string): number | null {
  return value === null ? null : integer(value, name);
}

function decimalOrdinal(value: unknown, name: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`${name} must be a decimal ordinal`);
  const ordinal = Number(value);
  return integer(ordinal, name);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new TypeError(`${name} is invalid`);
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  return value === null || value === undefined ? null : text(value, name);
}

function enumeration<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value as T[number];
}

function nullableEnumeration<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string
): T[number] | null {
  return value === null ? null : enumeration(value, allowed, name);
}
