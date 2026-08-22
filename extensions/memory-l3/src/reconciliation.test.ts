import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmCaller } from "./llm.js";
import {
  detectSupersededValueStaleness,
  reconcileCrossBrain,
  reconcileProseInterference,
} from "./reconciliation.js";
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

describe("detectSupersededValueStaleness — deterministic typed-supersession ground truth", () => {
  it("marks prose containing a superseded typed value, even when the LLM says agreed", async () => {
    await writeFixture(
      [proseFact({ id: "lt-bal", text: "balance is around $500" })],
      [
        typedFact({
          slot: "user:account_balance",
          value: "750.00",
          unit: "USD",
          history: [{ value: "500", supersededAt: NOW }],
        }),
      ],
    );
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({ decisions: [{ factId: "lt-bal", verdict: "agreed" }] }),
    );
    const out = await reconcileCrossBrain({
      storage,
      caller,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(out.newlyMarkedStale).toBe(1);
    expect(out.deterministicStale).toBe(1);
    const stored = await storage.readLongTerm();
    expect(stored.facts.find((f) => f.id === "lt-bal")?.supersededBy).toBe("user:account_balance");
  });

  it("does not fire when the old value is a substring of the current value", async () => {
    await writeFixture(
      [proseFact({ id: "lt-ver", text: "running version 1.2.3 in production" })],
      [
        typedFact({
          slot: "infra:version",
          value: "1.2.34",
          history: [{ value: "1.2.3", supersededAt: NOW }],
        }),
      ],
    );
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({ decisions: [{ factId: "lt-ver", verdict: "agreed" }] }),
    );
    const out = await reconcileCrossBrain({
      storage,
      caller,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(out.newlyMarkedStale).toBe(0);
    expect(out.deterministicStale).toBeUndefined();
    const stored = await storage.readLongTerm();
    expect(stored.facts.find((f) => f.id === "lt-ver")?.supersededBy).toBeNull();
  });

  it("does not fire when prose narrates both old and new values", async () => {
    await writeFixture(
      [proseFact({ id: "lt-bal", text: "balance moved from $500 to $750.00 last week" })],
      [
        typedFact({
          slot: "user:account_balance",
          value: "750.00",
          unit: "USD",
          history: [{ value: "500", supersededAt: NOW }],
        }),
      ],
    );
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({ decisions: [{ factId: "lt-bal", verdict: "agreed" }] }),
    );
    const out = await reconcileCrossBrain({
      storage,
      caller,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(out.newlyMarkedStale).toBe(0);
    expect(out.unmarkedNowAgreed).toBe(0);
    const stored = await storage.readLongTerm();
    expect(stored.facts.find((f) => f.id === "lt-bal")?.supersededBy).toBeNull();
  });

  it("ignores superseded values shorter than 3 characters", () => {
    const stale = detectSupersededValueStaleness(
      [proseFact({ id: "lt-p", text: "channel is set to #a for alerts" })],
      [
        typedFact({
          slot: "chat:channel",
          value: "#b",
          history: [{ value: "#a", supersededAt: NOW }],
        }),
      ],
    );
    expect(stale.size).toBe(0);
  });
});

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
    expect(persisted.facts[0]?.supersededBy ?? null).toBeNull();
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
    expect(persisted.facts[0]?.supersededBy ?? null).toBeNull();
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

describe("reconcileProseInterference — G2 embedding cosine", () => {
  const DAY = 24 * 60 * 60 * 1000;
  // A paraphrase pair with ~zero lexical overlap (jaccard ≈ 0) but near-identical
  // meaning. Embeddings are hand-built unit-ish vectors with cosine ≈ 0.99.
  const olderPara = (): LongTermFact =>
    proseFact({
      id: "lt-old",
      dedupKey: "balance:old",
      text: "Customer checking sits near five hundred.",
      embedding: [1, 0, 0],
      lastConfirmedAt: NOW - 3 * DAY,
      firstSeenAt: NOW - 3 * DAY,
    });
  const newerPara = (): LongTermFact =>
    proseFact({
      id: "lt-new",
      dedupKey: "balance:new",
      text: "Account currently holds about 500 dollars.",
      embedding: [0.9, 0.1, 0],
      lastConfirmedAt: NOW,
      firstSeenAt: NOW,
    });

  it("jaccard-only (default) does NOT supersede a low-lexical paraphrase", async () => {
    await writeFixture([olderPara(), newerPara()], []);
    const out = await reconcileProseInterference({ storage, agentId: "j-rorqual", now: NOW });
    expect(out.newlySuperseded).toBe(0);
    const after = await storage.readLongTerm();
    expect(after.facts.find((f) => f.id === "lt-old")?.supersededBy ?? null).toBeNull();
  });

  it("embedding cosine supersedes the older paraphrase that jaccard misses", async () => {
    await writeFixture([olderPara(), newerPara()], []);
    const out = await reconcileProseInterference({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      interferenceCosineThreshold: 0.7,
    });
    expect(out.newlySuperseded).toBe(1);
    const after = await storage.readLongTerm();
    expect(after.facts.find((f) => f.id === "lt-old")?.supersededBy).toBe("prose:balance:new");
    // The newer fact stays active.
    expect(after.facts.find((f) => f.id === "lt-new")?.supersededBy ?? null).toBeNull();
  });

  it("cosine mode falls back to jaccard when a fact lacks an embedding", async () => {
    // Newer has no embedding → no comparable vectors → jaccard fallback → the
    // low-overlap pair stays distinct even with cosine mode on.
    await writeFixture([olderPara(), { ...newerPara(), embedding: undefined }], []);
    const out = await reconcileProseInterference({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      interferenceCosineThreshold: 0.7,
    });
    expect(out.newlySuperseded).toBe(0);
  });
});
