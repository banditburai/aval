import type { Player, PlayerDecoderDiagnostic } from "./player-contract.js";
import type {
  CandidateRejectionReason,
  CandidateReport
} from "./player-failures.js";
import type { PublicationGate } from "./player-publication-gate.js";
import type { PreparationDeadline } from "./preparation-deadline.js";

export interface PlayerCandidateHandle extends Player {
  adoptPreparationParent(parent: PreparationDeadline): void;
  provisionalFailure(): unknown;
  completeCandidateInstallation(): void;
  failCandidateInstallation(reason: unknown): void;
}

export interface ProvisionalPlayerCandidate {
  readonly player: PlayerCandidateHandle;
  readonly candidateRank: number;
  readonly renditionId: string;
  readonly requiresQualification: boolean;
  readonly publications: PublicationGate;
}

export interface PlayerCandidateProbeInput {
  readonly sourceInputIndex: number;
  readonly renditionIndex: number;
  readonly candidateRank: number;
  readonly publications: PublicationGate;
  readonly candidateReports: readonly Readonly<CandidateReport>[];
  readonly decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[];
}

export type PlayerCandidateProbeResult =
  | Readonly<{
      kind: "candidate";
      player: PlayerCandidateHandle;
      renditionId: string;
      requiresQualification: boolean;
      renditionCount: number;
    }>
  | Readonly<{
      kind: "rendition-rejected";
      renditionId: string;
      renditionCount: number;
      reason: CandidateRejectionReason;
      decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[];
    }>
  | Readonly<{
      kind: "source-rejected";
      reason: CandidateRejectionReason;
    }>;

/** Creates or probes only the source/rendition requested by the selector. */
export type PlayerCandidateProbe = (
  input: Readonly<PlayerCandidateProbeInput>
) => Promise<Readonly<PlayerCandidateProbeResult>>;
