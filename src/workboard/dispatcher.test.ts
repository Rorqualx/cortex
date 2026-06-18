// Covers the dispatcher pass: board-gated spawning, claim-on-start, worker vs
// orchestrator selection, and block-on-start-failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkboardDispatchPass, type WorkboardSpawn } from "./dispatcher.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wb-dispatch-"));
  const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
  const store = new WorkboardStore(stores.cards, {
    boards: stores.boards,
    subscriptions: stores.subscriptions,
    attachments: stores.attachments,
  });
  return { store, close: stores.close };
}

function recordingSpawn() {
  const calls: Array<Parameters<WorkboardSpawn>[0]> = [];
  const spawn: WorkboardSpawn = async (params) => {
    calls.push(params);
    return { runId: `run-${calls.length}` };
  };
  return { calls, spawn };
}

describe("runWorkboardDispatchPass", () => {
  it("is inert when no board opted into orchestration", async () => {
    const { store, close } = openStore();
    try {
      await store.create({ title: "Ready", boardId: "b1", status: "ready" });
      const { calls, spawn } = recordingSpawn();
      const result = await runWorkboardDispatchPass({ store, spawn });
      expect(result).toEqual({ workersStarted: 0, orchestratorsStarted: 0, startFailures: 0 });
      expect(calls).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("claims and spawns a worker for a ready card on an opted-in board", async () => {
    const { store, close } = openStore();
    try {
      await store.upsertBoard({ id: "b1", orchestration: { autoDecompose: true } });
      const card = await store.create({ title: "Do it", boardId: "b1", status: "ready" });
      const { calls, spawn } = recordingSpawn();
      const result = await runWorkboardDispatchPass({ store, spawn });
      expect(result.workersStarted).toBe(1);
      expect(calls[0]!.sessionKey).toContain("subagent:workboard-b1-");
      expect(calls[0]!.message).toContain(card.id);
      expect(calls[0]!.message).toMatch(/claim token is:/i);
      const after = await store.get(card.id);
      expect(after?.status).toBe("running");
      expect(after?.metadata?.claim?.ownerId).toBe(calls[0]!.sessionKey);
    } finally {
      close();
    }
  });

  it("spawns an orchestrator for a flagged triage card", async () => {
    const { store, close } = openStore();
    try {
      await store.upsertBoard({ id: "b1", orchestration: { autoDecompose: true } });
      await store.create({ title: "Rough idea", boardId: "b1", status: "triage" });
      const { calls, spawn } = recordingSpawn();
      const result = await runWorkboardDispatchPass({ store, spawn });
      expect(result.orchestratorsStarted).toBe(1);
      expect(calls[0]!.sessionKey).toContain("workboard-orchestrator-b1-");
      expect(calls[0]!.message).toContain("workboard_decompose");
    } finally {
      close();
    }
  });

  it("blocks a card when the worker fails to start", async () => {
    const { store, close } = openStore();
    try {
      await store.upsertBoard({ id: "b1", orchestration: { autoDecompose: true } });
      const card = await store.create({ title: "Do it", boardId: "b1", status: "ready" });
      const spawn: WorkboardSpawn = async () => {
        throw new Error("boom");
      };
      const result = await runWorkboardDispatchPass({ store, spawn });
      expect(result.startFailures).toBe(1);
      const after = await store.get(card.id);
      expect(after?.status).toBe("blocked");
      expect(after?.metadata?.claim).toBeUndefined();
    } finally {
      close();
    }
  });

  it("does not double-spawn a card across overlapping/repeated passes (claim guard)", async () => {
    const { store, close } = openStore();
    try {
      await store.upsertBoard({ id: "b1", orchestration: { autoDecompose: true } });
      await store.create({ title: "Once", boardId: "b1", status: "ready" });
      const { calls, spawn } = recordingSpawn();
      const first = await runWorkboardDispatchPass({ store, spawn });
      const second = await runWorkboardDispatchPass({ store, spawn });
      expect(first.workersStarted).toBe(1);
      // Second pass: card is now running+claimed, so claim throws → no re-spawn.
      expect(second.workersStarted).toBe(0);
      expect(calls).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("starts at most maxWorkers per pass", async () => {
    const { store, close } = openStore();
    try {
      await store.upsertBoard({ id: "b1", orchestration: { autoDecompose: true } });
      // distinct agents so the per-owner dedupe does not collapse them
      for (let i = 0; i < 4; i++) {
        await store.create({ title: `R${i}`, boardId: "b1", status: "ready", agentId: `a${i}` });
      }
      const { calls, spawn } = recordingSpawn();
      const result = await runWorkboardDispatchPass({ store, spawn, maxWorkers: 2 });
      expect(result.workersStarted).toBe(2);
      expect(calls).toHaveLength(2);
    } finally {
      close();
    }
  });
});
