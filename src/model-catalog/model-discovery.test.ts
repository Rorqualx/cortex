// Covers the OpenAI-compatible /models fetcher mapping + failure guards.
import { describe, expect, it, vi } from "vitest";
import { fetchAnthropicMessagesModels, fetchOpenAiCompatibleModels } from "./model-discovery.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchAnthropicMessagesModels", () => {
  it("fetches /v1/models with anthropic headers and captures display_name as the version", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        object: "list",
        data: [
          {
            id: "kimi-for-coding",
            display_name: "K2.7 Code",
            object: "model",
            created: 1761264000,
          },
        ],
      }),
    );
    const result = await fetchAnthropicMessagesModels({
      baseUrl: "https://api.kimi.com/coding",
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.models[0]).toMatchObject({ modelId: "kimi-for-coding", name: "K2.7 Code" });
    const call = fetchFn.mock.calls[0];
    if (!call) throw new Error("expected fetch call");
    const [url, init] = call;
    expect(url).toBe("https://api.kimi.com/coding/v1/models");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["anthropic-version"]).toBeTruthy();
  });

  it("returns ok:false on a non-200", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "nope" }, 401));
    const result = await fetchAnthropicMessagesModels({
      baseUrl: "https://x",
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
  });
});

describe("fetchOpenAiCompatibleModels", () => {
  it("maps a z.ai-style list response to discovered inputs", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        object: "list",
        data: [
          { id: "glm-5.1", object: "model", created: 1774620000, owned_by: "z-ai" },
          { id: "glm-4.7", object: "model", created: 1766332800, owned_by: "z-ai" },
        ],
      }),
    );
    const result = await fetchOpenAiCompatibleModels({
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.models.map((m) => m.modelId)).toEqual(["glm-5.1", "glm-4.7"]);
    // created seconds normalized to ms.
    expect(result.models[0]?.createdRemoteMs).toBe(1774620000000);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.z.ai/api/paas/v4/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns ok:false on non-200 without throwing", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "nope" }, 401));
    const result = await fetchOpenAiCompatibleModels({
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, error: "HTTP 401", status: 401 });
  });

  it("treats an empty list as a non-result (never deprecate on empties)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ object: "list", data: [] }));
    const result = await fetchOpenAiCompatibleModels({
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false on transport error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await fetchOpenAiCompatibleModels({
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  it("guards missing baseUrl/apiKey", async () => {
    expect(await fetchOpenAiCompatibleModels({ baseUrl: "", apiKey: "k" })).toEqual({
      ok: false,
      error: "missing baseUrl",
    });
    expect(await fetchOpenAiCompatibleModels({ baseUrl: "https://x", apiKey: " " })).toEqual({
      ok: false,
      error: "missing apiKey",
    });
  });
});
