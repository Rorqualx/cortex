// Tests for chat.branch rewind semantics, including the edit flow's "before" mode.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptEventSync,
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
  type SessionTranscriptReadScope,
} from "../../config/sessions/session-accessor.js";
import { withEnvAsync } from "../../test-utils/env.js";

const SESSION_ID = "test-session";
const SESSION_KEY = "agent:main:test";

// Rewritten per fixture: the mocked gateway wrapper only supplies the session
// identity, while the transcript itself lives in the fixture's SQLite store.
let storePathForTest = "";
// When true, the mock returns no entry (simulates a new thread with no session yet)
let mockSessionMissing = false;

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: () => {
    if (mockSessionMissing) {
      return { entry: undefined, canonicalKey: SESSION_KEY, storePath: storePathForTest };
    }
    return {
      entry: { sessionId: SESSION_ID },
      canonicalKey: SESSION_KEY,
      storePath: storePathForTest,
    };
  },
}));

const { chatBranchHandlers } = await import("./chat-branch.js");

type RespondCall = { ok: boolean; payload?: unknown; error?: unknown };

function transcriptScope(): SessionTranscriptReadScope {
  return {
    agentId: "main",
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    storePath: storePathForTest,
  };
}

/**
 * Seeds the fixture transcript through the same accessor production uses.
 * Message rows must go through appendTranscriptMessage — the raw event writer
 * rejects them so parent-link and redaction invariants cannot be bypassed.
 */
async function seedTranscript(entries: Array<Record<string, unknown>>): Promise<void> {
  let now = 0;
  for (const entry of entries) {
    now += 1;
    if (entry.type === "message") {
      await appendTranscriptMessage(transcriptScope(), {
        eventId: entry.id as string,
        parentId: (entry.parentId ?? null) as string | null,
        // The whole message is forwarded: chat.branch resolves `messageId`
        // against the stored message id, so dropping it silently changes which
        // entry a rewind targets.
        message: entry.message as never,
        now,
      });
      continue;
    }
    appendTranscriptEventSync(transcriptScope(), entry as never);
  }
}

function transcriptEntries(): Array<Record<string, unknown>> {
  return loadTranscriptEventsSync(transcriptScope()) as Array<Record<string, unknown>>;
}

async function withTranscript(
  entries: Array<Record<string, unknown>>,
  run: () => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-branch-test-"));
  storePathForTest = path.join(dir, "sessions.json");
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: SESSION_KEY, storePath: storePathForTest },
        { sessionId: SESSION_ID, updatedAt: 1 },
      );
      await seedTranscript(entries);
      await run();
    });
  } finally {
    storePathForTest = "";
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function callChatBranch(params: Record<string, unknown>): Promise<RespondCall> {
  let result: RespondCall | undefined;
  const handler = chatBranchHandlers["chat.branch"];
  if (!handler) throw new Error("chat.branch handler not registered");
  await handler({
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
  const handler = chatBranchHandlers["chat.branches"];
  if (!handler) throw new Error("chat.branches handler not registered");
  await handler({
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
    message: { id: `m-${id}`, role, content },
  };
}

const BASE_ENTRIES = [
  message("e1", null, "user", "first"),
  message("e2", "e1", "assistant", "reply"),
  message("e3", "e2", "user", "second"),
];

describe("chat.branch", () => {
  it("default mode parents the branch marker on the target entry", async () => {
    await withTranscript(BASE_ENTRIES, async () => {
      const result = await callChatBranch({ sessionKey: SESSION_KEY, messageId: "m-e3" });

      expect(result.ok).toBe(true);
      expect((result.payload as { branchFromId?: string }).branchFromId).toBe("e3");
      const marker = transcriptEntries().at(-1);
      expect(marker?.customType).toBe("branch_marker");
      expect(marker?.parentId).toBe("e3");
    });
  });

  it("mode 'before' parents the marker on the target's parent so the edit replaces it", async () => {
    await withTranscript(BASE_ENTRIES, async () => {
      const result = await callChatBranch({
        sessionKey: SESSION_KEY,
        messageId: "m-e3",
        mode: "before",
      });

      expect(result.ok).toBe(true);
      expect((result.payload as { branchFromId?: string }).branchFromId).toBe("e2");
      const marker = transcriptEntries().at(-1);
      expect(marker?.customType).toBe("branch_marker");
      expect(marker?.parentId).toBe("e2");
    });
  });

  it("mode 'before' on a root message rewinds to an empty branch", async () => {
    await withTranscript(BASE_ENTRIES, async () => {
      const result = await callChatBranch({
        sessionKey: SESSION_KEY,
        messageId: "m-e1",
        mode: "before",
      });

      expect(result.ok).toBe(true);
      expect((result.payload as { branchFromId?: string | null }).branchFromId).toBeNull();
      const marker = transcriptEntries().at(-1);
      expect(marker?.customType).toBe("branch_marker");
      expect(marker?.parentId).toBeNull();
    });
  });

  it("rejects an invalid mode", async () => {
    await withTranscript(BASE_ENTRIES, async () => {
      const result = await callChatBranch({
        sessionKey: SESSION_KEY,
        messageId: "m-e3",
        mode: "sideways",
      });

      expect(result.ok).toBe(false);
    });
  });

  it("mode 'select' resumes a sibling's deepest leaf", async () => {
    // e1 forks into the active branch (e2) and an abandoned sibling (eA → eB).
    await withTranscript(
      [
        message("e1", null, "user", "first"),
        message("e2", "e1", "assistant", "active reply"),
        message("eA", "e1", "assistant", "sibling reply"),
        message("eB", "eA", "user", "sibling follow-up"),
      ],
      async () => {
        const result = await callChatBranch({
          sessionKey: SESSION_KEY,
          entryId: "eA",
          mode: "select",
        });

        expect(result.ok).toBe(true);
        // The marker parents on eB, the sibling's tip, so its whole branch reappears.
        expect((result.payload as { branchFromId?: string }).branchFromId).toBe("eB");
        const marker = transcriptEntries().at(-1);
        expect(marker?.customType).toBe("branch_marker");
        expect(marker?.parentId).toBe("eB");
      },
    );
  });
});

describe("chat.branches", () => {
  it("derives branch points and the active path from the canonical leaf tree", async () => {
    // Edit-of-first-message shape: the abandoned original (e1/e2) sits off the
    // active leaf; the marker M is the active root child leading to the edit.
    await withTranscript(
      [
        message("e1", null, "user", "first"),
        message("e2", "e1", "assistant", "reply"),
        {
          type: "custom",
          customType: "branch_marker",
          id: "M",
          parentId: null,
          branchFromId: null,
        },
        message("e4", "M", "user", "edited first"),
        message("e5", "e4", "assistant", "edited reply"),
      ],
      async () => {
        const result = await callChatBranches({ sessionKey: SESSION_KEY });

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
      },
    );
  });

  it("follows a trailing leaf control instead of the last physical entry", async () => {
    // A leaf control redirects the active leaf back to e1, the way the naive
    // last-entry-wins walk never would.
    await withTranscript(
      [
        message("e1", null, "user", "first"),
        message("e2", "e1", "assistant", "reply"),
        {
          type: "custom",
          customType: "branch_marker",
          id: "M",
          parentId: null,
          branchFromId: null,
        },
        message("e4", "M", "user", "edited first"),
        message("e5", "e4", "assistant", "edited reply"),
        { type: "leaf", id: "L", parentId: "e5", targetId: "e1" },
      ],
      async () => {
        const result = await callChatBranches({ sessionKey: SESSION_KEY });

        expect(result.ok).toBe(true);
        const payload = result.payload as BranchesPayload;
        expect(payload.activeLeafId).toBe("e1");
        expect(payload.activePath).toEqual(["e1"]);
        // The active child flips to e1 now that the leaf control selects it.
        expect(payload.branches[0]).toMatchObject({
          childIds: ["e1", "M"],
          activeChildId: "e1",
        });
      },
    );
  });

  it("returns empty branches when session does not exist yet (new thread)", async () => {
    mockSessionMissing = true;
    try {
      const result = await callChatBranches({ sessionKey: SESSION_KEY });
      expect(result.ok).toBe(true);
      const payload = result.payload as BranchesPayload;
      expect(payload.activeLeafId).toBeNull();
      expect(payload.branches).toEqual([]);
      expect(payload.activePath).toEqual([]);
    } finally {
      mockSessionMissing = false;
    }
  });
});
