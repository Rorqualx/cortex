import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type ConsolidationCandidate,
  type ConsolidationConfig,
  DEFAULT_CONSOLIDATION_CONFIG,
  selectPromotable,
} from "./consolidation.js";
import { jaccard, tokenize } from "./scoring.js";
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
  let epochGraceCount = 0;
  let semanticDedupCount = 0;

  // Build a map of active facts by firstSeenAt date string for epoch cluster
  // density checks. Facts that first appeared on the same day likely came from
  // the same consolidation epoch — dropping the last one means the entire
  // topic disappears at once ("Region Wipe-out" problem).
  const activeByEpoch = new Map<string, number>();
  for (const fact of merged.values()) {
    if (fact.archived) continue;
    const epochKey = formatDateString(fact.firstSeenAt);
    activeByEpoch.set(epochKey, (activeByEpoch.get(epochKey) ?? 0) + 1);
  }

  for (const [key, fact] of merged) {
    if (fact.archived) continue;
    if (promotableByKey.has(key)) continue; // already re-affirmed this pass
    const age = params.now - fact.lastConfirmedAt;
    if (age < longTermConfig.maxAgeWithoutConfirmMs) continue;

    // Epoch cluster awareness: if archiving would drop the last active fact
    // from its first-seen epoch, apply a grace multiplier to the threshold.
    // This prevents entire topic clusters from evaporating simultaneously.
    const epochKey = formatDateString(fact.firstSeenAt);
    const epochPop = activeByEpoch.get(epochKey) ?? 0;
    if (epochPop <= 1 && longTermConfig.epochGraceMultiplier > 1) {
      const graceThreshold =
        longTermConfig.maxAgeWithoutConfirmMs * longTermConfig.epochGraceMultiplier;
      if (age < graceThreshold) {
        epochGraceCount += 1;
        continue;
      }
    }

    merged.set(key, archive(fact, params.now));
    archivedCount += 1;
    // Update epoch density map since this fact is now archived
    if (epochPop > 0) {
      activeByEpoch.set(epochKey, epochPop - 1);
    }
  }

  // -----------------------------------------------------------------
  // Semantic dedup (FSFM-inspired redundancy-based forgetting)
  // -----------------------------------------------------------------
  // Runs AFTER archival so it doesn't interfere with epoch-grace logic.
  // When two active facts have high jaccard similarity, the lower-
  // importance one is archived as redundant. This prevents semantically
  // duplicate facts from accumulating (e.g., "fork is on memory-fork" and
  // "the branch is memory-fork" have different dedupKeys but are
  // semantically identical).
  if (longTermConfig.semanticDedupThreshold < 1.0) {
    const activeFacts = [...merged.values()].filter((f) => !f.archived);
    if (activeFacts.length >= 2) {
      // Pre-tokenize
      const factTokens = new Map<string, Set<string>>();
      for (const f of activeFacts) {
        factTokens.set(f.dedupKey, tokenize(f.text));
      }

      // For each pair, check if they're semantically redundant
      const toArchive = new Set<string>();
      for (let i = 0; i < activeFacts.length; i++) {
        for (let j = i + 1; j < activeFacts.length; j++) {
          const a = activeFacts[i];
          const b = activeFacts[j];
          if (toArchive.has(a.dedupKey) || toArchive.has(b.dedupKey)) continue;

          const sim = jaccard(factTokens.get(a.dedupKey)!, factTokens.get(b.dedupKey)!);
          if (sim < longTermConfig.semanticDedupThreshold) continue;

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
  const frontmatter: LongTermFrontmatter = {
    version: 1,
    agentId: params.agentId,
    lastConsolidatedAt: params.now,
    facts: orderedFacts,
  };

  await params.storage.writeLongTerm(frontmatter, formatLongTermBody(orderedFacts));

  if (params.workspaceDir) {
    await writeQmdMirror({
      workspaceDir: params.workspaceDir,
      facts: orderedFacts,
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
    supersededBy: null,
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
    // Preserve any cross-brain reconciliation mark — re-affirmation alone
    // doesn't resolve a stale-vs-typed contradiction; the reconciler must
    // run again with current data to decide.
    supersededBy: prior.supersededBy ?? null,
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
