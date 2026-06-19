import { describe, expect, it } from "vitest";
import { createHierarchicalL3Engine } from "./src/engine.js";

describe("memory-l3 engine factory", () => {
  it("returns a ContextEngine with the memory-l3 info id", () => {
    const engine = createHierarchicalL3Engine({});
    // Canonical id matches the registerContextEngine("memory-l3") slot key.
    expect(engine.info.id).toBe("memory-l3");
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

describe("afterTurn buffer-threshold trigger", () => {
  it("invokes the caller when the buffered token count crosses the threshold", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { Storage } = await import("./src/storage.js");
    const { HierarchicalL3Engine } = await import("./src/engine.js");

    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-afterturn-"));
    try {
      const storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
      const callerCalls: number = 0;
      let capturedCalls = callerCalls;
      const stub = async () => {
        capturedCalls += 1;
        return JSON.stringify({ facts: [] });
      };
      const engine = new HierarchicalL3Engine(storage, { caller: stub });
      await engine.bootstrap();

      const fatMessage = { role: "user", content: "x".repeat(20000) } as never;
      await engine.ingest({ sessionId: "s1", message: fatMessage });
      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/x",
        messages: [],
        prePromptMessageCount: 0,
      } as never);
      expect(capturedCalls).toBe(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("is a no-op when buffered tokens are below the threshold", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { Storage } = await import("./src/storage.js");
    const { HierarchicalL3Engine } = await import("./src/engine.js");

    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-afterturn-noop-"));
    try {
      const storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
      let calls = 0;
      const stub = async () => {
        calls += 1;
        return JSON.stringify({ facts: [] });
      };
      const engine = new HierarchicalL3Engine(storage, { caller: stub });
      await engine.bootstrap();
      await engine.ingest({ sessionId: "s1", message: { role: "user", content: "tiny" } as never });
      await engine.afterTurn({
        sessionId: "s1",
        sessionFile: "/tmp/x",
        messages: [],
        prePromptMessageCount: 0,
      } as never);
      expect(calls).toBe(0);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
