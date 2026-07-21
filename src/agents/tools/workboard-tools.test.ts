// Verifies the workboard agent tools wire to the right RPC method and forward
// the claim token both stores read (token + claimToken).
import { describe, expect, it, vi } from "vitest";
import { createWorkboardTools } from "./workboard-tools.js";

function toolsWithMock() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const callGateway = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
    return { card: { id: "c1" } };
  });
  const tools = createWorkboardTools({ callGateway: callGateway as never });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { calls, byName };
}

describe("workboard agent tools", () => {
  it("exposes the loop-closing tool set", () => {
    const { byName } = toolsWithMock();
    expect([...byName.keys()].toSorted()).toEqual(
      [
        "workboard_block",
        "workboard_complete",
        "workboard_decompose",
        "workboard_heartbeat",
        "workboard_list",
        "workboard_read",
        "workboard_research_sync",
        "workboard_specify",
      ].toSorted(),
    );
  });

  it("specify forwards id, summary, and the claim token as token + claimToken", async () => {
    const { calls, byName } = toolsWithMock();
    await byName.get("workboard_specify")!.execute("t1", {
      id: "card-1",
      summary: "clarified",
      claimToken: "tok-9",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("workboard.cards.specify");
    expect(calls[0]!.params).toMatchObject({
      id: "card-1",
      summary: "clarified",
      token: "tok-9",
      claimToken: "tok-9",
    });
  });

  it("decompose forwards the children array and completeParent", async () => {
    const { calls, byName } = toolsWithMock();
    await byName.get("workboard_decompose")!.execute("t1", {
      id: "p1",
      children: [{ title: "child", section: "tasks" }],
      completeParent: false,
    });
    expect(calls[0]!.method).toBe("workboard.cards.decompose");
    expect(calls[0]!.params.children).toEqual([{ title: "child", section: "tasks" }]);
    expect(calls[0]!.params.completeParent).toBe(false);
  });

  it("complete forwards the claim token so the store authorizes the worker", async () => {
    const { calls, byName } = toolsWithMock();
    await byName.get("workboard_complete")!.execute("t1", {
      id: "card-1",
      summary: "done",
      claimToken: "tok-1",
    });
    expect(calls[0]!.method).toBe("workboard.cards.complete");
    expect(calls[0]!.params).toMatchObject({ id: "card-1", summary: "done", token: "tok-1" });
  });

  it("research_sync wraps the ingest RPC and forwards defaultAssignee", async () => {
    const { calls, byName } = toolsWithMock();
    await byName.get("workboard_research_sync")!.execute("t1", { defaultAssignee: "main" });
    expect(calls[0]!.method).toBe("workboard.research.sync");
    expect(calls[0]!.params).toEqual({ defaultAssignee: "main" });
  });

  it("research_sync omits empty optional params", async () => {
    const { calls, byName } = toolsWithMock();
    await byName.get("workboard_research_sync")!.execute("t1", {});
    expect(calls[0]!.method).toBe("workboard.research.sync");
    expect(calls[0]!.params).toEqual({});
  });
});
