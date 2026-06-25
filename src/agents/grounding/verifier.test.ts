import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../simple-completion-runtime.js";
import { parseGroundingResponse, verifyGrounding } from "./verifier.js";

const cfg = {} as OpenClawConfig;

function preparedOk(): ReturnType<typeof prepareSimpleCompletionModelForAgent> {
  return Promise.resolve({
    selection: { provider: "anthropic", modelId: "x", agentDir: "/tmp" },
    model: {},
    auth: {},
  } as unknown as Awaited<ReturnType<typeof prepareSimpleCompletionModelForAgent>>);
}

function judgeReturning(text: string): typeof completeWithPreparedSimpleCompletionModel {
  return (async () => ({
    content: [{ type: "text", text }],
  })) as unknown as typeof completeWithPreparedSimpleCompletionModel;
}

function deps(judgeText: string) {
  return {
    prepareSimpleCompletionModelForAgent: vi.fn(preparedOk),
    completeWithPreparedSimpleCompletionModel: vi.fn(judgeReturning(judgeText)),
  };
}

describe("verifyGrounding", () => {
  it("returns grounded when the judge confirms support", async () => {
    const verdict = await verifyGrounding({
      cfg,
      source: "Paris is the capital of France.",
      claims: "The capital of France is Paris.",
      deps: deps(JSON.stringify({ grounded: true, unsupportedClaims: [] })),
    });
    expect(verdict).toEqual({ status: "grounded" });
  });

  it("returns ungrounded with the unsupported claims and a reason", async () => {
    const verdict = await verifyGrounding({
      cfg,
      source: "Paris is the capital of France.",
      claims: "Paris has 9 million residents.",
      deps: deps(
        JSON.stringify({
          grounded: false,
          unsupportedClaims: ["Paris has 9 million residents.", "   "],
          reason: "population not in source",
        }),
      ),
    });
    expect(verdict).toEqual({
      status: "ungrounded",
      unsupported: ["Paris has 9 million residents."],
      reason: "population not in source",
    });
  });

  it("skips (no-source) without calling the judge when source is empty", async () => {
    const d = deps("{}");
    const verdict = await verifyGrounding({ cfg, source: "   ", claims: "anything", deps: d });
    expect(verdict).toEqual({ status: "skipped", why: "no-source" });
    expect(d.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    expect(d.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it("skips (disabled) when no config is provided", async () => {
    const verdict = await verifyGrounding({
      source: "s",
      claims: "c",
      deps: deps("{}"),
    });
    expect(verdict).toEqual({ status: "skipped", why: "disabled" });
  });

  it("fails open (judge-error) when the model is unavailable", async () => {
    const verdict = await verifyGrounding({
      cfg,
      source: "s",
      claims: "c",
      deps: {
        prepareSimpleCompletionModelForAgent: vi.fn(
          () =>
            Promise.resolve({ error: "no auth" }) as ReturnType<
              typeof prepareSimpleCompletionModelForAgent
            >,
        ),
        completeWithPreparedSimpleCompletionModel: vi.fn(judgeReturning("{}")),
      },
    });
    expect(verdict).toEqual({ status: "skipped", why: "judge-error" });
  });

  it("fails open (judge-error) when the completion returns an error stop reason", async () => {
    const verdict = await verifyGrounding({
      cfg,
      source: "s",
      claims: "c",
      deps: {
        prepareSimpleCompletionModelForAgent: vi.fn(preparedOk),
        completeWithPreparedSimpleCompletionModel: vi.fn((async () => ({
          content: [],
          stopReason: "error",
          errorMessage: "boom",
        })) as unknown as typeof completeWithPreparedSimpleCompletionModel),
      },
    });
    expect(verdict).toEqual({ status: "skipped", why: "judge-error" });
  });

  it("fails open (judge-error) when the judge returns unparseable text", async () => {
    const verdict = await verifyGrounding({
      cfg,
      source: "s",
      claims: "c",
      deps: deps("not json at all"),
    });
    expect(verdict).toEqual({ status: "skipped", why: "judge-error" });
  });
});

describe("parseGroundingResponse", () => {
  it("parses fenced JSON", () => {
    const verdict = parseGroundingResponse(
      '```json\n{"grounded": true, "unsupportedClaims": []}\n```',
    );
    expect(verdict).toEqual({ status: "grounded" });
  });

  it("synthesizes a reason when ungrounded and none is given", () => {
    const verdict = parseGroundingResponse(
      JSON.stringify({ grounded: false, unsupportedClaims: ["a", "b"] }),
    );
    expect(verdict).toEqual({
      status: "ungrounded",
      unsupported: ["a", "b"],
      reason: "response contains 2 claim(s) not supported by the source",
    });
  });

  it("parses preConfidence and postConfidence when present", () => {
    const verdict = parseGroundingResponse(
      JSON.stringify({
        grounded: true,
        unsupportedClaims: [],
        preConfidence: 0.8,
        postConfidence: 0.9,
      }),
    );
    expect(verdict).toMatchObject({ status: "grounded", preConfidence: 0.8, postConfidence: 0.9 });
  });

  it("parses preConfidence and postConfidence on ungrounded", () => {
    const verdict = parseGroundingResponse(
      JSON.stringify({
        grounded: false,
        unsupportedClaims: ["x"],
        reason: "r",
        preConfidence: 0.7,
        postConfidence: 0.4,
      }),
    );
    expect(verdict).toMatchObject({
      status: "ungrounded",
      unsupported: ["x"],
      preConfidence: 0.7,
      postConfidence: 0.4,
    });
  });

  it("omits confidence fields when not present in judge response", () => {
    const verdict = parseGroundingResponse(
      JSON.stringify({ grounded: true, unsupportedClaims: [] }),
    );
    expect(verdict).toEqual({ status: "grounded" });
    expect("preConfidence" in verdict).toBe(false);
    expect("postConfidence" in verdict).toBe(false);
  });

  it("fails open on shape mismatch", () => {
    expect(parseGroundingResponse('{"grounded": "yes"}')).toEqual({
      status: "skipped",
      why: "judge-error",
    });
  });
});
