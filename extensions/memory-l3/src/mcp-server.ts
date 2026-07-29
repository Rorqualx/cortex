/**
 * PROBE SPIKE — Minimal MCP stdio server exposing memory tools.
 * Card: ARCH-2 b445f1a6 (Cross-agent memory MCP endpoint)
 *
 * This is a feasibility spike. It verifies:
 * 1. The MCP SDK's McpServer + StdioServerTransport API works as expected
 * 2. Tool registration with schemas works
 * 3. The server can be constructed with a mock storage interface
 *
 * Phase 1 is deliberately minimal: stdio transport, read-only, local only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export interface MemoryMcpServerDeps {
  // Thin interface matching what collectMemoryInsights needs
  getMemoryInsights: (params: { days?: number; limit?: number }) => Promise<unknown>;
  searchMemory: (params: { query: string; topK?: number }) => Promise<unknown>;
  agentId: string;
}

const FACT_TEXT_MAX_CHARS = 200;

/**
 * Creates an MCP server exposing read-only memory tools.
 * Does NOT start the transport — caller controls lifecycle.
 */
export function createMemoryMcpServer(deps: MemoryMcpServerDeps): McpServer {
  const server = new McpServer(
    { name: 'openclaw-memory', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Tool: memory_trends — returns trend data (promoted facts, top recalled, etc.)
  server.registerTool(
    'memory_trends',
    {
      description: 'Get recent memory trends: promoted facts, top-recalled, and typed-fact changes.',
      inputSchema: {
        days: z.number().int().min(1).max(90).default(7).describe('Lookback window in days'),
        limit: z.number().int().min(1).max(50).default(10).describe('Max items per category'),
      },
    },
    async (params) => {
      try {
        const insights = await deps.getMemoryInsights({
          days: params.days,
          limit: params.limit,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ agentId: deps.agentId, timestamp: Date.now(), insights }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: memory_search — semantic search over L3 facts
  server.registerTool(
    'memory_search',
    {
      description: 'Search the agent memory store for relevant facts. Returns top-K results.',
      inputSchema: {
        query: z.string().min(1).max(500).describe('Search query'),
        topK: z.number().int().min(1).max(20).default(5).describe('Max results'),
      },
    },
    async (params) => {
      try {
        const results = await deps.searchMemory({
          query: params.query,
          topK: params.topK,
        });
        // Clip fact text for safety
        const clipped = JSON.stringify(results, (key, value) => {
          if (key === 'text' && typeof value === 'string' && value.length > FACT_TEXT_MAX_CHARS) {
            return value.slice(0, FACT_TEXT_MAX_CHARS) + '...';
          }
          return value;
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ agentId: deps.agentId, timestamp: Date.now(), results: JSON.parse(clipped) }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

/**
 * Starts the MCP server on stdio transport.
 * Call this when OPENCLAW_MEMORY_L3_MCP_SERVER=1.
 */
export async function startMemoryMcpServer(deps: MemoryMcpServerDeps): Promise<void> {
  const server = createMemoryMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
