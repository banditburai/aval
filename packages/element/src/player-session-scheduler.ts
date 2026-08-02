import type { PlayerSessionTiming } from "./player-session-contract.js";

export type PlayerAdvanceOutcome = "progressed" | "waiting-route";

export interface PlayerScheduledAdvance {
  readonly ordinal: bigint;
  readonly callbackStart: number;
  readonly rationalDeadlineUs: number;
}

interface PlayerSessionSchedulerInput {
  readonly timing: PlayerSessionTiming;
  readonly frameDurationMs: number;
  readonly initiallyVisible: boolean;
  readonly shouldRun: () => boolean;
  readonly advance: (
    input: Readonly<PlayerScheduledAdvance>
  ) => Promise<PlayerAdvanceOutcome>;
  readonly onFailure: (reason: unknown) => void;
}

/** Owns frame eligibility, rational time, pause/visibility, and RAF state. */
export class PlayerSessionScheduler {
  readonly #input: Readonly<PlayerSessionSchedulerInput>;
  #ordinal = 0n;
  #raf: number | null = null;
  #deadline = 0;
  #clockOrigin = 0;
  #clockOrdinal = 0n;
  #pauseEpoch = 0;
  #generation = 0;
  #visible: boolean;
  #paused = false;
  #enabled = false;
  #busy = false;
  #disposed = false;

  public constructor(input: Readonly<PlayerSessionSchedulerInput>) {
    if (!Number.isFinite(input.frameDurationMs) || input.frameDurationMs <= 0) {
      throw new RangeError("AVAL frame duration is invalid");
    }
    this.#input = input;
    this.#visible = input.initiallyVisible;
  }

  public get ordinal(): bigint { return this.#ordinal; }
  public get pauseEpoch(): number { return this.#pauseEpoch; }

  public commitTick(): void { this.#ordinal += 1n; }

  public enable(resetClock: boolean): void {
    if (this.#disposed) return;
    this.#enabled = true;
    if (resetClock) this.resetClock();
    this.schedule();
  }

  public schedule(): void {
    if (
      !this.#enabled || this.#disposed || this.#paused || !this.#visible ||
      this.#busy || this.#raf !== null || !this.#input.shouldRun()
    ) return;
    const generation = this.#generation;
    this.#raf = this.#input.timing.requestAnimationFrame((time) => {
      if (this.#disposed || generation !== this.#generation) return;
      this.#raf = null;
      if (time < this.#deadline || this.#busy) {
        this.schedule();
        return;
      }
      this.#busy = true;
      const work = this.#input.advance(Object.freeze({
        ordinal: this.#ordinal,
        callbackStart: this.#input.timing.now(),
        rationalDeadlineUs: Math.round(this.#deadline * 1_000)
      }));
      void work.then((outcome) => {
        if (outcome === "progressed") {
          if (generation === this.#generation) this.#nextDeadline();
          else this.resetClock();
        }
      }).catch(this.#input.onFailure).finally(() => {
        this.#busy = false;
        this.schedule();
      });
    });
  }

  public pause(): void {
    this.#pauseEpoch += 1;
    this.#paused = true;
    this.cancel();
  }

  public resumeIfCurrent(epoch: number): boolean {
    if (epoch !== this.#pauseEpoch || this.#disposed) return false;
    this.#paused = false;
    this.resetClock();
    this.schedule();
    return true;
  }

  public resumeBeforeInstallation(): void { this.#paused = false; }

  public setVisible(visible: boolean): void {
    this.#visible = visible;
    if (visible) {
      this.resetClock();
      this.schedule();
    } else this.cancel();
  }

  public resetClock(now = this.#input.timing.now()): void {
    this.#clockOrigin = now;
    this.#clockOrdinal = this.#ordinal;
    this.#deadline = this.#rationalDeadline(this.#ordinal + 1n);
  }

  public cancel(): void {
    this.#generation += 1;
    if (this.#raf !== null) {
      this.#input.timing.cancelAnimationFrame(this.#raf);
    }
    this.#raf = null;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancel();
  }

  #nextDeadline(): void {
    const next = this.#rationalDeadline(this.#ordinal + 1n);
    if (next <= this.#input.timing.now()) this.resetClock();
    else this.#deadline = next;
  }

  #rationalDeadline(ordinal: bigint): number {
    const delta = ordinal - this.#clockOrdinal;
    if (delta < 0n || delta > 1_000_000n) {
      this.#clockOrigin = this.#input.timing.now();
      this.#clockOrdinal = this.#ordinal;
      return this.#clockOrigin + this.#input.frameDurationMs;
    }
    return this.#clockOrigin + Number(delta) * this.#input.frameDurationMs;
  }
}
