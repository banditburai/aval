import { describe, expect, it } from "vitest";

import { OwnedReleaseTracker } from "../src/owned-releases.js";

describe("OwnedReleaseTracker", () => {
  it("does not retain successful releases", () => {
    const tracker = new OwnedReleaseTracker();
    let calls = 0;

    expect(tracker.attempt("listener", () => { calls += 1; })).toBe(true);

    expect(calls).toBe(1);
    expect(tracker.pendingCount).toBe(0);
    expect(tracker.snapshot()).toEqual({
      pendingCount: 0,
      listenerCount: 0,
      observerCount: 0
    });
  });

  it("retains a failed release until retry succeeds", () => {
    const tracker = new OwnedReleaseTracker();
    let calls = 0;

    expect(tracker.attempt("listener", () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary removal failure");
    })).toBe(false);
    expect(tracker.pendingCount).toBe(1);

    tracker.retry();
    tracker.retry();

    expect(calls).toBe(2);
    expect(tracker.pendingCount).toBe(0);
  });

  it("keeps listener and observer failures typed and isolated", () => {
    const tracker = new OwnedReleaseTracker();
    tracker.attempt("listener", () => { throw new Error("listener"); });
    tracker.attempt("observer", () => { throw new Error("observer"); });

    const snapshot = tracker.snapshot();
    expect(snapshot).toEqual({
      pendingCount: 2,
      listenerCount: 1,
      observerCount: 1
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("does not lose a release registered during retry", () => {
    const tracker = new OwnedReleaseTracker();
    let firstAttempt = true;
    let nestedCalls = 0;
    tracker.attempt("listener", () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("retry me");
      }
      tracker.attempt("observer", () => {
        nestedCalls += 1;
        throw new Error("still pending");
      });
    });
    tracker.retry();

    expect(nestedCalls).toBe(1);
    expect(tracker.snapshot()).toEqual({
      pendingCount: 1,
      listenerCount: 0,
      observerCount: 1
    });
  });
});
