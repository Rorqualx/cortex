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

const ENGINE_INFO: ContextEngineInfo = {
  id: "hierarchical-l3",
  name: "Hierarchical Memory (L1/L2/L3)",
  version: "0.1.0",
  ownsCompaction: false,
};

export function createHierarchicalL3Engine(_ctx: ContextEngineFactoryContext): ContextEngine {
  return new HierarchicalL3Engine();
}

// Stage 1: passthrough stub. Every required method satisfies the ContextEngine
// contract with legacy-equivalent semantics. The L1/L2/L3 algorithms — sliding
// window, chunk fact-list with extract+update, epoch digest, hybrid retrieval —
// are filled in across subsequent stages.
class HierarchicalL3Engine implements ContextEngine {
  readonly info = ENGINE_INFO;

  async bootstrap(): Promise<BootstrapResult> {
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
    return {
      messages: [...params.messages],
      estimatedTokens: 0,
    };
  }

  async compact(): Promise<CompactResult> {
    return {
      ok: true,
      compacted: false,
      reason: "hierarchical-l3 v0.1.0 stub: L2 compaction not yet implemented",
    };
  }
}
