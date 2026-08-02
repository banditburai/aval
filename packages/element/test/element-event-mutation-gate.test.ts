import { describe, expect, it } from "vitest";

import { ElementEventMutationGate } from "../src/element-event-mutation-gate.js";
import { ElementPublicEvents } from "../src/element-public-events.js";

describe("ElementEventMutationGate", () => {
  it("serializes synchronous and promise commands after event listeners", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const gate = new ElementEventMutationGate(events);
    const order: string[] = [];
    events.transaction(true);
    expect(gate.deferCommand(() => { order.push("source"); })).toBe(true);
    const disposal = gate.deferCommandPromise(async () => {
      order.push("dispose");
      return 17;
    });
    order.push("listener-end");
    expect(gate.pendingOperationCount).toBe(2);
    expect(order).toEqual(["listener-end"]);
    events.transaction(false);
    await expect(disposal).resolves.toBe(17);
    expect(order).toEqual(["listener-end", "source", "dispose"]);
    expect(gate.pendingOperationCount).toBe(0);
  });

  it("coalesces each deferred attribute to its latest reflected value", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const gate = new ElementEventMutationGate(events);
    const applied: string[] = [];
    let state: string | null = "B";
    let fit: string | null = "contain";

    events.transaction(true);
    expect(gate.deferAttribute(
      "state",
      () => state,
      (value) => { applied.push(`state:${String(value)}`); }
    )).toBe(true);
    state = "C";
    expect(gate.deferAttribute(
      "state",
      () => state,
      (value) => { applied.push(`duplicate:${String(value)}`); }
    )).toBe(true);
    expect(gate.deferAttribute(
      "fit",
      () => fit,
      (value) => { applied.push(`fit:${String(value)}`); }
    )).toBe(true);
    fit = "cover";
    expect(gate.pendingOperationCount).toBe(2);
    events.transaction(false);

    await settleGate(gate);
    expect(applied).toEqual(["state:C", "fit:cover"]);
    expect(gate.pendingOperationCount).toBe(0);
  });

  it("owns microtasks and orders event followups after deferred commands", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const gate = new ElementEventMutationGate(events);
    const order: string[] = [];
    events.transaction(true);
    expect(gate.deferCommand(() => { order.push("command"); })).toBe(true);
    events.transaction(false);
    gate.queueEventFollowup(() => { order.push("followup"); });
    gate.queueOwnedMicrotask(() => { order.push("microtask"); });

    expect(gate.pendingOperationCount).toBe(3);
    await settleGate(gate);
    expect(order).toEqual(["command", "followup", "microtask"]);
    expect(gate.pendingOperationCount).toBe(0);
  });

  it("holds the serialized tail and pending count through promise settlement", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const gate = new ElementEventMutationGate(events);
    const order: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    events.transaction(true);
    const first = gate.deferCommandPromise(async () => {
      order.push("first:start");
      await hold;
      order.push("first:end");
    });
    const second = gate.deferCommandPromise(async () => {
      order.push("second");
    });
    events.transaction(false);
    if (first === null || second === null) throw new Error("defer failed");

    await settleMicrotasks();
    expect(order).toEqual(["first:start"]);
    expect(gate.pendingOperationCount).toBe(2);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(gate.pendingOperationCount).toBe(0);
  });

  it("preserves snapshot, listener, deferred command, and followup order", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const gate = new ElementEventMutationGate(events);
    const order = ["snapshot-committed"];
    events.transaction(true);
    order.push("event-listener-enter");
    expect(gate.deferCommand(() => { order.push("deferred-command"); })).toBe(true);
    order.push("event-listener-exit");
    events.transaction(false);
    gate.queueEventFollowup(() => { order.push("event-follow-up"); });

    await settleGate(gate);
    expect(order).toEqual([
      "snapshot-committed",
      "event-listener-enter",
      "event-listener-exit",
      "deferred-command",
      "event-follow-up"
    ]);
  });

  it("retains one queue across nested transactions", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const gate = new ElementEventMutationGate(events);
    const order: string[] = [];
    events.transaction(true);
    events.transaction(true);
    expect(gate.deferCommand(() => { order.push("nested"); })).toBe(true);
    events.transaction(false);
    expect(events.active).toBe(true);
    expect(order).toEqual([]);
    events.transaction(false);

    await settleGate(gate);
    expect(order).toEqual(["nested"]);
    expect(gate.pendingOperationCount).toBe(0);
  });

  it("does not leak pending ownership when a deferred promise rejects", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const gate = new ElementEventMutationGate(events);
    events.transaction(true);
    const deferred = gate.deferCommandPromise(async () => {
      throw new Error("synthetic rejection");
    });
    const rejection = expect(deferred).rejects.toThrow("synthetic rejection");
    expect(gate.pendingOperationCount).toBe(1);
    events.transaction(false);

    await rejection;
    expect(gate.pendingOperationCount).toBe(0);
  });

  it("rejects work outside transactions and after close without dropping accepted work", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const gate = new ElementEventMutationGate(events);
    const order: string[] = [];
    expect(gate.deferCommand(() => { order.push("outside"); })).toBe(false);
    expect(gate.deferCommandPromise(async () => 1)).toBeNull();
    expect(gate.deferAttribute("state", () => "idle", () => undefined)).toBe(false);

    events.transaction(true);
    expect(gate.deferCommand(() => { order.push("accepted"); })).toBe(true);
    gate.close();
    expect(gate.deferCommand(() => { order.push("closed"); })).toBe(false);
    expect(gate.deferCommandPromise(async () => 2)).toBeNull();
    gate.queueOwnedMicrotask(() => { order.push("closed-microtask"); });
    gate.queueEventFollowup(() => { order.push("closed-followup"); });
    events.transaction(false);

    await settleGate(gate);
    expect(order).toEqual(["accepted"]);
    expect(gate.pendingOperationCount).toBe(0);
  });
});

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settleGate(gate: ElementEventMutationGate): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (gate.pendingOperationCount === 0) return;
    await Promise.resolve();
  }
  throw new Error("mutation gate did not settle");
}
