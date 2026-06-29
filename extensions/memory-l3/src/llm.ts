import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { FactCertainty } from "./types.js";

export type LlmCaller = (params: {
  systemPrompt: string;
  userPrompt: string;
  thinking?: boolean;
}) => Promise<string>;

export type GlmCallerConfig = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  // Bounded retry for transient overload (429) / 5xx. Z.ai returns 429 code
  // 1305 "service temporarily overloaded" under burst; without retry a single
  // blip fails the whole consolidation/answer call. maxRetries = extra attempts
  // after the first (total tries = maxRetries + 1).
  maxRetries?: number;
  retryBaseMs?: number;
  // Per-attempt backoff ceiling. Default 30s; raise (e.g. 60s) when riding out
  // sustained contention so retries space out instead of hammering the limiter.
  maxBackoffMs?: number;
  // Proactive throttle: minimum gap between successive requests from this caller.
  // Default 0 (no spacing). Set (e.g. 1000) so a batch eval coexists with the
  // live gateway under a shared per-minute rate limit instead of bursting into
  // 429s. Reactive backoff alone only kicks in after a failure; this prevents it.
  minIntervalMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
};

export const DEFAULT_GLM_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const DEFAULT_GLM_MODEL = "glm-5.2";

// 429 = rate limit/overload; 5xx = transient server error. 4xx (auth, bad
// request) are caller faults and must fail fast, not retry.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Honor Retry-After (delta-seconds or HTTP-date) when present; else exponential
// backoff with full jitter, capped so a long outage does not stall unboundedly.
function backoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  retryAfter: string | null,
): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) {
      return Math.min(secs * 1000, capMs);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(dateMs - Date.now(), 0), capMs);
    }
  }
  const exp = Math.min(baseMs * 2 ** attempt, capMs);
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

export function createGlmCaller(config: GlmCallerConfig): LlmCaller {
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleepImpl ?? defaultSleep;
  const maxRetries = config.maxRetries ?? 5;
  const retryBaseMs = config.retryBaseMs ?? 1000;
  const maxBackoffMs = config.maxBackoffMs ?? 30_000;
  const minIntervalMs = config.minIntervalMs ?? 0;
  // Shared across concurrent calls so the gap is global, not per-invocation:
  // each call reserves the next slot before issuing its request.
  let nextAllowedAt = 0;
  return async ({ systemPrompt, userPrompt, thinking }) => {
    if (minIntervalMs > 0) {
      const now = Date.now();
      const wait = Math.max(0, nextAllowedAt - now);
      nextAllowedAt = Math.max(nextAllowedAt, now) + minIntervalMs;
      if (wait > 0) {
        await sleep(wait);
      }
    }
    const baseUrl = config.baseUrl ?? DEFAULT_GLM_BASE_URL;
    const body: Record<string, unknown> = {
      model: config.model ?? DEFAULT_GLM_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    };
    // `thinking` is a Z.ai-specific param; other OpenAI-compatible providers
    // (DeepSeek, Moonshot/kimi) reject it with 400. Only send it to z.ai.
    if (thinking !== undefined && baseUrl.includes("z.ai")) {
      body.thinking = { type: thinking ? "enabled" : "disabled" };
    }
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        const json = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return json.choices?.[0]?.message?.content ?? "";
      }
      const text = await response.text();
      if (attempt >= maxRetries || !RETRYABLE_STATUSES.has(response.status)) {
        throw new Error(`GLM call failed: ${response.status} ${text}`);
      }
      await sleep(
        backoffMs(
          attempt,
          retryBaseMs,
          maxBackoffMs,
          response.headers?.get?.("retry-after") ?? null,
        ),
      );
    }
  };
}

export type AnthropicCallerConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  // kimi-for-coding is a reasoning model that REQUIRES thinking=enabled; we send
  // a fixed budget and parse only the text block out of the response.
  maxTokens?: number;
  thinkingBudgetTokens?: number;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryBaseMs?: number;
  maxBackoffMs?: number;
  minIntervalMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
};

// Anthropic /v1/messages caller (e.g. kimi-for-coding via api.kimi.com/coding).
// Mirrors createGlmCaller's retry/backoff/throttle but speaks the Anthropic
// message schema: system is a top-level field, the answer is the first text
// content block, and thinking is forced on (the model rejects type!=enabled).
export function createAnthropicCaller(config: AnthropicCallerConfig): LlmCaller {
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleepImpl ?? defaultSleep;
  const maxRetries = config.maxRetries ?? 5;
  const retryBaseMs = config.retryBaseMs ?? 1000;
  const maxBackoffMs = config.maxBackoffMs ?? 30_000;
  const minIntervalMs = config.minIntervalMs ?? 0;
  const maxTokens = config.maxTokens ?? 4096;
  const thinkingBudget = config.thinkingBudgetTokens ?? 2048;
  const url = `${config.baseUrl.replace(/\/$/, "")}/v1/messages`;
  let nextAllowedAt = 0;
  return async ({ systemPrompt, userPrompt }) => {
    if (minIntervalMs > 0) {
      const now = Date.now();
      const wait = Math.max(0, nextAllowedAt - now);
      nextAllowedAt = Math.max(nextAllowedAt, now) + minIntervalMs;
      if (wait > 0) {
        await sleep(wait);
      }
    }
    const body = {
      model: config.model,
      max_tokens: maxTokens,
      thinking: { type: "enabled", budget_tokens: thinkingBudget },
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    };
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        const json = (await response.json()) as {
          content?: Array<{ type: string; text?: string }>;
        };
        const textBlock = json.content?.find((b) => b.type === "text");
        return textBlock?.text ?? "";
      }
      const text = await response.text();
      if (attempt >= maxRetries || !RETRYABLE_STATUSES.has(response.status)) {
        throw new Error(`Anthropic call failed: ${response.status} ${text}`);
      }
      await sleep(
        backoffMs(
          attempt,
          retryBaseMs,
          maxBackoffMs,
          response.headers?.get?.("retry-after") ?? null,
        ),
      );
    }
  };
}

// PROMPT_VERSION = 9 — adds SEMANTIC_ENTROPY confidence scoring on prose facts.
// v8 added CERTAINTY tagging so consolidation can hold tentative observations to higher promotion bars.
// v7 added DECISIONS and ACTIONS co-emission. v6 added SIGNIFICANT.
// v5 added REASONING. v4 co-emitted prose + typed.
const EXTRACT_SYSTEM_PROMPT = `You are a memory extraction assistant. Read the conversation chunk and extract three complementary kinds of information:

1. PROSE FACTS — durable LLM-distilled units of information for future recall.
2. TYPED FACTS — verbatim precise values that must be remembered EXACTLY.
3. DECISIONS & ACTIONS — structured decisions reached and action items identified.

Rules (PROMPT_VERSION=8):
- IMPORTANCE: 0.0-1.0 score for retrieval ranking. User preferences/decisions/identity facts get 0.7+; one-off context 0.3-0.5; trivia 0.1-0.3.
- DEDUPKEY: stable kebab-case key like "user_preference:morning_standups".
- REASONING: one optional sentence explaining WHY this fact is worth remembering across sessions.
- SIGNIFICANT: set to true when the user explicitly expresses intent to remember. Also true for safety-critical information or repeated facts. Default false.
- CERTAINTY: "confirmed" when the user directly stated or verified the fact; "tentative" for inferences, speculation, or single unverified observations; "instructional" for explicit directives about future behavior ("always X", "never Y"). Default "confirmed".
- SEMANTIC_ENTROPY: optional float 0.0–1.0 measuring the extractor's confidence that this fact is semantically coherent and well-supported by the source text. Higher = more confident (lower entropy). Default 1.0 when omitted.
- TYPED FACTS: emit only when a precise verbatim value appears. Each typed fact must include slot, value, sourceSpan, unit (or null), confidence. Skip when no verbatim values.
- DECISIONS: emit when a clear decision, conclusion, or agreement was reached (including implicit ones like "let's go with X"). Each must have:
  - text: what was decided.
  - maker: "user", "agent", or "both".
  - confidence: 0.0-1.0.
  - sourceSpan: verbatim context from conversation.
- ACTIONS: emit when a concrete task, follow-up, or action item is identified. Each must have:
  - text: what needs to be done.
  - owner: "user", "agent", or "unassigned".
  - deadline: optional deadline or time context string, or null.
  - confidence: 0.0-1.0.
  - sourceSpan: verbatim context from conversation.
  Skip decisions/actions when none are present.

Emit strict JSON only, with no surrounding prose.

Schema:
{
  "facts": [
    { "text": "string", "importance": 0.0..1.0, "dedupKey": "kebab:case", "reasoning": "optional string", "significant": false, "certainty": "tentative|confirmed|instructional", "semantic_entropy": 1.0 }
  ],
  "typedFacts": [
    { "slot": "kebab:case", "value": "verbatim", "sourceSpan": "context with value inside", "unit": null, "confidence": 0.9 }
  ],
  "decisions": [
    { "text": "what was decided", "maker": "user|agent|both", "confidence": 0.9, "sourceSpan": "verbatim context" }
  ],
  "actions": [
    { "text": "what to do", "owner": "user|agent|unassigned", "deadline": null, "confidence": 0.8, "sourceSpan": "verbatim context" }
  ]
}

If nothing to emit, output: { "facts": [], "typedFacts": [], "decisions": [], "actions": [] }`;

const EXTRACT_SYSTEM_PROMPT_NATIVE = `You are a memory extraction assistant. Read the conversation chunk and extract three complementary kinds of information in a dense, model-native format optimized for token efficiency:

1. PROSE FACTS — compressed, token-efficient units. Drop articles, filler words, and redundant connectors. Abbreviate common words where meaning is preserved. Preserve exact entities (names, numbers, dates, IDs, paths, versions, URLs) verbatim. Use compact notation: e.g., "usr:morning_standups=9AM" instead of full sentences.
2. TYPED FACTS — verbatim precise values that must be remembered EXACTLY.
3. DECISIONS & ACTIONS — structured decisions reached and action items identified.

Rules (PROMPT_VERSION=9-NATIVE):
- IMPORTANCE: 0.0-1.0 score for retrieval ranking. User preferences/decisions/identity facts get 0.7+; one-off context 0.3-0.5; trivia 0.1-0.3.
- DEDUPKEY: stable kebab-case key like "user_preference:morning_standups".
- REASONING: one optional compressed sentence explaining WHY this fact is worth remembering across sessions.
- SIGNIFICANT: set to true when the user explicitly expresses intent to remember. Also true for safety-critical information or repeated facts. Default false.
- CERTAINTY: "confirmed" when the user directly stated or verified the fact; "tentative" for inferences, speculation, or single unverified observations; "instructional" for explicit directives about future behavior ("always X", "never Y"). Default "confirmed".
- SEMANTIC_ENTROPY: optional float 0.0–1.0 measuring the extractor's confidence that this fact is semantically coherent and well-supported by the source text. Higher = more confident (lower entropy). Default 1.0 when omitted.
- TYPED FACTS: emit only when a precise verbatim value appears. Each typed fact must include slot, value, sourceSpan, unit (or null), confidence. Skip when no verbatim values.
- DECISIONS: emit when a clear decision, conclusion, or agreement was reached. Each must have:
  - text: compressed description of what was decided.
  - maker: "user", "agent", or "both".
  - confidence: 0.0-1.0.
  - sourceSpan: verbatim context from conversation.
- ACTIONS: emit when a concrete task, follow-up, or action item is identified. Each must have:
  - text: compressed description of what needs to be done.
  - owner: "user", "agent", or "unassigned".
  - deadline: optional deadline or time context string, or null.
  - confidence: 0.0-1.0.
  - sourceSpan: verbatim context from conversation.
  Skip decisions/actions when none are present.

Emit strict JSON only, with no surrounding prose.

Schema:
{
  "facts": [
    { "text": "string", "importance": 0.0..1.0, "dedupKey": "kebab:case", "reasoning": "optional string", "significant": false, "certainty": "tentative|confirmed|instructional", "semantic_entropy": 1.0 }
  ],
  "typedFacts": [
    { "slot": "kebab:case", "value": "verbatim", "sourceSpan": "context with value inside", "unit": null, "confidence": 0.9 }
  ],
  "decisions": [
    { "text": "what was decided", "maker": "user|agent|both", "confidence": 0.9, "sourceSpan": "verbatim context" }
  ],
  "actions": [
    { "text": "what to do", "owner": "user|agent|unassigned", "deadline": null, "confidence": 0.8, "sourceSpan": "verbatim context" }
  ]
}

If nothing to emit, output: { "facts": [], "typedFacts": [], "decisions": [], "actions": [] }`;

export type ExtractedFact = {
  text: string;
  importance: number;
  dedupKey: string;
  /** Optional reasoning about why this fact matters. */
  reasoning?: string;
  /** When true, user expressed intent to remember or the fact is safety-critical. */
  significant?: boolean;
  /** Grounding strength; absent when the model omits it (treated as confirmed downstream). */
  certainty?: FactCertainty;
  /** Semantic-entropy confidence score (0–1). Higher = more confident / lower entropy. */
  semanticEntropy?: number;
};

export type ExtractedTypedFact = {
  slot: string;
  value: string;
  sourceSpan: string;
  unit: string | null;
  confidence: number;
};

export type ExtractResult = {
  facts: ExtractedFact[];
  typedFacts: ExtractedTypedFact[];
  decisions: ExtractedDecision[];
  actions: ExtractedActionItem[];
};

export type ExtractedDecision = {
  text: string;
  maker: string;
  confidence: number;
  sourceSpan: string;
};

export type ExtractedActionItem = {
  text: string;
  owner: string;
  deadline: string | null;
  confidence: number;
  sourceSpan: string;
};

export async function extractFacts(params: {
  messages: ReadonlyArray<AgentMessage>;
  caller: LlmCaller;
}): Promise<ExtractResult> {
  const userPrompt = buildExtractUserPrompt(params.messages);
  const raw = await params.caller({
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    userPrompt,
    thinking: false,
  });
  return parseExtractResponse(raw);
}

export async function extractFactsNative(params: {
  messages: ReadonlyArray<AgentMessage>;
  caller: LlmCaller;
}): Promise<ExtractResult> {
  const userPrompt = buildExtractUserPrompt(params.messages);
  const raw = await params.caller({
    systemPrompt: EXTRACT_SYSTEM_PROMPT_NATIVE,
    userPrompt,
    thinking: false,
  });
  return parseExtractResponse(raw);
}

export function parseExtractResponse(raw: string): ExtractResult {
  let parsed: unknown;
  try {
    parsed = parseJsonResponse(raw);
  } catch (e) {
    debugLog(`extract: JSON parse failed (${(e as Error).message}); raw=${summarizeRaw(raw)}`);
    return { facts: [], typedFacts: [], decisions: [], actions: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    debugLog(`extract: response not an object; raw=${summarizeRaw(raw)}`);
    return { facts: [], typedFacts: [], decisions: [], actions: [] };
  }
  const obj = parsed as {
    facts?: unknown;
    typedFacts?: unknown;
    decisions?: unknown;
    actions?: unknown;
  };
  if (
    !Array.isArray(obj.facts) &&
    !Array.isArray(obj.typedFacts) &&
    !Array.isArray(obj.decisions) &&
    !Array.isArray(obj.actions)
  ) {
    debugLog(`extract: response missing all arrays; raw=${summarizeRaw(raw)}`);
    return { facts: [], typedFacts: [], decisions: [], actions: [] };
  }
  return {
    facts: Array.isArray(obj.facts) ? normalizeFacts(obj.facts) : [],
    typedFacts: Array.isArray(obj.typedFacts) ? normalizeTypedFacts(obj.typedFacts) : [],
    decisions: Array.isArray(obj.decisions) ? normalizeDecisions(obj.decisions) : [],
    actions: Array.isArray(obj.actions) ? normalizeActions(obj.actions) : [],
  };
}

// Gated on OPENCLAW_MEMORY_L3_DEBUG=1 to keep tests quiet by default; when on,
// surfaces silent extraction failures to stderr so we never lose another
// session's worth of facts to a parse error nobody saw.
function debugLog(message: string): void {
  if (process.env.OPENCLAW_MEMORY_L3_DEBUG === "1") {
    console.warn(`[memory-l3] ${message}`);
  }
}

function summarizeRaw(raw: string, limit = 160): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

export function parseJsonResponse(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json|javascript)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function normalizeFacts(facts: ReadonlyArray<unknown>): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  for (const candidate of facts) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const o = candidate as Record<string, unknown>;
    // GLM-5.1 inconsistently emits the prose field as "text", "fact", or
    // "content" depending on phase of the moon. Accept any of them; the
    // schema prompt asks for "text" but parser tolerance prevents silent
    // fact loss. Same for dedupKey vs key vs id.
    const textRaw =
      typeof o.text === "string"
        ? o.text
        : typeof o.fact === "string"
          ? o.fact
          : typeof o.content === "string"
            ? o.content
            : null;
    const dedupRaw =
      typeof o.dedupKey === "string" ? o.dedupKey : typeof o.key === "string" ? o.key : null;
    if (textRaw === null || dedupRaw === null) {
      continue;
    }
    const text = textRaw.trim();
    const dedupKey = dedupRaw.trim();
    if (text.length === 0 || dedupKey.length === 0) {
      continue;
    }
    const importanceRaw = typeof o.importance === "number" ? o.importance : 0.5;
    out.push({
      text,
      importance: Math.max(0, Math.min(1, importanceRaw)),
      dedupKey,
      reasoning:
        typeof o.reasoning === "string" && o.reasoning.trim().length > 0
          ? o.reasoning.trim()
          : undefined,
      significant: o.significant === true ? true : undefined,
      certainty: normalizeCertainty(o.certainty),
      semanticEntropy: normalizeSemanticEntropy(o.semantic_entropy ?? o.semanticEntropy),
    });
  }
  return out;
}

function normalizeCertainty(value: unknown): FactCertainty | undefined {
  return value === "tentative" || value === "confirmed" || value === "instructional"
    ? value
    : undefined;
}

function normalizeSemanticEntropy(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  const clamped = Math.max(0, Math.min(1, value));
  return clamped;
}

function normalizeTypedFacts(facts: ReadonlyArray<unknown>): ExtractedTypedFact[] {
  const out: ExtractedTypedFact[] = [];
  for (const candidate of facts) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const o = candidate as Record<string, unknown>;
    // Same field-name tolerance pattern as normalizeFacts: accept common
    // synonyms the model emits when it drifts from the schema. "span" is a
    // common alternate to "sourceSpan".
    const slotRaw = typeof o.slot === "string" ? o.slot : typeof o.key === "string" ? o.key : null;
    const valueRaw = typeof o.value === "string" ? o.value : null;
    const spanRaw =
      typeof o.sourceSpan === "string"
        ? o.sourceSpan
        : typeof o.span === "string"
          ? o.span
          : typeof o.source === "string"
            ? o.source
            : null;
    if (slotRaw === null || valueRaw === null || spanRaw === null) {
      continue;
    }
    const slot = slotRaw.trim();
    if (slot.length === 0 || valueRaw.length === 0 || spanRaw.length === 0) {
      continue;
    }
    const confidenceRaw = typeof o.confidence === "number" ? o.confidence : 0.5;
    const unit = typeof o.unit === "string" && o.unit.trim().length > 0 ? o.unit.trim() : null;
    out.push({
      slot,
      value: valueRaw,
      sourceSpan: spanRaw,
      unit,
      confidence: Math.max(0, Math.min(1, confidenceRaw)),
    });
  }
  return out;
}

function normalizeDecisions(items: ReadonlyArray<unknown>): ExtractedDecision[] {
  const out: ExtractedDecision[] = [];
  for (const candidate of items) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const o = candidate as Record<string, unknown>;
    const textRaw =
      typeof o.text === "string"
        ? o.text
        : typeof o.decision === "string"
          ? o.decision
          : typeof o.content === "string"
            ? o.content
            : null;
    const spanRaw =
      typeof o.sourceSpan === "string"
        ? o.sourceSpan
        : typeof o.span === "string"
          ? o.span
          : typeof o.source === "string"
            ? o.source
            : null;
    if (textRaw === null || spanRaw === null) {
      continue;
    }
    const text = textRaw.trim();
    if (text.length === 0 || spanRaw.length === 0) {
      continue;
    }
    const makerRaw =
      typeof o.maker === "string" ? o.maker : typeof o.who === "string" ? o.who : "unknown";
    const confidenceRaw = typeof o.confidence === "number" ? o.confidence : 0.5;
    out.push({
      text,
      maker: makerRaw.trim().toLowerCase(),
      confidence: Math.max(0, Math.min(1, confidenceRaw)),
      sourceSpan: spanRaw,
    });
  }
  return out;
}

function normalizeActions(items: ReadonlyArray<unknown>): ExtractedActionItem[] {
  const out: ExtractedActionItem[] = [];
  for (const candidate of items) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const o = candidate as Record<string, unknown>;
    const textRaw =
      typeof o.text === "string"
        ? o.text
        : typeof o.action === "string"
          ? o.action
          : typeof o.content === "string"
            ? o.content
            : null;
    const spanRaw =
      typeof o.sourceSpan === "string"
        ? o.sourceSpan
        : typeof o.span === "string"
          ? o.span
          : typeof o.source === "string"
            ? o.source
            : null;
    if (textRaw === null || spanRaw === null) {
      continue;
    }
    const text = textRaw.trim();
    if (text.length === 0 || spanRaw.length === 0) {
      continue;
    }
    const ownerRaw =
      typeof o.owner === "string"
        ? o.owner
        : typeof o.assignee === "string"
          ? o.assignee
          : "unassigned";
    const deadlineRaw =
      typeof o.deadline === "string" && o.deadline.trim().length > 0 ? o.deadline.trim() : null;
    const confidenceRaw = typeof o.confidence === "number" ? o.confidence : 0.5;
    out.push({
      text,
      owner: ownerRaw.trim().toLowerCase(),
      deadline: deadlineRaw,
      confidence: Math.max(0, Math.min(1, confidenceRaw)),
      sourceSpan: spanRaw,
    });
  }
  return out;
}

/**
 * Format the same transcript string the LLM sees in the user prompt, so
 * grounding can verify typed-fact spans against the exact text that was
 * shown to the model.
 */
export function formatTranscriptForPrompt(messages: ReadonlyArray<AgentMessage>): string {
  return messages
    .map(formatMessageForPrompt)
    .filter((s) => s.length > 0)
    .join("\n");
}

function buildExtractUserPrompt(messages: ReadonlyArray<AgentMessage>): string {
  const transcript = formatTranscriptForPrompt(messages);
  return `<conversation>\n${transcript}\n</conversation>\n\nExtract new facts following the rules.`;
}

function formatMessageForPrompt(message: AgentMessage): string {
  const m = message as { role?: string; content?: unknown };
  const text = stringifyContent(m.content);
  if (!m.role || text.length === 0) {
    return "";
  }
  return `${m.role}: ${text}`;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as { type?: string; text?: string; thinking?: string };
    if (typeof b.text === "string") {
      parts.push(b.text);
    } else if (typeof b.thinking === "string") {
      parts.push(`[thinking] ${b.thinking}`);
    }
  }
  return parts.join("\n");
}
