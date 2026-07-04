// Covers the model-facing arg-validation contract for the Z.ai MCP tools. These
// assertions hit the validation branches that return before any network call,
// so they need no ZAI_API_KEY and make no HTTP requests.
import { describe, expect, it } from "vitest";
import {
  EXPLORE_TOOL_NAMES,
  isReadOnlyTool,
  webReader,
  zread,
  type ZreadArgs,
} from "./explore-tools.js";

describe("Z.ai MCP explore tools", () => {
  it("registers web_reader and zread as read-only tools", () => {
    expect(EXPLORE_TOOL_NAMES).toContain("web_reader");
    expect(EXPLORE_TOOL_NAMES).toContain("zread");
    expect(isReadOnlyTool("web_reader")).toBe(true);
    expect(isReadOnlyTool("zread")).toBe(true);
  });

  it("web_reader rejects a missing/blank url before calling out", async () => {
    expect(await webReader({ url: "" })).toMatch(/'url' must be a non-empty string/);
    expect(await webReader({ url: "   " })).toMatch(/'url' must be a non-empty string/);
  });

  it("zread requires a repo_name", async () => {
    expect(await zread({ operation: "get_repo_structure", repo_name: "" })).toMatch(
      /'repo_name' must be a non-empty/,
    );
  });

  it("zread validates operation-specific required args", async () => {
    expect(await zread({ operation: "search_doc", repo_name: "vitejs/vite" })).toMatch(
      /'query' is required for operation 'search_doc'/,
    );
    expect(await zread({ operation: "read_file", repo_name: "vitejs/vite" })).toMatch(
      /'file_path' is required for operation 'read_file'/,
    );
    expect(await zread({ operation: "bogus", repo_name: "vitejs/vite" } as ZreadArgs)).toMatch(
      /'operation' must be one of/,
    );
  });
});
