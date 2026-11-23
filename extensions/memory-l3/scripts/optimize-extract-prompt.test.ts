import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRecommendation,
  loadVariantTable,
  parseJudgeStdout,
  rankResults,
  runVariantEvaluation,
  selectVariantsWithinBudget,
  VariantTableError,
  type VariantEvalResult,
} from "./optimize-extract-prompt.js";

/**
 * ARCH-3 Phase 1 (2026-11-23): extract-prompt optimization harness tests.
 * D1 file-order law: the table/OFF-adjacent core suite leads — here the
 * validator laws on the REAL committed table come first (zero LLM spend).
 */

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REAL_TABLE_PATH = path.join(SCRIPT_DIR, "extract-prompt-variants.json");

function validTableJson(
  overrides: string = '{"variants":[{"id":"v20-baseline","target":"extract","systemPrompt":"BASELINE TEXT"}]}',
): string {
  return overrides;
}

function result(
  variantId: string,
  accuracy: number,
  perType: Record<string, { total: number; hits: number }> = {},
): VariantEvalResult {
  return { variantId, accuracy, perType, hypothesisPath: "", metaPath: "" };
}

describe("H1: loadVariantTable validation laws (real table + failure modes)", () => {
  it("loads the committed real table: baseline first, unique ids, valid targets, non-empty text", () => {
    const table = loadVariantTable(
      validTableJson(require("node:fs").readFileSync(REAL_TABLE_PATH, "utf8")),
    );
    expect(table.length).toBeGreaterThanOrEqual(2);
    expect(table[0]).toMatchObject({ id: "v20-baseline", target: "extract" });
    const ids = new Set(table.map((v) => v.id));
    expect(ids.size).toBe(table.length);
    for (const v of table) {
      expect(v.systemPrompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("rejects malformed JSON", () => {
    expect(() => loadVariantTable("{not json")).toThrow(VariantTableError);
  });

  it("rejects a non-object / non-array-shape table", () => {
    expect(() => loadVariantTable("[]")).toThrow(VariantTableError);
    expect(() => loadVariantTable('{"nope":1}')).toThrow(VariantTableError);
    expect(() => loadVariantTable('{"variants":[]}')).toThrow(VariantTableError);
  });

  it("rejects a non-array variants field", () => {
    expect(() => loadVariantTable('{"variants":"nope"}')).toThrow(VariantTableError);
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      loadVariantTable(
        '{"variants":[{"id":"v20-baseline","target":"extract","systemPrompt":"a"},{"id":"v20-baseline","target":"native","systemPrompt":"b"}]}',
      ),
    ).toThrow(/duplicate/u);
  });

  it("rejects a target outside the enum", () => {
    expect(() =>
      loadVariantTable('{"variants":[{"id":"v20-baseline","target":"both","systemPrompt":"a"}]}'),
    ).toThrow(/extract" or "native/u);
  });

  it("rejects empty systemPrompt text", () => {
    expect(() =>
      loadVariantTable(
        '{"variants":[{"id":"v20-baseline","target":"extract","systemPrompt":"   "}]}',
      ),
    ).toThrow(/non-empty systemPrompt/u);
  });

  it("rejects a table whose first entry is not the v20-baseline extract baseline", () => {
    expect(() =>
      loadVariantTable('{"variants":[{"id":"v21-x","target":"extract","systemPrompt":"a"}]}'),
    ).toThrow(/first variant must be/u);
    expect(() =>
      loadVariantTable('{"variants":[{"id":"v20-baseline","target":"native","systemPrompt":"a"}]}'),
    ).toThrow(/first variant must be/u);
  });
});

describe("H2: rankResults — accuracy primary, per-type tiebreak, deterministic, non-mutating", () => {
  it("ranks by accuracy descending", () => {
    const ranked = rankResults([result("a", 0.5), result("b", 0.9), result("c", 0.7)]);
    expect(ranked.map((r) => r.variantId)).toEqual(["b", "c", "a"]);
  });

  it("breaks accuracy ties by per-type aggregate mean", () => {
    const ranked = rankResults([
      result("a", 0.8, { x: { total: 10, hits: 5 } }),
      result("b", 0.8, { x: { total: 10, hits: 9 } }),
    ]);
    expect(ranked.map((r) => r.variantId)).toEqual(["b", "a"]);
  });

  it("fully-equal scores fall back to variantId ascending (deterministic)", () => {
    const ranked = rankResults([result("z", 0.5), result("a", 0.5), result("m", 0.5)]);
    expect(ranked.map((r) => r.variantId)).toEqual(["a", "m", "z"]);
  });

  it("does not mutate the input array", () => {
    const input = [result("a", 0.1), result("b", 0.9)];
    rankResults(input);
    expect(input.map((r) => r.variantId)).toEqual(["a", "b"]);
  });
});

describe("H3: buildRecommendation shape + guard disqualification", () => {
  it("recommends the top ranked, guard-clean variant with the full JSON shape", () => {
    const rec = buildRecommendation({
      ranked: [result("b", 0.9), result("v20-baseline", 0.8)],
      baselineAccuracy: 0.8,
      guards: [
        { variantId: "b", guard: "repeated-compaction-test.mjs", passed: true, detail: "exit 0" },
      ],
    });
    expect(rec.recommendedVariantId).toBe("b");
    expect(rec.baselineAccuracy).toBe(0.8);
    expect(rec.results).toHaveLength(2);
    expect(rec.guards).toHaveLength(1);
    expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(rec.tip).toMatch(/never self-applies/u);
  });

  it("a guard-disqualified variant can never be recommended", () => {
    const rec = buildRecommendation({
      ranked: [result("b", 0.9), result("v20-baseline", 0.8)],
      baselineAccuracy: 0.8,
      guards: [
        { variantId: "b", guard: "temporal-survival-audit.mjs", passed: false, detail: "exit 1" },
      ],
    });
    expect(rec.recommendedVariantId).toBe("v20-baseline");
  });

  it("all disqualified ⇒ recommendedVariantId null", () => {
    const rec = buildRecommendation({
      ranked: [result("b", 0.9), result("c", 0.8)],
      baselineAccuracy: 0.7,
      guards: [
        { variantId: "b", guard: "g", passed: false, detail: "x" },
        { variantId: "c", guard: "g", passed: false, detail: "x" },
      ],
    });
    expect(rec.recommendedVariantId).toBeNull();
    expect(rec.tip).toMatch(/keep v20/u);
  });
});

describe("H4: budget accounting — exhaustive within budget, baseline always first", () => {
  const table = loadVariantTable(
    '{"variants":[' +
      '{"id":"v20-baseline","target":"extract","systemPrompt":"a"},' +
      '{"id":"v2","target":"extract","systemPrompt":"b"},' +
      '{"id":"v3","target":"native","systemPrompt":"c"},' +
      '{"id":"v4","target":"extract","systemPrompt":"d"}]}',
  );

  it("slices to budget with the baseline at index 0", () => {
    expect(selectVariantsWithinBudget(table, 3).map((v) => v.id)).toEqual([
      "v20-baseline",
      "v2",
      "v3",
    ]);
    expect(selectVariantsWithinBudget(table, 1).map((v) => v.id)).toEqual(["v20-baseline"]);
  });

  it("budget beyond the table returns everything", () => {
    expect(selectVariantsWithinBudget(table, 99)).toHaveLength(4);
  });

  it("budget < 1 throws (never silently skip the baseline)", () => {
    expect(() => selectVariantsWithinBudget(table, 0)).toThrow(VariantTableError);
  });
});

describe("H5: --dryRun smoke (exit 0, lists table, zero LLM spend, writes no JSON)", () => {
  it("exits 0 and lists the real table without writing the output file", () => {
    const outputPath = path.join("/tmp", `lme-optimal-prompt-dryrun-${Date.now()}.json`);
    const run = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        path.join(SCRIPT_DIR, "optimize-extract-prompt.ts"),
        `--output=${outputPath}`,
        "--dryRun",
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/table valid/u);
    expect(run.stdout).toMatch(/v20-baseline/u);
    expect(require("node:fs").existsSync(outputPath)).toBe(false);
  }, 120_000);
});

describe("H6: runVariantEvaluation env composition (fake child echoes env)", () => {
  it("engine env carries OVERRIDE + TARGET and composes with, never clobbers, ZENBRAIN_SCORING_JSON", () => {
    const capturedEnvs: NodeJS.ProcessEnv[] = [];
    const fakeSpawn = ((_cmd: string, cliArgs: string[], options: { env: NodeJS.ProcessEnv }) => {
      capturedEnvs.push(options.env);
      if (cliArgs.some((a) => a.includes("score-longmemeval.mjs"))) {
        return {
          status: 0,
          stdout: "  single      5/10 (50%)\n  OVERALL     8/10 (80%)\n",
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: "Wrote /tmp/hypothesis-engine-fake.jsonl\nmemory/runmeta-engine-fake.json\n",
        stderr: "",
      };
    }) as unknown as typeof import("node:child_process").spawnSync;

    const previousScoring = process.env.ZENBRAIN_SCORING_JSON;
    process.env.ZENBRAIN_SCORING_JSON = '{"weightLexical":0.25}';
    try {
      const evaluated = runVariantEvaluation({
        variant: { id: "v21-fake", target: "native", systemPrompt: "FAKE VARIANT" },
        cacheDir: "/tmp/lme-cache",
        stratified: 2,
        concurrency: 1,
        oraclePath: "/tmp/oracle.json",
        spawnImpl: fakeSpawn as never,
        writeOverrideFile: () => "/fake/override.txt",
      });
      // Engine env (first spawn): both seam keys + preserved scoring json.
      const engineEnv = capturedEnvs[0]!;
      expect(engineEnv.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE).toBe("/fake/override.txt");
      expect(engineEnv.ZENBRAIN_EXTRACT_PROMPT_TARGET).toBe("native");
      expect(engineEnv.ZENBRAIN_SCORING_JSON).toBe('{"weightLexical":0.25}');
      // Judge call (second spawn) runs WITHOUT the seam keys (ranking judge
      // is prompt-independent) and still sees ambient scoring config.
      const judgeEnv = capturedEnvs[1]!;
      expect(judgeEnv.ZENBRAIN_EXTRACT_PROMPT_OVERRIDE).toBeUndefined();
      expect(judgeEnv.ZENBRAIN_SCORING_JSON).toBe('{"weightLexical":0.25}');
      expect(evaluated).toMatchObject({ variantId: "v21-fake", accuracy: 0.8 });
      expect(evaluated.hypothesisPath).toBe("/tmp/hypothesis-engine-fake.jsonl");
    } finally {
      if (previousScoring === undefined) {
        delete process.env.ZENBRAIN_SCORING_JSON;
      } else {
        process.env.ZENBRAIN_SCORING_JSON = previousScoring;
      }
    }
  });
});

describe("D4: parseJudgeStdout fixture contract (real score-longmemeval.mjs shape)", () => {
  // Captured shape from score-longmemeval.mjs summary printing: two-space
  // indent, padEnd(28) columns, `type hits/total (pct%)` lines, OVERALL line,
  // plus "N of M" temporal/supersession wording that must NOT parse as types.
  const FIXTURE = [
    "# LongMemEval LLM-judge scoring",
    "Hypothesis: /tmp/hyp.jsonl",
    "Judge: glm-5.2",
    "Concurrency: 4",
    "",
    "  single                        3/5 (60%)",
    "  multi                         2/5 (40%)",
    "  OVERALL                       5/10 (50%)",
    "  temporal expressions preserved: 7 of 9 across 10 answers (77%)",
    "  supersession correct-slot: 2 of 3 probed knowledge-update answers (66%)",
  ].join("\n");

  it("parses OVERALL accuracy and per-type rows; ignores N-of-M wording", () => {
    const parsed = parseJudgeStdout(FIXTURE);
    expect(parsed).not.toBeNull();
    expect(parsed!.accuracy).toBeCloseTo(0.5, 10);
    expect(parsed!.perType).toEqual({
      single: { hits: 3, total: 5 },
      multi: { hits: 2, total: 5 },
    });
  });

  it("returns null when the OVERALL line is missing (contract drift = loud failure)", () => {
    expect(parseJudgeStdout("no summary here")).toBeNull();
  });
});
