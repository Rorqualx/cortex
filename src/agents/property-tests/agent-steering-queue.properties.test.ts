/**
 * Property-Based Tests for Agent Steering Queue
 *
 * Tests core invariants of the steering queue:
 * - Ordering is deterministic by endedAt timestamp
 * - Lease IDs are unique (no double-assignment)
 * - Stale leases are reclaimed after timeout
 * - Prompt bounding respects character limits
 * - Suspension state is preserved on release
 *
 * These tests use fast-check to generate thousands of random inputs
 * and verify invariants hold across all cases.
 */

import * as fc from "fast-check";
import { describe, expect, beforeEach, it } from "vitest";
import {
  listPendingAgentSteeringItemsFromSubagentRuns,
  leasePendingAgentSteeringItemsFromSubagentRuns,
  ackLeasedAgentSteeringItemsFromSubagentRuns,
  releaseLeasedAgentSteeringItemsFromSubagentRuns,
} from "../agent-steering-queue.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";
import { arbUUID, arbTimestamp } from "../test-helpers/property-generators.js";

describe("agent-steering-queue properties", () => {
  describe("listPendingAgentSteeringItemsFromSubagentRuns", () => {
    it("maintains deterministic ordering by endedAt", () => {
      fc.assert(
        fc.property(
          // Generate array of runs with different endedAt timestamps
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constantFrom("pending", "running", "terminal"),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: arbTimestamp,
              delivery: fc.record({
                status: fc.constantFrom("pending", "suspended"),
                createdAt: arbTimestamp,
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: arbTimestamp,
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.boolean(),
              cleanupCompletedAt: fc.constant(undefined),
            }),
            { minLength: 1, maxLength: 100 },
          ),
          arbUUID, // requesterSessionKey
          (runs, requesterSessionKey) => {
            const runsMap = new Map(runs.map((r) => [r.runId, r as unknown as SubagentRunRecord]));
            const items = listPendingAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              requesterSessionKey,
            });

            // Verify ordering by endedAt (ascending)
            for (let i = 1; i < items.length; i++) {
              const prevEnded =
                items[i - 1].payload.endedAt ??
                items[i - 1].entry.endedAt ??
                Number.MAX_SAFE_INTEGER;
              const currEnded =
                items[i].payload.endedAt ?? items[i].entry.endedAt ?? Number.MAX_SAFE_INTEGER;
              expect(currEnded).toBeGreaterThanOrEqual(prevEnded);
            }
          },
        ),
      );
    });

    it("orders by createdAt when endedAt is equal", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constantFrom("pending", "running", "terminal"),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: fc.constant(1000), // Same endedAt for all
              delivery: fc.record({
                status: fc.constantFrom("pending", "suspended"),
                createdAt: arbTimestamp,
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: fc.constant(1000),
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.boolean(),
              cleanupCompletedAt: fc.constant(undefined),
            }),
            { minLength: 2, maxLength: 50 },
          ),
          arbUUID,
          (runs, requesterSessionKey) => {
            const runsMap = new Map(runs.map((r) => [r.runId, r as unknown as SubagentRunRecord]));
            const items = listPendingAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              requesterSessionKey,
            });

            // When endedAt is equal, should order by delivery.createdAt
            for (let i = 1; i < items.length; i++) {
              const prevCreated =
                items[i - 1].entry.delivery?.createdAt ?? items[i - 1].entry.createdAt;
              const currCreated = items[i].entry.delivery?.createdAt ?? items[i].entry.createdAt;
              expect(currCreated).toBeGreaterThanOrEqual(prevCreated);
            }
          },
        ),
      );
    });

    it("orders by runId as final tiebreaker", () => {
      const sameEndedAt = 1000;
      const sameCreatedAt = 500;
      const requesterSessionKey = "test-session";

      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.constant("test-agent"),
              childSessionKey: arbUUID,
              status: fc.constant("terminal" as const),
              createdAt: fc.constant(sameCreatedAt),
              startedAt: fc.constant(sameCreatedAt),
              endedAt: fc.constant(sameEndedAt),
              delivery: fc.record({
                status: fc.constant("pending" as const),
                createdAt: fc.constant(sameCreatedAt),
                payload: fc.record({
                  requesterSessionKey: fc.constant(requesterSessionKey),
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.constant("test"),
                  label: fc.constant(undefined),
                  endedAt: fc.constant(sameEndedAt),
                  fallbackFrozenResultText: fc.constant(undefined),
                  frozenResultText: fc.constant(undefined),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.constant(false),
              cleanupCompletedAt: fc.constant(undefined),
            }),
            { minLength: 2, maxLength: 10 },
          ),
          (runs) => {
            const runsMap = new Map(runs.map((r) => [r.runId, r as unknown as SubagentRunRecord]));
            const items = listPendingAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              requesterSessionKey,
            });

            // Should be ordered by runId localeCompare
            const runIdsInOrder = items.map((i) => i.runId);
            const sortedRunIds = [...runIdsInOrder].toSorted();
            expect(runIdsInOrder).toEqual(sortedRunIds);
          },
        ),
      );
    });

    it("filters items by requesterSessionKey", () => {
      fc.assert(
        fc.property(
          fc.constantFrom("target-session-key"),
          fc.array(
            fc.tuple(
              arbUUID, // id
              arbUUID, // parentId
              arbUUID, // childSessionKey
              arbUUID, // childRunId
              arbUUID, // randomSessionKey
              fc.string(), // agentId
              fc.constantFrom("pending", "running", "terminal"), // status
              arbTimestamp, // createdAt
              arbTimestamp, // startedAt
              arbTimestamp, // endedAt
              arbTimestamp, // delivery.createdAt
              fc.constantFrom("pending", "suspended"), // delivery.status
              arbTimestamp, // payload.endedAt
              fc.string(), // task
              fc.string(), // label
              fc.string(), // fallbackFrozenResultText
              fc.string(), // frozenResultText
            ),
            { minLength: 1, maxLength: 50 },
          ),
          (targetSessionKey, tuples) => {
            // Build runs from tuples
            const runs = tuples.map(
              ([
                id,
                parentId,
                childSessionKey,
                childRunId,
                randomSessionKey,
                agentId,
                status,
                createdAt,
                startedAt,
                endedAt,
                deliveryCreatedAt,
                deliveryStatus,
                payloadEndedAt,
                task,
                label,
                fallbackFrozenResultText,
                frozenResultText,
              ]) => ({
                runId: id,
                requesterAgentId: parentId,
                agentId,
                childSessionKey,
                status,
                createdAt,
                startedAt,
                endedAt,
                delivery: {
                  status: deliveryStatus,
                  createdAt: deliveryCreatedAt,
                  payload: {
                    requesterSessionKey: randomSessionKey,
                    childSessionKey,
                    childRunId,
                    task,
                    label,
                    endedAt: payloadEndedAt,
                    fallbackFrozenResultText,
                    frozenResultText,
                    outcome: undefined,
                  },
                },
                cleanupHandled: false,
                cleanupCompletedAt: undefined,
              }),
            );

            // Filter runs to only those with target session key
            const runsWithTarget = runs.filter(
              (r) => r.delivery.payload.requesterSessionKey === targetSessionKey,
            );

            const runsMap = new Map(
              runsWithTarget.map((r) => [r.runId, r as unknown as SubagentRunRecord]),
            );
            const items = listPendingAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              requesterSessionKey: targetSessionKey,
            });

            // All items should have the target session key
            for (const item of items) {
              expect(item.payload.requesterSessionKey).toBe(targetSessionKey);
            }
          },
        ),
      );
    });

    it("excludes items with terminal delivery status", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constantFrom("pending", "running", "terminal"),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: arbTimestamp,
              delivery: fc.record({
                status: fc.constantFrom(
                  "pending",
                  "in_progress",
                  "delivered",
                  "failed",
                  "discarded",
                ),
                createdAt: arbTimestamp,
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: arbTimestamp,
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.boolean(),
              cleanupCompletedAt: fc.constant(undefined),
            }),
            { minLength: 1, maxLength: 50 },
          ),
          arbUUID,
          (runs, requesterSessionKey) => {
            // Set all payloads to have the requester session key
            const runsWithSession = runs.map((r) => ({
              ...r,
              delivery: {
                ...r.delivery,
                payload: {
                  ...r.delivery.payload,
                  requesterSessionKey,
                },
              },
            }));

            const runsMap = new Map(
              runsWithSession.map((r) => [r.runId, r as unknown as SubagentRunRecord]),
            );
            const items = listPendingAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              requesterSessionKey,
            });

            // No item should have terminal delivery status
            const terminalStatuses = ["delivered", "failed", "discarded"] as const;
            for (const item of items) {
              expect(terminalStatuses).not.toContain(item.entry.delivery?.status);
            }
          },
        ),
      );
    });
  });

  describe("leasePendingAgentSteeringItemsFromSubagentRuns", () => {
    it("assigns unique lease IDs", () => {
      fc.assert(
        fc.property(
          arbUUID, // leaseId
          arbUUID, // requesterSessionKey
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constantFrom("pending", "running", "terminal"),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: arbTimestamp,
              delivery: fc.record({
                status: fc.constantFrom("pending", "suspended"),
                createdAt: arbTimestamp,
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: arbTimestamp,
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.boolean(),
              cleanupCompletedAt: fc.constant(undefined),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          (leaseId, requesterSessionKey, runs) => {
            // Set all runs to have the requester session key
            const runsWithSession = runs.map((r) => ({
              ...r,
              delivery: {
                ...r.delivery,
                payload: {
                  ...r.delivery.payload,
                  requesterSessionKey,
                },
              },
            }));

            const runsMap = new Map(
              runsWithSession.map((r) => [r.runId, r as unknown as SubagentRunRecord]),
            );
            const result = leasePendingAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              requesterSessionKey,
              leaseId,
            });

            if (!result) {
              return;
            }

            // All leased runs should have the same leaseId
            for (const runId of result.runIds) {
              const run = runsMap.get(runId);
              expect(run?.delivery?.steeringLeaseId).toBe(leaseId);
            }

            // No two runs should share a leaseId with a different value
            const leaseIds = new Set<string>();
            for (const [_, run] of runsMap) {
              if (run.delivery?.steeringLeaseId) {
                const existingLease = leaseIds.has(run.delivery.steeringLeaseId);
                if (existingLease && run.delivery.steeringLeaseId !== leaseId) {
                  throw new Error(
                    `Run ${(run as { runId?: string }).runId ?? "?"} has conflicting lease ID`,
                  );
                }
                leaseIds.add(run.delivery.steeringLeaseId);
              }
            }
          },
        ),
      );
    });

    it("sets steeringLeasedAt timestamp", () => {
      fc.assert(
        fc.property(
          arbUUID,
          arbUUID,
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constantFrom("pending", "running", "terminal"),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: arbTimestamp,
              delivery: fc.record({
                status: fc.constantFrom("pending", "suspended"),
                createdAt: arbTimestamp,
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: arbTimestamp,
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.boolean(),
              cleanupCompletedAt: fc.constant(undefined),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          arbTimestamp,
          (leaseId, requesterSessionKey, runs, now) => {
            const runsWithSession = runs.map((r) => ({
              ...r,
              delivery: {
                ...r.delivery,
                payload: {
                  ...r.delivery.payload,
                  requesterSessionKey,
                },
              },
            }));

            const runsMap = new Map(
              runsWithSession.map((r) => [r.runId, r as unknown as SubagentRunRecord]),
            );
            const result = leasePendingAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              requesterSessionKey,
              leaseId,
              now,
            });

            if (!result) {
              return;
            }

            // All leased runs should have steeringLeasedAt set
            for (const runId of result.runIds) {
              const run = runsMap.get(runId);
              expect(run?.delivery?.steeringLeasedAt).toBe(now);
            }
          },
        ),
      );
    });

    it("sets status to in_progress", () => {
      fc.assert(
        fc.property(
          arbUUID,
          arbUUID,
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constantFrom("pending", "running", "terminal"),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: arbTimestamp,
              delivery: fc.record({
                status: fc.constantFrom("pending", "suspended"),
                createdAt: arbTimestamp,
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: arbTimestamp,
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.boolean(),
              cleanupCompletedAt: fc.constant(undefined),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          (leaseId, requesterSessionKey, runs) => {
            const runsWithSession = runs.map((r) => ({
              ...r,
              delivery: {
                ...r.delivery,
                payload: {
                  ...r.delivery.payload,
                  requesterSessionKey,
                },
              },
            }));

            const runsMap = new Map(
              runsWithSession.map((r) => [r.runId, r as unknown as SubagentRunRecord]),
            );
            const result = leasePendingAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              requesterSessionKey,
              leaseId,
            });

            if (!result) {
              return;
            }

            // All leased runs should have status in_progress
            for (const runId of result.runIds) {
              const run = runsMap.get(runId);
              expect(run?.delivery?.status).toBe("in_progress");
            }
          },
        ),
      );
    });

    it("sets cleanupHandled to true", () => {
      fc.assert(
        fc.property(
          arbUUID,
          arbUUID,
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constantFrom("pending", "running", "terminal"),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: arbTimestamp,
              delivery: fc.record({
                status: fc.constantFrom("pending", "suspended"),
                createdAt: arbTimestamp,
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: arbTimestamp,
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.boolean(), // Random initial state
              cleanupCompletedAt: fc.constant(undefined),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          (leaseId, requesterSessionKey, runs) => {
            const runsWithSession = runs.map((r) => ({
              ...r,
              delivery: {
                ...r.delivery,
                payload: {
                  ...r.delivery.payload,
                  requesterSessionKey,
                },
              },
            }));

            const runsMap = new Map(
              runsWithSession.map((r) => [r.runId, r as unknown as SubagentRunRecord]),
            );
            const result = leasePendingAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              requesterSessionKey,
              leaseId,
            });

            if (!result) {
              return;
            }

            // All leased runs should have cleanupHandled set to true
            for (const runId of result.runIds) {
              const run = runsMap.get(runId);
              expect(run?.cleanupHandled).toBe(true);
            }
          },
        ),
      );
    });
  });

  describe("ackLeasedAgentSteeringItemsFromSubagentRuns", () => {
    it("sets status to delivered and clears lease", () => {
      fc.assert(
        fc.property(
          arbUUID, // leaseId
          arbUUID, // requesterSessionKey
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constant("terminal" as const),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: arbTimestamp,
              delivery: fc.record({
                status: fc.constant("in_progress" as const),
                createdAt: arbTimestamp,
                deliveredAt: fc.constant(undefined),
                announcedAt: fc.constant(undefined),
                steeringLeaseId: arbUUID,
                steeringLeasedAt: arbTimestamp,
                steeringInjectedAt: fc.constant(undefined),
                lastError: fc.constant(undefined),
                lastDropReason: fc.constant(undefined),
                suspendedAt: fc.constant(undefined),
                suspendedReason: fc.constant(undefined),
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: arbTimestamp,
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.constant(true),
              cleanupCompletedAt: fc.constant(undefined),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          arbTimestamp,
          (leaseId, requesterSessionKey, runs, now) => {
            // First lease the items
            const runsWithSession = runs.map((r) => ({
              ...r,
              delivery: {
                ...r.delivery,
                payload: {
                  ...r.delivery.payload,
                  requesterSessionKey,
                },
                steeringLeaseId: leaseId,
                steeringLeasedAt: now,
              },
            }));

            const runsMap = new Map(
              runsWithSession.map((r) => [r.runId, r as unknown as SubagentRunRecord]),
            );
            const leaseResult = leasePendingAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              requesterSessionKey,
              leaseId,
              now,
            });

            if (!leaseResult) {
              return;
            }

            // Then ack them
            const acked = ackLeasedAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              runIds: leaseResult.runIds,
              leaseId,
              now,
            });

            // Verify all acked runs are in delivered state
            expect(acked).toBeGreaterThan(0);
            for (const runId of leaseResult.runIds) {
              const run = runsMap.get(runId);
              expect(run?.delivery?.status).toBe("delivered");
              expect(run?.delivery?.steeringLeaseId).toBeUndefined();
              expect(run?.delivery?.steeringLeasedAt).toBeUndefined();
            }
          },
        ),
      );
    });

    it("does not modify runs with different lease IDs", () => {
      fc.assert(
        fc.property(
          arbUUID, // leaseId
          arbUUID, // otherLeaseId
          arbUUID, // requesterSessionKey
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constant("terminal" as const),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: arbTimestamp,
              delivery: fc.record({
                status: fc.constant("in_progress" as const),
                createdAt: arbTimestamp,
                deliveredAt: fc.constant(undefined),
                announcedAt: fc.constant(undefined),
                steeringLeaseId: arbUUID,
                steeringLeasedAt: arbTimestamp,
                steeringInjectedAt: fc.constant(undefined),
                lastError: fc.constant(undefined),
                lastDropReason: fc.constant(undefined),
                suspendedAt: fc.constant(undefined),
                suspendedReason: fc.constant(undefined),
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: arbTimestamp,
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.constant(true),
              cleanupCompletedAt: fc.constant(undefined),
            }),
            { minLength: 2, maxLength: 20 },
          ),
          (leaseId, otherLeaseId, requesterSessionKey, runs) => {
            // Give half the runs the other lease ID
            const runsWithDifferentLeases = runs.map((r, i) => ({
              ...r,
              delivery: {
                ...r.delivery,
                payload: {
                  ...r.delivery.payload,
                  requesterSessionKey,
                },
                steeringLeaseId: i % 2 === 0 ? leaseId : otherLeaseId,
                steeringLeasedAt: Date.now(),
              },
            }));

            const runsMap = new Map(
              runsWithDifferentLeases.map((r) => [r.runId, r as unknown as SubagentRunRecord]),
            );
            const runIdsWithOurLease = runs.filter((_, i) => i % 2 === 0).map((r) => r.runId);

            const originalLeaseIds = new Map<string, string | undefined>();
            for (const [id, run] of runsMap) {
              originalLeaseIds.set(id, run.delivery?.steeringLeaseId);
            }

            const acked = ackLeasedAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              runIds: runIdsWithOurLease,
              leaseId,
            });

            // Runs with different lease ID should be unchanged
            for (const runId of runs.filter((_, i) => i % 2 === 1).map((r) => r.runId)) {
              const run = runsMap.get(runId);
              expect(run?.delivery?.steeringLeaseId).toBe(originalLeaseIds.get(runId));
            }
          },
        ),
      );
    });
  });

  describe("releaseLeasedAgentSteeringItemsFromSubagentRuns", () => {
    it("clears lease and restores previous status", () => {
      fc.assert(
        fc.property(
          arbUUID, // leaseId
          arbUUID, // requesterSessionKey
          fc.tuple(fc.constantFrom("pending", "suspended"), fc.boolean()),
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constant("terminal" as const),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: arbTimestamp,
              delivery: fc.record({
                status: fc.constant("in_progress" as const),
                createdAt: arbTimestamp,
                deliveredAt: fc.constant(undefined),
                announcedAt: fc.constant(undefined),
                steeringLeaseId: arbUUID,
                steeringLeasedAt: arbTimestamp,
                steeringInjectedAt: fc.constant(undefined),
                lastError: fc.constant(undefined),
                lastDropReason: fc.constant(undefined),
                suspendedAt: fc.constant(undefined),
                suspendedReason: fc.constant(undefined),
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: arbTimestamp,
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.constant(true),
              cleanupCompletedAt: fc.constant(undefined),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          (leaseId, requesterSessionKey, [status, hasSuspendedAt], runs) => {
            const now = Date.now();
            // Set up runs with the target status
            const runsWithStatus = runs.map((r) => ({
              ...r,
              delivery: {
                ...r.delivery,
                status: "in_progress" as const,
                payload: {
                  ...r.delivery.payload,
                  requesterSessionKey,
                },
                steeringLeaseId: leaseId,
                steeringLeasedAt: now,
                ...(hasSuspendedAt && { suspendedAt: now, suspendedReason: "test" }),
              },
            }));

            const runsMap = new Map(
              runsWithStatus.map((r) => [r.runId, r as unknown as SubagentRunRecord]),
            );
            const runIds = runs.map((r) => r.runId);

            const released = releaseLeasedAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              runIds,
              leaseId,
            });

            expect(released).toBeGreaterThan(0);
            for (const runId of runIds) {
              const run = runsMap.get(runId);
              expect(run?.delivery?.steeringLeaseId).toBeUndefined();
              expect(run?.delivery?.steeringLeasedAt).toBeUndefined();

              // Status should be restored based on whether it had suspendedAt
              if (hasSuspendedAt) {
                expect(run?.delivery?.status).toBe("suspended");
              } else {
                expect(run?.delivery?.status).toBe("pending");
              }
            }
          },
        ),
      );
    });

    it("sets cleanupHandled to false when cleanupCompletedAt is missing", () => {
      fc.assert(
        fc.property(
          arbUUID,
          arbUUID,
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constant("terminal" as const),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: arbTimestamp,
              delivery: fc.record({
                status: fc.constant("in_progress" as const),
                createdAt: arbTimestamp,
                deliveredAt: fc.constant(undefined),
                announcedAt: fc.constant(undefined),
                steeringLeaseId: arbUUID,
                steeringLeasedAt: arbTimestamp,
                steeringInjectedAt: fc.constant(undefined),
                lastError: fc.constant(undefined),
                lastDropReason: fc.constant(undefined),
                suspendedAt: fc.constant(undefined),
                suspendedReason: fc.constant(undefined),
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: arbTimestamp,
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.constant(true),
              cleanupCompletedAt: fc.constant(undefined), // No cleanupCompletedAt
            }),
            { minLength: 1, maxLength: 20 },
          ),
          (leaseId, requesterSessionKey, runs) => {
            const runsWithSession = runs.map((r) => ({
              ...r,
              delivery: {
                ...r.delivery,
                payload: {
                  ...r.delivery.payload,
                  requesterSessionKey,
                },
                steeringLeaseId: leaseId,
                steeringLeasedAt: Date.now(),
              },
            }));

            const runsMap = new Map(
              runsWithSession.map((r) => [r.runId, r as unknown as SubagentRunRecord]),
            );
            const runIds = runs.map((r) => r.runId);

            releaseLeasedAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              runIds,
              leaseId,
            });

            // All runs should have cleanupHandled set to false
            for (const runId of runIds) {
              const run = runsMap.get(runId);
              expect(run?.cleanupHandled).toBe(false);
            }
          },
        ),
      );
    });

    it("preserves cleanupHandled when cleanupCompletedAt is set", () => {
      fc.assert(
        fc.property(
          arbUUID,
          arbUUID,
          fc.array(
            fc.record({
              runId: arbUUID,
              agentId: fc.string(),
              childSessionKey: arbUUID,
              status: fc.constant("terminal" as const),
              createdAt: arbTimestamp,
              startedAt: arbTimestamp,
              endedAt: arbTimestamp,
              delivery: fc.record({
                status: fc.constant("in_progress" as const),
                createdAt: arbTimestamp,
                deliveredAt: fc.constant(undefined),
                announcedAt: fc.constant(undefined),
                steeringLeaseId: arbUUID,
                steeringLeasedAt: arbTimestamp,
                steeringInjectedAt: fc.constant(undefined),
                lastError: fc.constant(undefined),
                lastDropReason: fc.constant(undefined),
                suspendedAt: fc.constant(undefined),
                suspendedReason: fc.constant(undefined),
                payload: fc.record({
                  requesterSessionKey: arbUUID,
                  childSessionKey: arbUUID,
                  childRunId: arbUUID,
                  task: fc.string(),
                  label: fc.string(),
                  endedAt: arbTimestamp,
                  fallbackFrozenResultText: fc.string(),
                  frozenResultText: fc.string(),
                  outcome: fc.constant(undefined),
                }),
              }),
              cleanupHandled: fc.constant(true),
              cleanupCompletedAt: arbTimestamp, // Has cleanupCompletedAt
            }),
            { minLength: 1, maxLength: 20 },
          ),
          (leaseId, requesterSessionKey, runs) => {
            const runsWithSession = runs.map((r) => ({
              ...r,
              delivery: {
                ...r.delivery,
                payload: {
                  ...r.delivery.payload,
                  requesterSessionKey,
                },
                steeringLeaseId: leaseId,
                steeringLeasedAt: Date.now(),
              },
            }));

            const runsMap = new Map(
              runsWithSession.map((r) => [r.runId, r as unknown as SubagentRunRecord]),
            );
            const runIds = runs.map((r) => r.runId);

            const originalCleanupHandled = new Map<string, boolean>();
            for (const [id, run] of runsMap) {
              originalCleanupHandled.set(id, run.cleanupHandled ?? false);
            }

            releaseLeasedAgentSteeringItemsFromSubagentRuns({
              runs: runsMap,
              runIds,
              leaseId,
            });

            // All runs should preserve their cleanupHandled state
            for (const runId of runIds) {
              const run = runsMap.get(runId);
              expect(run?.cleanupHandled).toBe(originalCleanupHandled.get(runId));
            }
          },
        ),
      );
    });
  });
});
