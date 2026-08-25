import { describe, expect, it } from "vitest";
import { computeTemporalPreservation, extractTemporalExpressions } from "./score-longmemeval.mjs";

describe("extractTemporalExpressions", () => {
  it("extracts ISO dates, month dates, times, and relatives", () => {
    const text = [
      "Meeting on 2026-08-16 at 9:00 AM MT.",
      "Every Tuesday, then again August 25.",
      "The trip was last week; budget review is next month.",
    ].join(" ");
    const exprs = extractTemporalExpressions(text).map((e) => e.toLowerCase());
    expect(exprs).toContain("2026-08-16");
    expect(exprs).toContain("9:00 am");
    expect(exprs).toContain("every tuesday");
    expect(exprs).toContain("august 25");
    expect(exprs).toContain("last week");
    expect(exprs).toContain("next month");
  });

  it("does not double-count overlapping spans (9:00 AM)", () => {
    const exprs = extractTemporalExpressions("Standup is 9:00 AM sharp.");
    // The clock-time pattern claims "9:00 AM"; the bare am/pm pattern must not
    // re-emit "AM" (or "00 AM") over the same span.
    expect(exprs.filter((e) => e.toLowerCase() === "am")).toHaveLength(0);
    expect(exprs).toHaveLength(1);
  });

  it("returns an empty array for text without temporal content", () => {
    expect(extractTemporalExpressions("The router has 4 ports and 2 WAN links.")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(extractTemporalExpressions("Sync at 3PM daily")).toContain("3PM");
  });
});

describe("computeTemporalPreservation", () => {
  it("counts preserved temporal expressions verbatim", () => {
    const answer = "The exam is August 25, 2026 at 2:00 PM.";
    const response = "The exam takes place August 25, 2026, starting 2:00 PM in the gym.";
    expect(computeTemporalPreservation(answer, response)).toEqual({
      preserved: 2,
      total: 2,
    });
  });

  it("counts partial preservation when some anchors are dropped", () => {
    const answer = "Payments run every Tuesday and reset next month.";
    const response = "Payments run every Tuesday.";
    expect(computeTemporalPreservation(answer, response)).toEqual({
      preserved: 1,
      total: 2,
    });
  });

  it("matches case-insensitively across answer and response", () => {
    const answer = "Deadline: 2026-08-16";
    const response = "The deadline is 2026-08-16 (confirmed).";
    expect(computeTemporalPreservation(answer, response)).toEqual({
      preserved: 1,
      total: 1,
    });
  });

  it("returns null when the answer has no temporal expressions", () => {
    expect(computeTemporalPreservation("Paris", "The capital is Paris.")).toBeNull();
  });
});
