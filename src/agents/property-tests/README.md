# Property-Based Tests for OpenClaw Agents

This directory contains property-based tests that verify core invariants across thousands of randomly generated inputs using the [fast-check](https://github.com/dubzzz/fast-check) library.

## Philosophy

Traditional example-based tests verify behavior against specific inputs:

```typescript
expect(applyPolicy(tools, { deny: ["bash"] })).not.toContain("bash");
```

Property-based tests verify **invariants** that must hold for **all possible inputs**:

```typescript
fc.assert(
  fc.property(arbitraryTools, arbitraryPolicy, (tools, policy) => {
    const result = applyPolicy(tools, policy);
    // Invariant: No denied tool should ever be in the result
    for (const denied of policy.deny) {
      expect(result).not.toContain(denied);
    }
  }),
);
```

## Invariants Tested

### Tool Policy Pipeline (`tool-policy-pipeline.properties.test.ts`)

#### DENY_FIRST_RULE Invariants

1. **Deny Always Overrides Allow**
   - Invariant: Tools in any denylist are blocked, regardless of allowlist entries
   - Tested: `blocks tools in denylist even if in allowlist`
   - Security guarantee: A tool denied at ANY layer is blocked, even if explicitly allowed elsewhere

2. **Multi-Layer Deny Propagation**
   - Invariant: A tool denied in ANY policy layer is excluded from results
   - Tested: `blocks denied tools regardless of allow order`
   - Prevents policy layering bypass attempts

3. **Order-Independent Deny Processing**
   - Invariant: Denylists are processed before allowlists within each step
   - Tested: `denylist is processed before allowlist within each step`
   - Ensures deterministic evaluation order

#### Allowlist Behavior Invariants

4. **Wildcard Allow Permits Non-Denied Tools**
   - Invariant: With `allow: ['*']`, only denied tools are blocked
   - Tested: `wildcard allow permits all non-denied tools`
   - Baseline allow-all behavior (minus denies)

5. **Specific Allowlist Restriction**
   - Invariant: With specific allowlist, only listed tools are permitted
   - Tested: `specific allowlist permits only listed tools`
   - Default-deny mode when allowlist is present

6. **Empty Denylist with Wildcard**
   - Invariant: `{ deny: [], allow: ['*'] }` permits all tools
   - Tested: `wildcard allow with empty denylist permits all tools`
   - No-op policy configuration

#### Empty/Undefined Policy Invariants

7. **Empty Policy Allows All**
   - Invariant: Policy with no deny/allow allows all tools through
   - Tested: `empty policy (no deny, no allow) allows all tools`
   - Safe default behavior

8. **Undefined Policy is Skipped**
   - Invariant: `policy: undefined` step passes tools through unchanged
   - Tested: `undefined policy is skipped`
   - Graceful handling of missing policy

#### Multi-Layer Composition Invariants

9. **Intersection of Allowlists**
   - Invariant: Tools must be allowed in ALL layers with allowlists
   - Tested: `intersection of allowlists across layers`
   - Prevents permission escalation through layer addition

10. **Deterministic Layer Order**
    - Invariant: Default pipeline steps evaluate in documented order
    - Tested: `default pipeline steps are in correct order`
    - Predictable policy evaluation sequence

#### Additional Properties

11. **Determinism**
    - Invariant: Same inputs always produce same outputs
    - Tested: `same inputs always produce same outputs`
    - No hidden randomness or external state

12. **Edge Case Handling**
    - Invariant: Empty tool lists, duplicates, empty strings handled gracefully
    - Tested: Multiple edge case tests
    - Robustness to malformed inputs

### Agent Steering Queue (`agent-steering-queue.properties.test.ts`)

#### Ordering Invariants

1. **Deterministic Ordering by endedAt**
   - Invariant: Queue returns items in ascending `endedAt` order
   - Tested: `maintains deterministic ordering by endedAt`
   - Predictable announcement sequence

2. **Stable Sort for Equal Timestamps**
   - Invariant: Items with equal `endedAt` maintain insertion order
   - Tested: `stable sort for equal timestamps`
   - No arbitrary reordering of simultaneous completions

#### Lease Management Invariants

3. **Lease Uniqueness**
   - Invariant: No queue item can have multiple active leases
   - Tested: `never assigns duplicate leases`
   - Prevents duplicate announcement processing

4. **Lease Consumer Tracking**
   - Invariant: Each lease records which consumer holds it
   - Tested: `tracks lease consumer correctly`
   - Attribution for debugging and cleanup

#### Lease Reclamation Invariants

5. **Stale Lease Detection**
   - Invariant: Leases older than timeout are marked stale
   - Tested: `detects stale leases after timeout`
   - Automatic cleanup of abandoned work

6. **Reclaimed Items Return to Pending**
   - Invariant: Reclaimed items become available for leasing again
   - Tested: `reclaimed items return to pending`
   - No permanent queue blocking

7. **Reclaim Preserves Original Data**
   - Invariant: Reclaimed items retain original properties
   - Tested: `reclaim preserves item data`
   - No data loss during reclamation

8. **Reclaim Idempotency**
   - Invariant: Reclaiming same item multiple times is safe
   - Tested: `reclaim is idempotent`
   - Robustness to concurrent reclaim attempts

#### Queue Operations Invariants

9. **Enqueue Increments Count**
   - Invariant: Each enqueue increases pending count
   - Tested: `enqueue increments pending count`
   - Accurate queue sizing

10. **Dequeue Decrements Count**
    - Invariant: Each dequeue decreases pending count
    - Tested: `dequeue decrements pending count`
    - Accurate queue sizing

11. **TryLease Returns Null When Empty**
    - Invariant: Empty queue returns null from tryLease
    - Tested: `tryLease returns null when empty`
    - Graceful handling of empty state

#### Edge Cases

12. **Handles Empty Queue**
    - Invariant: All operations work correctly on empty queue
    - Tested: `handles empty queue`
    - No crashes on boundary conditions

13. **Handles Single Item**
    - Invariant: All operations work correctly with one item
    - Tested: `handles single item`
    - Minimal viable state

## Running Property Tests

### All Property Tests

```bash
pnpm test src/agents/property-tests/
```

### Specific Test Suite

```bash
pnpm test src/agents/property-tests/tool-policy-pipeline.properties.test.ts
pnpm test src/agents/property-tests/agent-steering-queue.properties.test.ts
```

### With Increased Iterations

```bash
FAST_CHECK_ITERATIONS=10000 pnpm test src/agents/property-tests/
```

## CI Integration

Property tests are included in the CI pipeline via the existing agents test configuration:

- **Pattern**: `src/agents/**/*.test.ts` includes `src/agents/property-tests/**/*.properties.test.ts`
- **Config**: `test/vitest/vitest.agents.config.ts`
- **Shard**: `agents-core` includes property tests

## Adding New Property Tests

1. **Identify the invariant**: What must always be true?
2. **Create the generator**: Add arbitrary generators in `test-helpers/property-generators.ts`
3. **Write the property**: Use `fc.assert(fc.property(arb, (value) => { ... }))`
4. **Document the invariant**: Add to this README

Example:

```typescript
describe("MyComponent properties", () => {
  it("my invariant holds", () => {
    fc.assert(
      fc.property(arbMyInput, (input) => {
        const result = myComponent(input);
        // Invariant check
        expect(result.satisfiesInvariant).toBe(true);
      }),
    );
  });
});
```

## Generators Reference

See `src/agents/test-helpers/property-generators.ts` for available arbitraries:

| Generator                            | Description                                  |
| ------------------------------------ | -------------------------------------------- |
| `arbAgentMessage`                    | Agent messages with role, content, timestamp |
| `arbToolCallMessage`                 | Assistant messages with tool calls           |
| `arbToolPolicy`                      | Tool policy structures                       |
| `arbSubagentRunRecord`               | Subagent run records for queue testing       |
| `arbSubagentCompletionDeliveryState` | Delivery state for completion tracking       |
| `arbToolName`                        | Tool name strings                            |
| `arbUUID`                            | UUID v4 strings                              |
| `arbTimestamp`                       | Unix timestamps                              |
| `arbSessionKey`                      | Session key identifiers                      |
| `arbAgentId`                         | Agent identifier strings                     |

## References

- [fast-check documentation](https://fast-check.dev/)
- [Property-based testing introduction](https://hypothesis.works/articles/intro/)
- [Test utilities](../test-helpers/property-generators.ts)
