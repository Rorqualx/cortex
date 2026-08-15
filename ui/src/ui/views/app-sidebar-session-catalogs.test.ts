import { describe, expect, it } from "vitest";
import type { SessionCatalog } from "../../../../packages/gateway-protocol/src/index.ts";
import { adoptedCatalogSessionKeys, isAdoptedSessionKey } from "./app-sidebar-session-catalogs.ts";

function catalogWithSessionKey(sessionKey: string): SessionCatalog {
  return {
    hosts: [{ sessions: [{ sessionKey }] }],
  } as unknown as SessionCatalog;
}

describe("adoptedCatalogSessionKeys alias handling", () => {
  it("collapses a catalog key against its live-row alias", () => {
    // "main" and "agent:main:main" are the same conversation. Before alias
    // normalization the exact `Set.has` missed this pair, so the live row was
    // never suppressed and the conversation rendered twice.
    const adopted = adoptedCatalogSessionKeys([catalogWithSessionKey("main")]);
    expect(isAdoptedSessionKey(adopted, "agent:main:main")).toBe(true);
    expect(isAdoptedSessionKey(adopted, "main")).toBe(true);
  });

  it("does not adopt an unrelated or missing session key", () => {
    const adopted = adoptedCatalogSessionKeys([catalogWithSessionKey("main")]);
    expect(isAdoptedSessionKey(adopted, "agent:ops:review")).toBe(false);
    expect(isAdoptedSessionKey(adopted, undefined)).toBe(false);
  });
});
