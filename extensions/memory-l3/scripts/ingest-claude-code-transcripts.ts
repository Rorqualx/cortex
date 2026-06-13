#!/usr/bin/env node --import tsx
// Ingest Claude Code session transcripts into the memory-l3 store by driving
// the production pipeline: parse -> IngestBuffer -> compactSession (4k-token
// batches, same threshold as the live engine) -> long-term consolidation on
// epoch boundaries. Fact timestamps are backdated to the transcript's own
// clock so recency scoring reflects when things were actually said.
//
// Usage:
//   node --import tsx extensions/memory-l3/scripts/ingest-claude-code-transcripts.ts \
//     <file-or-dir...> [--workspace=~/.openclaw/workspace] [--agent=main] \
//     [--dry-run] [--limit-sessions=N]
//
// Re-runs are idempotent: per-session progress is recorded in the engine's
// own compactedMessageCountBySession cursor, so already-ingested sessions
// (keyed by Claude Code session id) are skipped.
//
// Run while the gateway is idle/stopped: a live engine writing state.json
// concurrently would race the chunk-index cursor.

import { readdir, readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseClaudeCodeTranscript,
  type ClaudeCodeSession,
} from "../src/claude-code-transcript.js";
import { compactSession } from "../src/compaction.js";
import type { EmbeddingProvider } from "../src/engine.js";
import { IngestBuffer } from "../src/ingest.js";
import { createGlmCaller, type LlmCaller } from "../src/llm.js";
import { consolidateLongTermTyped } from "../src/longterm-typed.js";
import { consolidateLongTerm } from "../src/longterm.js";
import { Storage } from "../src/storage.js";

// Mirrors AFTER_TURN_COMPACTION_THRESHOLD_TOKENS in engine.ts so imported
// chunks match the granularity the live engine produces.
const BATCH_TOKENS = 4000;
const SESSION_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";

const args = process.argv.slice(2);
const argVal = (name: string): string | null => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const DRY_RUN = args.includes("--dry-run");
const NO_EMBEDDINGS = args.includes("--no-embeddings");
const LIMIT_SESSIONS = argVal("limit-sessions") ? Number(argVal("limit-sessions")) : Infinity;
const WORKSPACE = argVal("workspace") ?? path.join(os.homedir(), ".openclaw", "workspace");
const AGENT_ID = argVal("agent") ?? "main";
const INPUTS = args.filter((a) => !a.startsWith("--"));

async function collectTranscriptFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    const info = await stat(resolved);
    if (info.isFile()) {
      files.push(resolved);
      continue;
    }
    const names = await readdir(resolved);
    for (const name of names) {
      if (SESSION_FILE_PATTERN.test(name)) {
        files.push(path.join(resolved, name));
      }
    }
  }
  return files;
}

async function loadSessions(files: string[]): Promise<ClaudeCodeSession[]> {
  const sessions: ClaudeCodeSession[] = [];
  for (const file of files) {
    const jsonl = await readFile(file, "utf8");
    const session = parseClaudeCodeTranscript({
      jsonl,
      sessionId: path.basename(file, ".jsonl"),
    });
    if (session.messages.length > 0) {
      sessions.push(session);
    }
  }
  // Oldest first so chunk sequence and epoch digests follow real chronology.
  sessions.sort((a, b) => a.firstTimestamp - b.firstTimestamp);
  return sessions;
}

async function resolveZaiKey(): Promise<string> {
  const fromEnv = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY;
  if (fromEnv) {
    return fromEnv;
  }
  const authPath = path.join(
    os.homedir(),
    ".openclaw",
    "agents",
    AGENT_ID,
    "agent",
    "auth-profiles.json",
  );
  const parsed = JSON.parse(await readFile(authPath, "utf8")) as {
    profiles?: Record<string, { type?: string; provider?: string; key?: string }>;
  };
  const profiles = parsed.profiles ?? {};
  const isZaiKey = (p?: { type?: string; provider?: string; key?: string }): p is { key: string } =>
    p?.type === "api_key" && p.provider === "zai" && typeof p.key === "string" && p.key.length > 0;
  const preferred = profiles["zai:default"];
  if (isZaiKey(preferred)) {
    return preferred.key;
  }
  const fallback = Object.values(profiles).find(isZaiKey);
  if (fallback) {
    return fallback.key;
  }
  throw new Error(`No ZAI_API_KEY in env and no zai api_key profile in ${authPath}`);
}

/** Ollama-backed embedding provider; returns undefined when unreachable. */
async function resolveEmbeddingProvider(): Promise<EmbeddingProvider | undefined> {
  if (NO_EMBEDDINGS) {
    return undefined;
  }
  const embed = async (text: string): Promise<number[]> => {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    if (!resp.ok) {
      throw new Error(`ollama embeddings HTTP ${resp.status}`);
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
    console.log(`embeddings: unavailable (${(err as Error).message}) — continuing without`);
    return undefined;
  }
  return {
    embed,
    embedBatch: (texts) => Promise.all(texts.map((t) => embed(t))),
  };
}

async function main(): Promise<void> {
  if (INPUTS.length === 0) {
    console.error(
      "Usage: ingest-claude-code-transcripts.ts <file-or-dir...> [--workspace=DIR] [--agent=ID] [--dry-run] [--limit-sessions=N] [--no-embeddings]",
    );
    process.exitCode = 1;
    return;
  }

  const files = await collectTranscriptFiles(INPUTS);
  const sessions = (await loadSessions(files)).slice(0, LIMIT_SESSIONS);
  console.log(
    `parsed ${files.length} transcript file(s) -> ${sessions.length} non-empty session(s)`,
  );

  const storage = Storage.fromWorkspace(WORKSPACE);
  await storage.ensureLayout();
  const state = await storage.readState();
  if (state.agentId === null) {
    state.agentId = AGENT_ID;
  }

  const buffer = new IngestBuffer();
  let totalMessages = 0;
  let totalTokens = 0;
  let estBatches = 0;
  const plan: Array<{ session: ClaudeCodeSession; startAt: number }> = [];
  for (const session of sessions) {
    const cursor = state.compactedMessageCountBySession[session.sessionId] ?? 0;
    if (cursor >= session.messages.length) {
      continue;
    }
    const pending = session.messages.slice(cursor);
    buffer.pushBatch(session.sessionId, pending);
    const tokens = buffer.tokens(session.sessionId);
    totalMessages += pending.length;
    totalTokens += tokens;
    estBatches += Math.max(1, Math.ceil(tokens / BATCH_TOKENS));
    buffer.drain(session.sessionId);
    plan.push({ session, startAt: cursor });
    const day = new Date(session.firstTimestamp).toISOString().slice(0, 10);
    console.log(
      `  ${session.sessionId.slice(0, 8)} ${day} messages=${pending.length} tokens≈${tokens}${cursor > 0 ? ` (resume from ${cursor})` : ""}`,
    );
  }
  console.log(
    `total: messages=${totalMessages} tokens≈${totalTokens} -> ~${estBatches} extraction call(s)`,
  );
  if (DRY_RUN) {
    console.log("dry run: no chunks written, no LLM calls made");
    return;
  }
  if (plan.length === 0) {
    console.log("nothing to ingest (all sessions already imported)");
    return;
  }

  const caller: LlmCaller = createGlmCaller({ apiKey: await resolveZaiKey() });
  const embeddingProvider = await resolveEmbeddingProvider();

  let chunks = 0;
  let facts = 0;
  let typed = 0;
  let lastBatchAt = 0;

  const consolidate = async (now: number): Promise<void> => {
    const lt = await consolidateLongTerm({
      storage,
      agentId: state.agentId,
      now,
      workspaceDir: WORKSPACE,
      embeddingProvider,
    });
    const ltt = await consolidateLongTermTyped({ storage, agentId: state.agentId, now });
    state.lastConsolidatedAt = now;
    console.log(
      `  consolidated: prose +${lt.promotedCount}/~${lt.reaffirmedCount} typed +${ltt.promotedCount} (active ${lt.activeCount})`,
    );
  };

  for (const { session, startAt } of plan) {
    console.log(`ingesting ${session.sessionId} (${session.messages.length - startAt} messages)`);
    let consumed = startAt;
    let batchAt = session.firstTimestamp;
    const flush = async (): Promise<void> => {
      const result = await compactSession({
        sessionId: session.sessionId,
        buffer,
        storage,
        caller,
        state,
        now: batchAt,
        embeddingProvider,
      });
      if (result.chunkId === null) {
        return;
      }
      consumed += result.messagesIngested;
      chunks += 1;
      facts += result.factsAdded;
      typed += result.typedFactsAdded;
      lastBatchAt = batchAt;
      state.compactedMessageCountBySession[session.sessionId] = consumed;
      console.log(
        `  ${result.chunkId}: ${result.factsAdded} fact(s), ${result.typedFactsAdded} typed`,
      );
      if (result.epochId !== null) {
        await consolidate(batchAt);
      }
      // Persist after every batch so an interrupted import resumes cleanly.
      await storage.writeState(state);
    };
    for (const message of session.messages.slice(startAt)) {
      buffer.push(session.sessionId, message);
      const ts = (message as { timestamp?: number }).timestamp;
      if (typeof ts === "number" && ts > 0) {
        batchAt = ts;
      }
      if (buffer.tokens(session.sessionId) >= BATCH_TOKENS) {
        await flush();
      }
    }
    await flush();
    state.compactedMessageCountBySession[session.sessionId] = session.messages.length;
    await storage.writeState(state);
  }

  // Final pass so facts from a tail that never hit an epoch boundary still
  // get a promotion opportunity.
  if (chunks > 0) {
    await consolidate(lastBatchAt || Date.now());
  }
  await storage.writeState(state);
  console.log(`done: ${chunks} chunk(s), ${facts} prose fact(s), ${typed} typed fact(s)`);
}

main().catch((err: unknown) => {
  console.error(`FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
});
