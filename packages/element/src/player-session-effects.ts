import {
  MOTION_GRAPH_STATIC_REASONS,
  type MotionGraphStaticReason,
  type MotionGraphEffect,
  type MotionGraphResult,
  type MotionGraphSnapshot
} from "@pixel-point/aval-graph";

import type { PlayerSessionPublicationPort } from
  "./player-session-contract.js";
import { PlayerTelemetry } from "./player-telemetry.js";

interface StateRequest {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

/** Owns state-request capabilities and graph-effect publication ordering. */
export class PlayerSessionEffects {
  readonly #publication: Readonly<PlayerSessionPublicationPort>;
  readonly #telemetry: PlayerTelemetry;
  readonly #requests = new Map<number, StateRequest>();

  public constructor(
    publication: Readonly<PlayerSessionPublicationPort>,
    telemetry: PlayerTelemetry
  ) {
    this.#publication = publication;
    this.#telemetry = telemetry;
  }

  public seed(snapshot: Readonly<MotionGraphSnapshot>): void {
    const state = snapshot.requestedState;
    if (state === null || snapshot.visualState !== state) {
      throw new Error("Invalid AVAL graph");
    }
    this.#publication.onEvent("requestedstatechange", Object.freeze({
      from: state,
      to: state,
      sequence: 0,
      isTransitioning: false
    }));
    this.#publication.onEvent("visualstatechange", Object.freeze({
      from: state,
      to: state,
      isTransitioning: false
    }));
  }

  public register(result: Readonly<MotionGraphResult>): Promise<void> {
    const id = result.requestId;
    if (id === undefined || this.#requests.has(id)) {
      throw new Error("Invalid AVAL graph request");
    }
    return new Promise<void>((resolve, reject) => {
      this.#requests.set(id, { resolve, reject });
    });
  }

  public applyAll(result: Readonly<MotionGraphResult>): void {
    for (const effect of result.effects) {
      this.#apply(effect, result.snapshot);
    }
  }

  public applyBeforeDraw(
    result: Readonly<MotionGraphResult>
  ): readonly Readonly<MotionGraphEffect>[] {
    const after: Readonly<MotionGraphEffect>[] = [];
    for (const effect of result.effects) {
      if (afterDraw(effect)) after.push(effect);
      else this.#apply(effect, result.snapshot);
    }
    return Object.freeze(after);
  }

  public applyAfterDraw(
    effects: readonly Readonly<MotionGraphEffect>[],
    snapshot: Readonly<MotionGraphSnapshot>,
    assertCurrent: () => void
  ): void {
    for (const effect of effects) {
      assertCurrent();
      this.#apply(effect, snapshot);
    }
  }

  public rejectAll(reason: string | Error): void {
    const error = typeof reason === "string" ? requestError(reason) : reason;
    for (const capability of this.#requests.values()) capability.reject(error);
    this.#requests.clear();
  }

  #apply(
    effect: Readonly<MotionGraphEffect>,
    snapshot: Readonly<MotionGraphSnapshot>
  ): void {
    if (effect.type === "readinesschange") {
      if (effect.to === "static") {
        this.#publication.onReadiness("staticReady", staticReason(effect.reason));
      }
      return;
    }
    if (effect.type === "settle") {
      const capabilities = effect.requestIds.map((id) => {
        const capability = this.#requests.get(id);
        if (capability === undefined) {
          throw new Error("Invalid AVAL request settlement");
        }
        this.#requests.delete(id);
        return capability;
      });
      this.#telemetry.recordSettledRequests(capabilities.length);
      queueMicrotask(() => {
        for (const capability of capabilities) {
          if (effect.outcome.type === "resolve") capability.resolve();
          else capability.reject(requestError(effect.outcome.error));
        }
      });
      return;
    }
    if (effect.type === "requestedstatechange") {
      this.#publication.onEvent(effect.type, Object.freeze({
        from: effect.from,
        to: effect.to,
        sequence: effect.sequence,
        isTransitioning: snapshot.isTransitioning
      }));
      return;
    }
    this.#publication.onEvent(effect.type, Object.freeze({
      ...(effect.type === "transitionstart"
        ? { edge: effect.edgeId, from: effect.from, to: effect.to,
            sequence: effect.sequence }
        : effect.type === "transitionend"
          ? { edge: effect.edgeId, from: effect.from, to: effect.to }
          : { from: effect.from, to: effect.to }),
      isTransitioning: effect.type === "transitionstart"
        ? true : snapshot.isTransitioning
    }));
    if (effect.type === "transitionstart") {
      this.#telemetry.recordTransitionStart();
    } else if (effect.type === "transitionend") {
      this.#telemetry.recordTransitionEnd();
    }
  }
}

function staticReason(reason: string | undefined): MotionGraphStaticReason {
  const matched = MOTION_GRAPH_STATIC_REASONS.find(
    (candidate) => candidate === reason
  );
  if (matched === undefined) throw new Error("Invalid AVAL graph static reason");
  return matched;
}

function afterDraw(effect: Readonly<MotionGraphEffect>): boolean {
  return effect.type === "transitionstart" ||
    effect.type === "visualstatechange" ||
    effect.type === "transitionend" || effect.type === "settle";
}

function requestError(name: string): Error {
  const error = new Error(name === "AbortError"
    ? "AVAL state request was superseded"
    : name === "RouteError"
      ? "AVAL state route is unavailable"
      : "AVAL state request failed");
  error.name = name;
  return error;
}
