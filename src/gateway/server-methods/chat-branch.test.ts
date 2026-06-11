// Tests for chat.branch rewind semantics, including the edit flow's "before" mode.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let sessionFileForTest = "";

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: () => ({
    entry: { sessionFile: sessionFileForTest, sessionId: "test-session" },
    canonicalKey: "agent:main:test",
    storePath: "/tmp/unused-store.json",
  }),
}));

const { chatBranchHandlers } = await import("./chat-branch.js");

type RespondCall = { ok: boolean; payload?: unknown; error?: unknown };

function writeSessionFile(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-branch-test-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return file;
}

function transcriptEntries(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function callChatBranch(params: Record<string, unknown>): Promise<RespondCall> {
  let result: RespondCall | undefined;
  await chatBranchHandlers["chat.branch"]({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      result = { ok, payload, error };
    },
    context: {} as never,
  } as never);
  if (!result) {
    throw new Error("chat.branch did not respond");
  }
  return result;
}

const BASE_ENTRIES = [
  { type: "session", version: 3, id: "test-session", timestamp: "2026-06-10T00:00:00.000Z" },
  {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-06-10T00:00:01.000Z",
    message: { id: "m1", role: "user", content: "first" },
  },
  {
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-06-10T00:00:02.000Z",
    message: { id: "m2", role: "assistant", content: "reply" },
  },
  {
    type: "message",
    id: "e3",
    parentId: "e2",
    timestamp: "2026-06-10T00:00:03.000Z",
    message: { id: "m3", role: "user", content: "second" },
  },
];

afterEach(() => {
  if (sessionFileForTest) {
    fs.rmSync(path.dirname(sessionFileForTest), { recursive: true, force: true });
    sessionFileForTest = "";
  }
});

describe("chat.branch", () => {
  it("default mode parents the branch marker on the target entry", async () => {
    sessionFileForTest = writeSessionFile(BASE_ENTRIES);

    const result = await callChatBranch({ sessionKey: "agent:main:test", messageId: "m3" });

    expect(result.ok).toBe(true);
    expect((result.payload as { branchFromId?: string }).branchFromId).toBe("e3");
    const marker = transcriptEntries(sessionFileForTest).at(-1);
    expect(marker?.customType).toBe("branch_marker");
    expect(marker?.parentId).toBe("e3");
  });

  it("mode 'before' parents the marker on the target's parent so the edit replaces it", async () => {
    sessionFileForTest = writeSessionFile(BASE_ENTRIES);

    const result = await callChatBranch({
      sessionKey: "agent:main:test",
      messageId: "m3",
      mode: "before",
    });

    expect(result.ok).toBe(true);
    expect((result.payload as { branchFromId?: string }).branchFromId).toBe("e2");
    const marker = transcriptEntries(sessionFileForTest).at(-1);
    expect(marker?.customType).toBe("branch_marker");
    expect(marker?.parentId).toBe("e2");
  });

  it("mode 'before' on a root message rewinds to an empty branch", async () => {
    sessionFileForTest = writeSessionFile(BASE_ENTRIES);

    const result = await callChatBranch({
      sessionKey: "agent:main:test",
      messageId: "m1",
      mode: "before",
    });

    expect(result.ok).toBe(true);
    expect((result.payload as { branchFromId?: string | null }).branchFromId).toBeNull();
    const marker = transcriptEntries(sessionFileForTest).at(-1);
    expect(marker?.customType).toBe("branch_marker");
    expect(marker?.parentId).toBeNull();
  });

  it("rejects an invalid mode", async () => {
    sessionFileForTest = writeSessionFile(BASE_ENTRIES);

    const result = await callChatBranch({
      sessionKey: "agent:main:test",
      messageId: "m3",
      mode: "sideways",
    });

    expect(result.ok).toBe(false);
  });
});
