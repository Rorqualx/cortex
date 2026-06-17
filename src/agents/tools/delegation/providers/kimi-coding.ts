// kimi-for-coding provider client — speaks the Anthropic Messages dialect
// (api.kimi.com/coding) via @anthropic-ai/sdk, adapted to the delegation
// LlmClient interface. This is the path the OpenAI-compat clients can't serve.
//
// It translates between the loops' OpenAI-style messages/tools and Anthropic's
// content-block format:
//   - system messages       → top-level `system` string
//   - assistant.tool_calls   → assistant `tool_use` blocks
//   - role:"tool" results    → folded into a following user `tool_result` block
//   - OpenAI function tools   → Anthropic tools {name, description, input_schema}
//   - response text + tool_use blocks → LlmCallResult { content, toolCalls }
//
// Auth: api-key mode → x-api-key (SDK `apiKey`); oauth/token mode → Bearer
// (SDK `authToken`). Extended thinking is intentionally NOT requested, to avoid
// Anthropic's thinking-block round-trip/signature requirements in the multi-turn
// tool loops.
//
// NOTE: untested against the live api.kimi.com/coding endpoint from this
// environment; header/auth specifics may need tuning during live bring-up.

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool as AnthropicTool,
  ToolChoice,
} from "@anthropic-ai/sdk/resources/messages.js";
import type {
  ChatMessage,
  ChatPart,
  LlmCallParams,
  LlmCallResult,
  LlmChatParams,
  LlmClient,
  ToolCall,
  ToolDef,
} from "./types.js";
import { LlmError } from "./types.js";

export type KimiCodingConfig = {
  apiKey: string;
  baseUrl: string;
  authMode?: "api-key" | "oauth" | "token" | undefined;
  timeoutMs?: number | undefined;
};

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is Extract<ChatPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

function toUserContent(content: ChatMessage["content"]): string | ContentBlockParam[] {
  if (typeof content === "string" || content == null) return content ?? "";
  const blocks: ContentBlockParam[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const url = part.image_url.url;
      const dataUrl = /^data:(.+?);base64,(.*)$/.exec(url);
      if (dataUrl) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: dataUrl[1] as "image/png", data: dataUrl[2]! },
        });
      } else {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  return blocks.length > 0 ? blocks : "";
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Translate OpenAI-style chat messages into Anthropic system + messages. */
export function toAnthropic(messages: ChatMessage[]): { system: string; messages: MessageParam[] } {
  let system = "";
  const out: MessageParam[] = [];
  let pendingToolResults: ContentBlockParam[] = [];

  const flush = () => {
    if (pendingToolResults.length > 0) {
      out.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === "system") {
      const t = textOf(m.content);
      if (t) system += system ? `\n\n${t}` : t;
      continue;
    }
    if (m.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: textOf(m.content),
      });
      continue;
    }
    flush();
    if (m.role === "user") {
      out.push({ role: "user", content: toUserContent(m.content) });
    } else if (m.role === "assistant") {
      const blocks: ContentBlockParam[] = [];
      const text = textOf(m.content);
      if (text.trim()) blocks.push({ type: "text", text });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: safeParseArgs(tc.function.arguments),
        });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : text });
    }
  }
  flush();
  return { system, messages: out };
}

function toAnthropicTools(tools: readonly ToolDef[] | undefined): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as AnthropicTool["input_schema"],
  }));
}

function toToolChoice(choice: LlmChatParams["toolChoice"]): ToolChoice | undefined {
  switch (choice) {
    case "none":
      return { type: "none" };
    case "required":
      return { type: "any" };
    case "auto":
      return { type: "auto" };
    default:
      return undefined;
  }
}

export function makeKimiCodingProvider(config: KimiCodingConfig): LlmClient {
  const useBearer = config.authMode === "oauth" || config.authMode === "token";
  const client = new Anthropic({
    apiKey: useBearer ? null : config.apiKey,
    authToken: useBearer ? config.apiKey : null,
    baseURL: config.baseUrl,
    maxRetries: 0,
    ...(config.timeoutMs ? { timeout: config.timeoutMs } : {}),
  });

  async function send(
    messages: ChatMessage[],
    opts: {
      model: string;
      maxOutputTokens: number;
      tools?: readonly ToolDef[];
      toolChoice?: LlmChatParams["toolChoice"];
      signal?: AbortSignal;
    },
  ): Promise<LlmCallResult> {
    const started = Date.now();
    const { system, messages: amsgs } = toAnthropic(messages);
    const tools = toAnthropicTools(opts.tools);
    const params: MessageCreateParamsNonStreaming = {
      model: opts.model,
      max_tokens: opts.maxOutputTokens,
      messages: amsgs,
      ...(system ? { system } : {}),
      ...(tools ? { tools } : {}),
      ...(toToolChoice(opts.toolChoice) ? { tool_choice: toToolChoice(opts.toolChoice)! } : {}),
    };
    let resp: Anthropic.Messages.Message;
    try {
      resp = await client.messages.create(params, opts.signal ? { signal: opts.signal } : {});
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      throw new LlmError(
        `kimi-coding request failed: ${err instanceof Error ? err.message : String(err)}`,
        "kimi",
        status,
      );
    }

    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const block of resp.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }

    return {
      content,
      model: resp.model ?? opts.model,
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
      latencyMs: Date.now() - started,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(resp.stop_reason ? { finishReason: resp.stop_reason } : {}),
      ...(resp.usage &&
      "cache_read_input_tokens" in resp.usage &&
      resp.usage.cache_read_input_tokens != null
        ? { cacheHitTokens: resp.usage.cache_read_input_tokens }
        : {}),
    };
  }

  return {
    provider: "kimi",
    async call(params: LlmCallParams): Promise<LlmCallResult> {
      const messages: ChatMessage[] = [{ role: "system", content: params.systemPrompt }];
      const userParts: ChatPart[] = [{ type: "text", text: params.userPrompt }];
      for (const c of params.contextItems ?? [])
        userParts.push({ type: "text", text: `\n\n--- context ---\n${c}` });
      for (const img of params.images ?? [])
        userParts.push({ type: "image_url", image_url: { url: img } });
      messages.push({ role: "user", content: userParts });
      return send(messages, { model: params.model, maxOutputTokens: params.maxOutputTokens });
    },
    async chat(params: LlmChatParams): Promise<LlmCallResult> {
      return send(params.messages, {
        model: params.model,
        maxOutputTokens: params.maxOutputTokens,
        tools: params.tools,
        toolChoice: params.toolChoice,
        signal: params.signal,
      });
    },
  };
}
