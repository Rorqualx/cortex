import type { LlmCaller } from "./llm.js";
import { summarizeChunkUse, summarizeChunkUtility } from "./retrieval-use-store.js";
import type { Storage } from "./storage.js";
import type { FactCertainty, FactModality, L2Fact, LongTermFact } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type VerificationConfig = {
  /** When true, run the TRUSTMEM 3-axis verification gate on candidates. */
  enabled: boolean;
  /** Minimum score (0–1) on each axis. If any axis falls below, promotion is blocked. */
  thresholds: {
    coverage: number;
    preservation: number;
    faithfulness: number;
    /** Optional temporal axis (dates/times retained verbatim). Defaults to 0.7. */
    temporal?: number;
  };
};

export const DEFAULT_VERIFICATION_CONFIG: VerificationConfig = {
  enabled: false,
  thresholds: { coverage: 0.7, preservation: 0.7, faithfulness: 0.7, temporal: 0.7 },
};

export type ConsolidationConfig = {
  /** Minimum distinct L2 chunks that must emit a dedupKey before it can promote. */
  minRecallCount: number;
  /** Minimum span (ms) between firstSeenAt and lastConfirmedAt — proves the fact survives time. */
  minDayspanMs: number;
  /** Minimum importance (across all confirmations) for promotion. */
  minImportance: number;
  /**
   * Single-occurrence shortcut: a fact at this importance promotes immediately
   * without needing recall or dayspan. Mirrors memory-core's pattern of
   * letting high-confidence one-shots through. Tentative facts never take
   * this shortcut — a speculative one-shot must earn promotion over time.
   */
  highImportancePassthrough: number;
  /** Recall bar for candidates whose every occurrence was tagged tentative. */
  tentativeMinRecallCount: number;
  /** Dayspan bar for tentative-only candidates. */
  tentativeMinDayspanMs: number;
  /**
   * Optional TRUSTMEM 3-axis verification gate. When enabled, each candidate
   * that passes promotion thresholds is additionally verified by an LLM for
   * coverage, preservation, and faithfulness before L3 write.
   */
  verification?: VerificationConfig;
  /**
   * QW-2 (2026-11-25, BRAG-lite utility decay): a candidate whose chunks were
   * injected before but not within this window has drifting utility — its
   * behavioral-use credit expires and promotion needs extra importance.
   * Default 30 days (one typed-fact access half-life). Only applies to
   * candidates with a recorded injection history; never-injected candidates
   * carry no utility signal and are untouched.
   */
  utilityStalenessMs?: number;
  /**
   * QW-2: extra importance a stale-utility candidate must clear on top of
   * `minImportance` (the demotion feature). Default 0.05.
   */
  utilityStaleImportancePenalty?: number;
};

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  minRecallCount: 2,
  minDayspanMs: 3 * MS_PER_DAY,
  minImportance: 0.6,
  highImportancePassthrough: 0.85,
  tentativeMinRecallCount: 3,
  tentativeMinDayspanMs: 5 * MS_PER_DAY,
  utilityStalenessMs: 30 * MS_PER_DAY,
  utilityStaleImportancePenalty: 0.05,
};

/**
 * Retrieve-then-use credit cap (2026-10-04 quick-win): behavioral use
 * (recorded prompt injections of a candidate's source chunks) can substitute
 * for at most ONE distinct-chunk recall. Uses prove the fact matters to the
 * agent, but many injections of one chunk are weaker evidence than two
 * independent chunks, so the credit is capped.
 */
const RETRIEVAL_USE_RECALL_CREDIT_CAP = 1;

/** Rank for upgrading candidate certainty: any stronger occurrence wins. */
const CERTAINTY_RANK: Record<FactCertainty, number> = {
  tentative: 0,
  confirmed: 1,
  instructional: 2,
};

/**
 * Rank for aggregating candidate modality (speculation gate,
 * PROMPT_VERSION=18). A "plan" is the weakest claim — it stays a plan until
 * a settled occurrence arrives. A "correction" (explicit supersession) is
 * the strongest. Max across occurrences wins: one confirming sighting lifts
 * an intention out of plan status; nothing demotes back to plan.
 */
const MODALITY_RANK: Record<FactModality, number> = {
  plan: 0,
  fact: 1,
  correction: 2,
};

/**
 * The aggregated view of a single dedupKey across every L2 chunk that has
 * emitted it. This is the input to promotion decisions in `longterm.ts`.
 */
export type ConsolidationCandidate = {
  dedupKey: string;
  /** Canonical text — taken from the highest-importance occurrence; recency breaks ties. */
  text: string;
  importance: number;
  recallCount: number;
  firstSeenAt: number;
  lastConfirmedAt: number;
  /** Chunk ids that confirmed this dedupKey, in encounter order. */
  sourceChunkIds: string[];
  /**
   * Retrieve-then-use telemetry (2026-10-04): cumulative recorded prompt
   * injections of this candidate's source chunks. Joined in selectPromotable
   * from retrieval-use-store; optional so hand-built candidates and older
   * call sites behave exactly as before.
   */
  retrievalUseCount?: number;
  /**
   * QW-2 (2026-11-25, BRAG-lite utility decay): most recent injection day
   * (`YYYY-MM-DD`) across the candidate's source chunks, from the outcome
   * join. Null = never injected (no utility signal). Stamped as a SHADOW
   * feature — logged beside promotion decisions, not yet driving scoring
   * (the ARCH1 rollout rule: one epoch cycle of shadow data first).
   */
  retrievalLastUsedDay?: string | null;
  /**
   * QW-2: injections of the candidate's source chunks in sessions later
   * recorded `positive` (retrieved-and-helped). Shadow feature — the
   * outcome-join scalar ARCH1 will promote into scoring after its shadow
   * epoch.
   */
  retrievalPositiveUses?: number;
  /**
   * QW-2: injections in sessions later recorded `negative`
   * (retrieved-and-ignored). Shadow feature, same rollout rule.
   */
  retrievalNegativeUses?: number;
  /**
   * QW-2: true when the candidate's chunks HAVE an injection history but
   * the most recent injection is older than `utilityStalenessMs` — the
   * obsolescence signal (drifting utility). Unlike the outcome scalars this
   * flag DOES drive scoring: it expires the use credit and applies the
   * stale-importance penalty in `passesPromotionThresholds`.
   */
  retrievalUtilityStale?: boolean;
  /**
   * Strongest certainty across occurrences: one confirmed/instructional
   * sighting lifts the candidate out of the tentative bar. Facts extracted
   * before PROMPT_VERSION=8 carry no tag and count as confirmed.
   */
  certainty: FactCertainty;
  /**
   * Strongest modality across occurrences (speculation gate,
   * PROMPT_VERSION=18): plan < fact < correction. Facts extracted before
   * v18 carry no tag and count as "fact". Plans promote into long-term
   * memory with status "pending" (longterm.ts) until a confirming
   * occurrence flips them to "confirmed"; abandoned plans expire.
   * Optional so hand-built candidates may omit it; mergeFact always sets it.
   */
  modality?: FactModality;
};

/**
 * Walk every L2 chunk, group facts by dedupKey, and produce one candidate per
 * distinct key with cumulative signals. Pure function; no thresholding.
 */
export async function aggregateCandidates(storage: Storage): Promise<ConsolidationCandidate[]> {
  const candidates = new Map<string, ConsolidationCandidate>();
  const paths = await storage.listL2ChunkPaths();
  for (const filePath of paths) {
    const doc = await storage.readL2ChunkAtPath(filePath);
    if (!doc) {
      continue;
    }
    const chunkId = doc.frontmatter.id;
    for (const fact of doc.frontmatter.facts) {
      mergeFact(candidates, fact, chunkId);
    }
  }
  return [...candidates.values()];
}

function mergeFact(
  candidates: Map<string, ConsolidationCandidate>,
  fact: L2Fact,
  chunkId: string,
): void {
  const existing = candidates.get(fact.dedupKey);
  if (!existing) {
    candidates.set(fact.dedupKey, {
      dedupKey: fact.dedupKey,
      text: fact.text,
      importance: fact.importance,
      recallCount: 1,
      firstSeenAt: fact.createdAt,
      lastConfirmedAt: fact.createdAt,
      sourceChunkIds: [chunkId],
      certainty: fact.certainty ?? "confirmed",
      modality: fact.modality ?? "fact",
    });
    return;
  }
  // Capture before mutating lastConfirmedAt so the tie-break compares the
  // fact against the *previous* most-recent confirmation, not against itself.
  const prevLastConfirmedAt = existing.lastConfirmedAt;
  existing.recallCount += 1;
  existing.firstSeenAt = Math.min(existing.firstSeenAt, fact.createdAt);
  existing.lastConfirmedAt = Math.max(existing.lastConfirmedAt, fact.createdAt);
  if (
    fact.importance > existing.importance ||
    (fact.importance === existing.importance && fact.createdAt > prevLastConfirmedAt)
  ) {
    existing.text = fact.text;
    existing.importance = fact.importance;
  }
  if (!existing.sourceChunkIds.includes(chunkId)) {
    existing.sourceChunkIds.push(chunkId);
  }
  const factCertainty = fact.certainty ?? "confirmed";
  if (CERTAINTY_RANK[factCertainty] > CERTAINTY_RANK[existing.certainty]) {
    existing.certainty = factCertainty;
  }
  // Speculation gate: a settled (fact/correction) occurrence upgrades a
  // plan-modality candidate; correction outranks plain fact. Never demotes.
  const factModality = fact.modality ?? "fact";
  if (MODALITY_RANK[factModality] > MODALITY_RANK[existing.modality]) {
    existing.modality = factModality;
  }
}

/**
 * Predicate: should this candidate promote into the long-term tier? Returns
 * true when the candidate either (a) meets the high-importance shortcut or
 * (b) clears the recall + dayspan + importance bar.
 */
export function passesPromotionThresholds(
  candidate: ConsolidationCandidate,
  config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
): boolean {
  const tentative = candidate.certainty === "tentative";
  if (!tentative && candidate.importance >= config.highImportancePassthrough) {
    return true;
  }
  const minRecallCount = tentative ? config.tentativeMinRecallCount : config.minRecallCount;
  const minDayspanMs = tentative ? config.tentativeMinDayspanMs : config.minDayspanMs;
  // Behavioral-use credit: recorded prompt injections can substitute for at
  // most one distinct-chunk recall (see RETRIEVAL_USE_RECALL_CREDIT_CAP).
  // QW-2 (2026-11-25, utility decay): the credit EXPIRES when the
  // candidate's injection history has gone stale — drifting utility no
  // longer substitutes for recall (BRAG's obsolescence signal).
  const useCredit = candidate.retrievalUtilityStale
    ? 0
    : Math.min(candidate.retrievalUseCount ?? 0, RETRIEVAL_USE_RECALL_CREDIT_CAP);
  if (candidate.recallCount + useCredit < minRecallCount) {
    return false;
  }
  if (candidate.lastConfirmedAt - candidate.firstSeenAt < minDayspanMs) {
    return false;
  }
  // QW-2 (utility decay): stale-utility demotion — a candidate that was
  // verifiably useful once but whose injections have decayed away must
  // clear an extra importance bar to promote.
  const minImportance =
    config.minImportance +
    (candidate.retrievalUtilityStale ? (config.utilityStaleImportancePenalty ?? 0) : 0);
  if (candidate.importance < minImportance) {
    return false;
  }
  return true;
}

/**
 * Result of the TRUSTMEM 3-axis verification gate.
 */
export type VerificationResult = {
  /** Candidates that passed all three axis thresholds. */
  passed: ConsolidationCandidate[];
  /** Candidates that were blocked by the gate. */
  blocked: ConsolidationCandidate[];
  /** Number of candidates blocked. */
  blockedCount: number;
};

/**
 * Run the TRUSTMEM 3-axis verification gate on promotable candidates.
 * Checks coverage (all source info captured), preservation (nothing lost
 * from prior L3), and faithfulness (no hallucination) per candidate.
 *
 * When the LLM caller is unavailable or verification is disabled,
 * all candidates pass through unchanged.
 */
export async function runVerificationGate(params: {
  candidates: ConsolidationCandidate[];
  storage: Storage;
  /** Prior L3 facts keyed by dedupKey, for preservation checks. */
  priorFacts: ReadonlyMap<string, LongTermFact>;
  llm: LlmCaller | null;
  config: VerificationConfig;
}): Promise<VerificationResult> {
  if (!params.config.enabled || !params.llm || params.candidates.length === 0) {
    return { passed: params.candidates, blocked: [], blockedCount: 0 };
  }

  // Gather source material per candidate
  const candidateInputs: Array<{
    candidate: ConsolidationCandidate;
    sourceFacts: string[];
    priorText: string | null;
  }> = [];
  for (const candidate of params.candidates) {
    const sourceFacts: string[] = [];
    for (const chunkId of candidate.sourceChunkIds) {
      // Find the chunk path by scanning (inefficient but bounded —
      // sourceChunkIds is small)
      const paths = await params.storage.listL2ChunkPaths();
      for (const p of paths) {
        const doc = await params.storage.readL2ChunkAtPath(p);
        if (doc && doc.frontmatter.id === chunkId) {
          for (const f of doc.frontmatter.facts) {
            if (f.dedupKey === candidate.dedupKey) {
              sourceFacts.push(f.text);
            }
          }
          break;
        }
      }
    }
    const prior = params.priorFacts.get(candidate.dedupKey);
    candidateInputs.push({
      candidate,
      sourceFacts,
      priorText: prior ? prior.text : null,
    });
  }

  const userPrompt = buildVerificationPrompt(candidateInputs);
  let raw: string;
  try {
    raw = await params.llm({
      systemPrompt: VERIFICATION_SYSTEM_PROMPT,
      userPrompt,
      thinking: false,
    });
  } catch {
    // LLM failure must not block consolidation — fall through to pass-all.
    return { passed: params.candidates, blocked: [], blockedCount: 0 };
  }

  const scores = parseVerificationResponse(raw, params.candidates.length);
  const temporalThreshold = params.config.thresholds.temporal ?? 0.7;
  const passed: ConsolidationCandidate[] = [];
  const blocked: ConsolidationCandidate[] = [];
  for (let i = 0; i < params.candidates.length; i++) {
    const s = scores[i];
    const candidate = params.candidates[i];
    if (!s || !candidate) {
      continue;
    }
    if (
      s.coverage >= params.config.thresholds.coverage &&
      s.preservation >= params.config.thresholds.preservation &&
      s.faithfulness >= params.config.thresholds.faithfulness &&
      s.temporal >= temporalThreshold
    ) {
      passed.push(candidate);
    } else {
      blocked.push(candidate);
    }
  }
  return { passed, blocked, blockedCount: blocked.length };
}

function buildVerificationPrompt(
  inputs: Array<{
    candidate: ConsolidationCandidate;
    sourceFacts: string[];
    priorText: string | null;
  }>,
): string {
  const lines: string[] = [
    "Verify each consolidation candidate below on four axes:",
    "1. Coverage (0-1): did the consolidated text capture ALL relevant information from the source facts?",
    "2. Preservation (0-1): if a prior long-term fact exists, was nothing lost compared to it? (1.0 if no prior)",
    "3. Faithfulness (0-1): are there any hallucinations or unsupported claims in the consolidated text?",
    "4. Temporal (0-1): are all dates, times, and durations from the source facts retained verbatim, with no abbreviation, rounding, or drift? (1.0 if the source facts contain no dates or times)",
    "",
    "Respond with a JSON object: { results: [{ coverage: number, preservation: number, faithfulness: number, temporal: number }] }",
    "The results array must match the candidate order below.",
    "",
  ];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    if (!input) {
      continue;
    }
    const { candidate, sourceFacts, priorText } = input;
    lines.push(`--- Candidate ${i + 1} ---`);
    lines.push(`dedupKey: ${candidate.dedupKey}`);
    lines.push(`consolidated text: ${candidate.text}`);
    lines.push("source facts:");
    for (const sf of sourceFacts) {
      lines.push(`  - ${sf}`);
    }
    if (priorText) {
      lines.push(`prior long-term fact: ${priorText}`);
    } else {
      lines.push("prior long-term fact: (none — new promotion)");
    }
    lines.push("");
  }
  return lines.join("\n");
}

const VERIFICATION_SYSTEM_PROMPT =
  "You are a memory-quality verifier. Score each consolidation candidate on four axes (coverage, preservation, faithfulness, temporal) from 0 to 1. Temporal measures whether every date/time expression and time-bounded qualifier (since/until/currently) from the source facts survives verbatim. Be strict: any hallucination, missing information, or mangled date should score below 0.7. Output valid JSON only.";

function parseVerificationResponse(
  raw: string,
  expectedCount: number,
): Array<{
  coverage: number;
  preservation: number;
  faithfulness: number;
  temporal: number;
}> {
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g, "")) as unknown;
    if (!parsed || typeof parsed !== "object") return fillDefaults(expectedCount);
    const obj = parsed as { results?: unknown };
    if (!Array.isArray(obj.results)) return fillDefaults(expectedCount);
    const out: Array<{
      coverage: number;
      preservation: number;
      faithfulness: number;
      temporal: number;
    }> = [];
    for (const item of obj.results) {
      if (!item || typeof item !== "object") {
        out.push({ coverage: 1, preservation: 1, faithfulness: 1, temporal: 1 });
        continue;
      }
      const i = item as Record<string, unknown>;
      out.push({
        coverage: typeof i.coverage === "number" ? clamp01(i.coverage) : 1,
        preservation: typeof i.preservation === "number" ? clamp01(i.preservation) : 1,
        faithfulness: typeof i.faithfulness === "number" ? clamp01(i.faithfulness) : 1,
        temporal: typeof i.temporal === "number" ? clamp01(i.temporal) : 1,
      });
    }
    // Pad if too short
    while (out.length < expectedCount) {
      out.push({ coverage: 1, preservation: 1, faithfulness: 1, temporal: 1 });
    }
    return out.slice(0, expectedCount);
  } catch {
    return fillDefaults(expectedCount);
  }
}

function fillDefaults(
  n: number,
): Array<{ coverage: number; preservation: number; faithfulness: number; temporal: number }> {
  return Array.from({ length: n }, () => ({
    coverage: 1,
    preservation: 1,
    faithfulness: 1,
    temporal: 1,
  }));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Filter helper: aggregate + threshold in one pass, returning only the
 * candidates that should actually promote.
 */
export async function selectPromotable(
  storage: Storage,
  config: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
): Promise<ConsolidationCandidate[]> {
  const candidates = await aggregateCandidates(storage);
  return joinRetrievalUseCounts(candidates, storage.root).filter((c) =>
    passesPromotionThresholds(c, config),
  );
}

/**
 * Retrieve-then-use join (2026-10-04 quick-win): stamp each candidate with the
 * cumulative prompt-injection count of its source chunks from the telemetry
 * store (`retrieval-use.sqlite`, colocated with the l3 store). A telemetry
 * outage degrades to unstamped candidates — consolidation never blocks on it.
 *
 * QW-2 (2026-11-25): the join now also stamps the utility-decay and
 * outcome-join scalars — `retrievalLastUsedDay`, `retrievalPositiveUses`,
 * `retrievalNegativeUses` (shadow features: logged beside promotion
 * decisions, not driving them), and `retrievalUtilityStale` (drives scoring:
 * expires the use credit and applies the stale-importance demotion). The
 * cumulative `retrievalUseCount` keeps its original daily-table semantics
 * so pre-QW-2 telemetry rows still count.
 */
export function joinRetrievalUseCounts(
  candidates: ConsolidationCandidate[],
  l3Root: string,
  now?: number,
): ConsolidationCandidate[] {
  if (candidates.length === 0) {
    return candidates;
  }
  try {
    const chunkIds = [...new Set(candidates.flatMap((c) => c.sourceChunkIds))];
    const useByChunk = summarizeChunkUse({ chunkIds, dir: l3Root });
    const utilityByChunk = summarizeChunkUtility({ chunkIds, dir: l3Root });
    // Note: candidates whose own chunks have no telemetry rows are still
    // stamped (zeros / null lastUsedDay) so downstream readers see a
    // uniform shape — "no injection history" is itself a signal. A truly
    // unavailable store throws above and degrades to unstamped candidates.
    const asOf = now ?? Date.now();
    const stalenessMs = DEFAULT_CONSOLIDATION_CONFIG.utilityStalenessMs ?? 30 * MS_PER_DAY;
    return candidates.map((candidate) => {
      const lastUsedDays = candidate.sourceChunkIds
        .flatMap((chunkId) => [
          useByChunk.get(chunkId)?.lastUsedDay ?? null,
          utilityByChunk.get(chunkId)?.lastUsedDay ?? null,
        ])
        .filter((d): d is string => d !== null);
      const lastUsedDay = lastUsedDays.length > 0 ? maxDay(lastUsedDays) : null;
      return {
        ...candidate,
        retrievalUseCount: candidate.sourceChunkIds.reduce(
          (sum, chunkId) => sum + (useByChunk.get(chunkId)?.uses ?? 0),
          0,
        ),
        retrievalLastUsedDay: lastUsedDay,
        retrievalPositiveUses: candidate.sourceChunkIds.reduce(
          (sum, chunkId) => sum + (utilityByChunk.get(chunkId)?.positiveUses ?? 0),
          0,
        ),
        retrievalNegativeUses: candidate.sourceChunkIds.reduce(
          (sum, chunkId) => sum + (utilityByChunk.get(chunkId)?.negativeUses ?? 0),
          0,
        ),
        ...(lastUsedDay !== null && asOf - dayStartMs(lastUsedDay) > stalenessMs
          ? { retrievalUtilityStale: true }
          : {}),
      };
    });
  } catch {
    return candidates;
  }
}

/** Lexicographic max over `YYYY-MM-DD` day strings. */
function maxDay(days: readonly string[]): string {
  return days.reduce((a, b) => (a > b ? a : b));
}

/** `YYYY-MM-DD` day string → UTC-midnight epoch ms (≤24h slop vs the local
 * day boundary; negligible against the 30-day staleness window). */
function dayStartMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}
