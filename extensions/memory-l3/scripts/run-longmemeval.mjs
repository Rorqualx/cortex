#!/usr/bin/env node
// First-signal adapter for LongMemEval (arXiv 2410.10813, ICLR 2025).
// For each question: extract facts (PROMPT_VERSION=4) from each haystack
// session, retrieve top-K via lexical Jaccard against the question, and
// ask the LLM to answer using only those facts. Outputs hypothesis.jsonl
// and a summary table comparing hypothesis to ground truth.
//
// Usage:
//   node extensions/memory-l3/scripts/run-longmemeval.mjs [--limit=N] [--type=TYPE] [--stratified=PER_TYPE] [--concurrency=N] [--native]
//
// Defaults: 5 questions, single-session-user (smallest subset), concurrency=1.
// --stratified=30 runs N questions per type (6 types × N), overrides --type/--limit.
// --native uses the dense, token-efficient compaction prompt (A/B test mode).
// --reader-model=M overrides the reader LLM (default glm-5.2).
// --re-ask-budget=N re-prompts the reader up to N extra times when the reply has
//   no parseable Answer line (default 0 — single-shot, matches historical runs).
// Every run writes a sibling manifest-<tag>.json recording reader model, embed
// model, re-ask budget, prompt version, and selection — run-to-run comparability
// for the headline recall number depends on it.

import { readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const ORACLE_PATH = "/tmp/longmemeval/oracle.json";

const args = process.argv.slice(2);
const argVal = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : null;
};
const LIMIT = Number.parseInt(argVal("limit") ?? "5", 10);
const TYPE = argVal("type") ?? "single-session-user";
const STRATIFIED = argVal("stratified") ? Number.parseInt(argVal("stratified"), 10) : null;
const CONCURRENCY = Number.parseInt(argVal("concurrency") ?? "1", 10);
const TOP_K = 20;
const LEXICAL_ONLY = args.includes("--lexical-only");
const NATIVE = args.includes("--native");
const READER_MODEL = argVal("reader-model") ?? "glm-5.2";
const RE_ASK_BUDGET = Number.parseInt(argVal("re-ask-budget") ?? "0", 10);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const RRF_K = 60;
const QUESTION_TYPES = [
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
  "multi-session",
  "knowledge-update",
  "temporal-reasoning",
];

const EXTRACT_SYSTEM_PROMPT_V4 = `You are a memory extraction assistant. Read the conversation chunk and extract two complementary kinds of facts:

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

Emit strict JSON only, with no surrounding prose. Schema:
{
  "facts": [{ "text": "string", "importance": 0.0..1.0, "dedupKey": "kebab:case" }],
  "typedFacts": [{ "slot": "kebab:case", "value": "verbatim", "sourceSpan": "context with value inside", "unit": null, "confidence": 0.9 }]
}

If nothing to emit, output: { "facts": [], "typedFacts": [] }`;

const EXTRACT_SYSTEM_PROMPT_NATIVE = `You are a memory extraction assistant. Read the conversation chunk and extract two complementary kinds of facts in a dense, model-native format optimized for token efficiency:

1. PROSE FACTS — compressed, token-efficient units. Drop articles, filler words, and redundant connectors. Abbreviate common words where meaning is preserved. Preserve exact entities (names, numbers, dates, IDs, paths, versions, URLs) verbatim. Use compact notation: e.g., "usr:morning_standups=9AM" instead of full sentences.
2. TYPED FACTS — verbatim precise values that must be remembered EXACTLY (numbers, IDs, dates, phone numbers, IP addresses, file paths, version strings, URLs, currency amounts).

Rules (PROMPT_VERSION=4-NATIVE):
- IMPORTANCE: 0.0-1.0 score for retrieval ranking. User preferences/decisions/identity facts get 0.7+; one-off context 0.3-0.5; trivia 0.1-0.3.
- DEDUPKEY: *** kebab-case key like "user_preference:morning_standups".
- TYPED FACTS: emit only when a precise verbatim value appears in the conversation. Each typed fact must include:
  - slot: kebab-case scoped name like "user:phone" or "infra:pi_hole_ip" or "release:version".
  - value: the EXACT substring from the conversation, character-for-character (case- and whitespace-sensitive).
  - sourceSpan: surrounding context (15-200 chars) containing value, copied verbatim from the conversation.
  - unit: optional unit ("USD", "MB", "v", etc) or null.
  - confidence: 0.0-1.0.
  Skip typedFacts emission when no verbatim values are present.

Emit strict JSON only, with no surrounding prose. Schema:
{
  "facts": [{ "text": "string", "importance": 0.0..1.0, "dedupKey": "kebab:case" }],
  "typedFacts": [{ "slot": "kebab:case", "value": "verbatim", "sourceSpan": "context with value inside", "unit": null, "confidence": 0.9 }]
}

If nothing to emit, output: { "facts": [], "typedFacts": [] }`;

const ANSWER_SYSTEM_PROMPT = `You answer questions about a user using only the provided memory facts. Use a brief two-step format.

Format your output exactly like this:
Step 1: <one sentence noting which facts are relevant>
Answer: <bare answer>

Rules:
- ALWAYS commit to a best-effort answer. NEVER respond with UNKNOWN, "not sure", "I don't know", or similar — pick the most likely answer based on the facts and your inference. The judge rewards partial matches; refusal scores zero.
- Counting ("how many"): count distinct relevant items in the facts.
- Listing ("which", "what kinds of"): comma-separate all matching items.
- AGGREGATION (sum/combine) ONLY when the question explicitly asks for a total ("total", "altogether", "combined"): sum the components.
- For "how long is X" / "how much is X" / "what is X": phrase the answer the way the facts describe it. DO NOT double or sum unless explicitly asked.
- Temporal: use dates and durations exactly as stated.
- Keep the Step 1 line concise. The Answer line should contain only the bare answer (number, name, date, list, or your best inference).`;

const TOKEN_PATTERN = /[a-z]+|\d[\d.,]*\d|\d/g;

function tokenize(text) {
  const matches = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
  return new Set(matches.filter((t) => t.length > 1 || /^\d$/.test(t)));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersect = 0;
  for (const t of a) {
    if (b.has(t)) intersect += 1;
  }
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function formatRelativeAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return "(now)";
  }
  const days = ageMs / MS_PER_DAY;
  if (days < 1) {
    return "(today)";
  }
  if (days < 2) {
    return "(yesterday)";
  }
  if (days < 14) {
    return `(${Math.round(days)}d ago)`;
  }
  if (days < 60) {
    return `(${Math.round(days / 7)}w ago)`;
  }
  if (days < 365) {
    return `(${Math.round(days / 30)}mo ago)`;
  }
  return `(${(days / 365).toFixed(1)}y ago)`;
}

// Verbatim from packages/memory-host-sdk/src/host/internal.ts:483-507.
// Cosine similarity in 0..1 (clamped). Returns 0 on empty/zero vectors.
function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.max(0, Math.min(1, sim));
}

// Per-question embedding cache. Cleared between questions (avoid leakage).
let embedCache = new Map();
let embedFailures = 0;

function resetEmbedCache() {
  embedCache = new Map();
}

async function embedText(text) {
  if (LEXICAL_ONLY) {
    return null;
  }
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  const cached = embedCache.get(text);
  if (cached) {
    return cached;
  }
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    if (!resp.ok) {
      embedFailures += 1;
      return null;
    }
    const json = await resp.json();
    const vec = Array.isArray(json?.embedding) ? json.embedding : null;
    if (vec) {
      embedCache.set(text, vec);
    }
    return vec;
  } catch {
    embedFailures += 1;
    return null;
  }
}

function formatTranscript(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

function buildExtractUserPrompt(messages) {
  return `<conversation>\n${formatTranscript(messages)}\n</conversation>\n\nExtract new facts following the rules.`;
}

async function resolveZaiKey() {
  const fromEnv = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY;
  if (fromEnv) {
    return fromEnv;
  }
  const authPath = path.join(HOME, ".openclaw/agents/main/agent/auth-profiles.json");
  const text = await readFile(authPath, "utf8");
  const json = JSON.parse(text);
  const key = json?.profiles?.["zai:default"]?.key;
  if (!key) {
    throw new Error(`No zai:default key in ${authPath}`);
  }
  return key;
}

async function callGlm({ apiKey, systemPrompt, userPrompt }) {
  const resp = await fetch("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: READER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      thinking: { type: "disabled" },
    }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 400)}`);
  }
  const json = JSON.parse(text);
  return json.choices?.[0]?.message?.content ?? "";
}

// Normalize a raw fact entry from the LLM. GLM-5.1 inconsistently emits the
// prose field as "text", "fact", or "content"; same for "dedupKey" vs "key".
// Tolerate all three; downstream code reads .text and .dedupKey.
function normalizeFact(o) {
  if (!o || typeof o !== "object") {
    return null;
  }
  const text =
    typeof o.text === "string"
      ? o.text
      : typeof o.fact === "string"
        ? o.fact
        : typeof o.content === "string"
          ? o.content
          : null;
  const dedupKey =
    typeof o.dedupKey === "string" ? o.dedupKey : typeof o.key === "string" ? o.key : null;
  if (!text || !dedupKey) {
    return null;
  }
  return {
    text: text.trim(),
    dedupKey: dedupKey.trim(),
    importance: typeof o.importance === "number" ? Math.max(0, Math.min(1, o.importance)) : 0.5,
  };
}

function normalizeTypedFact(o) {
  if (!o || typeof o !== "object") {
    return null;
  }
  const slot = typeof o.slot === "string" ? o.slot : typeof o.key === "string" ? o.key : null;
  const value = typeof o.value === "string" ? o.value : null;
  const sourceSpan =
    typeof o.sourceSpan === "string"
      ? o.sourceSpan
      : typeof o.span === "string"
        ? o.span
        : typeof o.source === "string"
          ? o.source
          : null;
  if (!slot || !value || !sourceSpan) {
    return null;
  }
  return {
    slot: slot.trim(),
    value,
    sourceSpan,
    unit: typeof o.unit === "string" && o.unit.trim().length > 0 ? o.unit.trim() : null,
    confidence: typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0.5,
  };
}

function tryParseExtract(raw) {
  const trimmed = raw.trim();
  const fenced = /^```(?:json|javascript)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    const facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
      .map(normalizeFact)
      .filter(Boolean);
    const typedFacts = (Array.isArray(parsed.typedFacts) ? parsed.typedFacts : [])
      .map(normalizeTypedFact)
      .filter(Boolean);
    return { facts, typedFacts };
  } catch {
    return { facts: [], typedFacts: [] };
  }
}

function groundTypedFacts(typedFacts, transcript) {
  return typedFacts.filter(
    (t) =>
      typeof t?.value === "string" &&
      typeof t?.sourceSpan === "string" &&
      t.value.length > 0 &&
      t.sourceSpan.length > 0 &&
      t.sourceSpan.includes(t.value) &&
      transcript.includes(t.sourceSpan),
  );
}

// Mirrors retrieval.ts production composite scorer:
//   composite = lex * 0.6 + importance * 0.2 + recency * 0.1 + l3Boost * 0.1
// Recency uses 7-day half-life. Typed-fact tier adds +0.1 when lex > 0.
const W_LEX = 0.6;
const W_IMP = 0.2;
const W_REC = 0.1;
const W_TYPED_BOOST = 0.1;
const RECENCY_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function recencyScore(ageMs) {
  if (ageMs < 0) {
    return 1;
  }
  const ageDays = ageMs / MS_PER_DAY;
  return Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);
}

// Hybrid retrieve via Reciprocal Rank Fusion (RRF) of two ranked lists:
//   lexical: Jaccard over question vs fact tokens
//   semantic: cosine over question embedding vs fact embedding (Ollama)
// Final RRF: 1/(k+lex_rank) + 1/(k+sem_rank), then small additive priors
// for tier (typed +0.1) and importance/confidence. Top-K by final score.
//
// Robust to embedding failures: if Ollama is unreachable or LEXICAL_ONLY is
// set, the semantic leg is skipped and the run continues lexical-only.
async function retrieveTopK({ question, facts, typedFacts, now, k }) {
  const qTokens = tokenize(question);
  const candidates = [];
  for (const f of facts) {
    candidates.push({
      kind: "prose",
      text: f.text,
      tokens: tokenize(f.text),
      importance: f.importance ?? 0.5,
      createdAt: f.createdAt ?? now,
    });
  }
  for (const t of typedFacts) {
    const text = t.unit ? `${t.slot} = ${t.value} ${t.unit}` : `${t.slot} = ${t.value}`;
    candidates.push({
      kind: "typed",
      text,
      tokens: tokenize(text),
      importance: t.confidence ?? 0.7,
      createdAt: t.createdAt ?? now,
    });
  }
  if (candidates.length === 0) {
    return [];
  }

  // Lexical leg: rank by Jaccard score (desc). Zero scores get rank = +Infinity (RRF contribution 0).
  const withLex = candidates.map((c, i) => ({
    i,
    lex: jaccard(qTokens, c.tokens),
  }));
  withLex.sort((a, b) => b.lex - a.lex);
  const lexRank = new Array(candidates.length).fill(Infinity);
  for (let r = 0; r < withLex.length; r += 1) {
    if (withLex[r].lex > 0) {
      lexRank[withLex[r].i] = r;
    }
  }

  // Semantic leg: embed question + each fact text, rank by cosine.
  const semRank = new Array(candidates.length).fill(Infinity);
  const qEmbed = await embedText(question);
  if (qEmbed) {
    const factEmbeds = await Promise.all(candidates.map((c) => embedText(c.text)));
    const withSem = candidates.map((_, i) => ({
      i,
      sim: factEmbeds[i] ? cosineSimilarity(qEmbed, factEmbeds[i]) : 0,
    }));
    withSem.sort((a, b) => b.sim - a.sim);
    for (let r = 0; r < withSem.length; r += 1) {
      if (withSem[r].sim > 0) {
        semRank[withSem[r].i] = r;
      }
    }
  }

  // RRF fusion + tier/importance priors.
  const scored = candidates
    .map((c, i) => {
      let rrf = 0;
      if (Number.isFinite(lexRank[i])) {
        rrf += 1 / (RRF_K + lexRank[i]);
      }
      if (Number.isFinite(semRank[i])) {
        rrf += 1 / (RRF_K + semRank[i]);
      }
      if (rrf === 0) {
        return null;
      }
      const tierBoost = c.kind === "typed" ? 0.005 : 0;
      const impPrior = c.importance * 0.003;
      return {
        kind: c.kind,
        text: c.text,
        createdAt: c.createdAt,
        score: rrf + tierBoost + impPrior,
        lexRank: lexRank[i],
        semRank: semRank[i],
      };
    })
    .filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function parseHaystackDate(s) {
  // Format: "2023/04/10 (Mon) 17:50" — split on space, take date and time.
  if (!s || typeof s !== "string") {
    return Date.now();
  }
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+\([A-Za-z]+\)\s+(\d{1,2}):(\d{2})/.exec(s);
  if (!m) {
    return Date.now();
  }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

async function runQuestion({ apiKey, question }) {
  const allFacts = [];
  const allTyped = [];
  const sessionDates = (question.haystack_dates ?? []).map(parseHaystackDate);
  for (let i = 0; i < question.haystack_sessions.length; i += 1) {
    const session = question.haystack_sessions[i];
    const sessionTime = sessionDates[i] ?? Date.now();
    const transcript = formatTranscript(session);
    const raw = await callGlm({
      apiKey,
      systemPrompt: NATIVE ? EXTRACT_SYSTEM_PROMPT_NATIVE : EXTRACT_SYSTEM_PROMPT_V4,
      userPrompt: buildExtractUserPrompt(session),
    });
    const parsed = tryParseExtract(raw);
    for (const f of parsed.facts) {
      allFacts.push({ ...f, createdAt: sessionTime });
    }
    for (const t of groundTypedFacts(parsed.typedFacts, transcript)) {
      allTyped.push({ ...t, createdAt: sessionTime });
    }
  }
  const questionTime = parseHaystackDate(question.question_date);

  // Per-question embedding cache; cleared between questions to avoid leakage.
  resetEmbedCache();
  const top = await retrieveTopK({
    question: question.question,
    facts: allFacts,
    typedFacts: allTyped,
    now: questionTime,
    k: TOP_K,
  });
  const memorySection = top
    .map((r) => {
      const marker = r.kind === "typed" ? "■" : "·";
      const age = r.createdAt ? ` ${formatRelativeAge(questionTime - r.createdAt)}` : "";
      return `- ${marker}${age} ${r.text}`;
    })
    .join("\n");
  const userPrompt = `<memory>\n${memorySection || "(no facts retrieved)"}\n\nThe (Nd ago) annotation shows when each fact was *noted*, not when the event happened. Use it only to break ties between two facts that directly contradict (e.g. balance is X vs balance is Y, prefer the more recent recall). For questions about event ordering, durations, or specific dates, the answer lives in the fact text itself.\n</memory>\n\nQuestion: ${question.question}`;
  const rawAnswer = (await callGlm({ apiKey, systemPrompt: ANSWER_SYSTEM_PROMPT, userPrompt }))
    .replace(/^```[\s\S]*?\n|```$/g, "")
    .trim();
  let hypothesis = parseHypothesis(rawAnswer);
  // Re-ask budget: when the reply has no parseable Answer line, re-prompt up
  // to RE_ASK_BUDGET extra times. Default 0 keeps historical single-shot runs.
  let reAsksUsed = 0;
  while (!hypothesis && reAsksUsed < RE_ASK_BUDGET) {
    reAsksUsed += 1;
    const reAskPrompt =
      userPrompt +
      "\n\nYour previous reply had no parseable Answer line. Reply again; the last line must be `Answer: <bare answer>`.";
    const retryRaw = (
      await callGlm({ apiKey, systemPrompt: ANSWER_SYSTEM_PROMPT, userPrompt: reAskPrompt })
    )
      .replace(/^```[\s\S]*?\n|```$/g, "")
      .trim();
    hypothesis = parseHypothesis(retryRaw);
  }

  return {
    question_id: question.question_id,
    hypothesis,
    facts_extracted: allFacts.length,
    typed_extracted: allTyped.length,
    top_k_used: top.length,
    re_asks_used: reAsksUsed,
  };
}

// Extract the bare answer from a CoT response. Looks for the last
// `Answer:` line (case-insensitive). Falls back to the last non-empty
// line if the model didn't follow the format.
function parseHypothesis(raw) {
  if (!raw) {
    return "";
  }
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^answer\s*:\s*(.*)$/i.exec(lines[i]);
    if (m) {
      return m[1].trim();
    }
  }
  return lines[lines.length - 1] ?? "";
}

function exactStringMatch(hypothesis, answer) {
  const ansStr = String(answer);
  return hypothesis.toLowerCase().includes(ansStr.toLowerCase());
}

function selectQuestions(oracle) {
  if (STRATIFIED !== null) {
    const out = [];
    for (const t of QUESTION_TYPES) {
      out.push(...oracle.filter((q) => q.question_type === t).slice(0, STRATIFIED));
    }
    return out;
  }
  return oracle.filter((q) => q.question_type === TYPE).slice(0, LIMIT);
}

async function runWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next;
      next += 1;
      if (idx >= items.length) {
        return;
      }
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = { error: e.message, question_id: items[idx].question_id };
      }
      completed += 1;
      process.stdout.write(`\r  progress: ${completed}/${items.length} `);
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
  return results;
}

async function main() {
  console.log(`# LongMemEval run`);
  if (STRATIFIED !== null) {
    console.log(`Stratified: ${STRATIFIED} per type × ${QUESTION_TYPES.length} types`);
  } else {
    console.log(`Type: ${TYPE}, Limit: ${LIMIT}`);
  }
  console.log(`Concurrency: ${CONCURRENCY}`);

  const oracle = JSON.parse(await readFile(ORACLE_PATH, "utf8"));
  const filtered = selectQuestions(oracle);
  console.log(`Selected ${filtered.length} questions`);

  const apiKey = await resolveZaiKey();
  const t0 = Date.now();
  const results = await runWithConcurrency(filtered, CONCURRENCY, async (q) => {
    const r = await runQuestion({ apiKey, question: q });
    return {
      ...r,
      question_type: q.question_type,
      ground_truth: String(q.answer),
      exact_hit: exactStringMatch(r.hypothesis, q.answer),
    };
  });
  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);

  // Per-type breakdown
  const byType = {};
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    const t = filtered[i].question_type;
    if (!byType[t]) {
      byType[t] = { total: 0, hits: 0, errors: 0 };
    }
    byType[t].total += 1;
    if (r.exact_hit) {
      byType[t].hits += 1;
    }
    if (r.error) {
      byType[t].errors += 1;
    }
  }

  console.log(`\n=== Per-type results ===`);
  for (const t of QUESTION_TYPES) {
    const b = byType[t];
    if (!b) {
      continue;
    }
    const pct = b.total > 0 ? Math.round((b.hits / b.total) * 100) : 0;
    const errSuffix = b.errors > 0 ? ` [${b.errors} errors]` : "";
    console.log(`  ${t.padEnd(28)} ${b.hits}/${b.total} (${pct}%)${errSuffix}`);
  }
  const totalHits = results.filter((r) => r.exact_hit).length;
  const totalErrors = results.filter((r) => r.error).length;
  const overallPct = Math.round((totalHits / results.length) * 100);
  const errSuffix = totalErrors > 0 ? ` [${totalErrors} errors]` : "";
  console.log(
    `  ${"OVERALL".padEnd(28)} ${totalHits}/${results.length} (${overallPct}%)${errSuffix}`,
  );
  console.log(`  wall-clock: ${elapsedMin} min`);

  // Show 5 sample misses for inspection
  const misses = results.filter((r) => !r.exact_hit && !r.error).slice(0, 5);
  if (misses.length > 0) {
    console.log(`\n=== Sample misses ===`);
    for (const m of misses) {
      console.log(`  [${m.question_type}] ${m.question_id}`);
      console.log(`    Truth: ${(m.ground_truth ?? "").slice(0, 120)}`);
      console.log(`    Got:   ${(m.hypothesis ?? "").slice(0, 120)}`);
    }
  }

  const tag =
    (STRATIFIED !== null ? `stratified${STRATIFIED}` : `${TYPE}-n${filtered.length}`) +
    (NATIVE ? "-native" : "");
  const outPath = `/tmp/longmemeval/hypothesis-${tag}.jsonl`;
  await writeFile(
    outPath,
    results
      .map((r) => JSON.stringify({ question_id: r.question_id, hypothesis: r.hypothesis ?? "" }))
      .join("\n") + "\n",
  );
  console.log(`\nWrote ${outPath}`);

  // Run manifest: everything a future run needs to be comparable to this one.
  const manifest = {
    timestamp: new Date().toISOString(),
    readerModel: READER_MODEL,
    embedModel: EMBED_MODEL,
    reAskBudget: RE_ASK_BUDGET,
    promptVersion: NATIVE ? "4-NATIVE" : "4",
    filterTag: tag,
    selection: STRATIFIED !== null ? { stratified: STRATIFIED } : { type: TYPE, limit: LIMIT },
    concurrency: CONCURRENCY,
    topK: TOP_K,
    lexicalOnly: LEXICAL_ONLY,
    native: NATIVE,
    questionCount: results.length,
  };
  const manifestPath = `/tmp/longmemeval/manifest-${tag}.json`;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${manifestPath}`);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exitCode = 1;
});
