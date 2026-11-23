import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetExtractPromptOverrideForTests,
  extractFacts,
  extractFactsNative,
  resolveExtractSystemPrompt,
} from "./llm.js";

/**
 * ARCH-3 Phase 1 (2026-11-23): extract-prompt env-file override seam tests.
 * D1 file-order law: the OFF-identity suite is the FIRST describe block.
 */

const EMPTY_RESULT_JSON = '{"facts":[],"typedFacts":[],"decisions":[],"actions":[]}';

type Captured = { systemPrompt: string };

async function captureExtractSystemPrompt(lane: "extract" | "native"): Promise<Captured> {
  const captured: Captured = { systemPrompt: "" };
  const caller = async (params: { systemPrompt: string }): Promise<string> => {
    captured.systemPrompt = params.systemPrompt;
    return EMPTY_RESULT_JSON;
  };
  const messages = [{ role: "user", content: "hello world" }] as never[];
  if (lane === "extract") {
    await extractFacts({ messages, caller });
  } else {
    await extractFactsNative({ messages, caller });
  }
  return captured;
}

function writeTempOverride(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-prompt-override-"));
  const file = path.join(dir, "override.txt");
  writeFileSync(file, text, "utf8");
  return file;
}

const ENV_KEYS = ["ZENBRAIN_EXTRACT_PROMPT_OVERRIDE", "ZENBRAIN_EXTRACT_PROMPT_TARGET"] as const;

function clearSeamEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

let tempDirs: string[] = [];

beforeEach(() => {
  clearSeamEnv();
  __resetExtractPromptOverrideForTests();
});

afterEach(() => {
  clearSeamEnv();
  __resetExtractPromptOverrideForTests();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("OFF-identity (env absent ⇒ byte-identical constants, both lanes)", () => {
  it("resolver returns exactly what the unarmed production lanes send", async () => {
    const extract = await captureExtractSystemPrompt("extract");
    const native = await captureExtractSystemPrompt("native");
    expect(extract.systemPrompt.length).toBeGreaterThan(0);
    expect(native.systemPrompt.length).toBeGreaterThan(0);
    expect(extract.systemPrompt).not.toBe(native.systemPrompt);
    expect(resolveExtractSystemPrompt("extract")).toBe(extract.systemPrompt);
    expect(resolveExtractSystemPrompt("native")).toBe(native.systemPrompt);
  });

  it("seam env keys are absent in the test environment (guard)", () => {
    for (const key of ENV_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }
  });
});

describe("surgical arming (R2/R3)", () => {
  it("armed for extract: variant text at the extract lane ONLY, native lane const", async () => {
    const offExtract = await captureExtractSystemPrompt("extract");
    const offNative = await captureExtractSystemPrompt("native");
    const overrideText = "OVERRIDE EXTRACT MARKER — variant system prompt under test.";
    const overridePath = writeTempOverride(overrideText);
    tempDirs.push(path.dirname(overridePath));
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "extract";

    const onExtract = await captureExtractSystemPrompt("extract");
    const onNative = await captureExtractSystemPrompt("native");
    expect(onExtract.systemPrompt).toBe(overrideText);
    expect(onNative.systemPrompt).toBe(offNative.systemPrompt);
    expect(onExtract.systemPrompt).not.toBe(offExtract.systemPrompt);
  });

  it("armed for native: variant text at the native lane ONLY, extract lane const", async () => {
    const offExtract = await captureExtractSystemPrompt("extract");
    const overrideText = "OVERRIDE NATIVE MARKER — dense lane variant under test.";
    const overridePath = writeTempOverride(overrideText);
    tempDirs.push(path.dirname(overridePath));
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "native";

    const onExtract = await captureExtractSystemPrompt("extract");
    const onNative = await captureExtractSystemPrompt("native");
    expect(onNative.systemPrompt).toBe(overrideText);
    expect(onExtract.systemPrompt).toBe(offExtract.systemPrompt);
  });

  it("target defaults to extract when ZENBRAIN_EXTRACT_PROMPT_TARGET is unset", async () => {
    const overrideText = "DEFAULT TARGET MARKER — extract is the default lane.";
    const overridePath = writeTempOverride(overrideText);
    tempDirs.push(path.dirname(overridePath));
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;

    const onExtract = await captureExtractSystemPrompt("extract");
    expect(onExtract.systemPrompt).toBe(overrideText);
  });
});

describe("fail-loud law (R4)", () => {
  it("throws on an unreadable override path", () => {
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = path.join(
      tmpdir(),
      "does-not-exist-override.txt",
    );
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "extract";
    expect(() => resolveExtractSystemPrompt("extract")).toThrow(/unreadable/u);
  });

  it("throws on an empty override file", () => {
    const overridePath = writeTempOverride("   \n  ");
    tempDirs.push(path.dirname(overridePath));
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "extract";
    expect(() => resolveExtractSystemPrompt("extract")).toThrow(/empty/u);
  });

  it("throws on a bad target value", () => {
    const overridePath = writeTempOverride("text");
    tempDirs.push(path.dirname(overridePath));
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "both";
    expect(() => resolveExtractSystemPrompt("extract")).toThrow(/must be "extract" or "native"/u);
  });
});

describe("cache-reset law (R5)", () => {
  it("switching the override file re-reads; the module cache never leaks stale text", async () => {
    const first = writeTempOverride("FIRST VARIANT TEXT");
    const second = writeTempOverride("SECOND VARIANT TEXT");
    tempDirs.push(path.dirname(first), path.dirname(second));

    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = first;
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "extract";
    expect((await captureExtractSystemPrompt("extract")).systemPrompt).toBe("FIRST VARIANT TEXT");

    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = second;
    __resetExtractPromptOverrideForTests();
    expect((await captureExtractSystemPrompt("extract")).systemPrompt).toBe("SECOND VARIANT TEXT");

    // Back to the first path WITHOUT an explicit reset — keyed cache must re-arm.
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = first;
    expect((await captureExtractSystemPrompt("extract")).systemPrompt).toBe("FIRST VARIANT TEXT");
  });

  it("reset helper returns the seam to OFF (const) with env cleared", async () => {
    const overrideText = "TRANSIENT VARIANT";
    const overridePath = writeTempOverride(overrideText);
    tempDirs.push(path.dirname(overridePath));
    process.env.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE = overridePath;
    process.env.ZENBRAIN_EXTRACT_PROMPT_TARGET = "extract";
    expect((await captureExtractSystemPrompt("extract")).systemPrompt).toBe(overrideText);

    clearSeamEnv();
    __resetExtractPromptOverrideForTests();
    const off = await captureExtractSystemPrompt("extract");
    expect(off.systemPrompt).not.toBe(overrideText);
  });
});
