/**
 * CCR Retrieve Tool Executor — handles `ccr_retrieve` tool calls at runtime.
 *
 * When CCR is enabled, this module provides both the tool definition (to inject
 * into the model's available tools) and the execute function (to handle the
 * model's tool calls and return original data from the CCR store).
 *
 * Usage in attempt.ts:
 *   const ccrTool = createCCRRetrieveTool(ccrStore);
 *   if (ccrTool) effectiveTools.push(ccrTool);
 */
import type { Tool } from "../../llm/types.js";
import type { CCRStore } from "./store.js";

/**
 * The ccr_retrieve tool is an LLM schema tool (sent to the model alongside other
 * tool schemas) that also carries a runtime `execute` dispatched by the CCR
 * retrieval path — not the standard AgentTool runtime, so its execute returns the
 * raw retrieval payload rather than an `AgentToolResult`.
 */
export type CcrRetrieveTool = Tool & {
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
};

export type { CCRRetrieveParams } from "./retrieval-tool.js";
export { CCR_RETRIEVE_TOOL_NAME, ccrRetrieveToolDefinition } from "./retrieval-tool.js";
import { CCR_RETRIEVE_TOOL_NAME } from "./retrieval-tool.js";

/**
 * Create the ccr_retrieve tool with an execute function bound to a CCR store.
 * Returns null if the store is not available (graceful degradation).
 */
export function createCCRRetrieveTool(store: CCRStore | undefined): CcrRetrieveTool | null {
  if (!store || store.isClosed) {
    return null;
  }

  return {
    name: CCR_RETRIEVE_TOOL_NAME,
    description:
      "Retrieve original uncompressed data from the context compression cache. " +
      "Use when compressed tool output lacks the detail you need — including exact dates/times " +
      "elided by compression (compressed output only keeps a time-range anchor). " +
      "The hash key is provided in the compression marker (e.g., 'Retrieve: hash=abc123'). " +
      "Optionally provide a query to filter results by keywords.",
    parameters: {
      type: "object",
      properties: {
        hash: {
          type: "string",
          description: "Hash key from the compression marker",
        },
        query: {
          type: "string",
          description:
            "Optional: search within cached data to get a filtered subset. " +
            "Use space-separated keywords to narrow results.",
        },
        maxResults: {
          type: "number",
          description: "Max results when using query filtering. Default: 20.",
        },
      },
      required: ["hash"],
    },
    execute: async (_callId: string, args: Record<string, unknown>, _signal?: AbortSignal) => {
      const hash = args.hash as string;
      const query = args.query as string | undefined;
      const maxResults = (args.maxResults as number) ?? 20;

      if (!hash || typeof hash !== "string") {
        return { error: "Missing or invalid hash parameter." };
      }

      // If query provided, do filtered search
      if (query && typeof query === "string") {
        const results = store.search(hash, query, maxResults);
        if (results.length === 0) {
          // Fallback: return full content if search finds nothing
          const full = store.retrieve(hash);
          if (!full) {
            return { error: `No cached data found for hash=${hash}. It may have expired.` };
          }
          return {
            content: full,
            note: "No results matched your query. Returning full cached content.",
          };
        }
        return {
          content: results.join("\n"),
          totalMatches: results.length,
          hint: "Use without query parameter to retrieve the full original content.",
        };
      }

      // Full retrieval
      const content = store.retrieve(hash);
      if (!content) {
        return { error: `No cached data found for hash=${hash}. It may have expired.` };
      }

      return { content };
    },
  };
}
