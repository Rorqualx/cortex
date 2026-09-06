import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderExternalAuthProfile } from "../plugins/provider-external-auth.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { AUTH_STORE_VERSION, authProfilesLog as log } from "./auth-profiles/constants.js";
import { testing as externalAuthTesting } from "./auth-profiles/external-auth.test-support.js";
import { AuthProfileStoreUnreadableError } from "./auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "./auth-profiles/persisted.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "./auth-profiles/sqlite.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
} from "./auth-profiles/store-runtime.js";
import { clearRuntimeAuthProfileStoreSnapshot } from "./auth-profiles/store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";

const resolveExternalAuthProfilesWithPluginsMock = vi.hoisted(() =>
  vi.fn<() => ProviderExternalAuthProfile[]>(() => []),
);

vi.mock("./cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: () => null,
  readCodexCliCredentialsCached: () => {
    const codexHome = process.env.CODEX_HOME;
    if (!codexHome) {
      return null;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")) as {
        tokens?: {
          access_token?: unknown;
          refresh_token?: unknown;
          account_id?: unknown;
        };
      };
      const access = raw.tokens?.access_token;
      const refresh = raw.tokens?.refresh_token;
      if (typeof access !== "string" || typeof refresh !== "string") {
        return null;
      }
      return {
        type: "oauth",
        provider: "openai",
        access,
        refresh,
        expires: Date.now() + 60 * 60 * 1000,
        accountId: typeof raw.tokens?.account_id === "string" ? raw.tokens.account_id : undefined,
      };
    } catch {
      return null;
    }
  },
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: vi.fn(),
}));

describe("ensureAuthProfileStore", () => {
  beforeEach(() => {
    externalAuthTesting.setResolveExternalAuthProfilesForTest(
      resolveExternalAuthProfilesWithPluginsMock,
    );
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshot();
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  });

  // Env-scoped temp agent dir (state dir + agent dir inside a throwaway root) so
  // sqlite store resolution and shared-store discovery stay inside the sandbox.
  function withTempAgentDir<T>(prefix: string, run: (agentDir: string) => T): T {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const agentDir = path.join(root, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    fs.mkdirSync(agentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = root;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    try {
      return run(agentDir);
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

  // Seeds an arbitrary raw payload into the persisted sqlite store cell;
  // load-path normalization is what the tests below assert.
  function writeAuthProfileStore(agentDir: string, profiles: Record<string, unknown>): void {
    writePersistedAuthProfileStoreRaw({ version: AUTH_STORE_VERSION, profiles }, agentDir);
  }

  function writeRawAuthProfileStore(agentDir: string, raw: unknown): void {
    writePersistedAuthProfileStoreRaw(raw, agentDir);
  }

  function loadAuthProfile(agentDir: string, profileId: string): AuthProfileCredential {
    clearRuntimeAuthProfileStoreSnapshot();
    const store = ensureAuthProfileStore(agentDir);
    const profile = store.profiles[profileId];
    if (!profile) {
      throw new Error(`expected auth profile ${profileId}`);
    }
    return profile;
  }

  function restoreEnvValue(name: string, previous: string | undefined): void {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }

  function restoreAgentDirEnv(params: {
    previousStateDir?: string | undefined;
    previousAgentDir: string | undefined;
  }): void {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if ("previousStateDir" in params) {
      restoreEnvValue("OPENCLAW_STATE_DIR", params.previousStateDir);
    }
    restoreEnvValue("OPENCLAW_AGENT_DIR", params.previousAgentDir);
  }

  function configureMainAuthTestDirs(root: string): {
    mainDir: string;
    agentDir: string;
    previousStateDir: string | undefined;
    previousAgentDir: string | undefined;
  } {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const mainDir = path.join(root, "agents", "main", "agent");
    const agentDir = path.join(root, "agents", "agent-x", "agent");
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    process.env.OPENCLAW_STATE_DIR = root;
    process.env.OPENCLAW_AGENT_DIR = mainDir;
    clearRuntimeAuthProfileStoreSnapshot();
    return { mainDir, agentDir, previousStateDir, previousAgentDir };
  }

  function expectApiKeyProfile(
    profile: AuthProfileCredential,
  ): Extract<AuthProfileCredential, { type: "api_key" }> {
    expect(profile.type).toBe("api_key");
    if (profile.type !== "api_key") {
      throw new Error(`Expected api_key profile, got ${profile.type}`);
    }
    return profile;
  }

  function expectTokenProfile(
    profile: AuthProfileCredential,
  ): Extract<AuthProfileCredential, { type: "token" }> {
    expect(profile.type).toBe("token");
    if (profile.type !== "token") {
      throw new Error(`Expected token profile, got ${profile.type}`);
    }
    return profile;
  }

  function expectRecordFields(
    value: unknown,
    expected: Record<string, unknown>,
    message?: string,
  ): void {
    const record = value as Record<string, unknown> | undefined;
    for (const [key, expectedValue] of Object.entries(expected)) {
      expect(record?.[key], message ? `${message}:${key}` : key).toEqual(expectedValue);
    }
  }

  it("rejects array-shaped persisted store payloads instead of loading numeric profile ids", () => {
    withTempAgentDir("openclaw-auth-profiles-array-", (agentDir) => {
      writeRawAuthProfileStore(agentDir, {
        version: AUTH_STORE_VERSION,
        profiles: [
          {
            type: "api_key",
            provider: "openai",
            key: "test-array-shaped-profile",
          },
        ],
      });

      expect(() => ensureAuthProfileStore(agentDir)).toThrow(AuthProfileStoreUnreadableError);
    });
  });

  it("rejects top-level array persisted store payloads instead of treating entries as profiles", () => {
    withTempAgentDir("openclaw-auth-top-array-", (agentDir) => {
      writeRawAuthProfileStore(agentDir, [
        {
          type: "api_key",
          provider: "openai",
          key: "test-array-shaped-store",
        },
      ]);

      expect(() => ensureAuthProfileStore(agentDir)).toThrow(AuthProfileStoreUnreadableError);
    });
  });

  it("merges main auth profiles into agent store and keeps agent overrides", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-merge-"));
    const { mainDir, agentDir, previousStateDir, previousAgentDir } =
      configureMainAuthTestDirs(root);
    try {
      const mainStore: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "main-key",
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "main-anthropic-key",
          },
        },
      };
      saveAuthProfileStore(mainStore, mainDir);

      const agentStore: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "agent-key",
          },
        },
      };
      saveAuthProfileStore(agentStore, agentDir);

      const store = ensureAuthProfileStore(agentDir);
      expectRecordFields(store.profiles["anthropic:default"], {
        type: "api_key",
        provider: "anthropic",
        key: "main-anthropic-key",
      });
      expectRecordFields(store.profiles["openai:default"], {
        type: "api_key",
        provider: "openai",
        key: "agent-key",
      });
    } finally {
      restoreAgentDirEnv({ previousStateDir, previousAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the main agent's newer OAuth profile when an agent still has a stale default profile", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-drift-"));
    const { mainDir, agentDir, previousStateDir, previousAgentDir } =
      configureMainAuthTestDirs(root);
    try {
      const freshProfileId = "openai:user@example.com";
      const staleProfileId = "openai:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "main-access",
              refresh: "main-refresh",
              expires: Date.now() + 60 * 60 * 1000,
              email: "user@example.com",
            },
          },
          order: {
            openai: [freshProfileId],
          },
          lastGood: {
            openai: freshProfileId,
          },
        },
        mainDir,
      );
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "stale-identity-access",
              refresh: "stale-identity-refresh",
              expires: Date.now() - 30 * 60 * 1000,
              email: "user@example.com",
            },
            [staleProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() - 60 * 60 * 1000,
              accountId: "acct-from-old-codex-auth",
            },
          },
          order: {
            openai: [staleProfileId],
          },
          lastGood: {
            openai: staleProfileId,
          },
          usageStats: {
            [staleProfileId]: {
              lastUsed: Date.now() - 30_000,
              errorCount: 3,
            },
          },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshot();

      const store = loadAuthProfileStoreForRuntime(agentDir, { readOnly: true });

      expectRecordFields(store.profiles[freshProfileId], {
        type: "oauth",
        provider: "openai",
        access: "main-access",
        refresh: "main-refresh",
      });
      expect(store.profiles[staleProfileId]).toBeUndefined();
      expect(store.order?.["openai"]).toEqual([freshProfileId]);
      expect(store.lastGood?.["openai"]).toBe(freshProfileId);
      expect(store.usageStats?.[staleProfileId]).toBeUndefined();

      const persistedAgentStore = loadPersistedAuthProfileStore(agentDir);
      expect(persistedAgentStore?.profiles).toHaveProperty(staleProfileId);
    } finally {
      restoreAgentDirEnv({ previousStateDir, previousAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a newer agent replacement credential while repairing stale default references", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-drift-newer-agent-"));
    const { mainDir, agentDir, previousStateDir, previousAgentDir } =
      configureMainAuthTestDirs(root);
    try {
      const freshProfileId = "openai:user@example.com";
      const staleProfileId = "openai:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "older-main-access",
              refresh: "older-main-refresh",
              expires: Date.now() + 30 * 60 * 1000,
              email: "user@example.com",
            },
          },
          order: {
            openai: [freshProfileId],
          },
        },
        mainDir,
      );
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "newer-agent-access",
              refresh: "newer-agent-refresh",
              expires: Date.now() + 90 * 60 * 1000,
              email: "user@example.com",
            },
            [staleProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() - 60 * 60 * 1000,
              email: "user@example.com",
            },
          },
          order: {
            openai: [staleProfileId],
          },
          lastGood: {
            openai: staleProfileId,
          },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshot();

      const store = loadAuthProfileStoreForRuntime(agentDir, { readOnly: true });

      expectRecordFields(store.profiles[freshProfileId], {
        type: "oauth",
        provider: "openai",
        access: "newer-agent-access",
        refresh: "newer-agent-refresh",
      });
      expect(store.profiles[staleProfileId]).toBeUndefined();
      expect(store.order?.["openai"]).toEqual([freshProfileId]);
      expect(store.lastGood?.["openai"]).toBe(freshProfileId);
    } finally {
      restoreAgentDirEnv({ previousStateDir, previousAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a valid main default OAuth profile while replacing a stale agent override", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-drift-base-default-"));
    const { mainDir, agentDir, previousStateDir, previousAgentDir } =
      configureMainAuthTestDirs(root);
    try {
      const freshProfileId = "openai:user@example.com";
      const defaultProfileId = "openai:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "main-access",
              refresh: "main-refresh",
              expires: Date.now() + 60 * 60 * 1000,
              email: "user@example.com",
            },
            [defaultProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "main-default-access",
              refresh: "main-default-refresh",
              expires: Date.now() + 45 * 60 * 1000,
            },
          },
          order: {
            openai: [freshProfileId, defaultProfileId],
          },
          usageStats: {
            [defaultProfileId]: {
              lastUsed: 123,
            },
          },
        },
        mainDir,
      );
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [defaultProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "stale-agent-default-access",
              refresh: "stale-agent-default-refresh",
              expires: Date.now() - 60 * 60 * 1000,
            },
          },
          order: {
            openai: [defaultProfileId],
          },
          usageStats: {
            [defaultProfileId]: {
              lastUsed: 999,
              errorCount: 2,
            },
          },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshot();

      const store = loadAuthProfileStoreForRuntime(agentDir, { readOnly: true });

      expect(store.order?.["openai"]).toEqual([freshProfileId, defaultProfileId]);
      expectRecordFields(store.profiles[defaultProfileId], {
        type: "oauth",
        provider: "openai",
        access: "main-default-access",
      });
      expectRecordFields(store.usageStats?.[defaultProfileId], {
        lastUsed: 123,
      });
    } finally {
      restoreAgentDirEnv({ previousStateDir, previousAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a stale default OAuth profile when the main profile belongs to a different identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-drift-mismatch-"));
    const { mainDir, agentDir, previousStateDir, previousAgentDir } =
      configureMainAuthTestDirs(root);
    try {
      const freshProfileId = "openai:user@example.com";
      const staleProfileId = "openai:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [freshProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "main-access",
              refresh: "main-refresh",
              expires: Date.now() + 60 * 60 * 1000,
              email: "user@example.com",
            },
          },
        },
        mainDir,
      );
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [staleProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "other-access",
              refresh: "other-refresh",
              expires: Date.now() - 60 * 60 * 1000,
              email: "other@example.com",
            },
          },
          order: {
            openai: [staleProfileId],
          },
          lastGood: {
            openai: staleProfileId,
          },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshot();

      const store = loadAuthProfileStoreForRuntime(agentDir, { readOnly: true });

      expect(store.profiles).toHaveProperty(freshProfileId);
      expectRecordFields(store.profiles[staleProfileId], {
        type: "oauth",
        provider: "openai",
        access: "other-access",
      });
      expect(store.order?.["openai"]).toEqual([staleProfileId]);
      expect(store.lastGood?.["openai"]).toBe(staleProfileId);
    } finally {
      restoreAgentDirEnv({ previousStateDir, previousAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an invalidated identity-specific agent profile when the main agent has a different identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-codex-relogin-"));
    const { mainDir, agentDir, previousStateDir, previousAgentDir } =
      configureMainAuthTestDirs(root);
    try {
      const now = Date.now();
      const healthyProfileId = "openai:bunsthedev@gmail.com";
      const staleProfileId = "openai:val@viewdue.ai";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [healthyProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "healthy-access",
              refresh: "healthy-refresh",
              expires: now + 60 * 60 * 1000,
              email: "bunsthedev@gmail.com",
            },
          },
          order: {
            openai: [healthyProfileId],
          },
          lastGood: {
            openai: healthyProfileId,
          },
        },
        mainDir,
      );
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [staleProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: now + 30 * 60 * 1000,
              email: "val@viewdue.ai",
            },
          },
          order: {
            openai: [staleProfileId],
          },
          lastGood: {
            openai: staleProfileId,
          },
          usageStats: {
            [staleProfileId]: {
              cooldownUntil: now + 60_000,
              cooldownReason: "auth",
              failureCounts: { auth: 1 },
              errorCount: 1,
              lastFailureAt: now - 1_000,
            },
          },
        },
        agentDir,
      );
      clearRuntimeAuthProfileStoreSnapshot();

      const store = loadAuthProfileStoreForRuntime(agentDir, { readOnly: true });

      expectRecordFields(store.profiles[healthyProfileId], {
        type: "oauth",
        provider: "openai",
        access: "healthy-access",
      });
      expectRecordFields(store.profiles[staleProfileId], {
        type: "oauth",
        provider: "openai",
        access: "stale-access",
      });
      expect(store.order?.["openai"]).toEqual([staleProfileId]);
      expect(store.lastGood?.["openai"]).toBe(staleProfileId);
      expect(store.usageStats?.[staleProfileId]?.cooldownReason).toBe("auth");
    } finally {
      restoreAgentDirEnv({ previousStateDir, previousAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "mode/apiKey aliases map to type/key",
      profile: {
        provider: "anthropic",
        mode: "api_key",
        apiKey: "sk-ant-alias", // pragma: allowlist secret
      },
      expected: {
        type: "api_key",
        key: "sk-ant-alias",
      },
    },
    {
      name: "canonical type overrides conflicting mode alias",
      profile: {
        provider: "anthropic",
        type: "api_key",
        mode: "token",
        key: "sk-ant-canonical",
      },
      expected: {
        type: "api_key",
        key: "sk-ant-canonical",
      },
    },
    {
      name: "canonical key overrides conflicting apiKey alias",
      profile: {
        provider: "anthropic",
        type: "api_key",
        key: "sk-ant-canonical",
        apiKey: "sk-ant-alias", // pragma: allowlist secret
      },
      expected: {
        type: "api_key",
        key: "sk-ant-canonical",
      },
    },
    {
      name: "canonical profile shape remains unchanged",
      profile: {
        provider: "anthropic",
        type: "api_key",
        key: "sk-ant-direct",
      },
      expected: {
        type: "api_key",
        key: "sk-ant-direct",
      },
    },
  ] as const)(
    "normalizes auth-profiles credential aliases with canonical-field precedence: $name",
    ({ name, profile, expected }) => {
      withTempAgentDir("openclaw-auth-alias-", (agentDir) => {
        writeRawAuthProfileStore(agentDir, {
          version: AUTH_STORE_VERSION,
          profiles: {
            "anthropic:work": profile,
          },
        });

        const store = ensureAuthProfileStore(agentDir);
        expectRecordFields(store.profiles["anthropic:work"], expected, name);
      });
    },
  );

  it("exposes provider-managed runtime auth without persisting copied tokens", () => {
    withTempAgentDir("openclaw-external-auth-", (agentDir) => {
      resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
        {
          profileId: "demo-provider:external",
          credential: {
            type: "oauth",
            provider: "demo-provider",
            access: "external-access-token",
            refresh: "external-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "acct_123",
          },
          persistence: "runtime-only",
        },
      ]);

      const store = ensureAuthProfileStore(agentDir);
      expectRecordFields(store.profiles["demo-provider:external"], {
        type: "oauth",
        provider: "demo-provider",
        access: "external-access-token",
        refresh: "external-refresh-token",
      });

      expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
      expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
    });
  });

  it("does not write inherited auth stores during secrets runtime reads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secrets-runtime-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      const stateDir = path.join(root, ".openclaw");
      const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
      const workerAgentDir = path.join(stateDir, "agents", "worker", "agent");
      const workerStorePath = path.join(workerAgentDir, "auth-profiles.json");
      fs.mkdirSync(mainAgentDir, { recursive: true });
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            },
          },
        },
        mainAgentDir,
      );
      process.env.OPENCLAW_STATE_DIR = stateDir;
      clearRuntimeAuthProfileStoreSnapshot();

      const store = loadAuthProfileStoreForRuntime(workerAgentDir, { readOnly: true });

      expectRecordFields(store.profiles["openai:default"], {
        type: "api_key",
        provider: "openai",
      });
      expect(fs.existsSync(workerStorePath)).toBe(false);
    } finally {
      clearRuntimeAuthProfileStoreSnapshot();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      restoreEnvValue("OPENCLAW_STATE_DIR", previousStateDir);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not clone inherited auth stores during normal agent reads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-read-through-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      const stateDir = path.join(root, ".openclaw");
      const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
      const workerAgentDir = path.join(stateDir, "agents", "worker", "agent");
      const workerStorePath = path.join(workerAgentDir, "auth-profiles.json");
      fs.mkdirSync(mainAgentDir, { recursive: true });
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": {
              type: "oauth",
              provider: "openai",
              access: "main-access",
              refresh: "main-refresh",
              expires: Date.now() + 60_000,
            },
          },
        },
        mainAgentDir,
      );
      process.env.OPENCLAW_STATE_DIR = stateDir;
      clearRuntimeAuthProfileStoreSnapshot();

      const store = ensureAuthProfileStore(workerAgentDir);

      expectRecordFields(store.profiles["openai:default"], {
        type: "oauth",
        provider: "openai",
        access: "main-access",
      });
      expect(fs.existsSync(workerStorePath)).toBe(false);
    } finally {
      clearRuntimeAuthProfileStoreSnapshot();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      restoreEnvValue("OPENCLAW_STATE_DIR", previousStateDir);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("logs one warning with aggregated reasons for rejected auth-profiles entries", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      withTempAgentDir("openclaw-auth-invalid-", (agentDir) => {
        const invalidStore = {
          version: AUTH_STORE_VERSION,
          profiles: {
            "anthropic:missing-type": {
              provider: "anthropic",
            },
            "openai:missing-provider": {
              type: "api_key",
              key: "sk-openai",
            },
            "qwen:not-object": "broken",
          },
        };
        writeRawAuthProfileStore(agentDir, invalidStore);
        const store = ensureAuthProfileStore(agentDir);
        expect(store.profiles).toStrictEqual({});
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          "ignored invalid auth profile entries during store load",
          {
            source: "auth-profiles.json",
            dropped: 3,
            reasons: {
              invalid_type: 1,
              missing_provider: 1,
              non_object: 1,
            },
            validTypes: ["api_key", "oauth", "token"],
            keys: ["anthropic:missing-type", "openai:missing-provider", "qwen:not-object"],
          },
        );
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "migrates SecretRef object in `key` to `keyRef` and clears `key`",
      prefix: "openclaw-nonstr-key-ref-",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        key: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toEqual({
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        });
      },
    },
    {
      name: "deletes non-string non-SecretRef `key` without setting keyRef",
      prefix: "openclaw-nonstr-key-num-",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        key: 12345,
      },
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toBeUndefined();
      },
    },
    {
      name: "does not overwrite existing `keyRef` when `key` contains a SecretRef",
      prefix: "openclaw-nonstr-key-dup-",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        key: { source: "env", provider: "default", id: "WRONG_VAR" },
        keyRef: { source: "env", provider: "default", id: "CORRECT_VAR" },
      },
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toEqual({
          source: "env",
          provider: "default",
          id: "CORRECT_VAR",
        });
      },
    },
    {
      name: "overwrites malformed `keyRef` with migrated ref from `key`",
      prefix: "openclaw-nonstr-key-malformed-ref-",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        key: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        keyRef: null,
      },
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toEqual({
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        });
      },
    },
    {
      name: "preserves valid string `key` values unchanged",
      prefix: "openclaw-str-key-",
      profileId: "openai:default",
      profile: {
        type: "api_key",
        provider: "openai",
        key: "sk-valid-plaintext-key",
      },
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBe("sk-valid-plaintext-key");
      },
    },
    {
      name: "migrates SecretRef object in `token` to `tokenRef` and clears `token`",
      prefix: "openclaw-nonstr-token-ref-",
      profileId: "anthropic:default",
      profile: {
        type: "token",
        provider: "anthropic",
        token: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
      },
      assert(profile: AuthProfileCredential) {
        const token = expectTokenProfile(profile);
        expect(token.token).toBeUndefined();
        expect(token.tokenRef).toEqual({
          source: "env",
          provider: "default",
          id: "ANTHROPIC_TOKEN",
        });
      },
    },
    {
      name: "deletes non-string non-SecretRef `token` without setting tokenRef",
      prefix: "openclaw-nonstr-token-num-",
      profileId: "anthropic:default",
      profile: {
        type: "token",
        provider: "anthropic",
        token: 99999,
      },
      assert(profile: AuthProfileCredential) {
        const token = expectTokenProfile(profile);
        expect(token.token).toBeUndefined();
        expect(token.tokenRef).toBeUndefined();
      },
    },
    {
      name: "preserves valid string `token` values unchanged",
      prefix: "openclaw-str-token-",
      profileId: "anthropic:default",
      profile: {
        type: "token",
        provider: "anthropic",
        token: "tok-valid-plaintext",
      },
      assert(profile: AuthProfileCredential) {
        const token = expectTokenProfile(profile);
        expect(token.token).toBe("tok-valid-plaintext");
      },
    },
  ] as const)(
    "normalizes secret-backed auth profile fields during store load: $name (#58861)",
    (testCase) => {
      withTempAgentDir(testCase.prefix, (agentDir) => {
        writeAuthProfileStore(agentDir, { [testCase.profileId]: testCase.profile });
        const profile = loadAuthProfile(agentDir, testCase.profileId);
        testCase.assert(profile);
      });
    },
  );
});
