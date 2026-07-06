/**
 * Prompt-cache stability for per-turn system-prompt composition.
 *
 * Guards the invariant behind #85203: dynamic per-turn additions (media task hints, the
 * model-identity line) must land BELOW the system-prompt cache boundary so the cached
 * prefix stays byte-identical turn-to-turn. If any addition leaks into the prefix, an idle
 * turn and an active/media turn diverge and forfeit the provider cache-read discount.
 *
 * Self-contained: exercises the production helper `composeAttemptSystemPrompt` directly
 * (the exact code runEmbeddedAttempt calls), no gateway/provider/session needed.
 */
import { describe, expect, it } from "vitest";
import { splitSystemPromptCacheBoundary } from "../../system-prompt-cache-boundary.js";
import { composeAttemptSystemPrompt } from "./attempt.prompt-helpers.js";

const BASE = "You are OpenClaw.\nBe helpful.";
const MODEL = "anthropic/claude-opus-4-8";
const IDENTITY_MARKER = "Current model identity:";
const MEDIA = "Active image generation task: render a cat.";

/** The portion the provider caches: everything above the cache boundary. */
function cachedPrefix(systemPrompt: string): string {
  return splitSystemPromptCacheBoundary(systemPrompt)?.stablePrefix ?? systemPrompt;
}

describe("composeAttemptSystemPrompt cache stability", () => {
  it("keeps the cached prefix identical between an idle turn and a media turn", () => {
    const idle = composeAttemptSystemPrompt({ baseSystemPrompt: BASE, model: MODEL });
    const media = composeAttemptSystemPrompt({
      baseSystemPrompt: BASE,
      model: MODEL,
      mediaTaskAddition: MEDIA,
    });

    // The invariant: dynamic additions differ, cached prefix does not.
    expect(idle).not.toBe(media);
    expect(cachedPrefix(media)).toBe(cachedPrefix(idle));
    expect(cachedPrefix(idle)).toBe(BASE);
  });

  it("routes the model-identity line into the dynamic suffix, never the cached prefix", () => {
    const idle = composeAttemptSystemPrompt({ baseSystemPrompt: BASE, model: MODEL });

    expect(idle).toContain(`${IDENTITY_MARKER} ${MODEL}`);
    expect(cachedPrefix(idle)).not.toContain(IDENTITY_MARKER);
    expect(splitSystemPromptCacheBoundary(idle)?.dynamicSuffix).toContain(IDENTITY_MARKER);
  });

  it("keeps the cached prefix stable across a media turn even under hook prepend/append context", () => {
    const withMedia = (mediaTaskAddition?: string) =>
      composeAttemptSystemPrompt({
        baseSystemPrompt: BASE,
        model: MODEL,
        prependSystemContext: "Repository: openclaw",
        appendSystemContext: "Follow the house style.",
        mediaTaskAddition,
      });

    expect(cachedPrefix(withMedia(MEDIA))).toBe(cachedPrefix(withMedia(undefined)));
    // Static hook context belongs in the cached prefix; the dynamic media hint does not.
    expect(cachedPrefix(withMedia(undefined))).toContain("Repository: openclaw");
    expect(cachedPrefix(withMedia(MEDIA))).not.toContain(MEDIA);
  });

  it("keeps a marker-free hook systemPrompt override's prefix stable across turns", () => {
    const override = "Bespoke system prompt with no cache boundary marker.";
    const idle = composeAttemptSystemPrompt({
      baseSystemPrompt: BASE,
      model: MODEL,
      hookSystemPromptOverride: override,
    });
    const media = composeAttemptSystemPrompt({
      baseSystemPrompt: BASE,
      model: MODEL,
      hookSystemPromptOverride: override,
      mediaTaskAddition: MEDIA,
    });

    expect(cachedPrefix(idle)).toBe(override);
    expect(cachedPrefix(media)).toBe(cachedPrefix(idle));
    expect(cachedPrefix(idle)).not.toContain(IDENTITY_MARKER);
  });

  it("is pure: identical inputs yield byte-identical output", () => {
    const args = { baseSystemPrompt: BASE, model: MODEL, mediaTaskAddition: MEDIA } as const;
    expect(composeAttemptSystemPrompt({ ...args })).toBe(composeAttemptSystemPrompt({ ...args }));
  });

  it("leaves the prompt untouched when there is no model identity or addition", () => {
    expect(composeAttemptSystemPrompt({ baseSystemPrompt: BASE })).toBe(BASE);
    // Raw/gateway runs with no identity carry an empty prompt and gain no boundary marker.
    expect(composeAttemptSystemPrompt({ baseSystemPrompt: "" })).toBe("");
  });
});
