import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isGroundingFaithfulnessEnabled } from "./config.js";
import { renderMessagesAsGroundingSource, runGroundingFinalizeGate } from "./finalize-gate.js";
import type { GroundingVerdict } from "./verifier.js";

const cfg = {} as OpenClawConfig;
const longAnswer = "x".repeat(250);

function verifyReturning(verdict: GroundingVerdict) {
  return vi.fn(async () => verdict);
}

const messages = [
  { role: "user", content: "The launch is on 2026-07-01 in Berlin." },
  { role: "assistant", content: "Sure, let me help." },
  {
    role: "user",
    content: [{ type: "tool_result", content: [{ type: "text", text: "Attendees: 1200." }] }],
  },
];

describe("renderMessagesAsGroundingSource", () => {
  it("includes user + tool-result text and excludes assistant turns", () => {
    const source = renderMessagesAsGroundingSource(messages);
    expect(source).toContain("The launch is on 2026-07-01 in Berlin.");
    expect(source).toContain("Attendees: 1200.");
    expect(source).not.toContain("Sure, let me help.");
  });
});

describe("runGroundingFinalizeGate", () => {
  it("continues without calling the verifier for short answers", async () => {
    const verify = verifyReturning({ status: "ungrounded", unsupported: ["x"], reason: "r" });
    const decision = await runGroundingFinalizeGate({
      cfg,
      agentId: "main",
      finalAnswer: "ok",
      messages,
      deps: { verifyGrounding: verify, recordGroundingCheck: vi.fn() },
    });
    expect(decision).toEqual({ action: "continue" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("continues when there is no source material", async () => {
    const verify = verifyReturning({ status: "ungrounded", unsupported: ["x"], reason: "r" });
    const decision = await runGroundingFinalizeGate({
      cfg,
      agentId: "main",
      finalAnswer: longAnswer,
      messages: [{ role: "assistant", content: "only assistant text" }],
      deps: { verifyGrounding: verify, recordGroundingCheck: vi.fn() },
    });
    expect(decision).toEqual({ action: "continue" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("revises with a claim list when the verifier reports ungrounded", async () => {
    const verify = verifyReturning({
      status: "ungrounded",
      unsupported: ["Attendees were 5000.", "It was in Munich."],
      reason: "contradicts source",
    });
    const decision = await runGroundingFinalizeGate({
      cfg,
      agentId: "main",
      finalAnswer: longAnswer,
      messages,
      deps: { verifyGrounding: verify, recordGroundingCheck: vi.fn() },
    });
    expect(decision.action).toBe("revise");
    if (decision.action === "revise") {
      expect(decision.reason).toContain("Attendees were 5000.");
      expect(decision.reason).toContain("It was in Munich.");
    }
  });

  it("continues when grounded", async () => {
    const decision = await runGroundingFinalizeGate({
      cfg,
      agentId: "main",
      finalAnswer: longAnswer,
      messages,
      deps: {
        verifyGrounding: verifyReturning({ status: "grounded" }),
        recordGroundingCheck: vi.fn(),
      },
    });
    expect(decision).toEqual({ action: "continue" });
  });

  it("continues when the verifier fails open (skipped)", async () => {
    const decision = await runGroundingFinalizeGate({
      cfg,
      agentId: "main",
      finalAnswer: longAnswer,
      messages,
      deps: {
        verifyGrounding: verifyReturning({ status: "skipped", why: "judge-error" }),
        recordGroundingCheck: vi.fn(),
      },
    });
    expect(decision).toEqual({ action: "continue" });
  });

  it("records the check outcome and revision when the judge runs", async () => {
    const record = vi.fn();
    await runGroundingFinalizeGate({
      cfg,
      agentId: "varys",
      finalAnswer: longAnswer,
      messages,
      deps: {
        verifyGrounding: verifyReturning({
          status: "ungrounded",
          unsupported: ["x"],
          reason: "r",
          preConfidence: 0.7,
          postConfidence: 0.3,
        }),
        recordGroundingCheck: record,
      },
    });
    expect(record).toHaveBeenCalledWith({
      agentId: "varys",
      outcome: "ungrounded",
      revised: true,
      preConfidence: 0.7,
      postConfidence: 0.3,
    });
  });

  it("records confidence as undefined when verdict lacks it", async () => {
    const record = vi.fn();
    await runGroundingFinalizeGate({
      cfg,
      agentId: "main",
      finalAnswer: longAnswer,
      messages,
      deps: {
        verifyGrounding: verifyReturning({ status: "grounded" }),
        recordGroundingCheck: record,
      },
    });
    expect(record).toHaveBeenCalledWith({
      agentId: "main",
      outcome: "grounded",
      revised: false,
      preConfidence: undefined,
      postConfidence: undefined,
    });
  });

  it("does not record when the judge never runs (short answer)", async () => {
    const record = vi.fn();
    await runGroundingFinalizeGate({
      cfg,
      agentId: "main",
      finalAnswer: "ok",
      messages,
      deps: {
        verifyGrounding: verifyReturning({ status: "grounded" }),
        recordGroundingCheck: record,
      },
    });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("isGroundingFaithfulnessEnabled", () => {
  it("defaults to false", () => {
    expect(isGroundingFaithfulnessEnabled({ config: cfg, agentId: "main" })).toBe(false);
  });

  it("reads the agents.defaults experimental flag", () => {
    const enabled = {
      agents: { defaults: { experimental: { groundingFaithfulness: true } } },
    } as unknown as OpenClawConfig;
    expect(isGroundingFaithfulnessEnabled({ config: enabled, agentId: "main" })).toBe(true);
  });
});
