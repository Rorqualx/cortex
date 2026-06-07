/**
 * CCR (Content Cache & Retrieval) — reversible compression layer.
 *
 * Phase 2 of the compression pipeline. When content is compressed, the
 * original is stored in a SQLite-backed cache. The model can retrieve
 * originals via the `ccr_retrieve` tool.
 */
export { CCRStore } from "./store.js";
export {
  CCR_RETRIEVE_TOOL_NAME,
  ccrRetrieveToolDefinition,
  buildCompressionMarker,
  extractHashesFromContent,
} from "./retrieval-tool.js";
export type { CCRRetrieveParams } from "./retrieval-tool.js";
export { createCCRRetrieveTool } from "./retrieval-tool-executor.js";
export { ContextTracker } from "./context-tracker.js";
