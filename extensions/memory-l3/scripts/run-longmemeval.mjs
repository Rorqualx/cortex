#!/usr/bin/env node
// First-signal adapter for LongMemEval (arXiv 2410.10813, ICLR 2025).
// For each question: extract facts (PROMPT_VERSION=4) from each haystack
// session, retrieve top-K via lexical Jaccard against the question, and
// ask the LLM to answer using only those facts. Outputs hypothesis.jsonl
// and a summary table comparing hypothesis to ground truth.
//
// Usage:
//   node extensions/memory-l3/scripts/run-longmemeval.mjs [--limit=N] [--type=TYPE] [--stratified=PER_TYPE] [--concurrency=N]
//
// Defaults: 5 questions, single-session-user (smallest subset), concurrency=1.
// --stratified=30 runs N questions per type (6 types × N), overrides --type/--limit.

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
const TOP_K = 8;
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

const ANSWER_SYSTEM_PROMPT = `You answer questions about a user using only the provided memory facts. Output ONLY the answer, no preamble.

Rules:
- Counting questions ("how many"): count the distinct relevant items the facts describe.
- Listing questions ("which", "what kinds of"): comma-separate all matching items.
- AGGREGATION (sum/combine) ONLY when the question explicitly asks for a total ("total", "altogether", "in total", "combined"): sum the components from the facts.
- For "how long is X" / "how much does X cost" / "what is X": phrase the answer the way the facts describe it. DO NOT double or sum unless explicitly asked.
- Temporal: use dates and durations exactly as stated.
- Only return UNKNOWN if the facts genuinely lack the information; if facts contain a clear answer or its components, prefer the answer over UNKNOWN.

Be terse. Output the bare answer (number, name, date, list).`;

const TOKEN_PATTERN = /[a-z]+|\d[\d.,]*\d|\d/g;

function tokenize(text) {
  const matches = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
  return new Set(matches.filter((t) => t.length > 1 || /^\d$/.test(t)));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function formatTranscript(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

function buildExtractUserPrompt(messages) {
  return `<conversation>\n${formatTranscript(messages)}\n</conversation>\n\nExtract new facts following the rules.`;
}

async function resolveZaiKey() {
  const fromEnv = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY;
  if (fromEnv) return fromEnv;
  const authPath = path.join(HOME, ".openclaw/agents/main/agent/auth-profiles.json");
  const text = await readFile(authPath, "utf8");
  const json = JSON.parse(text);
  const key = json?.profiles?.["zai:default"]?.key;
  if (!key) throw new Error(`No zai:default key in ${authPath}`);
  return key;
}

async function callGlm({ apiKey, systemPrompt, userPrompt }) {
  const resp = await fetch("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "glm-5.1",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      thinking: { type: "disabled" },
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  return json.choices?.[0]?.message?.content ?? "";
}

function tryParseExtract(raw) {
  const trimmed = raw.trim();
  const fenced = /^```(?:json|javascript)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    return {
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      typedFacts: Array.isArray(parsed.typedFacts) ? parsed.typedFacts : [],
    };
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

function retrieveTopK({ question, facts, typedFacts, k }) {
  const qTokens = tokenize(question);
  const scored = [];
  for (const f of facts) {
    const lex = jaccard(qTokens, tokenize(f.text));
    if (lex === 0 && (f.importance ?? 0.5) < 0.7) continue;
    const score = lex * 0.7 + (f.importance ?? 0.5) * 0.3;
    scored.push({ kind: "prose", text: f.text, score });
  }
  for (const t of typedFacts) {
    const text = t.unit ? `${t.slot} = ${t.value} ${t.unit}` : `${t.slot} = ${t.value}`;
    const lex = jaccard(qTokens, tokenize(text));
    if (lex === 0) continue;
    const score = lex * 0.7 + (t.confidence ?? 0.7) * 0.3 + 0.1;
    scored.push({ kind: "typed", text, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

async function runQuestion({ apiKey, question }) {
  const allFacts = [];
  const allTyped = [];
  for (const session of question.haystack_sessions) {
    const transcript = formatTranscript(session);
    const raw = await callGlm({
      apiKey,
      systemPrompt: EXTRACT_SYSTEM_PROMPT_V4,
      userPrompt: buildExtractUserPrompt(session),
    });
    const parsed = tryParseExtract(raw);
    allFacts.push(...parsed.facts);
    allTyped.push(...groundTypedFacts(parsed.typedFacts, transcript));
  }

  const top = retrieveTopK({
    question: question.question,
    facts: allFacts,
    typedFacts: allTyped,
    k: TOP_K,
  });
  const memorySection = top.map((r) => `- ${r.kind === "typed" ? "■" : "·"} ${r.text}`).join("\n");
  const userPrompt = `<memory>\n${memorySection || "(no facts retrieved)"}\n</memory>\n\nQuestion: ${question.question}\nAnswer:`;
  const hypothesis = (await callGlm({ apiKey, systemPrompt: ANSWER_SYSTEM_PROMPT, userPrompt }))
    .replace(/^```[\s\S]*?\n|```$/g, "")
    .trim();

  return {
    question_id: question.question_id,
    hypothesis,
    facts_extracted: allFacts.length,
    typed_extracted: allTyped.length,
    top_k_used: top.length,
  };
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
      if (idx >= items.length) return;
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
    if (!byType[t]) byType[t] = { total: 0, hits: 0, errors: 0 };
    byType[t].total += 1;
    if (r.exact_hit) byType[t].hits += 1;
    if (r.error) byType[t].errors += 1;
  }

  console.log(`\n=== Per-type results ===`);
  for (const t of QUESTION_TYPES) {
    const b = byType[t];
    if (!b) continue;
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

  const tag = STRATIFIED !== null ? `stratified${STRATIFIED}` : `${TYPE}-n${filtered.length}`;
  const outPath = `/tmp/longmemeval/hypothesis-${tag}.jsonl`;
  await writeFile(
    outPath,
    results
      .map((r) => JSON.stringify({ question_id: r.question_id, hypothesis: r.hypothesis ?? "" }))
      .join("\n") + "\n",
  );
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exitCode = 1;
});
