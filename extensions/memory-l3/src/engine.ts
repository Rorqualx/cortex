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
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { compactSession } from "./compaction.js";
import { IngestBuffer } from "./ingest.js";
import { createGlmCaller, type LlmCaller } from "./llm.js";
import { selectSlidingWindow } from "./sliding-window.js";
import { Storage } from "./storage.js";
import { estimateTotalTokens } from "./token-estimate.js";
import type { L3State } from "./types.js";

const ENGINE_INFO: ContextEngineInfo = {
  id: "hierarchical-l3",
  name: "Hierarchical Memory (L1/L2/L3)",
  version: "0.1.0",
  ownsCompaction: false,
};

export function createHierarchicalL3Engine(ctx: ContextEngineFactoryContext): ContextEngine {
  const storage = Storage.fromWorkspace(ctx.workspaceDir);
  return new HierarchicalL3Engine(storage);
}

export type HierarchicalL3EngineOptions = {
  /** Override the default GLM-from-env LlmCaller. Used by tests. */
  caller?: LlmCaller;
};

// Stage 2: storage-backed bootstrap/dispose. Ingest, assemble, and compact
// remain passthrough stubs; subsequent stages (3-8) wire the L1/L2/L3
// algorithms onto this storage layer.
export class HierarchicalL3Engine implements ContextEngine {
  readonly info = ENGINE_INFO;
  private readonly storage: Storage;
  private readonly buffer = new IngestBuffer();
  private readonly callerOverride: LlmCaller | undefined;
  private state: L3State | null = null;

  constructor(storage: Storage, options?: HierarchicalL3EngineOptions) {
    this.storage = storage;
    this.callerOverride = options?.caller;
  }

  async bootstrap(): Promise<BootstrapResult> {
    await this.storage.ensureLayout();
    this.state = await this.storage.readState();
    return { bootstrapped: true };
  }

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
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
    if (params.tokenBudget && params.tokenBudget > 0) {
      const { selected, estimatedTokens } = selectSlidingWindow({
        messages: params.messages,
        tokenBudget: params.tokenBudget,
      });
      return { messages: selected, estimatedTokens };
    }
    return {
      messages: [...params.messages],
      estimatedTokens: estimateTotalTokens(params.messages),
    };
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
    const caller = this.resolveCaller();
    if (!caller) {
      return {
        ok: false,
        compacted: false,
        reason: "no LlmCaller available (Z_AI_API_KEY missing and no override)",
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

  private resolveCaller(): LlmCaller | null {
    if (this.callerOverride) return this.callerOverride;
    const apiKey = process.env.Z_AI_API_KEY;
    if (!apiKey || apiKey.length === 0) return null;
    return createGlmCaller({ apiKey });
  }

  async dispose(): Promise<void> {
    if (this.state) {
      await this.storage.writeState(this.state);
    }
  }
}
