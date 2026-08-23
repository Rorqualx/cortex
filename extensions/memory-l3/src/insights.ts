/**
 * Read-only trend aggregation over the L3 store: what was promoted, what
 * changed, and what keeps recurring. No LLM calls, no writes — safe to expose
 * as an agent tool and cheap enough to run on demand.
 */
import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { fsrsRetrievability, DEFAULT_FSRS_PARAMS, DEFAULT_SCORING_CONFIG } from "./scoring.js";
import { Storage } from "./storage.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FACT_TEXT_MAX_CHARS = 200;

export type ForgettingCandidate = {
  id: string;
  text: string;
  tier: "prose" | "typed";
  /** FSRS retrievability R(t): probability the fact is still recallable. 0 = fully forgotten. */
  retrievability: number;
  recallCount: number;
  lastConfirmedAt: number;
  ageDays: number;
};

export type ForgettingCandidates = {
  generatedAt: number;
  threshold: number;
  candidates: ForgettingCandidate[];
};

export type MemoryInsights = {
  generatedAt: number;
  windowDays: number;
  totals: {
    longTermFacts: number;
    typedSlots: number;
    epochs: number;
    l2Chunks: number;
  };
  window: {
    factsPromoted: Array<{
      text: string;
      importance: number;
      recallCount: number;
      firstSeenAt: number;
      sourceChunkIds: string[];
    }>;
    typedSlotsChanged: Array<{
      slot: string;
      value: string;
      lastConfirmedAt: number;
      changes: number;
      provenance?: { quote: string; chunkId: string; sessionId: string };
      conflictWith?: string;
    }>;
    epochsCreated: Array<{ id: string; createdAt: number; representativeFactCount: number }>;
    l2Chunks: number;
  };
  topRecalled: Array<{
    text: string;
    recallCount: number;
    lastConfirmedAt: number;
    sourceChunkIds: string[];
  }>;
};

function clipFactText(text: string): string {
  return text.length > FACT_TEXT_MAX_CHARS ? `${text.slice(0, FACT_TEXT_MAX_CHARS)}…` : text;
}

/** Date partition (YYYY-MM-DD, UTC) for a timestamp; mirrors storage's L2 layout. */
function datePartitionForMs(unixMs: number): string {
  return new Date(unixMs).toISOString().slice(0, 10);
}

export async function collectMemoryInsights(params: {
  storage: Storage;
  days?: number;
  limit?: number;
  now?: number;
}): Promise<MemoryInsights> {
  const now = params.now ?? Date.now();
  const windowDays = params.days ?? 7;
  const limit = params.limit ?? 10;
  const cutoff = now - windowDays * DAY_MS;

  const [longTerm, longTermTyped, epochPaths, l2Paths] = await Promise.all([
    params.storage.readLongTerm(),
    params.storage.readLongTermTyped(),
    params.storage.listL3EpochPaths(),
    params.storage.listL2ChunkPaths(),
  ]);

  // Typed facts are authoritative over superseded prose; both archived tiers
  // stay on disk for forensics but never count as live memory.
  const activeFacts = longTerm.facts.filter((fact) => !fact.archived && !fact.supersededBy);
  const activeTyped = longTermTyped.facts.filter((fact) => !fact.archived);

  const factsPromoted = activeFacts
    .filter((fact) => fact.firstSeenAt >= cutoff)
    .toSorted((a, b) => b.firstSeenAt - a.firstSeenAt)
    .slice(0, limit)
    .map((fact) => ({
      text: clipFactText(fact.text),
      importance: fact.importance,
      recallCount: fact.recallCount,
      firstSeenAt: fact.firstSeenAt,
      sourceChunkIds: fact.sourceChunkIds,
    }));

  const typedSlotsChanged = activeTyped
    .filter((fact) => fact.lastConfirmedAt >= cutoff)
    .toSorted((a, b) => b.lastConfirmedAt - a.lastConfirmedAt)
    .slice(0, limit)
    .map((fact) => ({
      slot: fact.slot,
      value: clipFactText(fact.value),
      lastConfirmedAt: fact.lastConfirmedAt,
      changes: fact.history.length,
      provenance: fact.provenance,
      conflictWith: fact.conflictWith,
    }));

  const topRecalled = activeFacts
    .toSorted((a, b) => b.recallCount - a.recallCount || b.lastConfirmedAt - a.lastConfirmedAt)
    .slice(0, limit)
    .map((fact) => ({
      text: clipFactText(fact.text),
      recallCount: fact.recallCount,
      lastConfirmedAt: fact.lastConfirmedAt,
      sourceChunkIds: fact.sourceChunkIds,
    }));

  const epochsCreated: MemoryInsights["window"]["epochsCreated"] = [];
  for (const epochPath of epochPaths) {
    const doc = await params.storage.readL3EpochAtPath(epochPath);
    if (doc && doc.frontmatter.createdAt >= cutoff) {
      epochsCreated.push({
        id: doc.frontmatter.id,
        createdAt: doc.frontmatter.createdAt,
        representativeFactCount: doc.frontmatter.representativeFacts.length,
      });
    }
  }
  epochsCreated.sort((a, b) => b.createdAt - a.createdAt);

  // L2 paths are partitioned by UTC date dir, so window membership is a
  // string compare on the parent dir name — no chunk reads needed.
  const cutoffPartition = datePartitionForMs(cutoff);
  const l2ChunksInWindow = l2Paths.filter((chunkPath) => {
    const partition = chunkPath.split("/").at(-2) ?? "";
    return partition >= cutoffPartition;
  }).length;

  return {
    generatedAt: now,
    windowDays,
    totals: {
      longTermFacts: activeFacts.length,
      typedSlots: activeTyped.length,
      epochs: epochPaths.length,
      l2Chunks: l2Paths.length,
    },
    window: {
      factsPromoted,
      typedSlotsChanged,
      epochsCreated: epochsCreated.slice(0, limit),
      l2Chunks: l2ChunksInWindow,
    },
    topRecalled,
  };
}

/**
 * Collect facts whose FSRS retrievability has dropped below `threshold`.
 * These are "forgetting candidates" — facts that the memory system considers
 * effectively forgotten (R(t) < 0.05 by default). Useful for reviewing what
 * the system is about to lose and deciding whether to re-affirm or archive.
 *
 * Read-only; no data mutation.
 */
export async function collectForgettingCandidates(params: {
  storage: Storage;
  threshold?: number;
  limit?: number;
  now?: number;
}): Promise<ForgettingCandidates> {
  const now = params.now ?? Date.now();
  const threshold = params.threshold ?? 0.05;
  const limit = params.limit ?? 20;
  const halfLifeDays = DEFAULT_SCORING_CONFIG.recencyHalfLifeDays;

  const [longTerm, longTermTyped] = await Promise.all([
    params.storage.readLongTerm(),
    params.storage.readLongTermTyped(),
  ]);

  const activeProse = longTerm.facts.filter((f) => !f.archived && !f.supersededBy);
  const activeTyped = longTermTyped.facts.filter((f) => !f.archived);

  const candidates: ForgettingCandidate[] = [];

  for (const fact of activeProse) {
    const ageMs = now - fact.lastConfirmedAt;
    const r = fsrsRetrievability({
      ageMs,
      recallCount: fact.recallCount,
      halfLifeDays,
      significant: fact.significant,
      fsrs: DEFAULT_FSRS_PARAMS,
    });
    if (r < threshold) {
      candidates.push({
        id: fact.id,
        text: clipFactText(fact.text),
        tier: "prose",
        retrievability: Math.round(r * 1e6) / 1e6,
        recallCount: fact.recallCount,
        lastConfirmedAt: fact.lastConfirmedAt,
        ageDays: Math.round((ageMs / DAY_MS) * 10) / 10,
      });
    }
  }

  for (const fact of activeTyped) {
    const ageMs = now - fact.lastConfirmedAt;
    const r = fsrsRetrievability({
      ageMs,
      recallCount: fact.recallCount,
      halfLifeDays,
      volatilityClass: fact.volatilityClass,
      fsrs: DEFAULT_FSRS_PARAMS,
    });
    if (r < threshold) {
      candidates.push({
        id: fact.id,
        text: `${fact.slot}: ${clipFactText(fact.value)}`,
        tier: "typed",
        retrievability: Math.round(r * 1e6) / 1e6,
        recallCount: fact.recallCount,
        lastConfirmedAt: fact.lastConfirmedAt,
        ageDays: Math.round((ageMs / DAY_MS) * 10) / 10,
      });
    }
  }

  // Lowest retrievability first — most-forgotten at the top
  candidates.sort((a, b) => a.retrievability - b.retrievability);

  return {
    generatedAt: now,
    threshold,
    candidates: candidates.slice(0, limit),
  };
}

const MemoryInsightsToolSchema = Type.Object(
  {
    days: Type.Optional(
      Type.Integer({
        description: "Trend window in days (default 7).",
        minimum: 1,
        maximum: 90,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Max entries per list (default 10).",
        minimum: 1,
        maximum: 50,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createMemoryInsightsTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "memory_insights",
    label: "Memory Insights",
    description:
      "Read-only trends from hierarchical L3 memory: facts promoted recently, typed slots that changed, epochs created, and the most-recalled long-term facts. Use to review what the memory system has been learning.",
    parameters: MemoryInsightsToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const storage = Storage.fromWorkspace(ctx.workspaceDir);
      // Close the per-call DB handle so each tool invocation does not leak a
      // SQLite connection + WAL-maintenance timer for the gateway's lifetime.
      try {
        const days = typeof rawParams.days === "number" ? rawParams.days : undefined;
        const limit = typeof rawParams.limit === "number" ? rawParams.limit : undefined;
        return jsonResult(await collectMemoryInsights({ storage, days, limit }));
      } finally {
        storage.close();
      }
    },
  };
}

const ArchiveSearchToolSchema = Type.Object(
  {
    query: Type.String({
      description:
        "Search keywords (BM25). Iterate with more specific terms if the first pass misses.",
      minLength: 1,
      maxLength: 400,
    }),
    session_hint: Type.Optional(
      Type.String({
        description: "Substring filter on the archive chunk id (session context token).",
        maxLength: 200,
      }),
    ),
    before: Type.Optional(
      Type.Union([Type.String(), Type.Integer()], {
        description: "Only turns at/before this time (ISO 8601 string or epoch ms).",
      }),
    ),
    after: Type.Optional(
      Type.Union([Type.String(), Type.Integer()], {
        description: "Only turns at/after this time (ISO 8601 string or epoch ms).",
      }),
    ),
    skip_session_ids: Type.Optional(
      Type.Array(Type.String(), {
        description: "Archive chunk ids whose turns should be excluded.",
        maxItems: 50,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ description: "Max hits to return (default 10).", minimum: 1, maximum: 20 }),
    ),
  },
  { additionalProperties: false },
);

function parseTimeParam(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new Error(`${label} must be an ISO 8601 string or epoch milliseconds`);
}

/**
 * Raw-archive search (ReFind finding 3, 2026-08-23): lexical BM25 over the
 * append-only L1 turn archive, complementing the distilled L2/L3 tiers —
 * details compaction dropped stay findable. Read-only.
 */
export function createArchiveSearchTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "memory_archive_search",
    label: "Memory Archive Search",
    description:
      "Read-only BM25 keyword search over the raw L1 turn archive (pre-compaction conversation turns). Use when distilled memory lacks a detail: exact strings, IDs, IPs, code snippets that compaction may have dropped. Returns matched turns with chunk (session) and time context; refine with session_hint / before / after.",
    parameters: ArchiveSearchToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const storage = Storage.fromWorkspace(ctx.workspaceDir);
      try {
        const query = typeof rawParams.query === "string" ? rawParams.query : "";
        const result = await storage.searchL1Archive({
          query,
          sessionHint:
            typeof rawParams.session_hint === "string" ? rawParams.session_hint : undefined,
          beforeMs: parseTimeParam(rawParams.before, "before"),
          afterMs: parseTimeParam(rawParams.after, "after"),
          skipSessionIds: Array.isArray(rawParams.skip_session_ids)
            ? rawParams.skip_session_ids.filter((id): id is string => typeof id === "string")
            : undefined,
          limit: typeof rawParams.limit === "number" ? rawParams.limit : undefined,
        });
        return jsonResult(result);
      } finally {
        storage.close();
      }
    },
  };
}

const ForgettingCandidatesToolSchema = Type.Object(
  {
    threshold: Type.Optional(
      Type.Number({
        description:
          "Retrievability threshold (0–1). Facts with FSRS retrievability below this value are returned. Default 0.05.",
        minimum: 0,
        maximum: 1,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Max candidates to return (default 20).",
        minimum: 1,
        maximum: 100,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createForgettingCandidatesTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "memory_forgetting",
    label: "Memory Forgetting Candidates",
    description:
      "Read-only query: returns long-term facts whose FSRS retrievability has dropped below a threshold, meaning the memory system considers them effectively forgotten. Use to review fading facts and decide whether to re-affirm or let them go.",
    parameters: ForgettingCandidatesToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const storage = Storage.fromWorkspace(ctx.workspaceDir);
      try {
        const threshold = typeof rawParams.threshold === "number" ? rawParams.threshold : undefined;
        const limit = typeof rawParams.limit === "number" ? rawParams.limit : undefined;
        return jsonResult(await collectForgettingCandidates({ storage, threshold, limit }));
      } finally {
        storage.close();
      }
    },
  };
}
