import { describe, expect, it, vi } from "vitest";

import {
  ElementPageResourceOwner,
  type ElementPageResourceEnvironment
} from "../src/element-page-resource-owner.js";
import type {
  PageDecoderLease,
  PageDecoderParticipant,
  PageDecoderTicket,
  PageDecoderTicketState,
  PageResourcesSnapshot
} from "../src/page-resources.js";

const EMPTY_PAGE: Readonly<PageResourcesSnapshot> = Object.freeze({
  active: 0,
  queued: 0,
  parked: 0,
  participants: 0,
  physicalBytes: 0
});

describe("ElementPageResourceOwner", () => {
  it("creates its participant lazily and accepts a synchronous lease", () => {
    const harness = createHarness();
    const lease = new FakeLease();
    harness.tickets.push(new FakeTicket(lease));
    const owner = harness.owner();

    expect(harness.participants).toHaveLength(0);
    expect(owner.claimDecoder(4)).toBe(true);
    expect(owner.claimDecoder(4)).toBe(true);
    expect(harness.participants).toHaveLength(1);
    expect(harness.participants[0]).toMatchObject({
      realm: harness.realm,
      initialVisibility: true,
      requestCount: 1
    });

    owner.setResourceBytes(2_048);
    expect(owner.snapshot().ownership).toEqual({
      kind: "page-resources",
      participantDisposed: false,
      participantRegistered: true,
      logicalBytes: 2_048,
      activeLeaseCount: 1,
      decoderTicketCount: 1,
      decoderState: "granted"
    });

    owner.releaseAll();
    owner.releaseAll();
    expect(lease.releaseCount).toBe(1);
    expect(harness.participants[0]?.disposeCount).toBe(1);
    expect(owner.snapshot().ownership).toMatchObject({
      participantDisposed: true,
      logicalBytes: 0,
      activeLeaseCount: 0,
      decoderTicketCount: 0,
      decoderState: null
    });
  });

  it("publishes an asynchronous grant once for the current generation", async () => {
    const harness = createHarness();
    const ticket = new FakeTicket();
    const lease = new FakeLease();
    harness.tickets.push(ticket);
    const owner = harness.owner();

    expect(owner.claimDecoder(9)).toBe(false);
    expect(owner.claimDecoder(9)).toBe(false);
    expect(harness.participants[0]?.requestCount).toBe(1);

    ticket.grant(lease);
    await settleMicrotasks();

    expect(harness.onDecoderGranted).toHaveBeenCalledTimes(1);
    expect(harness.onDecoderGranted).toHaveBeenCalledWith(9);
    expect(owner.snapshot().ownership).toMatchObject({
      activeLeaseCount: 1,
      decoderState: "granted"
    });
  });

  it("never lends a retained lease to another source generation", () => {
    const harness = createHarness();
    harness.tickets.push(new FakeTicket(new FakeLease()));
    const owner = harness.owner();

    expect(owner.claimDecoder(4)).toBe(true);
    expect(owner.claimDecoder(5)).toBe(false);
    expect(harness.participants[0]?.requestCount).toBe(1);
  });

  it("releases a late stale grant locally after invalidation", async () => {
    const harness = createHarness();
    const ticket = new FakeTicket();
    const lease = new FakeLease();
    harness.tickets.push(ticket);
    const owner = harness.owner();

    expect(owner.claimDecoder(1)).toBe(false);
    owner.invalidateRequest();
    ticket.grant(lease);
    await settleMicrotasks();

    expect(ticket.cancelCount).toBe(1);
    expect(lease.releaseCount).toBe(1);
    expect(harness.onDecoderGranted).not.toHaveBeenCalled();
    expect(owner.snapshot().ownership.decoderState).toBeNull();
  });

  it("supersedes an older queued generation without exposing a claim id", async () => {
    const harness = createHarness();
    const oldTicket = new FakeTicket();
    const nextTicket = new FakeTicket();
    const oldLease = new FakeLease();
    const nextLease = new FakeLease();
    harness.tickets.push(oldTicket, nextTicket);
    const owner = harness.owner();

    expect(owner.claimDecoder(2)).toBe(false);
    expect(owner.claimDecoder(3)).toBe(false);
    oldTicket.grant(oldLease);
    nextTicket.grant(nextLease);
    await settleMicrotasks();

    expect(oldTicket.cancelCount).toBe(1);
    expect(oldLease.releaseCount).toBe(1);
    expect(nextLease.releaseCount).toBe(0);
    expect(harness.onDecoderGranted).toHaveBeenCalledTimes(1);
    expect(harness.onDecoderGranted).toHaveBeenCalledWith(3);
  });

  it("retires the old realm before lazily joining an adopted realm", () => {
    const harness = createHarness();
    const firstLease = new FakeLease();
    const secondLease = new FakeLease();
    harness.tickets.push(new FakeTicket(firstLease), new FakeTicket(secondLease));
    const owner = harness.owner();

    expect(owner.claimDecoder(1)).toBe(true);
    const firstParticipant = harness.participants[0]!;
    harness.realm = {};
    expect(owner.claimDecoder(2)).toBe(true);

    expect(firstLease.releaseCount).toBe(1);
    expect(firstParticipant.disposeCount).toBe(1);
    expect(harness.participants).toHaveLength(2);
    expect(harness.participants[1]?.realm).toBe(harness.realm);
  });

  it("owns visibility, byte validation, and static retirement policy", () => {
    const harness = createHarness();
    const queued = new FakeTicket();
    harness.tickets.push(queued);
    const owner = harness.owner();

    expect(() => owner.setResourceBytes(-1)).toThrow(
      "Invalid participant physical bytes"
    );
    expect(() => owner.setResourceBytes(0)).not.toThrow();
    expect(owner.claimDecoder(5)).toBe(false);
    owner.setVisible(false);
    expect(harness.participants[0]?.visibility).toEqual([false]);

    owner.animationResourcesRetired(false);
    expect(queued.cancelCount).toBe(1);
    expect(harness.participants[0]?.disposeCount).toBe(1);
    expect(owner.snapshot().ownership.participantDisposed).toBe(true);
  });

  it("retains a queued decoder request when animation retirement says it is needed", () => {
    const harness = createHarness();
    const queued = new FakeTicket();
    harness.tickets.push(queued);
    const owner = harness.owner();

    expect(owner.claimDecoder(6)).toBe(false);
    owner.animationResourcesRetired(true);

    expect(queued.cancelCount).toBe(0);
    expect(harness.participants[0]?.disposeCount).toBe(0);
    expect(owner.snapshot().ownership.decoderState).toBe("queued");
  });

  it("uses the participant realm for page diagnostics and freezes the snapshot", () => {
    const harness = createHarness();
    const page = {
      active: 1,
      queued: 2,
      parked: 3,
      participants: 4,
      physicalBytes: 5
    };
    harness.page = page;
    harness.tickets.push(new FakeTicket(new FakeLease()));
    const owner = harness.owner();
    owner.claimDecoder(1);

    const snapshot = owner.snapshot();
    expect(snapshot.page).toEqual(page);
    expect(harness.snapshotRealms).toEqual([harness.realm]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.page)).toBe(true);
  });
});

class FakeLease implements PageDecoderLease {
  releaseCount = 0;

  release(): void {
    this.releaseCount += 1;
  }
}

class FakeTicket implements PageDecoderTicket {
  cancelCount = 0;
  #lease: PageDecoderLease | null;
  #state: PageDecoderTicketState;
  #resolve!: (lease: PageDecoderLease) => void;
  #reject!: (error: unknown) => void;
  #waiting: Promise<PageDecoderLease>;

  constructor(immediateLease: PageDecoderLease | null = null) {
    this.#lease = immediateLease;
    this.#state = immediateLease === null ? "queued" : "granted";
    this.#waiting = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  take(): PageDecoderLease | null {
    return this.#lease;
  }

  wait(): Promise<PageDecoderLease> {
    return this.#lease === null ? this.#waiting : Promise.resolve(this.#lease);
  }

  cancel(): void {
    this.cancelCount += 1;
    this.#state = "cancelled";
  }

  state(): PageDecoderTicketState {
    return this.#state;
  }

  grant(lease: PageDecoderLease): void {
    this.#lease = lease;
    this.#state = "granted";
    this.#resolve(lease);
  }

  reject(error: unknown): void {
    this.#reject(error);
  }
}

class FakeParticipant implements PageDecoderParticipant {
  readonly visibility: boolean[] = [];
  readonly physicalBytes: number[] = [];
  requestCount = 0;
  disposeCount = 0;

  constructor(
    readonly realm: object,
    readonly initialVisibility: boolean,
    private readonly nextTicket: () => PageDecoderTicket
  ) {}

  request(): PageDecoderTicket {
    this.requestCount += 1;
    return this.nextTicket();
  }

  setVisible(visible: boolean): void {
    this.visibility.push(visible);
  }

  setPhysicalBytes(bytes: number): void {
    this.physicalBytes.push(bytes);
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

function createHarness(): {
  realm: object;
  page: Readonly<PageResourcesSnapshot>;
  readonly tickets: FakeTicket[];
  readonly participants: FakeParticipant[];
  readonly snapshotRealms: object[];
  readonly onDecoderGranted: ReturnType<typeof vi.fn<(generation: number) => void>>;
  owner(): ElementPageResourceOwner;
} {
  const harness = {
    realm: {},
    page: EMPTY_PAGE,
    tickets: [] as FakeTicket[],
    participants: [] as FakeParticipant[],
    snapshotRealms: [] as object[],
    onDecoderGranted: vi.fn<(generation: number) => void>(),
    owner(): ElementPageResourceOwner {
      const environment: ElementPageResourceEnvironment = {
        createParticipant: (visible, realm) => {
          const participant = new FakeParticipant(
            realm,
            visible,
            () => {
              const ticket = harness.tickets.shift();
              if (ticket === undefined) throw new Error("No fake decoder ticket queued");
              return ticket;
            }
          );
          harness.participants.push(participant);
          return participant;
        },
        snapshot: (realm) => {
          harness.snapshotRealms.push(realm);
          return harness.page;
        }
      };
      return new ElementPageResourceOwner({
        environment,
        currentRealm: () => harness.realm,
        currentVisibility: () => true,
        onDecoderGranted: harness.onDecoderGranted
      });
    }
  };
  return harness;
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
