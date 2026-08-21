/**
 * CCR Retrieval Tool — tool definition for the model to request original
 * uncompressed data from the CCR store.
 *
 * When CCR is enabled and content is compressed, the compressed output includes
 * a marker like: `[200 items → 15. Retrieve: hash=abc123]`
 *
 * The model can then call `ccr_retrieve` with that hash to get the original
 * data back. It can optionally provide a `query` to filter the results.
 */

export type CCRRetrieveParams = {
  /** Hash key from the compression marker. */
  hash: string;
  /** Optional: search within cached data to get a filtered subset. */
  query?: string;
  /** Optional: max number of results when using query filtering. Default: 20. */
  maxResults?: number;
};

export const CCR_RETRIEVE_TOOL_NAME = "ccr_retrieve";

/**
 * OpenAI-format tool definition for ccr_retrieve.
 * This gets injected into the model's available tools when CCR is enabled.
 */
export const ccrRetrieveToolDefinition = {
  type: "function" as const,
  function: {
    name: CCR_RETRIEVE_TOOL_NAME,
    description:
      "Retrieve original uncompressed data from the context compression cache. " +
      "Use when compressed tool output lacks the detail you need — including exact dates/times " +
      "elided by compression (compressed output only keeps a time-range anchor). " +
      "The hash key is provided in the compression marker (e.g., 'Retrieve: hash=abc123').",
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
            "Use keywords to narrow results.",
        },
        maxResults: {
          type: "number",
          description: "Max results when using query filtering. Default: 20.",
        },
      },
      required: ["hash"],
    },
  },
};

/**
 * Build the compression marker that gets appended to compressed tool output.
 * Format: [N items → M. Retrieve: hash=abc123]
 */
export function buildCompressionMarker(
  hash: string,
  originalItems: number,
  compressedItems: number,
): string {
  return `\n[${originalItems} items → ${compressedItems}. Retrieve: hash=${hash}]`;
}

/**
 * Extract all hash keys from a compressed content string.
 * Returns an array of hash strings found in compression markers.
 */
export function extractHashesFromContent(content: string): string[] {
  const matches = content.matchAll(/Retrieve: hash=([a-f0-9]+)/g);
  // Capture group 1 is non-optional in the regex, so it is always defined on a match.
  return [...matches].map((m) => m[1]!);
}
