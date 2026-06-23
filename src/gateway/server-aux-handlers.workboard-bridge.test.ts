// Regression: the workboard bridge must read request params from opts.params,
// not opts.context (which carries no params). Reading the wrong field handed
// every workboard handler {} so readId-gated mutations failed with
// "missing parameter: id" while list-style reads silently ignored it.
import { describe, expect, it, vi } from "vitest";
import { bridgeWorkboardHandler } from "./server-aux-handlers.ts";

type BridgeOpts = Parameters<ReturnType<typeof bridgeWorkboardHandler>>[0];

function makeOpts(over: Partial<BridgeOpts>): BridgeOpts {
  return {
    params: {},
    context: {} as BridgeOpts["context"],
    respond: vi.fn(),
    ...over,
  } as BridgeOpts;
}

describe("bridgeWorkboardHandler", () => {
  it("forwards opts.params to the wrapped handler", async () => {
    const fn = vi.fn(() => ({ ok: true }));
    const respond = vi.fn();
    await bridgeWorkboardHandler(fn)(makeOpts({ params: { id: "card-1" }, respond }));

    expect(fn).toHaveBeenCalledWith({ id: "card-1" });
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("does NOT source params from opts.context", async () => {
    // The pre-fix bug read opts.context.params; a value parked there must never
    // reach the handler, and a real params object must still win.
    const fn = vi.fn(() => null);
    const ctx = { params: { id: "leaked" } } as unknown as BridgeOpts["context"];
    await bridgeWorkboardHandler(fn)(makeOpts({ params: { id: "real" }, context: ctx }));

    expect(fn).toHaveBeenCalledWith({ id: "real" });
  });

  it("relays handler errors through respond with the workboard error code", async () => {
    const err = Object.assign(new Error("missing parameter: id"), { code: "workboard_error" });
    const fn = vi.fn(() => {
      throw err;
    });
    const respond = vi.fn();
    await bridgeWorkboardHandler(fn)(makeOpts({ params: {}, respond }));

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "workboard_error",
      message: "missing parameter: id",
    });
  });
});
