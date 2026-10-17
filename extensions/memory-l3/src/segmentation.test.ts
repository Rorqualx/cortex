import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { buildMessageChunks, deriveWindowActor } from "./segmentation.js";

const msg = (role: string | undefined, text: string): AgentMessage =>
  ({ role, content: text }) as unknown as AgentMessage;

const provider = {
  embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
} as unknown as Parameters<typeof buildMessageChunks>[0]["embeddingProvider"];

describe("deriveWindowActor (QW3 2026-10-15 actor/channel facets)", () => {
  it("returns the uniform role when every message shares one", () => {
    expect(deriveWindowActor([msg("user", "a"), msg("user", "b")])).toBe("user");
    expect(deriveWindowActor([msg("assistant", "a")])).toBe("assistant");
  });

  it("returns mixed when several roles contribute", () => {
    expect(deriveWindowActor([msg("user", "a"), msg("assistant", "b")])).toBe("mixed");
    expect(deriveWindowActor([msg("user", "a"), msg("assistant", "b"), msg("user", "c")])).toBe(
      "mixed",
    );
  });

  it("returns null when no message carries role metadata (NULL-safe)", () => {
    expect(deriveWindowActor([msg(undefined, "a"), msg(undefined, "b")])).toBeNull();
    expect(deriveWindowActor([])).toBeNull();
  });

  it("ignores role-less messages when a later message carries a role", () => {
    expect(deriveWindowActor([msg(undefined, "a"), msg("user", "b")])).toBe("user");
  });
});

describe("buildMessageChunks facet stamping", () => {
  it("stamps actor per window and channel when provided (null otherwise)", async () => {
    const messages = [msg("user", "one"), msg("user", "two"), msg("assistant", "three")];
    // windowSize 2, overlap 1 → windows [0,2) user, [1,3) mixed, [2,3) assistant.
    const chunks = await buildMessageChunks({
      messages,
      embeddingProvider: provider,
      chunkId: "c1",
      now: 42,
      windowSize: 2,
      overlap: 1,
      channel: "telegram",
    });
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.actor)).toEqual(["user", "mixed", "assistant"]);
    expect(chunks.every((c) => c.channel === "telegram")).toBe(true);

    const noChannel = await buildMessageChunks({
      messages,
      embeddingProvider: provider,
      chunkId: "c2",
      now: 42,
      windowSize: 2,
      overlap: 1,
    });
    expect(noChannel.every((c) => c.channel === null)).toBe(true);
  });

  it("leaves actor null when the source messages carry no roles", async () => {
    const chunks = await buildMessageChunks({
      messages: [msg(undefined, "one"), msg(undefined, "two")],
      embeddingProvider: provider,
      chunkId: "c3",
      now: 42,
      windowSize: 2,
      overlap: 0,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.actor).toBeNull();
  });
});
