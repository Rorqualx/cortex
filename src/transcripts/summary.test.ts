/**
 * Summary type tests including embedding field validation
 */

import { describe, expect, it } from "vitest";
import type { TranscriptsSummary } from "./summary.js";

describe("TranscriptsSummary", () => {
  it("accepts summary without embedding fields", () => {
    const summary: TranscriptsSummary = {
      sessionId: "test-session",
      title: "Test Session",
      generatedAt: "2024-01-01T00:00:00Z",
      overview: "Test overview",
      transcript: ["User: Hello", "Agent: Hi"],
      decisions: [],
      actionItems: [],
      risks: [],
      utteranceCount: 2,
    };
    expect(summary.sessionId).toBe("test-session");
    expect(summary.embedding).toBeUndefined();
  });

  it("accepts summary with embedding fields", () => {
    const embedding = [0.1, 0.2, 0.3];
    const summary: TranscriptsSummary = {
      sessionId: "test-session",
      title: "Test Session",
      generatedAt: "2024-01-01T00:00:00Z",
      overview: "Test overview",
      transcript: ["User: Hello", "Agent: Hi"],
      decisions: [],
      actionItems: [],
      risks: [],
      utteranceCount: 2,
      embedding,
      embeddingModel: "text-embedding-3-small",
      embeddingAt: "2024-01-01T00:01:00Z",
    };
    expect(summary.embedding).toEqual(embedding);
    expect(summary.embeddingModel).toBe("text-embedding-3-small");
    expect(summary.embeddingAt).toBe("2024-01-01T00:01:00Z");
  });
});
