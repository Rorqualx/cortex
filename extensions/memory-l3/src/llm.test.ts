import { describe, expect, it, vi } from "vitest";
import {
  createGlmCaller,
  DEFAULT_GLM_BASE_URL,
  DEFAULT_GLM_MODEL,
  extractFacts,
  parseExtractResponse,
  parseJsonResponse,
  type LlmCaller,
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
  it("returns empty result for non-JSON output", () => {
    expect(parseExtractResponse("not json")).toEqual({
      facts: [],
      typedFacts: [],
      decisions: [],
      actions: [],
    });
  });

  it("returns empty result when both arrays are missing", () => {
    expect(parseExtractResponse("{}")).toEqual({
      facts: [],
      typedFacts: [],
      decisions: [],
      actions: [],
    });
  });

  it("normalizes a valid facts array", () => {
    const raw = JSON.stringify({
      facts: [
        { text: "  alpha  ", importance: 0.7, dedupKey: "k:1" },
        { text: "beta", importance: 1.5, dedupKey: "k:2" },
      ],
    });
    const result = parseExtractResponse(raw);
    expect(result.facts).toEqual([
      { text: "alpha", importance: 0.7, dedupKey: "k:1" },
      { text: "beta", importance: 1, dedupKey: "k:2" },
    ]);
    expect(result.typedFacts).toEqual([]);
  });

  it("keeps valid certainty tags and drops unknown values", () => {
    const raw = JSON.stringify({
      facts: [
        { text: "a", importance: 0.7, dedupKey: "k:1", certainty: "tentative" },
        { text: "b", importance: 0.7, dedupKey: "k:2", certainty: "instructional" },
        { text: "c", importance: 0.7, dedupKey: "k:3", certainty: "very-sure" },
        { text: "d", importance: 0.7, dedupKey: "k:4" },
      ],
    });
    const result = parseExtractResponse(raw);
    expect(result.facts.map((fact) => fact.certainty)).toEqual([
      "tentative",
      "instructional",
      undefined,
      undefined,
    ]);
  });

  it("preserves reasoning field when present", () => {
    const raw = JSON.stringify({
      facts: [
        {
          text: "user prefers dark mode",
          importance: 0.8,
          dedupKey: "pref:dark_mode",
          reasoning: "User mentioned this preference unprompted",
        },
      ],
    });
    const result = parseExtractResponse(raw);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.reasoning).toBe("User mentioned this preference unprompted");
  });

  it("drops empty/whitespace reasoning", () => {
    const raw = JSON.stringify({
      facts: [{ text: "alpha", importance: 0.5, dedupKey: "k:1", reasoning: "   " }],
    });
    const result = parseExtractResponse(raw);
    expect(result.facts[0]!.reasoning).toBeUndefined();
  });

  it("drops malformed prose entries (missing text or dedupKey)", () => {
    const raw = JSON.stringify({
      facts: [
        { text: "ok", importance: 0.5, dedupKey: "valid" },
        { text: "", importance: 0.5, dedupKey: "empty-text" },
        { text: "no-key", importance: 0.5 },
        { importance: 0.5, dedupKey: "no-text" },
      ],
    });
    const result = parseExtractResponse(raw);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.dedupKey).toBe("valid");
  });

  it("defaults missing importance to 0.5", () => {
    const raw = JSON.stringify({ facts: [{ text: "ok", dedupKey: "k:1" }] });
    const result = parseExtractResponse(raw);
    expect(result.facts[0]!.importance).toBe(0.5);
  });

  it("normalizes a valid typedFacts array", () => {
    const raw = JSON.stringify({
      facts: [],
      typedFacts: [
        {
          slot: "user:phone",
          value: "555-1234",
          sourceSpan: "my number is 555-1234",
          unit: null,
          confidence: 0.9,
        },
        {
          slot: "infra:port",
          value: "18789",
          sourceSpan: "listening on 18789",
          unit: "tcp",
          confidence: 0.7,
        },
      ],
    });
    const result = parseExtractResponse(raw);
    expect(result.typedFacts).toEqual([
      {
        slot: "user:phone",
        value: "555-1234",
        sourceSpan: "my number is 555-1234",
        unit: null,
        confidence: 0.9,
      },
      {
        slot: "infra:port",
        value: "18789",
        sourceSpan: "listening on 18789",
        unit: "tcp",
        confidence: 0.7,
      },
    ]);
  });

  it("drops malformed typed-fact entries (missing slot/value/sourceSpan)", () => {
    const raw = JSON.stringify({
      typedFacts: [
        { slot: "ok", value: "1", sourceSpan: "v=1", unit: null, confidence: 0.5 },
        { slot: "no-value", sourceSpan: "x", confidence: 0.5 },
        { slot: "", value: "1", sourceSpan: "v=1", confidence: 0.5 },
        { slot: "no-span", value: "1", confidence: 0.5 },
      ],
    });
    const result = parseExtractResponse(raw);
    expect(result.typedFacts).toHaveLength(1);
    expect(result.typedFacts[0]!.slot).toBe("ok");
  });

  it("clamps confidence into [0,1] and treats empty-string unit as null", () => {
    const raw = JSON.stringify({
      typedFacts: [
        { slot: "x", value: "5", sourceSpan: "v=5", unit: "  ", confidence: 1.7 },
        { slot: "y", value: "10", sourceSpan: "v=10", unit: "MB", confidence: -0.1 },
      ],
    });
    const result = parseExtractResponse(raw);
    expect(result.typedFacts[0]!.unit).toBeNull();
    expect(result.typedFacts[0]!.confidence).toBe(1);
    expect(result.typedFacts[1]!.unit).toBe("MB");
    expect(result.typedFacts[1]!.confidence).toBe(0);
  });

  it("normalizes a valid activeConstraints array", () => {
    const raw = JSON.stringify({
      activeConstraints: [
        { text: "Must support Python 3.9+", status: "open", sourceSpan: "needs to work on 3.9+" },
        {
          text: "Verified API returns JSON",
          status: "verified",
          sourceSpan: "the API returns JSON",
        },
        { text: "bad entry without span" },
      ],
    });
    const result = parseExtractResponse(raw);
    expect(result.activeConstraints).toEqual([
      { text: "Must support Python 3.9+", status: "open", sourceSpan: "needs to work on 3.9+" },
      { text: "Verified API returns JSON", status: "verified", sourceSpan: "the API returns JSON" },
    ]);
  });

  it("defaults unknown constraint status to open", () => {
    const raw = JSON.stringify({
      activeConstraints: [{ text: "something", status: "whatever", sourceSpan: "ctx" }],
    });
    const result = parseExtractResponse(raw);
    expect(result.activeConstraints).toEqual([
      { text: "something", status: "open", sourceSpan: "ctx" },
    ]);
  });
});

describe("extractFacts", () => {
  it("calls the caller with the v4 system prompt and returns parsed result", async () => {
    const caller = vi.fn<LlmCaller>(async () =>
      JSON.stringify({
        facts: [
          { text: "user prefers morning standups", importance: 0.8, dedupKey: "user:standups" },
        ],
        typedFacts: [
          {
            slot: "user:phone",
            value: "555-1234",
            sourceSpan: "my number is 555-1234",
            unit: null,
            confidence: 0.9,
          },
        ],
      }),
    );
    const result = await extractFacts({
      messages: [{ role: "user", content: "morning standups please" }] as never[],
      caller,
    });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.text).toBe("user prefers morning standups");
    expect(result.typedFacts).toHaveLength(1);
    expect(result.typedFacts[0]!.slot).toBe("user:phone");
    expect(caller).toHaveBeenCalledOnce();
    const call = caller.mock.calls[0]![0];
    expect(call.systemPrompt).toContain("PROMPT_VERSION=14");
    // QW1 (2026-08-16): extraction prompts must demand verbatim temporal expressions.
    expect(call.systemPrompt).toContain("TEMPORAL");
    // QW2 (2026-08-17): TANGLE conflict-preservation guard.
    expect(call.systemPrompt).toContain("CONFLICT");
    expect(call.systemPrompt).toContain("REASONING");
    expect(call.userPrompt).not.toContain("already-known");
  });

  it("returns empty result when caller returns empty/garbage", async () => {
    const caller = vi.fn(async () => "");
    const result = await extractFacts({
      messages: [{ role: "user", content: "hi" }] as never[],
      caller,
    });
    expect(result).toEqual({ facts: [], typedFacts: [], decisions: [], actions: [] });
  });
});

describe("createGlmCaller", () => {
  it("posts to the default Z.ai endpoint with the model and bearer token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "hello" } }] }),
        }) as Response,
    );
    const caller = createGlmCaller({
      apiKey: "test-key",
      fetchImpl: fetchImpl as never,
    });
    const result = await caller({ systemPrompt: "sys", userPrompt: "usr" });
    expect(result).toBe("hello");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${DEFAULT_GLM_BASE_URL}/chat/completions`);
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe(DEFAULT_GLM_MODEL);
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
  });

  it("throws immediately on a non-retryable status (no retry)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
      headers: { get: () => null },
    }));
    const caller = createGlmCaller({
      apiKey: "bad",
      fetchImpl: fetchImpl as never,
    });
    await expect(caller({ systemPrompt: "s", userPrompt: "u" })).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a transient 429 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        return {
          ok: false,
          status: 429,
          text: async () => "overloaded",
          headers: { get: () => null },
        } as never;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "recovered" } }] }),
      } as never;
    });
    const caller = createGlmCaller({
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      retryBaseMs: 1,
      sleepImpl: async () => {},
    });
    const result = await caller({ systemPrompt: "s", userPrompt: "u" });
    expect(result).toBe("recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries on persistent 429", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "overloaded",
      headers: { get: () => null },
    }));
    const caller = createGlmCaller({
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      maxRetries: 2,
      retryBaseMs: 1,
      sleepImpl: async () => {},
    });
    await expect(caller({ systemPrompt: "s", userPrompt: "u" })).rejects.toThrow(/429/);
    // first try + 2 retries
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throttles successive calls by minIntervalMs", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "x" } }] }),
    }));
    const waits: number[] = [];
    const caller = createGlmCaller({
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      minIntervalMs: 1000,
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });
    await caller({ systemPrompt: "s", userPrompt: "u" });
    await caller({ systemPrompt: "s", userPrompt: "u" });
    // First call fires immediately; the second waits ~minIntervalMs for its slot.
    expect(waits.some((w) => w >= 900)).toBe(true);
  });

  it("honors a numeric Retry-After header for the backoff delay", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => "overloaded",
          headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? "2" : null) },
        } as never;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      } as never;
    });
    const slept: number[] = [];
    const caller = createGlmCaller({
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      sleepImpl: async (ms) => {
        slept.push(ms);
      },
    });
    const result = await caller({ systemPrompt: "s", userPrompt: "u" });
    expect(result).toBe("ok");
    expect(slept).toEqual([2000]);
  });
});
