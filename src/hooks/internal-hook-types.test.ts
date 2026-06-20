import { describe, expect, it } from "vitest";
import { isKnownInternalHookEvent, KNOWN_INTERNAL_HOOK_EVENTS } from "./internal-hook-types.js";

describe("isKnownInternalHookEvent", () => {
  it("accepts the bare event types and every emitted type:action key", () => {
    for (const event of [
      "command",
      "session",
      "agent",
      "gateway",
      "message",
      "command:new",
      "command:reset",
      "command:stop",
      "session:patch",
      "session:compact:before",
      "session:compact:after",
      "agent:bootstrap",
      "gateway:startup",
      "gateway:shutdown",
      "gateway:pre-restart",
      "message:received",
      "message:transcribed",
      "message:preprocessed",
      "message:sent",
    ]) {
      expect(isKnownInternalHookEvent(event)).toBe(true);
    }
  });

  it("rejects events no dispatch site emits (typos that would fail silently)", () => {
    // command:exec and agent:compaction look plausible but are never emitted.
    for (const event of ["command:exec", "agent:compaction", "session:foo", "bogus", ""]) {
      expect(isKnownInternalHookEvent(event)).toBe(false);
    }
  });

  it("registry stays a closed contract synced with dispatch sites", () => {
    expect(KNOWN_INTERNAL_HOOK_EVENTS.size).toBe(19);
  });
});
