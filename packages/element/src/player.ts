import type { Player, PlayerInput } from "./player-contract.js";
import {
  PreparationDeadline
} from "./preparation-deadline.js";
import { CANDIDATE_INSTALLATION_TIMEOUT_MS } from
  "./preparation-budget.js";
import {
  limit,
  provisionalPlaybackFailure,
  startupFailureDisposition
} from "./player-failures.js";
import { PlayerMediaCandidateProbe } from "./player-media-candidate.js";
import { PublicationGate } from "./player-publication-gate.js";
import {
  PlayerCandidateSelector,
  type PlayerCandidateHandle,
  type PlayerCandidateProbeInput,
  type PlayerCandidateProbeResult,
  type ProvisionalPlayerCandidate
} from "./player-selection.js";
import { PlayerSession } from "./player-session.js";
import type { PlayerSessionHost } from "./player-session-contract.js";
import { orchestrateProvisionalCandidates } from "./provisional-startup.js";

export async function createPlayer(
  input: Readonly<PlayerInput>
): Promise<Player> {
  const deadline = PreparationDeadline.begin({
    parent: input.signal,
    timeoutMs: input.preparationTimeoutMs,
    platform: input.platform
  });
  const mediaProbe = new PlayerMediaCandidateProbe(input, deadline);
  const selector = new PlayerCandidateSelector(input.sources.length, (request) =>
    createSessionCandidate(mediaProbe, request));
  try {
    const candidate = await orchestrateProvisionalCandidates<
      ProvisionalPlayerCandidate
    >({
      next: () => selector.next(new PublicationGate(
          input,
          provisionalPlaybackFailure
        )),
      qualify: async (current) => {
        await installProvisionalCandidate(input, current.player, deadline);
        if (current.requiresQualification) {
          await current.player.prepare();
          deadline.complete();
          current.player.adoptPreparationParent(deadline);
        }
      },
      localFailure: (current) => current.player.provisionalFailure(),
      retire: (current) => selector.retire(current),
      cancelled: () => deadline.timedOut || input.signal.aborted,
      selected: (current) => current.publications.commit(),
      rejected: (current, rejection) => selector.reject(current, rejection)
    });
    return candidate.player;
  } catch (error) {
    const disposition = startupFailureDisposition({
      reason: error,
      sourceAborted: input.signal.aborted,
      deadlineTimedOut: deadline.timedOut
    });
    deadline.dispose();
    try { await mediaProbe.dispose(); }
    catch { /* cleanup cannot replace the canonical startup failure */ }
    if (disposition.kind === "abort") throw error;
    throw input.onPlaybackFailure(disposition.code, "prepare");
  }
}

async function installProvisionalCandidate(
  input: Readonly<Pick<PlayerInput, "onCandidate">>,
  player: PlayerCandidateHandle,
  preparation: PreparationDeadline
): Promise<void> {
  if (input.onCandidate === undefined) {
    player.completeCandidateInstallation();
    return;
  }
  const deadline = preparation.forkDeferred(
    CANDIDATE_INSTALLATION_TIMEOUT_MS
  );
  deadline.start();
  try {
    await limit(input.onCandidate(player), deadline.signal);
    player.completeCandidateInstallation();
  } catch (error) {
    player.failCandidateInstallation(error);
    throw error;
  } finally {
    deadline.dispose();
  }
}

function createSessionCandidate(
  probe: PlayerMediaCandidateProbe,
  request: Readonly<PlayerCandidateProbeInput>
): Promise<Readonly<PlayerCandidateProbeResult>> {
  return probe.probeWith(request, (result) => {
    const player = new PlayerSession(Object.freeze({
      candidate: Object.freeze({
        staticReason: result.staticReason,
        candidateReports: request.candidateReports,
        candidateRank: request.candidateRank
      }),
      host: sessionHost(request.publications.input),
      publications: request.publications,
      preparationDeadline: result.deadline,
      media: result.media,
      telemetry: result.telemetry
    }));
    return Object.freeze({
      kind: "candidate" as const,
      player,
      renditionId: result.renditionId,
      requiresQualification: result.requiresQualification,
      renditionCount: result.renditionCount
    });
  });
}

function sessionHost(input: Readonly<PlayerInput>): Readonly<PlayerSessionHost> {
  return Object.freeze({
    signal: input.signal,
    initialState: input.initialState,
    initialBody: input.initialBody,
    visible: input.visible,
    timing: Object.freeze({
      requestAnimationFrame: input.platform.requestAnimationFrame,
      cancelAnimationFrame: input.platform.cancelAnimationFrame,
      now: input.platform.now,
      setTimeout: input.platform.setTimeout,
      clearTimeout: input.platform.clearTimeout
    }),
    publication: Object.freeze({
      onMetadata: input.onMetadata,
      onReadiness: input.onReadiness,
      onRestart: input.onRestart,
      onEvent: input.onEvent,
      onFailure: input.onFailure,
      onPlaybackFailure: input.onPlaybackFailure
    })
  });
}
