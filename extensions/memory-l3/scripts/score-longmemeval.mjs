#!/usr/bin/env node
// LLM-judge scorer for LongMemEval hypothesis files. Implements the official
// per-task-type judge prompts from
// github.com/xiaowu0162/LongMemEval/src/evaluation/evaluate_qa.py — verbatim.
// The paper uses GPT-4o; we default to GLM-5.1 (already wired up via Z.ai)
// for affordability. Switch via JUDGE_MODEL=gpt-4o + OPENAI_API_KEY for
// paper-comparable numbers.
//
// Usage:
//   node extensions/memory-l3/scripts/score-longmemeval.mjs [hypothesis.jsonl] [--concurrency=N] [--stability-check=N] [--stability-sample=M] [--no-supersession]

import { readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  describeJudgeSpec,
  JUDGE_PROMPT_REVISION,
  LONGMEMEVAL_SCORER_SPEC_CORE,
} from "../src/judge-estimand.js";
import { computeRobustnessBar } from "./robustness.mjs";

const HOME = os.homedir();
const ORACLE_PATH = "/tmp/longmemeval/oracle.json";

const args = process.argv.slice(2);
const hypArg =
  args.find((a) => !a.startsWith("--")) ?? "/tmp/longmemeval/hypothesis-stratified30.jsonl";
const concArg = args.find((a) => a.startsWith("--concurrency="));
const CONCURRENCY = concArg ? Number.parseInt(concArg.split("=")[1], 10) : 5;
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "glm-5.2";
// Judge stability check (QW2, 2026-10-02): the "Auditable Long-Term Memory"
// paper reports judges flipping verdicts on byte-identical answers. When
// --stability-check=N is set, a deterministic sample of answers is re-judged
// N times and the verdict-flip rate is reported alongside accuracy.
const stabArg = args.find((a) => a.startsWith("--stability-check="));
const STABILITY_CHECK = stabArg ? Math.max(2, Number.parseInt(stabArg.split("=")[1], 10) || 0) : 0;
const stabSampleArg = args.find((a) => a.startsWith("--stability-sample="));
const STABILITY_SAMPLE = stabSampleArg
  ? Math.max(1, Number.parseInt(stabSampleArg.split("=")[1], 10) || 1)
  : 8;
// Fixed seed so stability samples are comparable across invocations.
const STABILITY_SEED = 20261002;
// Supersession split (QW3, 2026-10-12): one extra judge pass per
// knowledge-update question measures whether revision→slot-merge answers land
// in the right slot. Disable with --no-supersession.
const SUPERSESSION_SPLIT = !args.includes("--no-supersession");
// Robustness bar (ARCH-2, 2026-10-12): --robustness[=N] re-judges a
// deterministic sample with each judge variant from ROBUSTNESS_JUDGE_MODELS
// (CSV of SECONDARY judges; the primary judge is always variant 0) and
// reports the interface-sensitivity bar (max pairwise accuracy delta). Bare
// flag samples 50. Empty CSV degrades to a SKIPPED line — never fatal.
const robArg = args.find((a) => a === "--robustness" || a.startsWith("--robustness="));
const ROBUSTNESS_SAMPLE_N = robArg
  ? robArg.includes("=")
    ? Math.max(1, Number.parseInt(robArg.split("=")[1], 10) || 50)
    : 50
  : 0;
// Fixed seed (same algorithm as STABILITY_SEED) so robustness samples stay
// comparable across invocations.
const ROBUSTNESS_SEED = 20261008;

// Dimension weights for composite scoring (from PubHealthBench hybrid-retrieval
// study: judge-human agreement is strongest for faithfulness and completeness).
// When LONGMEMEVAL_DIMENSION_SCORING=1, the judge is asked to score each
// dimension (0-10) in addition to the yes/no verdict.
const DIMENSION_WEIGHTS = {
  faithfulness: 0.35,
  completeness: 0.35,
  factualConsistency: 0.15,
  clarity: 0.15,
};

const DIMENSION_SCORING_INSTRUCTIONS = `
After your yes/no verdict, also score the model response on four dimensions (0-10 each):
- Faithfulness: Does the response faithfully reflect the retrieved facts without hallucination or fabrication?
- Completeness: Does the response cover all relevant information from the correct answer?
- Factual Consistency: Is the response internally consistent and factually correct?
- Clarity: Is the response clear, well-structured, and unambiguous?

Output one extra line after your verdict with the four scores in this exact format:
Scores: F=<faithfulness> C=<completeness> FC=<consistency> CL=<clarity>
Example: Scores: F=8 C=6 FC=9 CL=7`;

// ── Temporal-expression preservation metric ───────────────────────────────────
// Deterministic (no extra judge call): extracts temporal expressions from the
// gold answer and counts how many survive verbatim (case/whitespace-normalized)
// in the model response. Measures the downstream effect of the TEMPORAL guard
// carried by the extraction/compaction/reflection prompts against the recall
// baseline (QW2, 2026-08-25). Mirrors the anchor categories that guard names:
// ISO dates, month-name dates, clock times, weekday recurrences, relative
// references, and durations.

const TEMPORAL_EXPRESSION_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/gi,
  /\b(?:jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?/gi,
  /\b\d{1,2}\s+(?:jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/gi,
  /\b\d{1,2}:\d{2}\s?(?:am|pm)\b/gi,
  /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g,
  /\bevery\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/gi,
  /\b(?:last|next)\s+(?:week|month|year|weekend|mon|tues|wednes|thurs|fri|satur|sun)(?:day)?s?\b/gi,
  /\b(?:yesterday|tomorrow|today|tonight)\b/gi,
  /\b\d+(?:\.\d+)?\s+(?:day|week|month|year)s?\b/gi,
];

function normalizeTemporalExpression(expr) {
  return String(expr)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/u, "")
    .trim();
}

export function extractTemporalExpressions(text) {
  const raw = String(text ?? "");
  const found = new Set();
  for (const pattern of TEMPORAL_EXPRESSION_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(raw)) !== null) {
      const normalized = normalizeTemporalExpression(m[0]);
      if (normalized) {
        found.add(normalized);
      }
    }
  }
  return [...found];
}

export function countTemporalPreserved(answer, response) {
  const anchors = extractTemporalExpressions(answer);
  if (anchors.length === 0) {
    return { total: 0, preserved: 0 };
  }
  const haystack = String(response ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ");
  let preserved = 0;
  for (const anchor of anchors) {
    if (haystack.includes(anchor)) {
      preserved += 1;
    }
  }
  return { total: anchors.length, preserved };
}

// ── End temporal preservation helpers ─────────────────────────────────────

// ── Miss attribution (retrieval-miss vs reader-miss) ───────────────────────
// For each judged miss, ONE extra judge pass asks whether the evidence needed
// for the gold answer was present in the retrieval packet the answerer saw.
//   retrieval-miss = the needed facts never reached the reader → fix retrieval
//   reader-miss    = the needed facts were present but the answer failed → fix
//                    reader/prompts/compaction wording
// The packet comes from packet-engine-<tag>.jsonl, written alongside the
// hypothesis file by run-longmemeval-engine.ts (the adapter runner writes none,
// so attribution is silently disabled there).

export function buildAttributionPrompt(question, answer, packet) {
  return `I will give you a question, its correct answer, and the retrieval packet (the only facts) a memory system provided to the model that answered. Decide whether the packet contains the evidence needed to produce the correct answer.

Question: ${question}

Correct Answer: ${answer}

Retrieval packet:
${packet}

Does the packet contain the information needed to answer the question correctly (allowing trivial paraphrase or simple one-step derivation)? Answer exactly "evidence-present" if the needed information is present, or "evidence-absent" if it is missing or insufficient. Answer with one of those two labels only.`;
}

export function parseAttribution(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  // "absent" first: a hedging judge may mention both labels; absence decides.
  if (/\bevidence[- ]absent\b/.test(s)) {
    return "retrieval-miss";
  }
  if (/\bevidence[- ]present\b/.test(s)) {
    return "reader-miss";
  }
  return null;
}

// ── Supersession split (knowledge-update probe, QW3 2026-10-12) ────────────
// LongMemEval `knowledge-update` questions are the ones whose ground truth
// involves an updated value (revision → slot-merge recall). The official KU
// judge template tolerates responses that carry the old value next to the
// updated one ("contains some previous information along with an updated
// answer … considered as correct"), so plain accuracy cannot tell a clean
// merge from a both-slots answer. One extra judge pass per knowledge-update
// question splits that exposure: (a) correct-slot — does the response state
// the updated value? (b) stale-exposure — does it also state the superseded
// value? Baseline measurement that gates the A2 MINDSET hysteresis lane; no
// behavior change to the memory engine.

export function buildSupersessionPrompt(question, answer, response) {
  return `I will give you a question whose correct answer reflects the user's most recent update to a fact, the correct updated answer, and a response from a model. Judge the response on two independent axes:

1. slot: Does the response state the updated value (allowing trivial paraphrase or simple one-step derivation)?
2. stale: Does the response also state a prior, superseded value for the same attribute — an outdated value that the user later changed?

Question: ${question}

Correct (updated) Answer: ${answer}

Model Response: ${response}

Answer with exactly one line in this format (choose one value for each label) and nothing else:
slot=<correct|incorrect> stale=<exposed|clean>
Example: slot=correct stale=clean`;
}

// The instruction line spells labels as slot=<correct|incorrect>, so an echo
// of the format line cannot match. Take the LAST match per axis — judges that
// elaborate put the final answer on the final line.
function lastLabelMatch(re, s) {
  re.lastIndex = 0;
  let last = null;
  let m;
  while ((m = re.exec(s)) !== null) {
    last = m;
  }
  return last;
}

export function parseSupersession(raw) {
  const s = String(raw ?? "").toLowerCase();
  const slot = lastLabelMatch(/slot\s*=\s*(correct|incorrect)/g, s);
  const stale = lastLabelMatch(/stale\s*=\s*(exposed|clean)/g, s);
  return {
    correctSlot: slot ? slot[1] === "correct" : null,
    staleExposed: stale ? stale[1] === "exposed" : null,
  };
}

/** Cross-tab of the probe against the main yes/no verdict. */
export function summarizeSupersession(rows) {
  const out = {
    probed: rows.length,
    unparseable: rows.filter((r) => r.correctSlot === null || r.staleExposed === null).length,
    correctSlot: rows.filter((r) => r.correctSlot === true).length,
    staleExposed: rows.filter((r) => r.staleExposed === true).length,
    staleAmongJudgedCorrect: { n: 0, stale: 0 },
    staleAmongJudgedMisses: { n: 0, stale: 0 },
  };
  for (const r of rows) {
    if (r.verdict === true) {
      out.staleAmongJudgedCorrect.n += 1;
      if (r.staleExposed === true) out.staleAmongJudgedCorrect.stale += 1;
    } else if (r.verdict === false) {
      out.staleAmongJudgedMisses.n += 1;
      if (r.staleExposed === true) out.staleAmongJudgedMisses.stale += 1;
    }
  }
  return out;
}

// ── End supersession split helpers ───────────────────────────────────────

// ── Judge-spec stamp (ARCH-2 H1, 2026-10-12) ───────────────────────────────
// Composes this run's JudgeSpec: canonical core (surface/estimand/resolution)
// + the evaluator stamp. Resolution flips to "confidence" when dimension
// scoring is on (the judge then emits 0-10 dimension scores, not just yes/no).

export function buildJudgeSpec() {
  return {
    ...LONGMEMEVAL_SCORER_SPEC_CORE,
    resolution: process.env.LONGMEMEVAL_DIMENSION_SCORING === "1" ? "confidence" : "verdict",
    evaluator: { model: JUDGE_MODEL, promptRevision: JUDGE_PROMPT_REVISION },
  };
}

/** H2: judgeSpec header record first, then verdict lines — additive-only. */
export function buildEvalOutputLines(verdicts, judgeSpec) {
  return [
    JSON.stringify({ recordType: "judgeSpec", ...judgeSpec }),
    ...verdicts.map((v) => JSON.stringify(v)),
  ];
}

// ── End judge-spec stamp helpers ─────────────────────────────────────────

// ── End miss attribution helpers ───────────────────────────────────────────

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
  let prompt = tmpl
    .replace("{q}", question)
    .replace("{a}", String(answer))
    .replace("{r}", response);
  if (process.env.LONGMEMEVAL_DIMENSION_SCORING === "1") {
    prompt += DIMENSION_SCORING_INSTRUCTIONS;
  }
  return prompt;
}

// ── Dimension scoring helpers ─────────────────────────────────────────────

const DIMENSION_SCORE_PATTERN =
  /F\s*=\s*(\d+(?:\.\d+)?)\s*C\s*=\s*(\d+(?:\.\d+)?)\s*FC\s*=\s*(\d+(?:\.\d+)?)\s*CL\s*=\s*(\d+(?:\.\d+)?)/i;

const DIMENSION_KEY_ORDER = ["faithfulness", "completeness", "factualConsistency", "clarity"];

export function parseDimensionScores(raw) {
  const m = DIMENSION_SCORE_PATTERN.exec(raw);
  if (!m) {
    return null;
  }
  return {
    faithfulness: Number(m[1]),
    completeness: Number(m[2]),
    factualConsistency: Number(m[3]),
    clarity: Number(m[4]),
  };
}

export function computeWeightedComposite(scores) {
  let total = 0;
  let weight = 0;
  for (const dim of DIMENSION_KEY_ORDER) {
    const w = DIMENSION_WEIGHTS[dim] ?? 0;
    total += (scores[dim] ?? 0) * w;
    weight += w;
  }
  return weight > 0 ? total / weight : 0;
}

// ── End dimension scoring helpers ─────────────────────────────────────────

// ── Judge stability helpers ─────────────────────────────────────────────────
// Deterministic PRNG (mulberry32): same seed → same sample, so flip rates stay
// comparable across invocations and CI reruns.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministically sample `size` items (seeded Fisher-Yates, stable order). */
export function pickStabilitySample(items, size, seed) {
  if (items.length <= size) {
    return items.slice();
  }
  const rand = mulberry32(seed);
  const idx = items.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx
    .slice(0, size)
    .sort((a, b) => a - b)
    .map((i) => items[i]);
}

/** Flip summary for N verdicts of one byte-identical answer. */
export function summarizeStabilityRuns(verdicts) {
  const distinct = new Set(verdicts.filter((v) => v !== null));
  return {
    repeats: verdicts.length,
    distinctVerdicts: distinct.size,
    flipped: distinct.size > 1,
    unparseable: verdicts.filter((v) => v === null).length,
  };
}

// ── End judge stability helpers ───────────────────────────────────────────

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
const JUDGE_MIN_INTERVAL_MS = Number(process.env.ZENBRAIN_MIN_INTERVAL_MS ?? 1000);
let judgeNextAllowedAt = 0;
async function throttleJudge() {
  const now = Date.now();
  const wait = Math.max(0, judgeNextAllowedAt - now);
  judgeNextAllowedAt = Math.max(judgeNextAllowedAt, now) + JUDGE_MIN_INTERVAL_MS;
  if (wait > 0) {
    await sleep(wait);
  }
}

// Optional generic OpenAI-compatible judge endpoint (e.g. DeepSeek) so the judge
// can bypass a congested Z.ai. Set JUDGE_BASE_URL + JUDGE_API_KEY + JUDGE_MODEL.
const JUDGE_BASE_URL = process.env.JUDGE_BASE_URL ?? null;

async function callJudge({ apiKey, prompt, model }) {
  await throttleJudge();
  const judgeModel = model ?? JUDGE_MODEL;
  const isOpenAI = judgeModel.startsWith("gpt-");
  const isZai = !isOpenAI && !JUDGE_BASE_URL;
  const url = JUDGE_BASE_URL
    ? `${JUDGE_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : isOpenAI
      ? "https://api.openai.com/v1/chat/completions"
      : "https://api.z.ai/api/coding/paas/v4/chat/completions";
  const body = {
    model: judgeModel,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  };
  // `thinking` is a Z.ai-specific param; other providers reject it.
  if (isZai) {
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
  if (STABILITY_CHECK > 0) {
    console.log(
      `Stability check: ${STABILITY_CHECK} repeats over a deterministic sample of up to ${STABILITY_SAMPLE} byte-identical answers`,
    );
  }
  if (!SUPERSESSION_SPLIT) {
    console.log(`Supersession split: disabled (--no-supersession)`);
  }
  // H3: render the judge spec beside the results so every number this run
  // prints is attributable to an estimator + evaluator pair.
  const judgeSpec = buildJudgeSpec();
  console.log(`Judge spec: ${describeJudgeSpec(judgeSpec)}`);
  if (ROBUSTNESS_SAMPLE_N > 0) {
    const secondaryCsv = process.env.ROBUSTNESS_JUDGE_MODELS ?? "";
    const secondaryModels = secondaryCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    console.log(
      secondaryModels.length > 0
        ? `Robustness: sample ${ROBUSTNESS_SAMPLE_N} across ${secondaryModels.length + 1} judge variants (primary + ROBUSTNESS_JUDGE_MODELS)`
        : `Robustness: configured but ROBUSTNESS_JUDGE_MODELS is empty — will report SKIPPED`,
    );
  }

  // Echo the run manifest (sibling of the hypothesis file) so scored numbers
  // are always printed next to the configuration that produced them.
  const tagMatch = /hypothesis-(.+)\.jsonl$/.exec(hypArg);
  if (tagMatch) {
    const manifestPath = path.join(path.dirname(hypArg), `manifest-${tagMatch[1]}.json`);
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const echo = {
        readerModel: manifest.readerModel,
        embedModel: manifest.embedModel,
        reAskBudget: manifest.reAskBudget,
        promptVersion: manifest.promptVersion,
        timestamp: manifest.timestamp,
        filterTag: manifest.filterTag,
        judgeSpec,
        judgeSpecRender: describeJudgeSpec(judgeSpec),
      };
      console.log(`Manifest: ${JSON.stringify(echo)}`);
    } catch {
      console.log(`Manifest: (none found at ${manifestPath})`);
    }
  }

  const hypLines = (await readFile(hypArg, "utf8")).split("\n").filter(Boolean);
  const hypotheses = hypLines.map((l) => JSON.parse(l));
  const oracle = JSON.parse(await readFile(ORACLE_PATH, "utf8"));
  const byId = new Map(oracle.map((q) => [q.question_id, q]));

  // Retrieval packets for miss attribution (QW-B): packet-engine-<tag>.jsonl
  // written by the real-engine runner next to the hypothesis file.
  const packetPath = hypArg.includes("hypothesis-")
    ? hypArg.replace("hypothesis-", "packet-")
    : null;
  let packetsById = null;
  if (packetPath) {
    try {
      const packetLines = (await readFile(packetPath, "utf8")).split("\n").filter(Boolean);
      packetsById = new Map(
        packetLines.map((l) => {
          const p = JSON.parse(l);
          return [p.question_id, String(p.packet ?? "")];
        }),
      );
      console.log(
        `Attribution: loaded ${packetsById.size} retrieval packets from ${path.basename(packetPath)} — misses will be split retrieval-vs-reader`,
      );
    } catch {
      console.log(
        `Attribution: no packet file at ${packetPath} — retrieval-vs-reader split disabled (real-engine runner writes one)`,
      );
      packetsById = null;
    }
  }

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

  const apiKey = process.env.JUDGE_API_KEY
    ? process.env.JUDGE_API_KEY
    : JUDGE_MODEL.startsWith("gpt-")
      ? (process.env.OPENAI_API_KEY ??
        (() => {
          throw new Error("OPENAI_API_KEY not set");
        })())
      : await resolveZaiKey();

  const doDimensionScoring = process.env.LONGMEMEVAL_DIMENSION_SCORING === "1";
  if (doDimensionScoring) {
    console.log(
      "Dimension scoring: enabled (faithfulness×0.35 + completeness×0.35 + factualConsistency×0.15 + clarity×0.15)",
    );
  }

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
    const result = {
      question_id: t.hyp.question_id,
      question_type: t.oracle.question_type,
      verdict,
      raw_judge_output: raw.slice(0, 80),
    };
    const temporal = countTemporalPreserved(t.oracle.answer ?? "", t.hyp.hypothesis ?? "");
    if (temporal.total > 0) {
      result.temporal_total = temporal.total;
      result.temporal_preserved = temporal.preserved;
    }
    if (doDimensionScoring) {
      const dimScores = parseDimensionScores(raw);
      if (dimScores) {
        result.dimension_scores = dimScores;
        result.dimension_composite = computeWeightedComposite(dimScores);
      }
    }
    // One extra judge pass per judged miss (bounded by miss count): was the
    // needed evidence in the packet? Failures here must not corrupt the verdict.
    if (verdict === false && packetsById) {
      const packet = packetsById.get(t.hyp.question_id) ?? "";
      if (packet) {
        try {
          const rawAttr = await callJudge({
            apiKey,
            prompt: buildAttributionPrompt(t.oracle.question, t.oracle.answer, packet),
          });
          result.miss_attribution = parseAttribution(rawAttr);
          result.raw_attribution_output = rawAttr.slice(0, 80);
        } catch (e) {
          result.miss_attribution = null;
          result.attribution_error = e.message;
        }
      }
    }
    // Supersession split (QW3): one extra judge pass per knowledge-update
    // question, regardless of verdict — a judged-correct both-slots merge is
    // exactly the tolerated noise this probe exists to count.
    if (SUPERSESSION_SPLIT && t.oracle.question_type === "knowledge-update") {
      try {
        const rawSup = await callJudge({
          apiKey,
          prompt: buildSupersessionPrompt(
            t.oracle.question,
            t.oracle.answer,
            t.hyp.hypothesis ?? "",
          ),
        });
        const sup = parseSupersession(rawSup);
        if (sup.correctSlot !== null) {
          result.supersession_correct_slot = sup.correctSlot;
        }
        if (sup.staleExposed !== null) {
          result.supersession_stale_exposed = sup.staleExposed;
        }
      } catch (e) {
        result.supersession_error = e.message;
      }
    }
    return result;
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
  const temporalVerdicts = verdicts.filter((v) => typeof v.temporal_total === "number");
  if (temporalVerdicts.length > 0) {
    const tTotal = temporalVerdicts.reduce((s, v) => s + v.temporal_total, 0);
    const tPres = temporalVerdicts.reduce((s, v) => s + v.temporal_preserved, 0);
    const tPct = tTotal > 0 ? Math.round((tPres / tTotal) * 100) : 0;
    // "N of M" wording on purpose: optimize-weights.ts parses `type hits/total (pct%)`
    // lines from this output, so this line must not match that shape.
    console.log(
      `  temporal expressions preserved: ${tPres} of ${tTotal} across ${temporalVerdicts.length} answers (${tPct}%)`,
    );
  }
  console.log(`  wall-clock: ${elapsedMin} min`);

  // Miss attribution split (QW-B): converts the raw miss count into the
  // retrieval-vs-reader number that steers retrieval-side work. Deliberately
  // not `type hits/total (pct%)` shaped — optimize-weights.ts parses that.
  const judgedMisses = verdicts.filter((v) => v.verdict === false);
  const retrievalMisses = judgedMisses.filter(
    (v) => v.miss_attribution === "retrieval-miss",
  ).length;
  const readerMisses = judgedMisses.filter((v) => v.miss_attribution === "reader-miss").length;
  if (judgedMisses.length > 0 && packetsById) {
    const unattributed = judgedMisses.length - retrievalMisses - readerMisses;
    console.log(
      `  miss attribution: ${retrievalMisses} retrieval-miss, ${readerMisses} reader-miss, ${unattributed} unattributed, of ${judgedMisses.length} judged misses`,
    );
  }

  // Supersession split (QW3, 2026-10-12): stale-exposure + correct-slot rates
  // over knowledge-update questions — the revision→slot-merge baseline that
  // gates MINDSET hysteresis. Deliberately "X of N" shaped; must not match the
  // `type hits/total (pct%)` lines optimize-weights.ts parses.
  const supRows = verdicts
    .filter(
      (v) =>
        v.question_type === "knowledge-update" &&
        (typeof v.supersession_correct_slot === "boolean" ||
          typeof v.supersession_stale_exposed === "boolean"),
    )
    .map((v) => ({
      verdict: v.verdict,
      correctSlot:
        typeof v.supersession_correct_slot === "boolean" ? v.supersession_correct_slot : null,
      staleExposed:
        typeof v.supersession_stale_exposed === "boolean" ? v.supersession_stale_exposed : null,
    }));
  if (supRows.length > 0) {
    const s = summarizeSupersession(supRows);
    const slotPct = Math.round((s.correctSlot / s.probed) * 100);
    const stalePct = Math.round((s.staleExposed / s.probed) * 100);
    console.log(
      `  supersession correct-slot: ${s.correctSlot} of ${s.probed} probed knowledge-update answers (${slotPct}%)`,
    );
    console.log(
      `  supersession stale-exposure: ${s.staleExposed} of ${s.probed} probed knowledge-update answers (${stalePct}%)`,
    );
    console.log(
      `  stale exposure among judged-correct: ${s.staleAmongJudgedCorrect.stale} of ${s.staleAmongJudgedCorrect.n} (both-slots merges the KU template tolerates)`,
    );
    console.log(
      `  stale exposure among judged-misses: ${s.staleAmongJudgedMisses.stale} of ${s.staleAmongJudgedMisses.n} (old-value answers)`,
    );
    if (s.unparseable > 0) {
      console.log(`  supersession unparseable probe outputs: ${s.unparseable}`);
    }
    const supErrors = verdicts.filter((v) => v.supersession_error).length;
    if (supErrors > 0) {
      console.log(`  supersession probe errors: ${supErrors}`);
    }
  }

  if (doDimensionScoring) {
    const dimVerdicts = verdicts.filter((v) => v.dimension_scores);
    if (dimVerdicts.length > 0) {
      const avgDim = {};
      for (const dim of DIMENSION_KEY_ORDER) {
        avgDim[dim] =
          dimVerdicts.reduce((s, v) => s + v.dimension_scores[dim], 0) / dimVerdicts.length;
      }
      const avgComposite =
        dimVerdicts.reduce((s, v) => s + v.dimension_composite, 0) / dimVerdicts.length;
      console.log(
        `  dimensions (n=${dimVerdicts.length}): ` +
          `F=${avgDim.faithfulness.toFixed(1)} ` +
          `C=${avgDim.completeness.toFixed(1)} ` +
          `FC=${avgDim.factualConsistency.toFixed(1)} ` +
          `CL=${avgDim.clarity.toFixed(1)} ` +
          `weighted=${avgComposite.toFixed(2)}`,
      );
    }
  }

  if (STABILITY_CHECK > 0) {
    const sample = pickStabilitySample(tasks, STABILITY_SAMPLE, STABILITY_SEED);
    console.log(
      `\n=== Judge stability check (${STABILITY_CHECK} repeats x ${sample.length} sampled answers, judge=${JUDGE_MODEL}) ===`,
    );
    const stabilityRows = [];
    for (const t of sample) {
      // Byte-identical prompt on every repeat: any verdict change is judge noise,
      // not a change in the answer under test.
      const prompt = buildPrompt(
        t.oracle.question_type,
        t.oracle.question,
        t.oracle.answer,
        t.hyp.hypothesis ?? "",
      );
      const verdicts = [];
      for (let i = 0; i < STABILITY_CHECK; i += 1) {
        verdicts.push(parseVerdict(await callJudge({ apiKey, prompt })));
      }
      stabilityRows.push({
        question_id: t.hyp.question_id,
        question_type: t.oracle.question_type,
        verdicts,
        ...summarizeStabilityRuns(verdicts),
      });
      process.stdout.write(`\r  stability progress: ${stabilityRows.length}/${sample.length} `);
    }
    process.stdout.write("\n");
    const flippedTasks = stabilityRows.filter((r) => r.flipped).length;
    const flipPct = sample.length > 0 ? Math.round((flippedTasks / sample.length) * 100) : 0;
    const unparseableCalls = stabilityRows.reduce((s, r) => s + r.unparseable, 0);
    // Deliberately not `type hits/total (pct%)` shaped — optimize-weights.ts
    // parses that pattern from this output.
    console.log(
      `  verdict flips: ${flippedTasks} of ${sample.length} sampled answers across ${STABILITY_CHECK} byte-identical re-judgings (${flipPct}% flip rate)`,
    );
    console.log(
      `  unparseable judge calls: ${unparseableCalls} of ${sample.length * STABILITY_CHECK}`,
    );
    const stabilityPath = `${hypArg}.stability-${JUDGE_MODEL}.jsonl`;
    await writeFile(stabilityPath, stabilityRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`Wrote ${stabilityPath}`);
  }

  // Robustness bar (ARCH-2, 2026-10-12): interface-sensitivity measurement —
  // the SAME deterministic sample judged by every variant; max pairwise
  // accuracy delta is the bar. Judge calls = sample × variants (bounded like
  // the stability path). Degrades to a SKIPPED line with no secondaries.
  if (ROBUSTNESS_SAMPLE_N > 0) {
    const secondaryCsv = process.env.ROBUSTNESS_JUDGE_MODELS ?? "";
    const secondaryModels = secondaryCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const sample = pickStabilitySample(tasks, ROBUSTNESS_SAMPLE_N, ROBUSTNESS_SEED);
    const bar = await computeRobustnessBar({
      sample,
      primaryModel: JUDGE_MODEL,
      secondaryModels,
      judge: async (t, model) =>
        parseVerdict(
          await callJudge({
            apiKey,
            model,
            prompt: buildPrompt(
              t.oracle.question_type,
              t.oracle.question,
              t.oracle.answer,
              t.hyp.hypothesis ?? "",
            ),
          }),
        ),
    });
    console.log(`  ${bar.render}`);
    if (bar.status === "ok") {
      const robustnessPath = `${hypArg}.robustness-${JUDGE_MODEL}.jsonl`;
      const rows = [
        ...bar.rows.map((r) => JSON.stringify(r)),
        JSON.stringify({ recordType: "robustnessBar", maxDelta: bar.maxDelta, render: bar.render }),
      ];
      await writeFile(robustnessPath, rows.join("\n") + "\n");
      console.log(`Wrote ${robustnessPath}`);
    }
  }

  const outPath = `${hypArg}.eval-${JUDGE_MODEL}.jsonl`;
  await writeFile(outPath, buildEvalOutputLines(verdicts, judgeSpec).join("\n") + "\n");
  console.log(`\nWrote ${outPath}`);
}

// Entry-point guard: importing this module (e.g. from unit tests) must not run
// the judge; only a direct `node score-longmemeval.mjs` invocation does.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`FATAL: ${e.message}`);
    process.exitCode = 1;
  });
}
