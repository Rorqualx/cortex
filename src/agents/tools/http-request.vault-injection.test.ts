import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDynamicSecrets } from "../../logging/redact.js";
import { saveVaultSecret } from "../../secrets/vault/store.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createHttpRequestTool } from "./http-request.js";
import type { GuardedFetchFn } from "./vault-login.js";

type CapturedHeaders = Record<string, string>;

function runTool(
  tool: NonNullable<ReturnType<typeof createHttpRequestTool>>,
  url: string,
): Promise<{ details: Record<string, unknown>; serialized: string }> {
  return tool
    .execute("call-1", { url, method: "GET" }, new AbortController().signal)
    .then((result) => ({
      details: (result as { details: Record<string, unknown> }).details,
      serialized: JSON.stringify(result),
    }));
}

describe("http_request vault injection (mocked fetch)", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vault-inj-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(() => {
    clearDynamicSecrets();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("injects every configured header for the header kind", async () => {
    saveVaultSecret(
      {
        name: "multi",
        authKind: "header",
        headers: [
          { name: "X-Api-Key", value: "KEY-1" },
          { name: "X-Account", value: "ACC-9" },
        ],
        hostAllowlist: ["api.example.com"],
        approvalPolicy: "auto",
      },
      { env },
    );
    let captured: CapturedHeaders = {};
    const fetchGuarded: GuardedFetchFn = async (params) => {
      captured = (params.init?.headers ?? {}) as CapturedHeaders;
      return {
        response: new Response("ok", { status: 200 }),
        finalUrl: params.url,
        release: async () => {},
      };
    };
    const tool = createHttpRequestTool({ env, fetchGuarded });
    const { details } = await runTool(tool!, "https://api.example.com/x");
    expect(details.secretInjected).toBe(true);
    expect(captured["X-Api-Key"]).toBe("KEY-1");
    expect(captured["X-Account"]).toBe("ACC-9");
  });

  it("injects an exact Basic auth header for the basic kind", async () => {
    saveVaultSecret(
      {
        name: "router",
        authKind: "basic",
        username: "admin",
        password: "hunter2",
        hostAllowlist: ["api.example.com"],
        approvalPolicy: "auto",
      },
      { env },
    );
    let captured: CapturedHeaders = {};
    const fetchGuarded: GuardedFetchFn = async (params) => {
      captured = (params.init?.headers ?? {}) as CapturedHeaders;
      return {
        response: new Response("ok", { status: 200 }),
        finalUrl: params.url,
        release: async () => {},
      };
    };
    const tool = createHttpRequestTool({ env, fetchGuarded });
    await runTool(tool!, "https://api.example.com/x");
    expect(captured.Authorization).toBe(`Basic ${Buffer.from("admin:hunter2").toString("base64")}`);
  });

  it("logs in, replays the captured cookie, reuses the session, and scrubs the token", async () => {
    saveVaultSecret(
      {
        name: "device",
        authKind: "login",
        username: "admin",
        password: "routerpass",
        hostAllowlist: ["device.example.com"],
        approvalPolicy: "auto",
        login: {
          loginUrl: "https://device.example.com/login",
          bodyTemplate: "login_authorization={{basic}}",
          extract: { from: "set-cookie", cookieName: "asus_token" },
          place: { as: "cookie", cookieName: "asus_token" },
        },
      },
      { env },
    );
    let loginCount = 0;
    let realCookie: string | undefined;
    const fetchGuarded: GuardedFetchFn = async (params) => {
      if (params.url.endsWith("/login")) {
        loginCount += 1;
        return {
          response: new Response("{}", {
            status: 200,
            headers: { "set-cookie": `asus_token=TOK${loginCount}; path=/` },
          }),
          finalUrl: params.url,
          release: async () => {},
        };
      }
      realCookie = (params.init?.headers as CapturedHeaders | undefined)?.Cookie;
      // Echo the token to prove it is scrubbed from the model-facing result.
      return {
        response: new Response(`seen ${realCookie}`, { status: 200 }),
        finalUrl: params.url,
        release: async () => {},
      };
    };
    const tool = createHttpRequestTool({ env, fetchGuarded });

    const first = await runTool(tool!, "https://device.example.com/api");
    expect(first.details.secretInjected).toBe(true);
    expect(loginCount).toBe(1);
    expect(realCookie).toBe("asus_token=TOK1");
    expect(first.serialized).not.toContain("TOK1");

    // Second call reuses the cached session — no second login.
    await runTool(tool!, "https://device.example.com/api");
    expect(loginCount).toBe(1);
  });

  it("re-authenticates exactly once on a 401 and retries", async () => {
    saveVaultSecret(
      {
        name: "device",
        authKind: "login",
        username: "admin",
        password: "routerpass",
        hostAllowlist: ["device.example.com"],
        approvalPolicy: "auto",
        login: {
          loginUrl: "https://device.example.com/login",
          bodyTemplate: "login_authorization={{basic}}",
          extract: { from: "set-cookie", cookieName: "asus_token" },
          place: { as: "cookie", cookieName: "asus_token" },
        },
      },
      { env },
    );
    let loginCount = 0;
    let realCount = 0;
    let lastCookie: string | undefined;
    const fetchGuarded: GuardedFetchFn = async (params) => {
      if (params.url.endsWith("/login")) {
        loginCount += 1;
        return {
          response: new Response("{}", {
            status: 200,
            headers: { "set-cookie": `asus_token=TOK${loginCount}; path=/` },
          }),
          finalUrl: params.url,
          release: async () => {},
        };
      }
      realCount += 1;
      lastCookie = (params.init?.headers as CapturedHeaders | undefined)?.Cookie;
      const status = realCount === 1 ? 401 : 200;
      return {
        response: new Response("body", { status }),
        finalUrl: params.url,
        release: async () => {},
      };
    };
    const tool = createHttpRequestTool({ env, fetchGuarded });
    const { details } = await runTool(tool!, "https://device.example.com/api");
    expect(loginCount).toBe(2);
    expect(realCount).toBe(2);
    expect(details.status).toBe(200);
    expect(lastCookie).toBe("asus_token=TOK2");
  });

  it("does not inject for a non-allowlisted host", async () => {
    saveVaultSecret(
      {
        name: "elsewhere",
        authKind: "bearer",
        token: "sk_live_xyz",
        hostAllowlist: ["api.example.com"],
        approvalPolicy: "auto",
      },
      { env },
    );
    let captured: CapturedHeaders = {};
    const fetchGuarded: GuardedFetchFn = async (params) => {
      captured = (params.init?.headers ?? {}) as CapturedHeaders;
      return {
        response: new Response("ok", { status: 200 }),
        finalUrl: params.url,
        release: async () => {},
      };
    };
    const tool = createHttpRequestTool({ env, fetchGuarded });
    const { details, serialized } = await runTool(tool!, "https://other.example.org/x");
    expect(details.secretInjected).toBe(false);
    expect(captured.Authorization).toBeUndefined();
    expect(serialized).not.toContain("sk_live_xyz");
  });

  it("surfaces the real 401 (does not crash) when re-authentication fails", async () => {
    saveVaultSecret(
      {
        name: "device",
        authKind: "login",
        username: "admin",
        password: "routerpass",
        hostAllowlist: ["device.example.com"],
        approvalPolicy: "auto",
        login: {
          loginUrl: "https://device.example.com/login",
          bodyTemplate: "login_authorization={{basic}}",
          extract: { from: "set-cookie", cookieName: "asus_token" },
          place: { as: "cookie", cookieName: "asus_token" },
        },
      },
      { env },
    );
    let loginCount = 0;
    let realCount = 0;
    const fetchGuarded: GuardedFetchFn = async (params) => {
      if (params.url.endsWith("/login")) {
        loginCount += 1;
        // First login succeeds; the forced re-login returns no cookie → null token.
        const headers = loginCount === 1 ? { "set-cookie": "asus_token=TOK1; path=/" } : {};
        return {
          response: new Response("{}", { status: 200, headers }),
          finalUrl: params.url,
          release: async () => {},
        };
      }
      realCount += 1;
      return {
        response: new Response("denied", { status: 401 }),
        finalUrl: params.url,
        release: async () => {},
      };
    };
    const tool = createHttpRequestTool({ env, fetchGuarded });
    const { details } = await runTool(tool!, "https://device.example.com/api");
    expect(details.status).toBe(401); // real 401 returned, not a thrown read-after-release
    expect(loginCount).toBe(2); // initial login + one failed re-auth
    expect(realCount).toBe(1); // no retry once re-auth failed
  });

  it("keeps the strict SSRF policy when the credential is denied", async () => {
    saveVaultSecret(
      {
        name: "router",
        authKind: "bearer",
        token: "sk_live_denied",
        hostAllowlist: ["api.example.com"],
        approvalPolicy: "ask",
      },
      { env },
    );
    let capturedPolicy: unknown = "unset";
    const fetchGuarded: GuardedFetchFn = async (params) => {
      capturedPolicy = (params as { policy?: unknown }).policy;
      return {
        response: new Response("ok", { status: 200 }),
        finalUrl: params.url,
        release: async () => {},
      };
    };
    const tool = createHttpRequestTool({
      env,
      fetchGuarded,
      approveSecretUse: async () => "deny",
    });
    const { details } = await runTool(tool!, "https://api.example.com/x");
    expect(details.secretInjected).toBe(false);
    // No private-network relaxation: a denied credential must not widen egress.
    expect(capturedPolicy).toBeUndefined();
  });
});
