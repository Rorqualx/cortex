import { Type } from "typebox";
/**
 * QW5 (2026-09-23 analysis) — MCP multi-server namespace collision audit.
 *
 * Scripted audit of the multi-server tool-merge surface against the
 * collision/shadowing taxonomy. The merge point is `mergeMcpToolCatalogs`
 * (server + requester partitions) and the namespace layer is
 * `agent-bundle-mcp-names` (safe server names + `server__tool` framing).
 * The audit asserts:
 *   M1 — the same toolName from two distinct servers survives the merge
 *        unshadowed (one catalog entry per server, no silent drop);
 *   M2 — sanitization-colliding server names get distinct safe names from the
 *        full declared set (precomputed, declaration order);
 *   M3 — model-facing names namespace identical toolNames distinctly and
 *        survive reserved-name cross-checks without swapping servers;
 *   M4 — policyTools/sessionDeniedTools default consistently through the merge;
 *   M5 — the merge is deterministic (byte-stable ordering across runs).
 */
import { describe, expect, it } from "vitest";
import { mergeMcpToolCatalogs } from "./agent-bundle-mcp-combined.js";
import {
  assignSafeServerNames,
  buildSafeToolName,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";
import type { McpCatalogTool, McpToolCatalog } from "./agent-bundle-mcp-types.js";

function makeCatalogTool(
  serverName: string,
  safeServerName: string,
  toolName: string,
): McpCatalogTool {
  return {
    serverName,
    safeServerName,
    toolName,
    description: `${serverName}/${toolName}`,
    inputSchema: Type.Object({ query: Type.String() }),
    fallbackDescription: `${serverName}/${toolName} fallback`,
  };
}

function makeCatalog(
  serverName: string,
  safeServerName: string,
  toolNames: readonly string[],
): McpToolCatalog {
  return {
    version: 1,
    generatedAt: 1,
    servers: {
      [serverName]: {
        serverName,
        ...(safeServerName ? { safeServerName } : {}),
        launchSummary: "stdio test fixture",
        toolCount: toolNames.length,
      },
    },
    tools: toolNames.map((toolName) => makeCatalogTool(serverName, safeServerName, toolName)),
  };
}

describe("MCP multi-server namespace collision audit", () => {
  it("M1: same toolName from two distinct servers survives the merge unshadowed", () => {
    const alpha = makeCatalog("alpha", "alpha", ["search", "fetch"]);
    const beta = makeCatalog("beta", "beta", ["search", "echo"]);
    const merged = mergeMcpToolCatalogs([alpha, beta]);

    // No shadowing: every (server, tool) pair from both catalogs is present.
    expect(merged.tools).toHaveLength(4);
    const searchTools = merged.tools.filter((t) => t.toolName === "search");
    expect(searchTools.map((t) => t.serverName).sort()).toEqual(["alpha", "beta"]);

    // Server map carries both servers (no clobbering).
    expect(Object.keys(merged.servers).sort()).toEqual(["alpha", "beta"]);
  });

  it("M2: sanitization-colliding server names get distinct safe names from the declared set", () => {
    // Both raw names sanitize toward the same fragment; the assigner must
    // disambiguate while preserving declaration order.
    const assigned = assignSafeServerNames(["my.server", "my-server"]);
    const values = [...assigned.values()];
    expect(new Set(values).size).toBe(2);
    // Declaration order owns the base fragment; the later declaration gets suffixed.
    expect(values[0]).not.toContain("-2");
    expect(values[1]).toContain("-2");

    // Trivially distinct names pass through unchanged.
    const distinct = assignSafeServerNames(["alpha", "beta"]);
    expect([...distinct.values()]).toEqual(["alpha", "beta"]);
  });

  it("M3: identical toolNames namespace distinctly per server and resist reserved-name shadowing", () => {
    const safe = assignSafeServerNames(["alpha", "beta"]);
    const safeAlpha = safe.get("alpha")!;
    const safeBeta = safe.get("beta")!;

    const alphaName = buildSafeToolName({
      serverName: safeAlpha,
      toolName: "search",
      reservedNames: new Set(),
    });
    const betaName = buildSafeToolName({
      serverName: safeBeta,
      toolName: "search",
      reservedNames: new Set(),
    });

    // Distinct model-facing names; each keeps its server prefix + separator.
    expect(alphaName).not.toBe(betaName);
    expect(alphaName.startsWith(`${safeAlpha}${TOOL_NAME_SEPARATOR}`)).toBe(true);
    expect(betaName.startsWith(`${safeBeta}${TOOL_NAME_SEPARATOR}`)).toBe(true);
    expect(alphaName.endsWith("search")).toBe(true);
    expect(betaName.endsWith("search")).toBe(true);

    // A reserved name from one server never forces the other server's tool
    // out of its own namespace (no cross-server swap).
    const betaAgain = buildSafeToolName({
      serverName: safeBeta,
      toolName: "search",
      reservedNames: new Set([alphaName.toLowerCase()]),
    });
    expect(betaAgain).toBe(betaName);
  });

  it("M4: policyTools default consistently and sessionDeniedTools carry through the merge", () => {
    const alpha = makeCatalog("alpha", "alpha", ["search"]);
    const beta = makeCatalog("beta", "beta", ["search"]);
    const denied = makeCatalogTool("beta", "beta", "secret");
    const betaWithDenied: McpToolCatalog = {
      ...beta,
      sessionDeniedTools: [denied],
    };
    const merged = mergeMcpToolCatalogs([alpha, betaWithDenied]);

    // policyTools defaults to tools + sessionDeniedTools when a partition omits it.
    expect(merged.policyTools).toHaveLength(3);
    expect(merged.sessionDeniedTools).toEqual([denied]);
    // Denial never shadows the callable catalog.
    expect(merged.tools).toHaveLength(2);
  });

  it("M5: the merge is deterministic across runs", () => {
    const alpha = makeCatalog("alpha", "alpha", ["search", "fetch"]);
    const beta = makeCatalog("beta", "beta", ["search", "echo"]);
    const first = mergeMcpToolCatalogs([alpha, beta]);
    const second = mergeMcpToolCatalogs([alpha, beta]);
    expect(JSON.stringify(first.tools)).toBe(JSON.stringify(second.tools));

    // Ordering is stable regardless of input order: safeServerName is the
    // primary key, so partition order cannot reshuffle dispatch identity.
    const reversed = mergeMcpToolCatalogs([beta, alpha]);
    expect(reversed.tools.map((t) => t.serverName)).toEqual(first.tools.map((t) => t.serverName));
  });
});
