import { describe, expect, it } from "vitest";

// Mirror of the diagnostic function in run-longmemeval-engine.ts
function checkAnswerInContext(answer: string | number, context: string): boolean {
  const normCtx = context.toLowerCase();
  const raw = String(answer).trim().toLowerCase();
  if (normCtx.includes(raw)) return true;
  const stripped = raw.replace(/[,\s]/g, "");
  if (normCtx.includes(stripped)) return true;
  return false;
}

describe("checkAnswerInContext", () => {
  it("matches exact substring", () => {
    expect(checkAnswerInContext("Paris", "The capital of France is Paris.")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(checkAnswerInContext("paris", "The capital of France is PARIS.")).toBe(true);
  });

  it("matches numbers", () => {
    expect(checkAnswerInContext(42, "The answer is 42.")).toBe(true);
  });

  it("normalises comma separators", () => {
    expect(checkAnswerInContext("1,234", "There are 1234 entries.")).toBe(true);
  });

  it("returns false when absent", () => {
    expect(checkAnswerInContext("London", "The capital of France is Paris.")).toBe(false);
  });

  it("handles empty context", () => {
    expect(checkAnswerInContext("foo", "")).toBe(false);
  });
});
