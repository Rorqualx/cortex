import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmCaller } from "./llm.js";
import { reconcileCrossBrain } from "./reconciliation.js";
import { Storage } from "./storage.js";
import type { LongTermFact, LongTermTypedFact } from "./types.js";

let tmpRoot: string;
let storage: Storage;
const NOW = Date.UTC(2026, 4, 7, 12, 0, 0);

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-reconcile-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const proseFact = (overrides: Partial<LongTermFact>): LongTermFact => ({
  id: "lt-default",
  text: "default text",
  dedupKey: "default:key",
  importance: 0.7,
  firstSeenAt: NOW,
  lastConfirmedAt: NOW,
  recallCount: 1,
  sourceChunkIds: ["chunk-x"],
  archived: false,
  archivedAt: null,
  supersededBy: null,
  ...overrides,
});

const typedFact = (overrides: Partial<LongTermTypedFact>): LongTermTypedFact => ({
  id: "ltt-default",
  slot: "default:slot",
  value: "default",
  unit: null,
  confidence: 0.9,
  firstSeenAt: NOW,
  lastConfirmedAt: NOW,
  recallCount: 1,
  sourceChunkIds: ["chunk-x"],
  history: [],
  validFrom: NOW,
  validUntil: null,
  supersededBy: null,
  archived: false,
  archivedAt: null,
  ...overrides,
});

const writeFixture = async (
  proseFacts: LongTermFact[],
  typedFacts: LongTermTypedFact[],
): Promise<void> => {
  await storage.writeLongTerm(
    { version: 1, agentId: "j-rorqual", lastConsolidatedAt: NOW, facts: proseFacts },
    "",
  );
  await storage.writeLongTermTyped(
    { version: 1, agentId: "j-rorqual", lastConsolidatedAt: NOW, facts: typedFacts },
    "",
  );
};

describe("reconcileCrossBrain", () => {
  it("returns zero counts and no LLM call when typed tier is empty", async () => {
    await writeFixture([proseFact({ id: "lt-1", text: "balance is around $500" })], []);
    const caller = vi.fn(async () => "{}");
    const out = await reconcileCrossBrain({
      storage,
      caller: caller as LlmCaller,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(caller).not.toHaveBeenCalled();
    expect(out.newlyMarkedStale).toBe(0);
    expect(out.proseFactsConsidered).toBe(1);
    expect(out.typedFactsConsidered).toBe(0);
  });

  it("returns zero counts and no LLM call when prose tier is empty", async () => {
    await writeFixture([], [typedFact({ slot: "user:phone", value: "555" })]);
    const caller = vi.fn(async () => "{}");
    const out = await reconcileCrossBrain({
      storage,
      caller: caller as LlmCaller,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(caller).not.toHaveBeenCalled();
    expect(out.newlyMarkedStale).toBe(0);
  });

  it("marks prose facts that the LLM verdicts as stale, naming the typed slot", async () => {
    await writeFixture(
      [
        proseFact({ id: "lt-bal", text: "balance is around $500" }),
        proseFact({ id: "lt-tabs", text: "user prefers tabs over spaces" }),
      ],
      [typedFact({ slot: "user:account_balance", value: "750.00", unit: "USD" })],
    );
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        decisions: [
          { factId: "lt-bal", verdict: "stale", supersededBy: "user:account_balance" },
          { factId: "lt-tabs", verdict: "agreed" },
        ],
      }),
    );
    const out = await reconcileCrossBrain({ storage, caller, agentId: "j-rorqual", now: NOW });
    expect(out.newlyMarkedStale).toBe(1);
    expect(out.unmarkedNowAgreed).toBe(0);

    const persisted = await storage.readLongTerm();
    const bal = persisted.facts.find((f) => f.id === "lt-bal");
    const tabs = persisted.facts.find((f) => f.id === "lt-tabs");
    expect(bal?.supersededBy).toBe("user:account_balance");
    expect(tabs?.supersededBy ?? null).toBeNull();
  });

  it("clears a prior supersededBy mark when the LLM now verdicts agreed", async () => {
    await writeFixture(
      [proseFact({ id: "lt-bal", text: "balance is $750", supersededBy: "user:account_balance" })],
      [typedFact({ slot: "user:account_balance", value: "750.00" })],
    );
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        decisions: [{ factId: "lt-bal", verdict: "agreed" }],
      }),
    );
    const out = await reconcileCrossBrain({ storage, caller, agentId: "j-rorqual", now: NOW });
    expect(out.unmarkedNowAgreed).toBe(1);
    const persisted = await storage.readLongTerm();
    expect(persisted.facts[0].supersededBy ?? null).toBeNull();
  });

  it("ignores LLM decisions that reference unknown factIds or unknown slots", async () => {
    await writeFixture(
      [proseFact({ id: "lt-real", text: "balance is around $500" })],
      [typedFact({ slot: "user:account_balance", value: "750" })],
    );
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        decisions: [
          { factId: "lt-hallucinated", verdict: "stale", supersededBy: "user:account_balance" },
          { factId: "lt-real", verdict: "stale", supersededBy: "nonexistent:slot" },
        ],
      }),
    );
    const out = await reconcileCrossBrain({ storage, caller, agentId: "j-rorqual", now: NOW });
    expect(out.newlyMarkedStale).toBe(0);
    const persisted = await storage.readLongTerm();
    expect(persisted.facts[0].supersededBy ?? null).toBeNull();
  });

  it("doesn't rewrite the file when no marks change", async () => {
    await writeFixture(
      [proseFact({ id: "lt-1", text: "user uses tabs" })],
      [typedFact({ slot: "user:phone", value: "555" })],
    );
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({ decisions: [{ factId: "lt-1", verdict: "agreed" }] }),
    );
    const before = await storage.readLongTerm();
    const out = await reconcileCrossBrain({ storage, caller, agentId: "j-rorqual", now: NOW });
    const after = await storage.readLongTerm();
    expect(out.newlyMarkedStale).toBe(0);
    expect(out.unmarkedNowAgreed).toBe(0);
    expect(after.lastConsolidatedAt).toBe(before.lastConsolidatedAt);
  });

  it("handles malformed LLM JSON without throwing (defensive)", async () => {
    await writeFixture(
      [proseFact({ id: "lt-1", text: "x" })],
      [typedFact({ slot: "y", value: "z" })],
    );
    const caller: LlmCaller = vi.fn(async () => "not json at all");
    const out = await reconcileCrossBrain({ storage, caller, agentId: "j-rorqual", now: NOW });
    expect(out.newlyMarkedStale).toBe(0);
    expect(out.unmarkedNowAgreed).toBe(0);
  });
});
