import { describe, expect, it, vi } from "vitest";

import {
  AvalAdapterBindingImplementation,
  type AvalAdapterBindingElementPort,
  type AvalAdapterBindingEnvironment,
  type AvalAdapterBindingNode
} from "../src/adapter-binding.js";
import {
  createAvalAdapterConfiguration,
  type AvalAdapterOptions
} from "../src/adapter-options.js";
import type {
  AvalErrorDetail,
  AvalSnapshot,
  RuntimeReadinessResult
} from "../src/public-types.js";

describe("AvalAdapterBindingImplementation", () => {
  it("has stable pre-mount state and safe command behavior", async () => {
    const binding = new AvalAdapterBindingImplementation(configuration());
    const status = binding.getStatus();

    expect(Object.isFrozen(status)).toBe(true);
    expect(binding.getStatus()).toBe(status);
    expect(binding.getServerStatus()).toBe(status);
    expect(status).toMatchObject({
      mounted: false,
      readiness: "unready",
      paused: true,
      effectivelyVisible: false
    });
    expect(binding.send("retry")).toBe(false);
    expect(binding.readyFor("idle")).toBe(false);
    expect(binding.getDiagnostics()).toBeNull();
    expect(() => binding.pause()).not.toThrow();
    await expect(binding.prepare()).rejects.toMatchObject({
      name: "NotReadyError"
    });
    await expect(binding.setState("idle")).rejects.toMatchObject({
      name: "NotReadyError"
    });
    await expect(binding.play()).rejects.toMatchObject({
      name: "NotReadyError"
    });
  });

  it("publishes render options only for semantic configuration changes", () => {
    const binding = new AvalAdapterBindingImplementation(configuration());
    const listener = vi.fn();
    const unsubscribe = binding.subscribeOptions(listener);

    binding.commit(configuration({ onError: vi.fn() }));
    expect(listener).not.toHaveBeenCalled();

    binding.commit(configuration({ state: "loading" }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(binding.getRenderOptions().state).toBe("loading");

    unsubscribe();
    unsubscribe();
    binding.commit(configuration({
      sources: { h264: "/other.avl" },
      state: "loading"
    }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("installs semantic listeners before upgrading the element", () => {
    const element = new TestElementPort();
    const binding = createBinding(element, {}, (node) => {
      expect(node).toBe(element);
      expect(element.nativeListenerCount).toBe(5);
    });

    binding.attach(element);
  });

  it("rolls back partial listener installation when attachment fails", () => {
    const element = new TestElementPort(2);
    const binding = createBinding(element);

    expect(() => binding.attach(element)).toThrow(/listener failure/u);
    expect(element.nativeListenerCount).toBe(0);
    expect(element.snapshotSubscriberCount).toBe(0);
    expect(binding.getStatus()).toBe(binding.getServerStatus());
  });

  it("closes one attachment and all owned resources without disposal", () => {
    const element = new TestElementPort();
    const binding = createBinding(element);
    const target = testTarget();

    binding.attach(element);
    binding.finalizeBindingTarget(target);
    const cancel = binding.beginReadyPreparation();
    const signal = element.preparationSignals[0];

    expect(binding.getStatus().mounted).toBe(true);
    expect(element.interactionTarget).toBe(target);
    expect(element.snapshotSubscriberCount).toBe(1);
    expect(element.nativeListenerCount).toBe(5);

    binding.attach(null);
    cancel();

    expect(signal?.aborted).toBe(true);
    expect(element.interactionTarget).toBeNull();
    expect(element.snapshotSubscriberCount).toBe(0);
    expect(element.nativeListenerCount).toBe(0);
    expect(element.disposeCallCount).toBe(0);
    expect(binding.getStatus()).toBe(binding.getServerStatus());
  });

  it("ignores stale preparation completion by operation identity", async () => {
    const element = new TestElementPort();
    const onReady = vi.fn();
    const binding = createBinding(element, { onReady });
    binding.attach(element);
    binding.finalizeBindingTarget(undefined);

    binding.beginReadyPreparation();
    const firstSignal = element.preparationSignals[0];
    binding.commit(configuration({
      sources: { h264: "/replacement.avl" },
      onReady
    }));
    binding.beginReadyPreparation();

    expect(firstSignal?.aborted).toBe(true);
    element.resolvePreparation(0);
    await Promise.resolve();
    expect(onReady).not.toHaveBeenCalled();

    element.resolvePreparation(1);
    expect(onReady).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(READY_RESULT);
  });

  it("defers an onReady callback failure after preparation settles", async () => {
    const element = new TestElementPort();
    const callbackError = new Error("ready callback failure");
    const defer = vi.spyOn(globalThis, "queueMicrotask")
      .mockImplementation(() => undefined);
    try {
      const binding = createBinding(element, {
        onReady() { throw callbackError; }
      });
      binding.attach(element);
      binding.finalizeBindingTarget(undefined);
      binding.beginReadyPreparation();

      element.resolvePreparation(0);
      expect(defer).not.toHaveBeenCalled();
      await Promise.resolve();

      expect(defer).toHaveBeenCalledTimes(1);
      const deferredRethrow = defer.mock.calls[0]?.[0];
      expect(deferredRethrow).toBeTypeOf("function");
      expect(() => deferredRethrow?.()).toThrow(callbackError);
    } finally {
      defer.mockRestore();
    }
  });

  it("uses replacement callbacks without republishing render options", () => {
    const element = new TestElementPort();
    const first = vi.fn();
    const replacement = vi.fn();
    const binding = createBinding(element, { onError: first });
    const optionsListener = vi.fn();
    binding.subscribeOptions(optionsListener);
    binding.attach(element);

    binding.commit(configuration({ onError: replacement }));
    element.dispatch("error", ERROR_DETAIL);

    expect(optionsListener).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledWith(ERROR_DETAIL);
  });

  it("invokes semantic callbacks synchronously and preserves thrown errors", () => {
    const element = new TestElementPort();
    const callbackError = new Error("callback failure");
    const order: string[] = [];
    const binding = createBinding(element, {
      onError() {
        order.push("callback");
        throw callbackError;
      }
    });
    binding.attach(element);

    order.push("before-dispatch");
    expect(() => element.dispatch("error", ERROR_DETAIL)).toThrow(callbackError);
    order.push("after-dispatch");

    expect(order).toEqual([
      "before-dispatch",
      "callback",
      "after-dispatch"
    ]);
  });

  it("replaces and clears one binding target without duplicate writes", () => {
    const element = new TestElementPort();
    const binding = createBinding(element);
    const first = testTarget();
    const second = testTarget();

    binding.attach(element);
    binding.finalizeBindingTarget(first);
    binding.finalizeBindingTarget(first);
    binding.finalizeBindingTarget(second);
    binding.clearBindingTarget();
    binding.clearBindingTarget();
    binding.finalizeBindingTarget(second);

    expect(element.interactionTargetWrites).toEqual([
      first,
      second,
      null,
      second
    ]);
  });

  it("does not rewrite an already-clear target while closing", () => {
    const element = new TestElementPort();
    const binding = createBinding(element);
    const target = testTarget();

    binding.attach(element);
    binding.finalizeBindingTarget(target);
    binding.clearBindingTarget();
    binding.attach(null);

    expect(element.interactionTargetWrites).toEqual([target, null]);
  });

  it("enforces one mounted host per binding", () => {
    const first = new TestElementPort();
    const second = new TestElementPort();
    const binding = createBinding(first);
    binding.attach(first);

    expect(() => binding.attach(second)).toThrow(/cannot be mounted more than once/u);
    expect(first.snapshotSubscriberCount).toBe(1);
    expect(second.snapshotSubscriberCount).toBe(0);
  });

  it("projects status only when the element snapshot identity changes", () => {
    const element = new TestElementPort();
    const binding = createBinding(element);
    binding.attach(element);
    binding.finalizeBindingTarget(undefined);
    const initialStatus = binding.getStatus();
    const listener = vi.fn();
    binding.subscribeStatus(listener);

    element.publishCurrentSnapshot();
    expect(binding.getStatus()).toBe(initialStatus);
    expect(listener).not.toHaveBeenCalled();

    element.publishNewSnapshot();
    expect(binding.getStatus()).not.toBe(initialStatus);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

const READY_RESULT: RuntimeReadinessResult = Object.freeze({
  mode: "animated",
  assurance: "best-effort",
  report: Object.freeze({
    readiness: "interactiveReady",
    selectedRendition: "h264",
    candidates: Object.freeze([])
  })
});

const ERROR_DETAIL: AvalErrorDetail = Object.freeze({
  generation: 1,
  fatal: true,
  failure: Object.freeze({
    code: "load-failure",
    message: "test failure",
    operation: "prepare"
  })
});

function configuration(
  overrides: Readonly<Partial<AvalAdapterOptions>> = {}
) {
  const { sources = { h264: "/motion.avl" }, ...options } = overrides;
  return createAvalAdapterConfiguration({
    ...options,
    sources
  });
}

function createBinding(
  element: TestElementPort,
  callbacks: Readonly<{
    readonly onReady?: () => void;
    readonly onError?: (detail: Readonly<AvalErrorDetail>) => void;
  }> = {},
  beforeUpgrade: (node: AvalAdapterBindingNode) => void = () => undefined
): AvalAdapterBindingImplementation {
  const environment: AvalAdapterBindingEnvironment = {
    upgrade(node: AvalAdapterBindingNode): AvalAdapterBindingElementPort {
      beforeUpgrade(node);
      expect(node).toBe(element);
      return element;
    }
  };
  return new AvalAdapterBindingImplementation(configuration(callbacks), environment);
}

function testTarget(): Element {
  return Object.freeze({}) as unknown as Element;
}

function snapshot(revision: number): Readonly<AvalSnapshot> {
  return Object.freeze({
    revision,
    generation: 1,
    connected: true,
    readiness: "interactiveReady",
    mode: "animated",
    assurance: "best-effort",
    staticReason: null,
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false,
    paused: false,
    effectivelyVisible: true,
    stateNames: Object.freeze(["idle"]),
    eventNames: Object.freeze([]),
    inputBindings: Object.freeze([]),
    lastError: null
  });
}

class TestElementPort implements AvalAdapterBindingNode, AvalAdapterBindingElementPort {
  readonly #nativeListeners = new Map<string, Set<EventListener>>();
  readonly #snapshotListeners = new Set<() => void>();
  readonly #preparations: Array<(result: RuntimeReadinessResult) => void> = [];
  readonly preparationSignals: Array<AbortSignal | null> = [];
  readonly interactionTargetWrites: Array<Element | null> = [];
  #disposeCallCount = 0;
  readonly #failListenerAt: number | null;
  #interactionTarget: Element | null = null;
  #snapshot: Readonly<AvalSnapshot> = snapshot(0);

  public constructor(failListenerAt: number | null = null) {
    this.#failListenerAt = failListenerAt;
  }

  public get interactionTarget(): Element | null {
    return this.#interactionTarget;
  }

  public set interactionTarget(value: Element | null) {
    this.#interactionTarget = value;
    this.interactionTargetWrites.push(value);
  }

  public get nativeListenerCount(): number {
    return [...this.#nativeListeners.values()].reduce(
      (count, listeners) => count + listeners.size,
      0
    );
  }

  public get snapshotSubscriberCount(): number {
    return this.#snapshotListeners.size;
  }

  public get disposeCallCount(): number {
    return this.#disposeCallCount;
  }

  public addEventListener(type: string, listener: EventListener): void {
    if (this.nativeListenerCount === this.#failListenerAt) {
      throw new Error("listener failure");
    }
    const listeners = this.#nativeListeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#nativeListeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    this.#nativeListeners.get(type)?.delete(listener);
  }

  public prepare(
    options?: Readonly<{ readonly signal?: AbortSignal; readonly timeoutMs?: number }>
  ): Promise<RuntimeReadinessResult> {
    this.preparationSignals.push(options?.signal ?? null);
    return new Promise((resolve) => {
      this.#preparations.push(resolve);
    });
  }

  public resolvePreparation(index: number): void {
    this.#preparations[index]?.(READY_RESULT);
  }

  public async setState(): Promise<void> {}
  public send(): boolean { return false; }
  public readyFor(): boolean { return false; }
  public pause(): void {}
  public async resume(): Promise<void> {}
  public dispose(): void { this.#disposeCallCount += 1; }

  public getSnapshot(): Readonly<AvalSnapshot> {
    return this.#snapshot;
  }

  public subscribe(listener: () => void): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  public getDiagnostics(): never {
    throw new Error("Diagnostics are outside this binding fixture");
  }

  public dispatch(type: string, detail: unknown): void {
    const event = { detail } as CustomEvent;
    for (const listener of [...this.#nativeListeners.get(type) ?? []]) {
      listener(event);
    }
  }

  public publishCurrentSnapshot(): void {
    this.#notifySnapshotListeners();
  }

  public publishNewSnapshot(): void {
    this.#snapshot = snapshot(this.#snapshot.revision + 1);
    this.#notifySnapshotListeners();
  }

  #notifySnapshotListeners(): void {
    for (const listener of [...this.#snapshotListeners]) listener();
  }
}
