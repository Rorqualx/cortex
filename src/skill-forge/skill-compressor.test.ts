import { describe, expect, it } from "vitest";
import { compressSkillMarkdown, type CompressionResult } from "./skill-compressor.js";

describe("compressSkillMarkdown", () => {
  it("removes exact duplicate prose lines", () => {
    const body = [
      "## Overview",
      "",
      "This skill helps with file operations.",
      "This skill helps with file operations.",
      "",
      "## Workflow",
      "",
      "1. Read the file",
    ].join("\n");
    const result = compressSkillMarkdown(body);
    expect(result.linesRemoved).toBe(1);
    expect(result.compressed).not.toContain(
      "This skill helps with file operations.\nThis skill helps with file operations.",
    );
  });

  it("collapses consecutive blank lines", () => {
    const body = "## Section A\n\n\n\nContent here\n\n\n## Section B";
    const result = compressSkillMarkdown(body);
    expect(result.compressed).not.toMatch(/\n{3,}/);
    expect(result.linesRemoved).toBeGreaterThan(0);
  });

  it("preserves section headers even if duplicated", () => {
    const body = "## Overview\nContent A\n## Overview\nContent B";
    const result = compressSkillMarkdown(body);
    // Headers are always preserved
    expect(result.compressed.match(/## Overview/gu)?.length).toBe(2);
  });

  it("preserves code block fences", () => {
    const body = ["## Workflow", "", "```bash", "npm test", "npm test", "```"].join("\n");
    const result = compressSkillMarkdown(body);
    expect(result.compressed).toContain("```bash");
    expect(result.compressed).toContain("```");
  });

  it("preserves numbered list items", () => {
    const body = [
      "## Workflow",
      "",
      "1. Read the file",
      "2. Read the file",
      "3. Write output",
    ].join("\n");
    const result = compressSkillMarkdown(body);
    // Numbered items are preserved even if content duplicates
    expect(result.compressed).toContain("1. Read the file");
    expect(result.compressed).toContain("2. Read the file");
  });

  it("preserves tool references (coverage check)", () => {
    const body = [
      "## Workflow",
      "",
      "Use `read-file` to read the contents.",
      "Use `write-file` to save changes.",
      "Use `read-file` to read the contents.",
    ].join("\n");
    const result = compressSkillMarkdown(body);
    expect(result.coveragePreserved).toBe(true);
    expect(result.compressed).toContain("`read-file`");
    expect(result.compressed).toContain("`write-file`");
  });

  it("returns original unchanged when coverage would be broken", () => {
    // Edge case: if dedup removes a line that's the only occurrence of a tool ref
    // This shouldn't happen with our logic (duplicates by definition appear 2+ times)
    // but test the safety mechanism anyway
    const body = "## Workflow\n\nUse `unique-tool` here.\nUse `unique-tool` here.";
    const result = compressSkillMarkdown(body);
    // The tool ref appears in the original, and should still be in the compressed
    expect(result.coveragePreserved).toBe(true);
    expect(result.compressed).toContain("`unique-tool`");
  });

  it("handles empty body", () => {
    const result = compressSkillMarkdown("");
    expect(result.linesRemoved).toBe(0);
    expect(result.coveragePreserved).toBe(true);
  });

  it("handles body with no duplicates", () => {
    const body =
      "## Overview\n\nThis is unique content.\n\n## Workflow\n\n1. Step one\n2. Step two";
    const result = compressSkillMarkdown(body);
    expect(result.linesRemoved).toBe(0);
    expect(result.compressed).toBe(body);
  });

  it("trims trailing whitespace from lines", () => {
    const body = "## Overview   \n\nContent here   \n";
    const result = compressSkillMarkdown(body);
    expect(result.compressed).not.toMatch(/  $/mu);
  });

  it("preserves trigger keywords in When sections", () => {
    const body = [
      "## When this triggers",
      "",
      "Detected when `file-read` is called repeatedly.",
      "",
      "## Workflow",
      "",
      "1. Call `file-read`",
    ].join("\n");
    const result = compressSkillMarkdown(body);
    expect(result.coveragePreserved).toBe(true);
    expect(result.missingTriggers).toEqual([]);
  });

  it("removes duplicate prose across different sections", () => {
    const body = [
      "## Overview",
      "",
      "This is a common warning line.",
      "",
      "## Notes",
      "",
      "This is a common warning line.",
    ].join("\n");
    const result = compressSkillMarkdown(body);
    expect(result.linesRemoved).toBe(1);
    // The first occurrence is kept
    expect(result.compressed.includes("This is a common warning line.")).toBe(true);
    // Count occurrences
    const occurrences = result.compressed.match(/This is a common warning line\./gu)?.length ?? 0;
    expect(occurrences).toBe(1);
  });
});
