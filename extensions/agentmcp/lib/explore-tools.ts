/**
 * Minimal stub for explore-tools.ts — only exports the constant needed by schemas.ts.
 * The full explore/swarm tools require Bun runtime and are available via the MCP server.
 */
export const EXPLORE_TOOL_NAMES = [
  "list_dir",
  "read_file",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "write_file",
  "write_files",
  "notebook_edit",
  "bash",
] as const;

export type ExploreToolName = (typeof EXPLORE_TOOL_NAMES)[number];
