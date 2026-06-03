import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrajectoryEvent } from "../trajectory/types.js";
import {
  clusterByCosineAndToolShape,
  cosineSimilarity,
  DEFAULT_COSINE_THRESHOLD,
  DEFAULT_TOOL_SHAPE_OVERLAP_MIN,
  detectEmbeddingRepetitionCandidates,
  extractCaptureSeedText,
  toolShapeOverlap,
} from "./embedding-clusterer.js";

function event(
  type: string,
  data: Record<string, unknown> = {},
  overrides: Partial<TrajectoryEvent> = {},
): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace",
    source: "transcript",
    type,
    ts: "2026-05-20T18:00:00.000Z",
    seq: 1,
    sessionId: "sess",
    data,
    ...overrides,
  };
}

function userMessage(text: string): TrajectoryEvent {
  return event("user.message", {
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function toolCall(name: string): TrajectoryEvent {
  return event("tool.call", { name });
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it("returns 0 for mismatched lengths or empty/zero vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("toolShapeOverlap", () => {
  it("returns 1 for identical tool sets", () => {
    expect(toolShapeOverlap(["a", "b"], ["a", "b"])).toBe(1);
  });
  it("returns 0 for disjoint sets", () => {
    expect(toolShapeOverlap(["a", "b"], ["c", "d"])).toBe(0);
  });
  it("returns Jaccard similarity for partial overlap", () => {
    expect(toolShapeOverlap(["a", "b", "c"], ["a", "b", "d"])).toBeCloseTo(2 / 4, 6);
  });
  it("handles empty sets (both empty: 1, one empty: 0)", () => {
    expect(toolShapeOverlap([], [])).toBe(1);
    expect(toolShapeOverlap(["a"], [])).toBe(0);
  });
});

describe("extractCaptureSeedText", () => {
  it("combines user texts and tool sequence", () => {
    const events = [
      userMessage("debug the failing test"),
      toolCall("read_file"),
      toolCall("grep"),
      userMessage("also check the schema"),
    ];
    const seed = extractCaptureSeedText(events);
    expect(seed).toContain("debug the failing test");
    expect(seed).toContain("also check the schema");
    expect(seed).toContain("Tools: read_file -> grep");
  });
  it("truncates above max chars", () => {
    const longUser = userMessage("x".repeat(5000));
    const seed = extractCaptureSeedText([longUser], 100);
    expect(seed.length).toBe(100);
  });
});

describe("clusterByCosineAndToolShape", () => {
  it("clusters two captures with similar embeddings + tool overlap", () => {
    const items = [
      { captureDir: "/a", toolSequence: ["read", "grep"], embedding: [1, 0, 0] },
      { captureDir: "/b", toolSequence: ["read", "grep"], embedding: [1, 0, 0] },
      { captureDir: "/c", toolSequence: ["write", "edit"], embedding: [0, 1, 0] },
    ];
    const clusters = clusterByCosineAndToolShape(
      items,
      DEFAULT_COSINE_THRESHOLD,
      DEFAULT_TOOL_SHAPE_OVERLAP_MIN,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toHaveLength(2);
    expect(clusters[0].map((c) => c.captureDir)).toEqual(["/a", "/b"]);
  });

  it("does NOT cluster captures with high cosine but disjoint tools (false-positive guard)", () => {
    const items = [
      { captureDir: "/a", toolSequence: ["read"], embedding: [1, 0] },
      { captureDir: "/b", toolSequence: ["write"], embedding: [1, 0] },
    ];
    const clusters = clusterByCosineAndToolShape(items, 0.5, 0.5);
    expect(clusters).toHaveLength(2);
  });

  it("does NOT cluster captures with overlapping tools but low cosine", () => {
    const items = [
      { captureDir: "/a", toolSequence: ["read"], embedding: [1, 0] },
      { captureDir: "/b", toolSequence: ["read"], embedding: [0, 1] },
    ];
    const clusters = clusterByCosineAndToolShape(items, 0.5, 0.5);
    expect(clusters).toHaveLength(2);
  });
});

describe("detectEmbeddingRepetitionCandidates", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-emb-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function writeCapture(name: string, events: TrajectoryEvent[]): Promise<string> {
    const dir = path.join(tmp, name);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "events.jsonl"),
      `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8",
    );
    return dir;
  }

  it("emits one candidate from a 2-capture cluster with mock embed", async () => {
    const a = await writeCapture("a", [
      userMessage("ship a feature"),
      toolCall("read_file"),
      toolCall("edit_file"),
    ]);
    const b = await writeCapture("b", [
      userMessage("ship a feature please"),
      toolCall("read_file"),
      toolCall("edit_file"),
    ]);
    const c = await writeCapture("c", [userMessage("delete a config"), toolCall("write_file")]);

    const report = await detectEmbeddingRepetitionCandidates({
      captureDirs: [a, b, c],
      options: {
        // Returns 3-vector based on first char of seed text: same letter -> same vector.
        embed: async (text) => {
          const firstChar = text.includes("User: ship")
            ? "s"
            : text.includes("User: delete")
              ? "d"
              : "x";
          return firstChar === "s" ? [1, 0, 0] : firstChar === "d" ? [0, 1, 0] : [0, 0, 1];
        },
      },
    });
    expect(report.embeddedCaptures).toBe(3);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].occurrences).toBe(2);
    expect(report.candidates[0].captureDirs).toEqual([a, b]);
    expect(report.candidates[0].toolSequence).toEqual(["read_file", "edit_file"]);
  });

  it("records skipped captures when embed throws", async () => {
    const a = await writeCapture("a", [userMessage("hi"), toolCall("x")]);
    const report = await detectEmbeddingRepetitionCandidates({
      captureDirs: [a],
      options: {
        embed: async () => {
          throw new Error("network down");
        },
      },
    });
    expect(report.embeddedCaptures).toBe(0);
    expect(report.skippedCaptures).toHaveLength(1);
    expect(report.skippedCaptures[0].reason).toMatch(/network down/u);
    expect(report.candidates).toHaveLength(0);
  });
});
