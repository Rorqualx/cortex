import { describe, expect, it } from "vitest";
import { IngestBuffer } from "./ingest.js";

const userMsg = (content: string) => ({ role: "user", content }) as never;

describe("IngestBuffer", () => {
  it("starts empty", () => {
    const buffer = new IngestBuffer();
    expect(buffer.size("s1")).toBe(0);
    expect(buffer.tokens("s1")).toBe(0);
    expect(buffer.totalTokens()).toBe(0);
    expect(buffer.sessionIds()).toEqual([]);
  });

  it("push tracks messages and tokens per session", () => {
    const buffer = new IngestBuffer();
    buffer.push("s1", userMsg("alpha"));
    buffer.push("s1", userMsg("beta"));
    buffer.push("s2", userMsg("gamma"));
    expect(buffer.size("s1")).toBe(2);
    expect(buffer.size("s2")).toBe(1);
    expect(buffer.tokens("s1")).toBeGreaterThan(0);
    expect(buffer.tokens("s2")).toBeGreaterThan(0);
    expect(buffer.totalTokens()).toBe(buffer.tokens("s1") + buffer.tokens("s2"));
    expect(buffer.sessionIds().toSorted()).toEqual(["s1", "s2"]);
  });

  it("pushBatch returns ingested count and accumulates tokens", () => {
    const buffer = new IngestBuffer();
    const count = buffer.pushBatch("s1", [userMsg("a"), userMsg("b"), userMsg("c")]);
    expect(count).toBe(3);
    expect(buffer.size("s1")).toBe(3);
  });

  it("peek returns a snapshot of buffered messages without draining", () => {
    const buffer = new IngestBuffer();
    buffer.push("s1", userMsg("a"));
    buffer.push("s1", userMsg("b"));
    const snapshot = buffer.peek("s1");
    expect(snapshot).toHaveLength(2);
    expect(buffer.size("s1")).toBe(2);
  });

  it("drain returns and clears messages for that session only", () => {
    const buffer = new IngestBuffer();
    buffer.push("s1", userMsg("a"));
    buffer.push("s1", userMsg("b"));
    buffer.push("s2", userMsg("c"));
    const drained = buffer.drain("s1");
    expect(drained).toHaveLength(2);
    expect(buffer.size("s1")).toBe(0);
    expect(buffer.tokens("s1")).toBe(0);
    expect(buffer.size("s2")).toBe(1);
  });

  it("stats reports messages and tokens together", () => {
    const buffer = new IngestBuffer();
    buffer.push("s1", userMsg("hello world"));
    const stats = buffer.stats("s1");
    expect(stats.messages).toBe(1);
    expect(stats.tokens).toBeGreaterThan(0);
  });
});
