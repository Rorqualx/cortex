// DeepSeek provider body-shaping tests (QW4, 2026-11-17): `reasoning_effort`
// passthrough. Global fetch is stubbed so no network leaves the machine;
// assertions inspect the exact JSON body the provider would emit.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDeepSeekProvider } from "./deepseek.js";

const CHAT_OK = {
  id: "chatcmpl-1",
  model: "deepseek-v4-pro",
  choices: [
    {
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function stubFetchOk() {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(CHAT_OK), { status: 200, statusText: "OK" }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
  const init = calls[calls.length - 1]![1]!;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function makeClient() {
  return makeDeepSeekProvider({ apiKey: "test-key", baseUrl: "https://api.deepseek.com/v1" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deepseek reasoning_effort (QW4)", () => {
  it("emits reasoning_effort on chat when thinking is on and effort is set", async () => {
    const fetchMock = stubFetchOk();
    const client = makeClient();
    await client.chat({
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 16,
      thinking: true,
      reasoningEffort: "low",
      model: "deepseek-v4-pro",
    });
    const body = lastBody(fetchMock);
    expect(body["thinking"]).toEqual({ type: "enabled" });
    expect(body["reasoning_effort"]).toBe("low");
  });

  it("omits reasoning_effort when no effort is set (docs default applies)", async () => {
    const fetchMock = stubFetchOk();
    const client = makeClient();
    await client.chat({
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 16,
      thinking: true,
      model: "deepseek-v4-pro",
    });
    const body = lastBody(fetchMock);
    expect(body["reasoning_effort"]).toBeUndefined();
  });

  it("never sends reasoning_effort on non-reasoning calls", async () => {
    const fetchMock = stubFetchOk();
    const client = makeClient();
    await client.chat({
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 16,
      thinking: false,
      reasoningEffort: "low",
      model: "deepseek-v4-pro",
    });
    const body = lastBody(fetchMock);
    expect(body["reasoning_effort"]).toBeUndefined();
    expect(body["thinking"]).toBeUndefined();
  });

  it("emits reasoning_effort on single-shot call() bodies too", async () => {
    const fetchMock = stubFetchOk();
    const client = makeClient();
    await client.call({
      systemPrompt: "sys",
      userPrompt: "do",
      maxOutputTokens: 16,
      thinking: true,
      reasoningEffort: "high",
      format: "text",
      model: "deepseek-v4-pro",
    });
    const body = lastBody(fetchMock);
    expect(body["reasoning_effort"]).toBe("high");
  });
});
