// Control UI tests cover session goal behavior.
import { describe, expect, it } from "vitest";
import { formatGoalDetail, formatGoalSummary } from "./session-goal.ts";
import type { SessionGoal } from "./types.ts";

function buildGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    schemaVersion: 1,
    id: "goal-1",
    objective: "Ship the web goal indicator",
    status: "active",
    createdAt: 1,
    updatedAt: 2,
    tokenStart: 100,
    tokensUsed: 12_400,
    tokenBudget: 50_000,
    continuationTurns: 0,
    ...overrides,
  };
}

describe("session goal formatting", () => {
  it("summarizes goal status and objective details", () => {
    const goal = buildGoal({ lastStatusNote: "Waiting for CI" });

    expect(formatGoalSummary(goal)).toBe("Pursuing goal (12k/50k)");
    expect(formatGoalDetail(goal)).toBe(
      "Pursuing goal (12k/50k): Ship the web goal indicator - Waiting for CI",
    );
  });

  it("uses terminal labels without a budget", () => {
    expect(formatGoalSummary(buildGoal({ status: "complete", tokenBudget: undefined }))).toBe(
      "Goal achieved (12k used)",
    );
  });
});
