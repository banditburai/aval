import type {
  Metadata,
  PlayerDecoderDiagnostic,
  PlayerInput,
  PlayerRendererDiagnostic
} from "./player-contract.js";

type PublicationKind = "animated-readiness" | "draw" | "other";

interface PendingPublication {
  readonly kind: PublicationKind;
  readonly operation: () => void;
}

/** Buffers candidate-visible callbacks until one provisional player is published. */
export class PublicationGate {
  public readonly input: Readonly<PlayerInput>;
  readonly #targetPlaybackFailure: PlayerInput["onPlaybackFailure"];
  readonly #pending: Readonly<PendingPublication>[] = [];
  #playbackFailure: PlayerInput["onPlaybackFailure"];
  #active = false;
  #discarded = false;
  #flushing = false;

  public constructor(
    target: Readonly<PlayerInput>,
    playbackFailure: PlayerInput["onPlaybackFailure"] = target.onPlaybackFailure
  ) {
    this.#targetPlaybackFailure = target.onPlaybackFailure;
    this.#playbackFailure = playbackFailure;
    const publish = (
      operation: () => void,
      kind: PublicationKind = "other"
    ): void => {
      if (this.#discarded) return;
      if (this.#active && !this.#flushing) operation();
      else this.#pending.push(Object.freeze({ kind, operation }));
    };
    this.input = Object.freeze({
      ...target,
      // Resource and diagnostics accounting remains authoritative while a
      // candidate is provisional; it is not candidate-visible publication.
      onResourceBytes: (bytes: number) => target.onResourceBytes(bytes),
      onMetadata: (metadata: Readonly<Metadata>) =>
        publish(() => target.onMetadata(metadata)),
      onReadiness: (value: string, reason?: string) => publish(
        () => target.onReadiness(value, reason),
        value === "visualReady" || value === "interactiveReady"
          ? "animated-readiness"
          : "other"
      ),
      onAnimationResourcesRetired: () =>
        publish(() => target.onAnimationResourcesRetired()),
      onDraw: () => publish(() => target.onDraw(), "draw"),
      onRestart: (state: string) => publish(() => target.onRestart(state)),
      onEvent: (type: string, detail: Readonly<Record<string, unknown>>) =>
        publish(() => target.onEvent(type, detail)),
      onFailure: (
        code: Parameters<PlayerInput["onFailure"]>[0],
        operation: string,
        fatal: boolean
      ) => publish(() => target.onFailure(code, operation, fatal)),
      onPlaybackFailure: (
        code: Parameters<PlayerInput["onPlaybackFailure"]>[0],
        operation: string
      ) => this.#playbackFailure(code, operation),
      onDecoderDiagnostics: (
        diagnostics: readonly Readonly<PlayerDecoderDiagnostic>[]
      ) => target.onDecoderDiagnostics?.(diagnostics),
      onRendererDiagnostics: (
        diagnostics: readonly Readonly<PlayerRendererDiagnostic>[]
      ) => target.onRendererDiagnostics?.(diagnostics)
    });
  }

  public activate(): void {
    if (this.#active || this.#discarded) return;
    this.#active = true;
    this.#flushing = true;
    let firstFailure: unknown;
    let failed = false;
    try {
      while (this.#pending.length > 0) {
        try { this.#pending.shift()!.operation(); }
        catch (error) {
          if (!failed) {
            failed = true;
            firstFailure = error;
          }
        }
      }
    } finally {
      this.#flushing = false;
    }
    if (failed) throw firstFailure;
  }

  public commit(): void {
    if (this.#discarded) return;
    this.#playbackFailure = this.#targetPlaybackFailure;
  }

  public discardAnimatedPresentation(): void {
    if (this.#active || this.#discarded) return;
    const retained = this.#pending.filter(({ kind }) =>
      kind !== "animated-readiness" && kind !== "draw"
    );
    this.#pending.length = 0;
    this.#pending.push(...retained);
  }

  public discard(): void {
    if (this.#active || this.#discarded) return;
    this.#discarded = true;
    this.#pending.length = 0;
  }
}
