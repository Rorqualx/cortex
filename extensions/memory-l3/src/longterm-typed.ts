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
import type {
  LongTermTypedFact,
  LongTermTypedFrontmatter,
  SourceTrust,
  TypedFact,
  VolatilityClass,
} from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Volatility-class derivation — keyword heuristics on slot + value
// ---------------------------------------------------------------------------

/** Tokens in the slot or value that suggest a volatile fact. */
const VOLATILE_TOKENS = [
  "api",
  "config",
  "version",
  "path",
  "port",
  "endpoint",
  "url",
  "host",
  "ip",
  "token",
  "key",
  "secret",
  "password",
  "credential",
  "binary",
  "executable",
  "docker",
  "container",
  "pod",
  "build",
  "cache",
  "temp",
  "tmp",
  "pid",
  "runtime",
  "process",
  "session",
];

/** Tokens in the slot that suggest a stable fact. */
const STABLE_SLOT_TOKENS = [
  "preference",
  "name",
  "relationship",
  "birthday",
  "anniversary",
  "personality",
  "like",
  "dislike",
  "favorite",
  "habit",
  "allergy",
  "pronoun",
  "gender",
  "language",
  "timezone",
  "location",
];

/**
 * Derive a volatility class from the slot name and value using keyword
 * heuristics. Volatile tokens (api, config, version, path, etc.) → volatile;
 * stable slot tokens (preference, name, relationship, etc.) → stable;
 * everything else → semi-volatile.
 *
 * Matches on token boundaries (split on : _ -) rather than naive substring
 * to avoid false positives like "ip" matching "relationship".
 */
export function deriveVolatilityClass(slot: string, _value: string): VolatilityClass {
  const lowerSlot = slot.toLowerCase();
  const tokens = lowerSlot.split(/[:_-]+/);

  // Check volatile tokens first (more specific)
  for (const token of VOLATILE_TOKENS) {
    for (const slotToken of tokens) {
      if (slotToken === token) return "volatile";
    }
  }

  // Check stable slot tokens
  for (const token of STABLE_SLOT_TOKENS) {
    for (const slotToken of tokens) {
      if (slotToken === token) return "stable";
    }
  }

  return "semi-volatile";
}

// ---------------------------------------------------------------------------
// QW-2: Source-trust inference from TypedFact metadata
// ---------------------------------------------------------------------------

/**
 * Infer a SourceTrust level from a TypedFact's metadata.
 *
 * Heuristic:
 * - `statedBy === "user"` or `"human"` → "user" (highest authority)
 * - `statedBy` matches tool/web patterns ("web-search", "http-request", "browser") → "web"
 * - `statedBy === "assistant"` or `"agent"` → "agent-inferred"
 * - Unknown/absent → defaults to "user" (most typed facts originate from user conversation)
 */
export function inferSourceTrust(t: TypedFact): SourceTrust {
  const statedBy = t.statedBy;
  if (!statedBy) {
    return "user"; // Backward compat: most typed facts originate from user conversation
  }
  const lower = statedBy.toLowerCase();
  if (lower === "user" || lower === "human") {
    return "user";
  }
  // Tool/web output patterns
  const webPatterns = ["web", "search", "http", "browser", "scraper", "url", "fetch"];
  for (const pattern of webPatterns) {
    if (lower.includes(pattern)) {
      return "web";
    }
  }
  // Agent/assistant inferred
  if (lower === "assistant" || lower === "agent" || lower === "ai" || lower === "model") {
    return "agent-inferred";
  }
  // Unknown source — treat as untrusted
  return "untrusted";
}

// ---------------------------------------------------------------------------
// QW-1: Per-fact perishability coefficient (ScrubJay-MEM-inspired)
// ---------------------------------------------------------------------------

/** Perishability modifiers for high-sensitivity slots. These are the slots
 * whose values change frequently — temporal/financial/operational data. */
const PERISHABLE_SLOT_FRAGMENTS = [
  "balance",
  "uptime",
  "load",
  "usage",
  "count",
  "total",
  "current",
  "temp",
  "cpu",
  "memory",
  "mem",
  "ram",
  "disk",
  "space",
  "latency",
  "ping",
  "status",
  "state",
  "health",
];

/** Slots that are durable — their values rarely change once set. */
const DURABLE_SLOT_FRAGMENTS = [
  "name",
  "birthday",
  "anniversary",
  "allergy",
  "pronoun",
  "gender",
  "language",
  "timezone",
  "location",
  "address",
  "phone",
  "email",
];

/**
 * Derive a per-fact perishability coefficient (0..1) from slot name,
 * value, volatility class, and source trust.
 *
 * Returns 1.0 (neutral) by default. Lower values mean the fact perishes
 * faster — applied as a multiplier in the FSRS forgetting curve:
 *   R(t) = exp(-(w2 · vc · dd · (2 - π) · t) / S)
 * where π is perishability. So π=0.5 doubles the effective decay rate,
 * π=1.0 leaves it unchanged.
 *
 * Heuristic factors:
 * - Volatile slots → π -= 0.3 (more perishable)
 * - Stable slots → π += 0.2 (more durable)
 * - Perishable slot fragments (balance, uptime, etc.) → π -= 0.2
 * - Durable slot fragments (name, birthday, etc.) → π += 0.15
 * - Untrusted source → π -= 0.15 (less confident in durability)
 * - User-stated → π += 0.1 (more durable — user authority)
 * Clamped to [0.2, 1.2].
 */
export function derivePerishability(params: {
  slot: string;
  value: string;
  volatilityClass: VolatilityClass;
  sourceTrust?: SourceTrust;
}): number {
  let pi = 1.0;
  const lowerSlot = params.slot.toLowerCase();
  const slotTokens = lowerSlot.split(/[:_-]+/);

  // Volatility class adjustment
  if (params.volatilityClass === "volatile") {
    pi -= 0.3;
  } else if (params.volatilityClass === "stable") {
    pi += 0.2;
  }

  // Perishable slot fragments
  for (const frag of PERISHABLE_SLOT_FRAGMENTS) {
    if (slotTokens.some((t) => t === frag || t.includes(frag))) {
      pi -= 0.2;
      break; // Only apply once
    }
  }

  // Durable slot fragments
  for (const frag of DURABLE_SLOT_FRAGMENTS) {
    if (slotTokens.some((t) => t === frag || t.includes(frag))) {
      pi += 0.15;
      break; // Only apply once
    }
  }

  // Source trust adjustment
  switch (params.sourceTrust) {
    case "user":
      pi += 0.1;
      break;
    case "untrusted":
      pi -= 0.15;
      break;
    case "web":
      pi -= 0.05;
      break;
    // agent-inferred: no adjustment
  }

  return Math.max(0.2, Math.min(1.2, Math.round(pi * 100) / 100));
}

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
  /**
   * Maximum number of newly promoted slots per epoch. Derived from J-space
   * capacity research (~20-40 verbalizable concepts). Promoting more than
   * this floods the next session's context injection and reduces recall
   * quality for all facts. Capped candidates remain in L2 and re-surface
   * next epoch — no data loss. Default 30.
   */
  maxPromotePerEpoch: number;
  /**
   * Weight of retrieval-frequency signal in J-space promotion scoring.
   * Facts that are frequently retrieved get a score boost proportional to
   * their retrieval hit count × this weight. Default 0.1 — a gentle nudge
   * that breaks ties in favor of demonstrably useful facts without
   * overwhelming the recallCount × confidence signal.
   *
   * Inspired by UniMem's recurrence-frequency principle (arXiv:2607.03190).
   */
  retrievalHitBoost?: number;
};

export const DEFAULT_LONG_TERM_TYPED_CONFIG: LongTermTypedConfig = {
  maxAgeWithoutConfirmMs: 60 * MS_PER_DAY,
  minRecallCount: 1,
  maxPromotePerEpoch: 30,
  retrievalHitBoost: 0.1,
};

/**
 * QW-3 (LeanMem-inspired): Age threshold below which stable facts are
 * skipped during consolidation maintenance. Stable facts (preferences,
 * names, relationships) don't need regular re-evaluation — they don't
 * drift. Only re-process if the value changed (supersession) or if the
 * fact is single-source (recallCount === 1, not yet consolidated).
 */
const STABLE_SKIP_AGE_MS = 30 * MS_PER_DAY;

/**
 * Whether a long-term typed fact is stable enough to skip maintenance.
 * Returns true when ALL of:
 * - volatilityClass is "stable"
 * - recallCount > 1 (already consolidated from multiple sources)
 * - lastVerifiedAt is within STABLE_SKIP_AGE_MS (recently verified)
 */
function shouldSkipStableMaintenance(fact: LongTermTypedFact, now: number): boolean {
  if (fact.volatilityClass !== "stable") return false;
  if (fact.recallCount <= 1) return false;
  const lastVerified = fact.lastVerifiedAt ?? fact.lastConfirmedAt;
  if (now - lastVerified < STABLE_SKIP_AGE_MS) return true;
  return false;
}

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
  /** Chunk ID of the L2 chunk that produced `latest`. */
  latestChunkId: string;
  firstSeenAt: number;
  recallCount: number;
  sourceChunkIds: string[];
  /** Distinct values seen with timestamps, oldest first, EXCLUDING `latest`. */
  prior: Array<{ value: string; createdAt: number }>;
  /**
   * All L2 typed fact IDs observed for this slot across chunks.
   * Used for retrieval-signal lookup during J-space capacity scoring.
   */
  factIds: string[];
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
  /** Session ID to stamp on newly promoted facts for provenance. */
  sessionId?: string;
  /** Model/provider identifier to stamp on newly promoted facts for provenance. */
  modelId?: string;
}): Promise<ConsolidateLongTermTypedOutput> {
  const config = params.config ?? DEFAULT_LONG_TERM_TYPED_CONFIG;
  const candidates = await aggregateTypedCandidates(params.storage);

  const existing = await params.storage.readLongTermTyped();
  const merged = new Map<string, LongTermTypedFact>(existing.facts.map((f) => [f.slot, f]));

  // QW-2 (UniMem recurrence-frequency): read retrieval signals so that facts
  // with demonstrated retrieval utility get a promotion-score boost in the
  // J-space capacity cap. Non-fatal — if signals can't be read, the boost is 0.
  let retrievalHitMap = new Map<string, number>();
  try {
    const signals = await params.storage.readRetrievalSignals();
    retrievalHitMap = new Map(signals.map((s) => [s.factId, s.recallCount]));
  } catch {
    // Retrieval signals unavailable — boost defaults to 0.
  }

  let promotedCount = 0;
  let supersededCount = 0;
  let reaffirmedCount = 0;
  let unarchivedCount = 0;
  /** Slots newly promoted this epoch, with candidate fact IDs for retrieval-signal lookup. */
  const newSlotIds: Array<{ slot: string; candidateFactIds: string[] }> = [];

  for (const candidate of candidates.values()) {
    if (candidate.recallCount < config.minRecallCount) {
      continue;
    }
    const prior = merged.get(candidate.slot);
    // QW-3: Skip maintenance for stable, recently-verified facts with
    // multiple sources — UNLESS the value changed (supersession must fire).
    if (
      prior &&
      !prior.archived &&
      prior.value === candidate.latest.value &&
      shouldSkipStableMaintenance(prior, params.now)
    ) {
      continue;
    }
    if (!prior) {
      merged.set(candidate.slot, promote(candidate, params.sessionId, params.modelId));
      promotedCount += 1;
      newSlotIds.push({
        slot: candidate.slot,
        candidateFactIds: candidate.factIds,
      });
      continue;
    }
    if (prior.value === candidate.latest.value) {
      const reaffirmed = reaffirm(prior, candidate, params.sessionId, params.modelId);
      if (prior.archived && !reaffirmed.archived) {
        unarchivedCount += 1;
      } else {
        reaffirmedCount += 1;
      }
      merged.set(candidate.slot, reaffirmed);
    } else {
      merged.set(
        candidate.slot,
        supersede(prior, candidate, params.now, params.sessionId, params.modelId),
      );
      supersededCount += 1;
    }
  }

  // J-space capacity cap: if we promoted more new slots than the verbalizable
  // workspace can hold (~20-40 concepts), keep only the top-N by recallCount *
  // confidence plus a retrieval-frequency boost. The boost uses retrieval
  // signals from L2-level typed fact IDs (the candidate's source facts), since
  // newly promoted facts don't have their own retrieval history yet. Capped
  // candidates remain in L2 and re-surface next epoch.
  const retrievalHitBoost = config.retrievalHitBoost ?? 0;
  if (newSlotIds.length > config.maxPromotePerEpoch) {
    const scored = newSlotIds
      .map((entry) => {
        const fact = merged.get(entry.slot);
        if (!fact) {
          return { slot: entry.slot, score: 0 };
        }
        // Sum retrieval hits across all candidate source fact IDs.
        // This captures how often the L2 version of this fact was retrieved.
        const retrievalHits = entry.candidateFactIds.reduce(
          (sum, fid) => sum + (retrievalHitMap.get(fid) ?? 0),
          0,
        );
        const score = fact.recallCount * fact.confidence + retrievalHits * retrievalHitBoost;
        return { slot: entry.slot, score };
      })
      .toSorted((a, b) => b.score - a.score);
    const keep = new Set(scored.slice(0, config.maxPromotePerEpoch).map((s) => s.slot));
    for (const entry of newSlotIds) {
      if (!keep.has(entry.slot)) {
        merged.delete(entry.slot);
        promotedCount -= 1;
      }
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
    // QW-3: Skip archival check for stable, recently-verified facts.
    if (shouldSkipStableMaintenance(fact, params.now)) {
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
          latestChunkId: chunkId,
          firstSeenAt: t.createdAt,
          recallCount: 1,
          sourceChunkIds: [chunkId],
          prior: [],
          factIds: [t.id],
        });
        continue;
      }
      cur.recallCount += 1;
      if (!cur.factIds.includes(t.id)) {
        cur.factIds.push(t.id);
      }
      if (!cur.sourceChunkIds.includes(chunkId)) {
        cur.sourceChunkIds.push(chunkId);
      }
      cur.firstSeenAt = Math.min(cur.firstSeenAt, t.createdAt);
      if (t.createdAt > cur.latest.createdAt) {
        if (t.value !== cur.latest.value) {
          cur.prior.push({ value: cur.latest.value, createdAt: cur.latest.createdAt });
        }
        cur.latest = t;
        cur.latestChunkId = chunkId;
      } else if (t.value !== cur.latest.value) {
        cur.prior.push({ value: t.value, createdAt: t.createdAt });
      }
    }
  }
  return out;
}

function promote(c: TypedCandidate, sessionId?: string, modelId?: string): LongTermTypedFact {
  const history = c.prior
    .slice()
    .toSorted((a, b) => a.createdAt - b.createdAt)
    .map((p) => ({ value: p.value, supersededAt: c.latest.createdAt }));
  const fact: LongTermTypedFact = {
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
    lastAccessedAt: c.latest.createdAt,
    volatilityClass: deriveVolatilityClass(c.slot, c.latest.value),
    sourceSessionId: sessionId,
    sourceModel: modelId ?? null,
    sourceTrust: inferSourceTrust(c.latest),
    // QW5: carry first-class temporal + affect grounding from the latest emission.
    temporalSpan: c.latest.temporalSpan,
    affect: c.latest.affect,
  };
  // QW-1: Compute per-fact perishability from slot/volatility/trust.
  fact.perishability = derivePerishability({
    slot: c.slot,
    value: c.latest.value,
    volatilityClass: fact.volatilityClass ?? "semi-volatile",
    sourceTrust: fact.sourceTrust,
  });
  // Provenance: thread the source span and chunk ID through to long-term.
  if (sessionId) {
    fact.provenance = {
      quote: c.latest.sourceSpan,
      chunkId: c.latestChunkId,
      sessionId,
    };
  }
  return fact;
}

function reaffirm(
  prior: LongTermTypedFact,
  c: TypedCandidate,
  sessionId?: string,
  modelId?: string,
): LongTermTypedFact {
  const merged = mergeChunkIds(prior.sourceChunkIds, c.sourceChunkIds);
  const effectiveSession = sessionId ?? prior.sourceSessionId;
  const result: LongTermTypedFact = {
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
    sourceSessionId: effectiveSession,
    sourceModel: modelId !== undefined ? modelId : prior.sourceModel,
    sourceTrust: inferSourceTrust(c.latest),
    // QW5: refresh temporal + affect grounding on reaffirmation.
    temporalSpan: c.latest.temporalSpan,
    affect: c.latest.affect,
  };
  // Update provenance with the most recent source.
  if (effectiveSession) {
    result.provenance = {
      quote: c.latest.sourceSpan,
      chunkId: c.latestChunkId,
      sessionId: effectiveSession,
    };
  }
  return result;
}

function supersede(
  prior: LongTermTypedFact,
  c: TypedCandidate,
  now: number,
  sessionId?: string,
  modelId?: string,
): LongTermTypedFact {
  const merged = mergeChunkIds(prior.sourceChunkIds, c.sourceChunkIds);
  const effectiveSession = sessionId ?? prior.sourceSessionId;
  const result: LongTermTypedFact = {
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
    lastAccessedAt: prior.lastAccessedAt,
    volatilityClass: prior.volatilityClass ?? deriveVolatilityClass(c.slot, c.latest.value),
    sourceSessionId: effectiveSession,
    sourceModel: modelId !== undefined ? modelId : prior.sourceModel,
    sourceTrust: inferSourceTrust(c.latest),
    // QW5: refresh temporal + affect grounding on reaffirmation.
    temporalSpan: c.latest.temporalSpan,
    affect: c.latest.affect,
  };
  // QW-1: Recompute perishability for the new value.
  result.perishability = derivePerishability({
    slot: c.slot,
    value: c.latest.value,
    volatilityClass: result.volatilityClass ?? "semi-volatile",
    sourceTrust: result.sourceTrust,
  });
  // Update provenance to point at the new value's source.
  if (effectiveSession) {
    result.provenance = {
      quote: c.latest.sourceSpan,
      chunkId: c.latestChunkId,
      sessionId: effectiveSession,
    };
  }
  // QW-3: Flag conflict — the new value contradicts the prior active value.
  // This is surfaced in memory_insights so cross-agent conflicts are visible.
  result.conflictWith = prior.id;
  return result;
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

export function formatBody(facts: ReadonlyArray<LongTermTypedFact>): string {
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
