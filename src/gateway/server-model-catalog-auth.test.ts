import { describe, expect, it } from "vitest";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import {
  loadDeferredCatalog,
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "./server-model-catalog-auth.js";

type CatalogLoader = GatewayRequestContext["loadGatewayModelCatalogSnapshot"];

const deferredSentinel = { marker: "deferred" } as never;
const preparedSentinel = { marker: "prepared" } as never;

function registerStubAccess(loader: CatalogLoader): void {
  registerGatewayModelCatalogPrivateAccess(loader, {
    loadDeferred: async () => deferredSentinel,
    readPrepared: async () => preparedSentinel,
  });
}

describe("gateway model catalog prepared owner access", () => {
  it("resolves deferred and prepared reads through the exact registered loader", async () => {
    const loader = (async () => undefined) as CatalogLoader;
    registerStubAccess(loader);

    await expect(
      loadDeferredCatalog({ loadGatewayModelCatalogSnapshot: loader }, "main", {}),
    ).resolves.toBe(deferredSentinel);
    await expect(
      readPreparedCatalog({ loadGatewayModelCatalogSnapshot: loader }, "main"),
    ).resolves.toBe(preparedSentinel);
  });

  it("fails closed when the context loader wraps the registered instance", async () => {
    // Private access is keyed by loader function identity: the request context must carry
    // the exact registered instance. A wrapper (e.g. one added to stamp request params)
    // silently strands every prepared read — the 2026-08-21 models.authStatus outage,
    // where a flagged wrapper in the core runtime return left models.authStatus and
    // models.list returning UNAVAILABLE. This pins the fail-closed contract that makes
    // such a wiring mistake loud instead of silent.
    const registered = (async () => undefined) as CatalogLoader;
    registerStubAccess(registered);
    const wrapped = ((params?: unknown) => registered(params as never)) as CatalogLoader;

    await expect(
      readPreparedCatalog({ loadGatewayModelCatalogSnapshot: wrapped }, "main"),
    ).rejects.toThrow("Gateway model catalog loader omitted prepared owner access");
    await expect(
      loadDeferredCatalog({ loadGatewayModelCatalogSnapshot: wrapped }, "main", {}),
    ).rejects.toThrow("Gateway model catalog loader omitted prepared owner access");
  });
});
