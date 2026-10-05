// Model-deprecation check: vision-drop warning note + provider-index caps projection.
import { describe, expect, it } from "vitest";
import { loadOpenClawProviderIndex } from "../model-catalog/provider-index/index.js";
import {
  buildProviderIndexInputCaps,
  serveSwapNote,
  visionDropNote,
} from "./doctor-model-deprecation-check.js";

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

const SWAPS = [
  { provider: "deepseek", from: "deepseek-v4-flash", to: "DeepSeek-V4.1-Flash-1003" },
  // Mixed casing proves matching is case-insensitive on both provider and id.
  { provider: "ZAI", from: "GLM-5.1", to: "glm-5.2" },
];

describe("serveSwapNote", () => {
  it("warns when the pinned name is now served as a different snapshot id", () => {
    const note = serveSwapNote(
      rewriteAction("deepseek", "deepseek-v4-flash", "deepseek-flash"),
      SWAPS,
    );
    expect(note).toContain("deepseek-v4-flash");
    expect(note).toContain("DeepSeek-V4.1-Flash-1003");
    expect(note).toContain("behavior changed behind a stable name");
  });

  it("matches provider and model id case-insensitively", () => {
    const note = serveSwapNote(rewriteAction("zai", "glm-5.1", "glm-5.2"), SWAPS);
    expect(note).toContain("glm-5.2");
  });

  it("stays silent when the pin has no recorded upgrade link", () => {
    expect(
      serveSwapNote(rewriteAction("deepseek", "deepseek-chat", "deepseek-flash"), SWAPS),
    ).toBeNull();
    expect(serveSwapNote(rewriteAction("other", "deepseek-v4-flash", "x"), SWAPS)).toBeNull();
  });

  it("fires also for clear-outcome actions (the swap explains the loss)", () => {
    const note = serveSwapNote(
      {
        binding: {
          kind: "alias",
          alias: "x",
          ref: { provider: "deepseek", modelId: "deepseek-v4-flash" },
        },
        outcome: "clear" as const,
      },
      SWAPS,
    );
    expect(note).toContain("DeepSeek-V4.1-Flash-1003");
  });

  it("stays silent with no probe data (providers without snapshot ids)", () => {
    expect(
      serveSwapNote(rewriteAction("deepseek", "deepseek-v4-flash", "deepseek-flash"), []),
    ).toBeNull();
  });
});
