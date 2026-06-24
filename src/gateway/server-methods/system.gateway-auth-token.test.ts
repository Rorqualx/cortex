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

const handler = systemHandlers["gateway.auth.token.get"];

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
    const [ok, payload, error] = respond.mock.calls[0];
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
    const [ok, payload] = respond.mock.calls[0];
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
    const [ok, payload] = respond.mock.calls[0];
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
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload).toEqual({ token: null, source: null, secretRefConfigured: false });
  });
});
