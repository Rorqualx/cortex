// Covers the workboard.research.stage RPC — the load-bearing contract between the
// Deep Pipeline cron and the nightly Implementation cron (implement → ready flip),
// plus its guards (category, no forward-skip, validation).
import { describe, expect, it } from "vitest";
import { createWorkboardGatewayHandlers } from "./api.js";
import type { WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";
import type { WorkboardResearchCategory } from "./types.js";

// The canonical core-DB store serializes each card as a JSON blob (research and
// all), so mirror it with an in-memory KeyedStore — the legacy columnar
// createWorkboardSqliteStores has no research column and would drop it.
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

function openHandlers() {
  const store = new WorkboardStore(memoryStore(), {
    boards: memoryStore(),
    subscriptions: memoryStore(),
    attachments: memoryStore(),
  });
  return { store, handlers: createWorkboardGatewayHandlers(store), close: () => {} };
}

async function makeCard(
  store: WorkboardStore,
  category: WorkboardResearchCategory,
  stage?: string,
) {
  return store.create({
    title: `${category} card`,
    status: "backlog",
    metadata: {
      research: { cycleDate: "2026-07-01", itemId: "X-1", category, ...(stage ? { stage } : {}) },
    },
  });
}

type StageResult = {
  card: { status: string; metadata?: { research?: { stage?: string; stageLog?: unknown[] } } };
};

describe("workboard.research.stage RPC", () => {
  it("advances one stage and appends to the stage log", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const card = await makeCard(store, "architecture", "research");
      const res = (await handlers["workboard.research.stage"]!({
        id: card.id,
        stage: "rescope",
        note: "scope confirmed",
      } as never)) as StageResult;
      expect(res.card.metadata?.research?.stage).toBe("rescope");
      expect(res.card.metadata?.research?.stageLog).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("flips the card to 'ready' when it reaches implement", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const card = await makeCard(store, "long-horizon", "review");
      const res = (await handlers["workboard.research.stage"]!({
        id: card.id,
        stage: "implement",
      } as never)) as StageResult;
      expect(res.card.metadata?.research?.stage).toBe("implement");
      expect(res.card.status).toBe("ready");
    } finally {
      close();
    }
  });

  it("rejects an invalid stage", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const card = await makeCard(store, "architecture", "research");
      await expect(
        handlers["workboard.research.stage"]!({ id: card.id, stage: "ship" } as never),
      ).rejects.toThrow(/invalid research stage/);
    } finally {
      close();
    }
  });

  it("refuses non-architecture/long-horizon cards (won't freeze a quick-win)", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const card = await makeCard(store, "quick-win");
      await expect(
        handlers["workboard.research.stage"]!({ id: card.id, stage: "research" } as never),
      ).rejects.toThrow(/architecture\/long-horizon/);
    } finally {
      close();
    }
  });

  it("refuses skipping forward past the next stage", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const card = await makeCard(store, "architecture", "research");
      await expect(
        handlers["workboard.research.stage"]!({ id: card.id, stage: "implement" } as never),
      ).rejects.toThrow(/cannot skip stages/);
    } finally {
      close();
    }
  });

  it("allows a backward step (probe/review can send a card back to design)", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const card = await makeCard(store, "architecture", "probe");
      const res = (await handlers["workboard.research.stage"]!({
        id: card.id,
        stage: "design",
      } as never)) as StageResult;
      expect(res.card.metadata?.research?.stage).toBe("design");
    } finally {
      close();
    }
  });

  it("rejects a stage call on a terminal (done) card", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const card = await makeCard(store, "architecture", "implement");
      // The Implementation cron completed it directly.
      await store.update(card.id, { status: "done" });
      // A stray/retried call must not re-land it or rewrite its stage.
      await expect(
        handlers["workboard.research.stage"]!({ id: card.id, stage: "implement" } as never),
      ).rejects.toThrow(/pipeline is complete/);
    } finally {
      close();
    }
  });

  it("treats a same-stage call as an idempotent no-op (no duplicate log entry)", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const card = await makeCard(store, "architecture", "design");
      await handlers["workboard.research.stage"]!({ id: card.id, stage: "design" } as never);
      const res = (await handlers["workboard.research.stage"]!({
        id: card.id,
        stage: "design",
      } as never)) as StageResult;
      // Neither call should have appended a transition for the unchanged stage.
      expect(res.card.metadata?.research?.stageLog ?? []).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("un-queues a card walked back out of implement (ready -> backlog)", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const card = await makeCard(store, "architecture", "review");
      const queued = (await handlers["workboard.research.stage"]!({
        id: card.id,
        stage: "implement",
      } as never)) as StageResult;
      expect(queued.card.status).toBe("ready");
      // Reopening it (implement -> review) must drop it from the cron's queue.
      const reopened = (await handlers["workboard.research.stage"]!({
        id: card.id,
        stage: "review",
      } as never)) as StageResult;
      expect(reopened.card.metadata?.research?.stage).toBe("review");
      expect(reopened.card.status).toBe("backlog");
    } finally {
      close();
    }
  });

  it("keeps an operator-promoted (userTouched) card ready on walk-back", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const card = await makeCard(store, "architecture", "implement");
      // Operator manually forced it ready and marked it touched (an override the
      // pipeline must not undo).
      await store.update(card.id, {
        status: "ready",
        metadata: { research: { ...card.metadata!.research!, userTouched: true } },
      });
      const res = (await handlers["workboard.research.stage"]!({
        id: card.id,
        stage: "review",
      } as never)) as StageResult;
      expect(res.card.status).toBe("ready");
    } finally {
      close();
    }
  });
});
