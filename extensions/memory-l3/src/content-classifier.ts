/**
 * PROBE SPIKE — Content-type classifier for L2 compaction routing.
 * Card: ARCH-1 d53eed50 (Content-type-routed compression)
 *
 * This is a feasibility spike. The value is proving the classification
 * approach works on realistic agent message content.
 */

export type ContentType = "code" | "json" | "prose" | "tool-output" | "mixed";

export interface ClassificationResult {
  type: ContentType;
  confidence: number;
  signals: string[];
}

/**
 * Lightweight content-type detector for L1 message segments.
 * Samples the first N messages and checks for structural markers.
 */
export function classifyContentType(
  messages: ReadonlyArray<{ role?: string; content?: string }>,
): ClassificationResult {
  const sample = messages.slice(0, 12);
  const allText = sample.map((m) => m.content ?? "").join("\n");
  const signals: string[] = [];

  // Code detection: fenced code blocks, common language markers
  const codeFenceCount = (allText.match(/```[\w]*\n/g) ?? []).length;
  const hasCodeKeywords =
    /\b(function|const|class|import|export|def |async |await |return |if \(|for \(|=>)\b/.test(
      allText,
    );
  const hasShellCommands = /^\s*(npm|pnpm|git|cargo|rustc|node|bash|sh)\s/m.test(allText);

  // JSON detection: structural markers
  const jsonBraceDensity = (allText.match(/[{}\[\]]/g) ?? []).length / Math.max(allText.length, 1);
  const hasJsonKeys = /"[\w_]+"\s*:/.test(allText);

  // Tool-output detection: exec results, tool markers
  const hasToolRole = sample.some((m) => m.role === "tool" || m.role === "function");
  const hasExecMarkers = /\b(exit code|stdout|stderr|command not found|✓|✗|PASS|FAIL)\b/i.test(
    allText,
  );

  // Prose detection: natural language sentences
  const sentenceCount = (allText.match(/[.!?]\s/g) ?? []).length;
  const avgWordLength =
    allText
      .split(/\s+/)
      .filter(Boolean)
      .reduce((sum, w) => sum + w.length, 0) /
    Math.max(allText.split(/\s+/).filter(Boolean).length, 1);

  // Score each type
  let codeScore = 0;
  let jsonScore = 0;
  let proseScore = 0;
  let toolScore = 0;

  if (codeFenceCount >= 1) {
    codeScore += 2;
    signals.push(`code-fence:${codeFenceCount}`);
  }
  if (hasCodeKeywords) {
    codeScore += 1;
    signals.push("code-keywords");
  }
  if (hasShellCommands) {
    codeScore += 1;
    signals.push("shell-commands");
  }

  if (jsonBraceDensity > 0.02) {
    jsonScore += 1;
    signals.push(`brace-density:${jsonBraceDensity.toFixed(3)}`);
  }
  if (hasJsonKeys) {
    jsonScore += 2;
    signals.push("json-keys");
  }

  if (hasToolRole) {
    toolScore += 2;
    signals.push("tool-role");
  }
  if (hasExecMarkers) {
    toolScore += 1;
    signals.push("exec-markers");
  }

  if (sentenceCount > 3 && avgWordLength > 3 && avgWordLength < 8) {
    proseScore += 2;
    signals.push(`prose:sentences=${sentenceCount}`);
  }
  if (codeScore === 0 && jsonScore === 0 && toolScore === 0) {
    proseScore += 1;
  }

  const maxScore = Math.max(codeScore, jsonScore, proseScore, toolScore);
  if (maxScore === 0) {
    return { type: "prose", confidence: 0.5, signals: ["default-fallback"] };
  }

  // Check for "mixed" — if two types are close in score
  const scores = [
    { type: "code" as const, score: codeScore },
    { type: "json" as const, score: jsonScore },
    { type: "prose" as const, score: proseScore },
    { type: "tool-output" as const, score: toolScore },
  ].sort((a, b) => b.score - a.score);

  const [winner, runnerUp] = scores;
  if (!winner) {
    return { type: "prose", confidence: 0.5, signals: ["default-fallback"] };
  }

  if (runnerUp && winner.score > 0 && runnerUp.score > 0 && winner.score - runnerUp.score <= 1) {
    return { type: "mixed", confidence: 0.6, signals };
  }

  return {
    type: winner.type,
    confidence: winner.score / (codeScore + jsonScore + proseScore + toolScore),
    signals,
  };
}
