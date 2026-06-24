// Covers the shared cron message prefix builder/parser used by the cron runner
// (write) and gateway title/preview derivation (read).
import { describe, expect, it } from "vitest";
import { buildCronMessagePrefix, parseCronMessagePrefix } from "./cron-message-prefix.js";

describe("cron-message-prefix", () => {
  it("builds the canonical prefix token", () => {
    expect(buildCronMessagePrefix({ id: "abc-123", name: "Daily Scan" })).toBe(
      "[cron:abc-123 Daily Scan]",
    );
  });

  it("round-trips a built prefix", () => {
    const message = `${buildCronMessagePrefix({ id: "c8c7e0df-1", name: "Morning Briefing" })} do the thing`;
    expect(parseCronMessagePrefix(message)).toStrictEqual({
      name: "Morning Briefing",
      body: "do the thing",
    });
  });

  it("extracts a multi-word emoji job name and the body", () => {
    const parsed = parseCronMessagePrefix(
      "[cron:9d1cec60-4db3-4c7c-a0da-447b7bcf26ce 🦦 Chief of Staff — Morning Briefing] ## heading\nmore",
    );
    expect(parsed?.name).toBe("🦦 Chief of Staff — Morning Briefing");
    expect(parsed?.body).toBe("## heading\nmore");
  });

  it("returns null when there is no cron prefix", () => {
    expect(parseCronMessagePrefix("just a normal message")).toBeNull();
    expect(parseCronMessagePrefix("[notcron:1 x] hi")).toBeNull();
  });

  it("handles an empty job name", () => {
    // No space between id and `]` means no name group; treated as no prefix.
    expect(parseCronMessagePrefix("[cron:only-id] body")).toBeNull();
  });
});
