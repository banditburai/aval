import { ElementEngagementBinding } from "./element-engagement-binding.js";
import { OwnedReleaseTracker } from "./owned-releases.js";
import type {
  AvalBindings,
  Binding,
  BindingSource
} from "./public-types.js";

export interface ElementInputEventTarget {
  addEventListener(
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions
  ): void;
  removeEventListener(
    type: string,
    listener: EventListener,
    options?: boolean | EventListenerOptions
  ): void;
}

export interface ElementInputBindingInput<
  TTarget extends ElementInputEventTarget
> {
  readonly host: TTarget;
  readonly documentTarget: () => ElementInputEventTarget;
  readonly activeElement: () => TTarget | null;
  readonly rootOf: (target: TTarget) => object;
  readonly resolveById: (id: string) => TTarget | null;
  readonly isCurrentRealmTarget: (target: TTarget) => boolean;
  readonly contains: (target: TTarget, node: TTarget | null) => boolean;
  readonly matchesHover: (target: TTarget) => boolean;
  readonly blur: (target: TTarget) => void;
  readonly currentMode: () => AvalBindings;
  readonly currentInteractionFor: () => string;
  readonly currentBindings: () => readonly Readonly<Binding>[] | null;
  readonly isTransitioning: () => boolean;
  readonly dispatchBinding: (event: string) => boolean;
  readonly recordSource: (source: BindingSource) => void;
  readonly onTargetUnavailable: () => void;
  readonly queueOwnedMicrotask: (operation: () => void) => void;
  readonly queueEventFollowup: (operation: () => void) => void;
}

export interface ElementInputBindingSnapshot {
  readonly activeListenerCount: number;
  readonly failedReleaseCount: number;
  readonly listenerCount: number;
  readonly bindingEpoch: number;
  readonly bound: boolean;
  readonly hovered: boolean;
  readonly focused: boolean;
  readonly closed: boolean;
}

type InputListener = Readonly<{
  target: ElementInputEventTarget;
  type: string;
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
}>;

/** Owns interaction target resolution, DOM input listeners, and engagement. */
export class ElementInputBinding<
  TTarget extends ElementInputEventTarget
> {
  readonly #input: Readonly<ElementInputBindingInput<TTarget>>;
  readonly #releases = new OwnedReleaseTracker();
  readonly #engagement: ElementEngagementBinding;
  #listeners: InputListener[] = [];
  #boundTarget: TTarget | null = null;
  #explicitTarget: TTarget | null = null;
  #bindingEpoch = 0;
  #hovered = false;
  #focused = false;
  #closed = false;

  public constructor(input: Readonly<ElementInputBindingInput<TTarget>>) {
    this.#input = input;
    this.#engagement = new ElementEngagementBinding(
      (source) => this.send(source),
      input.isTransitioning
    );
  }

  public get interactionTarget(): TTarget | null {
    return this.#explicitTarget ?? this.#resolveInteractionTarget();
  }

  public validateInteractionTarget(value: TTarget | null): TTarget | null {
    return validateInteractionTarget(
      this.#input.host,
      value,
      this.#input.isCurrentRealmTarget,
      this.#input.rootOf
    );
  }

  public setInteractionTarget(value: TTarget | null): void {
    this.#explicitTarget = this.validateInteractionTarget(value);
    this.refresh();
  }

  public refresh(): void {
    this.#unbind();
    const bindings = this.#input.currentBindings();
    if (
      this.#closed || this.#input.currentMode() === "none" ||
      bindings === null
    ) return;
    const target = this.interactionTarget;
    if (target === null) {
      if (this.#input.currentInteractionFor() !== "") {
        this.#input.onTargetUnavailable();
      }
      return;
    }

    const bindingEpoch = this.#bindingEpoch;
    this.#boundTarget = target;
    const current = (): boolean => bindingCurrent(
      bindingEpoch,
      this.#bindingEpoch,
      target,
      this.interactionTarget
    );
    const listen = (
      eventTarget: ElementInputEventTarget,
      type: string,
      operation: (event: Event) => void,
      options?: boolean | AddEventListenerOptions
    ): void => {
      const listener = (event: Event): void => {
        if (current()) operation(event);
      };
      this.#listeners.push(Object.freeze({
        target: eventTarget,
        type,
        listener,
        ...(options === undefined ? {} : { options })
      }));
      eventTarget.addEventListener(type, listener, options);
    };
    const bind = (type: string, operation: (event: Event) => void): void => {
      listen(target, type, operation);
    };

    try {
      bind("pointerenter", () => {
        this.#hovered = true;
        this.send("pointer.enter");
        this.#updateEngagement();
      });
      bind("pointerleave", () => {
        this.#hovered = false;
        this.send("pointer.leave");
        this.#updateEngagement();
      });
      bind("focusin", () => {
        this.#focused = true;
        this.send("focus.in");
        this.#updateEngagement();
      });
      bind("focusout", () => this.#input.queueOwnedMicrotask(() => {
        if (!current()) return;
        this.#focused = this.#input.contains(target, this.#input.activeElement());
        if (!this.#focused) this.send("focus.out");
        this.#updateEngagement();
      }));
      bind("click", () => this.send("activate"));
      const reconcileTouchHover = (event: Event): void => {
        const hovered = event.composedPath().some((entry) =>
          Object.is(entry, target)
        );
        if (hovered === this.#hovered) return;
        this.#hovered = hovered;
        this.#updateEngagement();
      };
      listen(this.#input.documentTarget(), "pointerdown", (event) => {
        const pointerType = (event as Partial<PointerEvent>).pointerType;
        if (pointerType !== "touch" && pointerType !== "pen") return;
        reconcileTouchHover(event);
      }, true);
      listen(this.#input.documentTarget(), "pointerup", (event) => {
        const pointerType = (event as Partial<PointerEvent>).pointerType;
        if (
          (pointerType !== "touch" && pointerType !== "pen") ||
          event.composedPath().some((entry) => Object.is(entry, target))
        ) return;
        const activeElement = this.#input.activeElement();
        if (
          activeElement === null ||
          !this.#input.contains(target, activeElement)
        ) return;
        try { this.#input.blur(activeElement); }
        catch { /* The focus level remains authoritative. */ }
      }, true);
      this.#hovered = this.#input.matchesHover(target);
      this.#focused = this.#input.contains(target, this.#input.activeElement());
      this.send(this.#hovered ? "pointer.enter" : "pointer.leave");
      this.send(this.#focused ? "focus.in" : "focus.out");
      this.#updateEngagement(true);
    } catch {
      this.#unbind();
    }
  }

  public send(source: BindingSource): boolean | null {
    if (this.#input.currentMode() === "none") return null;
    this.#input.recordSource(source);
    let result: boolean | null = null;
    for (const binding of this.#input.currentBindings() ?? []) {
      if (binding.source !== source) continue;
      const accepted = this.#input.dispatchBinding(binding.event);
      result = result === null ? accepted : result || accepted;
    }
    return result;
  }

  public transitionEnded(): void {
    const bindingEpoch = this.#bindingEpoch;
    const target = this.#boundTarget;
    this.#input.queueEventFollowup(() => {
      if (
        target === null ||
        !bindingCurrent(
          bindingEpoch,
          this.#bindingEpoch,
          target,
          this.#boundTarget
        ) ||
        target !== this.interactionTarget
      ) return;
      this.#engagement.retry(this.#hovered || this.#focused);
    });
  }

  public disconnect(): void {
    this.#unbind();
  }

  public realmChanged(): void {
    this.#unbind();
    if (this.#explicitTarget === null) return;
    try { this.validateInteractionTarget(this.#explicitTarget); }
    catch { this.#explicitTarget = null; }
  }

  public close(): void {
    this.#closed = true;
    this.#unbind();
    this.#explicitTarget = null;
  }

  public snapshot(): Readonly<ElementInputBindingSnapshot> {
    const failedReleaseCount = this.#releases.pendingCount;
    return Object.freeze({
      activeListenerCount: this.#listeners.length,
      failedReleaseCount,
      listenerCount: this.#listeners.length + failedReleaseCount,
      bindingEpoch: this.#bindingEpoch,
      bound: this.#boundTarget !== null,
      hovered: this.#hovered,
      focused: this.#focused,
      closed: this.#closed
    });
  }

  #unbind(): void {
    this.#bindingEpoch += 1;
    this.#releases.retry();
    const listeners = this.#listeners;
    this.#listeners = [];
    this.#boundTarget = null;
    for (const listener of listeners) {
      this.#releases.attempt("listener", () => listener.target.removeEventListener(
        listener.type,
        listener.listener,
        listener.options
      ));
    }
    this.#hovered = false;
    this.#focused = false;
    this.#engagement.reset();
  }

  #updateEngagement(force = false): void {
    this.#engagement.update(this.#hovered || this.#focused, force);
  }

  #resolveInteractionTarget(): TTarget | null {
    const id = this.#input.currentInteractionFor();
    if (id === "") return this.#input.host;
    return this.#input.resolveById(id);
  }
}

export function bindingCurrent(
  expectedEpoch: number,
  currentEpoch: number,
  expectedTarget: object,
  currentTarget: object | null
): boolean {
  return expectedEpoch === currentEpoch && expectedTarget === currentTarget;
}

export function validateInteractionTarget<
  TTarget extends ElementInputEventTarget
>(
  host: TTarget,
  value: TTarget | null,
  isCurrentRealmTarget: (target: TTarget) => boolean,
  rootOf: (target: TTarget) => object
): TTarget | null {
  if (value !== null && !isCurrentRealmTarget(value)) {
    throw new TypeError("interactionTarget must be a current-realm Element or null");
  }
  if (value !== null && rootOf(value) !== rootOf(host)) {
    throw new TypeError("interactionTarget must share the element root");
  }
  return value;
}
