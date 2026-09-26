import { describe, expect, it } from "vitest";
import { INTENT_GATE_MAX_PROMPT_CHARS, isSelfContainedPrompt } from "./intent-gate.js";

// QW-2 (2026-09-26): intent gate before L3 recall. isSelfContainedPrompt() is
// the conservative lexical gate used by buildMemorySection(): only short
// prompts with NO memory-seeking signal (no first/second-person pronouns, no
// digits, no mid-sentence capitalized entities) may skip recall. Anything
// ambiguous must pass through so the gate never silently loses a
// memory-needing turn.
describe("isSelfContainedPrompt", () => {
  it("marks short pronoun-free acknowledgements as self-contained", () => {
    expect(isSelfContainedPrompt("ok")).toBe(true);
    expect(isSelfContainedPrompt("thanks, that works")).toBe(true);
    expect(isSelfContainedPrompt("go ahead")).toBe(true);
  });

  it("keeps recall for first/second-person pronouns (memory-seeking)", () => {
    expect(isSelfContainedPrompt("what did I say about the greenhouse")).toBe(false);
    expect(isSelfContainedPrompt("remind us about the trip")).toBe(false);
    expect(isSelfContainedPrompt("is that your final answer")).toBe(false);
  });

  it("keeps recall for digit/slot vocabulary (typed-fact lookups)", () => {
    expect(isSelfContainedPrompt("restart the node at 192.168.50.128")).toBe(false);
    expect(isSelfContainedPrompt("build v13 again")).toBe(false);
    expect(isSelfContainedPrompt("what happened on 2026-09-26")).toBe(false);
  });

  it("keeps recall for mid-sentence capitalized entities", () => {
    expect(isSelfContainedPrompt("restart HueyTheDestroyer now")).toBe(false);
    expect(isSelfContainedPrompt("run the Deploy stage")).toBe(false);
  });

  it("keeps recall for long prompts regardless of content", () => {
    expect(isSelfContainedPrompt("a".repeat(INTENT_GATE_MAX_PROMPT_CHARS + 1))).toBe(false);
  });

  it("is conservative on ambiguity: empty/whitespace-only is not self-contained", () => {
    expect(isSelfContainedPrompt("")).toBe(false);
    expect(isSelfContainedPrompt("   ")).toBe(false);
  });
});
