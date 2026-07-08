import { describe, expect, it } from "vitest";
import {
  isKnownInternalHookEvent,
  isKnownInternalHookEventKey,
  KNOWN_INTERNAL_HOOK_EVENT_KEYS,
  KNOWN_INTERNAL_HOOK_EVENTS,
} from "./internal-hook-types.js";

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

describe("isKnownInternalHookEventKey", () => {
  it("accepts every emitted type:action key", () => {
    for (const key of KNOWN_INTERNAL_HOOK_EVENT_KEYS) {
      expect(isKnownInternalHookEventKey(key), key).toBe(true);
    }
  });

  it("accepts bare family keys that subscribe to every action", () => {
    for (const family of ["command", "session", "agent", "gateway", "message"]) {
      expect(isKnownInternalHookEventKey(family), family).toBe(true);
    }
  });

  it("rejects typos, bare actions, and unknown families", () => {
    for (const key of [
      "command:nwe",
      "message:recieved",
      "startup", // bare action without its family
      "gateway:started",
      "session:compact", // partial multi-segment action
      "webhook:received",
      "",
      "COMMAND:NEW",
    ]) {
      expect(isKnownInternalHookEventKey(key), key).toBe(false);
    }
  });
});
