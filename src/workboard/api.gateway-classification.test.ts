// The workboard descriptor table and api.ts must name exactly the same methods.
// A handler with no descriptor still registers, but falls through to the aux bucket's
// ADMIN_SCOPE default — reads start demanding operator.admin while least-privilege
// callers present no scope at all. A descriptor with no handler registers a lazy
// wrapper that only fails once a client calls it. Neither direction type-checks, and
// the 2026-07 resync deleted the whole block with every lane staying green.
import { describe, expect, it } from "vitest";
import { listCoreGatewayMethodNames } from "../gateway/methods/core-descriptors.js";
import { createWorkboardGatewayHandlers } from "./api.js";
import type { WorkboardStore } from "./store.js";

describe("workboard gateway handler classification", () => {
  it("matches the core descriptor set to the exposed handlers", () => {
    // The factory only closes over the store, so key enumeration needs no real DB.
    const handlers = Object.keys(createWorkboardGatewayHandlers({} as WorkboardStore));
    const described = listCoreGatewayMethodNames().filter((name) => name.startsWith("workboard."));
    expect(handlers.length).toBeGreaterThan(0);
    expect(new Set(handlers)).toEqual(new Set(described));
  });
});
