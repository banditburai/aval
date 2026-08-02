import type {
  GraphPresentation,
  MotionGraphDefinition,
  MotionGraphSnapshot
} from "@pixel-point/aval-graph";

import type {
  Metadata,
  PlayerSnapshot
} from "./player-contract.js";

/** Opaque, single-use authority to promote one prepared media stream. */
export interface PlayerMediaLease {
  readonly token: symbol;
}

export interface PlayerCandidateDescriptor {
  readonly metadata: Readonly<Metadata>;
  readonly graph: Readonly<MotionGraphDefinition>;
  readonly frameDurationMs: number;
  readonly rendition: Readonly<{
    readonly id: string;
    readonly codec: string;
    readonly bitDepth: 8 | 10;
    readonly sourceIndex: number;
  }>;
}

export type PlayerMediaContextEvent =
  | Readonly<{ state: "lost" }>
  | Readonly<{ state: "restored" }>
  | Readonly<{ state: "error"; error: unknown }>;

export class PlayerMediaFailure extends Error {
  public readonly operation: string;
  public readonly reason: unknown;

  public constructor(reason: unknown, operation: string) {
    super("AVAL media operation failed", { cause: reason });
    this.name = "PlayerMediaFailure";
    this.reason = reason;
    this.operation = operation;
  }
}

export interface PlayerMediaRouteDecision {
  readonly ready: boolean;
  readonly blocksPresentation: boolean;
}

export type PlayerMediaAcquisition =
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "ready"; lease: PlayerMediaLease | null }>;

export interface PlayerMediaDrawReceipt {
  readonly drew: boolean;
  readonly unitId: string | null;
  readonly localFrame: number | null;
  readonly logicalRunId: number | null;
  readonly openFrames: number;
  readonly readbackTag: string;
}

/** Opaque, one-shot authority to release one completed draw's media. */
export interface PlayerMediaDrawFinalization {
  readonly token: symbol;
}

export interface PlayerMediaDrawResult {
  readonly receipt: Readonly<PlayerMediaDrawReceipt>;
  readonly finalization: Readonly<PlayerMediaDrawFinalization>;
}

export interface PlayerMediaSnapshot {
  readonly transportMode: PlayerSnapshot["transportMode"];
  readonly declaredFileBytes: number;
  readonly metadataBytes: number;
  readonly verifiedBytes: number;
  readonly residentBlobBytes: number;
  readonly activeTransportBodies: number;
  readonly pendingLoads: number;
  readonly interestedWaiters: number;
  readonly workerCount: number;
  readonly openFrames: number;
  readonly rendererBackend: PlayerSnapshot["rendererBackend"];
  readonly presentation: PlayerSnapshot["presentation"];
  readonly contextLossCount: number;
  readonly contextRecoveryCount: number;
}

export interface PlayerMediaRuntimePort {
  readonly descriptor: Readonly<PlayerCandidateDescriptor>;
  connectContextObserver(
    observer: (event: PlayerMediaContextEvent) => void
  ): void;
  failure(): Promise<never>;
  updateGraphDiagnostic(input: Readonly<{
    requestedState: string | null;
    visualState: string | null;
  }>): void;
  qualifyOutput(signal: AbortSignal): Promise<void>;
  prepare(input: Readonly<{
    initialState: string;
    initialBody: boolean;
    signal: AbortSignal;
  }>): Promise<void>;
  routeDecision(
    snapshot: Readonly<MotionGraphSnapshot>
  ): Readonly<PlayerMediaRouteDecision>;
  prepareRoutes(
    snapshot: Readonly<MotionGraphSnapshot>,
    required?: Readonly<GraphPresentation>
  ): void;
  edgeReady(edgeId: string): boolean;
  acquirePresentation(
    presentation: Readonly<GraphPresentation>
  ): Readonly<PlayerMediaAcquisition>;
  cancelPresentation(lease: PlayerMediaLease | null): void;
  draw(input: Readonly<{
    presentation: Readonly<GraphPresentation>;
    lease: PlayerMediaLease | null;
  }>): Promise<Readonly<PlayerMediaDrawResult>>;
  finalizeDraw(finalization: Readonly<PlayerMediaDrawFinalization>): void;
  resize(input: Readonly<{
    width: number;
    height: number;
    dpr: number;
    fit: string;
  }>): void;
  snapshot(): Readonly<PlayerMediaSnapshot>;
  settled(): Promise<void>;
  retire(): Promise<void>;
}
