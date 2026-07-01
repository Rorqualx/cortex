import { afterEach, describe, expect, it } from "vitest";
import {
  __resetProviderConcurrencyGatesForTest,
  acquireProviderRequestSlot,
} from "./provider-concurrency-gate.js";

afterEach(() => {
  __resetProviderConcurrencyGatesForTest();
});

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("acquireProviderRequestSlot", () => {
  it("returns a non-blocking no-op release when no limit is configured", async () => {
    for (const limit of [undefined, 0, -1]) {
      const release = await acquireProviderRequestSlot("zai", limit);
      expect(typeof release).toBe("function");
      // Should never block regardless of how many are acquired.
      const second = await acquireProviderRequestSlot("zai", limit);
      release();
      second();
    }
  });

  it("blocks acquisitions beyond the limit until a slot is released", async () => {
    const r1 = await acquireProviderRequestSlot("zai", 2);
    const r2 = await acquireProviderRequestSlot("zai", 2);

    let thirdAcquired = false;
    const thirdPromise = acquireProviderRequestSlot("zai", 2).then((release) => {
      thirdAcquired = true;
      return release;
    });

    await settled();
    expect(thirdAcquired).toBe(false); // gated: 2 in flight

    r1();
    const r3 = await thirdPromise;
    expect(thirdAcquired).toBe(true); // freed by r1 release

    r2();
    r3();
  });

  it("hands freed slots to waiters in FIFO order", async () => {
    const held = await acquireProviderRequestSlot("zai", 1);
    const order: number[] = [];
    const w1 = acquireProviderRequestSlot("zai", 1).then((r) => {
      order.push(1);
      return r;
    });
    const w2 = acquireProviderRequestSlot("zai", 1).then((r) => {
      order.push(2);
      return r;
    });

    await settled();
    expect(order).toEqual([]);

    held();
    const r1 = await w1;
    await settled();
    expect(order).toEqual([1]); // second waiter still queued behind the first

    r1();
    const r2 = await w2;
    expect(order).toEqual([1, 2]);
    r2();
  });

  it("is idempotent: releasing twice frees only one slot", async () => {
    const r1 = await acquireProviderRequestSlot("zai", 1);
    r1();
    r1(); // second call must be a no-op, not an extra credit

    // Occupy the single slot, then a waiter must actually wait.
    const held = await acquireProviderRequestSlot("zai", 1);
    let extraAcquired = false;
    const waiter = acquireProviderRequestSlot("zai", 1).then((r) => {
      extraAcquired = true;
      return r;
    });
    await settled();
    expect(extraAcquired).toBe(false);

    held();
    const r = await waiter;
    expect(extraAcquired).toBe(true);
    r();
  });

  it("keys gates independently per provider", async () => {
    const zai = await acquireProviderRequestSlot("zai", 1);
    let kimiAcquired = false;
    const kimi = acquireProviderRequestSlot("kimi", 1).then((r) => {
      kimiAcquired = true;
      return r;
    });
    await settled();
    expect(kimiAcquired).toBe(true); // different provider, own limit
    zai();
    (await kimi)();
  });

  it("honors the tightest limit when a provider is reused with a smaller cap", async () => {
    const a = await acquireProviderRequestSlot("zai", 4); // gate created at 4, active 1
    let acquired = false;
    const waiter = acquireProviderRequestSlot("zai", 1).then((r) => {
      // min(4, 1) = 1, so a second in-flight request is now blocked.
      acquired = true;
      return r;
    });
    await settled();
    expect(acquired).toBe(false);
    a();
    (await waiter)();
  });

  it("drops an aborted waiter from the queue without holding a slot", async () => {
    const held = await acquireProviderRequestSlot("zai", 1);
    const controller = new AbortController();
    const waiter = acquireProviderRequestSlot("zai", 1, controller.signal);
    const assertion = expect(waiter).rejects.toThrow(/abort/i);
    controller.abort();
    await assertion;

    // The aborted waiter must not have taken the slot: once the holder releases,
    // a fresh acquire proceeds immediately (queue is empty, active back to 0).
    held();
    let acquired = false;
    const next = acquireProviderRequestSlot("zai", 1).then((r) => {
      acquired = true;
      return r;
    });
    await settled();
    expect(acquired).toBe(true);
    (await next)();
  });
});
