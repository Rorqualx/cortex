/**
 * ARCH-1 (a78e8033) — deterministic prose distillation lane (permanent suite).
 *
 * Manifest: lab/2026-09-20_a78e8033.md §A (cases 1–15) + A1 amendment #18
 * (lab/2026-09-21_a78e8033.md R2). Cases 16–17 live in compression.test.ts
 * (name-anchored additions); flag-off parity is proven by the sibling suites
 * running unmodified.
 */
import { describe, expect, it } from "vitest";
import { isProseContent, routeAndCompress } from "./content-router.js";
import { danglingReferenceStats } from "./dangling-metric.js";
import { resolveCompressionConfig } from "./index.js";
import { compressProseOutput, segmentBlocks } from "./prose-compressor.js";
import { DEFAULT_COMPRESSION_CONFIG } from "./types.js";
import { extractVerbatimSpans } from "./verbatim-guard.js";

const para = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `Sentence number ${i + 1} in this paragraph about the system and its behaviour overall.`,
  ).join(" ");

const proseOn = () =>
  resolveCompressionConfig({
    enabledTypes: { ...DEFAULT_COMPRESSION_CONFIG.enabledTypes, prose: true },
  });

describe("isProseContent — 10-shape corpus", () => {
  const corpus: Array<{ name: string; content: string; expect: boolean }> = [
    {
      name: "long-form markdown doc",
      expect: true,
      content: `# Guide\n\n${para(4)}\n\n## Setup\n\n${para(3)}\n\n## Next\n\n${para(3)}`,
    },
    {
      name: "web article (web_fetch output)",
      expect: true,
      content: `# Page Title\n\n${para(3)}\n\n## Section A\n\n${para(3)}\n\n## Section B\n\n${para(3)}`,
    },
    {
      name: "README-style",
      expect: true,
      content: `# Project\n\n${para(3)}\n\n## Install\n\n\`\`\`bash\nnpm install project\n\`\`\`\n\n## Usage\n\n${para(2)}`,
    },
    {
      name: "changelog",
      expect: true,
      content:
        "# Changelog\n\n## 1.2.0\n\n- fixed the ingestion loop that dropped messages on retry\n- added the metrics endpoint under /metrics\n\n## 1.1.0\n\n- initial stable release with sqlite storage backend",
    },
    {
      name: "blog post",
      expect: true,
      content: `## On Compression\n\n${para(4)}\n\n${para(3)}\n\n## Takeaway\n\n${para(2)}`,
    },
    {
      name: "docs page",
      expect: true,
      content:
        "# API Reference\n\n" +
        para(3) +
        '\n\n## GET /items\n\nReturns the collection of items with pagination metadata.\n\n```json\n{"items": []}\n```\n\n## POST /items\n\n' +
        para(2),
    },
    { name: "essay", expect: true, content: `${para(4)}\n\n${para(4)}\n\n${para(4)}` },
    {
      name: "technical explanation",
      expect: true,
      content: `# How It Works\n\n${para(4)}\n\nThe system was deployed on 2026-08-14 across three regions with staged rollout.\n\n${para(3)}`,
    },
    // Pinned known misses (heading-less shapes; tuning deferred — lab 09-20).
    {
      name: "man-page-style (pinned miss)",
      expect: false,
      content: `NAME\n\n${para(2)}\n\nSYNOPSIS\n\n${para(2)}\n\nDESCRIPTION\n\n${para(4)}`,
    },
    {
      name: "prose email (pinned miss)",
      expect: false,
      content: `Hi team,\n\n${para(4)}\n\n${para(3)}\n\nBest regards,\n\nThe sender`,
    },
  ];

  it("labels ≥8/10 corpus shapes correctly; exact labels pin the two known misses", () => {
    let correct = 0;
    const misses: string[] = [];
    for (const shape of corpus) {
      const got = isProseContent(shape.content);
      if (got === shape.expect) {
        correct++;
      } else {
        misses.push(`${shape.name}: expected ${shape.expect}, got ${got}`);
      }
    }
    // Pin exact per-shape labels so drift in either direction is visible.
    expect(misses).toEqual([]);
    expect(correct).toBeGreaterThanOrEqual(8);
  });

  it("negative guards refuse explicitly: CSV, YAML frontmatter, table-dominant", () => {
    const csv = Array.from(
      { length: 12 },
      (_, i) => `row${i},value${i},2026-01-0${(i % 9) + 1},label${i}`,
    ).join("\n");
    const yaml = `---\ntitle: Some Document\nauthor: Someone\ndate: 2026-09-01\n---\n\n${para(4)}`;
    const table =
      "| col a | col b | col c |\n|---|---|---|\n| r1c1 | r1c2 | r1c3 |\n| r2c1 | r2c2 | r2c3 |\n| r3c1 | r3c2 | r3c3 |";
    expect(isProseContent(csv)).toBe(false);
    expect(isProseContent(yaml)).toBe(false);
    expect(isProseContent(table)).toBe(false);
  });
});

describe("compressProseOutput — structure preservation", () => {
  const longDoc = [
    "# Title",
    para(4),
    "## Alpha",
    para(4),
    para(4),
    "On 2026-09-01 the migration finished and the old tables were dropped.",
    "## Beta",
    "```ts\nconst x = compute();\nconst y = computeAgain(x);\n```",
    para(4),
    para(4),
    para(4),
    para(4),
  ].join("\n\n");

  it("keeps ALL headings verbatim", () => {
    const out = compressProseOutput(longDoc, 0.3);
    expect(out.content).toContain("# Title");
    expect(out.content).toContain("## Alpha");
    expect(out.content).toContain("## Beta");
    expect(out.compressed).toBe(true);
  });

  it("keeps fenced code verbatim; fences with internal blank lines stay atomic", () => {
    const out = compressProseOutput(longDoc, 0.3);
    expect(out.content).toContain("const x = compute();");
    expect(out.content).toContain("const y = computeAgain(x);");
    const doc = `# T\n\n\`\`\`js\nconst a = 1;\n\nconst b = 2;\n\`\`\`\n\n${para(4)}`;
    const blocks = segmentBlocks(doc);
    const codeBlocks = blocks.filter((b) => b.kind === "code");
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0]?.text).toContain("const a = 1;");
    expect(codeBlocks[0]?.text).toContain("const b = 2;");
  });

  it("keeps temporally-anchored paragraphs (dated lines survive)", () => {
    const out = compressProseOutput(longDoc, 0.3);
    expect(out.content).toContain("On 2026-09-01 the migration finished");
  });

  it("lists always kept head-truncated: first item + '[+N more items]'", () => {
    const withList = [
      "# Doc",
      ["- first item in the list of changes", "- second item", "- third item"].join("\n"),
      ...Array.from({ length: 8 }, () => para(3)),
    ].join("\n\n");
    const out = compressProseOutput(withList, 0.3);
    expect(out.content).toContain("- first item in the list of changes");
    expect(out.content).toMatch(/\[\+\d+ more items\]/);
  });

  it("is deterministic: same input twice ⇒ byte-identical", () => {
    const a = compressProseOutput(longDoc, 0.3);
    const b = compressProseOutput(longDoc, 0.3);
    expect(a.content).toBe(b.content);
    expect(a.charsAfter).toBe(b.charsAfter);
  });

  it("emits the distillation summary line", () => {
    const out = compressProseOutput(longDoc, 0.3);
    expect(out.content).toContain("— prose distilled: kept");
  });

  it("short-doc fast path: compressed=false when nothing droppable", () => {
    const short = `# Small\n\n${para(1)}`;
    const out = compressProseOutput(short, 0.9);
    expect(out.compressed).toBe(false);
    expect(out.content).toBe(short);
  });
});

describe("ratio budget semantics (floor is a BUDGET floor, not output floor)", () => {
  const longDoc = [
    "# Title",
    para(4),
    "## Alpha",
    para(4),
    para(4),
    "On 2026-09-01 the migration finished and the old tables were dropped.",
    "## Beta",
    "```ts\nconst x = compute();\nconst y = computeAgain(x);\n```",
    para(4),
    para(4),
    para(4),
    para(4),
  ].join("\n\n");

  it("@0.1 clamps identical to @0.3 (fixed keep-set ≥ budget)", () => {
    const low = compressProseOutput(longDoc, 0.1);
    const atFloor = compressProseOutput(longDoc, 0.3);
    expect(low.content).toBe(atFloor.content);
  });

  it("@0.8 ⇒ achieved ratio ≥ 0.8", () => {
    const out = compressProseOutput(longDoc, 0.8);
    expect(out.compressed).toBe(true);
    expect(out.charsAfter / out.charsBefore).toBeGreaterThanOrEqual(0.8);
  });

  it("heading/code-dense doc (README stand-in) achieves ~0.94 — never under-keeps", () => {
    const dense = [
      "# Dense Project",
      para(2),
      "## One",
      "```bash\nnpm install dense\n```",
      "## Two",
      para(2), // the only droppable middle paragraph
      "## Three",
      '```json\n{"items": []}\n```',
      "## Four",
      para(2),
    ].join("\n\n");
    const out = compressProseOutput(dense, 0.3);
    const achieved = out.charsAfter / out.charsBefore;
    expect(achieved).toBeGreaterThanOrEqual(0.8);
    expect(out.content).toContain("## Four");
  });

  it("list-dominant doc undershoots floor (~0.18 band) — intended, pinned", () => {
    const bigList = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `- list entry number ${i + 1} with some detail text`,
      ).join("\n");
    const listDoc = [
      "# Doc",
      para(1),
      ...Array.from({ length: 8 }, () => bigList(12)),
      para(1),
    ].join("\n\n");
    const out = compressProseOutput(listDoc, 0.3);
    expect(out.compressed).toBe(true);
    const achieved = out.charsAfter / out.charsBefore;
    expect(achieved).toBeLessThan(0.3);
    expect(achieved).toBeGreaterThan(0.05);
  });
});

describe("metric non-interaction", () => {
  const refDoc = [
    "# Release Notes",
    "## Migration Runner",
    "Migration Runner handles schema upgrades safely across regions.",
    para(2),
    para(2),
    "## Cache Invalidator",
    "Cache Invalidator clears stale entries from the primary store.",
    para(2),
  ].join("\n\n");

  it("prose output emits no dangling references (dangling-metric scanner over output)", () => {
    const out = compressProseOutput(refDoc, 0.3);
    expect(out.compressed).toBe(true);
    const stats = danglingReferenceStats(refDoc, out.content);
    expect(stats.referentCount).toBeGreaterThanOrEqual(1);
    expect(stats.danglingCount).toBe(0);
    expect(stats.rate).toBe(0);
  });

  it("verbatim-guard passes over prose output (headings/code regions intact)", () => {
    const code =
      '```ts\nconst conf = readFileSync("/etc/app/settings.conf");\nconst ioctlCode = 0x40087601;\n```';
    const doc = ["# Title", para(4), "## Code", code, para(4), para(4), para(4)].join("\n\n");
    const out = compressProseOutput(doc, 0.3);
    const src = `# Title\n## Code\n${code}`;
    const spans = extractVerbatimSpans(src);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(out.content).toContain(span);
    }
  });
});

describe("ratio composition (A1 — external overrides win)", () => {
  it("ratioOverride overrides prose targetRatio (external protect wins: ratioOverride 0.8 ⇒ achieved ≥ 0.8)", () => {
    const cfg = proseOn(); // entropy OFF, global targetRatio 0.3
    const doc = ["# Page", ...Array.from({ length: 8 }, () => para(4))].join("\n\n");
    const out = routeAndCompress(doc, cfg, 0.8);
    expect(out.contentType).toBe("prose");
    expect(out.compressed).toBe(true);
    expect(out.charsAfter / out.charsBefore).toBeGreaterThanOrEqual(0.8);
  });
});
