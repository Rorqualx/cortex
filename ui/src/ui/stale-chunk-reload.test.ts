import { describe, expect, it } from "vitest";
import { isStaleChunkError } from "./stale-chunk-reload.ts";

describe("isStaleChunkError", () => {
  it("matches the real dynamic-import failure messages across browsers", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://x/assets/workboard-ABC.js",
      "error loading dynamically imported module: https://x/assets/chat-DEF.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/chat-DEF.css",
    ]) {
      expect(isStaleChunkError(new Error(message))).toBe(true);
      expect(isStaleChunkError(message)).toBe(true);
    }
  });

  it("does not match unrelated errors (so the manual recovery panel still shows)", () => {
    for (const message of [
      "chunk 404",
      "network error",
      "boom",
      "TypeError: x is not a function",
    ]) {
      expect(isStaleChunkError(new Error(message))).toBe(false);
    }
    expect(isStaleChunkError(null)).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
  });

  it("reads a message off a plain error-like payload (vite:preloadError)", () => {
    expect(
      isStaleChunkError({ message: "Failed to fetch dynamically imported module: a.js" }),
    ).toBe(true);
  });
});
