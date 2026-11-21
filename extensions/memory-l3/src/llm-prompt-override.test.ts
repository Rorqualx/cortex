import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetExtractPromptOverrideForTests,
  extractFacts,
  extractFactsNative,
  resolveExtractSystemPrompt,
  type LlmCaller,
} from "./llm.js";

// ARCH-3 Phase 1 probe tests (2026-11-20): the env-file override seam must be
// OFF-identical by default (byte-identical const flow through both extract
// lanes), surgical when armed (variant text reaches ONLY the targeted lane),
// and fail loud on misconfiguration.

type Captured = { systemPrompt: string; userPrompt: string };

const fakeCaller = (captured: Captured[]): LlmCaller => {
  return async (params) => {
    captured.push({ systemPrompt: params.systemPrompt, userPrompt: params.userPrompt });
    return JSON.stringify({ facts: [], typedFacts: [], decisions: [], actions: [] });
  };
};

const MESSAGES = [{ role: "user", content: "hello" }] as Parameters<typeof extractFacts>[0]["messages"];

let tempDir: string;

const ENV_KEYS = ["ZENBRAIN_EXTRACT_PROMPT_OVERRIDE", "ZENBRAIN_EXTRACT_PROMPT_TARGET"] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

beforeEach(() => {
  clearEnv();
  __resetExtractPromptOverrideForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "llm-prompt-override-"));
});

afterEach(() => {
  clearEnv();
  __resetExtractPromptOverrideForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveExtractSystemPrompt OFF identity", () => {
  it("returns the same bytes across calls with env absent (deterministic const)", () => {
    expect(resolveExtractSystemPrompt("extract")).toBe(resolveExtractSystemPrompt("extract"));
    expect(resolveExtractSystemPrompt("native")).toBe(resolveExtractSystemPrompt("native"));
    expect(resolveExtractSystemPrompt("extract")).not.toBe(resolveExtractSystemPrompt("native"));
  });

  it("OFF extractFacts/extractFactsNative lanes receive identical prompts as an unarmed second run", async () => {
    const offExtract: Captured[] = [];
    await extractFacts({ messages: MESSAGES, caller: fakeCaller(offExtract) });
    const offNative: Captured[] = [];
    await extractFactsNative({ messages: MESSAGES, caller: fakeCaller(offNative) });

    // Armed for the OTHER lane must leave this lane byte-identical.
    const overridePath = path.join(tempDir, "variant.txt");
    writeFileSync(overridePath, "VARIANT PROMPT TEXT", "utf8");
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "native";
    __resetExtractPromptOverrideForTests();

    const onExtract: Captured[] = [];
    await extractFacts({ messages: MESSAGES, caller: fakeCaller(onExtract) });
    expect(onExtract[0]!.systemPrompt).toBe(offExtract[0]!.systemPrompt);
    expect(onExtract[0]!.userPrompt).toBe(offExtract[0]!.userPrompt);

    clearEnv();
    __resetExtractPromptOverrideForTests();
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "extract";
    const onNative: Captured[] = [];
    await extractFactsNative({ messages: MESSAGES, caller: fakeCaller(onNative) });
    expect(onNative[0]!.systemPrompt).toBe(offNative[0]!.systemPrompt);
  });
});

describe("resolveExtractSystemPrompt armed", () => {
  it("variant text reaches ONLY the extract lane", async () => {
    const overridePath = path.join(tempDir, "variant.txt");
    writeFileSync(overridePath, "VARIANT-EXTRACT-TEXT", "utf8");
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "extract";

    const extractLane: Captured[] = [];
    await extractFacts({ messages: MESSAGES, caller: fakeCaller(extractLane) });
    expect(extractLane[0]!.systemPrompt).toBe("VARIANT-EXTRACT-TEXT");

    const nativeLane: Captured[] = [];
    await extractFactsNative({ messages: MESSAGES, caller: fakeCaller(nativeLane) });
    expect(nativeLane[0]!.systemPrompt).not.toBe("VARIANT-EXTRACT-TEXT");
  });

  it("variant text reaches ONLY the native lane", async () => {
    const overridePath = path.join(tempDir, "variant-native.txt");
    writeFileSync(overridePath, "VARIANT-NATIVE-TEXT", "utf8");
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "native";

    const nativeLane: Captured[] = [];
    await extractFactsNative({ messages: MESSAGES, caller: fakeCaller(nativeLane) });
    expect(nativeLane[0]!.systemPrompt).toBe("VARIANT-NATIVE-TEXT");

    const extractLane: Captured[] = [];
    await extractFacts({ messages: MESSAGES, caller: fakeCaller(extractLane) });
    expect(extractLane[0]!.systemPrompt).not.toBe("VARIANT-NATIVE-TEXT");
  });

  it("target defaults to extract when ZENBRAIN_EXTRACT_PROMPT_TARGET is unset", async () => {
    const overridePath = path.join(tempDir, "variant-default.txt");
    writeFileSync(overridePath, "VARIANT-DEFAULT-TARGET", "utf8");
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;

    const extractLane: Captured[] = [];
    await extractFacts({ messages: MESSAGES, caller: fakeCaller(extractLane) });
    expect(extractLane[0]!.systemPrompt).toBe("VARIANT-DEFAULT-TARGET");
  });
});

describe("resolveExtractSystemPrompt fail-loud laws", () => {
  it("throws on unreadable override file", () => {
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = path.join(tempDir, "does-not-exist.txt");
    expect(() => resolveExtractSystemPrompt("extract")).toThrow(/unreadable/);
  });

  it("throws on empty override file", () => {
    const overridePath = path.join(tempDir, "empty.txt");
    writeFileSync(overridePath, "   \n", "utf8");
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;
    expect(() => resolveExtractSystemPrompt("extract")).toThrow(/empty/);
  });

  it("throws on invalid target value", () => {
    const overridePath = path.join(tempDir, "variant.txt");
    writeFileSync(overridePath, "text", "utf8");
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "both";
    expect(() => resolveExtractSystemPrompt("extract")).toThrow(/must be "extract" or "native"/);
  });
});
