/**
 * Public SDK subpath bridging bundled context-engine plugins to the memory-core
 * search runtime and the core context-engine contract. Fork-owned seam:
 * memory-l3 (the fork's default context engine) reaches memory-core's search
 * manager through the bundled-plugin facade instead of a core `src/**` deep
 * import, and consumes the context-engine type contract from one stable subpath.
 */
import type { OpenClawConfig } from "../config/config.js";
import type { ContextEngineFactory } from "../context-engine/registry.js";
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";
import type { MemorySearchManager } from "./memory-core-host-engine-storage.js";

// Context-engine contract re-exports consumed by context-engine plugins.
export type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestBatchResult,
  IngestResult,
} from "../context-engine/types.js";
export type { ContextEngineFactory } from "../context-engine/registry.js";
export { registerContextEngine } from "../context-engine/registry.js";
export type { OpenClawConfig } from "../config/config.js";

/**
 * Runtime context handed to a context-engine factory. Derived from the exported
 * factory type because the core alias itself is registry-internal.
 */
export type ContextEngineFactoryContext = Parameters<ContextEngineFactory>[0];

type FacadeModule = {
  getMemorySearchManager: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status" | "cli";
  }) => Promise<{
    manager: MemorySearchManager | null;
    error?: string;
  }>;
};

function loadFacadeModule(): FacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "memory-core",
    artifactBasename: "runtime-api.js",
  });
}

/** Resolve the active memory search manager and any runtime availability error. */
export const getMemorySearchManager: FacadeModule["getMemorySearchManager"] = ((...args) =>
  loadFacadeModule().getMemorySearchManager(...args)) as FacadeModule["getMemorySearchManager"];
