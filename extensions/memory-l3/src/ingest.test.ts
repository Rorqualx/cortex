import { describe, expect, it } from "vitest";
import { IngestBuffer, detectIntentShift } from "./ingest.js";

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

describe("detectIntentShift", () => {
  it("detects 'actually' as intent shift", () => {
    expect(detectIntentShift(userMsg("actually, let's use Postgres instead"))).toBe(true);
  });

  it("detects 'no wait' as intent shift", () => {
    expect(detectIntentShift(userMsg("no wait, that won't work"))).toBe(true);
  });

  it("detects 'scratch that' as intent shift", () => {
    expect(detectIntentShift(userMsg("scratch that, I meant the other file"))).toBe(true);
  });

  it("detects 'different approach' as intent shift", () => {
    expect(detectIntentShift(userMsg("let's try a different approach here"))).toBe(true);
  });

  it("detects 'on second thought' as intent shift", () => {
    expect(detectIntentShift(userMsg("on second thought, maybe not"))).toBe(true);
  });

  it("does not flag normal messages", () => {
    expect(detectIntentShift(userMsg("can you help me with the database?"))).toBe(false);
    expect(detectIntentShift(userMsg("that looks great, ship it"))).toBe(false);
  });

  it("handles array content blocks", () => {
    const msg = {
      role: "user",
      content: [{ type: "text", text: "actually, use the other method" }],
    } as never;
    expect(detectIntentShift(msg)).toBe(true);
  });

  it("returns false for empty content", () => {
    expect(detectIntentShift(userMsg(""))).toBe(false);
  });
});

describe("IngestBuffer intent-shift tracking", () => {
  it("tracks intent-shift messages", () => {
    const buffer = new IngestBuffer();
    buffer.push("s1", userMsg("let's use Redis"));
    buffer.push("s1", userMsg("actually, let's use Postgres instead"));
    expect(buffer.hasIntentShift("s1")).toBe(true);
  });

  it("reports false when no shifts occurred", () => {
    const buffer = new IngestBuffer();
    buffer.push("s1", userMsg("build the API endpoint"));
    buffer.push("s1", userMsg("add tests for it"));
    expect(buffer.hasIntentShift("s1")).toBe(false);
  });

  it("clears intent-shift tracking on drain", () => {
    const buffer = new IngestBuffer();
    buffer.push("s1", userMsg("actually, do it differently"));
    expect(buffer.hasIntentShift("s1")).toBe(true);
    buffer.drain("s1");
    expect(buffer.hasIntentShift("s1")).toBe(false);
  });

  it("tracks per session independently", () => {
    const buffer = new IngestBuffer();
    buffer.push("s1", userMsg("normal message"));
    buffer.push("s2", userMsg("scratch that, redo it"));
    expect(buffer.hasIntentShift("s1")).toBe(false);
    expect(buffer.hasIntentShift("s2")).toBe(true);
  });
});
