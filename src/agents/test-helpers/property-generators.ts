/**
 * Property-Based Testing Generators for OpenClaw
 *
 * Provides fast-check arbitraries for generating test data across:
 * - Agent messages and conversations
 * - Tool definitions and policies
 * - Subagent run records
 * - Session metadata
 *
 * These generators enable systematic testing of invariants across
 * all possible inputs rather than hand-crafted examples.
 *
 * @example
 * ```ts
 * fc.assert(fc.property(arbAgentMessage, (message) => {
 *   // Test invariant on any message
 *   expect(message.role).toBeDefined()
 * }))
 * ```
 */

import * as fc from "fast-check";
import type { SubagentRunRecord } from "../subagent-registry.types.js";

/**
 * Common tool names for policy testing
 *
 * These represent core tools that are always available in OpenClaw.
 */
export const COMMON_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "search",
  "web_search",
  "web_fetch",
  "ask",
  "browse",
  "run",
  "message",
] as const;

/**
 * Arbitrary generator for UUID v4 strings
 */
export const arbUUID = fc.uuid();

/**
 * Arbitrary generator for tool names
 *
 * Generates either common core tool names or random valid identifiers.
 */
export const arbToolName = fc.oneof(
  ...COMMON_TOOL_NAMES.map((name) => fc.constant(name)),
  fc.string({ minLength: 1, maxLength: 50 }),
);

/**
 * Arbitrary generator for agent messages
 *
 * @example
 * ```ts
 * fc.assert(fc.property(arbAgentMessage, (message) => {
 *   expect(message).toHaveProperty("role")
 *   expect(message).toHaveProperty("content")
 * }))
 * ```
 */
export const arbAgentMessage = fc.record({
  role: fc.constantFrom("user", "assistant", "system"),
  content: fc.string({ maxLength: 10_000 }),
  timestamp: fc.integer({ min: 0, max: Date.now() }),
});

/**
 * Arbitrary generator for tool call messages
 *
 * Generates assistant messages with tool calls.
 */
export const arbToolCallMessage = fc.record({
  role: fc.constantFrom("assistant"),
  content: fc.string(),
  toolCalls: fc.array(
    fc.record({
      id: arbUUID,
      name: arbToolName,
      arguments: fc.json(),
    }),
    { minLength: 1, maxLength: 10 },
  ),
});

/**
 * Arbitrary generator for tool policy
 *
 * Generates valid ToolPolicyLike structures with:
 * - Optional allow list of tool names
 * - Optional deny list of tool names
 * - Random wildcard entries
 */
export const arbToolPolicy = fc.record({
  allow: fc.array(fc.oneof(arbToolName, fc.constant("*")), { minLength: 0, maxLength: 20 }),
  deny: fc.array(arbToolName, { minLength: 0, maxLength: 20 }),
});

/**
 * Arbitrary generator for subagent completion delivery state
 */
export const arbSubagentCompletionDeliveryState = fc.record({
  status: fc.constantFrom(
    "pending",
    "in_progress",
    "delivered",
    "failed",
    "discarded",
    "suspended",
  ),
  createdAt: fc.integer({ min: 0, max: Date.now() }),
  deliveredAt: fc.option(fc.integer({ min: 0, max: Date.now() })),
  announcedAt: fc.option(fc.integer({ min: 0, max: Date.now() })),
  steeringLeaseId: fc.option(fc.string()),
  steeringLeasedAt: fc.option(fc.integer({ min: 0, max: Date.now() })),
  steeringInjectedAt: fc.option(fc.integer({ min: 0, max: Date.now() })),
  lastError: fc.option(fc.string()),
  lastDropReason: fc.option(fc.string()),
  suspendedAt: fc.option(fc.integer({ min: 0, max: Date.now() })),
  suspendedReason: fc.option(fc.string()),
});

/**
 * Arbitrary generator for subagent run records
 *
 * Generates minimal valid SubagentRunRecord structures
 * suitable for testing queue and registry operations.
 */
export const arbSubagentRunRecord: fc.Arbitrary<SubagentRunRecord> = fc.record({
  runId: arbUUID,
  childSessionKey: arbUUID,
  requesterSessionKey: arbUUID,
  requesterDisplayKey: fc.string({ minLength: 1, maxLength: 100 }),
  task: fc.string({ minLength: 1, maxLength: 200 }),
  cleanup: fc.constantFrom("delete", "keep"),
  createdAt: fc.integer({ min: 0, max: Date.now() }),
});

/**
 * Arbitrary generator for tool definitions
 *
 * Generates tool definition objects with:
 * - Required name field
 * - Optional description
 * - Optional input schema
 */
export const arbToolDefinition = fc.record({
  name: arbToolName,
  description: fc.option(fc.string({ maxLength: 1000 })),
  inputSchema: fc.option(
    fc.record({
      type: fc.constantFrom("object", "string", "number", "boolean", "array"),
      properties: fc.option(fc.constant({})),
      required: fc.option(fc.array(fc.string())),
    }),
  ),
});

/**
 * Arbitrary generator for Unix timestamps
 *
 * Generates timestamps within a reasonable range.
 */
export const arbTimestamp = fc.integer({ min: 0, max: Date.now() });

/**
 * Arbitrary generator for session keys
 *
 * Generates valid session key identifiers (hex strings).
 * fast-check 4.x doesn't have hexaString, so we compose from string.
 */
export const arbSessionKey = fc.string({ minLength: 32, maxLength: 64 }).map((s) => {
  // Convert to hex-like string (use char codes for hex representation)
  return Array.from(s)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(32, "0")
    .slice(0, 64);
});

/**
 * Arbitrary generator for agent IDs
 *
 * Generates valid agent identifier strings.
 */
export const arbAgentId = fc.string({ minLength: 1, maxLength: 100 });

/**
 * Arbitrary generator for API keys (masked)
 *
 * Generates masked API key strings like "sk-***" for testing.
 */
export const arbMaskedApiKey = fc
  .tuple(
    fc.constantFrom("sk-", "pk-", "oa-"),
    fc.string({ minLength: 3, maxLength: 10 }),
    fc.constant("***"),
  )
  .map(([prefix, middle, suffix]) => `${prefix}${middle}${suffix}`);

/**
 * Arbitrary generator for provider names
 *
 * Generates common provider identifiers.
 */
export const arbProviderName = fc.constantFrom(
  "openai",
  "anthropic",
  "openclaw",
  "google",
  "mcp",
  "plugin",
);

/**
 * Arbitrary generator for model identifiers
 *
 * Generates valid model ID strings.
 */
export const arbModelId = fc
  .tuple(arbProviderName, fc.string({ minLength: 1, maxLength: 50 }))
  .map(([provider, model]) => `${provider}/${model}`);

/**
 * Arbitrary generator for error objects
 *
 * Generates Error-like objects with message.
 */
export const arbError = fc
  .record({
    message: fc.string({ minLength: 1, maxLength: 1000 }),
    name: fc.option(fc.constantFrom("Error", "TypeError", "RangeError", "SyntaxError")),
    stack: fc.option(fc.string()),
  })
  .map((err) => {
    const error = new Error(err.message);
    if (err.name) {
      error.name = err.name;
    }
    return error;
  });

/**
 * Arbitrary generator for file paths
 *
 * Generates Unix-style file paths.
 */
export const arbFilePath = fc
  .array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 })
  .map((parts) => "/" + parts.join("/"));

/**
 * Arbitrary generator for URLs
 *
 * Generates valid HTTP/HTTPS URLs.
 */
export const arbUrl = fc
  .tuple(
    fc.constantFrom("http", "https"),
    fc.domain(),
    fc.option(fc.string({ minLength: 1, maxLength: 50 })),
  )
  .map(([protocol, domain, path]) => `${protocol}://${domain}${path ? `/${path}` : ""}`);

/**
 * Arbitrary generator for JSON objects
 *
 * Generates arbitrary JSON-serializable objects.
 * fast-check 4.x uses json() for any JSON value.
 */
export const arbJsonObject = fc
  .json()
  .filter((v) => v !== null && typeof v === "object" && !Array.isArray(v));

/**
 * Arbitrary generator for JSON arrays
 *
 * Generates arbitrary JSON arrays.
 */
export const arbJsonArray = fc.json().filter((v) => Array.isArray(v));

/**
 * Arbitrary generator for policy layers
 *
 * Generates arrays of policies representing layered policy evaluation.
 */
export const arbPolicyLayers = fc.array(arbToolPolicy, { minLength: 1, maxLength: 8 });

/**
 * Arbitrary generator for non-empty strings
 *
 * Generates strings that are guaranteed to be non-empty after trimming.
 */
export const arbNonEmptyString = fc
  .string({ minLength: 1 })
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/**
 * Arbitrary generator for integers in realistic ranges
 *
 * Generates integers in commonly used ranges for testing.
 */
export const arbSmallInt = fc.integer({ min: -1000, max: 1000 });
export const arbPositiveInt = fc.integer({ min: 1, max: 1_000_000 });
export const arbDurationMs = fc.integer({ min: 0, max: 3600_000 }); // Up to 1 hour

/**
 * Filter generator for terminal delivery states
 *
 * Generates only terminal delivery states (delivered, failed, discarded).
 */
export const arbTerminalDeliveryState = fc.constantFrom("delivered", "failed", "discarded");

/**
 * Filter generator for active delivery states
 *
 * Generates only active/non-terminal delivery states.
 */
export const arbActiveDeliveryState = fc.constantFrom("pending", "in_progress", "suspended");

/**
 * Generator builder for arrays with unique elements
 *
 * Creates an array generator that ensures all elements are unique.
 *
 * @example
 * ```ts
 * const arbUniqueToolNames = arbUniqueArray(arbToolName, { minLength: 1, maxLength: 10 })
 * ```
 */
export function arbUniqueArray<T>(
  arb: fc.Arbitrary<T>,
  constraints?: fc.ArrayConstraints,
): fc.Arbitrary<T[]> {
  return fc.array(arb, constraints).filter((arr) => {
    const seen = new Set();
    for (const item of arr) {
      // Use string representation for comparison
      const key = String(item);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
    }
    return true;
  });
}

/**
 * Generator builder for sorted arrays
 *
 * Creates an array generator that produces sorted results.
 */
export function arbSortedArray<T>(
  arb: fc.Arbitrary<T>,
  compareFn?: (a: T, b: T) => number,
): fc.Arbitrary<T[]> {
  return fc.array(arb).map((arr) => arr.toSorted(compareFn));
}

/**
 * Generator for timestamps within a window
 *
 * Generates timestamps that are within a specified time window.
 *
 * @param baseTime - Base timestamp (default: current time)
 * @param windowMs - Window size in milliseconds (default: 1 hour)
 */
export function arbTimestampInWindow(baseTime?: number, windowMs?: number): fc.Arbitrary<number> {
  const base = baseTime ?? Date.now();
  const window = windowMs ?? 3600_000; // 1 hour
  return fc.integer({ min: base - window, max: base + window });
}

/**
 * Generator for arrays of items that sum to a target
 *
 * Generates arrays of positive integers that sum to approximately
 * the target value (useful for testing resource allocation).
 */
export function arbArraySummingTo(
  target: number,
  minItems: number,
  maxItems: number,
): fc.Arbitrary<number[]> {
  return fc
    .array(fc.integer({ min: 0, max: Math.max(target, 1) }), {
      minLength: minItems,
      maxLength: maxItems,
    })
    .map((arr) => {
      const sum = arr.reduce((a, b) => a + b, 0);
      if (sum === 0) {
        return arr.map(() => Math.floor(target / arr.length));
      }
      const ratio = target / sum;
      return arr.map((v) => Math.max(1, Math.floor(v * ratio)));
    });
}
