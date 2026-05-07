import { describe, expect, it, vi } from "vitest";
import {
  createGlmCaller,
  DEFAULT_GLM_BASE_URL,
  DEFAULT_GLM_MODEL,
  extractFacts,
  parseExtractResponse,
  parseJsonResponse,
} from "./llm.js";

describe("parseJsonResponse", () => {
  it("parses raw JSON when no fences are present", () => {
    expect(parseJsonResponse('{"facts": []}')).toEqual({ facts: [] });
  });

  it("strips ```json ... ``` markdown fences", () => {
    const fenced = '```json\n{"facts": [{"text": "hi", "importance": 0.5, "dedupKey": "k1"}]}\n```';
    expect(parseJsonResponse(fenced)).toEqual({
      facts: [{ text: "hi", importance: 0.5, dedupKey: "k1" }],
    });
  });

  it("strips bare ``` ... ``` fences", () => {
    expect(parseJsonResponse('```\n{"facts":[]}\n```')).toEqual({ facts: [] });
  });
});

describe("parseExtractResponse", () => {
  it("returns [] for non-JSON output", () => {
    expect(parseExtractResponse("not json")).toEqual([]);
  });

  it("returns [] when facts field is missing", () => {
    expect(parseExtractResponse("{}")).toEqual([]);
  });

  it("normalizes a valid facts array", () => {
    const raw = JSON.stringify({
      facts: [
        { text: "  alpha  ", importance: 0.7, dedupKey: "k:1" },
        { text: "beta", importance: 1.5, dedupKey: "k:2" },
      ],
    });
    const facts = parseExtractResponse(raw);
    expect(facts).toEqual([
      { text: "alpha", importance: 0.7, dedupKey: "k:1" },
      { text: "beta", importance: 1, dedupKey: "k:2" },
    ]);
  });

  it("drops malformed entries (missing text or dedupKey)", () => {
    const raw = JSON.stringify({
      facts: [
        { text: "ok", importance: 0.5, dedupKey: "valid" },
        { text: "", importance: 0.5, dedupKey: "empty-text" },
        { text: "no-key", importance: 0.5 },
        { importance: 0.5, dedupKey: "no-text" },
      ],
    });
    const facts = parseExtractResponse(raw);
    expect(facts).toHaveLength(1);
    expect(facts[0].dedupKey).toBe("valid");
  });

  it("defaults missing importance to 0.5", () => {
    const raw = JSON.stringify({
      facts: [{ text: "ok", dedupKey: "k:1" }],
    });
    const facts = parseExtractResponse(raw);
    expect(facts[0].importance).toBe(0.5);
  });
});

describe("extractFacts", () => {
  it("calls the caller with the extract system prompt and returns parsed facts", async () => {
    const caller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          { text: "user prefers morning standups", importance: 0.8, dedupKey: "user:standups" },
        ],
      }),
    );
    const facts = await extractFacts({
      messages: [{ role: "user", content: "morning standups please" }] as never[],
      alreadyKnownKeys: ["user:other"],
      caller,
    });
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe("user prefers morning standups");
    expect(caller).toHaveBeenCalledOnce();
    const call = caller.mock.calls[0][0];
    expect(call.systemPrompt).toContain("PROMPT_VERSION=2");
    expect(call.userPrompt).toContain("user:other");
  });

  it("returns [] when caller returns empty/garbage", async () => {
    const caller = vi.fn(async () => "");
    const facts = await extractFacts({
      messages: [{ role: "user", content: "hi" }] as never[],
      alreadyKnownKeys: [],
      caller,
    });
    expect(facts).toEqual([]);
  });
});

describe("createGlmCaller", () => {
  it("posts to the default Z.ai endpoint with the model and bearer token", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }] }),
    }));
    const caller = createGlmCaller({
      apiKey: "test-key",
      fetchImpl: fetchImpl as never,
    });
    const result = await caller({ systemPrompt: "sys", userPrompt: "usr" });
    expect(result).toBe("hello");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${DEFAULT_GLM_BASE_URL}/chat/completions`);
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe(DEFAULT_GLM_MODEL);
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
  });

  it("throws when the response is not ok", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    }));
    const caller = createGlmCaller({
      apiKey: "bad",
      fetchImpl: fetchImpl as never,
    });
    await expect(caller({ systemPrompt: "s", userPrompt: "u" })).rejects.toThrow(/401/);
  });
});
