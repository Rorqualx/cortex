// Covers the OpenAI-compatible /models fetcher mapping + failure guards.
import { describe, expect, it, vi } from "vitest";
import { fetchOpenAiCompatibleModels } from "./model-discovery.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
