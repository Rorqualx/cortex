#!/usr/bin/env node
// LLM-judge scorer for LongMemEval hypothesis files. Implements the official
// per-task-type judge prompts from
// github.com/xiaowu0162/LongMemEval/src/evaluation/evaluate_qa.py — verbatim.
// The paper uses GPT-4o; we default to GLM-5.1 (already wired up via Z.ai)
// for affordability. Switch via JUDGE_MODEL=gpt-4o + OPENAI_API_KEY for
// paper-comparable numbers.
//
// Usage:
//   node extensions/memory-l3/scripts/score-longmemeval.mjs [hypothesis.jsonl] [--concurrency=N]

import { readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const ORACLE_PATH = "/tmp/longmemeval/oracle.json";

const args = process.argv.slice(2);
const hypArg =
  args.find((a) => !a.startsWith("--")) ?? "/tmp/longmemeval/hypothesis-stratified30.jsonl";
const concArg = args.find((a) => a.startsWith("--concurrency="));
const CONCURRENCY = concArg ? Number.parseInt(concArg.split("=")[1], 10) : 5;
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "glm-5.2";

// Verbatim prompt templates from LongMemEval's evaluate_qa.py.
const TEMPLATES = {
  default:
    "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.",
  "temporal-reasoning":
    "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.",
  "knowledge-update":
    "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {q}\n\nCorrect Answer: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.",
  "single-session-preference":
    "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {q}\n\nRubric: {a}\n\nModel Response: {r}\n\nIs the model response correct? Answer yes or no only.",
};

const QUESTION_TYPES = [
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
  "multi-session",
  "knowledge-update",
  "temporal-reasoning",
];

function buildPrompt(qtype, question, answer, response) {
  const tmpl = TEMPLATES[qtype] ?? TEMPLATES.default;
  return tmpl.replace("{q}", question).replace("{a}", String(answer)).replace("{r}", response);
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

// 429 = overload/rate limit; 5xx = transient. Without retry a single Z.ai burst
// turns judge verdicts into errors and corrupts the whole arm's accuracy.
const RETRYABLE_JUDGE_STATUSES = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Proactive ~1s min-gap, shared across concurrent judge workers, so the judge
// coexists with the live gateway under the shared rate limit (matches the
// runner's throttle). Each call reserves the next slot before firing.
const JUDGE_MIN_INTERVAL_MS = 1000;
let judgeNextAllowedAt = 0;
async function throttleJudge() {
  const now = Date.now();
  const wait = Math.max(0, judgeNextAllowedAt - now);
  judgeNextAllowedAt = Math.max(judgeNextAllowedAt, now) + JUDGE_MIN_INTERVAL_MS;
  if (wait > 0) {
    await sleep(wait);
  }
}

async function callJudge({ apiKey, prompt }) {
  await throttleJudge();
  const isOpenAI = JUDGE_MODEL.startsWith("gpt-");
  const url = isOpenAI
    ? "https://api.openai.com/v1/chat/completions"
    : "https://api.z.ai/api/coding/paas/v4/chat/completions";
  const body = {
    model: JUDGE_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  };
  if (!isOpenAI) {
    body.thinking = { type: "disabled" };
  }
  // Aggressive budget: judge shares the Z.ai key with the live gateway, so it
  // must ride out sustained contention. ~10 attempts at up to 60s spacing.
  const maxRetries = 10;
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (resp.ok) {
      const json = JSON.parse(text);
      return json.choices?.[0]?.message?.content ?? "";
    }
    if (attempt >= maxRetries || !RETRYABLE_JUDGE_STATUSES.has(resp.status)) {
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    const retryAfter = Number(resp.headers.get("retry-after"));
    const delay =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60_000)
        : Math.round(Math.min(1000 * 2 ** attempt, 60_000) * (0.5 + Math.random() * 0.5));
    await sleep(delay);
  }
}

function parseVerdict(raw) {
  const s = raw.trim().toLowerCase();
  if (s.startsWith("yes")) {
    return true;
  }
  if (s.startsWith("no")) {
    return false;
  }
  // Some models elaborate. Fall back to substring search.
  if (/\byes\b/.test(s) && !/\bno\b/.test(s.split("\n")[0])) {
    return true;
  }
  if (/\bno\b/.test(s)) {
    return false;
  }
  return null;
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
        results[idx] = { error: e.message };
      }
      completed += 1;
      process.stdout.write(`\r  judge progress: ${completed}/${items.length} `);
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
  return results;
}

async function main() {
  console.log(`# LongMemEval LLM-judge scoring`);
  console.log(`Hypothesis: ${hypArg}`);
  console.log(`Judge: ${JUDGE_MODEL}`);
  console.log(`Concurrency: ${CONCURRENCY}`);

  const hypLines = (await readFile(hypArg, "utf8")).split("\n").filter(Boolean);
  const hypotheses = hypLines.map((l) => JSON.parse(l));
  const oracle = JSON.parse(await readFile(ORACLE_PATH, "utf8"));
  const byId = new Map(oracle.map((q) => [q.question_id, q]));

  const tasks = hypotheses
    .map((h) => {
      const q = byId.get(h.question_id);
      if (!q) {
        return null;
      }
      return { hyp: h, oracle: q };
    })
    .filter(Boolean);
  console.log(`Matched ${tasks.length} hypothesis-oracle pairs`);

  const apiKey = JUDGE_MODEL.startsWith("gpt-")
    ? (process.env.OPENAI_API_KEY ??
      (() => {
        throw new Error("OPENAI_API_KEY not set");
      })())
    : await resolveZaiKey();

  const t0 = Date.now();
  const verdicts = await runWithConcurrency(tasks, CONCURRENCY, async (t) => {
    const prompt = buildPrompt(
      t.oracle.question_type,
      t.oracle.question,
      t.oracle.answer,
      t.hyp.hypothesis ?? "",
    );
    const raw = await callJudge({ apiKey, prompt });
    const verdict = parseVerdict(raw);
    return {
      question_id: t.hyp.question_id,
      question_type: t.oracle.question_type,
      verdict,
      raw_judge_output: raw.slice(0, 80),
    };
  });
  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);

  const byType = {};
  let unparseable = 0;
  for (const v of verdicts) {
    const t = v.question_type;
    if (!byType[t]) {
      byType[t] = { total: 0, hits: 0 };
    }
    byType[t].total += 1;
    if (v.verdict === true) {
      byType[t].hits += 1;
    }
    if (v.verdict === null) {
      unparseable += 1;
    }
  }

  console.log(`\n=== LLM-judge results (judge=${JUDGE_MODEL}) ===`);
  for (const t of QUESTION_TYPES) {
    const b = byType[t];
    if (!b) {
      continue;
    }
    const pct = b.total > 0 ? Math.round((b.hits / b.total) * 100) : 0;
    console.log(`  ${t.padEnd(28)} ${b.hits}/${b.total} (${pct}%)`);
  }
  const totalHits = verdicts.filter((v) => v.verdict === true).length;
  const overallPct = Math.round((totalHits / verdicts.length) * 100);
  console.log(`  ${"OVERALL".padEnd(28)} ${totalHits}/${verdicts.length} (${overallPct}%)`);
  if (unparseable > 0) {
    console.log(`  unparseable verdicts: ${unparseable}`);
  }
  console.log(`  wall-clock: ${elapsedMin} min`);

  const outPath = `${hypArg}.eval-${JUDGE_MODEL}.jsonl`;
  await writeFile(outPath, verdicts.map((v) => JSON.stringify(v)).join("\n") + "\n");
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exitCode = 1;
});
