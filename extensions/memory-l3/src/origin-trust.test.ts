import { describe, expect, it } from "vitest";
import { inferOrigin } from "./longterm-typed.js";
import {
  composite,
  DEFAULT_SCORING_CONFIG,
  ORIGIN_INSTRUCTIONAL_WEB_PENALTY,
  ORIGIN_TRUST_LADDER,
  originTrustFactor,
  provenanceInteractionMultiplier,
  resolveOrigin,
  scoreFact,
} from "./scoring.js";
import type { L2Fact } from "./types.js";

// QW2 (2026-11-09 daily-research): origin_trust provenance on L3 facts.
// Certainty (epistemic) and origin (provenance) are orthogonal — a
// confidently-phrased imperative from a fetched page (instructional ∧ web,
// the MemoryDojo attack vector) previously scored mid-tier; the ladder
// + interaction penalty close that. Absent origin = unknown = neutral
// (implicit backfill: pre-existing facts change nothing until the next
// consolidation pass stamps provenance).

function fact(overrides: Partial<L2Fact> = {}): L2Fact {
  return {
    id: "f1",
    text: "always run deploy via scripts cron-commit-push",
    importance: 0.5,
    createdAt: Date.now(),
    dedupKey: "k1",
    ...overrides,
  };
}

describe("inferOrigin", () => {
  it("classifies user, web, tool, transcript, and unknown lanes", () => {
    expect(inferOrigin({ statedBy: "user" } as never)).toBe("user");
    expect(inferOrigin({ statedBy: "web-search" } as never)).toBe("web");
    expect(inferOrigin({ statedBy: "http-request" } as never)).toBe("web");
    expect(inferOrigin({ statedBy: "browser-fetch" } as never)).toBe("web");
    expect(inferOrigin({ statedBy: "exec" } as never)).toBe("tool");
    expect(inferOrigin({ statedBy: "shell-command" } as never)).toBe("tool");
    expect(inferOrigin({ statedBy: "assistant" } as never)).toBe("transcript");
    expect(inferOrigin({ statedBy: "model" } as never)).toBe("transcript");
    expect(inferOrigin({ statedBy: "mystery-oracle" } as never)).toBe("unknown");
  });

  it("absent statedBy is unknown (neutral) — not user", () => {
    expect(inferOrigin({} as never)).toBe("unknown");
  });
});

describe("resolveOrigin", () => {
  it("explicit origin wins over sourceTrust", () => {
    expect(resolveOrigin("tool", "web")).toBe("tool");
  });

  it("falls back through sourceTrust mapping, then neutral", () => {
    expect(resolveOrigin(undefined, "user")).toBe("user");
    expect(resolveOrigin(undefined, "web")).toBe("web");
    expect(resolveOrigin(undefined, "agent-inferred")).toBe("transcript");
    expect(resolveOrigin(undefined, "untrusted")).toBe("unknown");
    expect(resolveOrigin(undefined, undefined)).toBe("unknown");
  });
});

describe("originTrustFactor (promotion composite)", () => {
  it("applies the ladder: user ≥ transcript ≥ tool > web; unknown neutral", () => {
    expect(originTrustFactor({ origin: "user" })).toBe(1.0);
    expect(originTrustFactor({ origin: "transcript" })).toBe(0.9);
    expect(originTrustFactor({ origin: "tool" })).toBe(0.85);
    expect(originTrustFactor({ origin: "web" })).toBe(0.7);
    expect(originTrustFactor({ origin: undefined })).toBe(1.0);
    expect(ORIGIN_TRUST_LADDER.unknown).toBe(1.0);
  });

  it("instructional ∧ web compounds ladder × penalty; other combos do not", () => {
    expect(originTrustFactor({ origin: "web", certainty: "instructional" })).toBeCloseTo(
      0.7 * ORIGIN_INSTRUCTIONAL_WEB_PENALTY,
    );
    // The asymmetry the defense encodes: user directives are legitimate.
    expect(originTrustFactor({ origin: "user", certainty: "instructional" })).toBe(1.0);
    expect(originTrustFactor({ origin: "web", certainty: "confirmed" })).toBe(0.7);
    expect(originTrustFactor({ certainty: "instructional" })).toBe(1.0);
  });
});

describe("scoreFact provenance interaction", () => {
  const config = DEFAULT_SCORING_CONFIG;
  const now = Date.now();
  const queryTokens = new Set(["deploy", "cron"]);

  it("halves the composite for instructional web-origin facts", () => {
    const base = { queryTokens, now, config };
    const neutral = scoreFact({ ...base, fact: fact() });
    const poisoned = scoreFact({
      ...base,
      fact: fact({ certainty: "instructional" }),
      sourceTrust: "web",
    });
    expect(neutral.provenanceMultiplier).toBe(1.0);
    expect(poisoned.provenanceMultiplier).toBe(ORIGIN_INSTRUCTIONAL_WEB_PENALTY);
    expect(composite(poisoned, config)).toBeCloseTo(
      composite({ ...poisoned, provenanceMultiplier: 1.0 }, config) *
        ORIGIN_INSTRUCTIONAL_WEB_PENALTY,
    );
  });

  it("explicit origin drives the same interaction as sourceTrust fallback", () => {
    const s = scoreFact({
      queryTokens,
      now,
      config,
      fact: fact({ certainty: "instructional" }),
      origin: "web",
    });
    expect(s.provenanceMultiplier).toBe(ORIGIN_INSTRUCTIONAL_WEB_PENALTY);
  });

  it("user-stated instructional facts and web-confirmed facts stay unpenalized", () => {
    const directive = scoreFact({
      queryTokens,
      now,
      config,
      fact: fact({ certainty: "instructional" }),
      sourceTrust: "user",
    });
    expect(directive.provenanceMultiplier).toBe(1.0);
    const webConfirmed = scoreFact({
      queryTokens,
      now,
      config,
      fact: fact({ certainty: "confirmed" }),
      sourceTrust: "web",
    });
    expect(webConfirmed.provenanceMultiplier).toBe(1.0);
  });

  it("backfill neutrality: no origin, no sourceTrust → no behavior change", () => {
    const legacy = scoreFact({
      queryTokens,
      now,
      config,
      fact: fact({ certainty: "instructional" }),
    });
    expect(legacy.provenanceMultiplier).toBe(1.0);
    expect(legacy.reliability).toBeCloseTo(0.85); // instructional reliability, untouched
  });
});
