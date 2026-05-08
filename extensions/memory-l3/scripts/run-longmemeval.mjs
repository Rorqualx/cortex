#!/usr/bin/env node
// First-signal adapter for LongMemEval (arXiv 2410.10813, ICLR 2025).
// For each question: extract facts (PROMPT_VERSION=4) from each haystack
// session, retrieve top-K via lexical Jaccard against the question, and
// ask the LLM to answer using only those facts. Outputs hypothesis.jsonl
// and a summary table comparing hypothesis to ground truth.
//
// Usage:
//   node extensions/memory-l3/scripts/run-longmemeval.mjs [--limit=N] [--type=single-session-user]
//
// Defaults: 5 questions, single-session-user (smallest subset).

import { readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const ORACLE_PATH = "/tmp/longmemeval/oracle.json";

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const typeArg = args.find((a) => a.startsWith("--type="));
const LIMIT = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : 5;
const TYPE = typeArg ? typeArg.split("=")[1] : "single-session-user";
const TOP_K = 8;

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

const ANSWER_SYSTEM_PROMPT = `You answer questions about a user using only the provided memory facts. Be terse and direct — output ONLY the answer, no preamble. If the facts don't contain enough information, output the single word: UNKNOWN.`;

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

async function main() {
  console.log(`# LongMemEval first-signal run`);
  console.log(`Type: ${TYPE}`);
  console.log(`Limit: ${LIMIT}`);

  const oracle = JSON.parse(await readFile(ORACLE_PATH, "utf8"));
  const filtered = oracle.filter((q) => q.question_type === TYPE).slice(0, LIMIT);
  console.log(`Selected ${filtered.length} questions`);

  const apiKey = await resolveZaiKey();
  const results = [];
  let exactHits = 0;
  for (const [i, q] of filtered.entries()) {
    process.stdout.write(`\n[${i + 1}/${filtered.length}] ${q.question_id} `);
    const t0 = Date.now();
    let result;
    try {
      result = await runQuestion({ apiKey, question: q });
    } catch (e) {
      console.log(`ERR ${e.message}`);
      results.push({ question_id: q.question_id, hypothesis: "", error: e.message });
      continue;
    }
    const elapsed = Date.now() - t0;
    const hit = exactStringMatch(result.hypothesis, q.answer);
    if (hit) exactHits += 1;
    console.log(`${hit ? "✓" : "✗"} ${elapsed}ms`);
    console.log(`  Q: ${q.question}`);
    console.log(`  Truth:      ${q.answer}`);
    console.log(`  Hypothesis: ${result.hypothesis}`);
    console.log(
      `  facts=${result.facts_extracted} typed=${result.typed_extracted} retrieved=${result.top_k_used}`,
    );
    results.push({ ...result, ground_truth: q.answer, exact_hit: hit });
  }

  console.log(`\n=== Summary ===`);
  console.log(
    `Exact-string hits: ${exactHits}/${filtered.length} (${Math.round((exactHits / filtered.length) * 100)}%)`,
  );

  const outPath = `/tmp/longmemeval/hypothesis-${TYPE}-n${filtered.length}.jsonl`;
  await writeFile(
    outPath,
    results
      .map((r) => JSON.stringify({ question_id: r.question_id, hypothesis: r.hypothesis }))
      .join("\n") + "\n",
  );
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exitCode = 1;
});
