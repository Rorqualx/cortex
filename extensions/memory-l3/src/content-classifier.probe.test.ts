/**
 * PROBE TEST — Content-type classifier feasibility
 * Card: ARCH-1 d53eed50
 */
import { describe, it, expect } from 'vitest';
import { classifyContentType } from './content-classifier.js';

describe('content-classifier probe', () => {
  it('classifies code content', () => {
    const result = classifyContentType([
      { role: 'assistant', content: 'Here is the fix:' },
      { role: 'assistant', content: '```typescript\nexport function foo() {\n  return 42;\n}\n```' },
    ]);
    expect(result.type === 'code' || result.type === 'mixed').toBe(true);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('classifies JSON content', () => {
    const result = classifyContentType([
      { role: 'tool', content: '{"status": "ok", "data": {"items": [1, 2, 3]}, "count": 3}' },
    ]);
    expect(result.type === 'json' || result.type === 'tool-output' || result.type === 'mixed').toBe(true);
  });

  it('classifies prose content', () => {
    const result = classifyContentType([
      { role: 'user', content: 'I was thinking about the project roadmap. We should prioritize the memory improvements first, then tackle the UI refresh. What do you think?' },
      { role: 'assistant', content: 'That makes sense. The memory improvements will have the biggest impact on user experience. Let me outline a plan.' },
    ]);
    expect(result.type).toBe('prose');
  });

  it('classifies tool output', () => {
    const result = classifyContentType([
      { role: 'tool', content: 'exit code: 0\nstdout:\nPASS src/test.ts\nFAIL src/other.ts\n✓ 2 passed' },
    ]);
    expect(['tool-output', 'mixed'].includes(result.type)).toBe(true);
  });

  it('falls back to prose for empty content', () => {
    const result = classifyContentType([{ content: '' }]);
    expect(result.type).toBe('prose');
  });
});
