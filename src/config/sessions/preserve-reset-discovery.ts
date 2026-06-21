// Keeps a reset/rolled-over dashboard transcript discoverable in the session
// list. Lives in config/sessions (not gateway) so every reset path — the
// gateway reset service AND the reply-session rollover (session-accessor) — can
// reuse one implementation without a config/sessions -> gateway import cycle.
import fs from "node:fs";
import { logVerbose } from "../../globals.js";
import {
  isDashboardSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { snapshotSessionOrigin } from "./metadata.js";
import { updateSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

export function extractFirstUserMessageText(messages: unknown[]): string | undefined {
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user") {
      continue;
    }
    const { content } = record;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((part) => {
          if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") {
            return "";
          }
          const value = (part as { text?: unknown }).text;
          return typeof value === "string" ? value : "";
        })
        .join(" ");
    }
    text = text.trim();
    // Skip system/cron-injected user turns; they are not a real conversation.
    if (text && !text.startsWith("[OpenClaw") && !text.startsWith("[cron")) {
      return text;
    }
  }
  return undefined;
}

// The first real user turn sits near the top of a transcript (after the
// session/model/thinking headers), so a bounded prefix read avoids loading
// multi-MB transcripts whole just to derive a title.
const PRESERVE_RESET_HEAD_BYTES = 256 * 1024;

async function readArchivedHeadMessages(filePath: string): Promise<unknown[]> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.alloc(PRESERVE_RESET_HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, PRESERVE_RESET_HEAD_BYTES, 0);
    const lines = buf.subarray(0, bytesRead).toString("utf-8").split("\n");
    // A full buffer likely cut the final record mid-line; drop the partial.
    if (bytesRead === PRESERVE_RESET_HEAD_BYTES) {
      lines.pop();
    }
    const messages: unknown[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const record = JSON.parse(trimmed) as { type?: unknown; message?: unknown };
        if (record.type === "message" && record.message) {
          messages.push(record.message);
        }
      } catch {
        // Ignore unparseable/partial lines.
      }
    }
    return messages;
  } finally {
    await handle.close();
  }
}

// After a reset archives a dashboard transcript, keep the old conversation
// discoverable: restore a canonical transcript copy and register a
// `previous-<id>` store entry for it so it stays in the session list instead of
// becoming an orphaned file. Pointing at a fresh canonical copy (not the .reset
// archive) keeps the archive an immutable snapshot if the user reopens and
// continues the session. Best effort — never block or fail the reset itself.
export async function preserveResetSessionForDiscovery(params: {
  storePath: string;
  primaryKey: string;
  agentId?: string;
  oldSessionId?: string;
  oldEntry?: SessionEntry;
  archivedPath?: string;
}): Promise<void> {
  const { storePath, primaryKey, oldSessionId, oldEntry, archivedPath } = params;
  // Only webchat/dashboard tabs lose discoverability when reset rotates the
  // session out; channel sessions (Telegram/Signal `/new`) reset routinely and
  // must not spawn a "Previous:" entry on every reset.
  if (!oldSessionId || !archivedPath || !isDashboardSessionKey(primaryKey)) {
    return;
  }
  try {
    const firstUserText = extractFirstUserMessageText(await readArchivedHeadMessages(archivedPath));
    // Nothing the user typed -> nothing worth keeping in the list.
    if (!firstUserText) {
      return;
    }
    // `<sid>.jsonl.reset.<ts>` -> `<sid>.jsonl`; the reset already freed this
    // canonical path by archiving, and the new session uses a different id.
    const canonicalPath = archivedPath.replace(/\.reset\.[^/]+$/, "");
    if (canonicalPath === archivedPath) {
      return;
    }
    if (!fs.existsSync(canonicalPath)) {
      await fs.promises.copyFile(archivedPath, canonicalPath);
    }
    const parsed = parseAgentSessionKey(primaryKey);
    const agentId = normalizeAgentId(params.agentId ?? parsed?.agentId);
    const previousKey = `agent:${agentId}:dashboard:previous-${oldSessionId}`;
    const title = firstUserText.replace(/\s+/g, " ").slice(0, 60);
    await updateSessionStore(storePath, (store) => {
      const existing = store[previousKey];
      if (existing) {
        return existing;
      }
      const entry: SessionEntry = {
        sessionId: oldSessionId,
        sessionFile: canonicalPath,
        updatedAt: oldEntry?.updatedAt ?? Date.now(),
        sessionStartedAt: oldEntry?.sessionStartedAt,
        systemSent: true,
        abortedLastRun: false,
        displayName: `Previous: ${title}`,
        chatType: oldEntry?.chatType,
        origin: snapshotSessionOrigin(oldEntry),
      };
      store[previousKey] = entry;
      return entry;
    });
  } catch (err) {
    logVerbose(`preserve-reset session keep-listed failed: ${String(err)}`);
  }
}
