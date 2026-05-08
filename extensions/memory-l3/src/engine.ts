import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngine,
  ContextEngineFactoryContext,
  ContextEngineInfo,
  IngestBatchResult,
  IngestResult,
} from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { getMemorySearchManager } from "openclaw/plugin-sdk/memory-core-engine-runtime";
import { compactSession } from "./compaction.js";
import { IngestBuffer } from "./ingest.js";
import { createGlmCaller, type LlmCaller } from "./llm.js";
import { consolidateLongTermTyped } from "./longterm-typed.js";
import { consolidateLongTerm } from "./longterm.js";
import { reconcileCrossBrain } from "./reconciliation.js";
import { formatMemorySection, type MemoryCoreLookup, retrieveTopK } from "./retrieval.js";
import { selectSlidingWindow } from "./sliding-window.js";
import { Storage } from "./storage.js";
import { estimateTotalTokens } from "./token-estimate.js";
import type { L3State } from "./types.js";

const ASSEMBLE_TOP_K = 5;
const AFTER_TURN_COMPACTION_THRESHOLD_TOKENS = 4000;

const DEBUG_ENABLED = process.env.OPENCLAW_MEMORY_L3_DEBUG === "1";

function l3debug(msg: string): void {
  if (DEBUG_ENABLED) {
    console.error(`[memory-l3] ${msg}`);
  }
}

const ENGINE_INFO: ContextEngineInfo = {
  id: "hierarchical-l3",
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
  private cachedZaiKey: string | null | undefined;
  private state: L3State | null = null;

  constructor(storage: Storage, options?: HierarchicalL3EngineOptions) {
    this.storage = storage;
    this.callerOverride = options?.caller;
    this.agentDir = options?.agentDir;
    this.config = options?.config;
    this.memoryCoreLookupOverride = options?.memoryCoreLookup;
    this.workspaceDir = options?.workspaceDir;
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

    const systemPromptAddition = await this.buildMemorySection(params.prompt);

    return {
      messages: window.selected,
      estimatedTokens: window.estimatedTokens,
      ...(systemPromptAddition ? { systemPromptAddition } : {}),
    };
  }

  private async buildMemorySection(prompt: string | undefined): Promise<string | undefined> {
    if (!prompt || prompt.length === 0) return undefined;
    const top = await retrieveTopK({
      query: prompt,
      storage: this.storage,
      topK: ASSEMBLE_TOP_K,
      memoryCoreLookup: this.resolveMemoryCoreLookup(),
    });
    if (top.length === 0) return undefined;
    return formatMemorySection(top, { now: Date.now() });
  }

  private resolveMemoryCoreLookup(): MemoryCoreLookup | undefined {
    if (this.memoryCoreLookupOverride) return this.memoryCoreLookupOverride;
    if (!this.config || !this.state?.agentId) return undefined;
    const cfg = this.config;
    const agentId = this.state.agentId;
    return async (query) => {
      try {
        const { manager, error } = await getMemorySearchManager({
          cfg,
          agentId,
          purpose: "default",
        });
        if (!manager || error) return [];
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
    if (params.isHeartbeat || !this.state) return;

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
    const tokens = this.buffer.tokens(params.sessionId);
    l3debug(
      `afterTurn(): sessionId=${params.sessionId} totalMessages=${params.messages.length} compactedSoFar=${compactedSoFar} newTail=${tail.length} bufferedTokens=${tokens} threshold=${AFTER_TURN_COMPACTION_THRESHOLD_TOKENS}`,
    );
    if (tokens < AFTER_TURN_COMPACTION_THRESHOLD_TOKENS) return;
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
      });
      if (result.chunkId !== null) {
        this.state.compactedMessageCountBySession[params.sessionId] = params.messages.length;
      }
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
          });
          this.state.lastConsolidatedAt = now;
          l3debug(
            `afterTurn(): consolidation promoted=${lt.promotedCount} reaffirmed=${lt.reaffirmedCount} archived=${lt.archivedCount} unarchived=${lt.unarchivedCount} active=${lt.activeCount}`,
          );
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
          });
          typedActivity = ltt.promotedCount + ltt.supersededCount > 0;
          l3debug(
            `afterTurn(): typed consolidation promoted=${ltt.promotedCount} superseded=${ltt.supersededCount} reaffirmed=${ltt.reaffirmedCount} archived=${ltt.archivedCount} active=${ltt.activeCount}`,
          );
        } catch (typedErr) {
          console.error(`[memory-l3] typed consolidation failed: ${(typedErr as Error).message}`);
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
              `afterTurn(): reconcile prose=${rec.proseFactsConsidered} typed=${rec.typedFactsConsidered} newlyStale=${rec.newlyMarkedStale} unmarked=${rec.unmarkedNowAgreed}`,
            );
          } catch (recErr) {
            console.error(
              `[memory-l3] cross-brain reconciliation failed: ${(recErr as Error).message}`,
            );
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
    sessionFile: string;
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

  private async resolveCaller(): Promise<LlmCaller | null> {
    if (this.callerOverride) return this.callerOverride;
    const apiKey = await this.resolveZaiKey();
    if (!apiKey) return null;
    return createGlmCaller({ apiKey });
  }

  /**
   * Resolution order:
   *   1. process.env.ZAI_API_KEY  (matches OpenClaw's user-shell convention)
   *   2. process.env.Z_AI_API_KEY (compat alias)
   *   3. <agentDir>/agent/auth-profiles.json → profiles["zai:default"].key
   */
  private async resolveZaiKey(): Promise<string | null> {
    if (this.cachedZaiKey !== undefined) return this.cachedZaiKey;
    const fromEnv = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY ?? "";
    if (fromEnv.length > 0) {
      l3debug("resolveZaiKey: hit via env");
      this.cachedZaiKey = fromEnv;
      return fromEnv;
    }
    const fromAuth = await readZaiKeyFromAuthProfiles(this.agentDir);
    l3debug(
      `resolveZaiKey: agentDir=${this.agentDir ?? "(undefined)"} auth-result=${fromAuth ? "hit" : "miss"}`,
    );
    this.cachedZaiKey = fromAuth;
    return fromAuth;
  }

  async dispose(): Promise<void> {
    if (this.state) {
      await this.storage.writeState(this.state);
    }
  }
}

/**
 * Derive the agentId from the runtime-supplied agentDir. OpenClaw passes the
 * inner directory `<agentsRoot>/<agentId>/agent` so the parent's basename is
 * the agent id. Returns null when the path doesn't fit the expected shape.
 */
function deriveAgentIdFromAgentDir(agentDir: string | undefined): string | null {
  if (!agentDir) return null;
  const parent = path.dirname(agentDir);
  const candidate = path.basename(parent);
  if (!candidate || candidate === "." || candidate === "/" || candidate === "..") {
    return null;
  }
  return candidate;
}

async function readZaiKeyFromAuthProfiles(agentDir: string | undefined): Promise<string | null> {
  if (!agentDir) return null;
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
