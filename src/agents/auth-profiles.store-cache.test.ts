import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import { inspectPersistedAuthProfileStoreRaw } from "./auth-profiles/sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { clearRuntimeAuthProfileStoreSnapshot } from "./auth-profiles/store.js";
import type { ApiKeyCredential, OAuthCredential } from "./auth-profiles/types.js";

type RuntimeOnlyOverlay = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

const mocks = vi.hoisted(() => ({
  resolveExternalCliAuthProfiles: vi.fn<
    (store?: unknown, options?: unknown) => RuntimeOnlyOverlay[]
  >(() => []),
}));

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: mocks.resolveExternalCliAuthProfiles,
}));

function apiKeyStore(key: string): { version: number; profiles: Record<string, ApiKeyCredential> } {
  return {
    version: AUTH_STORE_VERSION,
    profiles: {
      "openai:default": { type: "api_key", provider: "openai", key },
    },
  };
}

// Env-scoped temp agent dir so sqlite store resolution stays inside the sandbox.
// 2026-09-06 resync note: this suite was reduced to the cache properties that
// survived upstream's sqlite store restructure. The retired JSON-file subjects
// (file mtime cache, auth-profiles.json.lock contention, unscoped persisted CLI
// overlays) are owned by auth-profiles.sqlite-store.test.ts (revision-keyed
// handles, runtime-only overlay recompute), external-oauth.test.ts (scoped CLI
// refresh/persist), and upsert-with-lock.sqlite.test.ts (locked writes).
async function withAgentDirEnv(
  prefix: string,
  run: (agentDir: string, root: string) => void | Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const agentDir = path.join(root, "agents", "main", "agent");
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = root;
  process.env.OPENCLAW_AGENT_DIR = agentDir;
  try {
    await run(agentDir, root);
  } finally {
    clearRuntimeAuthProfileStoreSnapshot();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("auth profile store cache", () => {
  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshot();
    mocks.resolveExternalCliAuthProfiles.mockReset();
    mocks.resolveExternalCliAuthProfiles.mockReturnValue([]);
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshot();
  });

  it("refreshes the cached auth store after the persisted sqlite store changes", async () => {
    await withAgentDirEnv("openclaw-auth-store-refresh-", async (agentDir) => {
      saveAuthProfileStore(apiKeyStore("sk-test-1"), agentDir);

      ensureAuthProfileStore(agentDir);

      saveAuthProfileStore(apiKeyStore("sk-test-2"), agentDir);

      const reloaded = ensureAuthProfileStore(agentDir);

      expect((reloaded.profiles["openai:default"] as { key?: string } | undefined)?.key).toBe(
        "sk-test-2",
      );
    });
  });

  it("isolates cached auth stores without structuredClone", async () => {
    const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");
    await withAgentDirEnv("openclaw-auth-store-isolated-", async (agentDir) => {
      saveAuthProfileStore(apiKeyStore("sk-test"), agentDir);

      const first = ensureAuthProfileStore(agentDir);
      const profile = first.profiles["openai:default"];
      if (profile?.type === "api_key") {
        profile.key = "sk-mutated";
      }
      first.profiles["anthropic:default"] = {
        type: "api_key",
        provider: "anthropic",
        key: "sk-added",
      };

      const second = ensureAuthProfileStore(agentDir);
      expect((second.profiles["openai:default"] as { key?: string } | undefined)?.key).toBe(
        "sk-test",
      );
      expect(second.profiles["anthropic:default"]).toBeUndefined();
      // The store cache must clone without structuredClone. Unrelated subsystems
      // (plugin registry materialization) legitimately clone their own payloads,
      // so only store-shaped arguments are guarded here.
      const storeShapeCloneCalls = structuredCloneSpy.mock.calls.filter(([value]) => {
        const record = value as Record<string, unknown> | undefined;
        return record != null && typeof record === "object" && "profiles" in record;
      });
      expect(storeShapeCloneCalls).toEqual([]);
    });
    structuredCloneSpy.mockRestore();
  });

  it("keeps runtime-only external auth out of the persisted sqlite store", async () => {
    mocks.resolveExternalCliAuthProfiles.mockReturnValue([
      {
        profileId: "openai:default",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "access-1",
          refresh: "refresh-1",
          expires: Date.now() + 60_000,
        },
      },
    ]);

    await withAgentDirEnv("openclaw-auth-store-missing-", (agentDir) => {
      const store = ensureAuthProfileStore(agentDir);

      expect((store.profiles["openai:default"] as OAuthCredential | undefined)?.access).toBe(
        "access-1",
      );
      expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
      expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
    });
  });
});
