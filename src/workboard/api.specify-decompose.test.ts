// Covers the specify/decompose gateway RPC handlers that close the agent path
// into the store (these methods previously had no RPC surface).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkboardGatewayHandlers } from "./api.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

function openHandlers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wb-rpc-"));
  const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
  const store = new WorkboardStore(stores.cards, {
    boards: stores.boards,
    subscriptions: stores.subscriptions,
    attachments: stores.attachments,
  });
  return { store, handlers: createWorkboardGatewayHandlers(store), close: stores.close };
}

describe("workboard specify/decompose RPC", () => {
  it("specify clarifies a triage card and moves it to todo", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const card = await store.create({ title: "Rough idea", status: "triage" });
      const result = (await handlers["workboard.cards.specify"]!({
        id: card.id,
        summary: "Clarified: build X",
      } as never)) as {
        card: { status: string; metadata?: { comments?: Array<{ body: string }> } };
      };
      expect(result.card.status).toBe("todo");
      expect(result.card.metadata?.comments?.at(-1)?.body).toBe("Clarified: build X");
    } finally {
      close();
    }
  });

  it("decompose fans a parent into linked children in the chosen sections", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      const parent = await store.create({ title: "Ship feature", section: "goals" });
      const result = (await handlers["workboard.cards.decompose"]!({
        id: parent.id,
        children: [
          { title: "Design", section: "implementations" },
          { title: "Write tests", section: "tasks" },
        ],
      } as never)) as {
        parent: { status: string };
        children: Array<{ title: string; section?: string }>;
      };
      expect(result.children).toHaveLength(2);
      expect(result.children.map((c) => c.section).toSorted()).toEqual([
        "implementations",
        "tasks",
      ]);
      // Parent is completed by default after decompose.
      expect(result.parent.status).toBe("done");
    } finally {
      close();
    }
  });

  it("authorizes specify on a claimed card via the claim token scope", async () => {
    const { store, handlers, close } = openHandlers();
    try {
      // A claimed triage card stays in triage (claim only flips backlog/todo/ready
      // to running), so it is still specifiable — the orchestrator path.
      const card = await store.create({ title: "Owned", status: "triage" });
      const { token } = await store.claim(card.id, { ownerId: "orch-1", ttlSeconds: 600 });
      // A wrong token is rejected by assertCanMutateClaimedCard...
      await expect(
        handlers["workboard.cards.specify"]!({
          id: card.id,
          summary: "x",
          claimToken: "wrong",
        } as never),
      ).rejects.toThrow(/claimed by/);
      // ...the real token authorizes the mutation.
      const ok = (await handlers["workboard.cards.specify"]!({
        id: card.id,
        summary: "real spec",
        claimToken: token,
      } as never)) as { card: { status: string } };
      expect(ok.card.status).toBe("todo");
    } finally {
      close();
    }
  });
});
