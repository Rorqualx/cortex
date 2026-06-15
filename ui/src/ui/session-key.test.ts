// Control UI tests cover session-key canonicalization used by chat-event matching.
import { describe, expect, it } from "vitest";
import { areUiSessionKeysEquivalent, canonicalizeBareUiSessionKey } from "./session-key.ts";

describe("canonicalizeBareUiSessionKey", () => {
  it("maps a bare/raw selected key to the gateway's agent-scoped form", () => {
    // The `?session=foo` deep link stores "foo"; the gateway broadcasts "agent:main:foo".
    expect(canonicalizeBareUiSessionKey("foo", "main")).toBe("agent:main:foo");
    expect(canonicalizeBareUiSessionKey("foo", "other")).toBe("agent:other:foo");
  });

  it("makes a raw selected key equivalent to the agent-scoped broadcast key", () => {
    const broadcastKey = "agent:main:foo";
    expect(areUiSessionKeysEquivalent(broadcastKey, "foo")).toBe(false);
    expect(
      areUiSessionKeysEquivalent(broadcastKey, canonicalizeBareUiSessionKey("foo", "main")),
    ).toBe(true);
  });

  it("does not cross agents: a bare key canonicalizes only under the given default agent", () => {
    expect(
      areUiSessionKeysEquivalent("agent:other:foo", canonicalizeBareUiSessionKey("foo", "main")),
    ).toBe(false);
  });

  it("leaves already-agent-scoped keys unchanged", () => {
    expect(canonicalizeBareUiSessionKey("agent:main:foo", "main")).toBe("agent:main:foo");
    expect(canonicalizeBareUiSessionKey("agent:other:bar", "main")).toBe("agent:other:bar");
  });

  it("leaves the global scope and empty keys unchanged", () => {
    expect(canonicalizeBareUiSessionKey("global", "main")).toBe("global");
    expect(canonicalizeBareUiSessionKey("", "main")).toBe("");
    expect(canonicalizeBareUiSessionKey(undefined, "main")).toBe("");
  });

  it("normalizes the default agent id", () => {
    expect(canonicalizeBareUiSessionKey("foo", "My Agent")).toBe("agent:my-agent:foo");
  });
});
