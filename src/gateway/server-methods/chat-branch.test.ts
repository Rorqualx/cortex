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

async function callChatBranches(params: Record<string, unknown>): Promise<RespondCall> {
  let result: RespondCall | undefined;
  await chatBranchHandlers["chat.branches"]({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      result = { ok, payload, error };
    },
    context: {} as never,
  } as never);
  if (!result) {
    throw new Error("chat.branches did not respond");
  }
  return result;
}

type BranchesPayload = {
  activeLeafId: string | null;
  activePath: string[];
  branches: Array<{
    entryId: string;
    childCount: number;
    childIds: string[];
    activeChildId: string | null;
    isActive: boolean;
  }>;
};

function message(
  id: string,
  parentId: string | null,
  role: string,
  content: string,
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-06-10T00:00:0${id.length}.000Z`,
    message: { id: `m-${id}`, role, content },
  };
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

  it("mode 'select' resumes a sibling's deepest leaf", async () => {
    // e1 forks into the active branch (e2) and an abandoned sibling (eA → eB).
    sessionFileForTest = writeSessionFile([
      { type: "session", version: 3, id: "test-session", timestamp: "2026-06-10T00:00:00.000Z" },
      message("e1", null, "user", "first"),
      message("e2", "e1", "assistant", "active reply"),
      message("eA", "e1", "assistant", "sibling reply"),
      message("eB", "eA", "user", "sibling follow-up"),
    ]);

    const result = await callChatBranch({
      sessionKey: "agent:main:test",
      entryId: "eA",
      mode: "select",
    });

    expect(result.ok).toBe(true);
    // The marker parents on eB, the sibling's tip, so its whole branch reappears.
    expect((result.payload as { branchFromId?: string }).branchFromId).toBe("eB");
    const marker = transcriptEntries(sessionFileForTest).at(-1);
    expect(marker?.customType).toBe("branch_marker");
    expect(marker?.parentId).toBe("eB");
  });
});

describe("chat.branches", () => {
  it("derives branch points and the active path from the canonical leaf tree", async () => {
    // Edit-of-first-message shape: the abandoned original (e1/e2) sits off the
    // active leaf; the marker M is the active root child leading to the edit.
    sessionFileForTest = writeSessionFile([
      { type: "session", version: 3, id: "test-session", timestamp: "2026-06-10T00:00:00.000Z" },
      message("e1", null, "user", "first"),
      message("e2", "e1", "assistant", "reply"),
      { type: "custom", customType: "branch_marker", id: "M", parentId: null, branchFromId: null },
      message("e4", "M", "user", "edited first"),
      message("e5", "e4", "assistant", "edited reply"),
    ]);

    const result = await callChatBranches({ sessionKey: "agent:main:test" });

    expect(result.ok).toBe(true);
    const payload = result.payload as BranchesPayload;
    expect(payload.activeLeafId).toBe("e5");
    // Abandoned e1/e2 are excluded; the active path runs through the marker.
    expect(payload.activePath).toEqual(["M", "e4", "e5"]);
    expect(payload.branches).toHaveLength(1);
    expect(payload.branches[0]).toMatchObject({
      childCount: 2,
      childIds: ["e1", "M"],
      activeChildId: "M",
      isActive: true,
    });
  });

  it("follows a trailing leaf control instead of the last physical entry", async () => {
    // A leaf control redirects the active leaf back to e1, the way the naive
    // last-entry-wins walk never would.
    sessionFileForTest = writeSessionFile([
      { type: "session", version: 3, id: "test-session", timestamp: "2026-06-10T00:00:00.000Z" },
      message("e1", null, "user", "first"),
      message("e2", "e1", "assistant", "reply"),
      { type: "custom", customType: "branch_marker", id: "M", parentId: null, branchFromId: null },
      message("e4", "M", "user", "edited first"),
      message("e5", "e4", "assistant", "edited reply"),
      { type: "leaf", id: "L", parentId: "e5", targetId: "e1" },
    ]);

    const result = await callChatBranches({ sessionKey: "agent:main:test" });

    expect(result.ok).toBe(true);
    const payload = result.payload as BranchesPayload;
    expect(payload.activeLeafId).toBe("e1");
    expect(payload.activePath).toEqual(["e1"]);
    // The active child flips to e1 now that the leaf control selects it.
    expect(payload.branches[0]).toMatchObject({
      childIds: ["e1", "M"],
      activeChildId: "e1",
    });
  });
});
