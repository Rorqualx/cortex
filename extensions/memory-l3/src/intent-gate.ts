// QW-2 (2026-09-26): intent gate before L3 recall (Agent Zero Memory).
// A cheap lexical heuristic lets the engine skip the whole recall path
// (embedding compute + ReTopK + retrieveTopK) for self-contained turns.
// Default ON; kill switch: OPENCLAW_MEMORY_L3_INTENT_GATE=0 (alongside the
// other OPENCLAW_MEMORY_L3_* switches). False negatives only cost one
// lookup; the gate may only skip recall it is confident a turn doesn't need.
// Kept dependency-free so it stays unit-testable in isolation from the
// storage/sqlite import graph (see engine.ts for the wiring point).
export const INTENT_GATE_ENABLED = process.env.OPENCLAW_MEMORY_L3_INTENT_GATE !== "0";
export const INTENT_GATE_MAX_PROMPT_CHARS = 240;
// First/second-person pronouns: the strongest signal a turn is about the
// user/agent and may need episodic memory.
const INTENT_GATE_PRONOUN_RE =
  /\b(?:i|me|my|mine|myself|we|us|our|ours|ourselves|you|your|yours|yourself|yourselves)\b/i;
// Digits: numbers/dates/IPs/versions — slot-lookup vocabulary for typed facts.
const INTENT_GATE_ENTITY_DIGIT_RE = /\d/;

/**
 * Conservative lexical self-containment check. Only report "self-contained"
 * (safe to skip recall) when the prompt is short AND carries no memory-seeking
 * signal: no first/second-person pronoun, no digits, and no mid-sentence
 * capitalized token (names/entities often key into stored facts). Anything
 * ambiguous passes through to full recall.
 */
export function isSelfContainedPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || trimmed.length > INTENT_GATE_MAX_PROMPT_CHARS) {
    return false;
  }
  if (INTENT_GATE_PRONOUN_RE.test(trimmed) || INTENT_GATE_ENTITY_DIGIT_RE.test(trimmed)) {
    return false;
  }
  const words = trimmed.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.length > 1 && /^[A-Z]/.test(w)) {
      return false;
    }
  }
  return true;
}
