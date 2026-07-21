/**
 * Tests the admin-gated gateway.auth.token.get reveal handler: scope enforcement
 * and the refusal to hand back an externally-managed SecretRef value.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const resolveGatewayAuthTokenMock = vi.hoisted(() => vi.fn());
vi.mock("../auth-token-resolution.js", () => ({
  resolveGatewayAuthToken: resolveGatewayAuthTokenMock,
}));

import { systemHandlers } from "./system.ts";

const registeredHandler = systemHandlers["gateway.auth.token.get"];
if (!registeredHandler) throw new Error("gateway.auth.token.get handler not registered");
// Bind to a definitely-typed const so the narrowing survives into the invoke
// closure below (control-flow narrowing of the indexed access does not).
const handler = registeredHandler;

async function invoke(scopes: string[]) {
  const respond = vi.fn();
  await handler({
    params: {},
    client: { connect: { scopes } },
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as never);
  return respond;
}

describe("gateway.auth.token.get", () => {
  beforeEach(() => {
    resolveGatewayAuthTokenMock.mockReset();
  });

  it("rejects non-admin callers without resolving the token", async () => {
    const respond = await invoke(["operator.read", "operator.write"]);
    expect(respond).toHaveBeenCalledTimes(1);
    const call = respond.mock.calls[0];
    if (!call) throw new Error("expected respond call");
    const [ok, payload, error] = call;
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(String(error?.message ?? "")).toContain("operator.admin");
    expect(resolveGatewayAuthTokenMock).not.toHaveBeenCalled();
  });

  it("returns a config/env token to an admin caller", async () => {
    resolveGatewayAuthTokenMock.mockResolvedValue({
      token: "deadbeef",
      source: "config",
      secretRefConfigured: false,
    });
    const respond = await invoke(["operator.admin"]);
    const call = respond.mock.calls[0];
    if (!call) throw new Error("expected respond call");
    const [ok, payload] = call;
    expect(ok).toBe(true);
    expect(payload).toEqual({ token: "deadbeef", source: "config", secretRefConfigured: false });
  });

  it("never reveals an externally-managed SecretRef value", async () => {
    resolveGatewayAuthTokenMock.mockResolvedValue({
      token: "resolved-secret",
      source: "secretRef",
      secretRefConfigured: true,
    });
    const respond = await invoke(["operator.admin"]);
    const call = respond.mock.calls[0];
    if (!call) throw new Error("expected respond call");
    const [ok, payload] = call;
    expect(ok).toBe(true);
    expect(payload).toEqual({ token: null, source: "secretRef", secretRefConfigured: true });
  });

  it("reports no token when none is configured", async () => {
    resolveGatewayAuthTokenMock.mockResolvedValue({
      token: undefined,
      source: undefined,
      secretRefConfigured: false,
    });
    const respond = await invoke(["operator.admin"]);
    const call = respond.mock.calls[0];
    if (!call) throw new Error("expected respond call");
    const [ok, payload] = call;
    expect(ok).toBe(true);
    expect(payload).toEqual({ token: null, source: null, secretRefConfigured: false });
  });
});
