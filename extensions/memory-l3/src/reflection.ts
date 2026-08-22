/**
 * G1 generative reflection: the depth-of-encoding mechanism L3 was missing.
 *
 * Periodically the reflector reads the agent's top facts and asks the LLM to
 * synthesize a few HIGHER-ORDER insights — generalizations/patterns that follow
 * from combining facts but are stated in none of them (Generative Agents,
 * arXiv:2304.03442). Each insight is provenance-grounded: it must cite real
 * source dedupKeys, and citations that don't resolve are dropped — the
 * generative analogue of typed-fact source-grounding, so the reflector can't
 * invent links. Insights live in their own tier and are injected by retrieval.
 */
import { randomUUID } from "node:crypto";
import { type LlmCaller, parseJsonResponse } from "./llm.js";
import type { Storage } from "./storage.js";
import type { Insight } from "./types.js";

export type ReflectionConfig = {
  /** Master switch. Default false — reflection is a measured, opt-in pass. */
  enabled: boolean;
  /** Max top-importance facts fed to the reflector. */
  maxFacts: number;
  /** Max insights accepted per pass. */
  maxInsights: number;
  /** Cap on total stored insights; lowest-importance evicted past this. */
  maxStored: number;
};

export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  enabled: false,
  maxFacts: 30,
  maxInsights: 5,
  maxStored: 50,
};

const REFLECTION_SYSTEM_PROMPT = `You are a memory reflection module. Given remembered facts (each prefixed with a KEY), synthesize HIGHER-ORDER INSIGHTS: durable generalizations, patterns, preferences, or conclusions that follow from combining several facts but are NOT stated in any single one.

Rules:
- Emit AT MOST {MAX} insights. Fewer is better. Only emit when an insight genuinely abstracts across multiple facts.
- Each insight MUST cite the KEYS of the facts it draws on (2+ keys preferred). Use the exact KEY strings.
- Never restate a single fact. Never invent facts not supported by the inputs.
- Preserve dates and times verbatim; do not abbreviate or drop temporal expressions from the input facts — temporal anchors drive later retrieval.
- importance is 0..1: how durable/useful the insight is.

Output strict JSON only, no prose:
{ "insights": [ { "text": "string", "sources": ["key-a", "key-b"], "importance": 0.7 } ] }
If nothing is worth abstracting, output { "insights": [] }`;

export function buildReflectionUserPrompt(
  facts: ReadonlyArray<{ dedupKey: string; text: string }>,
): string {
  const lines = facts.map((f) => `- [${f.dedupKey}] ${f.text}`).join("\n");
  return `<facts>\n${lines}\n</facts>\n\nSynthesize higher-order insights following the rules.`;
}

type RawInsight = { text: string; sources: string[]; importance: number };

function normalizeInsights(parsed: unknown): RawInsight[] {
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const arr = (parsed as { insights?: unknown }).insights;
  if (!Array.isArray(arr)) {
    return [];
  }
  const out: RawInsight[] = [];
  for (const candidate of arr) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const o = candidate as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : null;
    const sources = Array.isArray(o.sources)
      ? o.sources.filter((s): s is string => typeof s === "string")
      : [];
    if (!text || sources.length === 0) {
      continue;
    }
    const importance =
      typeof o.importance === "number" ? Math.max(0, Math.min(1, o.importance)) : 0.6;
    out.push({ text, sources, importance });
  }
  return out;
}

/**
 * Generate provenance-grounded insights from a fact set. Insights whose cited
 * sources don't resolve to an input dedupKey are dropped (hallucinated links);
 * surviving insights keep only their grounded sources.
 */
export async function generateInsights(params: {
  facts: ReadonlyArray<{ dedupKey: string; text: string }>;
  caller: LlmCaller;
  now: number;
  maxInsights: number;
}): Promise<Insight[]> {
  if (params.facts.length < 2) {
    return [];
  }
  const validKeys = new Set(params.facts.map((f) => f.dedupKey));
  const raw = await params.caller({
    systemPrompt: REFLECTION_SYSTEM_PROMPT.replace("{MAX}", String(params.maxInsights)),
    userPrompt: buildReflectionUserPrompt(params.facts),
    thinking: false,
  });
  let parsed: unknown;
  try {
    parsed = parseJsonResponse(raw);
  } catch {
    return [];
  }
  const insights: Insight[] = [];
  for (const r of normalizeInsights(parsed)) {
    const groundedSources = r.sources.filter((s) => validKeys.has(s));
    if (groundedSources.length === 0) {
      continue; // provenance unverifiable — drop
    }
    insights.push({
      id: `insight-${randomUUID().slice(0, 8)}`,
      text: r.text,
      sources: groundedSources,
      importance: r.importance,
      createdAt: params.now,
    });
    if (insights.length >= params.maxInsights) {
      break;
    }
  }
  return insights;
}

/**
 * Read top facts, generate insights, and merge into the stored insight tier
 * (capped; lowest-importance evicted). Dedups by normalized text so repeated
 * passes don't pile up duplicates. No-op when disabled or too few facts.
 */
export async function reflectAndStore(params: {
  storage: Storage;
  caller: LlmCaller;
  agentId: string | null;
  now: number;
  config?: ReflectionConfig;
}): Promise<{ added: number; total: number }> {
  const config = params.config ?? DEFAULT_REFLECTION_CONFIG;
  if (!config.enabled) {
    return { added: 0, total: 0 };
  }
  const longterm = await params.storage.readLongTerm();
  const active = longterm.facts.filter((f) => !f.archived && !f.supersededBy);
  if (active.length < 2) {
    return { added: 0, total: 0 };
  }
  const topFacts = [...active]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, config.maxFacts)
    .map((f) => ({ dedupKey: f.dedupKey, text: f.text }));
  const fresh = await generateInsights({
    facts: topFacts,
    caller: params.caller,
    now: params.now,
    maxInsights: config.maxInsights,
  });

  const store = await params.storage.readInsights();
  if (fresh.length === 0) {
    return { added: 0, total: store.insights.length };
  }
  const seen = new Set(store.insights.map((i) => i.text.trim().toLowerCase()));
  const added: Insight[] = [];
  for (const ins of fresh) {
    const key = ins.text.trim().toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    added.push(ins);
  }
  const merged = [...store.insights, ...added]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, config.maxStored);
  await params.storage.writeInsights({
    version: 1,
    agentId: params.agentId,
    lastReflectedAt: params.now,
    insights: merged,
  });
  return { added: added.length, total: merged.length };
}
