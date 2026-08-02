import type { GraphPresentation } from "@pixel-point/aval-graph";
import type { Unit } from "@pixel-point/aval-format";

import type { DecodeRun } from "./decoder.js";
import type { DecoderPoolCandidate } from "./decoder-pool.js";
import type {
  PlayerMediaDrawFinalization,
  PlayerMediaLease
} from "./player-media-contract.js";

interface ActiveMediaBase {
  readonly unit: Unit;
  lastIndex: number;
}

interface ResidentMedia extends ActiveMediaBase {
  readonly kind: "resident";
}

export interface StreamMedia extends ActiveMediaBase {
  readonly kind: "stream";
  readonly run: DecodeRun;
  needsDecoderRunQualification: boolean;
  drainedIndex: number;
  drain: Promise<void>;
}

export type ActiveMedia = ResidentMedia | StreamMedia;
export type StreamReservation =
  | Readonly<{ kind: "foreground"; media: StreamMedia }>
  | Readonly<{
      kind: "candidate";
      media: StreamMedia;
      candidate: DecoderPoolCandidate;
    }>;

interface PendingFinalization {
  readonly lease: PlayerMediaLease | null;
  readonly release: () => void;
}

/** Owns stream cursors, reservations, held frames, and their retirement. */
export class PlayerMediaStreamOwner {
  readonly #leases = new Map<symbol, StreamReservation>();
  readonly #finalizations = new Map<symbol, PendingFinalization>();
  readonly #drains = new Set<Promise<void>>();
  #initial: Readonly<{ unit: Unit; run: DecodeRun }> | null = null;
  #active: ActiveMedia | null = null;
  #retired = false;

  public get initialUnitId(): string | null {
    return this.#initial?.unit.id ?? null;
  }

  public get activeUnitId(): string | null {
    return this.#active?.unit.id ?? null;
  }

  public activeDescriptor(): Readonly<{
    unitId: string;
    mode: ActiveMedia["kind"];
  }> | null {
    const active = this.#active;
    return active === null ? null : Object.freeze({
      unitId: active.unit.id,
      mode: active.kind
    });
  }

  public activeRun(): DecodeRun | null {
    return this.#active?.kind === "stream" ? this.#active.run : null;
  }

  public installInitial(unit: Unit, run: DecodeRun): void {
    if (this.#retired || this.#initial !== null || this.#active !== null) {
      throw new Error("Invalid AVAL initial media ownership");
    }
    this.#initial = Object.freeze({ unit, run });
  }

  public requiredUnit(
    presentation: Readonly<GraphPresentation>,
    lastDraw: string,
    unitFor: (id: string) => Unit
  ): Unit | null {
    if (presentation.kind === "static" || presentation.kind === "reversible") {
      return null;
    }
    const key = `${presentation.kind}\0${presentation.unitId}\0${String(presentation.frameIndex)}`;
    if (key === lastDraw) return null;
    const unit = unitFor(presentation.unitId);
    const active = this.#active;
    return active === null || active.kind === "resident" ||
      active.unit.id !== unit.id || presentation.frameIndex <= active.lastIndex
      ? unit : null;
  }

  public acquire(
    unit: Unit,
    candidate: DecoderPoolCandidate | null
  ): PlayerMediaLease {
    if (this.#retired) throw abortException();
    let reservation: StreamReservation;
    const initial = this.#initial;
    if (initial?.unit.id === unit.id) {
      if (candidate !== null) candidate.cancel();
      this.#initial = null;
      reservation = Object.freeze({
        kind: "foreground" as const,
        media: createStreamMedia(unit, initial.run)
      });
    } else {
      if (candidate === null || candidate.unitId !== unit.id) {
        candidate?.cancel();
        throw new Error("AVAL candidate route identity diverged");
      }
      reservation = Object.freeze({
        kind: "candidate" as const,
        media: createStreamMedia(unit, candidate.run),
        candidate
      });
    }
    const token = Symbol("player-media-lease");
    this.#leases.set(token, reservation);
    return Object.freeze({ token });
  }

  public reservation(lease: PlayerMediaLease | null): StreamReservation | null {
    if (lease === null) return null;
    const reservation = this.#leases.get(lease.token);
    if (reservation === undefined) {
      throw new Error("Invalid AVAL media lease");
    }
    return reservation;
  }

  public cancel(lease: PlayerMediaLease | null): void {
    if (lease === null) return;
    const reservation = this.#leases.get(lease.token);
    if (reservation === undefined) return;
    this.#leases.delete(lease.token);
    cancelReservation(reservation);
  }

  public streamFor(
    unit: Unit,
    frameIndex: number,
    reservation: StreamReservation | null
  ): StreamMedia {
    const previous = this.#active;
    const replacing = previous === null || previous.kind === "resident" ||
      previous.unit.id !== unit.id || frameIndex <= previous.lastIndex;
    if (replacing !== (reservation !== null)) {
      throw new Error("Invalid AVAL stream replacement");
    }
    const active = reservation?.media ?? previous;
    if (active === null || active.kind !== "stream" ||
      active.unit.id !== unit.id) {
      throw new Error("Invalid AVAL stream replacement");
    }
    return active;
  }

  public commitStream(
    active: StreamMedia,
    reservation: StreamReservation | null,
    onCandidateCommit: (candidate: DecoderPoolCandidate) => void
  ): void {
    if (reservation === null) return;
    const previous = this.#active;
    if (reservation.media !== active) {
      throw new Error("Invalid AVAL stream reservation");
    }
    if (reservation.kind === "candidate") {
      reservation.candidate.commit();
      onCandidateCommit(reservation.candidate);
    }
    this.#active = active;
    if (reservation.kind === "foreground") closeActive(previous);
  }

  public activateResident(unit: Unit): ResidentMedia {
    const previous = this.#active;
    const resident = previous?.kind === "resident" &&
      previous.unit.id === unit.id
      ? previous
      : { kind: "resident" as const, unit, lastIndex: -1 };
    if (resident !== previous) {
      this.#active = resident;
      closeActive(previous);
    }
    return resident;
  }

  public async drawStreamFrame(
    active: StreamMedia,
    frameIndex: number,
    draw: (frame: VideoFrame, newDecoderRun: boolean) => Promise<void>,
    release: (run: DecodeRun, frame: VideoFrame) => void
  ): Promise<() => void> {
    if (active.drainedIndex < frameIndex - 1) {
      this.#drainThrough(active, frameIndex - 1, release);
    }
    await active.drain;
    const frame = await active.run.take(frameIndex);
    try {
      await draw(frame, active.needsDecoderRunQualification);
      active.needsDecoderRunQualification = false;
      active.drainedIndex = frameIndex;
      active.lastIndex = frameIndex;
      return once(() => release(active.run, frame));
    } catch (error) {
      release(active.run, frame);
      throw error;
    }
  }

  public markStoredFrame(active: ActiveMedia, frameIndex: number): void {
    active.lastIndex = frameIndex;
  }

  public drainStoredStream(
    active: StreamMedia,
    frameIndex: number,
    release: (run: DecodeRun, frame: VideoFrame) => void
  ): Promise<void> {
    return this.#drainThrough(active, frameIndex, release);
  }

  public holdFinalization(
    lease: PlayerMediaLease | null,
    release: () => void = () => undefined
  ): Readonly<PlayerMediaDrawFinalization> {
    if (lease !== null && !this.#leases.has(lease.token)) {
      throw new Error("Invalid AVAL media lease");
    }
    const token = Symbol("player-media-draw-finalization");
    this.#finalizations.set(token, Object.freeze({ lease, release }));
    return Object.freeze({ token });
  }

  public finalize(finalization: Readonly<PlayerMediaDrawFinalization>): void {
    const pending = this.#finalizations.get(finalization.token);
    if (pending === undefined) return;
    this.#finalizations.delete(finalization.token);
    if (pending.lease !== null) this.#leases.delete(pending.lease.token);
    pending.release();
  }

  public async settled(): Promise<void> {
    while (this.#drains.size > 0) {
      await Promise.allSettled([...this.#drains]);
    }
  }

  public async retire(): Promise<void> {
    if (this.#retired) return;
    this.#retired = true;
    const failures: unknown[] = [];
    for (const token of [...this.#finalizations.keys()]) {
      try { this.finalize(Object.freeze({ token })); }
      catch (error) { failures.push(error); }
    }
    for (const reservation of this.#leases.values()) {
      try { cancelReservation(reservation); }
      catch (error) { failures.push(error); }
    }
    this.#leases.clear();
    try { this.#initial?.run.close(); }
    catch (error) { failures.push(error); }
    this.#initial = null;
    try { closeActive(this.#active); }
    catch (error) { failures.push(error); }
    this.#active = null;
    await this.settled();
    if (failures.length > 0) throw failures[0];
  }

  #drainThrough(
    active: StreamMedia,
    index: number,
    release: (run: DecodeRun, frame: VideoFrame) => void
  ): Promise<void> {
    const operation = active.drain.then(async () => {
      for (let cursor = active.drainedIndex + 1; cursor <= index; cursor += 1) {
        const frame = await active.run.take(cursor);
        release(active.run, frame);
        active.drainedIndex = cursor;
      }
    });
    active.drain = operation;
    this.#drains.add(operation);
    void operation.finally(() => this.#drains.delete(operation))
      .catch(() => undefined);
    return operation;
  }
}

function createStreamMedia(unit: Unit, run: DecodeRun): StreamMedia {
  return {
    kind: "stream",
    unit,
    run,
    needsDecoderRunQualification: true,
    lastIndex: -1,
    drainedIndex: -1,
    drain: Promise.resolve()
  };
}

function cancelReservation(reservation: StreamReservation): void {
  if (reservation.kind === "candidate") reservation.candidate.cancel();
  else reservation.media.run.close();
}

function closeActive(active: ActiveMedia | null): void {
  if (active?.kind === "stream") active.run.close();
}

function once(operation: () => void): () => void {
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    operation();
  };
}

function abortException(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}
