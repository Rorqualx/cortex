/**
 * PROBE TEST — Generic submodular selection feasibility
 * Card: ARCH-1 6e85475c (PACMS)
 */
import { describe, it, expect } from 'vitest';
import { greedySubmodularSelect, selectContext, type ContextCandidate } from './submodular-context.js';

describe('greedySubmodularSelect probe', () => {
  it('selects items within token budget', () => {
    const pool = [
      { id: 'a', text: 'memory fact about rust', score: 0.9, tokens: 10 },
      { id: 'b', text: 'memory fact about typescript', score: 0.8, tokens: 10 },
      { id: 'c', text: 'memory fact about rust cargo', score: 0.7, tokens: 10 },
    ];
    const result = greedySubmodularSelect(pool, new Set(['rust', 'typescript']), {
      tokenBudget: 20,
      diversityWeight: 0.3,
      coverageWeight: 0.2,
      maxItems: 10,
    });
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result.every((r) => r.tokens <= 10)).toBe(true);
  });

  it('prefers high-relevance items', () => {
    const pool = [
      { id: 'low', text: 'unrelated text here', score: 0.1, tokens: 5 },
      { id: 'high', text: 'rust cargo build system', score: 0.95, tokens: 5 },
    ];
    const result = greedySubmodularSelect(pool, new Set(['rust', 'cargo']), {
      tokenBudget: 10,
      diversityWeight: 0.1,
      coverageWeight: 0.5,
      maxItems: 2,
    });
    expect(result[0].id).toBe('high');
  });

  it('respects maxItems constraint', () => {
    const pool = Array.from({ length: 20 }, (_, i) => ({
      id: `item-${i}`,
      text: `fact number ${i} about topics`,
      score: 0.5,
      tokens: 2,
    }));
    const result = greedySubmodularSelect(pool, new Set(['topics']), {
      tokenBudget: 1000,
      diversityWeight: 0.3,
      coverageWeight: 0.2,
      maxItems: 5,
    });
    expect(result.length).toBe(5);
  });
});

describe('selectContext probe', () => {
  it('handles mixed-source candidate pool', () => {
    const candidates: ContextCandidate[] = [
      { id: 'mem-1', text: 'user prefers rust', source: 'memory', relevanceScore: 0.9, tokenEstimate: 8 },
      { id: 'conv-1', text: 'lets use rust for this', source: 'conversation', relevanceScore: 0.7, tokenEstimate: 8 },
      { id: 'tool-1', text: 'cargo build exited 0', source: 'tool-output', relevanceScore: 0.3, tokenEstimate: 8 },
    ];
    const result = selectContext(candidates, new Set(['rust']), 20);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.length).toBeLessThanOrEqual(2);
    // High-relevance memory fact should be selected first
    expect(result.some((r) => r.id === 'mem-1')).toBe(true);
  });

  it('returns empty for empty pool', () => {
    const result = selectContext([], new Set(['test']), 100);
    expect(result).toEqual([]);
  });
});
