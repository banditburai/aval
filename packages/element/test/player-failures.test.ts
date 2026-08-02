import { afterEach, describe, expect, it, vi } from "vitest";

import {
  admissionFailure,
  candidateReasonFailureCode,
  candidateRejectionFailureCode,
  limit,
  playbackFailureCode,
  playbackOperationFailureCode,
  preparationFailureCode,
  preparationOperationFailureCode,
  selectionFailureCode,
  startupFailureDisposition
} from "../src/player-failures.js";
import { AvalPlaybackError } from "../src/errors.js";

describe("player failure policy", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("preserves failure-code precedence across startup phases", () => {
    const unsupported = new DOMException("unsupported", "NotSupportedError");
    const resource = Object.assign(new RangeError("byte cap"), {
      name: "ResourceBudgetError"
    });
    const renderer = new Error("WebGL texture draw failed");
    const decoder = new Error("worker decoder failed");

    expect(preparationFailureCode(unsupported)).toBe("unsupported-profile");
    expect(admissionFailure(resource)).toBe(true);
    expect(selectionFailureCode(resource)).toBe("resource-rejection");
    expect(playbackFailureCode(renderer)).toBe("renderer-failure");
    expect(playbackFailureCode(decoder)).toBe("worker-decode-failure");
    expect(candidateRejectionFailureCode({
      stage: "probe",
      cause: "unsupported-config"
    })).toBe("unsupported-profile");
    expect(candidateRejectionFailureCode({
      stage: "decode",
      cause: "decode-progress-timeout"
    })).toBe("worker-decode-failure");
    expect(candidateReasonFailureCode("codec-unsupported"))
      .toBe("unsupported-profile");
    expect(candidateReasonFailureCode("no-video-rendition"))
      .toBe("unsupported-profile");
  });

  it("centralizes startup abort, timeout, and canonical-error precedence", () => {
    const abort = new DOMException("retired", "AbortError");
    const timeout = new DOMException("late", "TimeoutError");
    const canonical = new AvalPlaybackError(Object.freeze({
      code: "renderer-failure",
      message: "canonical",
      operation: "prepare"
    }), 1);

    expect(startupFailureDisposition({
      reason: timeout,
      sourceAborted: true,
      deadlineTimedOut: true
    })).toEqual({ kind: "abort" });
    expect(startupFailureDisposition({
      reason: abort,
      sourceAborted: false,
      deadlineTimedOut: true
    })).toEqual({ kind: "failure", code: "watchdog-timeout" });
    expect(startupFailureDisposition({
      reason: timeout,
      sourceAborted: false,
      deadlineTimedOut: false
    })).toEqual({ kind: "failure", code: "watchdog-timeout" });
    expect(startupFailureDisposition({
      reason: canonical,
      sourceAborted: false,
      deadlineTimedOut: false
    })).toEqual({ kind: "failure", code: "renderer-failure" });
  });

  it("gives timeout and resource admission precedence in phase policies", () => {
    const resource = Object.assign(new Error("decoder byte ceiling"), {
      name: "ResourceBudgetError"
    });

    expect(preparationOperationFailureCode(resource, true))
      .toBe("watchdog-timeout");
    expect(preparationOperationFailureCode(resource, false))
      .toBe("resource-rejection");
    expect(playbackOperationFailureCode(resource)).toBe("resource-rejection");
    expect(playbackOperationFailureCode(new Error("WebGL draw failed")))
      .toBe("renderer-failure");
  });

  it("passes through an unbounded successful operation", async () => {
    const operation = Promise.resolve("ready");
    expect(limit(operation)).toBe(operation);
    await expect(limit(operation)).resolves.toBe("ready");
  });

  it("rejects an operation aborted before it starts", async () => {
    const controller = new AbortController();
    const reason = new DOMException("retired", "AbortError");
    controller.abort(reason);

    await expect(limit(Promise.resolve(), controller.signal)).rejects.toBe(reason);
  });

  it("aborts during an operation and releases its listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const reason = new DOMException("retired", "AbortError");
    const bounded = limit(new Promise<void>(() => undefined), controller.signal);

    controller.abort(reason);
    await expect(bounded).rejects.toBe(reason);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("times out at the deadline and clears the timer", async () => {
    vi.useFakeTimers();
    const clearTimeout = vi.fn((handle: number) => {
      globalThis.clearTimeout(handle);
    });
    const bounded = limit(new Promise<void>(() => undefined), undefined, 25, {
      setTimeout: (callback, delay) =>
        globalThis.setTimeout(callback, delay) as unknown as number,
      clearTimeout
    });
    const rejection = expect(bounded).rejects.toMatchObject({
      name: "TimeoutError"
    });

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(clearTimeout).toHaveBeenCalledOnce();
  });
});
