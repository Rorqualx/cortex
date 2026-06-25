import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getVaultGrant, saveVaultSecret } from "../../secrets/vault/store.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveSecretInjectionDecision, type SecretApprover } from "./http-request.js";

describe("resolveSecretInjectionDecision (ask policy approval)", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vault-ask-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function saveAsk(name = "stripe", hosts = ["api.stripe.com"]) {
    saveVaultSecret(
      { name, authKind: "bearer", token: "sk_live_x", hostAllowlist: hosts, approvalPolicy: "ask" },
      { env },
    );
  }

  const entry = (name = "stripe", hosts = ["api.stripe.com"]) => ({
    name,
    hostAllowlist: hosts,
    approvalPolicy: "ask" as const,
    authKind: "bearer" as const,
    authConfig: { kind: "bearer" as const },
    createdAt: 0,
    updatedAt: 0,
  });

  it("auto policy injects without consulting the approver", async () => {
    const approve = vi.fn<SecretApprover>();
    const decision = await resolveSecretInjectionDecision({
      entry: { ...entry(), approvalPolicy: "auto" },
      host: "api.stripe.com",
      env,
      approveSecretUse: approve,
    });
    expect(decision).toBe("inject");
    expect(approve).not.toHaveBeenCalled();
  });

  it("ask with no approver fails closed", async () => {
    const decision = await resolveSecretInjectionDecision({
      entry: entry(),
      host: "api.stripe.com",
      env,
    });
    expect(decision).toBe("no-approval-channel");
  });

  it("allow-once injects without persisting a grant", async () => {
    saveAsk();
    const approve = vi.fn<SecretApprover>().mockResolvedValue("allow-once");
    const decision = await resolveSecretInjectionDecision({
      entry: entry(),
      host: "api.stripe.com",
      env,
      approveSecretUse: approve,
    });
    expect(decision).toBe("inject");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(getVaultGrant("stripe", "api.stripe.com", { env })).toBeUndefined();
  });

  it("allow-always persists a grant and skips the prompt next time", async () => {
    saveAsk();
    const approve = vi.fn<SecretApprover>().mockResolvedValue("allow-always");
    const first = await resolveSecretInjectionDecision({
      entry: entry(),
      host: "api.stripe.com",
      env,
      approveSecretUse: approve,
    });
    expect(first).toBe("inject");
    expect(getVaultGrant("stripe", "api.stripe.com", { env })).toBe("allow-always");

    const second = await resolveSecretInjectionDecision({
      entry: entry(),
      host: "api.stripe.com",
      env,
      approveSecretUse: approve,
    });
    expect(second).toBe("inject");
    // The standing grant means the approver is consulted only once.
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("deny persists a deny grant and short-circuits future calls", async () => {
    saveAsk();
    const approve = vi.fn<SecretApprover>().mockResolvedValue("deny");
    const first = await resolveSecretInjectionDecision({
      entry: entry(),
      host: "api.stripe.com",
      env,
      approveSecretUse: approve,
    });
    expect(first).toBe("denied");
    expect(getVaultGrant("stripe", "api.stripe.com", { env })).toBe("deny");

    const second = await resolveSecretInjectionDecision({
      entry: entry(),
      host: "api.stripe.com",
      env,
      approveSecretUse: approve,
    });
    expect(second).toBe("denied");
    expect(approve).toHaveBeenCalledTimes(1);
  });
});
