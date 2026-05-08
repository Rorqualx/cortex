#!/usr/bin/env node
// Replay an L1 archive through the live GLM extractor and print the raw
// response + parse outcome, so we can tell the difference between a clean
// empty result (correct) and a silent parse failure (bug).
//
// Usage:
//   node extensions/memory-l3/scripts/replay-compaction.mjs [archive-path] [--limit=N] [--legacy-v2]
//
// Defaults to the most recent failed-extraction archive using the v3 prompt
// (production). Pass --legacy-v2 to replay with the old v2 prompt + injected
// already-known keys, which reproduces the over-suppression bug for
// regression checking.

import { readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const DEFAULT_ARCHIVE = path.join(
  HOME,
  ".openclaw/workspace/.openclaw/l3/l1_archive/chunk-000002-51fc85b9.jsonl",
);
const L3_L2_ROOT = path.join(HOME, ".openclaw/workspace/.openclaw/l3/l2");
const RECENT_CHUNKS_TO_SCAN = 50;
const RECENT_DEDUP_KEYS_LIMIT = 200;

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const LEGACY_V2 = args.includes("--legacy-v2");
const positional = args.filter((a) => !a.startsWith("--"));
const ARCHIVE_PATH = positional[0] ?? DEFAULT_ARCHIVE;
const MSG_LIMIT = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : null;

// Inlined from extensions/memory-l3/src/llm.ts. Kept manually in sync.
const EXTRACT_SYSTEM_PROMPT_V3 = `You are a memory extraction assistant. Read the conversation chunk and extract distilled facts — durable units of information that should be remembered across future sessions.

Rules (PROMPT_VERSION=3):
- IMPORTANCE: a 0.0-1.0 score for retrieval ranking. User preferences/decisions/identity facts get 0.7+; one-off context details 0.3-0.5; trivia 0.1-0.3.
- DEDUPKEY: a stable kebab-case key like "user_preference:morning_standups" so future runs can detect duplicates.

Emit strict JSON only, with no surrounding prose. Schema:
{ "facts": [ { "text": "string", "importance": 0.0..1.0, "dedupKey": "kebab:case" } ] }

If no new facts to emit, output: { "facts": [] }`;

// Retained verbatim for regression replay. v2 over-suppressed on long inputs
// with 20+ keys; do NOT use as the production prompt.
const EXTRACT_SYSTEM_PROMPT_V2_LEGACY = `You are a memory extraction assistant. Read the conversation chunk and extract distilled facts — durable units of information that should be remembered across future sessions.

Critical rules (PROMPT_VERSION=2):
- ALREADY KNOWN: when the conversation re-states a fact already listed in <already-known>, do NOT re-emit it. Skip silently.
- DELTA ONLY: when the conversation refines or contradicts a known fact, emit ONLY the new/refined piece, not the whole restated fact.
- IMPORTANCE: a 0.0-1.0 score for retrieval ranking. User preferences/decisions/identity facts get 0.7+; one-off context details 0.3-0.5; trivia 0.1-0.3.
- DEDUPKEY: a stable kebab-case key like "user_preference:morning_standups" so future runs can detect duplicates.

Emit strict JSON only, with no surrounding prose. Schema:
{ "facts": [ { "text": "string", "importance": 0.0..1.0, "dedupKey": "kebab:case" } ] }

If no new facts to emit, output: { "facts": [] }`;

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") parts.push(block.text);
    else if (typeof block.thinking === "string") parts.push(`[thinking] ${block.thinking}`);
  }
  return parts.join("\n");
}

function formatMessageForPrompt(message) {
  const text = stringifyContent(message?.content);
  if (!message?.role || text.length === 0) return "";
  return `${message.role}: ${text}`;
}

function buildV3UserPrompt(messages) {
  const transcript = messages
    .map(formatMessageForPrompt)
    .filter((s) => s.length > 0)
    .join("\n");
  return `<conversation>\n${transcript}\n</conversation>\n\nExtract new facts following the rules.`;
}

function buildV2LegacyUserPrompt(messages, alreadyKnownKeys) {
  const transcript = messages
    .map(formatMessageForPrompt)
    .filter((s) => s.length > 0)
    .join("\n");
  const known = alreadyKnownKeys.length > 0 ? alreadyKnownKeys.join("\n- ") : "(none)";
  return `<already-known>\n- ${known}\n</already-known>\n\n<conversation>\n${transcript}\n</conversation>\n\nExtract new facts following the rules.`;
}

async function loadRecentDedupKeys() {
  const dateDirs = await readdir(L3_L2_ROOT).catch(() => []);
  const allChunkPaths = [];
  for (const dateDir of dateDirs.sort()) {
    const full = path.join(L3_L2_ROOT, dateDir);
    const files = await readdir(full).catch(() => []);
    for (const f of files.sort()) {
      if (f.endsWith(".md")) allChunkPaths.push(path.join(full, f));
    }
  }
  const tail = allChunkPaths.slice(-RECENT_CHUNKS_TO_SCAN);
  const keys = [];
  for (const filePath of tail) {
    const text = await readFile(filePath, "utf8").catch(() => null);
    if (!text) continue;
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!m) continue;
    try {
      const fm = JSON.parse(m[1]);
      if (Array.isArray(fm.dedupKeys)) {
        for (const k of fm.dedupKeys) keys.push(k);
      }
    } catch {
      // skip malformed chunk
    }
  }
  return keys.slice(-RECENT_DEDUP_KEYS_LIMIT);
}

async function resolveZaiKey() {
  const fromEnv = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY;
  if (fromEnv) return { key: fromEnv, source: "env" };
  const authPath = path.join(HOME, ".openclaw/agents/main/agent/auth-profiles.json");
  const text = await readFile(authPath, "utf8").catch(() => null);
  if (!text) throw new Error(`Could not read auth profiles at ${authPath}`);
  const json = JSON.parse(text);
  const key = json?.profiles?.["zai:default"]?.key;
  if (!key) throw new Error(`No zai:default key in ${authPath}`);
  return { key, source: authPath };
}

async function callGlm({ apiKey, systemPrompt, userPrompt }) {
  const t0 = Date.now();
  const resp = await fetch("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
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
  const elapsedMs = Date.now() - t0;
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} in ${elapsedMs}ms: ${text.slice(0, 800)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Non-JSON response in ${elapsedMs}ms: ${text.slice(0, 800)}`);
  }
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    finishReason: json.choices?.[0]?.finish_reason ?? "unknown",
    usage: json.usage ?? {},
    elapsedMs,
  };
}

function tryParse(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty_string" };
  }
  const fenced = /^```(?:json|javascript)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return {
      ok: false,
      reason: "json_parse_error",
      error: String(e),
      candidatePrefix: candidate.slice(0, 200),
      candidateSuffix: candidate.slice(-200),
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "not_object", parsed };
  }
  if (!Array.isArray(parsed.facts)) {
    return { ok: false, reason: "no_facts_array", parsed };
  }
  return {
    ok: true,
    factCount: parsed.facts.length,
    sample: parsed.facts.slice(0, 3),
  };
}

function summarizeContent(messages) {
  const counts = { user: 0, assistant: 0, system: 0, tool: 0, other: 0 };
  let totalChars = 0;
  let heartbeats = 0;
  for (const m of messages) {
    counts[m.role] = (counts[m.role] ?? 0) + 1;
    const text = stringifyContent(m.content);
    totalChars += text.length;
    if (text.trim() === "HEARTBEAT_OK" || text.includes("HEARTBEAT")) heartbeats += 1;
  }
  return { counts, totalChars, heartbeats };
}

async function main() {
  console.log(`# Replay harness`);
  console.log(`Archive: ${ARCHIVE_PATH}`);

  const archiveText = await readFile(ARCHIVE_PATH, "utf8");
  const lines = archiveText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const allMessages = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      allMessages.push(JSON.parse(lines[i]));
    } catch {
      console.error(`! malformed line ${i + 1}, skipping`);
    }
  }
  const messages = MSG_LIMIT ? allMessages.slice(0, MSG_LIMIT) : allMessages;

  const summary = summarizeContent(messages);
  console.log(
    `Loaded ${messages.length} messages (of ${allMessages.length} in archive)` +
      (MSG_LIMIT ? ` — limited to first ${MSG_LIMIT}` : ""),
  );
  console.log(
    `  by role: ${JSON.stringify(summary.counts)}, ${summary.totalChars.toLocaleString()} chars total, ${summary.heartbeats} heartbeat-like`,
  );

  const { key, source } = await resolveZaiKey();
  console.log(`Auth source: ${source} (key ${key.slice(0, 10)}...)`);

  const promptVersion = LEGACY_V2 ? "v2 (legacy regression replay)" : "v3 (production)";
  console.log(`Prompt version: ${promptVersion}`);

  let userPrompt;
  let systemPrompt;
  if (LEGACY_V2) {
    const knownKeys = await loadRecentDedupKeys();
    console.log(
      `already-known keys: ${knownKeys.length}` +
        (knownKeys.length > 0 ? ` — sample: ${knownKeys.slice(0, 5).join(", ")}...` : ""),
    );
    userPrompt = buildV2LegacyUserPrompt(messages, knownKeys);
    systemPrompt = EXTRACT_SYSTEM_PROMPT_V2_LEGACY;
  } else {
    userPrompt = buildV3UserPrompt(messages);
    systemPrompt = EXTRACT_SYSTEM_PROMPT_V3;
  }

  const promptBytes = Buffer.byteLength(userPrompt, "utf8");
  console.log(
    `Prompt: ${promptBytes.toLocaleString()} bytes, ~${Math.round(promptBytes / 4).toLocaleString()} tokens (rough)`,
  );

  console.log(`\nCalling GLM-5.1...`);
  const result = await callGlm({
    apiKey: key,
    systemPrompt,
    userPrompt,
  });

  console.log(`\n=== Response metadata ===`);
  console.log(`  elapsed:       ${result.elapsedMs}ms`);
  console.log(`  finish_reason: ${result.finishReason}`);
  console.log(`  usage:         ${JSON.stringify(result.usage)}`);
  console.log(`  content bytes: ${Buffer.byteLength(result.content, "utf8").toLocaleString()}`);

  console.log(`\n=== Raw response (first 2000 chars) ===`);
  console.log(result.content.slice(0, 2000));
  if (result.content.length > 2000) {
    console.log(`\n... [${result.content.length - 2000} more chars omitted]`);
    console.log(`\n=== Last 500 chars ===`);
    console.log(result.content.slice(-500));
  }

  console.log(`\n=== Parse outcome ===`);
  console.log(JSON.stringify(tryParse(result.content), null, 2));
}

main().catch((e) => {
  console.error(`\nFATAL: ${e.message}`);
  process.exitCode = 1;
});
