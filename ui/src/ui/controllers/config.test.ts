// Control UI tests cover config behavior.
// NOTE(resync-2026-07-20): the merged controller adopted upstream's shape minus
// its runtime-config capability layer; both sides' larger suites targeted APIs
// that no longer exist here. Rebuild coverage when the controller surface
// settles (see RESYNC_FEATURE_LEDGER.md follow-ups).
import { describe, expect, it } from "vitest";
import { findAgentConfigEntryIndex } from "./config.ts";

describe("agent config helpers", () => {
  it("finds explicit agent entries", () => {
    expect(
      findAgentConfigEntryIndex(
        {
          agents: {
            list: [{ id: "main" }, { id: "assistant" }],
          },
        },
        "assistant",
      ),
    ).toBe(1);
  });
});
