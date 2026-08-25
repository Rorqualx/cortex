import { describe, expect, it } from "vitest";
// QW4 (2026-08-25, arXiv:2608.15008): regime-aware retrieval breadth through
// the memory-core seam. The mapping and cache-breadth contract are unit-tested
// here; the runtime derivation (tool-loop tail detection) is covered in
// src/agents/embedded-agent-runner/tool-result-context-guard.test.ts.
import { resolveAssembleTopK } from "./engine.js";

describe("resolveAssembleTopK", () => {
  it("narrows recall for the mid-tool-loop regime", () => {
    expect(resolveAssembleTopK("narrow")).toBeLessThan(resolveAssembleTopK("full"));
    expect(resolveAssembleTopK("narrow")).toBeGreaterThan(0);
  });

  it("keeps full recall for the default/initial regime", () => {
    expect(resolveAssembleTopK("full")).toBe(5);
    // Explicit full matches the historical constant (ASSEMBLE_TOP_K = 5).
    expect(resolveAssembleTopK("full")).toBe(resolveAssembleTopK(undefined));
  });

  it("treats undefined breadth as full for backward compatibility", () => {
    expect(resolveAssembleTopK(undefined)).toBe(5);
  });
});
