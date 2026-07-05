import type { Candidate } from "./detector.js";

/**
 * Process vs. Outcome rubric dimensions for skill evaluation.
 *
 * Process: Focus on the methodology, steps, and how the task is executed
 * Outcome: Focus on the result, goal achievement, and end state
 */
export type ProcessVsOutcomeRubric = {
  /**
   * How much the skill focuses on process vs. outcome
   * - 0 = purely outcome-focused
   * - 1 = purely process-focused
   */
  processFocus: number;
  /**
   * Whether the skill involves sequential steps (process) vs direct results (outcome)
   */
  sequentialSteps: boolean;
  /**
   * Whether the skill requires error handling (process) vs assumes successful execution (outcome)
   */
  errorHandling: boolean;
  /**
   * Whether the skill is reusable across different scenarios (process) or specific to one outcome (outcome)
   */
  reusability: boolean;
};

/**
 * Evaluate a candidate for process vs. outcome characteristics.
 */
export function evaluateProcessVsOutcome(candidate: Candidate): ProcessVsOutcomeRubric {
  const base = {
    processFocus: 0.5,
    sequentialSteps: false,
    errorHandling: false,
    reusability: true,
  };

  switch (candidate.lane) {
    case "tool-shape":
      // Tool-shape skills are typically process-focused - they capture repeated workflows
      base.processFocus = 0.8;
      base.sequentialSteps = true;
      base.reusability = true;
      // Check if it includes error recovery based on tool sequence
      base.errorHandling = candidate.toolSequence.some(
        (tool) => tool.includes("error") || tool.includes("recover") || tool.includes("fix"),
      );
      break;

    case "error-recovery":
      // Error-recovery skills are process-focused by definition
      base.processFocus = 0.9;
      base.sequentialSteps = true;
      base.errorHandling = true;
      base.reusability = true;
      break;

    case "explicit":
      // Explicit skills depend on the matched phrase - analyze the prompt excerpt
      const promptText = candidate.promptExcerpt.toLowerCase();

      if (
        promptText.includes("how to") ||
        promptText.includes("steps") ||
        promptText.includes("process") ||
        promptText.includes("workflow")
      ) {
        base.processFocus = 0.8;
        base.sequentialSteps = true;
      } else if (
        promptText.includes("result") ||
        promptText.includes("output") ||
        promptText.includes("achieve") ||
        promptText.includes("goal")
      ) {
        base.processFocus = 0.2;
        base.sequentialSteps = false;
      }

      // Explicit skills with error context should handle errors
      base.errorHandling =
        promptText.includes("error") ||
        promptText.includes("fail") ||
        candidate.rationale.includes("error");

      break;
  }

  return base;
}

/**
 * Format process vs. outcome rubric for skill documentation.
 */
export function formatProcessVsOutcome(rubric: ProcessVsOutcomeRubric): string {
  const focusLabel =
    rubric.processFocus > 0.6
      ? "Process-focused"
      : rubric.processFocus < 0.4
        ? "Outcome-focused"
        : "Balanced";

  return [
    "## Process vs. Outcome Analysis",
    "",
    `**Focus:** ${focusLabel} (${Math.round(rubric.processFocus * 100)}% process-oriented)`,
    "",
    "**Characteristics:**",
    `- Sequential steps: ${rubric.sequentialSteps ? "Yes" : "No"}`,
    `- Error handling: ${rubric.errorHandling ? "Yes" : "No"}`,
    `- Reusable across scenarios: ${rubric.reusability ? "Yes" : "No"}`,
    "",
  ].join("\n");
}
