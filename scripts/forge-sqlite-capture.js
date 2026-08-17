#!/usr/bin/env node
import crypto from "node:crypto";
/**
 * Capture session transcripts into Skill Forge from the SQLite transcript store.
 *
 * Successor to forge-bulk-capture.js for the post-JSONL era: live transcripts
 * now live in ~/.openclaw/agents/main/agent/openclaw-agent.sqlite (table
 * transcript_events) instead of sessions/*.jsonl. Event semantics mirror
 * forge-bulk-capture.js exactly (user.message / tool.call / tool.result).
 *
 * Usage: node scripts/forge-sqlite-capture.js [--dry-run]
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = path.join(
  os.homedir(),
  ".openclaw",
  "agents",
  "main",
  "agent",
  "openclaw-agent.sqlite",
);
const FORGE_DIR = path.join(os.homedir(), ".openclaw", "skill-forge", "sessions");
const DRY_RUN = process.argv.includes("--dry-run");

function stampNow() {
  return new Date().toISOString().replace(/:/g, "-").slice(0, 19);
}

function toTrajectoryEvents(rawEvents) {
  const trajectory = [];
  for (const evt of rawEvents) {
    if (evt?.type !== "message" || !evt.message) continue;
    const msg = evt.message;
    const ts = evt.timestamp ?? new Date().toISOString();
    const content = Array.isArray(msg.content) ? msg.content : [];

    if (msg.role === "user") {
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      if (text) {
        trajectory.push({
          type: "user.message",
          timestamp: ts,
          data: { message: { content: text } },
        });
      }
    }

    if (msg.role === "assistant") {
      for (const block of content) {
        if (block.type === "toolCall") {
          trajectory.push({
            type: "tool.call",
            timestamp: ts,
            data: { name: block.name, args: block.arguments },
          });
        }
      }
    }

    if (msg.role === "toolResult") {
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      trajectory.push({
        type: "tool.result",
        timestamp: ts,
        data: {
          name: msg.toolName,
          isError: msg.isError === true,
          content: text,
        },
      });
    }
  }
  return trajectory;
}

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db
    .prepare("SELECT session_id, seq, event_json FROM transcript_events ORDER BY session_id, seq")
    .all();

  // Group by session
  const bySession = new Map();
  for (const r of rows) {
    let ev;
    try {
      ev = JSON.parse(r.event_json);
    } catch {
      continue;
    }
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push(ev);
  }
  console.log(`Found ${bySession.size} sessions in transcript store (${rows.length} events)`);

  // Existing forge captures (dedupe by session-id 12-char prefix)
  const existingDirs = new Set();
  try {
    for (const d of await fsp.readdir(FORGE_DIR)) existingDirs.add(d);
  } catch {}

  let captured = 0;
  let already = 0;
  let empty = 0;

  for (const [sessionId, rawEvents] of bySession) {
    const prefix = sessionId.slice(0, 12);
    if ([...existingDirs].some((d) => d.includes(prefix))) {
      already++;
      continue;
    }

    const trajectory = toTrajectoryEvents(rawEvents);
    if (trajectory.length === 0) {
      empty++;
      continue;
    }

    const dirName = `${sessionId}-${stampNow()}`;
    if (DRY_RUN) {
      console.log(`  [dry] ${sessionId.slice(0, 8)}… ${trajectory.length} events`);
      captured++;
      continue;
    }

    const outDir = path.join(FORGE_DIR, dirName);
    await fsp.mkdir(outDir, { recursive: true });
    const lines = trajectory.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fsp.writeFile(path.join(outDir, "events.jsonl"), lines, "utf8");
    await fsp.writeFile(
      path.join(outDir, "forge-manifest.json"),
      JSON.stringify(
        {
          forgeSchema: "openclaw-skill-forge",
          forgeSchemaVersion: 1,
          capturedAt: new Date().toISOString(),
          trigger: "sqlite-scan",
          traceId: crypto.randomBytes(8).toString("hex"),
          sessionId,
          eventCount: trajectory.length,
          transcriptEventCount: rawEvents.length,
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(
      path.join(outDir, "session-branch.json"),
      JSON.stringify(
        { sessionId, branchType: "bulk-capture", eventCount: trajectory.length },
        null,
        2,
      ),
      "utf8",
    );
    existingDirs.add(dirName);
    captured++;
    console.log(`  captured ${sessionId.slice(0, 8)}… ${trajectory.length} events`);
  }

  db.close();
  console.log(`\nSQLite capture complete:`);
  console.log(`  Already captured: ${already}`);
  console.log(`  Newly captured:   ${captured}`);
  console.log(`  Empty sessions:   ${empty}`);
}

main().catch((e) => {
  console.error("Capture failed:", e);
  process.exit(1);
});
