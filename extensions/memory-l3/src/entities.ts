/**
 * Entity extraction and cross-session topic linking.
 *
 * Phase 3 enhancements:
 * - Extracts named entities (people, projects, infrastructure, tools) from
 *   L2 facts and typed facts for cross-referencing across sessions.
 * - Builds a topic graph linking chunks across sessions via embedding
 *   similarity, enabling retrieval to pull relevant context from different
 *   conversation threads.
 * - Dynamic importance scoring adjusts fact importance based on retrieval
 *   frequency, reinforcing frequently-used facts and decaying idle ones.
 */

import { cosineSimilarity } from "./scoring.js";
import type {
  L2Fact,
  LongTermFact,
  TypedFact,
  Entity,
  TopicLink,
  RetrievalSignal,
} from "./types.js";

const DEBUG_ENABLED = process.env.OPENCLAW_MEMORY_L3_DEBUG === "1";
function l3debug(msg: string): void {
  if (DEBUG_ENABLED) {
    console.error(`[memory-l3/entities] ${msg}`);
  }
}

// -----------------------------------------------------------------
// Entity Extraction
// -----------------------------------------------------------------

/** Known entity categories for classification. */
export const ENTITY_CATEGORIES = [
  "person",
  "project",
  "infrastructure",
  "tool",
  "location",
  "organization",
  "concept",
] as const;
export type EntityCategory = (typeof ENTITY_CATEGORIES)[number];

/**
 * Extract entities from a set of facts by looking for known patterns:
 * - Infrastructure: IP addresses, hostnames, URLs
 * - People: names referenced in facts
 * - Projects: capitalized multi-word phrases near project-related keywords
 * - Tools: software names, CLI commands
 *
 * This is a heuristic extractor — it runs at compaction time with zero
 * LLM cost. The LLM-driven alternative would be more accurate but
 * adds latency to every compaction pass.
 */
export function extractEntitiesFromFacts(params: {
  facts: ReadonlyArray<L2Fact>;
  typedFacts?: ReadonlyArray<TypedFact>;
  agentId: string | null;
  chunkId: string;
  now?: number;
}): Entity[] {
  const now = params.now ?? Date.now();
  const entities: Map<string, Entity> = new Map();

  const addEntity = (name: string, category: EntityCategory, aliases?: string[]): void => {
    const normalizedName = name.trim().toLowerCase();
    if (normalizedName.length < 2) {
      return;
    }
    if (!entities.has(normalizedName)) {
      entities.set(normalizedName, {
        id: `entity-${normalizedName.replace(/\s+/g, "-")}`,
        name: name.trim(),
        category,
        aliases: (aliases ?? []).map((a) => a.trim().toLowerCase()),
        firstSeenAt: now,
        lastSeenAt: now,
        mentionCount: 1,
        sourceChunkIds: [params.chunkId],
        attributes: {},
      });
    } else {
      const existing = entities.get(normalizedName)!;
      existing.lastSeenAt = now;
      existing.mentionCount += 1;
      if (!existing.sourceChunkIds.includes(params.chunkId)) {
        existing.sourceChunkIds.push(params.chunkId);
      }
      for (const alias of aliases ?? []) {
        const normAlias = alias.trim().toLowerCase();
        if (!existing.aliases.includes(normAlias)) {
          existing.aliases.push(normAlias);
        }
      }
    }
  };

  // Extract from typed facts (high precision — these are verbatim values)
  for (const tf of params.typedFacts ?? []) {
    // IP addresses → infrastructure
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(tf.value)) {
      addEntity(tf.value, "infrastructure", [tf.slot]);
    }
    // URLs → infrastructure or tool
    if (/^https?:\/\//.test(tf.value)) {
      try {
        const host = new URL(tf.value).hostname;
        addEntity(host, "infrastructure");
      } catch {
        // Not a valid URL
      }
    }
    // Paths → project or tool
    if (tf.slot.includes("path") || tf.slot.includes("dir") || tf.slot.includes("repo")) {
      const basename = tf.value.split("/").pop() ?? tf.value;
      if (basename.length > 1) {
        addEntity(basename, "project");
      }
    }
    // Version strings → tool
    if (tf.unit === "v" || tf.slot.endsWith(":version")) {
      addEntity(tf.slot.split(":")[0] || tf.slot, "tool");
    }
  }

  // Extract from prose facts via keyword patterns
  for (const fact of params.facts) {
    const text = fact.text;

    // Infrastructure: IP-like patterns
    const ipMatches = text.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g);
    for (const m of ipMatches) {
      const ip = m[1];
      if (ip !== undefined) {
        addEntity(ip, "infrastructure");
      }
    }

    // Hostnames: word.word pattern (e.g., HueyTheDestroyer, rorqualx.asuscomm.com)
    const hostnameMatches = text.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\b/g);
    for (const m of hostnameMatches) {
      const host = m[1];
      if (host === undefined) {
        continue;
      }
      // Skip common English words that look like hostnames
      if (/^(e\.g|etc|i\.e|vs)\.$/i.test(host)) {
        continue;
      }
      if (host.includes(".") && !host.endsWith(".")) {
        addEntity(host, "infrastructure");
      }
    }

    // Named entities after "project", "repo", "server", "device" keywords
    const projectKeywords = new Set([
      "project",
      "repo",
      "repository",
      "server",
      "device",
      "service",
      "container",
      "database",
    ]);
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length - 1; i++) {
      const word = words[i];
      if (word === undefined) {
        continue;
      }
      const clean = word.toLowerCase().replace(/[.,;:!?]/g, "");
      if (projectKeywords.has(clean)) {
        const next = words[i + 1]?.replace(/[.,;:!?'"()]/g, "");
        if (next && next.length > 1 && /^[A-Z]/.test(next)) {
          addEntity(next, "project");
        }
      }
    }

    // Docker/service names (typically lowercase with hyphens)
    const dockerMatches = text.matchAll(/\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g);
    for (const m of dockerMatches) {
      const name = m[1];
      if (name === undefined) {
        continue;
      }
      // Filter out common English hyphenated words
      const noise = new Set([
        "well-known",
        "self-signed",
        "long-term",
        "short-term",
        "cross-session",
        "one-off",
        "built-in",
        "pre-computed",
        "non-trivial",
      ]);
      if (!noise.has(name) && name.length > 4) {
        addEntity(name, "tool");
      }
    }
  }

  return Array.from(entities.values());
}

/**
 * Merge newly extracted entities with existing entities from the entity index.
 * Updates mention counts, aliases, and last-seen timestamps.
 */
export function mergeEntities(
  existing: ReadonlyArray<Entity>,
  incoming: ReadonlyArray<Entity>,
): Entity[] {
  const index = new Map<string, Entity>();

  // Index existing by normalized name
  for (const e of existing) {
    index.set(e.name.toLowerCase(), { ...e });
    for (const alias of e.aliases) {
      index.set(alias, { ...e }); // alias → same entity
    }
  }

  // Merge incoming
  for (const inc of incoming) {
    const key = inc.name.toLowerCase();
    const current = index.get(key);
    if (current) {
      // Merge: update timestamps, add new aliases and sources
      current.lastSeenAt = Math.max(current.lastSeenAt, inc.lastSeenAt);
      current.mentionCount += inc.mentionCount;
      for (const alias of inc.aliases) {
        if (!current.aliases.includes(alias)) {
          current.aliases.push(alias);
        }
      }
      for (const cid of inc.sourceChunkIds) {
        if (!current.sourceChunkIds.includes(cid)) {
          current.sourceChunkIds.push(cid);
        }
      }
    } else {
      // New entity
      index.set(key, { ...inc });
    }
  }

  // Deduplicate: return unique entities by id
  const seen = new Set<string>();
  const out: Entity[] = [];
  for (const entity of index.values()) {
    if (!seen.has(entity.id)) {
      seen.add(entity.id);
      out.push(entity);
    }
  }
  return out;
}

// -----------------------------------------------------------------
// Cross-Session Topic Linking
// -----------------------------------------------------------------

/**
 * Find topic links between a new chunk and existing chunks from other sessions.
 * Uses embedding cosine similarity to detect when the same topic appears in
 * different conversations.
 */
export async function findTopicLinks(params: {
  chunkId: string;
  chunkEmbedding: number[];
  existingChunks: ReadonlyArray<{
    chunkId: string;
    embedding: number[];
    sessionId?: string;
  }>;
  threshold?: number;
}): Promise<TopicLink[]> {
  const threshold = params.threshold ?? 0.7; // Higher than epoch segmentation — we want strong matches
  const links: TopicLink[] = [];

  for (const existing of params.existingChunks) {
    if (existing.chunkId === params.chunkId) {
      continue;
    }
    if (!existing.embedding || existing.embedding.length !== params.chunkEmbedding.length) {
      continue;
    }

    const sim = cosineSimilarity(params.chunkEmbedding, existing.embedding);
    if (sim >= threshold) {
      links.push({
        sourceChunkId: params.chunkId,
        targetChunkId: existing.chunkId,
        similarity: sim,
        createdAt: Date.now(),
      });
    }
  }

  if (links.length > 0) {
    l3debug(
      `findTopicLinks: ${links.length} link(s) found for chunk ${params.chunkId} (threshold=${threshold})`,
    );
  }

  return links;
}

// -----------------------------------------------------------------
// Dynamic Importance Scoring
// -----------------------------------------------------------------

/**
 * Apply dynamic importance adjustments based on retrieval signals.
 *
 * The scoring model is inspired by FSRS (Free Spaced Repetition Scheduler):
 * - Facts that are retrieved frequently get their importance boosted,
 *   reflecting their ongoing relevance.
 * - Facts that haven't been retrieved in a long time get a small decay,
 *   but never below their original extraction importance.
 * - Significant facts (user said "remember this") decay 2.7× slower.
 *
 * This runs during consolidation, not during retrieval — so it's
 * eventually consistent, not latency-sensitive.
 */
export function adjustImportance(params: {
  facts: ReadonlyArray<LongTermFact>;
  signals: ReadonlyMap<string, RetrievalSignal>;
  now?: number;
  decayHalfLifeDays?: number;
  boostPerRecall?: number;
  maxBoost?: number;
}): LongTermFact[] {
  const now = params.now ?? Date.now();
  const halfLifeDays = params.decayHalfLifeDays ?? 30;
  const boostPerRecall = params.boostPerRecall ?? 0.02;
  const maxBoost = params.maxBoost ?? 0.3;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  return params.facts.map((fact) => {
    const signal = params.signals.get(fact.id);
    const baseImportance = fact.importance;

    // Decay: exponential decay from last confirmation
    const daysSinceConfirmation = (now - fact.lastConfirmedAt) / MS_PER_DAY;
    const decayRate = fact.significant ? 2.7 : 1; // Significant facts decay slower
    const decayFactor = 0.5 ** (daysSinceConfirmation / (halfLifeDays * decayRate));
    const decayedImportance = baseImportance * (0.7 + 0.3 * decayFactor); // Never below 70% of original

    // Boost: additive based on recent retrieval count
    let boost = 0;
    if (signal) {
      boost = Math.min(maxBoost, signal.recallCount * boostPerRecall);
      // Extra boost for very recent retrievals
      const daysSinceLastRecall = (now - signal.lastRecalledAt) / MS_PER_DAY;
      if (daysSinceLastRecall < 7) {
        boost *= 1.5; // 50% recency bonus
      }
    }

    const newImportance = Math.min(1, decayedImportance + boost);

    // Only update if changed meaningfully (> 0.01 delta)
    if (Math.abs(newImportance - baseImportance) < 0.01) {
      return fact;
    }

    return {
      ...fact,
      importance: Math.round(newImportance * 1000) / 1000, // 3 decimal places
    };
  });
}

/**
 * Record a retrieval signal for dynamic importance scoring.
 * Called by the retrieval pipeline each time a fact is surfaced in top-K results.
 */
export function recordRetrievalSignals(
  existing: Map<string, RetrievalSignal>,
  retrievedFactIds: ReadonlyArray<string>,
  now?: number,
): Map<string, RetrievalSignal> {
  const ts = now ?? Date.now();
  const updated = new Map(existing);

  for (const id of retrievedFactIds) {
    const current = updated.get(id);
    if (current) {
      updated.set(id, {
        factId: id,
        recallCount: current.recallCount + 1,
        lastRecalledAt: ts,
        firstRecalledAt: current.firstRecalledAt,
      });
    } else {
      updated.set(id, {
        factId: id,
        recallCount: 1,
        lastRecalledAt: ts,
        firstRecalledAt: ts,
      });
    }
  }

  return updated;
}
