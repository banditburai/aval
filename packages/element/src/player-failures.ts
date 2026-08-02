import { AvalPlaybackError } from "./errors.js";
import type { PlayerInput } from "./player-contract.js";
import type { RetryableCandidateRejection } from
  "./provisional-candidate-outcome.js";
import { UnsupportedPlaybackProfileError } from "./provisional-startup.js";
import { RendererFailureError } from "./renderer-diagnostics.js";
import type {
  RuntimeFailureCode,
  RuntimeReadinessResult,
  StaticReason
} from "./public-types.js";

export type CandidateReport =
  RuntimeReadinessResult["report"]["candidates"][number];

export type CandidateRejectionReason =
  | "codec-unsupported"
  | "no-video-rendition";

export function candidateReasonFailureCode(
  reason: CandidateRejectionReason
): "unsupported-profile" {
  switch (reason) {
    case "codec-unsupported":
    case "no-video-rendition":
      return "unsupported-profile";
  }
}

export class SelectionExhaustedError extends Error {
  public readonly failureCode: RuntimeFailureCode;

  public constructor(failureCode: RuntimeFailureCode) {
    super("No AVAL source completed startup qualification");
    this.name = "NotSupportedError";
    this.failureCode = failureCode;
  }
}

export function candidateReport(
  rendition: string,
  rank: number,
  reason: StaticReason | CandidateRejectionReason | RuntimeFailureCode | null
): Readonly<CandidateReport> {
  if (reason === null) {
    return Object.freeze({ rendition, rank, outcome: "selected", failure: null });
  }
  if (reason === "reduced-motion" || reason === "visibility-suspended" ||
    reason === "decoder-queued") {
    return Object.freeze({ rendition, rank, outcome: "eligible", failure: null });
  }
  const code = candidateReportFailureCode(reason);
  return Object.freeze({
    rendition,
    rank,
    outcome: "rejected",
    failure: Object.freeze({
      code,
      message: "animation candidate was rejected",
      context: Object.freeze({ rendition, rank })
    })
  });
}

function candidateReportFailureCode(
  reason: CandidateRejectionReason | RuntimeFailureCode
): RuntimeFailureCode {
  return reason === "codec-unsupported" || reason === "no-video-rendition"
    ? candidateReasonFailureCode(reason)
    : reason;
}

export function provisionalPlaybackFailure(
  code: RuntimeFailureCode,
  operation: string
): AvalPlaybackError {
  return new AvalPlaybackError(Object.freeze({
    code,
    message: `AVAL provisional candidate failed (${code})`,
    operation
  }), 1);
}

export function playbackErrorFailureCode(
  error: unknown
): RuntimeFailureCode | null {
  if (error instanceof SelectionExhaustedError) return error.failureCode;
  if (!(error instanceof AvalPlaybackError)) return null;
  return isRuntimeFailureCode(error.failure.code) ? error.failure.code : null;
}

export function candidateRejectionFailureCode(
  rejection: Readonly<RetryableCandidateRejection>
): RuntimeFailureCode {
  return rejection.stage === "probe"
    ? "unsupported-profile"
    : "worker-decode-failure";
}

export type StartupFailureDisposition =
  | Readonly<{ kind: "abort" }>
  | Readonly<{ kind: "failure"; code: RuntimeFailureCode }>;

export function startupFailureDisposition(input: Readonly<{
  reason: unknown;
  sourceAborted: boolean;
  deadlineTimedOut: boolean;
}>): StartupFailureDisposition {
  const timedOut = !input.sourceAborted && (
    input.deadlineTimedOut || isTimeout(input.reason)
  );
  if (input.sourceAborted || isAbort(input.reason) && !timedOut) {
    return Object.freeze({ kind: "abort" });
  }
  return Object.freeze({
    kind: "failure",
    code: timedOut
      ? "watchdog-timeout"
      : playbackErrorFailureCode(input.reason) ?? selectionFailureCode(input.reason)
  });
}

export function abortError(): DOMException {
  return new DOMException("AVAL operation was superseded", "AbortError");
}

export function playerAbortReason(signal: AbortSignal): Error {
  return signal.aborted && signal.reason instanceof Error
    ? signal.reason
    : abortError();
}

export function limit<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
  platform?: Pick<PlayerInput["platform"], "setTimeout" | "clearTimeout">
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    return Promise.reject(new RangeError("timeoutMs must be a positive integer"));
  }
  if (signal === undefined && timeoutMs === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    let timer: number | undefined;
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      if (timer !== undefined) (platform?.clearTimeout ?? clearTimeout)(timer);
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const abort = (): void => rejectOnce(signal?.reason ?? abortError());
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== undefined) timer = (platform?.setTimeout ?? setTimeout)(
      () => rejectOnce(new DOMException(
        "AVAL preparation timed out",
        "TimeoutError"
      )),
      timeoutMs
    );
    operation.then(resolveOnce, rejectOnce);
  });
}

export function unsupportedProfileError(): UnsupportedPlaybackProfileError {
  return new UnsupportedPlaybackProfileError(
    "AVAL has no supported animated rendition"
  );
}

export function admissionFailure(error: unknown): boolean {
  return errorString(error, "name") === "ResourceBudgetError" ||
    /resource declarations|resource budget|byte cap|byte ceiling/i.test(
      errorString(error, "message") ?? ""
    );
}

export function playbackFailureCode(
  reason: unknown
): "renderer-failure" | "worker-decode-failure" {
  if (reason instanceof RendererFailureError) return "renderer-failure";
  const message = errorString(reason, "message") ?? "";
  return /canvas|context|draw|renderer|texture|viewport|webgl/i.test(message)
    ? "renderer-failure"
    : "worker-decode-failure";
}

export function playbackOperationFailureCode(reason: unknown):
  | "resource-rejection"
  | "renderer-failure"
  | "worker-decode-failure" {
  return admissionFailure(reason)
    ? "resource-rejection"
    : playbackFailureCode(reason);
}

export function preparationFailureCode(reason: unknown):
  | "readiness-failure"
  | "renderer-failure"
  | "unsupported-profile"
  | "worker-decode-failure" {
  if (unsupportedProfileFailure(reason)) return "unsupported-profile";
  if (reason instanceof RendererFailureError) return "renderer-failure";
  const message = errorString(reason, "message") ?? "";
  if (/canvas|context|draw|renderer|texture|viewport|webgl/i.test(message)) {
    return "renderer-failure";
  }
  if (/codec|decode|decoder|frame|video/i.test(message)) {
    return "worker-decode-failure";
  }
  return "readiness-failure";
}

export function preparationOperationFailureCode(
  reason: unknown,
  timedOut: boolean
):
  | "watchdog-timeout"
  | "resource-rejection"
  | "readiness-failure"
  | "renderer-failure"
  | "unsupported-profile"
  | "worker-decode-failure" {
  if (timedOut) return "watchdog-timeout";
  return admissionFailure(reason)
    ? "resource-rejection"
    : preparationFailureCode(reason);
}

export function selectionFailureCode(reason: unknown):
  | "invalid-asset"
  | "resource-rejection"
  | "renderer-failure"
  | "worker-decode-failure"
  | "readiness-failure"
  | "unsupported-profile" {
  const message = errorString(reason, "message") ?? "";
  if (reason instanceof RendererFailureError) return "renderer-failure";
  if (unsupportedProfileFailure(reason)) return "unsupported-profile";
  if (admissionFailure(reason)) return "resource-rejection";
  if (/canvas|context|draw|renderer|texture|viewport|webgl/i.test(message)) {
    return "renderer-failure";
  }
  if (/codec|decode|decoder|frame|video|worker/i.test(message)) {
    return "worker-decode-failure";
  }
  if (/invalid aval|manifest|asset/i.test(message)) return "invalid-asset";
  return "readiness-failure";
}

export function rendererFailureOperation(
  reason: unknown,
  fallback: string
): string {
  if (!(reason instanceof RendererFailureError)) return fallback;
  if (reason.diagnostic.operation === "restore") return "restore";
  if (reason.diagnostic.phase === "resize") return "resize";
  return reason.diagnostic.operation === "construct" ? "prepare" : "render";
}

export function isAbort(error: unknown): boolean {
  return errorString(error, "name") === "AbortError";
}

export function isTimeout(error: unknown): boolean {
  return errorString(error, "name") === "TimeoutError";
}

function unsupportedProfileFailure(reason: unknown): boolean {
  return reason instanceof UnsupportedPlaybackProfileError ||
    errorString(reason, "name") === "NotSupportedError";
}

function isRuntimeFailureCode(value: unknown): value is RuntimeFailureCode {
  return value === "invalid-asset" || value === "load-failure" ||
    value === "range-response-invalid" || value === "entity-changed" ||
    value === "integrity-mismatch" || value === "unsupported-profile" ||
    value === "resource-rejection" || value === "readiness-failure" ||
    value === "worker-decode-failure" || value === "renderer-failure" ||
    value === "context-loss" || value === "watchdog-timeout" ||
    value === "underflow" || value === "abort" || value === "disposed";
}

function errorString(
  value: unknown,
  key: "name" | "message"
): string | null {
  if ((typeof value !== "object" && typeof value !== "function") ||
    value === null) return null;
  try {
    const field = (value as {
      readonly name?: unknown;
      readonly message?: unknown;
    })[key];
    return typeof field === "string" ? field : null;
  } catch { return null; }
}
