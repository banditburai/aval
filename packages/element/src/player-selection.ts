import type { PlayerDecoderDiagnostic } from "./player-contract.js";
import {
  candidateReasonFailureCode,
  candidateRejectionFailureCode,
  candidateReport,
  SelectionExhaustedError,
  type CandidateRejectionReason,
  type CandidateReport
} from "./player-failures.js";
import { PublicationGate } from "./player-publication-gate.js";
import type { RetryableCandidateRejection } from
  "./provisional-candidate-outcome.js";
import { mergePlayerDecoderDiagnostics } from
  "./player-diagnostic-retention.js";
import type { RuntimeFailureCode } from "./public-types.js";
import type {
  PlayerCandidateProbe,
  ProvisionalPlayerCandidate
} from "./player-candidate-contract.js";

export type {
  PlayerCandidateHandle,
  PlayerCandidateProbe,
  PlayerCandidateProbeInput,
  PlayerCandidateProbeResult,
  ProvisionalPlayerCandidate
} from "./player-candidate-contract.js";

export class PlayerCandidateSelector {
  readonly #sourceCount: number;
  readonly #probe: PlayerCandidateProbe;
  #sourceInputIndex = 0;
  #renditionIndex = 0;
  #reports: readonly Readonly<CandidateReport>[] = Object.freeze([]);
  #decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[] =
    Object.freeze([]);
  #lastRejectionCode: RuntimeFailureCode = "unsupported-profile";

  public constructor(sourceCount: number, probe: PlayerCandidateProbe) {
    if (!Number.isSafeInteger(sourceCount) || sourceCount < 0) {
      throw new RangeError("AVAL source count is invalid");
    }
    this.#sourceCount = sourceCount;
    this.#probe = probe;
  }

  public async next(
    publications: PublicationGate
  ): Promise<Readonly<ProvisionalPlayerCandidate>> {
    try {
      if (this.#sourceCount === 0) throw new TypeError("AVAL requires a source");
      while (this.#sourceInputIndex < this.#sourceCount) {
        const result = await this.#probe(Object.freeze({
          sourceInputIndex: this.#sourceInputIndex,
          renditionIndex: this.#renditionIndex,
          candidateRank: this.#reports.length,
          publications,
          candidateReports: this.#reports,
          decoderDiagnostics: this.#decoderDiagnostics
        }));
        if (result.kind === "source-rejected") {
          this.#lastRejectionCode = candidateReasonFailureCode(result.reason);
          this.#advanceSource();
          continue;
        }
        this.#decoderDiagnostics = mergePlayerDecoderDiagnostics(
          this.#decoderDiagnostics,
          result.kind === "rendition-rejected"
            ? result.decoderDiagnostics
            : Object.freeze([])
        );
        this.#advanceRendition(result.renditionCount);
        if (result.kind === "candidate") return Object.freeze({
          player: result.player,
          candidateRank: this.#reports.length,
          renditionId: result.renditionId,
          requiresQualification: result.requiresQualification,
          publications
        });
        const code = candidateReasonFailureCode(result.reason);
        this.#lastRejectionCode = code;
        this.#reports = Object.freeze([
          ...this.#reports,
          candidateReport(
            result.renditionId,
            this.#reports.length,
            result.reason
          )
        ]);
      }
      throw new SelectionExhaustedError(this.#lastRejectionCode);
    } catch (error) {
      publications.discard();
      throw error;
    }
  }

  public reject(
    candidate: Readonly<ProvisionalPlayerCandidate>,
    rejection: Readonly<RetryableCandidateRejection>
  ): void {
    const code = candidateRejectionFailureCode(rejection);
    this.#lastRejectionCode = code;
    this.#reports = Object.freeze([
      ...this.#reports,
      candidateReport(candidate.renditionId, candidate.candidateRank, code)
    ]);
  }

  public async retire(
    candidate: Readonly<ProvisionalPlayerCandidate>
  ): Promise<Readonly<{ retryAllowed: boolean }>> {
    candidate.publications.discard();
    let snapshotError: unknown;
    let cleanupFailureCount: number | null = null;
    try {
      const snapshot = candidate.player.snapshot(false);
      cleanupFailureCount = snapshot.cleanupFailureCount ?? 0;
      this.#decoderDiagnostics = mergePlayerDecoderDiagnostics(
        this.#decoderDiagnostics,
        snapshot.decoderDiagnostics
      );
    } catch (error) {
      snapshotError = error;
    }
    let disposalError: unknown;
    try { await candidate.player.dispose(); }
    catch (error) { disposalError = error; }
    if (disposalError !== undefined) throw disposalError;
    if (cleanupFailureCount === null) throw snapshotError;
    return Object.freeze({ retryAllowed: cleanupFailureCount === 0 });
  }

  #advanceRendition(renditionCount: number): void {
    if (!Number.isSafeInteger(renditionCount) || renditionCount < 1 ||
      this.#renditionIndex >= renditionCount) {
      throw new Error("AVAL candidate probe returned an invalid rendition count");
    }
    this.#renditionIndex += 1;
    if (this.#renditionIndex >= renditionCount) this.#advanceSource();
  }

  #advanceSource(): void {
    this.#sourceInputIndex += 1;
    this.#renditionIndex = 0;
  }
}
