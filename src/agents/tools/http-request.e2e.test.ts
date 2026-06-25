import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDynamicSecrets } from "../../logging/redact.js";
import { saveVaultSecret } from "../../secrets/vault/store.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createHttpRequestTool } from "./http-request.js";

// Live network proof of the core guarantee. Run with OPENCLAW_LIVE_TEST=1.
const SECRET = "supersecretvalue_abc123_DONOTLEAK";

async function runTool(tool: NonNullable<ReturnType<typeof createHttpRequestTool>>, url: string) {
  const controller = new AbortController();
  const result = await tool.execute("call-1", { url, method: "GET" }, controller.signal, () => {});
  const details = (result as { details: Record<string, unknown> }).details;
  return { details, serialized: JSON.stringify(result) };
}

describe.skipIf(!process.env.OPENCLAW_LIVE_TEST)("http_request vault egress (live)", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vault-e2e-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(() => {
    clearDynamicSecrets();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("injects the bound credential and scrubs the echoed value from the result", async () => {
    saveVaultSecret(
      {
        name: "httpbin",
        authKind: "bearer",
        token: SECRET,
        hostAllowlist: ["httpbin.org"],
        approvalPolicy: "auto",
      },
      { env },
    );
    const tool = createHttpRequestTool({ env });
    expect(tool).not.toBeNull();
    // httpbin /headers echoes request headers back, so a leak would surface here.
    const { details, serialized } = await runTool(tool!, "https://httpbin.org/headers");
    expect(details.secretInjected).toBe(true);
    // The injected Authorization header reached the server (proof of injection)...
    expect(String(details.body)).toContain("[redacted secret]");
    // ...but the plaintext value never appears anywhere in what returns to the model.
    expect(serialized).not.toContain(SECRET);
  });

  it("does not inject a credential bound to a different host (anti-exfil)", async () => {
    saveVaultSecret(
      {
        name: "elsewhere",
        authKind: "bearer",
        token: SECRET,
        hostAllowlist: ["api.example.com"],
        approvalPolicy: "auto",
      },
      { env },
    );
    const tool = createHttpRequestTool({ env });
    const { details, serialized } = await runTool(tool!, "https://httpbin.org/headers");
    expect(details.secretInjected).toBe(false);
    expect(serialized).not.toContain(SECRET);
  });
});
