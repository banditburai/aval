import { ELEMENT_DECODER_CAPACITY } from "@pixel-point/aval-element";

import { BrowserResourceLedger } from "./resource-ledger.js";
import { createPublicMotionElement, preparePublicMotion, retirePublicMotion } from "./public-element-host.js";

const MAX_SOAK_MS = 30 * 60 * 1_000;

export const CERTIFICATION_RUNTIME_CAPACITY = Object.freeze({
  preparationBatchSize: 1,
  decoderWorkersPerActiveElement: ELEMENT_DECODER_CAPACITY.workerCount,
  decoderRingSize: ELEMENT_DECODER_CAPACITY.ringSize,
  decodedSurfacesPerActiveElement: ELEMENT_DECODER_CAPACITY.totalDecodedSurfaces
});

export interface ResourceSoakReport {
  readonly status: "passed" | "failed" | "inconclusive";
  readonly requestedDurationMs: number;
  readonly elapsedMs: number;
  readonly playerCount: number;
  readonly samples: number;
  readonly runtimeCapacity: typeof CERTIFICATION_RUNTIME_CAPACITY;
  readonly peakCounters: Readonly<Record<string, number>>;
  readonly terminalCounters: readonly Readonly<Record<string, number>>[];
  readonly failures: readonly string[];
}

export async function runResourceSoak(options: Readonly<{
  parent: HTMLElement;
  sourceUrl: string;
  sourceIntegrity: string;
  durationMs: number;
  players: number;
  sampleIntervalMs?: number;
  signal?: AbortSignal;
}>): Promise<ResourceSoakReport> {
  const durationMs = boundedInteger(options.durationMs, 0, MAX_SOAK_MS, "soak duration");
  const playerCount = boundedInteger(options.players, 1, 16, "soak player count");
  const sampleIntervalMs = boundedInteger(options.sampleIntervalMs ?? 1_000, 16, 60_000, "soak sample interval");
  const ledger = new BrowserResourceLedger(Math.min(100_000, playerCount * (Math.ceil(durationMs / sampleIntervalMs) + 4)));
  const failures: string[] = [];
  const terminalCounters: Readonly<Record<string, number>>[] = Array.from(
    { length: playerCount },
    () => Object.freeze({ player: 0, decoder: 0, bytes: 0 })
  );
  const started = performance.now();
  for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
    if (isAborted(options.signal) || failures.length > 0) break;
    // One active element owns all element decoder workers. Retire it before
    // connecting the next participant so the public admission queue can make
    // progress without depending on an unpublished page-wide policy.
    const element = createPublicMotionElement(
      sourceGenerationUrl(options.sourceUrl, playerIndex),
      options.parent,
      undefined,
      options.sourceIntegrity
    );
    try {
      const initial = await preparePublicMotion(element, 20_000, options.signal);
      ledger.append(`player-${String(playerIndex)}-ready`, initial);
      const playerDurationMs = distributedDuration(
        durationMs,
        playerCount,
        playerIndex
      );
      const playerStarted = performance.now();
      while (
        performance.now() - playerStarted < playerDurationMs &&
        !isAborted(options.signal)
      ) {
        await delay(Math.min(
          sampleIntervalMs,
          Math.max(0, playerDurationMs - (performance.now() - playerStarted))
        ), options.signal);
        ledger.append(`player-${String(playerIndex)}-sample`, element.getDiagnostics());
      }
    } catch (error) {
      if (!isAborted(options.signal)) failures.push(error instanceof Error ? error.message : "unknown soak failure");
    } finally {
      const terminal = await retirePublicMotion(element).catch((error: unknown) => {
        failures.push(`player-${String(playerIndex)}:${error instanceof Error ? error.message : "unknown soak cleanup failure"}`);
        return null;
      });
      terminalCounters[playerIndex] = Object.freeze(terminal === null
        ? { player: 1, decoder: 1, bytes: 1 }
        : {
            player: terminal.outstanding.player ?? 0,
            decoder: terminal.outstanding.decoder ?? 0,
            bytes: terminal.outstanding.bytes ?? 0
          });
    }
  }
  for (const [index, counters] of terminalCounters.entries()) {
    if (Object.values(counters).some((value) => value !== 0)) failures.push(`player-${String(index)}-unsettled`);
  }
  return Object.freeze({
    status: isAborted(options.signal) ? "inconclusive" : failures.length === 0 ? "passed" : "failed",
    requestedDurationMs: durationMs,
    elapsedMs: Math.max(0, Math.floor(performance.now() - started)),
    playerCount,
    samples: ledger.snapshot().length,
    runtimeCapacity: CERTIFICATION_RUNTIME_CAPACITY,
    peakCounters: ledger.peakCounters(),
    terminalCounters: Object.freeze(terminalCounters),
    failures: Object.freeze(failures)
  });
}

function sourceGenerationUrl(sourceUrl: string, index: number): string {
  const url = new URL(sourceUrl, location.href);
  url.hash = `aval-certification-soak-${String(index)}`;
  return `${url.pathname}${url.search}${url.hash}`;
}

function distributedDuration(totalMs: number, participantCount: number, participantIndex: number): number {
  const base = Math.floor(totalMs / participantCount);
  return base + (participantIndex < totalMs % participantCount ? 1 : 0);
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be in ${String(minimum)}..${String(maximum)}`);
  return value;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    const abort = (): void => done();
    signal?.addEventListener("abort", abort, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
  });
}
