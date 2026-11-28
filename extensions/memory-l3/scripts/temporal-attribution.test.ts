import { describe, expect, it } from "vitest";
import {
  AMBIENT_NOISE_ROLES,
  attributionForLostAnchor,
  denoisedTextFromLines,
  isAmbientNoiseRecord,
  parseSince,
  V18_LANDED_AT,
} from "./temporal-attribution.mjs";

// Temporal-loss attribution helpers (QW-A, 2026-11-28): pure building blocks
// for the v18+ slice + de-noised pre side + lost-anchor classification in
// temporal-survival-audit.mjs. No store access — classification semantics
// are the contract under test.

describe("isAmbientNoiseRecord", () => {
  it("flags tool-output and system roles", () => {
    expect(isAmbientNoiseRecord({ role: "toolResult", content: "ok 09:30" })).toBe(true);
    expect(isAmbientNoiseRecord({ role: "tool", content: "ok" })).toBe(true);
    expect(isAmbientNoiseRecord({ role: "system", content: "ok" })).toBe(true);
  });

  it("flags openclaw runtime-context injections but not plain custom roles", () => {
    expect(
      isAmbientNoiseRecord({
        role: "custom",
        customType: "openclaw.runtime-context",
        content: "[x]",
      }),
    ).toBe(true);
    expect(
      isAmbientNoiseRecord({ role: "custom", customType: "user.template", content: "[x]" }),
    ).toBe(false);
    expect(isAmbientNoiseRecord({ role: "custom", content: "hello" })).toBe(false);
  });

  it("keeps user and assistant records", () => {
    expect(isAmbientNoiseRecord({ role: "user", content: "meet 2026-11-28" })).toBe(false);
    expect(isAmbientNoiseRecord({ role: "assistant", content: "noted" })).toBe(false);
  });

  it("treats null/non-object records as noise", () => {
    expect(isAmbientNoiseRecord(null)).toBe(true);
    expect(isAmbientNoiseRecord(undefined)).toBe(true);
    expect(isAmbientNoiseRecord("text")).toBe(true);
  });

  it("exposes the ambient role set", () => {
    expect(AMBIENT_NOISE_ROLES.has("toolResult")).toBe(true);
    expect(AMBIENT_NOISE_ROLES.has("system")).toBe(true);
    expect(AMBIENT_NOISE_ROLES.has("user")).toBe(false);
  });
});

describe("denoisedTextFromLines", () => {
  it("drops noise records and keeps prose from text blocks", () => {
    const lines = [
      JSON.stringify({ role: "user", content: [{ type: "text", text: "flight on 2026-11-30" }] }),
      JSON.stringify({
        role: "toolResult",
        content: [{ type: "text", text: "uptime since 04:15" }],
      }),
      JSON.stringify({ role: "custom", customType: "openclaw.runtime-context", content: "[Tue]" }),
      JSON.stringify({ role: "assistant", content: "arriving 09:45" }),
    ];
    const text = denoisedTextFromLines(lines);
    expect(text).toContain("flight on 2026-11-30");
    expect(text).toContain("arriving 09:45");
    expect(text).not.toContain("uptime since 04:15");
    expect(text).not.toContain("[Tue]");
  });

  it("keeps string content and excludes non-text blocks", () => {
    const lines = [
      JSON.stringify({ role: "user", content: "plain string 2026/06/01" }),
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "thinking", text: "internal 03:00" },
          { type: "toolCall", text: "run --at 05:00" },
          { type: "text", text: "visible 06:00" },
        ],
      }),
    ];
    const text = denoisedTextFromLines(lines);
    expect(text).toContain("plain string 2026/06/01");
    expect(text).toContain("visible 06:00");
    expect(text).not.toContain("internal 03:00");
    expect(text).not.toContain("run --at 05:00");
  });

  it("skips blank and malformed lines without throwing", () => {
    expect(denoisedTextFromLines(["", "   ", "{not json"])).toBe("");
  });

  it("returns empty string for no input", () => {
    expect(denoisedTextFromLines([])).toBe("");
  });
});

describe("parseSince", () => {
  it("defaults to the v18 landing timestamp", () => {
    expect(parseSince(null)).toBe(Date.parse(V18_LANDED_AT));
    expect(parseSince(undefined)).toBe(Date.parse("2026-08-16T12:37:40Z"));
  });

  it("disables the slice on 0 or all", () => {
    expect(parseSince("0")).toBe(0);
    expect(parseSince("all")).toBe(0);
  });

  it("accepts epoch-ms and ISO strings", () => {
    expect(parseSince("1755347860000")).toBe(1755347860000);
    expect(parseSince("2026-09-01T00:00:00Z")).toBe(Date.parse("2026-09-01T00:00:00Z"));
  });

  it("returns null on unparseable values", () => {
    expect(parseSince("not-a-date")).toBe(null);
  });
});

describe("attributionForLostAnchor", () => {
  const owner = 1_000;

  it("classifies retained-earlier when an earlier chunk contains the anchor", () => {
    expect(attributionForLostAnchor(owner, [100, 200, 5_000])).toBe("retained-earlier");
    expect(attributionForLostAnchor(owner, [100])).toBe("retained-earlier");
  });

  it("classifies retained-later when only later chunks contain it", () => {
    expect(attributionForLostAnchor(owner, [2_000])).toBe("retained-later");
    expect(attributionForLostAnchor(owner, [2_000, 3_000])).toBe("retained-later");
  });

  it("classifies extraction-lost when no other chunk contains it", () => {
    expect(attributionForLostAnchor(owner, [])).toBe("extraction-lost");
  });

  it("treats missing arrays as no other chunks", () => {
    expect(attributionForLostAnchor(owner, undefined)).toBe("extraction-lost");
  });
});
