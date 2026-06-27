import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { inheritSessionRuntimeSelection } from "./sessions.js";

// A new session created from a parent must respect the agent's configured
// default model. Only a deliberate USER model pick carries forward; auto-fallback
// overrides (e.g. a quota fallback that pinned a different model) and the runtime
// effective model are execution artifacts and must NOT be inherited, or new
// sessions would silently override the configured default.
describe("inheritSessionRuntimeSelection", () => {
  const base: SessionEntry = { sessionId: "s", updatedAt: 1 } as SessionEntry;

  it("inherits a deliberate user model override", () => {
    const inherited = inheritSessionRuntimeSelection({
      ...base,
      providerOverride: "anthropic",
      modelOverride: "sonnet-4.6",
      modelOverrideSource: "user",
      contextTokens: 200000,
    } as SessionEntry);
    expect(inherited.providerOverride).toBe("anthropic");
    expect(inherited.modelOverride).toBe("sonnet-4.6");
    expect(inherited.modelOverrideSource).toBe("user");
    // Model-derived context budget rides along with a carried user pick.
    expect(inherited.contextTokens).toBe(200000);
  });

  it("does NOT inherit an auto-fallback override (modelOverrideSource=auto)", () => {
    const inherited = inheritSessionRuntimeSelection({
      ...base,
      providerOverride: "kimi",
      modelOverride: "kimi-for-coding",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "zai",
      modelOverrideFallbackOriginModel: "glm-5.2",
    } as SessionEntry);
    expect(inherited.providerOverride).toBeUndefined();
    expect(inherited.modelOverride).toBeUndefined();
    expect(inherited.modelOverrideSource).toBeUndefined();
  });

  it("does NOT inherit a legacy auto-fallback override (no source, has fallback provenance)", () => {
    const inherited = inheritSessionRuntimeSelection({
      ...base,
      providerOverride: "kimi",
      modelOverride: "kimi-for-coding",
      modelOverrideFallbackOriginProvider: "zai",
      modelOverrideFallbackOriginModel: "glm-5.2",
    } as SessionEntry);
    expect(inherited.providerOverride).toBeUndefined();
    expect(inherited.modelOverride).toBeUndefined();
  });

  it("does NOT inherit the runtime effective model (model/modelProvider)", () => {
    const inherited = inheritSessionRuntimeSelection({
      ...base,
      modelProvider: "kimi",
      model: "kimi-for-coding",
      contextTokens: 195000,
    } as SessionEntry);
    expect(inherited.model).toBeUndefined();
    expect(inherited.modelProvider).toBeUndefined();
    // Without a carried model, the model-derived budget must NOT ride along, or
    // the new session would carry a stale window for the resolved default model.
    expect(inherited.contextTokens).toBeUndefined();
  });

  it("still inherits non-model runtime selections (thinking, fastMode)", () => {
    const inherited = inheritSessionRuntimeSelection({
      ...base,
      thinkingLevel: "high",
      fastMode: true,
    } as SessionEntry);
    expect(inherited.thinkingLevel).toBe("high");
    expect(inherited.fastMode).toBe(true);
  });
});
