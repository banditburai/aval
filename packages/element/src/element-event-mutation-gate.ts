import type { ElementPublicEvents } from "./element-public-events.js";

/** Defers listener-triggered public mutations until the DOM event transaction exits. */
export class ElementEventMutationGate {
  readonly #events: ElementPublicEvents;
  readonly #deferredAttributes = new Set<string>();
  #tail: Promise<void> | null = null;
  #pendingOperations = 0;
  #closed = false;

  public constructor(events: ElementPublicEvents) { this.#events = events; }

  public get pendingOperationCount(): number { return this.#pendingOperations; }

  public deferCommand(operation: () => void): boolean {
    if (this.#closed || !this.#events.active) return false;
    void this.#after(operation);
    return true;
  }

  public deferCommandPromise<T>(
    operation: () => Promise<T>
  ): Promise<T> | null {
    if (this.#closed || !this.#events.active) return null;
    return this.#after(operation);
  }

  public deferAttribute(
    name: string,
    read: () => string | null,
    apply: (value: string | null) => void
  ): boolean {
    if (this.#closed || !this.#events.active) return false;
    if (this.#deferredAttributes.has(name)) return true;
    this.#deferredAttributes.add(name);
    void this.#after(() => {
      this.#deferredAttributes.delete(name);
      apply(read());
    });
    return true;
  }

  public queueOwnedMicrotask(operation: () => void): void {
    if (this.#closed) return;
    void this.#enqueue(() => new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        try {
          operation();
          resolve();
        } catch (error) { reject(error); }
      });
    })).catch(() => undefined);
  }

  /** Runs after already-deferred listener work while retaining queue ownership. */
  public queueEventFollowup(operation: () => void): void {
    if (this.#closed) return;
    void this.#after(operation);
  }

  /** Rejects new work; operations already accepted retain their completion path. */
  public close(): void {
    this.#closed = true;
  }

  #after<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    return this.#enqueue(() => this.#events.after(operation));
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.#pendingOperations += 1;
    let result: Promise<T>;
    try {
      result = this.#tail === null ? operation() : this.#tail.then(operation);
    } catch (error) { result = Promise.reject(error); }
    const settled = result.finally(() => {
      this.#pendingOperations -= 1;
    });
    const tail = settled.then(() => undefined, () => undefined);
    this.#tail = tail;
    void tail.then(() => {
      if (this.#tail === tail) this.#tail = null;
    });
    return settled;
  }
}
