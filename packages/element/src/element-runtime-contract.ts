import type {
  Metadata,
  PlayerDecoderDiagnostic,
  PlayerRendererDiagnostic,
  PlayerSnapshot,
  Source
} from "./player-contract.js";
import type {
  AvalAutoplay,
  AvalCrossOrigin,
  AvalFit,
  AvalMotion,
  AvalPublicFailure,
  RuntimeReadiness,
  StaticReason,
  AvalSnapshot
} from "./public-types.js";
import type { SourceCleanupReceipt } from "./element-cleanup-proof.js";

export interface ElementRuntimeGeometry {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export interface ElementRuntimeSourceRead {
  readonly sources: readonly Readonly<Source>[];
  readonly failures: readonly Readonly<{
    readonly sourceIndex: number;
    readonly attribute: "src" | "data-codec" | "integrity";
  }>[];
}

export interface ElementRuntimeReadSnapshot {
  readonly publicSnapshot: Readonly<AvalSnapshot>;
  readonly view: Window | null;
  readonly baseUrl: string;
  readonly crossOrigin: AvalCrossOrigin;
  readonly motion: AvalMotion;
  readonly autoplay: AvalAutoplay;
  readonly fit: AvalFit | null;
  readonly declarativeState: string | null;
  readonly geometry: Readonly<ElementRuntimeGeometry>;
  readonly reducedMotion: boolean;
  readonly intersectionKnown: boolean;
  readonly effectivelyVisible: boolean;
}

export interface ElementRuntimeReadPort {
  snapshot(): Readonly<ElementRuntimeReadSnapshot>;
  sources(): Readonly<ElementRuntimeSourceRead>;
  takeSourceChanges(): boolean;
  needsIntersectionSample(): boolean;
  waitForIntersection(): Promise<void>;
}

export type ElementRuntimeDiagnosticEvent =
  | Readonly<{ readonly kind: "prepare" }>
  | Readonly<{ readonly kind: "source-replacement" }>
  | Readonly<{ readonly kind: "pause" }>
  | Readonly<{ readonly kind: "resume" }>
  | Readonly<{ readonly kind: "underflow" }>
  | Readonly<{ readonly kind: "cleanup" }>
  | Readonly<{ readonly kind: "timer-started" }>
  | Readonly<{ readonly kind: "timer-settled" }>
  | Readonly<{ readonly kind: "stale-publication" }>
  | Readonly<{
      readonly kind: "source-started";
      readonly generation: number;
      readonly preservePlaybackLifecycle: boolean;
    }>
  | Readonly<{
      readonly kind: "source-capacity";
      readonly generation: number;
      readonly sourceCount: number;
    }>
  | Readonly<{
      readonly kind: "runtime";
      readonly generation: number;
      readonly snapshot: Readonly<PlayerSnapshot> | null;
    }>
  | Readonly<{
      readonly kind: "decoder";
      readonly generation: number;
      readonly diagnostics: readonly Readonly<PlayerDecoderDiagnostic>[];
    }>
  | Readonly<{
      readonly kind: "renderer";
      readonly generation: number;
      readonly diagnostics: readonly Readonly<PlayerRendererDiagnostic>[];
    }>
  | Readonly<{
      readonly kind: "retired-context";
      readonly generation: number;
      readonly count: number;
    }>;

export interface ElementRuntimePublicationPort {
  commit(patch: Readonly<Partial<Omit<AvalSnapshot, "revision">>>): void;
  diagnostic(event: Readonly<ElementRuntimeDiagnosticEvent>): void;
  readinessChanged(
    value: RuntimeReadiness,
    reason: StaticReason | undefined,
    generation: number
  ): void;
  runtimeEvent(
    type: string,
    detail: Readonly<Record<string, unknown>>,
    generation: number
  ): void;
  failure(
    failure: Readonly<AvalPublicFailure>,
    fatal: boolean,
    generation: number
  ): void;
  metadataChanged(metadata: Readonly<Metadata>): void;
  refreshInputs(): void;
  disconnectInputs(): void;
  sendInput(source: "visible" | "hidden"): void;
  transitionEnded(): void;
  disposalStarted(): void;
  disposalCompleted(
    sourceCleanupCompleted: boolean,
    sessionPending: number
  ): boolean;
  cleanupObserved(receipt: Readonly<SourceCleanupReceipt>): void;
  stalePublicationCount(): number;
}

export interface ElementRuntimePresentationPort {
  readonly canvas: HTMLCanvasElement;
  stylesSupported(): boolean;
  resetSource(generation: number): void;
  metadataChanged(metadata: Readonly<Metadata>): void;
  reconcileMotionPreference(): void;
  animatedDrawn(generation: number): void;
}

export interface ElementRuntimePageSnapshot {
  readonly ownership: Readonly<{
    readonly kind: "page-resources";
    readonly participantDisposed: boolean;
    readonly participantRegistered: boolean;
    readonly logicalBytes: number;
    readonly activeLeaseCount: number;
    readonly decoderTicketCount: number;
    readonly decoderState:
      | "queued"
      | "parked"
      | "granted"
      | "cancelled"
      | "released"
      | null;
  }>;
  readonly page: Readonly<{
    readonly active: number;
    readonly queued: number;
    readonly parked: number;
    readonly participants: number;
    readonly physicalBytes: number;
  }>;
}

export interface ElementRuntimePageResourcePort {
  invalidateRequest(): void;
  claimDecoder(generation: number): boolean;
  setResourceBytes(bytes: number): void;
  animationResourcesRetired(retainQueuedRequest: boolean): void;
  cancelDecoderTicket(): void;
  setVisible(visible: boolean): void;
  releaseAll(): void;
  snapshot(): Readonly<ElementRuntimePageSnapshot>;
}

export interface ElementRuntimeSessionSnapshot {
  readonly elementGeneration: number;
  readonly inputGeneration: number;
  readonly motionGeneration: number;
  readonly visibilityGeneration: number;
  readonly resizeGeneration: number;
  readonly runtime: Readonly<PlayerSnapshot> | null;
  readonly runtimeIsActive: boolean;
  readonly runtimeSuspending: boolean;
  readonly runtimeSuspended: boolean;
  readonly rebuildPending: boolean;
  readonly presentationFit: AvalFit | null;
  readonly pendingOperationCount: number;
}
