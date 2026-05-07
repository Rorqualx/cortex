import { describe, expect, it } from "vitest";
import { createHierarchicalL3Engine } from "./src/engine.js";

describe("memory-l3 engine factory", () => {
  it("returns a ContextEngine with the hierarchical-l3 info id", () => {
    const engine = createHierarchicalL3Engine({});
    expect(engine.info.id).toBe("hierarchical-l3");
    expect(engine.info.name).toBe("Hierarchical Memory (L1/L2/L3)");
    expect(engine.info.ownsCompaction).toBe(false);
  });

  it("ingest acknowledges every message in stage 1 (passthrough stub)", async () => {
    const engine = createHierarchicalL3Engine({});
    const result = await engine.ingest({
      sessionId: "s1",
      message: { role: "user", content: "hi" } as never,
    });
    expect(result.ingested).toBe(true);
  });

  it("assemble returns messages unchanged in stage 1 (passthrough stub)", async () => {
    const engine = createHierarchicalL3Engine({});
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ] as never[];
    const result = await engine.assemble({
      sessionId: "s1",
      messages,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages).not.toBe(messages);
  });

  it("compact refuses to run when the engine has not been bootstrapped", async () => {
    const engine = createHierarchicalL3Engine({});
    const result = await engine.compact({
      sessionId: "s1",
      sessionFile: "/tmp/test.session",
    } as never);
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("not bootstrapped");
  });
});
