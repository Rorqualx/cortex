import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkboardKeyedStore } from "./persistence-types.js";
import { runResearchIngest, SELF_IMPROVEMENT_BOARD_ID } from "./research-ingest.js";
import { WorkboardStore } from "./store.js";

function memoryStore<T>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

function newStore(): WorkboardStore {
  return new WorkboardStore(memoryStore(), {
    boards: memoryStore(),
    subscriptions: memoryStore(),
    attachments: memoryStore(),
  });
}

const DATE = "2026-06-21";

const LLM_RESEARCH = `# LLM Research Daily Scan — ${DATE}

## Top Findings

### 1. H-RePlan: Hierarchical Recovery

- **Source:** arXiv:2606.20487 (Jun 18, 2026)
- **Summary:** Hierarchical replanning for multi-device agents.
- **OpenClaw Integration Relevance:** Maps to agent runtime.

### 2. Learning What to Remember

- **Source:** arXiv:2606.12945 (Jun 11, 2026)
- **Summary:** Multi-factor memory value function.
- **OpenClaw Integration Relevance:** Maps to Memory-L3.

## Watch List

- **Vortex (arXiv:2606.06453)** — programmable sparse attention serving.
`;

const ANALYSIS = `# OpenClaw Source Analysis — ${DATE}

## ⚡ Quick Wins

### QW-1: Add goal-relevance & reliability factors
**Source finding:** #2 (Learning What to Remember)
**Complexity:** S · **Risk:** Low

**Change:**
1. Add goalRelevance and reliability to Signals.
2. Wire into composite().

## 🏗️ Architecture

### ARCH-1: Replace recency truncation (PACMS)
**Source finding:** #1 (PACMS)
**Complexity:** L · **Risk:** Medium

**Change:**
1. Add submodular selection step.
`;

const IMPLEMENTATION = `# OpenClaw Implementation Report — ${DATE}
Status: COMPLETE — 1 implemented

## Implemented

### QW-1: Add goal-relevance & reliability factors ✅
- **Files changed:** \`scoring.ts\`
- **Commit:** \`22f4a4e36a\` — feat(daily-research): QW-1
`;

describe("runResearchIngest", () => {
  let dir: string;
  let reportsDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rsil-"));
    reportsDir = path.join(dir, "memory", "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, `llm-research-${DATE}.md`), LLM_RESEARCH);
    fs.writeFileSync(path.join(reportsDir, `openclaw-analysis-${DATE}.md`), ANALYSIS);
    fs.writeFileSync(path.join(reportsDir, `implementation-${DATE}.md`), IMPLEMENTATION);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the board and cards for analysis items, findings, and watch entries", async () => {
    const store = newStore();
    const result = await runResearchIngest({ store, reportsDir });

    const boards = await store.listBoards();
    expect(boards.boards.some((b) => b.id === SELF_IMPROVEMENT_BOARD_ID)).toBe(true);

    const cards = await store.list({ boardId: SELF_IMPROVEMENT_BOARD_ID });
    const byKey = Object.fromEntries(cards.map((c) => [c.metadata?.research?.itemId, c]));
    // 2 analysis items + 2 findings + 1 watch.
    expect(cards).toHaveLength(5);
    expect(result.created).toBe(5);
    expect(byKey["QW-1"].metadata?.research?.category).toBe("quick-win");
    expect(byKey["ARCH-1"].metadata?.research?.category).toBe("architecture");
    expect(byKey["F-1"].metadata?.research?.category).toBe("finding");
    expect(byKey["WATCH-1"].metadata?.research?.category).toBe("watch");
  });

  it("maps implementation outcomes to status and stamps the commit", async () => {
    const store = newStore();
    await runResearchIngest({ store, reportsDir });
    const cards = await store.list({ boardId: SELF_IMPROVEMENT_BOARD_ID });
    const qw1 = cards.find((c) => c.metadata?.research?.itemId === "QW-1");
    const arch1 = cards.find((c) => c.metadata?.research?.itemId === "ARCH-1");
    // QW-1 was implemented → done with commit; ARCH-1 not implemented → backlog
    // (seeded for manual triage; the operator promotes to "ready" to auto-work it).
    expect(qw1?.status).toBe("done");
    expect(qw1?.metadata?.research?.commit).toBe("22f4a4e36a");
    expect(arch1?.status).toBe("backlog");
    expect(arch1?.sourceUrl).toContain("arxiv.org");
  });

  it("seeds next-steps from the analysis change list", async () => {
    const store = newStore();
    await runResearchIngest({ store, reportsDir });
    const cards = await store.list({ boardId: SELF_IMPROVEMENT_BOARD_ID });
    const arch1 = cards.find((c) => c.metadata?.research?.itemId === "ARCH-1");
    expect(arch1?.metadata?.research?.nextSteps).toEqual(["Add submodular selection step."]);
  });

  it("is idempotent — re-running updates in place, no duplicates", async () => {
    const store = newStore();
    await runResearchIngest({ store, reportsDir });
    const second = await runResearchIngest({ store, reportsDir });
    const cards = await store.list({ boardId: SELF_IMPROVEMENT_BOARD_ID });
    expect(cards).toHaveLength(5);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(5);
  });

  it("preserves operator status/next-steps once a card is userTouched", async () => {
    const store = newStore();
    await runResearchIngest({ store, reportsDir });
    let cards = await store.list({ boardId: SELF_IMPROVEMENT_BOARD_ID });
    const arch1 = cards.find((c) => c.metadata?.research?.itemId === "ARCH-1")!;

    // Operator moves it and edits steps, marking it touched.
    await store.update(arch1.id, {
      status: "blocked",
      metadata: {
        research: {
          ...arch1.metadata!.research!,
          nextSteps: ["operator note"],
          userTouched: true,
        },
      },
    });

    const result = await runResearchIngest({ store, reportsDir });
    expect(result.skippedUserTouched).toBeGreaterThanOrEqual(1);
    cards = await store.list({ boardId: SELF_IMPROVEMENT_BOARD_ID });
    const after = cards.find((c) => c.metadata?.research?.itemId === "ARCH-1")!;
    expect(after.status).toBe("blocked");
    expect(after.metadata?.research?.nextSteps).toEqual(["operator note"]);
  });

  it("archives cards older than the retention window", async () => {
    const store = newStore();
    // Ingest at a time far past the cycle date so retention kicks in.
    const future = Date.parse("2026-09-01T00:00:00Z");
    const result = await runResearchIngest({ store, reportsDir, now: future, retentionDays: 30 });
    expect(result.archived).toBe(5);
  });
});
