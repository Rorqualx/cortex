/**
 * PROBE (a78e8033) — throwaway feasibility spike for the prose distillation
 * lane. NOT the final test suite (that is the `test` stage deliverable);
 * this file answers the plan's probe questions:
 *   1. Does isProseContent label a 10-shape corpus ≥8/10 correct?
 *   2. Do the negative guards (CSV / YAML frontmatter / table) refuse?
 *   3. Is compressProseOutput deterministic and structure-preserving?
 *   4. Does the 0.3 floor hold, and what ratios land on real docs?
 *   5. Flag-off parity: prose content byte-identical when the flag is off?
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProseContent, routeAndCompress } from "./content-router.js";
import { resolveCompressionConfig } from "./index.js";
import { compressProseOutput, segmentBlocks } from "./prose-compressor.js";
import { DEFAULT_COMPRESSION_CONFIG } from "./types.js";

const p = (s: string) => s.repeat(3).slice(0, Math.max(1, s.length * 3)); // no-op helper placeholder
const para = (n: number) =>
  Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} in this paragraph about the system and its behaviour overall.`).join(" ");

describe("PROBE isProseContent — 10-shape corpus", () => {
  const corpus: Array<{ name: string; content: string; expect: boolean }> = [
    {
      name: "web_fetch markdown",
      expect: true,
      content: `# Page Title\n\n${para(3)}\n\n## Section A\n\n${para(3)}\n\n## Section B\n\n${para(3)}`,
    },
    {
      name: "man page",
      expect: true,
      content: `NAME\n\n${para(2)}\n\nSYNOPSIS\n\n${para(2)}\n\nDESCRIPTION\n\n${para(4)}`,
    },
    {
      name: "README",
      expect: true,
      content: `# Project\n\n${para(3)}\n\n## Install\n\n\`\`\`bash\nnpm install project\n\`\`\`\n\n## Usage\n\n${para(2)}`,
    },
    {
      name: "CSV rows",
      expect: false,
      content: Array.from({ length: 12 }, (_, i) => `row${i},value${i},2026-01-0${(i % 9) + 1},label${i}`).join("\n"),
    },
    {
      name: "YAML frontmatter doc",
      expect: false,
      content: `---\ntitle: Some Document\nauthor: Someone\ndate: 2026-09-01\n---\n\n${para(4)}`,
    },
    {
      name: "markdown table dominant",
      expect: false,
      content: `| col a | col b | col c |\n|---|---|---|\n| r1c1 | r1c2 | r1c3 |\n| r2c1 | r2c2 | r2c3 |\n| r3c1 | r3c2 | r3c3 |\n| r4c1 | r4c2 | r4c3 |\n| r5c1 | r5c2 | r5c3 |`,
    },
    {
      name: "changelog",
      expect: true,
      content: `# Changelog\n\n## 1.2.0\n\n- fixed the ingestion loop that dropped messages on retry\n- added the metrics endpoint under /metrics\n\n## 1.1.0\n\n- initial stable release with sqlite storage backend`,
    },
    {
      name: "license text",
      expect: true,
      content: `${para(4)}\n\n${para(4)}\n\n${para(4)}`,
    },
    {
      name: "API doc",
      expect: true,
      content: `# API Reference\n\n${para(3)}\n\n## GET /items\n\nReturns the collection of items with pagination metadata.\n\n\`\`\`json\n{"items": []}\n\`\`\`\n\n## POST /items\n\n${para(2)}`,
    },
    {
      name: "prose email",
      expect: true,
      content: `Hi team,\n\n${para(4)}\n\n${para(3)}\n\nBest regards,\n\nThe sender`,
    },
  ];

  it("labels ≥8/10 shapes correctly (plan bar)", () => {
    let correct = 0;
    for (const shape of corpus) {
      const got = isProseContent(shape.content);
      if (got === shape.expect) correct++;
      else console.log(`[corpus-miss] ${shape.name}: expected ${shape.expect}, got ${got}`);
    }
    console.log(`[corpus] ${correct}/10 correct`);
    expect(correct).toBeGreaterThanOrEqual(8);
  });

  it("negative guards refuse explicitly (CSV + YAML)", () => {
    expect(isProseContent(corpus[3].content)).toBe(false);
    expect(isProseContent(corpus[4].content)).toBe(false);
    expect(isProseContent(corpus[5].content)).toBe(false);
  });
});

describe("PROBE compressProseOutput", () => {
  const longDoc = [
    "# Title",
    para(4),
    "## Alpha",
    para(4),
    para(4),
    "On 2026-09-01 the migration finished and the old tables were dropped.",
    para(4),
    "## Beta",
    "```ts\nconst x = compute();\nconst y = computeAgain(x);\n```",
    para(4),
    para(4),
    para(4),
    para(4),
  ].join("\n\n");

  it("keeps ALL headings and code blocks verbatim", () => {
    const out = compressProseOutput(longDoc, 0.3);
    expect(out.content).toContain("# Title");
    expect(out.content).toContain("## Alpha");
    expect(out.content).toContain("## Beta");
    expect(out.content).toContain("const x = compute();");
    expect(out.compressed).toBe(true);
    console.log(`[ratio] longDoc: ${out.charsAfter}/${out.charsBefore} = ${(out.charsAfter / out.charsBefore).toFixed(2)}`);
  });

  it("keeps temporally-anchored paragraph even below budget style", () => {
    const out = compressProseOutput(longDoc, 0.3);
    expect(out.content).toContain("On 2026-09-01 the migration finished");
  });

  it("floors the ratio at 0.3 (probe question #4)", () => {
    const low = compressProseOutput(longDoc, 0.1);
    const atFloor = compressProseOutput(longDoc, 0.3);
    expect(low.content).toBe(atFloor.content); // 0.1 ⇒ clamped to 0.3
    const high = compressProseOutput(longDoc, 0.8);
    expect(high.charsAfter).toBeGreaterThan(atFloor.charsAfter);
    console.log(`[floor] ratio@0.1→${(low.charsAfter / low.charsBefore).toFixed(2)}, @0.3→${(atFloor.charsAfter / atFloor.charsBefore).toFixed(2)}, @0.8→${(high.charsAfter / high.charsBefore).toFixed(2)}`);
  });

  it("is deterministic: same input twice ⇒ byte-identical", () => {
    const a = compressProseOutput(longDoc, 0.3);
    const b = compressProseOutput(longDoc, 0.3);
    expect(a.content).toBe(b.content);
    expect(a.charsAfter).toBe(b.charsAfter);
  });

  it("emits [+N more items] for lists and the distillation summary line", () => {
    const withList = ["# Doc", ["- first item in the list of changes", "- second item", "- third item"].join("\n"), para(3), para(3), para(3), para(3), para(3), para(3), para(3), para(3)].join("\n\n");
    const out = compressProseOutput(withList, 0.3);
    expect(out.content).toContain("- first item in the list of changes");
    expect(out.content).toMatch(/\[\+\d+ more items\]/);
    expect(out.content).toContain("— prose distilled: kept");
  });

  it("short-doc fast path: compressed=false when nothing can be dropped", () => {
    const short = `# Small\n\n${para(1)}`;
    const out = compressProseOutput(short, 0.9);
    expect(out.compressed).toBe(false);
    expect(out.content).toBe(short);
  });

  it("fenced code with blank lines inside stays atomic (segmentBlocks)", () => {
    const doc = `# T\n\n\`\`\`js\nconst a = 1;\n\nconst b = 2;\n\`\`\`\n\n${para(4)}`;
    const blocks = segmentBlocks(doc);
    const codeBlocks = blocks.filter((b) => b.kind === "code");
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].text).toContain("const a = 1;");
    expect(codeBlocks[0].text).toContain("const b = 2;");
  });
});

describe("PROBE flag-off parity through the router", () => {
  const proseDoc = `# Page\n\n${para(4)}\n\n## Section\n\n${para(4)}\n\n${para(4)}`;

  it("DEFAULT config: prose flag off ⇒ passthrough byte-identity", () => {
    const cfg = resolveCompressionConfig(undefined);
    expect(cfg.enabledTypes.prose).toBe(false);
    const out = routeAndCompress(proseDoc, cfg);
    expect(out.compressed).toBe(false);
    expect(out.content).toBe(proseDoc);
    expect(out.contentType).toBe("passthrough");
  });

  it("flag on ⇒ compressed with contentType prose", () => {
    const cfg = resolveCompressionConfig({
      enabledTypes: { ...DEFAULT_COMPRESSION_CONFIG.enabledTypes, prose: true },
    });
    const bigProseDoc = `# Page\n\n${para(4)}\n\n## Section\n\n${para(4)}\n\n${para(4)}\n\n${para(4)}\n\n${para(4)}\n\n${para(4)}\n\n${para(4)}\n\n${para(4)}`;
    const out = routeAndCompress(bigProseDoc, cfg);
    expect(out.compressed).toBe(true);
    expect(out.contentType).toBe("prose");
  });

  it("resolveCompressionConfig honors user prose=true override", () => {
    const cfg = resolveCompressionConfig({ enabledTypes: { prose: true } });
    expect(cfg.enabledTypes.prose).toBe(true);
  });
});

describe("PROBE real-document ratio measurement", () => {
  it("measures achieved ratios on repo markdown stand-ins for web-fetch output", () => {
    const candidates = [
      join(process.cwd(), "README.md"),
      join(process.cwd(), "docs", "README.md"),
      join(process.cwd(), "AGENTS.md"),
    ].filter((f) => existsSync(f));
    console.log(`[realdocs] measuring ${candidates.length} files`);
    for (const file of candidates) {
      const content = readFileSync(file, "utf8");
      const detected = isProseContent(content);
      const out = compressProseOutput(content, 0.3);
      console.log(
        `[realdocs] ${file.split("/").pop()}: detected=${detected} chars=${out.charsBefore}→${out.charsAfter} ratio=${(out.charsAfter / out.charsBefore).toFixed(2)} compressed=${out.compressed}`,
      );
    }
    // Assertions are soft: measurement is the deliverable, not a pass bar.
    expect(candidates.length).toBeGreaterThan(0);
  });
});
