#!/usr/bin/env node --import tsx
// Real-engine LongMemEval runner (ZenBrain proof harness, P0a + P0b).
//
// Unlike run-longmemeval.mjs — a standalone adapter that REIMPLEMENTS retrieval
// with its own hardcoded weights (W_LEX=0.6, RRF) and therefore proves nothing
// about shipped code — this runner drives the PRODUCTION path end to end:
//   haystack sessions -> compactSession (real extraction/grounding/dedup)
//   -> consolidateLongTerm[+Typed] (real promotion/forgetting/reconciliation)
//   -> retrieveTopK (real 7-anchor fusion + Hebbian + FSRS)
//   -> formatMemorySection (the real injected "## Memory" block)
//   -> GLM answers; output is hypothesis.jsonl for score-longmemeval.mjs.
//
// Each question runs in an isolated temp workspace so haystacks never leak
// across questions (LongMemEval semantics: each question has its own history).
//
// P0b ablation surface (env-only; NO openclaw.json keys per the config-bloat
// rule). One flag per mechanism so a delta is attributable to ONE change:
//   ZENBRAIN_ABLATE_SEMANTIC=1   weightSemantic=0 + no query embedding (lexical+BM25 only)
//   ZENBRAIN_ABLATE_BM25=1       weightBm25=0
//   ZENBRAIN_ABLATE_HEBBIAN=1    hebbian.enabled=false
//   ZENBRAIN_HEBBIAN_2HOP=<f>    hebbian.twoHopDecay=f (G4 2-hop experiment; default 0)
//   ZENBRAIN_ABLATE_TYPED=1      weightTypedFactTierBoost=0
//   ZENBRAIN_ABLATE_FSRS=1       useFsrs=false (uniform exponential decay)
//   ZENBRAIN_ABLATE_EPOCH_FIRST=1 retrieval.useEpochFirst=false (full scan)
//   ZENBRAIN_TOPK=<n>            retrieval depth (default 20; prod assemble uses 5)
//   ZENBRAIN_SCORING_JSON='{...}' deep-merge override onto ScoringConfig (sweeps)
//
// Usage:
//   node --import tsx extensions/memory-l3/scripts/run-longmemeval-engine.ts \
//     [--limit=N] [--type=TYPE] [--stratified=PER_TYPE] [--concurrency=N] [--oracle=PATH]
//
// Requires: oracle JSON (default /tmp/longmemeval/oracle.json), an Ollama
// embedder (unless --ablate-semantic), and a zai key (env or auth-profiles).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compactSession } from "../src/compaction.js";
import type { EmbeddingProvider } from "../src/engine.js";
import { DEFAULT_HEBBIAN_CONFIG, type HebbianConfig } from "../src/hebbian.js";
import { IngestBuffer } from "../src/ingest.js";
import { createGlmCaller } from "../src/llm.js";
import { consolidateLongTermTyped } from "../src/longterm-typed.js";
import {
  consolidateLongTerm,
  DEFAULT_LONG_TERM_CONFIG,
  type LongTermConfig,
} from "../src/longterm.js";
import { reconcileCrossBrain, reconcileProseInterference } from "../src/reconciliation.js";
import {
  DEFAULT_RETRIEVAL_CONFIG,
  formatMemorySection,
  retrieveTopK,
  type RetrievalConfig,
} from "../src/retrieval.js";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "../src/scoring.js";
import { Storage } from "../src/storage.js";

const HOME = os.homedir();
const BATCH_TOKENS = 4000; // mirrors AFTER_TURN_COMPACTION_THRESHOLD_TOKENS
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const QUESTION_TYPES = [
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
  "multi-session",
  "knowledge-update",
  "temporal-reasoning",
];

const args = process.argv.slice(2);
const argVal = (name: string): string | null => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : null;
};
const LIMIT = Number.parseInt(argVal("limit") ?? "5", 10);
const TYPE = argVal("type") ?? "single-session-user";
const STRATIFIED = argVal("stratified") ? Number.parseInt(argVal("stratified")!, 10) : null;
const CONCURRENCY = Number.parseInt(argVal("concurrency") ?? "1", 10);
const ORACLE_PATH = argVal("oracle") ?? "/tmp/longmemeval/oracle.json";
const TOP_K = Number.parseInt(process.env.ZENBRAIN_TOPK ?? "20", 10);

const ANSWER_SYSTEM_PROMPT = `You answer a question about a user using only the provided memory facts.
Output exactly two lines:
Step 1: <one sentence naming the relevant facts>
Answer: <bare answer — number, name, date, or comma-separated list>
Commit to a best-effort answer; never reply UNKNOWN. Use dates/durations exactly as the facts state them.`;

type LmeTurn = { role: string; content: string };
type LmeQuestion = {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  question_date: string;
  haystack_dates?: string[];
  haystack_sessions: LmeTurn[][];
};

// ---- P0b: resolve the ablation config from env -----------------------------

type Ablation = {
  scoring: ScoringConfig;
  hebbian: HebbianConfig;
  retrieval: RetrievalConfig;
  longTerm: LongTermConfig;
  interferenceCosineThreshold: number | null;
  useQueryEmbedding: boolean;
  label: string;
};

function resolveAblation(): Ablation {
  const scoring: ScoringConfig = { ...DEFAULT_SCORING_CONFIG };
  const hebbian: HebbianConfig = { ...DEFAULT_HEBBIAN_CONFIG };
  const retrieval: RetrievalConfig = { ...DEFAULT_RETRIEVAL_CONFIG };
  const longTerm: LongTermConfig = { ...DEFAULT_LONG_TERM_CONFIG };
  let interferenceCosineThreshold: number | null = null;
  const on = (k: string) => process.env[k] === "1";
  const flags: string[] = [];

  let useQueryEmbedding = true;
  if (on("ZENBRAIN_ABLATE_SEMANTIC")) {
    scoring.weightSemantic = 0;
    useQueryEmbedding = false;
    flags.push("no-semantic");
  }
  if (on("ZENBRAIN_ABLATE_BM25")) {
    scoring.weightBm25 = 0;
    flags.push("no-bm25");
  }
  if (on("ZENBRAIN_ABLATE_HEBBIAN")) {
    hebbian.enabled = false;
    flags.push("no-hebbian");
  }
  if (process.env.ZENBRAIN_HEBBIAN_2HOP) {
    hebbian.twoHopDecay = Number(process.env.ZENBRAIN_HEBBIAN_2HOP);
    flags.push(`2hop=${hebbian.twoHopDecay}`);
  }
  if (on("ZENBRAIN_ABLATE_TYPED")) {
    scoring.weightTypedFactTierBoost = 0;
    flags.push("no-typed");
  }
  if (on("ZENBRAIN_ABLATE_FSRS")) {
    scoring.useFsrs = false;
    flags.push("no-fsrs");
  }
  if (on("ZENBRAIN_ABLATE_EPOCH_FIRST")) {
    retrieval.useEpochFirst = false;
    flags.push("no-epoch-first");
  }
  if (process.env.ZENBRAIN_SCORING_JSON) {
    Object.assign(scoring, JSON.parse(process.env.ZENBRAIN_SCORING_JSON));
    flags.push("scoring-json");
  }
  // G2: embedding-cosine dedup (long-term redundancy) + interference. Recalibrates
  // the long-term cosine threshold off its inherited jaccard value and turns on
  // the cosine path in prose interference (off by default = today's behavior).
  if (on("ZENBRAIN_DEDUP_COSINE")) {
    longTerm.semanticDedupCosineThreshold = Number(
      process.env.ZENBRAIN_DEDUP_COSINE_THRESHOLD ?? "0.92",
    );
    interferenceCosineThreshold = Number(process.env.ZENBRAIN_INTERFERENCE_COSINE ?? "0.7");
    flags.push(
      `dedup-cosine(d=${longTerm.semanticDedupCosineThreshold},i=${interferenceCosineThreshold})`,
    );
  }

  return {
    scoring,
    hebbian,
    retrieval,
    longTerm,
    interferenceCosineThreshold,
    useQueryEmbedding,
    label: flags.length > 0 ? flags.join("+") : "full",
  };
}

// ---- engine plumbing -------------------------------------------------------

function parseHaystackDate(s: string | undefined): number {
  if (!s) {
    return Date.now();
  }
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+\([A-Za-z]+\)\s+(\d{1,2}):(\d{2})/.exec(s);
  return m
    ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
    : Date.now();
}

// Convert a LongMemEval turn to the exact AgentMessage shape compaction already
// ingests (see claude-code-transcript.ts): user content is a string, assistant
// content is a text-part array. Backdate timestamps so FSRS/recency reflect when
// things were said, not now.
function toAgentMessage(turn: LmeTurn, timestamp: number): unknown {
  if (turn.role === "assistant") {
    return { role: "assistant", content: [{ type: "text", text: turn.content }], timestamp };
  }
  return { role: "user", content: turn.content, timestamp };
}

async function resolveZaiKey(): Promise<string> {
  const fromEnv = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY;
  if (fromEnv) {
    return fromEnv;
  }
  const authPath = path.join(HOME, ".openclaw/agents/main/agent/auth-profiles.json");
  const json = JSON.parse(await readFile(authPath, "utf8")) as {
    profiles?: Record<string, { key?: string }>;
  };
  const key = json.profiles?.["zai:default"]?.key;
  if (!key) {
    throw new Error(`No zai key in env or ${authPath}`);
  }
  return key;
}

async function resolveEmbeddingProvider(enabled: boolean): Promise<EmbeddingProvider | undefined> {
  if (!enabled) {
    return undefined;
  }
  const embed = async (text: string): Promise<number[]> => {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    if (!resp.ok) {
      throw new Error(`ollama HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as { embedding?: number[] };
    if (!Array.isArray(json.embedding)) {
      throw new Error("ollama returned no embedding");
    }
    return json.embedding;
  };
  try {
    await embed("probe");
  } catch (err) {
    console.log(`embeddings: unavailable (${(err as Error).message}) — running lexical-only`);
    return undefined;
  }
  return { embed, embedBatch: (texts) => Promise.all(texts.map(embed)) };
}

function parseAnswer(raw: string): string {
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

type QResult = {
  question_id: string;
  question_type: string;
  hypothesis: string;
  ground_truth: string;
  exact_hit: boolean;
  retrieved: number;
  memory_chars: number;
  error?: string;
};

async function runQuestion(
  q: LmeQuestion,
  deps: {
    apiKey: string;
    caller: ReturnType<typeof createGlmCaller>;
    embeddingProvider: EmbeddingProvider | undefined;
    ablation: Ablation;
  },
): Promise<QResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lme-eng-"));
  try {
    const storage = Storage.fromWorkspace(root);
    await storage.ensureLayout();
    const state = await storage.readState();
    state.agentId = "eval";

    const buffer = new IngestBuffer();
    const sessionDates = (q.haystack_dates ?? []).map(parseHaystackDate);
    let lastTs = Date.now();

    const consolidate = async (now: number): Promise<void> => {
      await consolidateLongTerm({
        storage,
        agentId: state.agentId,
        now,
        workspaceDir: root,
        embeddingProvider: deps.embeddingProvider,
        longTermConfig: deps.ablation.longTerm,
      });
      const ltt = await consolidateLongTermTyped({ storage, agentId: state.agentId, now });
      // Mirror the engine's epoch handler so the harness exercises the same
      // consolidation surface: cross-brain (prose↔typed) only on typed activity
      // to avoid a wasted LLM round-trip; prose interference always.
      if (ltt.promotedCount + ltt.supersededCount > 0) {
        await reconcileCrossBrain({ storage, caller: deps.caller, agentId: state.agentId, now });
      }
      await reconcileProseInterference({
        storage,
        agentId: state.agentId,
        now,
        interferenceCosineThreshold: deps.ablation.interferenceCosineThreshold,
      });
      state.lastConsolidatedAt = now;
    };

    for (let s = 0; s < q.haystack_sessions.length; s += 1) {
      const sessionId = `s${s}`;
      const ts = sessionDates[s] ?? Date.now();
      lastTs = ts;
      const flush = async (): Promise<void> => {
        const r = await compactSession({
          sessionId,
          buffer,
          storage,
          caller: deps.caller,
          state,
          now: ts,
          embeddingProvider: deps.embeddingProvider,
        });
        if (r.chunkId !== null && r.epochId !== null) {
          await consolidate(ts);
        }
      };
      for (const turn of q.haystack_sessions[s]) {
        buffer.push(sessionId, toAgentMessage(turn, ts) as never);
        if (buffer.tokens(sessionId) >= BATCH_TOKENS) {
          await flush();
        }
      }
      await flush();
    }
    // Tail consolidation so facts that never hit an epoch boundary still get a
    // promotion opportunity (mirrors ingest-claude-code-transcripts.ts).
    await consolidate(lastTs);

    const questionTime = parseHaystackDate(q.question_date);
    const queryEmbedding =
      deps.ablation.useQueryEmbedding && deps.embeddingProvider
        ? await deps.embeddingProvider.embed(q.question)
        : undefined;
    const top = await retrieveTopK({
      query: q.question,
      storage,
      topK: TOP_K,
      now: questionTime,
      config: deps.ablation.scoring,
      retrievalConfig: deps.ablation.retrieval,
      hebbianConfig: deps.ablation.hebbian,
      queryEmbedding,
    });
    const memorySection = formatMemorySection(top.facts, { now: questionTime });
    const userPrompt = `<memory>\n${memorySection || "(no facts retrieved)"}\n</memory>\n\nQuestion: ${q.question}`;
    const rawAnswer = await deps.caller({
      systemPrompt: ANSWER_SYSTEM_PROMPT,
      userPrompt,
      thinking: false,
    });
    const hypothesis = parseAnswer(rawAnswer.replace(/^```[\s\S]*?\n|```$/g, "").trim());

    return {
      question_id: q.question_id,
      question_type: q.question_type,
      hypothesis,
      ground_truth: String(q.answer),
      exact_hit: hypothesis.toLowerCase().includes(String(q.answer).toLowerCase()),
      retrieved: top.facts.length,
      memory_chars: memorySection.length,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function selectQuestions(oracle: LmeQuestion[]): LmeQuestion[] {
  if (STRATIFIED !== null) {
    return QUESTION_TYPES.flatMap((t) =>
      oracle.filter((q) => q.question_type === t).slice(0, STRATIFIED),
    );
  }
  return oracle.filter((q) => q.question_type === TYPE).slice(0, LIMIT);
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) {
        return;
      }
      results[idx] = await fn(items[idx]);
      process.stdout.write(`\r  progress: ${++done}/${items.length} `);
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
  return results;
}

async function main(): Promise<void> {
  const ablation = resolveAblation();
  console.log(`# LongMemEval (REAL ENGINE) — ablation: ${ablation.label}, topK=${TOP_K}`);

  const oracle = JSON.parse(await readFile(ORACLE_PATH, "utf8")) as LmeQuestion[];
  const selected = selectQuestions(oracle);
  console.log(
    `Selected ${selected.length} questions ${STRATIFIED ? `(${STRATIFIED}/type)` : `(${TYPE})`}, concurrency=${CONCURRENCY}`,
  );

  const apiKey = await resolveZaiKey();
  const caller = createGlmCaller({ apiKey });
  const embeddingProvider = await resolveEmbeddingProvider(ablation.useQueryEmbedding);

  const t0 = Date.now();
  const results = await runWithConcurrency(selected, CONCURRENCY, (q) =>
    runQuestion(q, { apiKey, caller, embeddingProvider, ablation }).catch(
      (e: unknown): QResult => ({
        question_id: q.question_id,
        question_type: q.question_type,
        hypothesis: "",
        ground_truth: String(q.answer),
        exact_hit: false,
        retrieved: 0,
        memory_chars: 0,
        error: (e as Error).message,
      }),
    ),
  );
  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);

  const byType: Record<string, { total: number; hits: number; errors: number }> = {};
  for (const r of results) {
    const b = (byType[r.question_type] ??= { total: 0, hits: 0, errors: 0 });
    b.total += 1;
    if (r.exact_hit) {
      b.hits += 1;
    }
    if (r.error) {
      b.errors += 1;
    }
  }

  console.log(`\n=== Per-type (exact-match presence; run score-longmemeval.mjs for judge) ===`);
  for (const t of QUESTION_TYPES) {
    const b = byType[t];
    if (b) {
      const pct = b.total > 0 ? Math.round((b.hits / b.total) * 100) : 0;
      console.log(
        `  ${t.padEnd(28)} ${b.hits}/${b.total} (${pct}%)${b.errors ? ` [${b.errors} err]` : ""}`,
      );
    }
  }
  const hits = results.filter((r) => r.exact_hit).length;
  const avgRetrieved = (results.reduce((s, r) => s + r.retrieved, 0) / results.length).toFixed(1);
  const avgMemChars = Math.round(results.reduce((s, r) => s + r.memory_chars, 0) / results.length);
  console.log(
    `  ${"OVERALL".padEnd(28)} ${hits}/${results.length} (${Math.round((hits / results.length) * 100)}%)`,
  );
  console.log(
    `  wall-clock ${elapsedMin}min · avg facts/q ${avgRetrieved} · avg memory ~${avgMemChars} chars (≈context budget — match across ablations)`,
  );

  const tag =
    (STRATIFIED ? `stratified${STRATIFIED}` : `${TYPE}-n${selected.length}`) +
    `__${ablation.label}`;
  const outDir = path.dirname(ORACLE_PATH);
  const hypoPath = path.join(outDir, `hypothesis-engine-${tag}.jsonl`);
  await writeFile(
    hypoPath,
    results
      .map((r) => JSON.stringify({ question_id: r.question_id, hypothesis: r.hypothesis }))
      .join("\n") + "\n",
  );
  const metaPath = path.join(outDir, `runmeta-engine-${tag}.json`);
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        ablation: ablation.label,
        scoring: ablation.scoring,
        hebbian: ablation.hebbian,
        retrieval: ablation.retrieval,
        longTerm: ablation.longTerm,
        interferenceCosineThreshold: ablation.interferenceCosineThreshold,
        topK: TOP_K,
        selected: selected.length,
        byType,
        overall: { hits, total: results.length },
        avgRetrieved: Number(avgRetrieved),
        avgMemChars,
        wallClockMin: Number(elapsedMin),
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${hypoPath}\n      ${metaPath}`);
  console.log(`Judge:  node extensions/memory-l3/scripts/score-longmemeval.mjs ${hypoPath}`);
}

main().catch((e: unknown) => {
  console.error(`FATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
