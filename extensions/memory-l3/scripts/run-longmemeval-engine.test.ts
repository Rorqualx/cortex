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

// Mirror of resolveRunPinning in run-longmemeval-engine.ts (QW-1, 2026-09-26).
// The script runs main() on import, so its helpers are mirrored here.
const DEFAULT_GLM_MODEL = "glm-5.2";
const READER_MAX_RETRIES = 10;
const READER_MAX_BACKOFF_MS = 60_000;

type RunPinning = {
  embedModel: string;
  readerApi: "glm" | "anthropic-messages";
  readerModel: string;
  judgeModel: string;
  readerMaxRetries: number;
  readerMaxBackoffMs: number;
  readerMinIntervalMs: number;
};

function resolveRunPinning(env: Record<string, string | undefined>): RunPinning {
  const readerApi = env.EVAL_LLM_API === "anthropic-messages" ? "anthropic-messages" : "glm";
  return {
    embedModel: env.EMBED_MODEL ?? "nomic-embed-text",
    readerApi,
    readerModel:
      readerApi === "anthropic-messages"
        ? (env.EVAL_LLM_MODEL ?? "")
        : (env.EVAL_LLM_MODEL ?? DEFAULT_GLM_MODEL),
    judgeModel: env.JUDGE_MODEL ?? DEFAULT_GLM_MODEL,
    readerMaxRetries: READER_MAX_RETRIES,
    readerMaxBackoffMs: READER_MAX_BACKOFF_MS,
    readerMinIntervalMs: Number(env.ZENBRAIN_MIN_INTERVAL_MS ?? 1000),
  };
}

describe("resolveRunPinning", () => {
  it("defaults to the GLM reader + GLM judge with the 10x/60s retry budget", () => {
    const p = resolveRunPinning({});
    expect(p).toEqual({
      embedModel: "nomic-embed-text",
      readerApi: "glm",
      readerModel: "glm-5.2",
      judgeModel: "glm-5.2",
      readerMaxRetries: 10,
      readerMaxBackoffMs: 60_000,
      readerMinIntervalMs: 1000,
    });
  });

  it("honors EVAL_LLM_MODEL / JUDGE_MODEL / EMBED_MODEL overrides", () => {
    const p = resolveRunPinning({
      EVAL_LLM_MODEL: "kimi-k2.6",
      JUDGE_MODEL: "gpt-4o",
      EMBED_MODEL: "bge-m3",
    });
    expect(p.readerModel).toBe("kimi-k2.6");
    expect(p.judgeModel).toBe("gpt-4o");
    expect(p.embedModel).toBe("bge-m3");
  });

  it("anthropic-messages reader requires an explicit model (empty = unset)", () => {
    const p = resolveRunPinning({ EVAL_LLM_API: "anthropic-messages" });
    expect(p.readerApi).toBe("anthropic-messages");
    expect(p.readerModel).toBe("");
  });

  it("honors ZENBRAIN_MIN_INTERVAL_MS pacing override", () => {
    const p = resolveRunPinning({ ZENBRAIN_MIN_INTERVAL_MS: "0" });
    expect(p.readerMinIntervalMs).toBe(0);
  });
});
