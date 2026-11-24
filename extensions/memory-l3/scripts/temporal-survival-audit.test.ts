import { describe, expect, it } from "vitest";
import {
  countTemporalExpressions,
  extractAnchors,
  extractAspectForms,
  messageText,
  partitionFactsByOperatorOutput,
  postHaystack,
} from "./temporal-survival-audit.mjs";

// QW2 (2026-11-24): regression-lock the temporal-survival-audit's exported
// pure helpers — the abstraction-path slice (partitionFactsByOperatorOutput),
// the paper's occurrence-level expression-count check
// (countTemporalExpressions), and the pre-existing extraction helpers the new
// slices ride on. The CLI body is guarded by an isMainModule check, so
// importing the module must not open the store or exit.

describe("extractAnchors", () => {
  it("collects distinct anchors per category and masks overlaps", () => {
    const anchors = extractAnchors(
      "Deploy on 2026-11-24 at 09:30, revisit 2026-11-24, see 11/25/26 notes",
    );
    expect(anchors.get("iso-date")).toEqual(new Set(["2026-11-24"]));
    // 11/25/26 is a slash date; the standalone "at 09:30" clock time (not
    // inside the ISO timestamp) is its own clock-time anchor.
    expect(anchors.get("slash-date")).toEqual(new Set(["11/25/26"]));
    expect(anchors.get("clock-time")).toEqual(new Set(["09:30"]));
  });
});

describe("countTemporalExpressions (QW2: paper's pre/post expression-count check)", () => {
  it("counts occurrences, not distinct anchors — repeats read as density", () => {
    const counts = countTemporalExpressions(
      "shipped 2026-11-24, verified 2026-11-24, filed 2026-11-25",
    );
    expect(counts.total).toBe(3);
    expect(counts.perCategory.get("iso-date")).toBe(3);
  });

  it("masks clock times inside ISO timestamps (no double counting)", () => {
    const counts = countTemporalExpressions("event at 2026-11-24T09:30 plus 10:15");
    expect(counts.perCategory.get("iso-date")).toBe(1);
    expect(counts.perCategory.get("clock-time")).toBe(1);
    expect(counts.total).toBe(2);
  });

  it("returns zeros for text without temporal expressions", () => {
    const counts = countTemporalExpressions("no dates here at all");
    expect(counts.total).toBe(0);
  });
});

describe("partitionFactsByOperatorOutput (QW2: gist-abstraction slice)", () => {
  it("partitions persisted facts by merged:/abstract: reasoning markers", () => {
    const frontmatter = JSON.stringify({
      facts: [
        { text: "plain fact mentioning 2026-11-24", reasoning: "src:l1" },
        { text: "merged fact mentioning 2026-11-24 and 2026-12-01", reasoning: "merged:3" },
        { text: "abstract summary with 09:30", reasoning: "abstract:2" },
        { text: "another plain fact", reasoning: "" },
      ],
    });
    const slices = partitionFactsByOperatorOutput(frontmatter);
    expect(slices.plain).toContain("plain fact mentioning 2026-11-24");
    expect(slices.plain).not.toContain("merged fact");
    expect(slices.merged).toContain("merged fact mentioning 2026-11-24 and 2026-12-01");
    expect(slices.merged).toContain("merged:3");
    expect(slices.abstract).toContain("abstract summary with 09:30");
    expect(slices.abstract).toContain("abstract:2");
  });

  it("routes facts with no reasoning to plain", () => {
    const slices = partitionFactsByOperatorOutput(
      JSON.stringify({ facts: [{ text: "bare fact" }] }),
    );
    expect(slices.plain).toContain("bare fact");
    expect(slices.merged).toBe("");
    expect(slices.abstract).toBe("");
  });

  it("tolerates malformed frontmatter JSON", () => {
    const slices = partitionFactsByOperatorOutput("not json{");
    expect(slices.plain).toBe("");
    expect(slices.merged).toBe("");
    expect(slices.abstract).toBe("");
  });

  it("operator survival slice: anchors carried by merged output only", () => {
    // End-to-end shape of the QW2 slice: pre anchors that survived ONLY into
    // the merged partition must be absent from plain and vice versa.
    const frontmatter = JSON.stringify({
      facts: [
        { text: "user flies out 2026-12-15", reasoning: "merged:2" },
        { text: "unrelated plain fact", reasoning: "" },
      ],
    });
    const anchors = [...extractAnchors("user flies out 2026-12-15").values()].flatMap((s) => [
      ...s,
    ]);
    const slices = partitionFactsByOperatorOutput(frontmatter);
    expect(anchors).toContain("2026-12-15");
    expect(slices.merged.includes("2026-12-15")).toBe(true);
    expect(slices.plain.includes("2026-12-15")).toBe(false);
  });
});

describe("extractAspectForms", () => {
  it("pairs progressive on the participle and lowercases markers", () => {
    const forms = extractAspectForms("Joe is migrating the DB and Used To run cron at 06:00");
    expect(forms.get("progressive")).toEqual(new Set(["migrating"]));
    expect(forms.get("expired")).toEqual(new Set(["used to"]));
  });
});

describe("messageText / postHaystack (pre-existing helpers stay stable)", () => {
  it("flattens role + string content and content blocks", () => {
    expect(messageText({ role: "user", content: "hello" })).toBe("user\nhello");
    expect(messageText({ role: "assistant", content: [{ type: "text", text: "a" }, "b"] })).toBe(
      "assistant\na\nb",
    );
  });

  it("concatenates fact text+reasoning, typed fields, and body", () => {
    const post = postHaystack(
      JSON.stringify({
        facts: [{ text: "fact text", reasoning: "merged:2" }],
        typedFacts: [{ slot: "ip", value: "192.168.50.128" }],
      }),
      "body text",
    );
    expect(post).toContain("fact text");
    expect(post).toContain("merged:2");
    expect(post).toContain("192.168.50.128");
    expect(post).toContain("body text");
  });
});
