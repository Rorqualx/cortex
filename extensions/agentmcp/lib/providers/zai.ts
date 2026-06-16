// Z.ai (GLM) provider — the original client, refactored to implement LlmClient.
//
// Quirks absorbed here:
//   - body.thinking = {type:"enabled"} when params.thinking is true.
//   - Default temperature: 1.0 when thinking, 0.3 otherwise. Always sent.
//   - 1113 in-body sentinel for "Insufficient Balance" returned with HTTP 429
//     (almost always means wrong base URL on a Coding Plan key).
//   - response_format: {type:"json_object"} when params.format === "json"
//     (probe-2026-05 confirmed acceptance on the Coding Plan endpoint).
//   - cache_control: {type:"ephemeral"} on the system message by default
//     (probe-2026-05 confirmed acceptance). Opt-out: ZAI_CACHE_DISABLE=1.
//   - Cache hits surface at usage.prompt_tokens_details.cached_tokens
//     (OpenAI-standard field name, not DeepSeek's prompt_cache_hit_tokens).
//     Cache miss is computed as prompt_tokens - cached_tokens.
//   - reasoning_content surfaces at choices[0].message.reasoning_content
//     when thinking is enabled (probe-2026-05 confirmed).

import { z } from "zod";
import type {
  ChatMessage,
  ChatPart,
  LlmCallParams,
  LlmCallResult,
  LlmChatParams,
  LlmClient,
  LlmConfig,
} from "./types.js";
import { LlmError } from "./types.js";

const ToolCallSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const ChatCompletionResponse = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.string(),
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          tool_calls: z.array(ToolCallSchema).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
      // OpenAI-standard nested cache reporting (Z.ai's OpenAI-compat path).
      prompt_tokens_details: z
        .object({
          cached_tokens: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

// Default per-request timeout. 120s was too tight for big glm-5.1 reviews
// with thinking on (deep reasoning + multi-context input + high max_tokens
// can run 90-180s). Bumped to 5 minutes; override via ZAI_TIMEOUT_MS env.
const DEFAULT_TIMEOUT_MS = 300_000;

function formatHint(format: LlmCallParams["format"]): string {
  if (format === "json") {
    return "\n\nRespond with valid JSON only. No prose, no markdown fences.";
  }
  if (format === "markdown") {
    return "\n\nRespond in Markdown.";
  }
  return "";
}

function contextBlock(items: string[]): string {
  const block = items.map((item, idx) => `--- context[${idx}] ---\n${item}`).join("\n\n");
  return `<context>\n${block}\n</context>`;
}

// Cache-control default: ON. Tag the system message so Z.ai's prompt cache
// extends to the (long) per-tool system prompts. Z.ai already does some
// implicit caching on this endpoint (probe-2026-05 saw cached_tokens > 0
// without setting cache_control), but explicit tagging is documented and
// harmless. Opt out via ZAI_CACHE_DISABLE=1 in the env.
function cacheEnabled(): boolean {
  const v = process.env["ZAI_CACHE_DISABLE"];
  return !(v === "1" || v === "true");
}

function buildMessages(params: LlmCallParams): ChatMessage[] {
  const useCache = cacheEnabled();
  const sysMsg: ChatMessage = { role: "system", content: params.systemPrompt };
  if (useCache) {
    sysMsg.cache_control = { type: "ephemeral" };
  }
  const messages: ChatMessage[] = [sysMsg];

  if (params.contextItems && params.contextItems.length > 0) {
    messages.push({ role: "user", content: contextBlock(params.contextItems) });
  }

  const finalText = params.userPrompt + formatHint(params.format);
  const hasImages = params.images && params.images.length > 0;

  if (hasImages && params.images) {
    const parts: ChatPart[] = [{ type: "text", text: finalText }];
    for (const url of params.images) {
      parts.push({ type: "image_url", image_url: { url } });
    }
    messages.push({ role: "user", content: parts });
  } else {
    messages.push({ role: "user", content: finalText });
  }

  return messages;
}

function defaultTemperature(thinking: boolean, explicit: number | undefined): number {
  if (explicit !== undefined) {
    return explicit;
  }
  return thinking ? 1 : 0.3;
}

function buildRequestBody(params: LlmCallParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: buildMessages(params),
    max_tokens: params.maxOutputTokens,
    temperature: defaultTemperature(params.thinking, params.temperature),
    stream: false,
  };
  if (params.thinking) {
    body["thinking"] = { type: "enabled" };
  }
  if (params.format === "json") {
    body["response_format"] = { type: "json_object" };
  }
  return body;
}

function buildChatRequestBody(params: LlmChatParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    max_tokens: params.maxOutputTokens,
    temperature: defaultTemperature(params.thinking, params.temperature),
    stream: false,
  };
  if (params.thinking) {
    body["thinking"] = { type: "enabled" };
  }
  if (params.tools && params.tools.length > 0) {
    body["tools"] = params.tools;
    body["tool_choice"] = params.toolChoice ?? "auto";
  }
  return body;
}

type RawHttp = { status: number; statusText: string; ok: boolean; bodyText: string };

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<RawHttp> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    return { status: res.status, statusText: res.statusText, ok: res.ok, bodyText };
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function wrapTransportError(err: unknown, timeoutMs: number): LlmError {
  if (err instanceof LlmError) {
    return err;
  }
  if (isAbortError(err)) {
    return new LlmError(`Z.ai request timed out after ${timeoutMs}ms`, "zai");
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new LlmError(`Z.ai network error: ${msg}`, "zai");
}

function parseResponseBody(http: RawHttp): unknown {
  if (!http.ok) {
    // 429 with body code 1113 ("Insufficient Balance") is documented as the
    // signature of a Coding-Plan key hitting the wrong base URL. The PaaS
    // endpoint /api/paas/v4 is pay-per-token only; Coding-Plan benefits are
    // gated to /api/coding/paas/v4 (OpenAI-compat) or /api/anthropic (Claude
    // shim). Real out-of-balance failures on a PaaS account look the same,
    // hence "almost always" rather than a flat assertion.
    if (http.status === 429 && /1113|insufficient balance/i.test(http.bodyText)) {
      throw new LlmError(
        `Z.ai HTTP 429 (error 1113 "Insufficient Balance"). On a Coding Plan key this almost always means the wrong base URL — use https://api.z.ai/api/coding/paas/v4 (OpenAI-compat) or https://api.z.ai/api/anthropic (Claude shim), not /api/paas/v4. If you're on PaaS, top up the account.`,
        "zai",
        http.status,
        http.bodyText.slice(0, 2000),
      );
    }
    throw new LlmError(
      `Z.ai HTTP ${http.status}: ${http.statusText}`,
      "zai",
      http.status,
      http.bodyText.slice(0, 2000),
    );
  }
  try {
    return JSON.parse(http.bodyText);
  } catch {
    throw new LlmError(
      "Z.ai returned non-JSON body",
      "zai",
      http.status,
      http.bodyText.slice(0, 2000),
    );
  }
}

async function executeRequest(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  let http: RawHttp;
  try {
    http = await postJson(url, apiKey, body, timeoutMs, signal);
  } catch (err) {
    throw wrapTransportError(err, timeoutMs);
  }
  return parseResponseBody(http);
}

async function executeWithRetry(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await executeRequest(url, apiKey, body, timeoutMs, signal);
  } catch (err) {
    if (signal?.aborted) {
      throw err;
    }
    if (err instanceof LlmError && err.status !== undefined && err.status >= 500) {
      await new Promise((r) => setTimeout(r, 500));
      return executeRequest(url, apiKey, body, timeoutMs, signal);
    }
    throw err;
  }
}

function shapeResult(raw: unknown, fallbackModel: string, latencyMs: number): LlmCallResult {
  const parsed = ChatCompletionResponse.safeParse(raw);
  if (!parsed.success) {
    throw new LlmError(
      `Z.ai response did not match expected shape: ${parsed.error.message}`,
      "zai",
      undefined,
      JSON.stringify(raw).slice(0, 2000),
    );
  }

  const firstChoice = parsed.data.choices[0];
  if (!firstChoice) {
    throw new LlmError("Z.ai returned no choices", "zai");
  }

  const result: LlmCallResult = {
    content: firstChoice.message.content ?? "",
    model: parsed.data.model ?? fallbackModel,
    inputTokens: parsed.data.usage?.prompt_tokens ?? 0,
    outputTokens: parsed.data.usage?.completion_tokens ?? 0,
    latencyMs,
  };
  if (firstChoice.message.tool_calls && firstChoice.message.tool_calls.length > 0) {
    result.toolCalls = firstChoice.message.tool_calls;
  }
  if (firstChoice.message.reasoning_content) {
    result.reasoningContent = firstChoice.message.reasoning_content;
  }
  if (firstChoice.finish_reason) {
    result.finishReason = firstChoice.finish_reason;
  }
  // Cache reporting: Z.ai surfaces cached_tokens at OpenAI's standard nested
  // path. Compute miss as prompt - cached so the meta footer can render
  // hit/miss counts the same way DeepSeek's path does.
  const cachedTokens = parsed.data.usage?.prompt_tokens_details?.cached_tokens;
  if (cachedTokens !== undefined) {
    result.cacheHitTokens = cachedTokens;
    const promptTokens = parsed.data.usage?.prompt_tokens ?? 0;
    result.cacheMissTokens = Math.max(0, promptTokens - cachedTokens);
  }
  return result;
}

export function makeZaiProvider(config: LlmConfig): LlmClient {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    provider: "zai",
    async call(params: LlmCallParams): Promise<LlmCallResult> {
      const body = buildRequestBody(params);
      const start = Date.now();
      const raw = await executeWithRetry(url, config.apiKey, body, timeoutMs);
      return shapeResult(raw, params.model, Date.now() - start);
    },
    async chat(params: LlmChatParams): Promise<LlmCallResult> {
      const body = buildChatRequestBody(params);
      const start = Date.now();
      const raw = await executeWithRetry(url, config.apiKey, body, timeoutMs, params.signal);
      return shapeResult(raw, params.model, Date.now() - start);
    },
  };
}
