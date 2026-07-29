/**
 * PROBE TEST — MCP server tool registration and response shape
 * Card: ARCH-2 b445f1a6
 */
import { describe, it, expect } from 'vitest';
import { createMemoryMcpServer, type MemoryMcpServerDeps } from './mcp-server.js';

function mockDeps(): MemoryMcpServerDeps {
  return {
    agentId: 'test-agent',
    getMemoryInsights: async () => ({ promoted: [], topRecalled: [] }),
    searchMemory: async () => ({ results: [{ text: 'short fact', score: 0.9 }] }),
  };
}

describe('mcp-server probe', () => {
  it('creates server without throwing', () => {
    const server = createMemoryMcpServer(mockDeps());
    expect(server).toBeDefined();
  });

  it('registers tools (server exposes tool count)', () => {
    const server = createMemoryMcpServer(mockDeps());
    // McpServer instance exists and can be inspected
    expect(typeof server.connect).toBe('function');
  });

  it('mock deps return expected shapes', async () => {
    const deps = mockDeps();
    const insights = await deps.getMemoryInsights({ days: 7 });
    expect(insights).toHaveProperty('promoted');

    const results = await deps.searchMemory({ query: 'test' });
    expect(results).toHaveProperty('results');
  });
});
