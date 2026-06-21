/**
 * Read-only trend aggregation over the L3 store: what was promoted, what
 * changed, and what keeps recurring. No LLM calls, no writes — safe to expose
 * as an agent tool and cheap enough to run on demand.
 */
import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { Storage } from "./storage.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FACT_TEXT_MAX_CHARS = 200;

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
    }>;
    typedSlotsChanged: Array<{
      slot: string;
      value: string;
      lastConfirmedAt: number;
      changes: number;
    }>;
    epochsCreated: Array<{ id: string; createdAt: number; representativeFactCount: number }>;
    l2Chunks: number;
  };
  topRecalled: Array<{ text: string; recallCount: number; lastConfirmedAt: number }>;
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
    }));

  const topRecalled = activeFacts
    .toSorted((a, b) => b.recallCount - a.recallCount || b.lastConfirmedAt - a.lastConfirmedAt)
    .slice(0, limit)
    .map((fact) => ({
      text: clipFactText(fact.text),
      recallCount: fact.recallCount,
      lastConfirmedAt: fact.lastConfirmedAt,
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
