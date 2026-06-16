// DeepSeek provider — OpenAI-compatible at https://api.deepseek.com/v1.
//
// Quirks absorbed here:
//   - body.thinking = {type:"enabled"} (same shape as Z.ai). Optional sibling
//     `reasoning_effort` is left at the docs default ("high") — bump if a tool
//     wants harder reasoning.
//   - Temperature is a no-op when thinking is enabled (per DeepSeek docs).
//     We send 0.3 only when thinking is OFF (or pass an explicit override
//     either way); omit the field entirely under thinking-with-no-override.
//   - reasoning_content is stateful across multi-turn:
//       * any tool_calls present in the conversation → must round-trip
//         reasoning_content on assistant messages → 400 if stripped.
//       * no tool_calls in the conversation       → must strip
//         reasoning_content → 400 if present.
//     applyReasoningContentRule() implements the toggle at request build time.
//   - usage exposes prompt_cache_hit_tokens / prompt_cache_miss_tokens (DeepSeek-
//     specific names; OpenAI uses prompt_tokens_details.cached_tokens). We
//     mirror them onto LlmCallResult.cacheHitTokens / cacheMissTokens.
//   - 402 ("Insufficient Balance") is the balance sentinel (not Z.ai's 1113-in-body).
//   - No vision support — DeepSeek's current models don't accept image_url parts.

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
      prompt_cache_hit_tokens: z.number().optional(),
      prompt_cache_miss_tokens: z.number().optional(),
    })
    .optional(),
});

const DEFAULT_TIMEOUT_MS = 300_000;

function formatHint(format: LlmCallParams["format"]): string {
  // DeepSeek's json_object mode requires the word "json" in the prompt — the
  // markdown/text hints stay aligned with OpenAI's expectations.
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

function buildMessages(params: LlmCallParams): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: params.systemPrompt }];

  if (params.contextItems && params.contextItems.length > 0) {
    messages.push({ role: "user", content: contextBlock(params.contextItems) });
  }

  const finalText = params.userPrompt + formatHint(params.format);
  const hasImages = params.images && params.images.length > 0;

  if (hasImages && params.images) {
    // DeepSeek doesn't accept image_url parts on current models; we still
    // build the parts so the API surfaces a clear 400 rather than silently
    // dropping the images. Callers should not be routing vision tasks here.
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

// DeepSeek's stateful rule (see module-level note). Returns a fresh array.
function applyReasoningContentRule(messages: ChatMessage[]): ChatMessage[] {
  const hasAnyToolCalls = messages.some((m) => m.tool_calls && m.tool_calls.length > 0);
  if (hasAnyToolCalls) {
    // Pass-through: preserve reasoning_content on assistant messages so
    // DeepSeek doesn't 400 the request.
    return messages;
  }
  // Strip: remove reasoning_content from any assistant messages so DeepSeek
  // doesn't 400 the request.
  return messages.map((m) => {
    if (m.role === "assistant" && m.reasoning_content !== undefined) {
      const { reasoning_content: _drop, ...rest } = m;
      return rest;
    }
    return m;
  });
}

function applyTemperature(
  body: Record<string, unknown>,
  thinking: boolean,
  explicit: number | undefined,
): void {
  if (explicit !== undefined) {
    body["temperature"] = explicit;
    return;
  }
  // Omit the field when thinking is on (DeepSeek docs say it's a no-op).
  if (!thinking) {
    body["temperature"] = 0.3;
  }
}

function buildRequestBody(params: LlmCallParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: buildMessages(params),
    max_tokens: params.maxOutputTokens,
    stream: false,
  };
  applyTemperature(body, params.thinking, params.temperature);
  if (params.thinking) {
    body["thinking"] = { type: "enabled" };
  }
  // Structured json_object mode parallels zai. DeepSeek's mode requires the
  // word "json" in the prompt — the textual formatHint already includes "JSON".
  if (params.format === "json") {
    body["response_format"] = { type: "json_object" };
  }
  return body;
}

function buildChatRequestBody(params: LlmChatParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: applyReasoningContentRule(params.messages),
    max_tokens: params.maxOutputTokens,
    stream: false,
  };
  applyTemperature(body, params.thinking, params.temperature);
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
    return new LlmError(`DeepSeek request timed out after ${timeoutMs}ms`, "deepseek");
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new LlmError(`DeepSeek network error: ${msg}`, "deepseek");
}

function parseResponseBody(http: RawHttp): unknown {
  if (!http.ok) {
    if (http.status === 402) {
      throw new LlmError(
        `DeepSeek HTTP 402 (Insufficient Balance). Top up at platform.deepseek.com/balance.`,
        "deepseek",
        http.status,
        http.bodyText.slice(0, 2000),
      );
    }
    if (http.status === 400 && /reasoning_content/i.test(http.bodyText)) {
      throw new LlmError(
        `DeepSeek HTTP 400 referencing reasoning_content — multi-turn rule violation. ` +
          `When tool_calls appear in the conversation, reasoning_content must be ` +
          `round-tripped on assistant messages; when they don't, it must be stripped. ` +
          `Body: ${http.bodyText.slice(0, 500)}`,
        "deepseek",
        http.status,
        http.bodyText.slice(0, 2000),
      );
    }
    throw new LlmError(
      `DeepSeek HTTP ${http.status}: ${http.statusText}`,
      "deepseek",
      http.status,
      http.bodyText.slice(0, 2000),
    );
  }
  try {
    return JSON.parse(http.bodyText);
  } catch {
    throw new LlmError(
      "DeepSeek returned non-JSON body",
      "deepseek",
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
      `DeepSeek response did not match expected shape: ${parsed.error.message}`,
      "deepseek",
      undefined,
      JSON.stringify(raw).slice(0, 2000),
    );
  }

  const firstChoice = parsed.data.choices[0];
  if (!firstChoice) {
    throw new LlmError("DeepSeek returned no choices", "deepseek");
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
  if (parsed.data.usage?.prompt_cache_hit_tokens !== undefined) {
    result.cacheHitTokens = parsed.data.usage.prompt_cache_hit_tokens;
  }
  if (parsed.data.usage?.prompt_cache_miss_tokens !== undefined) {
    result.cacheMissTokens = parsed.data.usage.prompt_cache_miss_tokens;
  }
  return result;
}

export function makeDeepSeekProvider(config: LlmConfig): LlmClient {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    provider: "deepseek",
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
