/**
 * Fact-graph dependency edges (ARCH-1) — deterministic `entity-shares` emitter.
 *
 * `supersedes` edges are collected inline by `consolidateLongTermTyped` at each
 * value transition (`slot@value` state pairs, new→prior orientation). This
 * module owns the second emitter: a post-merge pass over the final canonical
 * typed set that links facts sharing an extracted entity, reusing the
 * `entities.ts` heuristics (no LLM anywhere in the loop).
 *
 * Endpoint identity (probe amendment 2026-09-21): bare slots — the typed tier
 * has no dedupKey, and slot never rewrites on merge by construction.
 */

import { extractEntitiesFromFacts } from "./entities.js";
import type { FactEdge, LongTermTypedFact } from "./types.js";

/** Minimum Jaccard-style entity-set overlap for an entity-shares edge. */
export const ENTITY_SHARES_MIN_OVERLAP = 0.3;

/**
 * Maximum pairwise edges emitted per entity bucket. Applied PER ENTITY — not
 * per pair and not globally: a misapplied cap produced a 5,568-edge near-clique
 * in the probe spike. The cap is the load-bearing volume bound; the J-gate is
 * non-discriminating for single-entity facts (J=1.0 by construction).
 */
export const ENTITY_SHARES_MAX_PAIRS_PER_ENTITY = 8;

/** Deterministic chunkId for the entity-extraction reuse pass. */
const EDGE_PASS_CHUNK_ID = "fact-edge-pass";

function factText(fact: LongTermTypedFact): string {
  return fact.unit ? `${fact.slot} = ${fact.value} ${fact.unit}` : `${fact.slot} = ${fact.value}`;
}

/**
 * Extract the normalized entity-name set of one canonical typed fact, reusing
 * `extractEntitiesFromFacts` on a synthesized prose fact (slot = value text)
 * plus typed view so both heuristic branches (IP/URL-host/path-basename and
 * prose hostname/project/docker patterns) contribute.
 */
function entityNamesOf(fact: LongTermTypedFact, now: number): Set<string> {
  const entities = extractEntitiesFromFacts({
    facts: [
      {
        id: fact.id,
        text: factText(fact),
        importance: fact.confidence,
        createdAt: fact.lastConfirmedAt,
        dedupKey: fact.slot,
      },
    ],
    typedFacts: [
      {
        id: fact.id,
        slot: fact.slot,
        value: fact.value,
        sourceSpan: fact.provenance?.quote ?? factText(fact),
        unit: fact.unit,
        confidence: fact.confidence,
        createdAt: fact.lastConfirmedAt,
      },
    ],
    agentId: null,
    chunkId: EDGE_PASS_CHUNK_ID,
    now,
  });
  return new Set(entities.map((e) => e.name.trim().toLowerCase()));
}

/**
 * Emit `entity-shares` edges over the final canonical typed set.
 *
 * - Archived facts never feed buckets (only the canonical unarchived set).
 * - Singleton entity buckets are skipped.
 * - A pair is emitted only when the two facts' entity sets overlap by
 *   ≥ ENTITY_SHARES_MIN_OVERLAP (Jaccard); confidence is that overlap value.
 * - Each entity bucket contributes at most ENTITY_SHARES_MAX_PAIRS_PER_ENTITY
 *   edges, enumerated in sorted-slot order for determinism.
 * - Endpoints are stored sorted (a < b) so direction is canonical; the edge is
 *   semantically undirected.
 */
export function emitEntityShareEdges(
  facts: ReadonlyArray<LongTermTypedFact>,
  epoch: number,
): FactEdge[] {
  const entitySets = new Map<string, Set<string>>();
  for (const fact of facts) {
    if (fact.archived) {
      continue;
    }
    entitySets.set(fact.slot, entityNamesOf(fact, epoch));
  }

  // entity name → slots mentioning it
  const buckets = new Map<string, string[]>();
  for (const [slot, names] of entitySets) {
    for (const name of names) {
      const bucket = buckets.get(name) ?? [];
      bucket.push(slot);
      buckets.set(name, bucket);
    }
  }

  const edges: FactEdge[] = [];
  for (const slots of buckets.values()) {
    if (slots.length < 2) {
      continue;
    }
    slots.sort();
    let emitted = 0;
    for (let i = 0; i < slots.length && emitted < ENTITY_SHARES_MAX_PAIRS_PER_ENTITY; i++) {
      for (let j = i + 1; j < slots.length && emitted < ENTITY_SHARES_MAX_PAIRS_PER_ENTITY; j++) {
        const a = slots[i]!;
        const b = slots[j]!;
        const setA = entitySets.get(a)!;
        const setB = entitySets.get(b)!;
        let intersection = 0;
        for (const name of setA) {
          if (setB.has(name)) {
            intersection += 1;
          }
        }
        const union = setA.size + setB.size - intersection;
        const overlap = union > 0 ? intersection / union : 0;
        if (overlap < ENTITY_SHARES_MIN_OVERLAP) {
          continue;
        }
        const [source, target] = a < b ? [a, b] : [b, a];
        edges.push({
          sourceKey: source,
          targetKey: target,
          edgeType: "entity-shares",
          confidence: overlap,
          createdEpoch: epoch,
        });
        emitted += 1;
      }
    }
  }
  return edges;
}
