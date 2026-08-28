import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolve as resolvePath } from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngine,
  ContextEngineFactoryContext,
  ContextEngineInfo,
  IngestBatchResult,
  IngestResult,
} from "openclaw/plugin-sdk/memory-core-engine-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-engine-runtime";
import { getMemorySearchManager } from "openclaw/plugin-sdk/memory-core-engine-runtime";
import { compactSession } from "./compaction.js";
import { publishToFacts } from "./cross-context.js";
import { IngestBuffer } from "./ingest.js";
import { createGlmCaller, type LlmCaller } from "./llm.js";
import { consolidateLongTermTyped } from "./longterm-typed.js";
import { consolidateLongTerm } from "./longterm.js";
import { reconcileCrossBrain, reconcileProseInterference } from "./reconciliation.js";
import { DEFAULT_REFLECTION_CONFIG, reflectAndStore } from "./reflection.js";

/**
 * Embedding provider for pre-computing vectors at promotion time.
 * Follows the same pattern as LlmCaller — injected via constructor,
 * resolved lazily, optional (graceful degradation to jaccard).
 *
 * When provided, embeddings are computed once at promotion/reaffirmation and
 * stored in LongTermFact.embedding. This enables cosine-similarity-based
 * semantic dedup (instead of jaccard) and semantic retrieval signals —
 * without any embedding calls during the dedup or retrieval passes.
 */
export type EmbeddingProvider = {
  /** Compute embedding for a single text. */
  embed(text: string): Promise<number[]>;
  /** Compute embeddings for multiple texts in a batch. */
  embedBatch(texts: string[]): Promise<number[][]>;
};
import { formatMemorySection, type MemoryCoreLookup, retrieveTopK } from "./retrieval.js";
import { cosineSimilarity } from "./scoring.js";
import { selectSlidingWindow } from "./sliding-window.js";
import { Storage } from "./storage.js";
import { estimateTotalTokens } from "./token-estimate.js";
import type { L3State } from "./types.js";

const ASSEMBLE_TOP_K = 5;
const ASSEMBLE_TOP_K_MIN = 3;
const AFTER_TURN_COMPACTION_THRESHOLD_TOKENS = 4000;

/**
 * Pressure-adaptive recall volume (F9, PACE-style budgeting): scale the number
 * of injected L3 facts with current context-token pressure. At zero pressure
 * (roomy context) keep the full baseline topK; as the window fills, trim
 * linearly toward the minimum so memory injection never crowds out the
 * conversation. `pressure` is estimatedTokens / tokenBudget, clamped to [0,1];
 * callers without a budget signal pass 0 (baseline behavior).
 */
export function pressureAdaptiveTopK(pressure: number): number {
  const p = Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure)) : 0;
  const scaled = Math.round(ASSEMBLE_TOP_K - p * (ASSEMBLE_TOP_K - ASSEMBLE_TOP_K_MIN));
  return Math.max(ASSEMBLE_TOP_K_MIN, Math.min(ASSEMBLE_TOP_K, scaled));
}

// ReTopK retrieval cache (arXiv:2607.27692) — session-scoped LRU that reuses
// retrieval results when a new query's embedding cosine-similarity to a
// cached query exceeds RETOPK_SIMILARITY_THRESHOLD. Cache is bounded and
// invalidated on any fact write.
const RETOPK_MAX_ENTRIES = 10;
const RETOPK_SIMILARITY_THRESHOLD = 0.92;

/**
 * Cross-embedding-model calibration map (arXiv:2608.05857-inspired).
 *
 * When the embedding provider is swapped, cosine-similarity distributions
 * shift. The calibration script (`scripts/calibrate-embeddings.ts`) writes
 * a `threshold_map.json` with a linear regression mapping old thresholds
 * to new. This function loads that map (if present) and returns the adjusted
 * threshold for a given old-model threshold. Returns the input unchanged
 * when no map exists — fully backward-compatible.
 */
let cachedThresholdMap: Record<string, number> | null | undefined;

function loadThresholdMap(l3Root: string): Record<string, number> | null {
  if (cachedThresholdMap !== undefined) return cachedThresholdMap;
  try {
    const path = resolvePath(l3Root, "threshold_map.json");
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    cachedThresholdMap = parsed.thresholds ?? null;
    if (cachedThresholdMap) {
      l3debug(
        `loadThresholdMap(): loaded ${Object.keys(cachedThresholdMap).length} threshold mappings from ${path}`,
      );
    }
  } catch {
    cachedThresholdMap = null;
  }
  return cachedThresholdMap ?? null;
}

/** Get the effective ReTopK similarity threshold, adjusted by calibration map if present. */
function getRetopkThreshold(l3Root: string): number {
  const map = loadThresholdMap(l3Root);
  if (map) {
    const adjusted = map[RETOPK_SIMILARITY_THRESHOLD.toFixed(2)];
    if (typeof adjusted === "number") return adjusted;
  }
  return RETOPK_SIMILARITY_THRESHOLD;
}

type ReTopKCacheEntry = {
  query: string;
  embedding: number[];
  result: string;
};

const DEBUG_ENABLED = process.env.OPENCLAW_MEMORY_L3_DEBUG === "1";
// G1 generative reflection at the epoch boundary. Off by default — opt-in A/B
// flag (one extra LLM call per epoch) consistent with the other
// OPENCLAW_MEMORY_L3_* experimental switches. Promote to a default once the
// LongMemEval delta is measured.
const REFLECTION_ENABLED = process.env.OPENCLAW_MEMORY_L3_REFLECTION === "1";

function l3debug(msg: string): void {
  if (DEBUG_ENABLED) {
    console.error(`[memory-l3] ${msg}`);
  }
}

const ENGINE_INFO: ContextEngineInfo = {
  id: "memory-l3",
  name: "Hierarchical Memory (L1/L2/L3)",
  version: "0.1.0",
  ownsCompaction: false,
};

export function createHierarchicalL3Engine(ctx: ContextEngineFactoryContext): ContextEngine {
  const storage = Storage.fromWorkspace(ctx.workspaceDir);
  return new HierarchicalL3Engine(storage, {
    agentDir: ctx.agentDir,
    config: ctx.config,
    workspaceDir: ctx.workspaceDir,
    // Embedding provider is resolved lazily from config at first use.
    // See resolveEmbeddingProvider() below.
  });
}

export type HierarchicalL3EngineOptions = {
  /** Override the default GLM-from-auth LlmCaller. Used by tests. */
  caller?: LlmCaller;
  /** Per-agent directory under ~/.openclaw/agents/<id>/. Used to read auth-profiles.json. */
  agentDir?: string;
  /** OpenClaw config from the factory context. Required to call memory-core's QMD. */
  config?: OpenClawConfig;
  /** Override the memory-core lookup. Used by tests; production wires the SDK call. */
  memoryCoreLookup?: MemoryCoreLookup;
  /** Workspace dir from factory context. Used to mirror long-term facts into memory/.l3/. */
  workspaceDir?: string;
  /** Skill-forge directory for procedural memory tier. Defaults to ~/.openclaw/skill-forge/skills/. */
  skillForgeDir?: string;
  /** Shared memory directory for cross-context tier. Defaults to ~/.openclaw/shared-memory/. */
  sharedMemoryDir?: string;
  /**
   * Embedding provider for pre-computing vectors at promotion time.
   * When provided, LongTermFacts get an `embedding` field that enables
   * cosine-similarity semantic dedup and retrieval. Falls back to jaccard
   * when unavailable.
   */
  embeddingProvider?: EmbeddingProvider;
};

export class HierarchicalL3Engine implements ContextEngine {
  readonly info = ENGINE_INFO;
  private readonly storage: Storage;
  private readonly buffer = new IngestBuffer();
  private readonly callerOverride: LlmCaller | undefined;
  private readonly agentDir: string | undefined;
  private readonly config: OpenClawConfig | undefined;
  private readonly memoryCoreLookupOverride: MemoryCoreLookup | undefined;
  private readonly workspaceDir: string | undefined;
  private readonly skillForgeDir: string | undefined;
  private readonly sharedMemoryDir: string | undefined;
  private readonly embeddingProviderOverride: EmbeddingProvider | undefined;
  /** Lazily resolved embedding provider from core infrastructure. */
  private resolvedEmbeddingProvider: EmbeddingProvider | null | undefined;
  private cachedZaiKey: string | null | undefined;
  private state: L3State | null = null;
  /** ReTopK session-scoped retrieval cache (bounded LRU). */
  private retrievalCache: ReTopKCacheEntry[] = [];

  constructor(storage: Storage, options?: HierarchicalL3EngineOptions) {
    this.storage = storage;
    this.callerOverride = options?.caller;
    this.agentDir = options?.agentDir;
    this.config = options?.config;
    this.embeddingProviderOverride = options?.embeddingProvider;
    this.memoryCoreLookupOverride = options?.memoryCoreLookup;
    this.workspaceDir = options?.workspaceDir;
    this.skillForgeDir = options?.skillForgeDir;
    this.sharedMemoryDir = options?.sharedMemoryDir;
  }

  async bootstrap(): Promise<BootstrapResult> {
    l3debug(`bootstrap(): root=${this.storage.root} agentDir=${this.agentDir ?? "(undefined)"}`);
    await this.storage.ensureLayout();
    this.state = await this.storage.readState();
    if (this.state.agentId === null) {
      const derived = deriveAgentIdFromAgentDir(this.agentDir);
      if (derived) {
        this.state.agentId = derived;
      }
    }
    return { bootstrapped: true };
  }

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    l3debug(`ingest(): sessionId=${params.sessionId} heartbeat=${params.isHeartbeat ?? false}`);
    if (params.isHeartbeat) {
      return { ingested: false };
    }
    this.buffer.push(params.sessionId, params.message);
    this.refreshBufferTokenCount();
    return { ingested: true };
  }

  async ingestBatch(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    l3debug(
      `ingestBatch(): sessionId=${params.sessionId} count=${params.messages.length} heartbeat=${params.isHeartbeat ?? false}`,
    );
    if (params.isHeartbeat) {
      return { ingestedCount: 0 };
    }
    const ingestedCount = this.buffer.pushBatch(params.sessionId, params.messages);
    this.refreshBufferTokenCount();
    return { ingestedCount };
  }

  private refreshBufferTokenCount(): void {
    if (this.state) {
      this.state.bufferTokenCount = this.buffer.totalTokens();
    }
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    prompt?: string;
  }): Promise<AssembleResult> {
    l3debug(
      `assemble(): sessionId=${params.sessionId} messages.length=${params.messages.length} prompt.length=${params.prompt?.length ?? 0}`,
    );
    const window =
      params.tokenBudget && params.tokenBudget > 0
        ? selectSlidingWindow({
            messages: params.messages,
            tokenBudget: params.tokenBudget,
          })
        : {
            selected: [...params.messages],
            estimatedTokens: estimateTotalTokens(params.messages),
          };

    const systemPromptAddition = await this.buildMemorySection(
      params.prompt,
      params.tokenBudget && params.tokenBudget > 0
        ? Math.min(1, window.estimatedTokens / params.tokenBudget)
        : 0,
    );

    return {
      messages: window.selected,
      estimatedTokens: window.estimatedTokens,
      ...(systemPromptAddition ? { systemPromptAddition } : {}),
    };
  }

  private async buildMemorySection(
    prompt: string | undefined,
    tokenPressure = 0,
  ): Promise<string | undefined> {
    if (!prompt || prompt.length === 0) {
      return undefined;
    }

    // Compute query embedding once for both cache-check and retrieval.
    const queryEmbedding = await this.resolveQueryEmbedding(prompt);

    // ReTopK cache check: if a cached query's embedding cosine exceeds the
    // threshold, reuse the cached formatted result (arXiv:2607.27692).
    const retopkThreshold = getRetopkThreshold(this.storage.root);
    if (queryEmbedding && this.retrievalCache.length > 0) {
      for (let i = this.retrievalCache.length - 1; i >= 0; i--) {
        const entry = this.retrievalCache[i]!;
        if (
          entry.embedding.length === queryEmbedding.length &&
          cosineSimilarity(entry.embedding, queryEmbedding) >= retopkThreshold
        ) {
          // LRU: move hit to end (most-recently-used).
          this.retrievalCache.splice(i, 1);
          this.retrievalCache.push(entry);
          l3debug(`ReTopK cache hit (sim ≥ ${retopkThreshold}) for query: ${prompt.slice(0, 60)}`);
          return entry.result;
        }
      }
    }

    const top = await retrieveTopK({
      query: prompt,
      storage: this.storage,
      topK: pressureAdaptiveTopK(tokenPressure),
      memoryCoreLookup: this.resolveMemoryCoreLookup(),
      skillForgeDir: this.skillForgeDir,
      sharedMemoryDir: this.sharedMemoryDir,
      queryEmbedding,
    });
    if (top.facts.length === 0) {
      return undefined;
    }
    const result = formatMemorySection(top.facts, { now: Date.now() });

    // Populate cache when we have an embedding for similarity comparison.
    if (queryEmbedding && queryEmbedding.length > 0) {
      this.retrievalCache.push({ query: prompt, embedding: queryEmbedding, result });
      // LRU eviction: keep only the most recent RETOPK_MAX_ENTRIES entries.
      if (this.retrievalCache.length > RETOPK_MAX_ENTRIES) {
        this.retrievalCache.shift();
      }
    }

    return result;
  }

  /** Invalidate the ReTopK retrieval cache. Call after any fact mutation
   * (consolidation, promotion, new fact creation) so stale results are
   * never served. */
  private invalidateRetrievalCache(): void {
    if (this.retrievalCache.length > 0) {
      l3debug(`ReTopK cache invalidated (${this.retrievalCache.length} entries cleared)`);
      this.retrievalCache = [];
    }
  }

  private resolveMemoryCoreLookup(): MemoryCoreLookup | undefined {
    if (this.memoryCoreLookupOverride) {
      return this.memoryCoreLookupOverride;
    }
    if (!this.config || !this.state?.agentId) {
      return undefined;
    }
    const cfg = this.config;
    const agentId = this.state.agentId;
    return async (query) => {
      try {
        const { manager, error } = await getMemorySearchManager({
          cfg,
          agentId,
          purpose: "default",
        });
        if (!manager || error) {
          return [];
        }
        const hits = await manager.search(query, { maxResults: ASSEMBLE_TOP_K });
        return hits.map((h) => ({
          path: h.path,
          startLine: h.startLine,
          endLine: h.endLine,
          score: h.score,
          snippet: h.snippet,
        }));
      } catch (err) {
        l3debug(`memory-core lookup failed: ${(err as Error).message}`);
        return [];
      }
    };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
  }): Promise<void> {
    // Lazy bootstrap: if the engine hasn't been bootstrapped yet
    // (e.g. embedded-agent-runner path doesn't call bootstrap() explicitly),
    // do it now so we don't silently skip all afterTurn work.
    if (!this.state) {
      try {
        await this.bootstrap();
      } catch (err) {
        console.error(`[memory-l3] lazy bootstrap failed: ${(err as Error).message}`);
        return;
      }
    }
    if (params.isHeartbeat || !this.state) {
      return;
    }

    // OpenClaw's runtime hands us the full session message array each turn
    // and never invokes ingest/ingestBatch separately. Pull the tail we
    // haven't compacted yet into the buffer so the existing compactor runs.
    // Per-session cursor with truncation guard: if the runtime sends fewer
    // messages than we'd already compacted (session restart, history
    // truncation), reset to 0 for this session and re-ingest from the top.
    const sessionCursors = this.state.compactedMessageCountBySession;
    const recordedCursor = sessionCursors[params.sessionId] ?? 0;
    const compactedSoFar = recordedCursor > params.messages.length ? 0 : recordedCursor;
    if (compactedSoFar !== recordedCursor) {
      sessionCursors[params.sessionId] = 0;
    }
    const tail = params.messages.slice(compactedSoFar);
    if (tail.length > 0) {
      this.buffer.pushBatch(params.sessionId, tail);
      this.refreshBufferTokenCount();
    }
    // Use total buffer tokens across all sessions — compaction processes
    // the full buffer regardless of which session triggered it.
    const totalBuffered = this.buffer.totalTokens();
    l3debug(
      `afterTurn(): sessionId=${params.sessionId} totalMessages=${params.messages.length} compactedSoFar=${compactedSoFar} newTail=${tail.length} totalBuffered=${totalBuffered} threshold=${AFTER_TURN_COMPACTION_THRESHOLD_TOKENS}`,
    );
    if (totalBuffered < AFTER_TURN_COMPACTION_THRESHOLD_TOKENS) {
      return;
    }
    const caller = await this.resolveCaller();
    if (!caller) {
      l3debug("afterTurn(): no caller resolved; skipping compaction");
      return;
    }
    l3debug(`afterTurn(): triggering compaction for sessionId=${params.sessionId}`);
    const now = Date.now();
    try {
      const result = await compactSession({
        sessionId: params.sessionId,
        buffer: this.buffer,
        storage: this.storage,
        caller,
        state: this.state,
        now,
        embeddingProvider: await this.resolveEmbeddingProvider(),
      });
      if (result.chunkId !== null) {
        this.state.compactedMessageCountBySession[params.sessionId] = params.messages.length;
        // Invalidate ReTopK cache — new facts were persisted.
        this.invalidateRetrievalCache();
      }
      // QW5 (2026-08-16, arXiv:2608.11879): cost-attribution accumulators
      // for this engine cycle — one l3_metrics row per afterTurn covering
      // compaction + both long-term consolidation passes.
      let metricPasses = result.chunkId !== null ? 1 : 0;
      let metricPromotions = 0;
      let metricDemotions = 0;
      let metricMerges = 0;
      l3debug(
        `afterTurn(): compaction result chunkId=${result.chunkId} factsAdded=${result.factsAdded} epochId=${result.epochId}`,
      );
      // Epoch boundary triggers a long-term consolidation pass: aggregate
      // recurring/important L2 facts into the long-term tier, archive
      // stale entries, persist longterm.md.
      if (result.epochId !== null) {
        try {
          const lt = await consolidateLongTerm({
            storage: this.storage,
            agentId: this.state.agentId,
            now,
            workspaceDir: this.workspaceDir,
            embeddingProvider: await this.resolveEmbeddingProvider(),
            llm: await this.resolveCaller(),
          });
          this.state.lastConsolidatedAt = now;
          metricPasses += 1;
          metricPromotions += lt.promotedCount;
          metricDemotions += lt.archivedCount;
          metricMerges += lt.semanticDedupCount;
          l3debug(
            `afterTurn(): consolidation promoted=${lt.promotedCount} reaffirmed=${lt.reaffirmedCount} archived=${lt.archivedCount} unarchived=${lt.unarchivedCount} active=${lt.activeCount} verificationBlocked=${lt.verificationBlocked}`,
          );
          // Cross-context publish: share promoted facts with other agents/sessions.
          try {
            const ltData = await this.storage.readLongTerm();
            const activeFacts = ltData.facts.filter((f) => !f.archived && !f.supersededBy);
            if (activeFacts.length > 0) {
              const pub = await publishToFacts(
                this.state.agentId ?? "unknown",
                activeFacts,
                this.sharedMemoryDir,
              );
              if (pub.published > 0) {
                l3debug(
                  `afterTurn(): cross-context published=${pub.published} conflicts=${pub.conflicts}`,
                );
              }
            }
          } catch (pubErr) {
            console.error(`[memory-l3] cross-context publish failed: ${(pubErr as Error).message}`);
          }
        } catch (consolidationErr) {
          // Consolidation failures are non-fatal — the L2 chunk is already
          // safely persisted. Log loud and continue.
          console.error(`[memory-l3] consolidation failed: ${(consolidationErr as Error).message}`);
        }
        // Corpus-callosum bridge: typed-fact long-term consolidation runs
        // on the same epoch boundary. Detects value drift per slot and
        // builds the canonical "current value" view at longterm-typed.md.
        let typedActivity = false;
        try {
          const ltt = await consolidateLongTermTyped({
            storage: this.storage,
            agentId: this.state.agentId,
            now,
            sessionId: params.sessionId,
          });
          typedActivity = ltt.promotedCount + ltt.supersededCount > 0;
          metricPasses += 1;
          metricPromotions += ltt.promotedCount;
          metricDemotions += ltt.supersededCount;
          l3debug(
            `afterTurn(): typed consolidation promoted=${ltt.promotedCount} superseded=${ltt.supersededCount} reaffirmed=${ltt.reaffirmedCount} archived=${ltt.archivedCount} active=${ltt.activeCount}`,
          );
        } catch (typedErr) {
          console.error(`[memory-l3] typed consolidation failed: ${(typedErr as Error).message}`);
        }
        // QW5: persist the aggregated cost-attribution row. Failures are
        // non-fatal — the canonical state writes above already committed.
        try {
          await this.storage.recordMetric(
            {
              sessionId: params.sessionId,
              consolidations: metricPasses,
              promotions: metricPromotions,
              demotions: metricDemotions,
              merges: metricMerges,
              tokensSpent: result.tokensBefore,
            },
            now,
          );
        } catch (metricErr) {
          console.error(`[memory-l3] metric recording failed: ${(metricErr as Error).message}`);
        }
        // Cross-brain reconciliation: only fires when typed consolidation
        // produced a new or changed slot — otherwise the prose↔typed
        // landscape didn't shift since the last pass and we'd just spend
        // an LLM round-trip to confirm what's already on disk. Failures
        // are non-fatal; the worst case is one stale prose fact slipping
        // through to retrieval until the next pass.
        if (typedActivity) {
          try {
            const rec = await reconcileCrossBrain({
              storage: this.storage,
              caller,
              agentId: this.state.agentId,
              now,
            });
            l3debug(
              `afterTurn(): reconcile prose=${rec.proseFactsConsidered} typed=${rec.typedFactsConsidered} newlyStale=${rec.newlyMarkedStale} unmarked=${rec.unmarkedNowAgreed} detStale=${rec.deterministicStale ?? 0}`,
            );
          } catch (recErr) {
            console.error(
              `[memory-l3] cross-brain reconciliation failed: ${(recErr as Error).message}`,
            );
          }
        }
        // Prose-prose interference detection (Microsoft "Forgetting Is the Fix"):
        // Algorithmic (no LLM) — detects topically similar prose facts from
        // different time periods and marks the older one as superseded.
        try {
          const pi = await reconcileProseInterference({
            storage: this.storage,
            agentId: this.state.agentId,
            now,
          });
          if (pi.newlySuperseded > 0 || pi.cleared > 0) {
            l3debug(
              `afterTurn(): prose interference considered=${pi.factsConsidered} superseded=${pi.newlySuperseded} cleared=${pi.cleared}`,
            );
          }
        } catch (piErr) {
          console.error(
            `[memory-l3] prose interference detection failed: ${(piErr as Error).message}`,
          );
        }
        // G1 generative reflection: synthesize higher-order insights from the
        // top facts into the relevance-gated insight retrieval tier. One extra
        // LLM call per epoch, so gated behind OPENCLAW_MEMORY_L3_REFLECTION.
        // Non-fatal — facts are already persisted.
        if (REFLECTION_ENABLED) {
          try {
            const refl = await reflectAndStore({
              storage: this.storage,
              caller,
              agentId: this.state.agentId,
              now,
              config: { ...DEFAULT_REFLECTION_CONFIG, enabled: true },
            });
            if (refl.added > 0) {
              l3debug(`afterTurn(): reflection added=${refl.added} total=${refl.total}`);
            }
          } catch (reflErr) {
            console.error(`[memory-l3] reflection failed: ${(reflErr as Error).message}`);
          }
        }
      }
      await this.storage.writeState(this.state);
    } catch (err) {
      // Real failures stay loud regardless of debug flag — compaction errors
      // are operational signals worth surfacing.
      console.error(`[memory-l3] afterTurn compaction failed: ${(err as Error).message}`);
    }
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    // Optional so this override stays assignable to ContextEngine.compact, whose
    // callers pass a storage-neutral sessionTarget rather than a file path. L3
    // compacts purely from sessionId + its own buffer, so the extra fields are
    // accepted but unused.
    sessionFile?: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
  }): Promise<CompactResult> {
    if (!this.state) {
      return { ok: false, compacted: false, reason: "engine not bootstrapped" };
    }
    const caller = await this.resolveCaller();
    if (!caller) {
      return {
        ok: false,
        compacted: false,
        reason: "no LlmCaller available (no zai key in env or auth-profiles.json)",
      };
    }
    const { chunkId, factsAdded, tokensBefore, messagesIngested } = await compactSession({
      sessionId: params.sessionId,
      buffer: this.buffer,
      storage: this.storage,
      caller,
      state: this.state,
      embeddingProvider: await this.resolveEmbeddingProvider(),
    });
    if (chunkId === null) {
      return {
        ok: true,
        compacted: false,
        reason: "no buffered messages to compact",
        result: { tokensBefore: 0, tokensAfter: 0 },
      };
    }
    await this.storage.writeState(this.state);
    // Invalidate ReTopK cache — compaction wrote new facts.
    this.invalidateRetrievalCache();
    return {
      ok: true,
      compacted: true,
      reason: `wrote chunk ${chunkId} with ${factsAdded} fact(s) over ${messagesIngested} message(s)`,
      result: {
        firstKeptEntryId: chunkId,
        tokensBefore,
        tokensAfter: 0,
      },
    };
  }

  /**
   * Compute query embedding for semantic retrieval signal.
   * Returns undefined when no embedding provider is configured or the call fails.
   */
  private async resolveQueryEmbedding(query: string): Promise<number[] | undefined> {
    const provider = await this.resolveEmbeddingProvider();
    if (!provider) {
      return undefined;
    }
    try {
      return await provider.embed(query);
    } catch {
      return undefined;
    }
  }

  /**
   * Lazily resolve an embedding provider from core OpenClaw infrastructure.
   *
   * Resolution order:
   *   1. Explicit override passed via HierarchicalL3EngineOptions
   *   2. Core embedding provider resolved from config (via dynamic import)
   *
   * The result is cached after first resolution (null = tried and failed,
   * undefined = not yet attempted). This keeps the synchronous factory
   * function clean while still connecting to the provider at runtime.
   */
  private async resolveEmbeddingProvider(): Promise<EmbeddingProvider | undefined> {
    if (this.resolvedEmbeddingProvider !== undefined) {
      // null = already tried and no provider available
      return this.resolvedEmbeddingProvider ?? undefined;
    }

    // 1. Explicit override from constructor options (e.g. tests)
    if (this.embeddingProviderOverride) {
      this.resolvedEmbeddingProvider = this.embeddingProviderOverride;
      return this.resolvedEmbeddingProvider;
    }

    // 2. Try to resolve from core OpenClaw embedding provider infrastructure
    try {
      // Lazy import via the public SDK seam (loaded only when the semantic
      // channel is first needed) — keeps the embedding runtime out of the eager
      // module graph without reaching into core `src/**`.
      const { getMemoryEmbeddingProvider } =
        await import("openclaw/plugin-sdk/memory-core-host-engine-embeddings");
      const adapter = getMemoryEmbeddingProvider("openai", this.config);
      if (!adapter) {
        l3debug("resolveEmbeddingProvider(): no openai adapter found; semantic channel disabled");
        this.resolvedEmbeddingProvider = null;
        return undefined;
      }
      if (!this.config || !adapter.defaultModel) {
        l3debug("resolveEmbeddingProvider(): missing config or model; semantic channel disabled");
        this.resolvedEmbeddingProvider = null;
        return undefined;
      }
      const { provider } = await adapter.create({
        config: this.config,
        model: adapter.defaultModel,
      });
      if (!provider) {
        l3debug("resolveEmbeddingProvider(): adapter.create() returned no provider");
        this.resolvedEmbeddingProvider = null;
        return undefined;
      }
      // Wrap the core EmbeddingProvider as our local EmbeddingProvider type;
      // queries ride the canonical inputType: "query" flag (the pre-canonical
      // embedQuery API was removed upstream with the MemoryEmbeddingProvider alias).
      const wrapped: EmbeddingProvider = {
        embed: async (text: string) => await provider.embed(text, { inputType: "query" }),
        embedBatch: (texts: string[]) => provider.embedBatch(texts),
      };
      this.resolvedEmbeddingProvider = wrapped;
      l3debug("resolveEmbeddingProvider(): resolved provider from core infrastructure");
      return wrapped;
    } catch (err) {
      l3debug(`resolveEmbeddingProvider(): failed to resolve from core: ${(err as Error).message}`);
      this.resolvedEmbeddingProvider = null;
      return undefined;
    }
  }

  private async resolveCaller(): Promise<LlmCaller | null> {
    if (this.callerOverride) {
      return this.callerOverride;
    }
    const apiKey = await this.resolveZaiKey();
    if (!apiKey) {
      return null;
    }
    return createGlmCaller({ apiKey });
  }

  /**
   * Resolution order:
   *   1. process.env.ZAI_API_KEY  (matches OpenClaw's user-shell convention)
   *   2. process.env.Z_AI_API_KEY (compat alias)
   *   3. OpenClaw config → plugins.entries.agentmcp.config.zaiApiKey
   *   4. OpenClaw config → models.providers.zai.apiKey
   *   5. <agentDir>/agent/auth-profiles.json → profiles["zai:default"].key
   */
  private async resolveZaiKey(): Promise<string | null> {
    if (this.cachedZaiKey !== undefined) {
      return this.cachedZaiKey;
    }
    // 1–2. Environment variables
    const fromEnv = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY ?? "";
    if (fromEnv.length > 0) {
      l3debug("resolveZaiKey: hit via env");
      this.cachedZaiKey = fromEnv;
      return fromEnv;
    }
    // 3–4. OpenClaw config (keys are typically stored here, not in env)
    const fromConfig = readZaiKeyFromConfig(this.config);
    if (fromConfig) {
      l3debug("resolveZaiKey: hit via openclaw config");
      this.cachedZaiKey = fromConfig;
      return fromConfig;
    }
    // 5. Auth profiles file
    const fromAuth = await readZaiKeyFromAuthProfiles(this.agentDir);
    l3debug(
      `resolveZaiKey: agentDir=${this.agentDir ?? "(undefined)"} auth-result=${fromAuth ? "hit" : "miss"}`,
    );
    this.cachedZaiKey = fromAuth;
    return fromAuth;
  }

  async dispose(): Promise<void> {
    try {
      if (this.state) {
        await this.storage.writeState(this.state);
      }
    } finally {
      // Release the cached SQLite handle + its WAL-maintenance timer.
      this.storage.close();
    }
  }
}

/**
 * Derive the agentId from the runtime-supplied agentDir. OpenClaw passes the
 * inner directory `<agentsRoot>/<agentId>/agent` so the parent's basename is
 * the agent id. Returns null when the path doesn't fit the expected shape.
 */
function deriveAgentIdFromAgentDir(agentDir: string | undefined): string | null {
  if (!agentDir) {
    return null;
  }
  const parent = path.dirname(agentDir);
  const candidate = path.basename(parent);
  if (!candidate || candidate === "." || candidate === "/" || candidate === "..") {
    return null;
  }
  return candidate;
}

/**
 * Read ZAI API key from the OpenClaw config object.
 * Checks two common locations where the key may be stored:
 *   1. plugins.entries.agentmcp.config.zaiApiKey  (agentmcp plugin)
 *   2. models.providers.zai.apiKey               (provider config)
 */
function readZaiKeyFromConfig(config: OpenClawConfig | undefined): string | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyCfg = config as any;
  // Path 1: agentmcp plugin config
  const fromAgentmcp = anyCfg?.plugins?.entries?.agentmcp?.config?.zaiApiKey;
  if (typeof fromAgentmcp === "string" && fromAgentmcp.length > 0) {
    return fromAgentmcp;
  }
  // Path 2: models provider config
  const fromModels = anyCfg?.models?.providers?.zai?.apiKey;
  if (typeof fromModels === "string" && fromModels.length > 0) {
    return fromModels;
  }
  return null;
}

async function readZaiKeyFromAuthProfiles(agentDir: string | undefined): Promise<string | null> {
  if (!agentDir) {
    return null;
  }
  // OpenClaw's runtime hands us the inner `<agentRoot>/agent/` directory.
  // The auth-profiles file lives directly inside it, alongside auth-state.json,
  // models.json, etc. Don't double-join "agent".
  const target = path.join(agentDir, "auth-profiles.json");
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { type?: string; provider?: string; key?: string }>;
    };
    const profile = parsed.profiles?.["zai:default"];
    if (
      profile?.type === "api_key" &&
      profile.provider === "zai" &&
      typeof profile.key === "string"
    ) {
      return profile.key;
    }
    for (const candidate of Object.values(parsed.profiles ?? {})) {
      if (
        candidate.type === "api_key" &&
        candidate.provider === "zai" &&
        typeof candidate.key === "string" &&
        candidate.key.length > 0
      ) {
        return candidate.key;
      }
    }
    return null;
  } catch {
    return null;
  }
}
