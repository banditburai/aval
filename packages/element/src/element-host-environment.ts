import { OwnedReleaseTracker } from "./owned-releases.js";

export interface HostListenerTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface HostDocumentTarget extends HostListenerTarget {
  readonly visibilityState: DocumentVisibilityState;
}

export interface HostViewTarget extends HostListenerTarget {}

export interface HostMediaQuery extends HostListenerTarget {
  readonly matches: boolean;
}

export interface HostObserver {
  start(): void;
  disconnect(): void;
}

export interface HostMutationObserver<TRecord> extends HostObserver {
  takeRecords(): readonly TRecord[];
}

export interface HostIntersectionEntry {
  readonly isIntersecting: boolean;
  readonly intersectionRatio: number;
}

export interface ElementHostGeometry {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export interface ElementHostEnvironmentPort<TRecord> {
  readonly currentDocument: () => HostDocumentTarget;
  readonly currentView: () => HostViewTarget | null;
  readonly currentRoot: () => object;
  readonly measure: () => Readonly<ElementHostGeometry>;
  readonly isSourceMutation: (record: TRecord) => boolean;
  readonly createMutationObserver: (
    callback: (records: readonly TRecord[]) => void
  ) => HostMutationObserver<TRecord>;
  readonly createResizeObserver: (callback: () => void) => HostObserver | null;
  readonly createIntersectionObserver: (
    callback: (entries: readonly HostIntersectionEntry[]) => void
  ) => HostObserver | null;
  readonly createReducedMotionQuery: () => HostMediaQuery | null;
  readonly abortError: () => Error;
}

export type ElementHostVisibilityReason =
  | "intersection"
  | "document"
  | "pagehide"
  | "pageshow"
  | "bfcache-restore";

export interface ElementHostVisibilityChange {
  readonly reason: ElementHostVisibilityReason;
}

export interface ElementHostEnvironmentCallbacks {
  readonly sourcesChanged: () => void;
  readonly geometryChanged: (geometry: Readonly<ElementHostGeometry>) => void;
  readonly visibilityChanged: (
    change: Readonly<ElementHostVisibilityChange>
  ) => void;
  readonly motionPreferenceChanged: (reduced: boolean) => void;
  readonly realmChanged: () => void;
}

export interface ElementHostEnvironmentSnapshot {
  readonly installed: boolean;
  readonly documentVisible: boolean;
  readonly intersectionKnown: boolean;
  readonly intersecting: boolean;
  readonly positiveBox: boolean;
  readonly effectivelyVisible: boolean;
  readonly reducedMotion: boolean;
  readonly observedReducedMotion: boolean | null;
  readonly observerSupported: boolean;
  readonly activeListenerCount: number;
  readonly activeObserverCount: number;
  readonly failedListenerReleaseCount: number;
  readonly failedObserverReleaseCount: number;
  readonly failedReleaseCount: number;
  readonly listenerCount: number;
  readonly observerCount: number;
}

export interface ElementHostAdoptionClaim {
  current(): boolean;
}

type IntersectionGate = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}>;

/** Owns realm-bound host observers, listeners, and visibility sampling. */
export class ElementHostEnvironment<TRecord> {
  readonly #environment: Readonly<ElementHostEnvironmentPort<TRecord>>;
  readonly #callbacks: Readonly<ElementHostEnvironmentCallbacks>;
  readonly #releases = new OwnedReleaseTracker();

  #sourceObserver: HostMutationObserver<TRecord> | null = null;
  #sourceObserving = false;
  #resizeObserver: HostObserver | null = null;
  #intersectionObserver: HostObserver | null = null;
  #documentListener: EventListener | null = null;
  #windowListener: EventListener | null = null;
  #pageHideListener: EventListener | null = null;
  #pageShowListener: EventListener | null = null;
  #mediaListener: EventListener | null = null;
  #media: HostMediaQuery | null = null;
  #installedDocument: HostDocumentTarget | null = null;
  #installedView: HostViewTarget | null = null;
  #installedRoot: object | null = null;
  #installed = false;
  #observerEpoch = 0;
  #adoptionEpoch = 0;
  #pageHidden = false;
  #intersectionKnown = false;
  #intersecting = false;
  #positiveBox = false;
  #observedReducedMotion: boolean | null = null;
  #observerSupported = false;
  #intersectionGate: IntersectionGate | null = null;

  public constructor(input: Readonly<{
    environment: ElementHostEnvironmentPort<TRecord>;
    callbacks: ElementHostEnvironmentCallbacks;
  }>) {
    this.#environment = input.environment;
    this.#callbacks = input.callbacks;
  }

  public install(): boolean {
    const document = this.#environment.currentDocument();
    const view = this.#environment.currentView();
    const root = this.#environment.currentRoot();
    if (
      this.#installed && this.#installedDocument === document &&
      this.#installedRoot === root
    ) return true;
    if (this.#installedDocument !== null || this.#sourceObserver !== null) {
      this.remove();
    }
    this.#releases.retry();
    const epoch = ++this.#observerEpoch;
    this.#installedDocument = document;
    this.#installedView = view;
    this.#installedRoot = root;
    try {
      let sourceObserver!: HostMutationObserver<TRecord>;
      sourceObserver = this.#environment.createMutationObserver((records) => {
        if (
          epoch !== this.#observerEpoch ||
          sourceObserver !== this.#sourceObserver ||
          !this.#sourceObserving
        ) return;
        if (records.some(this.#environment.isSourceMutation)) {
          this.#callbacks.sourcesChanged();
        }
      });
      this.#sourceObserver = sourceObserver;
      this.#sourceObserving = true;
      sourceObserver.start();

      let resizeObserver: HostObserver | null = null;
      resizeObserver = this.#environment.createResizeObserver(() => {
        if (
          epoch === this.#observerEpoch &&
          resizeObserver === this.#resizeObserver
        ) this.#reportGeometry();
      });
      this.#resizeObserver = resizeObserver;
      resizeObserver?.start();

      let intersectionObserver: HostObserver | null = null;
      intersectionObserver = this.#environment.createIntersectionObserver(
        (entries) => {
          if (
            epoch !== this.#observerEpoch ||
            intersectionObserver !== this.#intersectionObserver
          ) return;
          const entry = entries.at(-1);
          if (entry === undefined) return;
          this.#intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
          this.#intersectionKnown = true;
          this.#resolveIntersectionGate();
          this.#callbacks.visibilityChanged(Object.freeze({
            reason: "intersection"
          }));
        }
      );
      this.#intersectionObserver = intersectionObserver;
      this.#observerSupported = intersectionObserver !== null;
      if (intersectionObserver === null) {
        this.#intersecting = false;
        this.#intersectionKnown = true;
      } else {
        intersectionObserver.start();
      }

      this.#documentListener = () => {
        if (epoch !== this.#observerEpoch) return;
        if (!this.#documentVisible()) this.#resolveIntersectionGate();
        this.#callbacks.visibilityChanged(Object.freeze({ reason: "document" }));
      };
      document.addEventListener("visibilitychange", this.#documentListener);

      const media = this.#environment.createReducedMotionQuery();
      this.#media = media;
      this.#observedReducedMotion = media?.matches ?? null;
      if (media !== null) {
        this.#mediaListener = () => {
          if (epoch === this.#observerEpoch) this.reconcileMotionPreference();
        };
        media.addEventListener("change", this.#mediaListener);
      }

      if (view !== null) {
        this.#windowListener = () => {
          if (epoch === this.#observerEpoch) this.#reportGeometry();
        };
        view.addEventListener("resize", this.#windowListener);

        this.#pageHideListener = () => {
          if (epoch !== this.#observerEpoch) return;
          this.#pageHidden = true;
          this.#resolveIntersectionGate();
          this.#callbacks.visibilityChanged(Object.freeze({ reason: "pagehide" }));
        };
        view.addEventListener("pagehide", this.#pageHideListener);

        this.#pageShowListener = (event) => {
          if (epoch !== this.#observerEpoch) return;
          this.#pageHidden = false;
          this.#callbacks.visibilityChanged(Object.freeze({
            reason: persistedPageShow(event) ? "bfcache-restore" : "pageshow"
          }));
        };
        view.addEventListener("pageshow", this.#pageShowListener);
      }

      this.#installed = true;
      this.#reportGeometry();
      return true;
    } catch {
      this.remove();
      return false;
    }
  }

  public remove(): void {
    this.#releases.retry();
    this.#installed = false;
    this.#observerEpoch += 1;

    const sourceObserver = this.#sourceObserver;
    const sourceObserving = this.#sourceObserving;
    const resizeObserver = this.#resizeObserver;
    const intersectionObserver = this.#intersectionObserver;
    this.#sourceObserver = null;
    this.#sourceObserving = false;
    this.#resizeObserver = null;
    this.#intersectionObserver = null;
    if (sourceObserver !== null && sourceObserving) {
      this.#releases.attempt("observer", () => sourceObserver.disconnect());
    }
    if (resizeObserver !== null) {
      this.#releases.attempt("observer", () => resizeObserver.disconnect());
    }
    if (intersectionObserver !== null) {
      this.#releases.attempt("observer", () => intersectionObserver.disconnect());
    }

    const document = this.#installedDocument;
    const view = this.#installedView;
    const media = this.#media;
    const documentListener = this.#documentListener;
    const windowListener = this.#windowListener;
    const pageHideListener = this.#pageHideListener;
    const pageShowListener = this.#pageShowListener;
    const mediaListener = this.#mediaListener;
    this.#installedDocument = null;
    this.#installedView = null;
    this.#installedRoot = null;
    this.#media = null;
    this.#documentListener = null;
    this.#windowListener = null;
    this.#pageHideListener = null;
    this.#pageShowListener = null;
    this.#mediaListener = null;

    if (documentListener !== null) this.#releases.attempt(
      "listener",
      () => document?.removeEventListener("visibilitychange", documentListener)
    );
    if (windowListener !== null) this.#releases.attempt(
      "listener",
      () => view?.removeEventListener("resize", windowListener)
    );
    if (pageHideListener !== null) this.#releases.attempt(
      "listener",
      () => view?.removeEventListener("pagehide", pageHideListener)
    );
    if (pageShowListener !== null) this.#releases.attempt(
      "listener",
      () => view?.removeEventListener("pageshow", pageShowListener)
    );
    if (mediaListener !== null) this.#releases.attempt(
      "listener",
      () => media?.removeEventListener("change", mediaListener)
    );

    this.#pageHidden = false;
    this.#intersectionKnown = false;
    this.#intersecting = false;
    this.#observedReducedMotion = null;
    this.#observerSupported = false;
    const gate = this.#intersectionGate;
    this.#intersectionGate = null;
    gate?.reject(this.#environment.abortError());
  }

  public rootChanged(): boolean {
    return this.#installedRoot !== null &&
      this.#installedRoot !== this.#environment.currentRoot();
  }

  public takeSourceChanges(): boolean {
    const observer = this.#sourceObserver;
    if (observer === null || !this.#sourceObserving) return false;
    return observer.takeRecords().some(this.#environment.isSourceMutation);
  }

  public measure(): Readonly<ElementHostGeometry> {
    const measured = this.#environment.measure();
    const geometry = Object.freeze({
      width: measured.width,
      height: measured.height,
      dpr: measured.dpr
    });
    this.#positiveBox = geometry.width > 0 && geometry.height > 0;
    return geometry;
  }

  public needsIntersectionSample(): boolean {
    return needsIntersectionSample(
      this.#intersectionKnown,
      this.#documentVisible()
    );
  }

  public waitForIntersection(): Promise<void> {
    if (!this.needsIntersectionSample()) return Promise.resolve();
    if (this.#intersectionGate !== null) return this.#intersectionGate.promise;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((accepted, rejected) => {
      resolve = accepted;
      reject = rejected;
    });
    this.#intersectionGate = Object.freeze({ promise, resolve, reject });
    return promise;
  }

  public reconcileMotionPreference(): void {
    const reduced = this.#media?.matches;
    if (reduced === undefined || reduced === this.#observedReducedMotion) return;
    this.#observedReducedMotion = reduced;
    this.#callbacks.motionPreferenceChanged(reduced);
  }

  public beginAdoption(): Readonly<ElementHostAdoptionClaim> {
    const adoptionEpoch = ++this.#adoptionEpoch;
    this.remove();
    this.#callbacks.realmChanged();
    return Object.freeze({
      current: (): boolean => adoptionEpoch === this.#adoptionEpoch
    });
  }

  public snapshot(): Readonly<ElementHostEnvironmentSnapshot> {
    const failures = this.#releases.snapshot();
    const activeListenerCount =
      Number(this.#documentListener !== null) +
      Number(this.#windowListener !== null) +
      Number(this.#pageHideListener !== null) +
      Number(this.#pageShowListener !== null) +
      Number(this.#media !== null && this.#mediaListener !== null);
    const activeObserverCount = Number(this.#sourceObserving) +
      Number(this.#resizeObserver !== null) +
      Number(this.#intersectionObserver !== null);
    const documentVisible = this.#documentVisible();
    return Object.freeze({
      installed: this.#installed,
      documentVisible,
      intersectionKnown: this.#intersectionKnown,
      intersecting: this.#intersecting,
      positiveBox: this.#positiveBox,
      effectivelyVisible: documentVisible &&
        this.#intersecting && this.#positiveBox,
      reducedMotion: this.#observedReducedMotion === true,
      observedReducedMotion: this.#observedReducedMotion,
      observerSupported: this.#observerSupported,
      activeListenerCount,
      activeObserverCount,
      failedListenerReleaseCount: failures.listenerCount,
      failedObserverReleaseCount: failures.observerCount,
      failedReleaseCount: failures.pendingCount,
      listenerCount: activeListenerCount + failures.listenerCount,
      observerCount: activeObserverCount + failures.observerCount
    });
  }

  #reportGeometry(): void {
    this.#callbacks.geometryChanged(this.measure());
  }

  #documentVisible(): boolean {
    const document = this.#installedDocument ??
      this.#environment.currentDocument();
    return !this.#pageHidden && document.visibilityState !== "hidden";
  }

  #resolveIntersectionGate(): void {
    const gate = this.#intersectionGate;
    this.#intersectionGate = null;
    gate?.resolve();
  }
}

export function createDomHostEnvironmentPort(
  host: HTMLElement,
  isSourceMutation: (record: MutationRecord) => boolean
): Readonly<ElementHostEnvironmentPort<MutationRecord>> {
  return Object.freeze({
    currentDocument: () => host.ownerDocument,
    currentView: () => host.ownerDocument.defaultView,
    currentRoot: () => host.getRootNode(),
    measure: () => {
      const rect = host.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        dpr: host.ownerDocument.defaultView?.devicePixelRatio ?? 1
      };
    },
    isSourceMutation,
    createMutationObserver: (
      callback: (records: readonly MutationRecord[]) => void
    ) => {
      const Observer = host.ownerDocument.defaultView?.MutationObserver ??
        MutationObserver;
      const observer = new Observer((records) => callback(records));
      return {
        start: () => observer.observe(host, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["src", "data-codec", "integrity"]
        }),
        disconnect: () => observer.disconnect(),
        takeRecords: () => observer.takeRecords()
      };
    },
    createResizeObserver: (callback: () => void) => {
      const Observer = host.ownerDocument.defaultView?.ResizeObserver;
      if (typeof Observer !== "function") return null;
      const observer = new Observer(callback);
      return {
        start: () => observer.observe(host),
        disconnect: () => observer.disconnect()
      };
    },
    createIntersectionObserver: (
      callback: (entries: readonly HostIntersectionEntry[]) => void
    ) => {
      const Observer = host.ownerDocument.defaultView?.IntersectionObserver;
      if (typeof Observer !== "function") return null;
      const observer = new Observer((entries) => callback(entries));
      return {
        start: () => observer.observe(host),
        disconnect: () => observer.disconnect()
      };
    },
    createReducedMotionQuery: () => {
      const view = host.ownerDocument.defaultView;
      return typeof view?.matchMedia === "function"
        ? view.matchMedia("(prefers-reduced-motion: reduce)") : null;
    },
    abortError: () => {
      const RealmDOMException = host.ownerDocument.defaultView?.DOMException ??
        DOMException;
      return new RealmDOMException("Host observation removed", "AbortError");
    }
  });
}

export function persistedPageShow(event: Event): boolean {
  return "persisted" in event && event.persisted === true;
}

export function needsIntersectionSample(
  intersectionKnown: boolean,
  documentVisible: boolean
): boolean {
  return !intersectionKnown && documentVisible;
}
