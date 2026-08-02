export type OwnedReleaseKind = "listener" | "observer";

export interface OwnedReleaseSnapshot {
  readonly pendingCount: number;
  readonly listenerCount: number;
  readonly observerCount: number;
}

type PendingRelease = Readonly<{
  kind: OwnedReleaseKind;
  release: () => void;
}>;

/** Retains failed cleanup authority until a later retry succeeds. */
export class OwnedReleaseTracker {
  #pending: PendingRelease[] = [];

  public get pendingCount(): number { return this.#pending.length; }

  public attempt(kind: OwnedReleaseKind, release: () => void): boolean {
    try {
      release();
      return true;
    } catch {
      this.#pending.push(Object.freeze({ kind, release }));
      return false;
    }
  }

  public retry(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const owned of pending) this.attempt(owned.kind, owned.release);
  }

  public snapshot(): Readonly<OwnedReleaseSnapshot> {
    let listenerCount = 0;
    for (const owned of this.#pending) {
      if (owned.kind === "listener") listenerCount += 1;
    }
    return Object.freeze({
      pendingCount: this.#pending.length,
      listenerCount,
      observerCount: this.#pending.length - listenerCount
    });
  }
}
