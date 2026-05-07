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

// Stage 2: storage-backed bootstrap/dispose. Ingest, assemble, and compact
// remain passthrough stubs; subsequent stages (3-8) wire the L1/L2/L3
// algorithms onto this storage layer.
class HierarchicalL3Engine implements ContextEngine {
  readonly info = ENGINE_INFO;
  private readonly storage: Storage;
  private state: L3State | null = null;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  async bootstrap(): Promise<BootstrapResult> {
    await this.storage.ensureLayout();
    this.state = await this.storage.readState();
    return { bootstrapped: true };
  }

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  async ingestBatch(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    return { ingestedCount: params.messages.length };
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

  async compact(): Promise<CompactResult> {
    return {
      ok: true,
      compacted: false,
      reason: "hierarchical-l3 v0.1.0 stub: L2 compaction not yet implemented",
    };
  }

  async dispose(): Promise<void> {
    if (this.state) {
      await this.storage.writeState(this.state);
    }
  }
}
