import { randomUUID } from "node:crypto";
import {
  type ConsolidationCandidate,
  type ConsolidationConfig,
  DEFAULT_CONSOLIDATION_CONFIG,
  selectPromotable,
} from "./consolidation.js";
import type { Storage } from "./storage.js";
import type { LongTermFact, LongTermFrontmatter } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type LongTermConfig = {
  /**
   * After this many ms without re-confirmation, an active long-term fact is
   * archived. Archived facts are kept on disk for forensics but excluded
   * from active retrieval.
   */
  maxAgeWithoutConfirmMs: number;
};

export const DEFAULT_LONG_TERM_CONFIG: LongTermConfig = {
  maxAgeWithoutConfirmMs: 60 * MS_PER_DAY,
};

export type ConsolidationOutput = {
  /** Candidates that were not previously in long-term and were added. */
  promotedCount: number;
  /** Candidates that already existed; recall/timestamp/source counters bumped. */
  reaffirmedCount: number;
  /** Active facts that aged out and were marked archived in this pass. */
  archivedCount: number;
  /** Archived facts that re-appeared in candidates and were re-activated. */
  unarchivedCount: number;
  /** Total active facts after the pass (excludes archived). */
  activeCount: number;
};

/**
 * Run a consolidation pass: aggregate L2 candidates, promote new evergreen
 * facts, re-affirm existing ones, archive stale active facts, and persist
 * `<root>/longterm.md`. Idempotent — safe to call repeatedly.
 */
export async function consolidateLongTerm(params: {
  storage: Storage;
  agentId: string | null;
  now: number;
  consolidationConfig?: ConsolidationConfig;
  longTermConfig?: LongTermConfig;
}): Promise<ConsolidationOutput> {
  const consolidationConfig = params.consolidationConfig ?? DEFAULT_CONSOLIDATION_CONFIG;
  const longTermConfig = params.longTermConfig ?? DEFAULT_LONG_TERM_CONFIG;

  const promotable = await selectPromotable(params.storage, consolidationConfig);
  const promotableByKey = new Map(promotable.map((c) => [c.dedupKey, c]));

  const existing = await params.storage.readLongTerm();
  const merged = new Map<string, LongTermFact>();
  for (const fact of existing.facts) {
    merged.set(fact.dedupKey, fact);
  }

  let promotedCount = 0;
  let reaffirmedCount = 0;
  let unarchivedCount = 0;

  for (const candidate of promotable) {
    const prior = merged.get(candidate.dedupKey);
    if (!prior) {
      merged.set(candidate.dedupKey, promote(candidate));
      promotedCount += 1;
      continue;
    }
    const reaffirmed = reaffirm(prior, candidate);
    if (prior.archived && !reaffirmed.archived) {
      unarchivedCount += 1;
    } else {
      reaffirmedCount += 1;
    }
    merged.set(candidate.dedupKey, reaffirmed);
  }

  let archivedCount = 0;
  for (const [key, fact] of merged) {
    if (fact.archived) continue;
    if (promotableByKey.has(key)) continue; // already re-affirmed this pass
    if (params.now - fact.lastConfirmedAt < longTermConfig.maxAgeWithoutConfirmMs) continue;
    merged.set(key, archive(fact, params.now));
    archivedCount += 1;
  }

  const orderedFacts = orderFacts([...merged.values()]);
  const frontmatter: LongTermFrontmatter = {
    version: 1,
    agentId: params.agentId,
    lastConsolidatedAt: params.now,
    facts: orderedFacts,
  };

  await params.storage.writeLongTerm(frontmatter, formatLongTermBody(orderedFacts));

  return {
    promotedCount,
    reaffirmedCount,
    archivedCount,
    unarchivedCount,
    activeCount: orderedFacts.filter((f) => !f.archived).length,
  };
}

function promote(candidate: ConsolidationCandidate): LongTermFact {
  return {
    id: `lt-${randomUUID().slice(0, 8)}`,
    text: candidate.text,
    dedupKey: candidate.dedupKey,
    importance: candidate.importance,
    firstSeenAt: candidate.firstSeenAt,
    lastConfirmedAt: candidate.lastConfirmedAt,
    recallCount: candidate.recallCount,
    sourceChunkIds: [...candidate.sourceChunkIds],
    archived: false,
    archivedAt: null,
  };
}

function reaffirm(prior: LongTermFact, candidate: ConsolidationCandidate): LongTermFact {
  const merged = mergeChunkIds(prior.sourceChunkIds, candidate.sourceChunkIds);
  return {
    id: prior.id,
    text: candidate.text,
    dedupKey: prior.dedupKey,
    importance: Math.max(prior.importance, candidate.importance),
    firstSeenAt: Math.min(prior.firstSeenAt, candidate.firstSeenAt),
    lastConfirmedAt: Math.max(prior.lastConfirmedAt, candidate.lastConfirmedAt),
    recallCount: merged.length,
    sourceChunkIds: merged,
    archived: false,
    archivedAt: null,
  };
}

function archive(fact: LongTermFact, now: number): LongTermFact {
  return { ...fact, archived: true, archivedAt: now };
}

function mergeChunkIds(prior: ReadonlyArray<string>, incoming: ReadonlyArray<string>): string[] {
  const seen = new Set<string>(prior);
  const out: string[] = [...prior];
  for (const id of incoming) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Stable ordering: active facts by importance desc, then archived facts. */
function orderFacts(facts: LongTermFact[]): LongTermFact[] {
  const active = facts.filter((f) => !f.archived).sort(byImportanceDesc);
  const archived = facts.filter((f) => f.archived).sort(byImportanceDesc);
  return [...active, ...archived];
}

function byImportanceDesc(a: LongTermFact, b: LongTermFact): number {
  if (b.importance !== a.importance) return b.importance - a.importance;
  return a.dedupKey.localeCompare(b.dedupKey);
}

function formatLongTermBody(facts: ReadonlyArray<LongTermFact>): string {
  const active = facts.filter((f) => !f.archived);
  const archived = facts.filter((f) => f.archived);
  const lines: string[] = ["## Long-term facts", ""];
  if (active.length === 0) {
    lines.push("(no active long-term facts)");
  } else {
    for (const fact of active) {
      lines.push(`- [${fact.importance.toFixed(2)}] \`${fact.dedupKey}\` — ${fact.text}`);
    }
  }
  if (archived.length > 0) {
    lines.push("", "## Archived", "");
    for (const fact of archived) {
      const archivedDate =
        fact.archivedAt !== null ? new Date(fact.archivedAt).toISOString().slice(0, 10) : "?";
      lines.push(
        `- [${fact.importance.toFixed(2)}] \`${fact.dedupKey}\` — ${fact.text} _(archived ${archivedDate})_`,
      );
    }
  }
  return lines.join("\n");
}
