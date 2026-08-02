import {
  createPageResourceOwnership,
  type PageResourceOwnership
} from "./element-cleanup-proof.js";
import {
  createPageDecoderParticipant,
  pageResourcesSnapshot,
  type PageDecoderLease,
  type PageDecoderParticipant,
  type PageDecoderTicket,
  type PageDecoderTicketState,
  type PageResourcesSnapshot
} from "./page-resources.js";

export interface ElementPageResourceEnvironment {
  createParticipant(visible: boolean, realm: object): PageDecoderParticipant;
  snapshot(realm: object): Readonly<PageResourcesSnapshot>;
}

export interface ElementPageResourceOwnerInput {
  readonly environment?: ElementPageResourceEnvironment;
  readonly currentRealm: () => object;
  readonly currentVisibility: () => boolean;
  readonly onDecoderGranted: (generation: number) => void;
}

export interface ElementPageResourceOwnerSnapshot {
  readonly ownership: Readonly<PageResourceOwnership>;
  readonly page: Readonly<PageResourcesSnapshot>;
}

const DEFAULT_ENVIRONMENT: ElementPageResourceEnvironment = Object.freeze({
  createParticipant: createPageDecoderParticipant,
  snapshot: pageResourcesSnapshot
});

/** Owns the page-level decoder participant, request, lease, and byte accounting. */
export class ElementPageResourceOwner {
  readonly #environment: ElementPageResourceEnvironment;
  readonly #currentRealm: () => object;
  readonly #currentVisibility: () => boolean;
  readonly #onDecoderGranted: (generation: number) => void;

  #participant: PageDecoderParticipant | null = null;
  #participantRealm: object | null = null;
  #ticket: PageDecoderTicket | null = null;
  #ticketGeneration: number | null = null;
  #lease: PageDecoderLease | null = null;
  #leaseGeneration: number | null = null;
  #resourceBytes = 0;
  #claimSequence = 0;

  constructor(input: Readonly<ElementPageResourceOwnerInput>) {
    this.#environment = input.environment ?? DEFAULT_ENVIRONMENT;
    this.#currentRealm = input.currentRealm;
    this.#currentVisibility = input.currentVisibility;
    this.#onDecoderGranted = input.onDecoderGranted;
  }

  claimDecoder(generation: number): boolean {
    this.#retireAdoptedRealm();
    if (this.#lease !== null) return this.#leaseGeneration === generation;
    if (this.#ticket !== null) {
      if (this.#ticketGeneration === generation) return false;
      this.invalidateRequest();
    }

    const participant = this.#ensureParticipant();
    const ticket = participant.request();
    const immediateLease = ticket.take();
    if (immediateLease !== null) {
      this.#lease = immediateLease;
      this.#leaseGeneration = generation;
      return true;
    }

    const claimSequence = ++this.#claimSequence;
    this.#ticket = ticket;
    this.#ticketGeneration = generation;
    void ticket.wait().then(
      (granted) => {
        if (!this.#claimIsCurrent(
          ticket,
          participant,
          generation,
          claimSequence
        )) {
          granted.release();
          return;
        }
        this.#ticket = null;
        this.#ticketGeneration = null;
        this.#lease = granted;
        this.#leaseGeneration = generation;
        this.#onDecoderGranted(generation);
      },
      () => {
        if (this.#ticket === ticket && this.#claimSequence === claimSequence) {
          this.#ticket = null;
          this.#ticketGeneration = null;
        }
      }
    );
    return false;
  }

  invalidateRequest(): void {
    this.#claimSequence += 1;
    this.#cancelTicket();
  }

  setVisible(visible: boolean): void {
    this.#participant?.setVisible(visible);
  }

  setResourceBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("Invalid participant physical bytes");
    }
    if (bytes === 0 && this.#participant === null) {
      this.#resourceBytes = 0;
      return;
    }
    this.#retireAdoptedRealm();
    this.#ensureParticipant().setPhysicalBytes(bytes);
    this.#resourceBytes = bytes;
  }

  animationResourcesRetired(retainQueuedRequest: boolean): void {
    this.releaseDecoderLease();
    if (retainQueuedRequest) return;
    this.cancelDecoderTicket();
    if (this.#resourceBytes === 0) this.#disposeParticipant();
  }

  cancelDecoderTicket(): void {
    this.invalidateRequest();
  }

  releaseDecoderLease(): void {
    const lease = this.#lease;
    this.#lease = null;
    this.#leaseGeneration = null;
    lease?.release();
  }

  releaseAll(): void {
    this.#claimSequence += 1;
    this.#cancelTicket();
    this.releaseDecoderLease();
    this.#disposeParticipant();
  }

  snapshot(): Readonly<ElementPageResourceOwnerSnapshot> {
    const decoderState = this.#decoderState();
    const realm = this.#participantRealm ?? this.#currentRealm();
    const page = Object.freeze({ ...this.#environment.snapshot(realm) });
    return Object.freeze({
      ownership: createPageResourceOwnership(
        this.#participant === null,
        this.#resourceBytes,
        decoderState
      ),
      page
    });
  }

  #claimIsCurrent(
    ticket: PageDecoderTicket,
    participant: PageDecoderParticipant,
    generation: number,
    claimSequence: number
  ): boolean {
    return this.#ticket === ticket &&
      this.#participant === participant &&
      this.#ticketGeneration === generation &&
      this.#claimSequence === claimSequence;
  }

  #ensureParticipant(): PageDecoderParticipant {
    const retained = this.#participant;
    if (retained !== null) return retained;
    const realm = this.#currentRealm();
    const participant = this.#environment.createParticipant(
      this.#currentVisibility(),
      realm
    );
    this.#participantRealm = realm;
    this.#participant = participant;
    return participant;
  }

  #retireAdoptedRealm(): void {
    if (
      this.#participantRealm !== null &&
      this.#participantRealm !== this.#currentRealm()
    ) {
      this.releaseAll();
    }
  }

  #cancelTicket(): void {
    const ticket = this.#ticket;
    this.#ticket = null;
    this.#ticketGeneration = null;
    ticket?.cancel();
  }

  #disposeParticipant(): void {
    const participant = this.#participant;
    this.#participant = null;
    this.#participantRealm = null;
    this.#resourceBytes = 0;
    participant?.dispose();
  }

  #decoderState(): PageDecoderTicketState | null {
    if (this.#lease !== null) return "granted";
    return this.#ticket?.state() ?? null;
  }
}
