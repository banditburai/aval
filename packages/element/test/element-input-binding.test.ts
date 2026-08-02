import { describe, expect, it, vi } from "vitest";

import { ElementInputBinding } from "../src/element-input-binding.js";
import type { Binding, BindingSource } from "../src/public-types.js";

describe("ElementInputBinding", () => {
  it("resolves authored targets and validates explicit realm/root ownership", () => {
    const harness = createHarness();
    const control = harness.element();
    harness.root.elements.set("control", control);
    harness.interactionFor = "control";
    const owner = harness.owner();

    expect(owner.interactionTarget).toBe(control);
    owner.refresh();
    expect(owner.snapshot()).toMatchObject({ bound: true, listenerCount: 7 });

    const explicit = harness.element();
    owner.setInteractionTarget(explicit);
    expect(owner.interactionTarget).toBe(explicit);
    expect(owner.snapshot().listenerCount).toBe(7);

    const foreignRoot = harness.element(new FakeRoot());
    expect(() => owner.setInteractionTarget(foreignRoot)).toThrow(
      "share the element root"
    );
    const foreignRealm = harness.element();
    foreignRealm.realm = {};
    expect(() => owner.setInteractionTarget(foreignRealm)).toThrow(
      "current-realm Element"
    );
  });

  it("reports a missing authored target without installing listeners", () => {
    const harness = createHarness();
    harness.interactionFor = "missing";
    const owner = harness.owner();

    owner.refresh();

    expect(harness.onTargetUnavailable).toHaveBeenCalledTimes(1);
    expect(owner.snapshot()).toMatchObject({ bound: false, listenerCount: 0 });
  });

  it("dispatches authored pointer, focus, engagement, and click bindings", () => {
    const harness = createHarness();
    harness.bindings = [
      binding("pointer.enter", "hover"),
      binding("focus.in", "focus"),
      binding("engagement.on", "engaged"),
      binding("activate", "activate")
    ];
    const owner = harness.owner();
    owner.refresh();
    harness.dispatched.length = 0;
    harness.sources.length = 0;

    harness.host.emit("pointerenter");
    harness.host.emit("focusin");
    harness.host.emit("click");

    expect(harness.dispatched).toEqual(["hover", "engaged", "focus", "activate"]);
    expect(harness.sources).toEqual([
      "pointer.enter",
      "engagement.on",
      "focus.in",
      "activate"
    ]);
    expect(owner.snapshot()).toMatchObject({ hovered: true, focused: true });
  });

  it("rebinds authored events without leaving the previous target active", () => {
    const harness = createHarness();
    const target = harness.element();
    harness.bindings = [binding("activate", "first")];
    const owner = harness.owner();
    owner.setInteractionTarget(target);
    harness.dispatched.length = 0;

    target.emit("click");
    harness.bindings = [binding("activate", "second")];
    owner.refresh();
    target.emit("click");

    expect(harness.dispatched).toEqual(["first", "second"]);
    expect(target.listenerCount("click")).toBe(1);
  });

  it("retries the composed engagement binding after transition completion", () => {
    const harness = createHarness();
    harness.transitioning = true;
    harness.bindings = [binding("engagement.off", "idle")];
    let attempts = 0;
    harness.dispatch = (event) => {
      harness.dispatched.push(event);
      attempts += 1;
      return attempts > 1;
    };
    const owner = harness.owner();

    owner.refresh();
    expect(harness.dispatched).toEqual(["idle"]);
    harness.transitioning = false;
    owner.transitionEnded();
    harness.flushFollowups();

    expect(harness.dispatched).toEqual(["idle", "idle"]);
  });

  it("rejects stale focusout microtasks after target replacement", () => {
    const harness = createHarness();
    harness.bindings = [binding("focus.out", "blur")];
    const first = harness.element();
    const second = harness.element();
    const owner = harness.owner();
    owner.setInteractionTarget(first);
    harness.dispatched.length = 0;
    first.emit("focusin");
    first.emit("focusout");

    owner.setInteractionTarget(second);
    harness.dispatched.length = 0;
    harness.flushMicrotasks();

    expect(harness.dispatched).toEqual([]);
    expect(owner.interactionTarget).toBe(second);
  });

  it("invalidates an old-realm explicit target during adoption", () => {
    const harness = createHarness();
    const explicit = harness.element();
    const owner = harness.owner();
    owner.setInteractionTarget(explicit);

    class AdoptedElement extends FakeTarget {}
    harness.document.defaultView = { Element: AdoptedElement };
    owner.realmChanged();

    expect(owner.interactionTarget).toBe(harness.host);
    expect(owner.snapshot()).toMatchObject({ bound: false, listenerCount: 0 });
  });

  it("retains a failed listener removal until disconnect retry succeeds", () => {
    const harness = createHarness();
    const owner = harness.owner();
    owner.refresh();
    harness.host.failNextRemoval = true;

    owner.disconnect();
    expect(owner.snapshot()).toMatchObject({
      activeListenerCount: 0,
      failedReleaseCount: 1,
      listenerCount: 1
    });

    owner.disconnect();
    expect(owner.snapshot()).toMatchObject({
      failedReleaseCount: 0,
      listenerCount: 0
    });
  });

  it("closes repeatedly and refuses to reinstall listeners", () => {
    const harness = createHarness();
    const externalTarget = harness.element();
    const owner = harness.owner();
    owner.setInteractionTarget(externalTarget);

    owner.close();
    owner.close();
    owner.refresh();

    expect(owner.snapshot()).toMatchObject({
      closed: true,
      bound: false,
      listenerCount: 0
    });
    expect(owner.interactionTarget).toBe(harness.host);
  });
});

class FakeRoot {
  readonly elements = new Map<string, FakeTarget>();

  getElementById(id: string): FakeTarget | null {
    return this.elements.get(id) ?? null;
  }
}

class FakeTarget {
  ownerDocument!: FakeDocument;
  realm: object = {};
  hover = false;
  failNextRemoval = false;
  #root!: FakeRoot;
  readonly #listeners = new Map<string, Set<EventListener>>();

  initialize(root: FakeRoot, document: FakeDocument): this {
    this.#root = root;
    this.ownerDocument = document;
    return this;
  }

  getRootNode(): FakeRoot { return this.#root; }

  addEventListener(
    type: string,
    listener: EventListener,
    _options?: boolean | AddEventListenerOptions
  ): void {
    const listeners = this.#listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: EventListener,
    _options?: boolean | EventListenerOptions
  ): void {
    if (this.failNextRemoval) {
      this.failNextRemoval = false;
      throw new Error("temporary listener removal failure");
    }
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type: string, path: readonly object[] = [this]): void {
    const event = new Event(type);
    Object.defineProperty(event, "composedPath", { value: () => [...path] });
    for (const listener of [...this.#listeners.get(type) ?? []]) listener(event);
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }

  matches(selector: string): boolean {
    if (selector !== ":hover") throw new Error("Unexpected selector");
    return this.hover;
  }

  contains(node: unknown): boolean { return node === this; }

  blur(): void {}
}

class FakeDocument extends FakeTarget {
  defaultView: { Element: typeof FakeTarget } = { Element: FakeTarget };
  activeElement: FakeTarget | null = null;
  readonly realmToken = {};
}

function createHarness(): {
  readonly root: FakeRoot;
  readonly document: FakeDocument;
  readonly host: FakeTarget;
  interactionFor: string;
  mode: "auto" | "none";
  bindings: readonly Readonly<Binding>[] | null;
  transitioning: boolean;
  readonly dispatched: string[];
  readonly sources: BindingSource[];
  dispatch: (event: string) => boolean;
  readonly onTargetUnavailable: ReturnType<typeof vi.fn<() => void>>;
  element(root?: FakeRoot): FakeTarget;
  owner(): ElementInputBinding<FakeTarget>;
  flushMicrotasks(): void;
  flushFollowups(): void;
} {
  const root = new FakeRoot();
  const document = new FakeDocument();
  document.initialize(root, document);
  const host = new FakeTarget().initialize(root, document);
  host.realm = document.realmToken;
  const microtasks: Array<() => void> = [];
  const followups: Array<() => void> = [];
  const harness = {
    root,
    document,
    host,
    interactionFor: "",
    mode: "auto" as const as "auto" | "none",
    bindings: [] as readonly Readonly<Binding>[] | null,
    transitioning: false,
    dispatched: [] as string[],
    sources: [] as BindingSource[],
    dispatch(event: string): boolean {
      harness.dispatched.push(event);
      return true;
    },
    onTargetUnavailable: vi.fn<() => void>(),
    element(elementRoot = root): FakeTarget {
      const element = new FakeTarget().initialize(elementRoot, document);
      element.realm = document.realmToken;
      return element;
    },
    owner(): ElementInputBinding<FakeTarget> {
      return new ElementInputBinding({
        host,
        documentTarget: () => document,
        activeElement: () => document.activeElement,
        rootOf: (target) => target.getRootNode(),
        resolveById: (id) => root.getElementById(id),
        isCurrentRealmTarget: (target) =>
          target instanceof document.defaultView.Element &&
          target.realm === document.realmToken,
        contains: (target, node) => target.contains(node),
        matchesHover: (target) => target.matches(":hover"),
        blur: (target) => target.blur(),
        currentMode: () => harness.mode,
        currentInteractionFor: () => harness.interactionFor,
        currentBindings: () => harness.bindings,
        isTransitioning: () => harness.transitioning,
        dispatchBinding: (event) => harness.dispatch(event),
        recordSource: (source) => { harness.sources.push(source); },
        onTargetUnavailable: harness.onTargetUnavailable,
        queueOwnedMicrotask: (operation) => { microtasks.push(operation); },
        queueEventFollowup: (operation) => { followups.push(operation); }
      });
    },
    flushMicrotasks(): void {
      for (const operation of microtasks.splice(0)) operation();
    },
    flushFollowups(): void {
      for (const operation of followups.splice(0)) operation();
    }
  };
  return harness;
}

function binding(source: BindingSource, event: string): Readonly<Binding> {
  return Object.freeze({ source, event });
}
