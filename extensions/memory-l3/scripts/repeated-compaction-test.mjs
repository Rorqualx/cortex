#!/usr/bin/env node
// Repeated-compaction degradation benchmark for LongMemEval.
//
// Diagnostic: extracts facts from haystack sessions, then re-compacts the
// fact pool N-1 additional times (feeding previous output as pseudo-conversation
// input to the extractor). At each pass milestone, measures recall via
// the existing retrieval + answer pipeline.
//
// Usage:
//   node extensions/memory-l3/scripts/repeated-compaction-test.mjs \
//     [--limit=N] [--passes=1,3,5,10] [--type=TYPE]
//
// Output: degradation table showing fact count, typed count, and recall at
// each compaction depth. Results saved to /tmp/longmemeval/compaction-degradation.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
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
const PASSES = (argVal("passes") ?? "1,3,5,10")
  .split(",")
  .map(Number.parseInt)
  .filter((n) => n >= 1);
const MAX_PASS = Math.max(...PASSES, 1);
const TOP_K = 20;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const RRF_K = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const EXTRACT_SYSTEM_PROMPT = `You are a memory extraction assistant. Read the conversation chunk and extract two complementary kinds of facts:

1. PROSE FACTS — durable LLM-distilled units of information for future recall.
2. TYPED FACTS — verbatim precise values that must be remembered EXACTLY.

Rules (PROMPT_VERSION=4):
- IMPORTANCE: 0.0-1.0 score for retrieval ranking.
- DEDUPKEY: stable kebab-case key like "user_preference:morning_standups".
- TYPED FACTS: emit only when a precise verbatim value appears. Include slot, value, sourceSpan, unit (or null), confidence.

Emit strict JSON only. Schema:
{ "facts": [{ "text": "string", "importance": 0.0..1.0, "dedupKey": "kebab:case" }], "typedFacts": [{ "slot": "kebab:case", "value": "verbatim", "sourceSpan": "context", "unit": null, "confidence": 0.9 }] }
If nothing: { "facts": [], "typedFacts": [] }`;

// Re-compaction prompt: given previously extracted facts, distill them further
// (simulating what happens when L2 chunks are re-compacted in the real engine).
// The LLM naturally drops low-importance facts and merges similar ones.
const RECOMPACT_SYSTEM_PROMPT = `You are a memory compaction assistant. You are given a list of previously extracted facts from a conversation. Re-extract the most important and durable facts, dropping trivia, duplicates, and low-signal entries. Preserve precise values (numbers, IDs, dates, IPs, paths) verbatim.

Rules:
- Keep the most important and durable facts. Drop trivia and one-off context.
- Merge similar facts into single concise entries.
- Preserve IMPORTANCE and DEDUPKEY for each fact.
- Preserve TYPED FACTS that contain precise verbatim values.
- It is expected that the output will have FEWER facts than the input — that is the point.

Emit strict JSON only. Schema:
{ "facts": [{ "text": "string", "importance": 0.0..1.0, "dedupKey": "kebab:case" }], "typedFacts": [{ "slot": "kebab:case", "value": "verbatim", "sourceSpan": "context", "unit": null, "confidence": 0.9 }] }
If nothing: { "facts": [], "typedFacts": [] }`;

const ANSWER_SYSTEM_PROMPT = `You answer questions about a user using only the provided memory facts. Use a brief two-step format.

Format your output exactly like this:
Step 1: <one sentence noting which facts are relevant>
Answer: <bare answer>

Rules:
- ALWAYS commit to a best-effort answer. NEVER respond with UNKNOWN or "I don't know".
- Counting: count distinct relevant items.
- Listing: comma-separate all matching items.
- Temporal: use dates and durations exactly as stated.`;

const TOKEN_PATTERN = /[a-z]+|\d[\d.,]*\d|\d/g;

function tokenize(text) {
  const matches = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
  return new Set(matches.filter((t) => t.length > 1 || /^\d$/.test(t)));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  return intersect / (a.size + b.size - intersect);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

function formatTranscript(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

async function resolveZaiKey() {
  const fromEnv = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY;
  if (fromEnv) return fromEnv;
  const authPath = path.join(HOME, ".openclaw/agents/main/agent/auth-profiles.json");
  const text = await readFile(authPath, "utf8");
  const json = JSON.parse(text);
  return (
    json?.profiles?.["zai:default"]?.key ??
    (() => {
      throw new Error("No zai key");
    })()
  );
}

async function callGlm({ apiKey, systemPrompt, userPrompt }) {
  const resp = await fetch("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "glm-5.2",
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
  return JSON.parse(text).choices?.[0]?.message?.content ?? "";
}

function normalizeFact(o) {
  if (!o || typeof o !== "object") return null;
  const text = typeof o.text === "string" ? o.text : typeof o.fact === "string" ? o.fact : null;
  const dedupKey =
    typeof o.dedupKey === "string" ? o.dedupKey : typeof o.key === "string" ? o.key : null;
  if (!text || !dedupKey) return null;
  return {
    text: text.trim(),
    dedupKey: dedupKey.trim(),
    importance: typeof o.importance === "number" ? Math.max(0, Math.min(1, o.importance)) : 0.5,
  };
}

function normalizeTypedFact(o) {
  if (!o || typeof o !== "object") return null;
  const slot = typeof o.slot === "string" ? o.slot : null;
  const value = typeof o.value === "string" ? o.value : null;
  const sourceSpan = typeof o.sourceSpan === "string" ? o.sourceSpan : null;
  if (!slot || !value || !sourceSpan) return null;
  return {
    slot: slot.trim(),
    value,
    sourceSpan,
    unit: typeof o.unit === "string" && o.unit.trim() ? o.unit.trim() : null,
    confidence: typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0.5,
  };
}

function tryParseExtract(raw) {
  const trimmed = raw.trim();
  const fenced = /^```(?:json|javascript)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  try {
    const parsed = JSON.parse(fenced ? fenced[1] : trimmed);
    return {
      facts: (Array.isArray(parsed.facts) ? parsed.facts : []).map(normalizeFact).filter(Boolean),
      typedFacts: (Array.isArray(parsed.typedFacts) ? parsed.typedFacts : [])
        .map(normalizeTypedFact)
        .filter(Boolean),
    };
  } catch {
    return { facts: [], typedFacts: [] };
  }
}

function groundTypedFacts(typedFacts, transcript) {
  return typedFacts.filter(
    (t) =>
      t?.value &&
      t?.sourceSpan &&
      t.sourceSpan.includes(t.value) &&
      transcript.includes(t.sourceSpan),
  );
}

function parseHaystackDate(s) {
  if (!s) return Date.now();
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+\([A-Za-z]+\)\s+(\d{1,2}):(\d{2})/.exec(s);
  return m
    ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
    : Date.now();
}

function parseHypothesis(raw) {
  if (!raw) return "";
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^answer\s*:\s*(.*)$/i.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return lines[lines.length - 1] ?? "";
}

function exactStringMatch(hypothesis, answer) {
  return hypothesis.toLowerCase().includes(String(answer).toLowerCase());
}

// Embedding cache per benchmark run.
let embedCache = new Map();
async function embedText(text) {
  if (!text) return null;
  if (embedCache.has(text)) return embedCache.get(text);
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    if (!resp.ok) return null;
    const vec = (await resp.json())?.embedding;
    if (vec) embedCache.set(text, vec);
    return vec ?? null;
  } catch {
    return null;
  }
}

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
  if (candidates.length === 0) return [];

  const withLex = candidates.map((c, i) => ({ i, lex: jaccard(qTokens, c.tokens) }));
  withLex.sort((a, b) => b.lex - a.lex);
  const lexRank = new Array(candidates.length).fill(Infinity);
  for (let r = 0; r < withLex.length; r++) if (withLex[r].lex > 0) lexRank[withLex[r].i] = r;

  const semRank = new Array(candidates.length).fill(Infinity);
  const qEmbed = await embedText(question);
  if (qEmbed) {
    const factEmbeds = await Promise.all(candidates.map((c) => embedText(c.text)));
    const withSem = candidates.map((_, i) => ({
      i,
      sim: factEmbeds[i] ? cosineSimilarity(qEmbed, factEmbeds[i]) : 0,
    }));
    withSem.sort((a, b) => b.sim - a.sim);
    for (let r = 0; r < withSem.length; r++) if (withSem[r].sim > 0) semRank[withSem[r].i] = r;
  }

  const scored = candidates
    .map((c, i) => {
      let rrf = 0;
      if (Number.isFinite(lexRank[i])) rrf += 1 / (RRF_K + lexRank[i]);
      if (Number.isFinite(semRank[i])) rrf += 1 / (RRF_K + semRank[i]);
      if (rrf === 0) return null;
      const tierBoost = c.kind === "typed" ? 0.005 : 0;
      const impPrior = c.importance * 0.003;
      return {
        kind: c.kind,
        text: c.text,
        createdAt: c.createdAt,
        score: rrf + tierBoost + impPrior,
      };
    })
    .filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Re-compact a fact pool by formatting it as a pseudo-conversation and
 * re-extracting. Simulates what compactSession does to existing L2 facts.
 */
async function recompactFacts({ apiKey, facts, typedFacts }) {
  // Format facts as pseudo-conversation for re-extraction.
  const lines = facts.map(
    (f, i) => `system: Fact ${i + 1}: [${f.importance.toFixed(2)}] ${f.text} (key: ${f.dedupKey})`,
  );
  if (typedFacts.length > 0) {
    lines.push("system: --- Typed facts ---");
    for (const t of typedFacts) {
      lines.push(
        `system: ${t.slot} = ${t.value}${t.unit ? ` ${t.unit}` : ""} (source: ${t.sourceSpan})`,
      );
    }
  }
  const pseudoConversation = lines.join("\n");
  const raw = await callGlm({
    apiKey,
    systemPrompt: RECOMPACT_SYSTEM_PROMPT,
    userPrompt: `<previous_facts>\n${pseudoConversation}\n</previous_facts>\n\nRe-extract the most important durable facts, dropping trivia and duplicates.`,
  });
  return tryParseExtract(raw);
}

async function evaluateRecall({ apiKey, questions, facts, typedFacts }) {
  let hits = 0;
  const details = [];
  for (const q of questions) {
    embedCache = new Map(); // Clear per question.
    const questionTime = parseHaystackDate(q.question_date);
    const top = await retrieveTopK({
      question: q.question,
      facts,
      typedFacts,
      now: questionTime,
      k: TOP_K,
    });
    const memorySection = top
      .map((r) => `- ${r.kind === "typed" ? "■" : "·"} ${r.text}`)
      .join("\n");
    const userPrompt = `<memory>\n${memorySection || "(no facts retrieved)"}\n</memory>\n\nQuestion: ${q.question}`;
    const rawAnswer = (await callGlm({ apiKey, systemPrompt: ANSWER_SYSTEM_PROMPT, userPrompt }))
      .replace(/^```[\s\S]*?\n|```$/g, "")
      .trim();
    const hypothesis = parseHypothesis(rawAnswer);
    const hit = exactStringMatch(hypothesis, q.answer);
    if (hit) hits += 1;
    details.push({ question_id: q.question_id, hypothesis, ground_truth: String(q.answer), hit });
  }
  return {
    hits,
    total: questions.length,
    pct: Math.round((hits / questions.length) * 100),
    details,
  };
}

async function main() {
  console.log(`# Repeated-Compaction Degradation Benchmark`);
  console.log(`Type: ${TYPE}, Limit: ${LIMIT}, Passes to measure: ${PASSES.join(", ")}`);

  const oracle = JSON.parse(await readFile(ORACLE_PATH, "utf8"));
  const questions = oracle.filter((q) => q.question_type === TYPE).slice(0, LIMIT);
  console.log(`Selected ${questions.length} questions`);

  const apiKey = await resolveZaiKey();

  // Step 1: Initial extraction from all haystack sessions.
  console.log(`\n--- Pass 1: Initial extraction ---`);
  let facts = [];
  let typedFacts = [];
  const sessionDates = (questions[0]?.haystack_dates ?? []).map(parseHaystackDate);
  // Extract from ALL haystack sessions across all questions (pooled, like the real engine).
  const allSessions = questions[0]?.haystack_sessions ?? [];
  for (let i = 0; i < allSessions.length; i++) {
    const session = allSessions[i];
    const sessionTime = sessionDates[i] ?? Date.now();
    const transcript = formatTranscript(session);
    const raw = await callGlm({
      apiKey,
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      userPrompt: `<conversation>\n${transcript}\n</conversation>\n\nExtract new facts following the rules.`,
    });
    const parsed = tryParseExtract(raw);
    for (const f of parsed.facts) facts.push({ ...f, createdAt: sessionTime });
    for (const t of groundTypedFacts(parsed.typedFacts, transcript))
      typedFacts.push({ ...t, createdAt: sessionTime });
  }
  console.log(`  Facts: ${facts.length}, Typed: ${typedFacts.length}`);

  const results = [];

  // Evaluate at pass 1 if requested.
  if (PASSES.includes(1)) {
    console.log(`\n--- Evaluating recall at pass 1 ---`);
    const evalResult = await evaluateRecall({ apiKey, questions, facts, typedFacts });
    console.log(`  Recall: ${evalResult.hits}/${evalResult.total} (${evalResult.pct}%)`);
    results.push({
      pass: 1,
      factCount: facts.length,
      typedCount: typedFacts.length,
      ...evalResult,
    });
  }

  // Step 2: Re-compact up to MAX_PASS times, evaluating at each requested milestone.
  for (let pass = 2; pass <= MAX_PASS; pass++) {
    console.log(`\n--- Pass ${pass}: Re-compaction ---`);
    const recompacted = await recompactFacts({ apiKey, facts, typedFacts });
    facts = recompacted.facts.length > 0 ? recompacted.facts : facts; // Don't lose everything if LLM returns empty.
    typedFacts = recompacted.typedFacts.length > 0 ? recompacted.typedFacts : typedFacts;
    console.log(`  Facts: ${facts.length}, Typed: ${typedFacts.length}`);

    if (PASSES.includes(pass)) {
      console.log(`\n--- Evaluating recall at pass ${pass} ---`);
      const evalResult = await evaluateRecall({ apiKey, questions, facts, typedFacts });
      console.log(`  Recall: ${evalResult.hits}/${evalResult.total} (${evalResult.pct}%)`);
      results.push({ pass, factCount: facts.length, typedCount: typedFacts.length, ...evalResult });
    }
  }

  // Final summary table.
  console.log(`\n=== Degradation Table ===`);
  console.log(
    `  ${"Pass".padEnd(6)} ${"Facts".padEnd(8)} ${"Typed".padEnd(8)} ${"Recall".padEnd(12)} ${"Δ".padEnd(8)}`,
  );
  const baselinePct = results[0]?.pct ?? 0;
  for (const r of results) {
    const delta = r.pct - baselinePct;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    console.log(
      `  ${String(r.pass).padEnd(6)} ${String(r.factCount).padEnd(8)} ${String(r.typedCount).padEnd(8)} ${`${r.hits}/${r.total} (${r.pct}%)`.padEnd(12)} ${deltaStr.padEnd(8)}`,
    );
  }

  // Save results.
  await mkdir("/tmp/longmemeval", { recursive: true });
  const outPath = `/tmp/longmemeval/compaction-degradation-${TYPE}-n${LIMIT}.json`;
  await writeFile(
    outPath,
    JSON.stringify({ type: TYPE, limit: LIMIT, passes: PASSES, results }, null, 2),
  );
  console.log(`\nSaved to ${outPath}`);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exitCode = 1;
});
