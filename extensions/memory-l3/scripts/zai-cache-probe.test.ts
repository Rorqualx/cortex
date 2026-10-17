import { describe, expect, it } from "vitest";
import {
  buildRequestBody,
  classifyVerdict,
  wireHasCacheControl,
} from "./zai-cache-probe.mjs";

// R2 probe (ARCH-3 card 9e633f3e, probe stage 2026-10-17): unit tests for the
// pure helpers only — the network lane is spend-gated and never runs in CI.

describe("buildRequestBody", () => {
  it("tags the system message with ephemeral cache_control by default", () => {
    const body = buildRequestBody({ systemPrompt: "s", userPrompt: "u" });
    expect(body.messages[0]).toMatchObject({
      role: "system",
      cache_control: { type: "ephemeral" },
    });
    expect(body.stream).toBe(false);
    expect(body.temperature).toBeCloseTo(0.3);
  });

  it("omits the tag when useCache=false (ZAI_CACHE_DISABLE lane)", () => {
    const body = buildRequestBody({ systemPrompt: "s", userPrompt: "u", useCache: false });
    expect(body.messages[0].cache_control).toBeUndefined();
    expect(wireHasCacheControl(body)).toBe(false);
  });

  it("wireHasCacheControl detects the tag", () => {
    expect(wireHasCacheControl(buildRequestBody({ systemPrompt: "s", userPrompt: "u" }))).toBe(true);
  });
});

describe("classifyVerdict", () => {
  const usage = (cached) => ({
    prompt_tokens: 3000,
    prompt_tokens_details: cached === null ? undefined : { cached_tokens: cached },
  });

  it("verified when wire + cached_tokens>0 (cost n/a without rates)", () => {
    const v = classifyVerdict({
      call1Usage: usage(0),
      call2Usage: usage(2500),
      wireEvidence: true,
    });
    expect(v.wire).toBe(true);
    expect(v.usage).toBe(true);
    expect(v.cost).toBeNull();
    expect(v.overall).toBe("verified (usage; cost n/a)");
  });

  it("verified with cost when cached rate makes call 2 cheaper", () => {
    const v = classifyVerdict({
      call1Usage: usage(0),
      call2Usage: usage(2900),
      wireEvidence: true,
      pricing: { inputPerM: 2, cachedPerM: 0.4 },
    });
    expect(v.cost).toBe(true);
    expect(v.overall).toBe("verified");
  });

  it("emitted, server-unverified when call-2 usage is missing entirely", () => {
    const v = classifyVerdict({ call1Usage: usage(0), call2Usage: null, wireEvidence: true });
    expect(v.overall).toBe("emitted, server-unverified");
  });

  it("cache-miss when cached_tokens=0 reported", () => {
    const v = classifyVerdict({
      call1Usage: usage(0),
      call2Usage: usage(0),
      wireEvidence: true,
    });
    expect(v.usage).toBe(false);
    expect(v.overall).toBe("emitted, cache-miss (retry later)");
  });

  it("failed when wire evidence absent", () => {
    expect(
      classifyVerdict({ call1Usage: usage(0), call2Usage: usage(999), wireEvidence: false }).overall,
    ).toBe("failed");
  });

  it("reads the OpenAI-standard nested field, tolerating absent details", () => {
    const v = classifyVerdict({ call1Usage: usage(null), call2Usage: usage(null), wireEvidence: true });
    expect(v.usage).toBe(false); // absent details ≠ failure — explicit miss lane
  });
});
