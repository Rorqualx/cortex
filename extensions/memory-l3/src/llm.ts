import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

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
};

export const DEFAULT_GLM_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const DEFAULT_GLM_MODEL = "glm-5.1";

export function createGlmCaller(config: GlmCallerConfig): LlmCaller {
  const fetchImpl = config.fetchImpl ?? fetch;
  return async ({ systemPrompt, userPrompt, thinking }) => {
    const baseUrl = config.baseUrl ?? DEFAULT_GLM_BASE_URL;
    const body: Record<string, unknown> = {
      model: config.model ?? DEFAULT_GLM_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    };
    if (thinking !== undefined) {
      body.thinking = { type: thinking ? "enabled" : "disabled" };
    }
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GLM call failed: ${response.status} ${text}`);
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? "";
  };
}

// PROMPT_VERSION = 4 — co-emits prose facts AND verbatim typed facts in a
// single LLM call (Mem0/HippoRAG2 pattern). Prose facts are LLM-distilled
// (right brain); typed facts are exact-string values that must pass regex
// source-grounding (left brain) before they hit storage. v3's drop-the-
// already-known-list change is preserved as the prose-fact rule set; v4
// adds the typed-fact schema alongside.
const EXTRACT_SYSTEM_PROMPT = `You are a memory extraction assistant. Read the conversation chunk and extract two complementary kinds of facts:

1. PROSE FACTS — durable LLM-distilled units of information for future recall.
2. TYPED FACTS — verbatim precise values that must be remembered EXACTLY (numbers, IDs, dates, phone numbers, IP addresses, file paths, version strings, URLs, currency amounts).

Rules (PROMPT_VERSION=4):
- IMPORTANCE: 0.0-1.0 score for retrieval ranking. User preferences/decisions/identity facts get 0.7+; one-off context 0.3-0.5; trivia 0.1-0.3.
- DEDUPKEY: stable kebab-case key like "user_preference:morning_standups".
- TYPED FACTS: emit only when a precise verbatim value appears in the conversation. Each typed fact must include:
  - slot: kebab-case scoped name like "user:phone" or "infra:pi_hole_ip" or "release:version".
  - value: the EXACT substring from the conversation, character-for-character (case- and whitespace-sensitive).
  - sourceSpan: surrounding context (15-200 chars) containing value, copied verbatim from the conversation.
  - unit: optional unit ("USD", "MB", "v", etc) or null.
  - confidence: 0.0-1.0.
  Skip typedFacts emission when no verbatim values are present.

Emit strict JSON only, with no surrounding prose. Use EXACTLY the field names below — do NOT rename "text" to "fact"/"content" or "dedupKey" to "key"/"id".

Schema:
{
  "facts": [
    { "text": "string", "importance": 0.0..1.0, "dedupKey": "kebab:case" }
  ],
  "typedFacts": [
    { "slot": "kebab:case", "value": "verbatim", "sourceSpan": "context with value inside", "unit": null, "confidence": 0.9 }
  ]
}

If nothing to emit, output: { "facts": [], "typedFacts": [] }`;

export type ExtractedFact = {
  text: string;
  importance: number;
  dedupKey: string;
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

export function parseExtractResponse(raw: string): ExtractResult {
  let parsed: unknown;
  try {
    parsed = parseJsonResponse(raw);
  } catch (e) {
    debugLog(`extract: JSON parse failed (${(e as Error).message}); raw=${summarizeRaw(raw)}`);
    return { facts: [], typedFacts: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    debugLog(`extract: response not an object; raw=${summarizeRaw(raw)}`);
    return { facts: [], typedFacts: [] };
  }
  const obj = parsed as { facts?: unknown; typedFacts?: unknown };
  if (!Array.isArray(obj.facts) && !Array.isArray(obj.typedFacts)) {
    debugLog(
      `extract: response missing both "facts" and "typedFacts" arrays; raw=${summarizeRaw(raw)}`,
    );
    return { facts: [], typedFacts: [] };
  }
  return {
    facts: Array.isArray(obj.facts) ? normalizeFacts(obj.facts) : [],
    typedFacts: Array.isArray(obj.typedFacts) ? normalizeTypedFacts(obj.typedFacts) : [],
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
    if (!candidate || typeof candidate !== "object") continue;
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
    if (textRaw === null || dedupRaw === null) continue;
    const text = textRaw.trim();
    const dedupKey = dedupRaw.trim();
    if (text.length === 0 || dedupKey.length === 0) continue;
    const importanceRaw = typeof o.importance === "number" ? o.importance : 0.5;
    out.push({
      text,
      importance: Math.max(0, Math.min(1, importanceRaw)),
      dedupKey,
    });
  }
  return out;
}

function normalizeTypedFacts(facts: ReadonlyArray<unknown>): ExtractedTypedFact[] {
  const out: ExtractedTypedFact[] = [];
  for (const candidate of facts) {
    if (!candidate || typeof candidate !== "object") continue;
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
    if (slotRaw === null || valueRaw === null || spanRaw === null) continue;
    const slot = slotRaw.trim();
    if (slot.length === 0 || valueRaw.length === 0 || spanRaw.length === 0) continue;
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
  if (!m.role || text.length === 0) return "";
  return `${m.role}: ${text}`;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; thinking?: string };
    if (typeof b.text === "string") parts.push(b.text);
    else if (typeof b.thinking === "string") parts.push(`[thinking] ${b.thinking}`);
  }
  return parts.join("\n");
}
