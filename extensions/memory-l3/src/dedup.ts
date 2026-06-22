import { randomUUID } from "node:crypto";
import type { ExtractedFact } from "./llm.js";
import type { L2Fact } from "./types.js";

/**
 * Drop facts whose dedupKey appeared earlier in the same chunk. The first
 * occurrence wins — this preserves the importance score of the
 * higher-confidence emission when the LLM repeats itself.
 */
export function dedupWithinChunk(facts: ReadonlyArray<ExtractedFact>): ExtractedFact[] {
  const seen = new Set<string>();
  const out: ExtractedFact[] = [];
  for (const fact of facts) {
    if (seen.has(fact.dedupKey)) {
      continue;
    }
    seen.add(fact.dedupKey);
    out.push(fact);
  }
  return out;
}

/**
 * Belt-and-suspenders pass: drop facts whose dedupKey appears in the
 * already-known set, even if the prompt's `already-known` rule was
 * supposed to prevent the LLM from emitting them. Models occasionally
 * ignore extraction-time rules.
 */
export function dropAlreadyKnown(
  facts: ReadonlyArray<ExtractedFact>,
  alreadyKnownKeys: ReadonlySet<string>,
): ExtractedFact[] {
  return facts.filter((f) => !alreadyKnownKeys.has(f.dedupKey));
}

export function liftToL2Fact(fact: ExtractedFact, createdAt: number): L2Fact {
  return {
    id: `fact-${randomUUID().slice(0, 8)}`,
    text: fact.text,
    importance: fact.importance,
    createdAt,
    dedupKey: fact.dedupKey,
    reasoning: fact.reasoning,
    significant: fact.significant,
    certainty: fact.certainty,
    semanticEntropy: fact.semanticEntropy,
  };
}
