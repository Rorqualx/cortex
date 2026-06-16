import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDynamicSecrets } from "../../logging/redact.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { vaultHandlers } from "./vault.js";

type Captured = { ok: boolean; result?: unknown; error?: unknown };

function invoke(method: keyof typeof vaultHandlers, params: Record<string, unknown>): Captured {
  let captured: Captured | undefined;
  const respond = (ok: boolean, result?: unknown, error?: unknown) => {
    captured = { ok, result, error };
  };
  const handler = vaultHandlers[method];
  // Handlers only read params/respond; cast the partial context for the test.
  void handler({ params, respond } as never);
  if (!captured) {
    throw new Error("handler did not respond");
  }
  return captured;
}

describe("vault gateway handlers", () => {
  let stateDir: string;
  let priorStateDir: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vault-gw-"));
    priorStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    clearDynamicSecrets();
    closeOpenClawStateDatabaseForTest();
    if (priorStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = priorStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("saves, then lists metadata only (no value)", () => {
    const save = invoke("vault.save", {
      name: "stripe",
      value: "sk_live_handler_secret_123",
      hostAllowlist: ["api.stripe.com"],
      approvalPolicy: "auto",
    });
    expect(save.ok).toBe(true);

    const list = invoke("vault.list", {});
    expect(list.ok).toBe(true);
    const serialized = JSON.stringify(list.result);
    expect(serialized).toContain("stripe");
    expect(serialized).toContain("api.stripe.com");
    expect(serialized).not.toContain("sk_live_handler_secret_123");
  });

  it("rejects a save with no hosts", () => {
    const save = invoke("vault.save", {
      name: "bad",
      value: "whatever-secret-value",
      hostAllowlist: [],
    });
    expect(save.ok).toBe(false);
  });

  it("deletes an entry", () => {
    invoke("vault.save", {
      name: "temp",
      value: "temp-secret-value-123",
      hostAllowlist: ["api.temp.com"],
    });
    const del = invoke("vault.delete", { name: "temp" });
    expect(del.ok).toBe(true);
    const list = invoke("vault.list", {});
    expect(JSON.stringify(list.result)).not.toContain("temp");
  });
});
