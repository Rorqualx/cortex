// Covers the served-model probe: captures response.model, dedups, best-effort.
import { describe, expect, it, vi } from "vitest";
import {
  countReasoningTokens,
  probeNoThinkCompliance,
  probeServedModel,
  probeServedModels,
} from "./served-model-probe.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("probeServedModel", () => {
  it("returns the served model id from the response", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({ model: "glm-5.2", choices: [] }),
    );
    const served = await probeServedModel({
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      apiKey: "k",
      modelId: "glm-5.1",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(served).toBe("glm-5.2");
    // posts to /chat/completions with the requested model
    const call = fetchFn.mock.calls[0];
    if (!call) throw new Error("expected fetch call");
    const [url, init] = call;
    expect(url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(JSON.parse((init as RequestInit).body as string).model).toBe("glm-5.1");
  });

  it("returns null on non-200 (best-effort)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "nope" }, false, 404));
    expect(
      await probeServedModel({
        baseUrl: "https://x",
        apiKey: "k",
        modelId: "m",
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it("returns null on a thrown fetch", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network");
    });
    expect(
      await probeServedModel({
        baseUrl: "https://x",
        apiKey: "k",
        modelId: "m",
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it("uses the Anthropic /v1/messages shape when protocol=anthropic", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ model: "kimi-for-coding" }));
    const served = await probeServedModel({
      baseUrl: "https://api.kimi.com/coding",
      apiKey: "k",
      modelId: "kimi-for-coding",
      protocol: "anthropic",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(served).toBe("kimi-for-coding");
    const call = fetchFn.mock.calls[0];
    if (!call) throw new Error("expected fetch call");
    const [url, init] = call;
    expect(url).toBe("https://api.kimi.com/coding/v1/messages");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "kimi-for-coding", max_tokens: 1 });
  });
});

describe("probeServedModels", () => {
  it("probes each unique id and returns observations", async () => {
    const served: Record<string, string> = { "glm-5.1": "glm-5.2", "glm-4.6": "glm-4.6" };
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string).model as string;
      return jsonResponse({ model: served[req] ?? req });
    });
    const obs = await probeServedModels({
      baseUrl: "https://x",
      apiKey: "k",
      modelIds: ["glm-5.1", "glm-4.6", "glm-5.1"], // duplicate skipped
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(obs).toEqual([
      { requested: "glm-5.1", served: "glm-5.2" },
      { requested: "glm-4.6", served: "glm-4.6" },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("skips ids whose probe fails", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string).model as string;
      return req === "good" ? jsonResponse({ model: "good-v2" }) : jsonResponse({}, false, 500);
    });
    const obs = await probeServedModels({
      baseUrl: "https://x",
      apiKey: "k",
      modelIds: ["bad", "good"],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(obs).toEqual([{ requested: "good", served: "good-v2" }]);
  });
});

describe("countReasoningTokens (empty-thinking audit, QW1 2026-10-14)", () => {
  it("reads OpenAI-style usage.reasoning_tokens first", () => {
    expect(countReasoningTokens({ usage: { reasoning_tokens: 7 } })).toBe(7);
  });

  it("reads nested completion_tokens_details.reasoning_tokens", () => {
    expect(
      countReasoningTokens({
        usage: { completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 3 } },
      }),
    ).toBe(3);
  });

  it("counts Anthropic-style thinking content blocks", () => {
    expect(
      countReasoningTokens({
        content: [
          { type: "text", text: "hi" },
          { type: "thinking", thinking: "..." },
        ],
      }),
    ).toBe(1);
    expect(countReasoningTokens({ content: [{ type: "text", text: "hi" }] })).toBe(0);
  });

  it("returns null when the payload carries no signal", () => {
    expect(countReasoningTokens({ model: "glm-5.2" })).toBeNull();
    expect(countReasoningTokens("not a record")).toBeNull();
    expect(countReasoningTokens({ usage: {} })).toBeNull();
  });
});

describe("probeNoThinkCompliance", () => {
  it("returns true when thinking was disabled and zero reasoning tokens came back", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        model: "glm-lite",
        usage: { completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 } },
      }),
    );
    expect(
      await probeNoThinkCompliance({
        baseUrl: "https://x",
        apiKey: "k",
        modelId: "glm-lite",
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).toBe(true);
    // request shape: small budget with thinking explicitly disabled (openai-style)
    const call = fetchFn.mock.calls[0];
    if (!call) throw new Error("expected fetch call");
    const [url, init] = call;
    expect(url).toBe("https://x/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "glm-lite", reasoning_effort: "none" });
    expect(body.max_tokens).toBeGreaterThan(1);
  });

  it("returns false when reasoning tokens still came back", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ usage: { reasoning_tokens: 24 } }));
    expect(
      await probeNoThinkCompliance({
        baseUrl: "https://x",
        apiKey: "k",
        modelId: "m",
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).toBe(false);
  });

  it("sends the Anthropic thinking:disabled shape when protocol=anthropic", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({ model: "kimi-for-coding", content: [{ type: "text", text: "hi" }] }),
    );
    expect(
      await probeNoThinkCompliance({
        baseUrl: "https://api.kimi.com/coding",
        apiKey: "k",
        modelId: "kimi-for-coding",
        protocol: "anthropic",
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).toBe(true);
    const call = fetchFn.mock.calls[0];
    if (!call) throw new Error("expected fetch call");
    const [url, init] = call;
    expect(url).toBe("https://api.kimi.com/coding/v1/messages");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "kimi-for-coding", thinking: { type: "disabled" } });
  });

  it("returns null (unknown) on non-200 — providers rejecting the disable param are not marked non-compliant", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "unknown field" }, false, 400));
    expect(
      await probeNoThinkCompliance({
        baseUrl: "https://x",
        apiKey: "k",
        modelId: "m",
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).toBeNull();
  });
});
