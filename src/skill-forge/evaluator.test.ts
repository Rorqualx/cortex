import { describe, it, expect } from "vitest";
import { evaluateProcessVsOutcome, formatProcessVsOutcome } from "./evaluator.js";

describe("Process vs. Outcome Evaluator", () => {
  describe("evaluateProcessVsOutcome", () => {
    it("evaluates tool-shape candidates as process-focused", () => {
      const candidate = {
        lane: "tool-shape" as const,
        candidateId: "test-123",
        toolShapeHash: "abc123",
        toolSequence: ["read_file", "grep", "write_file"],
        captureDirs: ["/tmp/capture1"],
        occurrences: 3,
        successScore: 1,
      };

      const result = evaluateProcessVsOutcome(candidate);

      expect(result.processFocus).toBeGreaterThan(0.6);
      expect(result.sequentialSteps).toBe(true);
      expect(result.reusability).toBe(true);
    });

    it("evaluates error-recovery candidates as highly process-focused", () => {
      const candidate = {
        lane: "error-recovery" as const,
        candidateId: "test-456",
        captureDir: "/tmp/capture2",
        toolSequence: ["read_file", "error", "try_again"],
        failingTool: "read_file",
        recoveringTool: "try_again",
        rationale: "Read failed, retry succeeded",
        successScore: 0.5,
      };

      const result = evaluateProcessVsOutcome(candidate);

      expect(result.processFocus).toBeGreaterThan(0.8);
      expect(result.sequentialSteps).toBe(true);
      expect(result.errorHandling).toBe(true);
      expect(result.reusability).toBe(true);
    });

    it("evaluates explicit candidates with 'how to' as process-focused", () => {
      const candidate = {
        lane: "explicit" as const,
        candidateId: "test-789",
        captureDir: "/tmp/capture3",
        toolSequence: ["step1", "step2", "step3"],
        matchedPhrase: "how to do something",
        promptExcerpt: "How to process this data step by step?",
        rationale: "User requested workflow",
        successScore: 1,
      };

      const result = evaluateProcessVsOutcome(candidate);

      expect(result.processFocus).toBeGreaterThan(0.6);
      expect(result.sequentialSteps).toBe(true);
    });

    it("evaluates explicit candidates with 'result' as outcome-focused", () => {
      const candidate = {
        lane: "explicit" as const,
        candidateId: "test-101",
        captureDir: "/tmp/capture4",
        toolSequence: ["direct_tool"],
        matchedPhrase: "get result",
        promptExcerpt: "I need the final result immediately",
        rationale: "User wanted outcome",
        successScore: 1,
      };

      const result = evaluateProcessVsOutcome(candidate);

      expect(result.processFocus).toBeLessThan(0.4);
      expect(result.sequentialSteps).toBe(false);
    });

    it("detects error handling in explicit candidates", () => {
      const candidate = {
        lane: "explicit" as const,
        candidateId: "test-202",
        captureDir: "/tmp/capture5",
        toolSequence: ["check", "handle_error"],
        matchedPhrase: "error handling",
        promptExcerpt: "What to do when there's an error?",
        rationale: "Handles errors",
        successScore: 0.5,
      };

      const result = evaluateProcessVsOutcome(candidate);

      expect(result.errorHandling).toBe(true);
    });
  });

  describe("formatProcessVsOutcome", () => {
    it("formats process-focused rubric", () => {
      const rubric = {
        processFocus: 0.8,
        sequentialSteps: true,
        errorHandling: false,
        reusability: true,
      };

      const result = formatProcessVsOutcome(rubric);

      expect(result).toContain("Process-focused");
      expect(result).toContain("80% process-oriented");
      expect(result).toContain("Sequential steps: Yes");
      expect(result).toContain("Error handling: No");
      expect(result).toContain("Reusable across scenarios: Yes");
    });

    it("formats outcome-focused rubric", () => {
      const rubric = {
        processFocus: 0.2,
        sequentialSteps: false,
        errorHandling: false,
        reusability: false,
      };

      const result = formatProcessVsOutcome(rubric);

      expect(result).toContain("Outcome-focused");
      expect(result).toContain("20% process-oriented");
      expect(result).toContain("Sequential steps: No");
      expect(result).toContain("Error handling: No");
      expect(result).toContain("Reusable across scenarios: No");
    });

    it("formats balanced rubric", () => {
      const rubric = {
        processFocus: 0.5,
        sequentialSteps: true,
        errorHandling: true,
        reusability: true,
      };

      const result = formatProcessVsOutcome(rubric);

      expect(result).toContain("Balanced");
      expect(result).toContain("50% process-oriented");
    });
  });
});