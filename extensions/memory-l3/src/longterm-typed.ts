// Typed-fact long-term consolidation — the corpus-callosum bridge for the
// left brain. Walks every L2 chunk's typedFacts[], groups by slot, and
// builds a canonical "current value per slot" view at <root>/longterm-typed.md.
// When a slot's value changes across chunks, the older value is moved into
// `history[]` rather than dropped — this gives retrieval a clean current
// answer plus an audit trail of supersessions.
//
// Mirrors the prose-fact pipeline in longterm.ts but the consolidation
// semantics are different: prose accumulates evidence (recallCount = N
// confirmations), typed tracks drift (history = trail of value changes).

import { randomUUID } from "node:crypto";
import type { Storage } from "./storage.js";
import type { LongTermTypedFact, LongTermTypedFrontmatter, TypedFact } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type LongTermTypedConfig = {
  /**
   * After this many ms without re-confirmation, an active canonical entry
   * is archived. Archived entries are kept on disk for forensics but
   * excluded from active retrieval.
   */
  maxAgeWithoutConfirmMs: number;
  /**
   * Minimum recall (distinct chunks) before a slot becomes canonical.
   * Default 1 — even single-occurrence typed facts get a canonical entry,
   * because they're already verbatim-grounded and useful to surface.
   */
  minRecallCount: number;
};

export const DEFAULT_LONG_TERM_TYPED_CONFIG: LongTermTypedConfig = {
  maxAgeWithoutConfirmMs: 60 * MS_PER_DAY,
  minRecallCount: 1,
};

export type ConsolidateLongTermTypedOutput = {
  /** Slots that didn't exist in the canonical view and were added. */
  promotedCount: number;
  /** Slots whose value changed; previous value moved into history. */
  supersededCount: number;
  /** Slots that already existed with the same value; recall counters bumped. */
  reaffirmedCount: number;
  /** Active canonical entries that aged out and were archived this pass. */
  archivedCount: number;
  /** Archived entries that re-appeared and were re-activated. */
  unarchivedCount: number;
  /** Total active canonical entries after the pass (excludes archived). */
  activeCount: number;
};

type TypedCandidate = {
  slot: string;
  latest: TypedFact;
  firstSeenAt: number;
  recallCount: number;
  sourceChunkIds: string[];
  /** Distinct values seen with timestamps, oldest first, EXCLUDING `latest`. */
  prior: Array<{ value: string; createdAt: number }>;
};

/**
 * Run a typed-fact consolidation pass. Aggregates typed facts across chunks,
 * detects value changes per slot, and rewrites longterm-typed.md.
 * Idempotent — safe to call after every chunk write.
 */
export async function consolidateLongTermTyped(params: {
  storage: Storage;
  agentId: string | null;
  now: number;
  config?: LongTermTypedConfig;
}): Promise<ConsolidateLongTermTypedOutput> {
  const config = params.config ?? DEFAULT_LONG_TERM_TYPED_CONFIG;
  const candidates = await aggregateTypedCandidates(params.storage);

  const existing = await params.storage.readLongTermTyped();
  const merged = new Map<string, LongTermTypedFact>(existing.facts.map((f) => [f.slot, f]));

  let promotedCount = 0;
  let supersededCount = 0;
  let reaffirmedCount = 0;
  let unarchivedCount = 0;

  for (const candidate of candidates.values()) {
    if (candidate.recallCount < config.minRecallCount) {
      continue;
    }
    const prior = merged.get(candidate.slot);
    if (!prior) {
      merged.set(candidate.slot, promote(candidate));
      promotedCount += 1;
      continue;
    }
    if (prior.value === candidate.latest.value) {
      const reaffirmed = reaffirm(prior, candidate);
      if (prior.archived && !reaffirmed.archived) {
        unarchivedCount += 1;
      } else {
        reaffirmedCount += 1;
      }
      merged.set(candidate.slot, reaffirmed);
    } else {
      merged.set(candidate.slot, supersede(prior, candidate, params.now));
      supersededCount += 1;
    }
  }

  let archivedCount = 0;
  for (const [slot, fact] of merged) {
    if (fact.archived) {
      continue;
    }
    if (candidates.has(slot)) {
      continue;
    }
    const lastActive = fact.lastVerifiedAt ?? fact.lastConfirmedAt;
    if (params.now - lastActive < config.maxAgeWithoutConfirmMs) {
      continue;
    }
    merged.set(slot, archive(fact, params.now));
    archivedCount += 1;
  }

  const ordered = orderTypedFacts([...merged.values()]);
  const frontmatter: LongTermTypedFrontmatter = {
    version: 1,
    agentId: params.agentId,
    lastConsolidatedAt: params.now,
    facts: ordered,
  };
  await params.storage.writeLongTermTyped(frontmatter, formatBody(ordered));

  return {
    promotedCount,
    supersededCount,
    reaffirmedCount,
    archivedCount,
    unarchivedCount,
    activeCount: ordered.filter((f) => !f.archived).length,
  };
}

async function aggregateTypedCandidates(storage: Storage): Promise<Map<string, TypedCandidate>> {
  const out = new Map<string, TypedCandidate>();
  const paths = await storage.listL2ChunkPaths();
  for (const filePath of paths) {
    const doc = await storage.readL2ChunkAtPath(filePath);
    if (!doc) {
      continue;
    }
    const chunkId = doc.frontmatter.id;
    for (const t of doc.frontmatter.typedFacts ?? []) {
      const cur = out.get(t.slot);
      if (!cur) {
        out.set(t.slot, {
          slot: t.slot,
          latest: t,
          firstSeenAt: t.createdAt,
          recallCount: 1,
          sourceChunkIds: [chunkId],
          prior: [],
        });
        continue;
      }
      cur.recallCount += 1;
      if (!cur.sourceChunkIds.includes(chunkId)) {
        cur.sourceChunkIds.push(chunkId);
      }
      cur.firstSeenAt = Math.min(cur.firstSeenAt, t.createdAt);
      if (t.createdAt > cur.latest.createdAt) {
        if (t.value !== cur.latest.value) {
          cur.prior.push({ value: cur.latest.value, createdAt: cur.latest.createdAt });
        }
        cur.latest = t;
      } else if (t.value !== cur.latest.value) {
        cur.prior.push({ value: t.value, createdAt: t.createdAt });
      }
    }
  }
  return out;
}

function promote(c: TypedCandidate): LongTermTypedFact {
  const history = c.prior
    .slice()
    .toSorted((a, b) => a.createdAt - b.createdAt)
    .map((p) => ({ value: p.value, supersededAt: c.latest.createdAt }));
  return {
    id: `ltt-${randomUUID().slice(0, 8)}`,
    slot: c.slot,
    value: c.latest.value,
    unit: c.latest.unit,
    confidence: c.latest.confidence,
    firstSeenAt: c.firstSeenAt,
    lastConfirmedAt: c.latest.createdAt,
    recallCount: c.recallCount,
    sourceChunkIds: [...c.sourceChunkIds],
    history,
    validFrom: c.firstSeenAt,
    validUntil: null,
    supersededBy: null,
    archived: false,
    archivedAt: null,
    lastVerifiedAt: c.latest.lastVerifiedAt ?? c.latest.createdAt,
  };
}

function reaffirm(prior: LongTermTypedFact, c: TypedCandidate): LongTermTypedFact {
  const merged = mergeChunkIds(prior.sourceChunkIds, c.sourceChunkIds);
  return {
    ...prior,
    confidence: Math.max(prior.confidence, c.latest.confidence),
    firstSeenAt: Math.min(prior.firstSeenAt, c.firstSeenAt),
    lastConfirmedAt: Math.max(prior.lastConfirmedAt, c.latest.createdAt),
    lastVerifiedAt: c.latest.lastVerifiedAt ?? c.latest.createdAt,
    recallCount: merged.length,
    sourceChunkIds: merged,
    validFrom: prior.validFrom,
    validUntil: null,
    supersededBy: null,
    archived: false,
    archivedAt: null,
  };
}

function supersede(prior: LongTermTypedFact, c: TypedCandidate, now: number): LongTermTypedFact {
  const merged = mergeChunkIds(prior.sourceChunkIds, c.sourceChunkIds);
  return {
    id: prior.id,
    slot: prior.slot,
    value: c.latest.value,
    unit: c.latest.unit,
    confidence: c.latest.confidence,
    firstSeenAt: Math.min(prior.firstSeenAt, c.firstSeenAt),
    lastConfirmedAt: c.latest.createdAt,
    lastVerifiedAt: c.latest.lastVerifiedAt ?? c.latest.createdAt,
    recallCount: merged.length,
    sourceChunkIds: merged,
    history: [...prior.history, { value: prior.value, supersededAt: now }],
    validFrom: c.latest.createdAt,
    validUntil: null,
    supersededBy: null,
    archived: false,
    archivedAt: null,
  };
}

function archive(fact: LongTermTypedFact, now: number): LongTermTypedFact {
  return { ...fact, archived: true, archivedAt: now, validUntil: now, supersededBy: null };
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

function orderTypedFacts(facts: LongTermTypedFact[]): LongTermTypedFact[] {
  const active = facts.filter((f) => !f.archived).toSorted(bySlot);
  const archived = facts.filter((f) => f.archived).toSorted(bySlot);
  return [...active, ...archived];
}

function bySlot(a: LongTermTypedFact, b: LongTermTypedFact): number {
  return a.slot.localeCompare(b.slot);
}

function formatBody(facts: ReadonlyArray<LongTermTypedFact>): string {
  const active = facts.filter((f) => !f.archived);
  const archived = facts.filter((f) => f.archived);
  const lines: string[] = ["## Typed facts (canonical)", ""];
  if (active.length === 0) {
    lines.push("(no active typed facts)");
  } else {
    for (const f of active) {
      const unit = f.unit ? ` ${f.unit}` : "";
      const hist =
        f.history.length > 0 ? ` _was: ${f.history.map((h) => h.value).join(" → ")}_` : "";
      lines.push(
        `- \`${f.slot}\` = \`${f.value}\`${unit} (recall ${f.recallCount}, conf ${f.confidence.toFixed(2)})${hist}`,
      );
    }
  }
  if (archived.length > 0) {
    lines.push("", "## Archived", "");
    for (const f of archived) {
      const archivedDate =
        f.archivedAt !== null ? new Date(f.archivedAt).toISOString().slice(0, 10) : "?";
      lines.push(`- \`${f.slot}\` = \`${f.value}\` _(archived ${archivedDate})_`);
    }
  }
  return lines.join("\n");
}
