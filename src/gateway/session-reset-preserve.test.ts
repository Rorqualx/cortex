import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractFirstUserMessageText,
  preserveResetSessionForDiscovery,
} from "../config/sessions/preserve-reset-discovery.js";

async function seedArchive(dir: string, sessionId: string, userText: string) {
  const archivedPath = path.join(dir, `${sessionId}.jsonl.reset.2026-06-17T20-57-45.973Z`);
  const lines = [
    { type: "session", id: sessionId },
    { type: "message", id: "u1", message: { role: "user", content: userText } },
    { type: "message", id: "a1", message: { role: "assistant", content: "ok" } },
  ];
  await writeFile(archivedPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf-8");
  return archivedPath;
}

describe("extractFirstUserMessageText", () => {
  it("returns the first user string message", () => {
    expect(
      extractFirstUserMessageText([
        { role: "assistant", content: "hi" },
        { role: "user", content: "  research claude code  " },
        { role: "user", content: "second" },
      ]),
    ).toBe("research claude code");
  });

  it("joins text parts from array content", () => {
    expect(
      extractFirstUserMessageText([
        {
          role: "user",
          content: [
            { type: "text", text: "best way" },
            { type: "image", url: "x" },
            { type: "text", text: "to talk" },
          ],
        },
      ]),
    ).toBe("best way  to talk");
  });

  it("skips OpenClaw/cron injected turns", () => {
    expect(
      extractFirstUserMessageText([
        { role: "user", content: "[OpenClaw heartbeat poll]" },
        { role: "user", content: "[cron:abc] do thing" },
        { role: "user", content: "real question" },
      ]),
    ).toBe("real question");
  });

  it("returns undefined when there is no genuine user message", () => {
    expect(
      extractFirstUserMessageText([{ role: "assistant", content: "only me" }]),
    ).toBeUndefined();
    expect(extractFirstUserMessageText([])).toBeUndefined();
    expect(extractFirstUserMessageText([{ role: "user", content: "   " }])).toBeUndefined();
  });
});

describe("preserveResetSessionForDiscovery", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  async function tempDir() {
    const dir = await mkdtemp(path.join(tmpdir(), "preserve-reset-"));
    dirs.push(dir);
    return dir;
  }
  async function readStore(storePath: string) {
    return JSON.parse(await readFile(storePath, "utf-8")) as Record<
      string,
      { sessionId?: string; sessionFile?: string; displayName?: string }
    >;
  }

  it("registers a Previous: entry and restores a canonical transcript", async () => {
    const dir = await tempDir();
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const archivedPath = await seedArchive(dir, sessionId, "research the latest claude code");
    const storePath = path.join(dir, "sessions.json");
    await writeFile(storePath, "{}\n", "utf-8");

    await preserveResetSessionForDiscovery({
      storePath,
      primaryKey: "agent:main:dashboard:tab-1",
      oldSessionId: sessionId,
      archivedPath,
    });

    const store = await readStore(storePath);
    const entry = store[`agent:main:dashboard:previous-${sessionId}`];
    expect(entry).toBeDefined();
    expect(entry?.sessionId).toBe(sessionId);
    expect(entry?.displayName).toBe("Previous: research the latest claude code");
    // Points at a restored canonical copy, not the .reset archive snapshot.
    const canonicalPath = path.join(dir, `${sessionId}.jsonl`);
    expect(entry?.sessionFile).toBe(canonicalPath);
    await expect(readFile(canonicalPath, "utf-8")).resolves.toContain("research the latest");
  });

  it("skips non-dashboard sessions and empty conversations", async () => {
    const dir = await tempDir();
    const storePath = path.join(dir, "sessions.json");
    await writeFile(storePath, "{}\n", "utf-8");

    // Channel (non-dashboard) key -> skipped even with content.
    const channelSid = "aaaaaaaa-0000-0000-0000-000000000000";
    await preserveResetSessionForDiscovery({
      storePath,
      primaryKey: "agent:main:telegram:direct:123",
      oldSessionId: channelSid,
      archivedPath: await seedArchive(dir, channelSid, "hi from telegram"),
    });

    // Dashboard key but the archive has no real user turn -> skipped.
    const emptySid = "bbbbbbbb-0000-0000-0000-000000000000";
    const emptyArchive = path.join(dir, `${emptySid}.jsonl.reset.2026-06-17T00-00-00.000Z`);
    await writeFile(
      emptyArchive,
      `${JSON.stringify({ type: "session", id: emptySid })}\n`,
      "utf-8",
    );
    await preserveResetSessionForDiscovery({
      storePath,
      primaryKey: "agent:main:dashboard:tab-2",
      oldSessionId: emptySid,
      archivedPath: emptyArchive,
    });

    expect(Object.keys(await readStore(storePath))).toHaveLength(0);
  });
});
