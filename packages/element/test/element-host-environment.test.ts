import { describe, expect, it, vi } from "vitest";

import {
  ElementHostEnvironment,
  type ElementHostEnvironmentCallbacks,
  type ElementHostEnvironmentPort,
  type HostDocumentTarget,
  type HostIntersectionEntry,
  type HostListenerTarget,
  type HostMediaQuery,
  type HostMutationObserver,
  type HostObserver,
  type HostViewTarget
} from "../src/element-host-environment.js";

describe("ElementHostEnvironment", () => {
  it("installs one realm owner and reports sources and geometry", () => {
    const harness = createHarness();
    const owner = harness.owner();

    expect(owner.install()).toBe(true);
    expect(owner.install()).toBe(true);
    expect(harness.mutations).toHaveLength(1);
    expect(harness.resizes).toHaveLength(1);
    expect(harness.intersections).toHaveLength(1);
    expect(harness.callbacks.geometryChanged).toHaveBeenCalledTimes(1);
    expect(owner.geometry).toEqual({ width: 120, height: 90, dpr: 1.5 });
    expect(Object.isFrozen(owner.geometry)).toBe(true);
    expect(owner.snapshot()).toMatchObject({
      installed: true,
      positiveBox: true,
      listenerCount: 5,
      observerCount: 3,
      failedReleaseCount: 0
    });

    harness.mutations[0]?.fire(["irrelevant", "source"]);
    harness.rect = { width: 80, height: 0, dpr: 2 };
    harness.resizes[0]?.fire();

    expect(harness.callbacks.sourcesChanged).toHaveBeenCalledTimes(1);
    expect(harness.callbacks.geometryChanged).toHaveBeenLastCalledWith({
      width: 80,
      height: 0,
      dpr: 2
    });
    expect(owner.geometry).toEqual({ width: 80, height: 0, dpr: 2 });
    expect(owner.snapshot().positiveBox).toBe(false);
  });

  it("takes pending source records through the current observer only", () => {
    const harness = createHarness();
    const owner = harness.owner();
    owner.install();
    harness.mutations[0]?.queue(["irrelevant"]);
    expect(owner.takeSourceChanges()).toBe(false);
    harness.mutations[0]?.queue(["source"]);
    expect(owner.takeSourceChanges()).toBe(true);
    expect(owner.takeSourceChanges()).toBe(false);
  });

  it("owns the first-intersection gate and resolves it on a sample", async () => {
    const harness = createHarness();
    const owner = harness.owner();
    owner.install();

    expect(owner.needsIntersectionSample()).toBe(true);
    let settled = false;
    const gate = owner.waitForIntersection().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    harness.intersections[0]?.fire([{ isIntersecting: true, intersectionRatio: 1 }]);
    await gate;

    expect(owner.needsIntersectionSample()).toBe(false);
    expect(owner.snapshot()).toMatchObject({
      intersectionKnown: true,
      intersecting: true,
      effectivelyVisible: true
    });
    expect(harness.callbacks.visibilityChanged).toHaveBeenLastCalledWith({
      reason: "intersection"
    });
  });

  it("reports document, page lifecycle, and reduced-motion changes", async () => {
    const harness = createHarness();
    const owner = harness.owner();
    owner.install();
    const gate = owner.waitForIntersection();

    harness.document.visibilityState = "hidden";
    harness.document.emit("visibilitychange");
    await gate;
    harness.view.emit("pagehide");
    harness.view.emit("pageshow", { persisted: true });
    harness.media.matches = true;
    harness.media.emitChange();
    owner.reconcileMotionPreference();
    harness.media.matches = false;
    owner.reconcileMotionPreference();

    expect(harness.callbacks.visibilityChanged.mock.calls.map(
      ([change]) => change.reason
    )).toEqual(["document", "pagehide", "bfcache-restore"]);
    expect(harness.callbacks.motionPreferenceChanged.mock.calls).toEqual([
      [true],
      [false]
    ]);
    expect(owner.snapshot()).toMatchObject({
      documentVisible: false,
      reducedMotion: false
    });
  });

  it("retires an old realm, rejects stale callbacks, and scopes adoption claims", () => {
    const harness = createHarness();
    const owner = harness.owner();
    owner.install();
    const oldMutation = harness.mutations[0]!;
    const oldResize = harness.resizes[0]!;
    const oldIntersection = harness.intersections[0]!;

    harness.document = new FakeDocument();
    harness.view = new FakeView();
    harness.root = {};
    harness.media = new FakeMediaQuery();
    const firstAdoption = owner.beginAdoption();
    expect(firstAdoption.current()).toBe(true);
    const secondAdoption = owner.beginAdoption();
    expect(firstAdoption.current()).toBe(false);
    expect(secondAdoption.current()).toBe(true);
    expect(harness.callbacks.realmChanged).toHaveBeenCalledTimes(2);
    expect(owner.rootChanged()).toBe(false);

    expect(owner.install()).toBe(true);
    oldMutation.fire(["source"]);
    oldResize.fire();
    oldIntersection.fire([{ isIntersecting: true, intersectionRatio: 1 }]);

    expect(harness.callbacks.sourcesChanged).not.toHaveBeenCalled();
    expect(harness.callbacks.geometryChanged).toHaveBeenCalledTimes(2);
    expect(harness.callbacks.visibilityChanged).not.toHaveBeenCalled();
    expect(harness.mutations).toHaveLength(2);
  });

  it("detects root replacement before reinstall", () => {
    const harness = createHarness();
    const owner = harness.owner();
    owner.install();
    expect(owner.rootChanged()).toBe(false);
    harness.root = {};
    expect(owner.rootChanged()).toBe(true);
    owner.install();
    expect(harness.mutations).toHaveLength(2);
  });

  it("retains one-time observer and listener removal failures for retry", () => {
    const harness = createHarness();
    const owner = harness.owner();
    owner.install();
    harness.mutations[0]!.failNextDisconnect = true;
    harness.view.failNextRemoval = true;

    owner.remove();
    expect(owner.snapshot()).toMatchObject({
      installed: false,
      failedReleaseCount: 2,
      failedListenerReleaseCount: 1,
      failedObserverReleaseCount: 1,
      listenerCount: 1,
      observerCount: 1
    });

    owner.remove();
    owner.remove();
    expect(owner.snapshot()).toMatchObject({
      failedReleaseCount: 0,
      listenerCount: 0,
      observerCount: 0
    });
  });
});

class FakeListenerTarget implements HostListenerTarget {
  failNextRemoval = false;
  readonly #listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.#listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (this.failNextRemoval) {
      this.failNextRemoval = false;
      throw new Error("temporary listener removal failure");
    }
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type: string, fields: Readonly<Record<string, unknown>> = {}): void {
    const event = new Event(type);
    for (const [name, value] of Object.entries(fields)) {
      Object.defineProperty(event, name, { value });
    }
    for (const listener of [...this.#listeners.get(type) ?? []]) listener(event);
  }
}

class FakeDocument extends FakeListenerTarget implements HostDocumentTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

class FakeView extends FakeListenerTarget implements HostViewTarget {}

class FakeMediaQuery extends FakeListenerTarget implements HostMediaQuery {
  matches = false;

  emitChange(): void { this.emit("change"); }
}

class FakeObserver implements HostObserver {
  started = false;
  disconnectCount = 0;
  failNextDisconnect = false;

  start(): void { this.started = true; }

  disconnect(): void {
    this.disconnectCount += 1;
    if (this.failNextDisconnect) {
      this.failNextDisconnect = false;
      throw new Error("temporary observer disconnect failure");
    }
    this.started = false;
  }
}

class FakeResizeObserver extends FakeObserver {
  constructor(readonly callback: () => void) { super(); }
  fire(): void { this.callback(); }
}

class FakeIntersectionObserver extends FakeObserver {
  constructor(
    readonly callback: (entries: readonly HostIntersectionEntry[]) => void
  ) { super(); }
  fire(entries: readonly HostIntersectionEntry[]): void { this.callback(entries); }
}

class FakeMutationObserver extends FakeObserver implements HostMutationObserver<string> {
  readonly #pending: string[] = [];

  constructor(readonly callback: (records: readonly string[]) => void) {
    super();
  }

  fire(records: readonly string[]): void { this.callback(records); }

  queue(records: readonly string[]): void { this.#pending.push(...records); }

  takeRecords(): readonly string[] { return this.#pending.splice(0); }
}

function createHarness(): {
  document: FakeDocument;
  view: FakeView;
  root: object;
  media: FakeMediaQuery;
  rect: { width: number; height: number; dpr: number };
  readonly mutations: FakeMutationObserver[];
  readonly resizes: FakeResizeObserver[];
  readonly intersections: FakeIntersectionObserver[];
  readonly callbacks: {
    readonly sourcesChanged: ReturnType<typeof vi.fn<() => void>>;
    readonly geometryChanged: ReturnType<typeof vi.fn>;
    readonly visibilityChanged: ReturnType<typeof vi.fn>;
    readonly motionPreferenceChanged: ReturnType<typeof vi.fn>;
    readonly realmChanged: ReturnType<typeof vi.fn<() => void>>;
  };
  owner(): ElementHostEnvironment<string>;
} {
  const harness = {
    document: new FakeDocument(),
    view: new FakeView(),
    root: {},
    media: new FakeMediaQuery(),
    rect: { width: 120, height: 90, dpr: 1.5 },
    mutations: [] as FakeMutationObserver[],
    resizes: [] as FakeResizeObserver[],
    intersections: [] as FakeIntersectionObserver[],
    callbacks: {
      sourcesChanged: vi.fn<() => void>(),
      geometryChanged: vi.fn(),
      visibilityChanged: vi.fn(),
      motionPreferenceChanged: vi.fn(),
      realmChanged: vi.fn<() => void>()
    },
    owner(): ElementHostEnvironment<string> {
      const environment: ElementHostEnvironmentPort<string> = {
        currentDocument: () => harness.document,
        currentView: () => harness.view,
        currentRoot: () => harness.root,
        measure: () => harness.rect,
        isSourceMutation: (record) => record === "source",
        createMutationObserver: (callback) => {
          const observer = new FakeMutationObserver(callback);
          harness.mutations.push(observer);
          return observer;
        },
        createResizeObserver: (callback) => {
          const observer = new FakeResizeObserver(callback);
          harness.resizes.push(observer);
          return observer;
        },
        createIntersectionObserver: (callback) => {
          const observer = new FakeIntersectionObserver(callback);
          harness.intersections.push(observer);
          return observer;
        },
        createReducedMotionQuery: () => harness.media,
        abortError: () => new DOMException("Host observation removed", "AbortError")
      };
      return new ElementHostEnvironment({
        environment,
        callbacks: harness.callbacks satisfies ElementHostEnvironmentCallbacks
      });
    }
  };
  return harness;
}
