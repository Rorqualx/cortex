import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { getRuntimeConfig } from "../config/config.js";
import { getMemoryEmbeddingProvider } from "../plugins/memory-embedding-provider-runtime.js";
import type { EmbedFn } from "./embedding-clusterer.js";

export type EmbeddingProviderResolution =
  | { status: "ok"; embed: EmbedFn; providerId: string; model: string }
  | { status: "unavailable"; reason: string };

export async function tryResolveSkillForgeEmbeddingProvider(
  params: {
    agentId?: string;
  } = {},
): Promise<EmbeddingProviderResolution> {
  let cfg;
  try {
    cfg = getRuntimeConfig();
  } catch (error) {
    return {
      status: "unavailable",
      reason: `runtime config unavailable: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }
  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const memorySearch = resolveMemorySearchConfig(cfg, agentId);
  if (!memorySearch) {
    return {
      status: "unavailable",
      reason: `memory search is not enabled for agent ${agentId}; set agents.${agentId}.memorySearch.enabled to true in openclaw.json`,
    };
  }
  if (memorySearch.provider === "auto") {
    return {
      status: "unavailable",
      reason:
        "memory.provider='auto' is not supported in skill-forge yet; set an explicit provider id",
    };
  }
  const adapter = getMemoryEmbeddingProvider(memorySearch.provider, cfg);
  if (!adapter) {
    return {
      status: "unavailable",
      reason: `embedding provider '${memorySearch.provider}' is not registered (plugins may not be loaded)`,
    };
  }
  const agentDir = resolveAgentDir(cfg, agentId);
  let created;
  try {
    created = await adapter.create({
      config: cfg,
      agentDir,
      model: memorySearch.model || adapter.defaultModel || "",
      local: memorySearch.local,
      remote: memorySearch.remote
        ? {
            baseUrl: memorySearch.remote.baseUrl,
            apiKey: memorySearch.remote.apiKey,
            headers: memorySearch.remote.headers,
          }
        : undefined,
      ...(typeof memorySearch.outputDimensionality === "number"
        ? { dimensions: memorySearch.outputDimensionality }
        : {}),
    });
  } catch (error) {
    return {
      status: "unavailable",
      reason: `embedding adapter ${adapter.id} threw during create: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    };
  }
  if (!created.provider) {
    return {
      status: "unavailable",
      reason: `embedding adapter ${adapter.id} returned no provider`,
    };
  }
  const provider = created.provider;
  return {
    status: "ok",
    providerId: provider.id,
    model: provider.model,
    embed: async (text: string) => provider.embed(text, { inputType: "query" }),
  };
}
