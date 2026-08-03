/**
 * Know/Act Paired Test — LongMemEval Act-axis extension.
 *
 * Research finding (Finding 4, 2026-08-03): memory systems should be evaluated
 * on two axes: (1) **Know** — can the agent recall a fact? (2) **Act** — can
 * the agent apply it in a scenario? These are distinct — a model can recall
 * a preference without applying it, or apply a pattern without conscious recall.
 *
 * This module provides:
 * - `ActScenario` — a scenario where a known preference should be applied
 * - `generateActScenario()` — creates a scenario from a typed fact
 * - `scoreActResponse()` — judges whether a response applies the preference
 * - `ACT_SCENARIO_BANK` — curated scenario templates for common fact types
 *
 * The harness (`run-longmemeval-engine.ts`) can import these to produce a
 * parallel `act-scenarios.jsonl` output alongside the existing hypothesis.jsonl.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A scenario that tests whether a preference is applied, not just recalled. */
export interface ActScenario {
  /** The fact being tested (e.g., "favorite_language = Rust"). */
  factId: string;
  /** The slot name. */
  slot: string;
  /** The expected value. */
  expectedValue: string;
  /** The scenario prompt — a situation where the preference should manifest. */
  prompt: string;
  /** Keywords/phrases that indicate the preference was applied. */
  applicationKeywords: string[];
  /** Keywords that indicate the preference was NOT applied (anti-signals). */
  antiKeywords: string[];
  /** Human-readable description of what this scenario tests. */
  description: string;
}

/** Result of scoring a response against an act scenario. */
export interface ActScore {
  /** Whether the response applies the preference. */
  applied: boolean;
  /** Confidence score [0, 1]. */
  confidence: number;
  /** Which keywords matched (positive evidence). */
  matchedKeywords: string[];
  /** Which anti-keywords matched (negative evidence). */
  matchedAntiKeywords: string[];
  /** Reason for the verdict. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Scenario bank — curated templates for common fact types
// ---------------------------------------------------------------------------

type ScenarioTemplate = {
  /** Slot patterns this template matches (regex). */
  slotPattern: RegExp;
  /** Generate a prompt from the fact value. */
  prompt: (slot: string, value: string) => string;
  /** Keywords that signal application of the preference. */
  keywords: (value: string) => string[];
  /** Anti-keywords that signal non-application. */
  antiKeywords: (value: string) => string[];
  /** Description. */
  description: (slot: string) => string;
};

/**
 * Curated scenario templates. Each template knows how to turn a typed fact
 * into a realistic scenario where the preference should naturally manifest
 * in the response.
 */
const ACT_SCENARIO_BANK: ScenarioTemplate[] = [
  {
    slotPattern: /language|framework|stack|tool/i,
    prompt: (_slot, value) =>
      `I need to write a new utility script that parses JSON files and outputs CSV. What language or tool should I use? Write the first few lines.`,
    keywords: (value) => [value.toLowerCase()],
    antiKeywords: (_value) => [],
    description: (slot) => `Tests whether ${slot} preference appears in code recommendation`,
  },
  {
    slotPattern: /timezone|tz/i,
    prompt: (_slot, _value) =>
      `If it's 2 PM right now, what time should I schedule a meeting for tomorrow morning?`,
    keywords: (value) => [value.toLowerCase()],
    antiKeywords: () => [],
    description: (slot) => `Tests whether ${slot} is applied to time reasoning`,
  },
  {
    slotPattern: /favorite|preference|like|prefer/i,
    prompt: (slot, _value) => `Can you recommend something for me? I'm not sure what to pick.`,
    keywords: (value) => [value.toLowerCase()],
    antiKeywords: () => [],
    description: (slot) => `Tests whether ${slot} preference appears in recommendations`,
  },
  {
    slotPattern: /allergy|dietary|diet/i,
    prompt: (_slot, _value) => `I'm planning a dinner menu. What should I make?`,
    keywords: (value) => [value.toLowerCase()],
    antiKeywords: () => [],
    description: (slot) => `Tests whether ${slot} constraint is respected in planning`,
  },
  {
    slotPattern: /name|nickname|alias/i,
    prompt: (_slot, _value) => `Write a short greeting message for me.`,
    keywords: (value) => [value.toLowerCase()],
    antiKeywords: () => [],
    description: (slot) => `Tests whether ${slot} is used in personal address`,
  },
];

/**
 * Default fallback scenario generator — works for any fact.
 * Asks an open-ended question where the preference should surface.
 */
function defaultScenario(
  slot: string,
  value: string,
): {
  prompt: string;
  keywords: string[];
  antiKeywords: string[];
  description: string;
} {
  const humanSlot = slot.replace(/[:_-]/g, " ").trim();
  return {
    prompt: `What do you know about my ${humanSlot}? How would that affect your recommendations?`,
    keywords: [value.toLowerCase()],
    antiKeywords: [],
    description: `Generic act-scenario for ${slot}`,
  };
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Generate an act scenario from a typed fact.
 * Picks the best-matching template from the bank, or falls back to default.
 */
export function generateActScenario(fact: {
  id: string;
  slot: string;
  value: string;
}): ActScenario {
  const template = ACT_SCENARIO_BANK.find((t) => t.slotPattern.test(fact.slot));
  const gen = template ?? null;

  const prompt = gen
    ? gen.prompt(fact.slot, fact.value)
    : defaultScenario(fact.slot, fact.value).prompt;
  const keywords = gen ? gen.keywords(fact.value) : defaultScenario(fact.slot, fact.value).keywords;
  const antiKeywords = gen
    ? gen.antiKeywords(fact.value)
    : defaultScenario(fact.slot, fact.value).antiKeywords;
  const description = gen
    ? gen.description(fact.slot)
    : defaultScenario(fact.slot, fact.value).description;

  return {
    factId: fact.id,
    slot: fact.slot,
    expectedValue: fact.value,
    prompt,
    applicationKeywords: keywords,
    antiKeywords,
    description,
  };
}

/**
 * Score a response against an act scenario.
 *
 * Checks for presence of application keywords (positive evidence) and
 * anti-keywords (negative evidence). Returns a verdict and confidence.
 *
 * This is a heuristic scorer — the LLM-judge version can be layered on
 * top for more nuanced assessment.
 */
export function scoreActResponse(response: string, scenario: ActScenario): ActScore {
  const lowerResponse = response.toLowerCase();

  const matchedKeywords = scenario.applicationKeywords.filter((k) =>
    lowerResponse.includes(k.toLowerCase()),
  );
  const matchedAntiKeywords = scenario.antiKeywords.filter((k) =>
    lowerResponse.includes(k.toLowerCase()),
  );

  // Positive evidence: application keywords present
  const positiveScore =
    scenario.applicationKeywords.length > 0
      ? matchedKeywords.length / scenario.applicationKeywords.length
      : 0;

  // Negative evidence: anti-keywords present
  const negativeScore =
    scenario.antiKeywords.length > 0
      ? matchedAntiKeywords.length / scenario.antiKeywords.length
      : 0;

  const confidence = Math.max(0, positiveScore - negativeScore);
  const applied = confidence > 0;

  let reason: string;
  if (applied) {
    reason =
      matchedAntiKeywords.length > 0
        ? `Applied with ${matchedKeywords.length} positive and ${matchedAntiKeywords.length} negative signals`
        : `Application detected: ${matchedKeywords.join(", ")}`;
  } else {
    reason =
      matchedAntiKeywords.length > 0
        ? `Not applied; anti-keywords detected: ${matchedAntiKeywords.join(", ")}`
        : "No application signals found in response";
  }

  return { applied, confidence, matchedKeywords, matchedAntiKeywords, reason };
}

/**
 * Batch-score a set of act scenarios.
 * Returns aggregate metrics for the harness.
 */
export function scoreActBatch(results: Array<{ scenario: ActScenario; response: string }>): {
  actUtilizationRate: number;
  avgConfidence: number;
  perScenario: Array<ActScore & { factId: string; slot: string }>;
} {
  if (results.length === 0) {
    return { actUtilizationRate: 0, avgConfidence: 0, perScenario: [] };
  }

  const perScenario = results.map(({ scenario, response }) => {
    const score = scoreActResponse(response, scenario);
    return { ...score, factId: scenario.factId, slot: scenario.slot };
  });

  const applied = perScenario.filter((s) => s.applied).length;
  const actUtilizationRate = applied / results.length;
  const avgConfidence = perScenario.reduce((sum, s) => sum + s.confidence, 0) / results.length;

  return { actUtilizationRate, avgConfidence, perScenario };
}
