#!/usr/bin/env node
import crypto from "node:crypto";
/**
 * Bulk-capture session transcripts into Skill Forge sessions directory.
 * Reads .jsonl transcripts (and .zst-compressed archives left by the nightly
 * session prune pass), extracts tool call/error events, and writes
 * them as forge-capturable event bundles.
 *
 * Usage: node scripts/forge-bulk-capture.js [--dry-run]
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const SESSIONS_DIR = path.join(os.homedir(), ".openclaw", "agents", "main", "sessions");
const FORGE_DIR = path.join(os.homedir(), ".openclaw", "skill-forge", "sessions");
const DRY_RUN = process.argv.includes("--dry-run");

function shortHash(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function extractEventsFromJsonl(content) {
  const events = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {}
  }
  return events;
}

function toTrajectoryEvents(rawEvents) {
  // Convert session transcript events to forge trajectory events
  const trajectory = [];
  for (const evt of rawEvents) {
    // Session transcript format: tool calls are inside message.content[]
    if (evt.type === "message" && evt.message) {
      const msg = evt.message;
      const content = Array.isArray(msg.content) ? msg.content : [];

      // User messages
      if (msg.role === "user") {
        const text = content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
        if (text) {
          trajectory.push({
            type: "user.message",
            timestamp: evt.timestamp ?? new Date().toISOString(),
            data: { message: { content: text } },
          });
        }
      }

      // Assistant messages — extract tool calls and text
      if (msg.role === "assistant") {
        for (const block of content) {
          if (block.type === "toolCall") {
            trajectory.push({
              type: "tool.call",
              timestamp: evt.timestamp ?? new Date().toISOString(),
              data: { name: block.name, args: block.arguments },
            });
          }
        }
      }
    }

    // Tool result messages
    if (evt.type === "tool_result") {
      const isError = evt.is_error === true;
      const text =
        typeof evt.content === "string"
          ? evt.content
          : Array.isArray(evt.content)
            ? evt.content.map((c) => c.text ?? "").join("\n")
            : "";
      trajectory.push({
        type: "tool.result",
        timestamp: evt.timestamp ?? new Date().toISOString(),
        data: { name: evt.tool_name ?? evt.name, isError, content: text },
      });
    }

    // Also handle tool_use / tool.call direct format
    if (evt.type === "tool_use" || evt.type === "tool.call") {
      trajectory.push({
        type: "tool.call",
        timestamp: evt.timestamp ?? new Date().toISOString(),
        data: { name: evt.name ?? evt.tool_name, args: evt.input ?? evt.arguments },
      });
    }
  }
  return trajectory;
}

async function main() {
  const entries = await fsp.readdir(SESSIONS_DIR);
  const sessionFiles = entries.filter(
    (e) =>
      (e.endsWith(".jsonl") || e.endsWith(".zst")) &&
      !e.includes("trajectory") &&
      !e.includes(".reset.") &&
      !e.includes(".bak"),
  );

  console.log(`Found ${sessionFiles.length} session transcripts`);

  // Check existing forge captures
  const existingDirs = new Set();
  try {
    const forgeEntries = await fsp.readdir(FORGE_DIR);
    for (const d of forgeEntries) {
      existingDirs.add(d);
    }
  } catch {}

  let captured = 0;
  let skipped = 0;
  let empty = 0;
  let already = 0;

  for (const file of sessionFiles) {
    // Plain transcripts: <id>.jsonl. Archived transcripts (post-prune):
    // <id>.jsonl.deleted.<ts>.<hash>.zst — session id is the prefix before .jsonl
    const sessionId = file.replace(/\.jsonl.*$/, "");
    const sessionFile = path.join(SESSIONS_DIR, file);

    // Check if already captured (match by session ID prefix)
    const prefix = sessionId.slice(0, 12);
    const exists = [...existingDirs].some((d) => d.includes(prefix));
    if (exists) {
      already++;
      continue;
    }

    // Read and parse
    let content;
    try {
      const raw = await fsp.readFile(sessionFile);
      content = (
        file.endsWith(".zst")
          ? zlib.zstdDecompressSync(raw, { maxOutputLength: 512 * 1024 * 1024 })
          : raw
      ).toString("utf8");
    } catch {
      skipped++;
      continue;
    }

    const rawEvents = extractEventsFromJsonl(content);
    if (rawEvents.length === 0) {
      empty++;
      continue;
    }

    // Convert to trajectory events
    const trajectory = toTrajectoryEvents(rawEvents);
    if (trajectory.length === 0) {
      empty++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [dry] ${sessionId.slice(0, 8)}… ${trajectory.length} events`);
      captured++;
      continue;
    }

    // Write to forge sessions dir
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputDir = path.join(FORGE_DIR, `${sessionId}-${timestamp}`);

    try {
      await fsp.mkdir(outputDir, { recursive: true });

      // Write events.jsonl
      const lines = trajectory.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await fsp.writeFile(path.join(outputDir, "events.jsonl"), lines, "utf8");

      // Write manifest
      const manifest = {
        forgeSchema: "openclaw-skill-forge",
        forgeSchemaVersion: 1,
        capturedAt: new Date().toISOString(),
        trigger: "bulk-scan",
        traceId: shortHash(sessionId),
        sessionId,
        eventCount: trajectory.length,
        transcriptEventCount: rawEvents.length,
      };
      await fsp.writeFile(
        path.join(outputDir, "forge-manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        "utf8",
      );

      // Write session-branch.json (minimal)
      const branch = {
        sessionId,
        branchType: "bulk-capture",
        eventCount: trajectory.length,
      };
      await fsp.writeFile(
        path.join(outputDir, "session-branch.json"),
        JSON.stringify(branch, null, 2) + "\n",
        "utf8",
      );

      captured++;
      console.log(`  ✓ ${sessionId.slice(0, 8)}… ${trajectory.length} events`);
    } catch (err) {
      console.log(`  ✗ ${sessionId.slice(0, 8)}… ${err.message}`);
      skipped++;
    }
  }

  console.log("");
  console.log(`Bulk capture complete:`);
  console.log(`  Already captured: ${already}`);
  console.log(`  Newly captured:   ${captured}`);
  console.log(`  Empty sessions:   ${empty}`);
  console.log(`  Skipped/errors:   ${skipped}`);
  console.log(`  Total:            ${sessionFiles.length}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
