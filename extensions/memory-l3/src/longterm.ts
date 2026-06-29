import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type ConsolidationCandidate,
  type ConsolidationConfig,
  DEFAULT_CONSOLIDATION_CONFIG,
  type VerificationResult,
  runVerificationGate,
  selectPromotable,
} from "./consolidation.js";
import { adjustImportance } from "./entities.js";
import type { LlmCaller } from "./llm.js";
import { cosineSimilarity, jaccard, tokenize } from "./scoring.js";
import type { Storage } from "./storage.js";
import type { LongTermFact, LongTermFrontmatter } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEBUG_ENABLED = process.env.OPENCLAW_MEMORY_L3_DEBUG === "1";
function l3debug(msg: string): void {
  if (DEBUG_ENABLED) {
    console.error(`[memory-l3/longterm] ${msg}`);
  }
}

export type LongTermConfig = {
  /**
   * After this many ms without re-confirmation, an active long-term fact is
   * archived. Archived facts are kept on disk for forensics but excluded
   * from active retrieval.
   */
  maxAgeWithoutConfirmMs: number;
  /**
   * Multiplier applied to `maxAgeWithoutConfirmMs` when archiving would drop
   * the last active fact from its epoch cluster (facts that first appeared on
   * the same day). Prevents "Region Wipe-out" where an entire topic
   * disappears at once because all its facts age out in the same pass.
   * Set to 1.0 to disable epoch-aware grace.
   * Default: 1.5 (50% extension).
   */
  epochGraceMultiplier: number;
  /**
   * Jaccard similarity threshold for semantic dedup during consolidation.
   * When a new promotion candidate's jaccard similarity with an existing
   * active fact exceeds this threshold, the older (lower-importance) fact
   * is archived as semantically redundant. Inspired by FSFM's
   * redundancy-based forgetting (cosine > 0.95 → demote).
   *
   * We use jaccard (0-1) instead of cosine similarity because L3 prose
   * facts are short enough that lexical overlap is a strong signal,
   * and it avoids the cost of embedding computation.
   *
   * Set to 1.0 to disable semantic dedup.
   * Default: 0.75.
   */
  semanticDedupThreshold: number;
};

export const DEFAULT_LONG_TERM_CONFIG: LongTermConfig = {
  maxAgeWithoutConfirmMs: 60 * MS_PER_DAY,
  epochGraceMultiplier: 1.5,
  semanticDedupThreshold: 0.85,
};

export type ConsolidationOutput = {
  /** Candidates that were not previously in long-term and were added. */
  promotedCount: number;
  /** Candidates that already existed; recall/timestamp/source counters bumped. */
  reaffirmedCount: number;
  /** Active facts that aged out and were marked archived in this pass. */
  archivedCount: number;
  /** Active facts that would have aged out but received an epoch-cluster grace extension. */
  epochGraceCount: number;
  /** Archived facts that re-appeared in candidates and were re-activated. */
  unarchivedCount: number;
  /** Facts archived as semantically redundant of a higher-importance fact (FSFM). */
  semanticDedupCount: number;
  /** Candidates blocked by the TRUSTMEM verification gate. */
  blockedCount: number;
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
  /**
   * When provided, additionally write a QMD-friendly snapshot of active
   * long-term facts to `<workspaceDir>/memory/.l3/<YYYY-MM-DD>.md` so
   * memory-core's existing dreaming + retrieval pipeline picks them up
   * without any modification to memory-core source.
   */
  workspaceDir?: string;
  /**
   * Optional LLM caller for the TRUSTMEM 3-axis verification gate.
   * When provided and verification is enabled in consolidationConfig,
   * candidates are verified before promotion.
   */
  llm?: LlmCaller;
  /**
   * Optional embedding provider for pre-computing vectors at promotion time.
   * When provided, promoted/reaffirmed facts get an `embedding` field
   * enabling cosine-similarity semantic dedup and retrieval signals.
   * Falls back to jaccard when unavailable.
   */
  embeddingProvider?: { embedBatch(texts: string[]): Promise<number[][]> };
}): Promise<ConsolidationOutput> {
  const consolidationConfig = params.consolidationConfig ?? DEFAULT_CONSOLIDATION_CONFIG;
  const longTermConfig = params.longTermConfig ?? DEFAULT_LONG_TERM_CONFIG;

  const existing = await params.storage.readLongTerm();
  const merged = new Map<string, LongTermFact>();
  for (const fact of existing.facts) {
    merged.set(fact.dedupKey, fact);
  }

  const promotable = await selectPromotable(params.storage, consolidationConfig);

  // TRUSTMEM 3-axis verification gate (optional — disabled by default)
  const verificationResult = await runVerificationGate({
    candidates: promotable,
    storage: params.storage,
    priorFacts: merged,
    llm: params.llm ?? null,
    config: consolidationConfig.verification ?? {
      enabled: false,
      thresholds: { coverage: 0.7, preservation: 0.7, faithfulness: 0.7 },
    },
  });
  const verifiedPromotable = verificationResult.passed;
  const blockedCount = verificationResult.blockedCount;

  const promotableByKey = new Map(verifiedPromotable.map((c) => [c.dedupKey, c]));

  let promotedCount = 0;
  let reaffirmedCount = 0;
  let unarchivedCount = 0;

  // Collect all facts that need embedding computation.
  const factsNeedingEmbedding: Array<{ dedupKey: string; text: string }> = [];
  const pendingFacts = new Map<string, LongTermFact>();

  for (const candidate of verifiedPromotable) {
    const prior = merged.get(candidate.dedupKey);
    if (!prior) {
      const fact = promote(candidate);
      pendingFacts.set(candidate.dedupKey, fact);
      factsNeedingEmbedding.push({ dedupKey: candidate.dedupKey, text: candidate.text });
      promotedCount += 1;
      continue;
    }
    const reaffirmed = reaffirm(prior, candidate);
    if (prior.archived && !reaffirmed.archived) {
      unarchivedCount += 1;
    } else {
      reaffirmedCount += 1;
    }
    pendingFacts.set(candidate.dedupKey, reaffirmed);
    // Re-compute embedding on reaffirmation (text may have updated)
    if (!reaffirmed.archived) {
      factsNeedingEmbedding.push({ dedupKey: candidate.dedupKey, text: reaffirmed.text });
    }
  }

  // Batch-compute embeddings for all promoted/reaffirmed facts at once.
  if (params.embeddingProvider && factsNeedingEmbedding.length > 0) {
    try {
      const texts = factsNeedingEmbedding.map((f) => f.text);
      const vectors = await params.embeddingProvider.embedBatch(texts);
      for (let i = 0; i < factsNeedingEmbedding.length; i++) {
        const dedupKey = factsNeedingEmbedding[i].dedupKey;
        const fact = pendingFacts.get(dedupKey);
        if (fact && vectors[i]) {
          pendingFacts.set(dedupKey, { ...fact, embedding: vectors[i] });
        }
      }
    } catch (embedErr) {
      // Non-fatal: facts without embeddings fall back to jaccard in dedup
      l3debug(`embedding batch failed, continuing without vectors: ${(embedErr as Error).message}`);
    }
  }

  // Merge pending facts into the merged map
  for (const [key, fact] of pendingFacts) {
    merged.set(key, fact);
  }

  let archivedCount = 0;
  let epochGraceCount = 0;
  let semanticDedupCount = 0;

  // Build a SNAPSHOT of epoch densities BEFORE any archival decisions.
  // Facts that first appeared on the same day likely came from the same
  // consolidation epoch. Dropping the last one means the entire topic
  // disappears at once ("Region Wipe-out" problem). The snapshot must be
  // frozen before the loop so archiving one fact doesn't shift the count
  // for another fact in the same epoch — that caused sequential archivals
  // to incorrectly grant grace to the second-to-last fact.
  const epochPopSnapshot = new Map<string, number>();
  for (const fact of merged.values()) {
    if (fact.archived) {
      continue;
    }
    const epochKey = formatDateString(fact.firstSeenAt);
    epochPopSnapshot.set(epochKey, (epochPopSnapshot.get(epochKey) ?? 0) + 1);
  }

  // Collect all archivable facts first, then decide grace/commit in one pass.
  // This avoids order-dependent grace when multiple facts share an epoch.
  const archivalCandidates: Array<{
    key: string;
    fact: LongTermFact;
    age: number;
    epochKey: string;
  }> = [];
  for (const [key, fact] of merged) {
    if (fact.archived) {
      continue;
    }
    if (promotableByKey.has(key)) {
      continue;
    }
    const age = params.now - fact.lastConfirmedAt;
    if (age < longTermConfig.maxAgeWithoutConfirmMs) {
      continue;
    }
    archivalCandidates.push({ key, fact, age, epochKey: formatDateString(fact.firstSeenAt) });
  }

  // Sort by importance ascending so lower-importance facts archive first.
  // This ensures grace, if granted, protects the most important fact.
  archivalCandidates.sort((a, b) => a.fact.importance - b.fact.importance);

  // Track remaining epoch pop as we commit archivals.
  const remainingEpochPop = new Map(epochPopSnapshot);
  for (const { key, fact, age, epochKey } of archivalCandidates) {
    // Use the FROZEN snapshot for the grace decision, not the running count.
    // This prevents sequential archivals from incorrectly granting grace
    // to a fact that was part of a multi-fact epoch cluster.
    const originalPop = epochPopSnapshot.get(epochKey) ?? 0;
    const pop = remainingEpochPop.get(epochKey) ?? 0;
    // Grace: protect the LAST survivor of a multi-fact epoch cluster from
    // Region Wipe-out. Conditions:
    //   (a) pop == 1 — this is the last fact currently standing
    //   (b) originalPop >= 3 — the epoch was a genuine cluster, not just a
    //       pair. Two-fact epochs don't get grace because a pair doesn't
    //       represent enough topical depth to warrant protection. A single
    //       original fact (solitary epoch) DOES get grace — it's the only
    //       representative of its topic.
    // This means: 2-fact epochs archive both, 3+ epochs protect the last one.
    const isSolitary = originalPop === 1;
    const isLastOfCluster = originalPop >= 3 && pop <= 1;
    if ((isSolitary || isLastOfCluster) && longTermConfig.epochGraceMultiplier > 1) {
      const graceThreshold =
        longTermConfig.maxAgeWithoutConfirmMs * longTermConfig.epochGraceMultiplier;
      if (age < graceThreshold) {
        epochGraceCount += 1;
        continue;
      }
    }
    merged.set(key, archive(fact, params.now));
    archivedCount += 1;
    if (pop > 0) {
      remainingEpochPop.set(epochKey, pop - 1);
    }
  }

  // -----------------------------------------------------------------
  // Semantic dedup (FSFM-inspired redundancy-based forgetting)
  // -----------------------------------------------------------------
  // Runs AFTER archival so it doesn't interfere with epoch-grace logic.
  // Uses cosine similarity on pre-computed embeddings when available,
  // falls back to jaccard for facts without embeddings.
  //
  // When two active facts exceed the similarity threshold, the lower-
  // importance one is archived as redundant. This prevents semantically
  // duplicate facts from accumulating (e.g., "fork is on memory-fork" and
  // "the branch is memory-fork" have different dedupKeys but are
  // semantically identical).
  if (longTermConfig.semanticDedupThreshold < 1) {
    const activeFacts = [...merged.values()].filter((f) => !f.archived);
    if (activeFacts.length >= 2) {
      // Pre-compute jaccard tokens for fallback
      const factTokens = new Map<string, Set<string>>();
      for (const f of activeFacts) {
        factTokens.set(f.dedupKey, tokenize(f.text));
      }

      // For each pair, check if they're semantically redundant.
      // Prefer cosine similarity on embeddings when both facts have them.
      const toArchive = new Set<string>();
      for (let i = 0; i < activeFacts.length; i++) {
        for (let j = i + 1; j < activeFacts.length; j++) {
          const a = activeFacts[i];
          const b = activeFacts[j];
          if (toArchive.has(a.dedupKey) || toArchive.has(b.dedupKey)) {
            continue;
          }

          // Use cosine similarity on embeddings when both facts have them,
          // otherwise fall back to jaccard.
          let sim: number;
          if (
            a.embedding &&
            b.embedding &&
            a.embedding.length > 0 &&
            a.embedding.length === b.embedding.length
          ) {
            sim = cosineSimilarity(a.embedding, b.embedding);
          } else {
            sim = jaccard(factTokens.get(a.dedupKey)!, factTokens.get(b.dedupKey)!);
          }
          if (sim < longTermConfig.semanticDedupThreshold) {
            continue;
          }

          // Archive the lower-importance (or older if tied) fact
          const victim =
            a.importance < b.importance ||
            (a.importance === b.importance && a.firstSeenAt < b.firstSeenAt)
              ? a
              : b;
          toArchive.add(victim.dedupKey);
        }
      }

      for (const dedupKey of toArchive) {
        const fact = merged.get(dedupKey);
        if (fact && !fact.archived) {
          merged.set(dedupKey, archive(fact, params.now));
          semanticDedupCount += 1;
        }
      }
    }
  }

  const orderedFacts = orderFacts([...merged.values()]);

  // -----------------------------------------------------------------
  // Dynamic importance scoring (Phase 3)
  // -----------------------------------------------------------------
  // Adjust fact importance based on retrieval frequency signals.
  // Facts that are frequently recalled get boosted; idle facts decay.
  let adjustedFacts = orderedFacts;
  try {
    const signals = await params.storage.readRetrievalSignals();
    if (signals.length > 0) {
      const signalMap = new Map(signals.map((s) => [s.factId, s]));
      adjustedFacts = adjustImportance({
        facts: orderedFacts,
        signals: signalMap,
        now: params.now,
      });
      const changed = adjustedFacts.filter(
        (f, i) => Math.abs(f.importance - orderedFacts[i].importance) >= 0.01,
      ).length;
      if (changed > 0) {
        l3debug(`dynamic importance: adjusted ${changed}/${orderedFacts.length} facts`);
      }
    }
  } catch (importanceErr) {
    // Non-fatal: proceed with existing importance values
    l3debug(`dynamic importance failed: ${(importanceErr as Error).message}`);
  }

  const frontmatter: LongTermFrontmatter = {
    version: 1,
    agentId: params.agentId,
    lastConsolidatedAt: params.now,
    facts: adjustedFacts,
  };

  await params.storage.writeLongTerm(frontmatter, formatLongTermBody(adjustedFacts));

  if (params.workspaceDir) {
    await writeQmdMirror({
      workspaceDir: params.workspaceDir,
      facts: adjustedFacts,
      now: params.now,
    });
  }

  return {
    promotedCount,
    reaffirmedCount,
    archivedCount,
    epochGraceCount,
    unarchivedCount,
    semanticDedupCount,
    blockedCount,
    activeCount: adjustedFacts.filter((f) => !f.archived).length,
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
    supersededBy: null,
  };
}

/** Revision trail cap: keeps frontmatter bounded for facts whose text churns. */
const FACT_HISTORY_LIMIT = 5;

function reaffirm(prior: LongTermFact, candidate: ConsolidationCandidate): LongTermFact {
  const merged = mergeChunkIds(prior.sourceChunkIds, candidate.sourceChunkIds);
  // EvoMem-style revision trail: when reaffirmation rewrites the canonical
  // text, keep the superseded text (mirrors LongTermTypedFact.history) so
  // drift in prose facts stays inspectable.
  const history: NonNullable<LongTermFact["history"]> = prior.history ? [...prior.history] : [];
  if (prior.text !== candidate.text) {
    history.push({ text: prior.text, supersededAt: candidate.lastConfirmedAt });
    if (history.length > FACT_HISTORY_LIMIT) {
      history.shift();
    }
  }
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
    // Preserve any cross-brain reconciliation mark — re-affirmation alone
    // doesn't resolve a stale-vs-typed contradiction; the reconciler must
    // run again with current data to decide.
    supersededBy: prior.supersededBy ?? null,
    ...(history.length > 0 ? { history } : {}),
  };
}

function archive(fact: LongTermFact, now: number): LongTermFact {
  return { ...fact, archived: true, archivedAt: now };
}

function mergeChunkIds(prior: ReadonlyArray<string>, incoming: ReadonlyArray<string>): string[] {
  const seen = new Set<string>(prior);
  const out: string[] = [...prior];
  for (const id of incoming) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Stable ordering: active facts by importance desc, then archived facts. */
function orderFacts(facts: LongTermFact[]): LongTermFact[] {
  const active = facts.filter((f) => !f.archived).toSorted(byImportanceDesc);
  const archived = facts.filter((f) => f.archived).toSorted(byImportanceDesc);
  return [...active, ...archived];
}

function byImportanceDesc(a: LongTermFact, b: LongTermFact): number {
  if (b.importance !== a.importance) {
    return b.importance - a.importance;
  }
  return a.dedupKey.localeCompare(b.dedupKey);
}

/**
 * Mirror the active long-term tier into a QMD-indexable markdown file at
 * `<workspaceDir>/memory/.l3/<YYYY-MM-DD>.md`. The path is chosen to match
 * memory-core's SHORT_TERM_PATH_RE (`memory/<...>/YYYY-MM-DD.md`) so the
 * existing memory-core indexer + dreaming pipeline picks the facts up
 * automatically, no patches needed. Each fact gets its own H2 heading so
 * QMD chunks them sensibly.
 *
 * Format is plain markdown — NO JSON frontmatter — so memory-core's regular
 * parsers don't fight it. The file is purely a derived artifact of
 * consolidation; user edits will be overwritten on the next pass.
 */
async function writeQmdMirror(params: {
  workspaceDir: string;
  facts: ReadonlyArray<LongTermFact>;
  now: number;
}): Promise<void> {
  const active = params.facts.filter((f) => !f.archived);
  const datePart = formatDateString(params.now);
  const mirrorDir = path.join(params.workspaceDir, "memory", ".l3");
  const mirrorPath = path.join(mirrorDir, `${datePart}.md`);

  if (active.length === 0) {
    // No active facts — leave any prior mirror in place rather than churn it.
    // It will be overwritten on the next consolidation that has facts.
    return;
  }

  await fs.mkdir(mirrorDir, { recursive: true });
  const body = formatQmdMirror(active);
  const tmp = `${mirrorPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, mirrorPath);
}

function formatQmdMirror(facts: ReadonlyArray<LongTermFact>): string {
  const lines: string[] = [
    "# Long-term memory (memory-l3 derived)",
    "",
    "_Auto-generated snapshot of evergreen facts that have promoted into hierarchical-l3's long-term tier. Edits are overwritten on the next consolidation pass._",
    "",
  ];
  for (const fact of facts) {
    const firstSeen = formatDateString(fact.firstSeenAt);
    const lastConfirmed = formatDateString(fact.lastConfirmedAt);
    lines.push(`## ${fact.dedupKey}`);
    lines.push("");
    lines.push(fact.text);
    lines.push("");
    lines.push(
      `_recallCount=${fact.recallCount}, importance=${fact.importance.toFixed(2)}, firstSeen=${firstSeen}, lastConfirmed=${lastConfirmed}_`,
    );
    lines.push("");
  }
  return lines.join("\n");
}

function formatDateString(unixMs: number): string {
  const d = new Date(unixMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function formatLongTermBody(facts: ReadonlyArray<LongTermFact>): string {
  const active = facts.filter((f) => !f.archived);
  const archived = facts.filter((f) => f.archived);
  const lines: string[] = ["## Long-term facts", ""];
  if (active.length === 0) {
    lines.push("(no active long-term facts)");
  } else {
    for (const fact of active) {
      const supersededMark = fact.supersededBy
        ? ` _(superseded by typed fact \`${fact.supersededBy}\`)_`
        : "";
      lines.push(
        `- [${fact.importance.toFixed(2)}] \`${fact.dedupKey}\` — ${fact.text}${supersededMark}`,
      );
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
