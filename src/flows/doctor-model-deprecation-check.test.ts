// Model-deprecation check: vision-drop warning note + provider-index caps projection.
import { describe, expect, it } from "vitest";
import { loadOpenClawProviderIndex } from "../model-catalog/provider-index/index.js";
import { buildProviderIndexInputCaps, visionDropNote } from "./doctor-model-deprecation-check.js";

const CAPS = buildProviderIndexInputCaps({
  providers: {
    deepseek: {
      id: "deepseek",
      previewCatalog: {
        models: [
          { id: "deepseek-flash", input: ["text"] },
          { id: "deepseek-v4-flash", input: ["text"] },
          { id: "deepseek-v4-flash-vision-exp", input: ["text", "image"] },
          // Mixed-case id proves keys are normalized to lowercase on insert.
          { id: "DeepSeek-V4-Pro", input: ["text"] },
        ],
      },
    },
  },
});

function rewriteAction(provider: string, modelId: string, replacementModelId: string) {
  return {
    binding: { kind: "alias", alias: "x", ref: { provider, modelId } },
    outcome: "rewrite" as const,
    replacementModelId,
  };
}

describe("buildProviderIndexInputCaps", () => {
  it("keys input modalities by provider/model, lowercased", () => {
    expect(CAPS.get("deepseek/deepseek-v4-flash-vision-exp")).toEqual(new Set(["text", "image"]));
    expect(CAPS.get("deepseek/deepseek-v4-pro")).toEqual(new Set(["text"]));
  });
});

describe("visionDropNote", () => {
  it("warns when a text-only replacement silently drops image input", () => {
    const note = visionDropNote(
      rewriteAction("deepseek", "deepseek-v4-flash-vision-exp", "deepseek-flash"),
      CAPS,
    );
    expect(note).toContain("deepseek-v4-flash-vision-exp");
    expect(note).toContain("deepseek-flash");
    expect(note).toContain("drops vision capability");
  });

  it("stays silent when both sides are text-only", () => {
    expect(
      visionDropNote(rewriteAction("deepseek", "deepseek-v4-flash", "deepseek-flash"), CAPS),
    ).toBeNull();
  });

  it("stays silent when the replacement also accepts images", () => {
    const withVisionKeep = new Map(CAPS, [["deepseek/vision-keep", new Set(["text", "image"])]]);
    expect(
      visionDropNote(
        rewriteAction("deepseek", "deepseek-v4-flash-vision-exp", "vision-keep"),
        withVisionKeep,
      ),
    ).toBeNull();
  });

  it("stays silent when either side is unknown or the pin is cleared", () => {
    expect(
      visionDropNote(rewriteAction("deepseek", "unknown-model", "deepseek-flash"), CAPS),
    ).toBeNull();
    expect(
      visionDropNote(
        {
          binding: {
            kind: "alias",
            alias: "x",
            ref: { provider: "deepseek", modelId: "deepseek-v4-flash-vision-exp" },
          },
          outcome: "clear" as const,
        },
        CAPS,
      ),
    ).toBeNull();
  });

  it("fires for the live provider index: retired deepseek vision alias -> deepseek-flash", () => {
    const liveCaps = buildProviderIndexInputCaps(loadOpenClawProviderIndex());
    expect(
      visionDropNote(
        rewriteAction("deepseek", "deepseek-v4-flash-vision-exp", "deepseek-flash"),
        liveCaps,
      ),
    ).toContain("drops vision capability");
  });
});
