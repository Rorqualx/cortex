/**
 * HyPE — Hypothetical Prompt Embeddings for typed-fact retrieval.
 *
 * Research finding (Finding 9, 2026-08-03): at fact storage time, pre-generate
 * 2–3 hypothetical user queries that would retrieve each fact. Store those
 * query embeddings alongside the fact's own embedding. At retrieval time, the
 * query matches against both fact embeddings and hypothetical-prompt
 * embeddings, improving recall for phrasings that differ from how the fact
 * was originally stored.
 *
 * This module provides:
 * - `generateHypeQueries()` — template-based generation (no LLM required).
 *   An LLM-based generator can be injected at the engine level for higher
 *   quality queries.
 * - `bestHypeMatch()` — max cosine similarity across a fact's HyPE queries.
 * - `buildHypeLookup()` — group HyPE queries by fact ID for retrieval-time use.
 */

/** A single hypothetical query with its embedding. */
export interface HypeQuery {
  text: string;
  embedding?: number[];
}

/** A HyPE query as stored in the DB. */
export interface StoredHypeQuery {
  factId: string;
  querySeq: number;
  queryText: string;
  embedding: number[];
}

/**
 * Generate 2–3 hypothetical user queries for a typed fact, using simple
 * templates. No LLM call required — the templates cover common phrasings
 * that differ from the canonical slot=value representation.
 *
 * For typed facts (`slot = value`), queries focus on how a user would
 * naturally ASK for that information.
 *
 * Example: slot="pi_hole:ip", value="192.168.50.128"
 *   → "What is the pi hole ip?"
 *   → "What's the pi hole ip address?"
 *   → "pi hole ip"
 *
 * For prose facts (general text), queries extract key entities.
 *
 * An LLM-based generator can be injected at the engine level for better
 * quality. The template version ensures the feature works out of the box.
 */
export function generateHypeQueries(factText: string, slot?: string): string[] {
  // For typed facts (slot = value), generate slot-oriented queries.
  if (slot) {
    return generateTypedHypeQueries(slot, factText);
  }

  // For prose facts, extract the most informative words.
  return generateProseHypeQueries(factText);
}

/**
 * Generate hypothetical queries for a typed fact (slot = value).
 */
function generateTypedHypeQueries(slot: string, _value: string): string[] {
  // Humanize the slot name: "pi_hole:ip" → "pi hole ip"
  const humanSlot = slot.replace(/[:_-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

  return [`What is the ${humanSlot}?`, `What's the ${humanSlot}?`, humanSlot];
}

/**
 * Generate hypothetical queries for a prose fact.
 * Extracts the first sentence and key capitalized terms.
 */
function generateProseHypeQueries(text: string): string[] {
  const trimmed = text.trim();
  // First sentence (or first ~80 chars)
  const firstSentence = trimmed.split(/[.!?]\s/)[0] ?? trimmed;
  const short = firstSentence.length > 80 ? firstSentence.slice(0, 77) + "..." : firstSentence;

  // Extract capitalized terms (likely entities)
  const entities = trimmed.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
  const entityQuery = entities && entities.length > 0 ? `Tell me about ${entities[0]}` : short;

  return [short, entityQuery, trimmed.slice(0, 40).toLowerCase().trim()];
}

/**
 * Compute the best (max) cosine similarity between a query embedding and
 * a set of HyPE query embeddings for a fact.
 *
 * Returns 0 if no embeddings are available (graceful fallback).
 */
export function bestHypeMatch(
  queryEmbedding: number[],
  hypeQueries: ReadonlyArray<{ embedding: number[] }>,
): number {
  let best = 0;
  for (const hq of hypeQueries) {
    if (hq.embedding.length === 0 || hq.embedding.length !== queryEmbedding.length) {
      continue;
    }
    const sim = cosineSimilarity(queryEmbedding, hq.embedding);
    if (sim > best) best = sim;
  }
  return best;
}

/**
 * Group stored HyPE queries by fact ID for O(1) lookup during retrieval.
 */
export function buildHypeLookup(
  queries: ReadonlyArray<StoredHypeQuery>,
): Map<string, StoredHypeQuery[]> {
  const map = new Map<string, StoredHypeQuery[]>();
  for (const q of queries) {
    const list = map.get(q.factId);
    if (list) {
      list.push(q);
    } else {
      map.set(q.factId, [q]);
    }
  }
  return map;
}

/** Cosine similarity between two equal-length vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
