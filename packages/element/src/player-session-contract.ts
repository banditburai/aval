import type { AvalPlaybackError } from "./errors.js";
import type { Metadata, PlayerInput } from "./player-contract.js";

export type PlayerSessionTiming = Readonly<Pick<
  PlayerInput["platform"],
  "requestAnimationFrame" | "cancelAnimationFrame" | "now" |
    "setTimeout" | "clearTimeout"
>>;

export interface PlayerSessionPublicationPort {
  onMetadata(metadata: Readonly<Metadata>): void;
  onReadiness(
    value: Parameters<PlayerInput["onReadiness"]>[0],
    reason?: Parameters<PlayerInput["onReadiness"]>[1]
  ): void;
  onRestart(state: string): void;
  onEvent(type: string, detail: Readonly<Record<string, unknown>>): void;
  onFailure(
    code: Parameters<PlayerInput["onFailure"]>[0],
    operation: string,
    fatal: boolean
  ): void;
  onPlaybackFailure(
    code: Parameters<PlayerInput["onPlaybackFailure"]>[0],
    operation: string
  ): AvalPlaybackError;
}

/** Narrow host capabilities needed by graph/session coordination only. */
export interface PlayerSessionHost {
  readonly signal: AbortSignal;
  readonly initialState: string | null;
  readonly initialBody: boolean;
  readonly visible: boolean;
  readonly timing: PlayerSessionTiming;
  readonly publication: Readonly<PlayerSessionPublicationPort>;
}
