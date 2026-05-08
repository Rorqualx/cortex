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

// PROMPT_VERSION = 3 — drops the in-prompt already-known list. v2 sent the
// recent dedup keys to the LLM with a "skip silently" rule; on long inputs
// with 20+ keys, GLM-5.1 over-applied the rule and returned {"facts": []}
// for content that genuinely contained new facts (verified via
// scripts/replay-compaction.mjs A/B test). Dedup now happens post-hoc via
// dropAlreadyKnown in dedup.ts — the LLM never sees the suppression list.
const EXTRACT_SYSTEM_PROMPT = `You are a memory extraction assistant. Read the conversation chunk and extract distilled facts — durable units of information that should be remembered across future sessions.

Rules (PROMPT_VERSION=3):
- IMPORTANCE: a 0.0-1.0 score for retrieval ranking. User preferences/decisions/identity facts get 0.7+; one-off context details 0.3-0.5; trivia 0.1-0.3.
- DEDUPKEY: a stable kebab-case key like "user_preference:morning_standups" so future runs can detect duplicates.

Emit strict JSON only, with no surrounding prose. Schema:
{ "facts": [ { "text": "string", "importance": 0.0..1.0, "dedupKey": "kebab:case" } ] }

If no new facts to emit, output: { "facts": [] }`;

export type ExtractedFact = {
  text: string;
  importance: number;
  dedupKey: string;
};

export async function extractFacts(params: {
  messages: ReadonlyArray<AgentMessage>;
  caller: LlmCaller;
}): Promise<ExtractedFact[]> {
  const userPrompt = buildExtractUserPrompt(params.messages);
  const raw = await params.caller({
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    userPrompt,
    thinking: false,
  });
  return parseExtractResponse(raw);
}

export function parseExtractResponse(raw: string): ExtractedFact[] {
  let parsed: unknown;
  try {
    parsed = parseJsonResponse(raw);
  } catch (e) {
    debugLog(`extract: JSON parse failed (${(e as Error).message}); raw=${summarizeRaw(raw)}`);
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { facts?: unknown }).facts)
  ) {
    debugLog(`extract: response missing "facts" array; raw=${summarizeRaw(raw)}`);
    return [];
  }
  return normalizeFacts(parsed);
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

function normalizeFacts(parsed: unknown): ExtractedFact[] {
  if (!parsed || typeof parsed !== "object" || !("facts" in parsed)) {
    return [];
  }
  const facts = (parsed as { facts: unknown }).facts;
  if (!Array.isArray(facts)) {
    return [];
  }
  const out: ExtractedFact[] = [];
  for (const candidate of facts) {
    if (!candidate || typeof candidate !== "object") continue;
    const o = candidate as Record<string, unknown>;
    if (typeof o.text !== "string" || typeof o.dedupKey !== "string") continue;
    const importanceRaw = typeof o.importance === "number" ? o.importance : 0.5;
    const text = o.text.trim();
    const dedupKey = o.dedupKey.trim();
    if (text.length === 0 || dedupKey.length === 0) continue;
    out.push({
      text,
      importance: Math.max(0, Math.min(1, importanceRaw)),
      dedupKey,
    });
  }
  return out;
}

function buildExtractUserPrompt(messages: ReadonlyArray<AgentMessage>): string {
  const transcript = messages
    .map(formatMessageForPrompt)
    .filter((s) => s.length > 0)
    .join("\n");
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
