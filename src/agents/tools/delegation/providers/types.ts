// Shared provider abstraction.
//
// Three OpenAI-compatible providers wear different quirks:
//   - zai (GLM):      body.thinking = {type:"enabled"}, force temp=1.0 on thinking,
//                     1113 in-body sentinel for insufficient balance.
//   - deepseek:       body.thinking = {type:"enabled"}; reasoning_content is stateful
//                     across multi-turn (required when tool_calls present, forbidden
//                     when not — both produce 400). Cache fields are
//                     prompt_cache_hit_tokens / prompt_cache_miss_tokens. 402 = balance.
//   - kimi (Moonshot): thinking goes via extra_body, not the top-level body.
//                     Cache field is usage.cached_tokens. 429 ambiguously means
//                     either rate-limit or balance.
//
// Each provider implements LlmClient.call (single-completion shaping with
// systemPrompt + userPrompt + context + images) and LlmClient.chat (multi-turn
// with messages + tools + tool_calls). Both produce LlmCallResult — a unified
// envelope with optional cache and reasoning fields populated when the provider
// surfaces them.
//
// `temperature` in LlmCallParams / LlmChatParams is optional. When undefined,
// each provider applies its own default: zai+kimi force 1.0 on thinking / 0.3
// otherwise; deepseek sets 0.3 only when thinking is off and omits the field
// entirely under thinking (DeepSeek's docs say it's a no-op there).

export type Provider = "zai" | "deepseek" | "kimi";

export type ChatRole = "system" | "user" | "assistant" | "tool";
export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type ChatPart = TextPart | ImagePart;

export type ToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

// Permissive message shape; the chat-completions API accepts any combo the
// OpenAI compat layer supports plus assistant tool_calls and role:"tool" with
// tool_call_id. reasoning_content is non-OpenAI but DeepSeek requires it to
// round-trip in multi-turn when tool_calls are present. cache_control is
// Anthropic-style — Z.ai's OpenAI-compat endpoint accepts it (probe-2026-05
// confirmed); other providers ignore it.
export type ChatMessage = {
  role: ChatRole;
  content?: string | ChatPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  cache_control?: { type: "ephemeral" };
};

export type LlmFormat = "text" | "json" | "markdown";

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type LlmCallParams = {
  systemPrompt: string;
  userPrompt: string;
  contextItems?: string[] | undefined;
  images?: string[] | undefined;
  maxOutputTokens: number;
  // undefined = let the provider apply its default. See module-level note.
  temperature?: number | undefined;
  thinking: boolean;
  format: LlmFormat;
  model: string;
};

export type LlmChatParams = {
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature?: number | undefined;
  thinking: boolean;
  model: string;
  tools?: readonly ToolDef[] | undefined;
  toolChoice?: "auto" | "none" | "required" | undefined;
  // External abort signal. Used by the explore loop's wall-clock cap to
  // preempt a slow chat response so the wall budget is genuinely bounded.
  signal?: AbortSignal | undefined;
};

export type LlmCallResult = {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  toolCalls?: ToolCall[];
  finishReason?: string;
  // Cache hit/miss counts when the provider surfaces them. Both undefined
  // means caching was either inactive or not exposed for this call.
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  // Provider-specific reasoning trace. Stored on the result so the explore
  // loop can echo it back to DeepSeek (required there in multi-turn when
  // tool_calls are present). Absent for providers that don't surface it.
  reasoningContent?: string;
};

export type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
};

export interface LlmClient {
  readonly provider: Provider;
  call(params: LlmCallParams): Promise<LlmCallResult>;
  chat(params: LlmChatParams): Promise<LlmCallResult>;
}

export class LlmError extends Error {
  public readonly provider: Provider;
  public readonly status: number | undefined;
  public readonly body: string | undefined;
  constructor(message: string, provider: Provider, status?: number, body?: string) {
    super(message);
    this.name = "LlmError";
    this.provider = provider;
    this.status = status;
    this.body = body;
  }
}
