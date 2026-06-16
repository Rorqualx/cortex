// Kimi (Moonshot) provider — OpenAI-compatible at https://api.moonshot.ai/v1.
//
// Quirks absorbed here:
//   - body.thinking = {type:"enabled", keep:"all"} when thinking is requested.
//     `keep:"all"` preserves reasoning_content across multi-turn replay (it
//     then counts as input tokens, which the cache discount mostly recovers).
//     For thinking=false we explicitly send {type:"disabled"} because K2.6 /
//     K2.5 reason by default — omitting the field would still produce CoT.
//     For moonshot-v1-* models the field is benign / ignored.
//   - usage.cached_tokens is the single field for cache-hit input tokens
//     (not split hit/miss like DeepSeek). We mirror it onto cacheHitTokens
//     and infer cacheMissTokens = inputTokens - cacheHitTokens.
//   - 429 is ambiguous: rate-limit OR insufficient funds (the API masks
//     balance failures as rate-limit). Error hint surfaces both.
//   - Default temperature: model-locked on K2.x. K2.5/K2.6 reject anything
//     other than 1.0 (thinking on) or 0.6 (thinking off) with HTTP 400
//     `invalid_request_error`. moonshot-v1-* and other variants accept the
//     standard 1.0 / 0.3 defaults.
//   - Vision is supported on K2.6 / K2.5 / moonshot-v1-*-vision-preview via
//     the standard image_url parts shape.

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
      cached_tokens: z.number().optional(),
    })
    .optional(),
});

// K2.6 with thinking-on on planning/research tasks legitimately runs 100-300s
// server-side (verified across r2-r4: median 107s → 254s → 299s as load varies).
// 300s clipped real completions; 600s gives margin without hiding genuine hangs.
const DEFAULT_TIMEOUT_MS = 600_000;

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

function buildMessages(params: LlmCallParams): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: params.systemPrompt }];

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

function isK2Model(model: string): boolean {
  return /^kimi-k2\.\d/.test(model);
}

function defaultTemperature(
  model: string,
  thinking: boolean,
  explicit: number | undefined,
): number {
  if (explicit !== undefined) {
    return explicit;
  }
  if (isK2Model(model)) {
    return thinking ? 1.0 : 0.6;
  }
  return thinking ? 1 : 0.3;
}

function thinkingField(thinking: boolean): Record<string, unknown> {
  // Explicit on/off both ways. K2.6 / K2.5 reason by default, so a missing
  // field would silently keep CoT on for "thinking:false" callers.
  return thinking ? { type: "enabled", keep: "all" } : { type: "disabled" };
}

// Streaming on by default. K2.6 with thinking-on can spend 4-5 minutes
// generating reasoning_content before any visible content appears; under
// non-streaming, undici's body-timeout (~300s) aborts before the first byte
// arrives. Streaming makes each delta reset the body timer so long reasoning
// sessions complete. `stream_options.include_usage` ensures the usage block
// arrives in the final chunk before [DONE].
function buildRequestBody(params: LlmCallParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: buildMessages(params),
    max_tokens: params.maxOutputTokens,
    temperature: defaultTemperature(params.model, params.thinking, params.temperature),
    thinking: thinkingField(params.thinking),
    stream: true,
    stream_options: { include_usage: true },
  };
  // Structured json_object mode parallels zai. The textual formatHint already
  // includes the word "JSON" in the user prompt, satisfying Moonshot's
  // requirement that the prompt explicitly mention JSON when this mode is on.
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
    temperature: defaultTemperature(params.model, params.thinking, params.temperature),
    thinking: thinkingField(params.thinking),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (params.tools && params.tools.length > 0) {
    body["tools"] = params.tools;
    body["tool_choice"] = params.toolChoice ?? "auto";
  }
  return body;
}

type RawHttp = { status: number; statusText: string; ok: boolean; bodyText: string };

// Parses a single SSE delta chunk's `delta` field and folds it into the
// accumulator. Mutates the accumulator in place.
type StreamAccumulator = {
  content: string;
  reasoning_content: string;
  finish_reason?: string | null;
  tool_calls_by_index: Map<number, { id?: string; name?: string; arguments: string }>;
  model?: string;
  id?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
  };
};

function foldDelta(acc: StreamAccumulator, chunk: Record<string, unknown>): void {
  if (typeof chunk["model"] === "string" && !acc.model) {
    acc.model = chunk["model"];
  }
  if (typeof chunk["id"] === "string" && !acc.id) {
    acc.id = chunk["id"];
  }
  // Final chunk often carries usage at the top level (with empty choices[]).
  const usage = chunk["usage"] as StreamAccumulator["usage"] | undefined;
  if (usage && typeof usage === "object") {
    acc.usage = usage;
  }

  const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices) || choices.length === 0) {
    return;
  }
  const choice = choices[0];
  if (!choice) {
    return;
  }
  const finishReason = choice["finish_reason"];
  if (finishReason !== null && finishReason !== undefined) {
    acc.finish_reason = finishReason as string;
  }

  const delta = choice["delta"] as Record<string, unknown> | undefined;
  if (!delta) {
    return;
  }
  if (typeof delta["content"] === "string") {
    acc.content += delta["content"];
  }
  if (typeof delta["reasoning_content"] === "string") {
    acc.reasoning_content += delta["reasoning_content"];
  }

  const toolCalls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const idx = typeof tc["index"] === "number" ? tc["index"] : 0;
      let entry = acc.tool_calls_by_index.get(idx);
      if (!entry) {
        entry = { arguments: "" };
        acc.tool_calls_by_index.set(idx, entry);
      }
      if (typeof tc["id"] === "string") {
        entry.id = tc["id"];
      }
      const fn = tc["function"] as Record<string, unknown> | undefined;
      if (fn) {
        if (typeof fn["name"] === "string") {
          entry.name = fn["name"];
        }
        if (typeof fn["arguments"] === "string") {
          entry.arguments += fn["arguments"];
        }
      }
    }
  }
}

// Synthesize a non-streaming chat-completion shape from the accumulator so
// the existing shapeResult / ChatCompletionResponse logic works unchanged.
function synthesizeResponse(acc: StreamAccumulator): unknown {
  const message: Record<string, unknown> = { role: "assistant", content: acc.content };
  if (acc.reasoning_content) {
    message["reasoning_content"] = acc.reasoning_content;
  }
  if (acc.tool_calls_by_index.size > 0) {
    message["tool_calls"] = [...acc.tool_calls_by_index.entries()]
      .toSorted((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id ?? "",
        type: "function",
        function: { name: v.name ?? "", arguments: v.arguments },
      }));
  }
  return {
    id: acc.id,
    model: acc.model,
    choices: [{ message, finish_reason: acc.finish_reason ?? null }],
    usage: acc.usage,
  };
}

async function postJsonStream(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<RawHttp> {
  const controller = new AbortController();
  // Wall-clock cap on the total request. Each delta resets the user-visible
  // body-timeout via the streaming reads; this timer guards against a stuck
  // server that keeps the connection open without sending anything.
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
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Error responses still arrive non-streaming (Kimi sends a JSON error
      // body before closing). Read it once and return the raw HTTP shape so
      // the caller can run parseResponseBody for the error path.
      const errBody = await res.text();
      return { status: res.status, statusText: res.statusText, ok: false, bodyText: errBody };
    }
    if (!res.body) {
      throw new LlmError("Kimi streaming response had no body", "kimi", res.status);
    }
    const acc: StreamAccumulator = {
      content: "",
      reasoning_content: "",
      tool_calls_by_index: new Map(),
    };
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by blank lines. Process every complete event
      // currently in the buffer and keep the trailing partial.
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") {
            continue;
          }
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            foldDelta(acc, parsed);
          } catch {
            // Malformed chunk — skip rather than abort the whole stream.
          }
        }
      }
    }
    const synthesized = synthesizeResponse(acc);
    return {
      status: res.status,
      statusText: res.statusText,
      ok: true,
      bodyText: JSON.stringify(synthesized),
    };
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
    return new LlmError(`Kimi request timed out after ${timeoutMs}ms`, "kimi");
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new LlmError(`Kimi network error: ${msg}`, "kimi");
}

function parseResponseBody(http: RawHttp): unknown {
  if (!http.ok) {
    if (http.status === 429) {
      throw new LlmError(
        `Kimi HTTP 429 — rate-limit OR insufficient balance (the API masks balance ` +
          `failures as 429). Check the developer dashboard at platform.moonshot.ai ` +
          `before assuming this is a true rate limit.`,
        "kimi",
        http.status,
        http.bodyText.slice(0, 2000),
      );
    }
    throw new LlmError(
      `Kimi HTTP ${http.status}: ${http.statusText}`,
      "kimi",
      http.status,
      http.bodyText.slice(0, 2000),
    );
  }
  try {
    return JSON.parse(http.bodyText);
  } catch {
    throw new LlmError(
      "Kimi returned non-JSON body",
      "kimi",
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
    http = await postJsonStream(url, apiKey, body, timeoutMs, signal);
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
      `Kimi response did not match expected shape: ${parsed.error.message}`,
      "kimi",
      undefined,
      JSON.stringify(raw).slice(0, 2000),
    );
  }

  const firstChoice = parsed.data.choices[0];
  if (!firstChoice) {
    throw new LlmError("Kimi returned no choices", "kimi");
  }

  const inputTokens = parsed.data.usage?.prompt_tokens ?? 0;
  const result: LlmCallResult = {
    content: firstChoice.message.content ?? "",
    model: parsed.data.model ?? fallbackModel,
    inputTokens,
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
  // cached_tokens is the cache-hit input count. Infer miss = total - hit so the
  // pricing.ts cache discount works without a separate miss field.
  if (parsed.data.usage?.cached_tokens !== undefined) {
    result.cacheHitTokens = parsed.data.usage.cached_tokens;
    result.cacheMissTokens = Math.max(0, inputTokens - parsed.data.usage.cached_tokens);
  }
  return result;
}

export function makeKimiProvider(config: LlmConfig): LlmClient {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    provider: "kimi",
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
