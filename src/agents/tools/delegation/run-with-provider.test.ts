// runDelegation failure-class → policy tests (strategy-aware delegation,
// Finding #12): transient → sibling retry via chain advance; persistent →
// same-provider candidates skipped for the run; silent → flag-gated abort
// instead of burning the chain on dud outputs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resetLatencyState } from "./router.js";
import type { Candidate } from "./router.js";
import {
  classifyDelegationError,
  DelegationSilentFailureError,
  isModelScopedFailure,
  resolveAbortOnSilentFailure,
  runDelegation,
} from "./run-with-provider.js";

const authResolver = () => ({ apiKey: "test-key" });

function delegate<T>(params: {
  primary?: Candidate;
  fallbacks?: Candidate[];
  run: (provider: string, model: string, call: number) => Promise<T>;
  unusableReason?: (result: T) => string | undefined;
  abortOnSilentFailure?: boolean;
  cfg?: OpenClawConfig;
}) {
  const calls: Array<{ provider: string; model: string }> = [];
  let call = 0;
  return {
    calls,
    promise: runDelegation<T>({
      cfg: params.cfg,
      primary: params.primary ?? { provider: "zai", model: "glm-4.7" },
      fallbacks: params.fallbacks ?? [{ provider: "kimi", model: "kimi-for-coding" }],
      resolveApiKeyForProvider: authResolver,
      unusableReason: params.unusableReason,
      abortOnSilentFailure: params.abortOnSilentFailure,
      run: async (_client, model, providerId) => {
        call += 1;
        calls.push({ provider: providerId, model });
        return params.run(providerId, model, call);
      },
    }),
  };
}

describe("classifyDelegationError", () => {
  it("classifies timeout / 5xx / rate-limit / network signals as transient", () => {
    expect(classifyDelegationError(new Error("request timeout after 60000ms"))).toBe("transient");
    expect(classifyDelegationError(new Error("HTTP 503 service unavailable"))).toBe("transient");
    expect(classifyDelegationError(new Error("429 too many requests"))).toBe("transient");
    expect(classifyDelegationError(new Error("fetch failed: ECONNRESET"))).toBe("transient");
    expect(classifyDelegationError(new Error("socket hang up"))).toBe("transient");
  });

  it("classifies auth / 4xx / schema signals as persistent", () => {
    expect(classifyDelegationError(new Error("401 unauthorized"))).toBe("persistent");
    expect(classifyDelegationError(new Error("403 forbidden: invalid api key"))).toBe("persistent");
    expect(classifyDelegationError(new Error("schema validation failed on response"))).toBe(
      "persistent",
    );
    expect(classifyDelegationError(new Error("bad request 400"))).toBe("persistent");
  });

  it("detects model-scoped (not provider-scoped) failures", () => {
    expect(isModelScopedFailure(new Error("model glm-4.7 not found"))).toBe(true);
    expect(isModelScopedFailure(new Error("401 unauthorized: invalid api key"))).toBe(false);
  });
});

describe("runDelegation failure-class policies", () => {
  beforeEach(() => {
    resetLatencyState();
  });
  afterEach(() => {
    resetLatencyState();
    vi.restoreAllMocks();
  });

  it("returns the primary result on success", async () => {
    const { calls, promise } = delegate({ run: async () => "ok" });
    const out = await promise;
    expect(out).toMatchObject({ result: "ok", provider: "zai", model: "glm-4.7" });
    expect(calls).toEqual([{ provider: "zai", model: "glm-4.7" }]);
  });

  it("transient primary failure retries the same-provider sibling before crossing providers", async () => {
    const { calls, promise } = delegate({
      fallbacks: [
        { provider: "zai", model: "glm-4.6" },
        { provider: "kimi", model: "kimi-for-coding" },
      ],
      run: async (_provider, model) => {
        if (model === "glm-4.7") throw new Error("request timeout after 60000ms");
        return `ok:${model}`;
      },
    });
    const out = await promise;
    expect(out.result).toBe("ok:glm-4.6");
    expect(calls).toEqual([
      { provider: "zai", model: "glm-4.7" },
      { provider: "zai", model: "glm-4.6" },
    ]);
  });

  it("persistent failure skips the provider's remaining models without calling them", async () => {
    const { calls, promise } = delegate({
      fallbacks: [
        { provider: "zai", model: "glm-4.6" },
        { provider: "zai", model: "glm-5.1" },
        { provider: "kimi", model: "kimi-for-coding" },
      ],
      run: async (provider) => {
        if (provider === "zai") throw new Error("401 unauthorized: invalid api key");
        return "ok:kimi";
      },
    });
    const out = await promise;
    expect(out.result).toBe("ok:kimi");
    // zai/glm-4.7 threw persistent; zai/glm-4.6 + zai/glm-5.1 must be skipped
    // without an API call; kimi serves the request.
    expect(calls).toEqual([
      { provider: "zai", model: "glm-4.7" },
      { provider: "kimi", model: "kimi-for-coding" },
    ]);
  });

  it("model-scoped persistent failure still tries the provider's next model", async () => {
    const { calls, promise } = delegate({
      fallbacks: [{ provider: "zai", model: "glm-4.6" }],
      run: async (_provider, model) => {
        if (model === "glm-4.7") throw new Error("model glm-4.7 not found");
        return "ok:glm-4.6";
      },
    });
    const out = await promise;
    expect(out.result).toBe("ok:glm-4.6");
    expect(calls).toEqual([
      { provider: "zai", model: "glm-4.7" },
      { provider: "zai", model: "glm-4.6" },
    ]);
  });

  it("silent failure advances the chain when the abort flag is OFF (default)", async () => {
    const { calls, promise } = delegate({
      fallbacks: [{ provider: "kimi", model: "kimi-for-coding" }],
      run: async (provider) => (provider === "zai" ? "DUD" : "ok:kimi"),
      unusableReason: (r) => (r === "DUD" ? "empty content" : undefined),
      abortOnSilentFailure: false,
    });
    const out = await promise;
    expect(out.result).toBe("ok:kimi");
    expect(calls).toEqual([
      { provider: "zai", model: "glm-4.7" },
      { provider: "kimi", model: "kimi-for-coding" },
    ]);
  });

  it("silent failure aborts the chain when the abort flag is ON", async () => {
    const { calls, promise } = delegate({
      fallbacks: [
        { provider: "kimi", model: "kimi-for-coding" },
        { provider: "deepseek", model: "deepseek-v4-pro" },
      ],
      run: async () => "DUD",
      unusableReason: (r) => (r === "DUD" ? "empty content" : undefined),
      abortOnSilentFailure: true,
    });
    await expect(promise).rejects.toBeInstanceOf(DelegationSilentFailureError);
    // Only the primary was attempted — the remaining chain was not burned.
    expect(calls).toEqual([{ provider: "zai", model: "glm-4.7" }]);
    const err = await promise.catch((e: DelegationSilentFailureError) => e);
    expect(err.provider).toBe("zai");
    expect(err.model).toBe("glm-4.7");
    expect(err.silentReason).toBe("empty content");
  });

  it("silent-failure abort policy resolves from the experimental config flag", () => {
    const flag = (on: boolean) =>
      ({
        agents: { defaults: { experimental: { delegationSilentFailureAbort: on } } },
      }) as unknown as OpenClawConfig;
    // Default OFF — the always-extend fallback chain stays the default.
    expect(resolveAbortOnSilentFailure({ cfg: undefined, override: undefined })).toBe(false);
    expect(resolveAbortOnSilentFailure({ cfg: {} as OpenClawConfig, override: undefined })).toBe(
      false,
    );
    expect(resolveAbortOnSilentFailure({ cfg: flag(true), override: undefined })).toBe(true);
    // Explicit override wins in both directions.
    expect(resolveAbortOnSilentFailure({ cfg: flag(true), override: false })).toBe(false);
    expect(resolveAbortOnSilentFailure({ cfg: flag(false), override: true })).toBe(true);
  });
});
