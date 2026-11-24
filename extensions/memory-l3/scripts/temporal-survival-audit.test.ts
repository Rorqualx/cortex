import { describe, expect, it } from "vitest";
import {
  countOrderInversions,
  countTemporalExpressions,
  extractAnchors,
  extractAspectForms,
  extractLossForms,
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

// QW1 order-fidelity pass (2026-11-22, arXiv:2609.36457): pure unit tests
// over the within-chunk anchor-pair comparison — preserved order, inversions,
// non-surviving anchors excluded from pairs, and the O(n²) cap.

const PRE = "left on 2026-11-02 then again on 12/04/2026 at 9:30 finally 2026-11-20";

describe("countOrderInversions", () => {
  it("reports zero inversions when post preserves pre order", () => {
    const post = "remembered: 2026-11-02 first; then 12/04/2026; 9:30 after that; 2026-11-20 last.";
    const anchors = ["2026-11-02", "12/04/2026", "9:30", "2026-11-20"];
    expect(countOrderInversions(anchors, PRE, post)).toEqual({ pairs: 6, inversions: 0 });
  });

  it("counts each flipped pair", () => {
    // Post reverses the first two anchors AND the last two: (1,2) and (3,4) flip.
    const post = "later 12/04/2026 before 2026-11-02; then 2026-11-20 before 9:30.";
    const anchors = ["2026-11-02", "12/04/2026", "9:30", "2026-11-20"];
    expect(countOrderInversions(anchors, PRE, post)).toEqual({ pairs: 6, inversions: 2 });
  });

  it("excludes anchors that did not survive from the pair count", () => {
    // Only two anchors survive; their order is preserved.
    const post = "kept 2026-11-02 and 2026-11-20 only.";
    const anchors = ["2026-11-02", "12/04/2026", "9:30", "2026-11-20"];
    expect(countOrderInversions(anchors, PRE, post)).toEqual({ pairs: 1, inversions: 0 });
  });

  it("treats tied post positions (substring anchors) as preserved", () => {
    // "10:00" sits inside "2026-11-22 10:00" at the same post offset — tie.
    const pre = "logged 2026-11-22 10:00 and separately 10:00 sharp";
    const post = "2026-11-22 10:00 survived verbatim";
    const anchors = ["2026-11-22 10:00", "10:00"];
    expect(countOrderInversions(anchors, pre, post)).toEqual({ pairs: 1, inversions: 0 });
  });

  it("caps the pair comparison at 20 anchors", () => {
    // 25 surviving anchors in identical order: cap → exactly C(20,2)=190 pairs.
    const years = Array.from({ length: 25 }, (_, i) => `year-${String(i).padStart(2, "0")}`);
    const pre = years.join(" ");
    const post = years.join(" ");
    expect(countOrderInversions(years, pre, post)).toEqual({ pairs: 190, inversions: 0 });
  });

  it("returns zero pairs when nothing survived", () => {
    expect(countOrderInversions(["2026-11-02"], PRE, "nothing survived")).toEqual({
      pairs: 0,
      inversions: 0,
    });
  });
});

// QW3 loss-taxonomy pass (2026-11-22): quantities (with unit), negation
// markers, entity–attribute bindings — matched-pair survival classes.
describe("extractLossForms", () => {
  it("extracts quantities, negations, and entity bindings", () => {
    const forms = extractLossForms(
      "Huey's disk is 4 TB but is not backed up; waited 250ms and never timed out",
    );
    expect(forms.get("quantity")).toEqual(new Set(["4 tb", "250ms"]));
    expect(forms.get("negation")).toEqual(new Set(["not", "never"]));
    expect(forms.get("entity-binding")).toEqual(new Set(["huey's disk"]));
  });

  it("lowercases forms so case drift alone never counts as loss", () => {
    const forms = extractLossForms("Maria's Laptop");
    expect(forms.get("entity-binding")).toEqual(new Set(["maria's laptop"]));
  });

  it("returns empty sets for text with no loss forms", () => {
    const forms = extractLossForms("plain affirmative sentence");
    expect(forms.get("quantity")).toEqual(new Set());
    expect(forms.get("negation")).toEqual(new Set());
    expect(forms.get("entity-binding")).toEqual(new Set());
  });
});
