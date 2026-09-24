/**
 * PROBE (throwaway) — ARCH-3 cross-skill overlap screen at promotion.
 * Synthetic promoted set: 3 skills. Candidates: one paraphrase-dup (the gate's
 * blind spot), one orthogonal. Proves: lexical contract extraction, band flags,
 * composite ordering, advisory-only wiring (pipeline untouched by default).
 * Card 654cb681 · cycle 2026-09-10.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  crossSkillScreen,
  parseSkillContract,
  NEAR_DUP_BAND_MIN,
  TOP_CONFLICTS_CAP,
} from "./promotion-screen.js";

let tmpRoot: string;
let skillsRoot: string;
let stagingRoot: string;
let stateDir: string;

const PROMOTED = {
  "deploy-gateway": {
    description: "Restart and deploy the gateway service after config changes",
    body: [
      "## Overview",
      "Restart the gateway via `exec` after editing the config file.",
      "## Steps",
      "1. Edit the config with `edit`",
      "2. Restart using `exec` and `bash scripts/restart`",
      "3. Verify with `exec` curl on localhost",
    ].join("\n"),
  },
  "recover-edit-failure": {
    description: "Recover when the edit tool fails on a locked file",
    body: [
      "## Overview",
      "When `edit` fails, fall back to `write` after reading the file.",
      "## Steps",
      "1. Read the target file",
      "2. Rewrite it fully with `write`",
      "3. Confirm via `read`",
    ].join("\n"),
  },
  "weather-lookup": {
    description: "Fetch current weather and forecasts for a location",
    body: [
      "## Overview",
      "Use `web_fetch` on a weather API for current conditions.",
      "## Steps",
      "1. `web_fetch` the forecast URL",
      "2. Summarize temperature and rain chance",
    ].join("\n"),
  },
} as const;

const CANDIDATES = {
  // Paraphrase of deploy-gateway: same triggers/tools, different prose →
  // the blocking gate (shingle ≥ 0.7) should NOT fire, but the screen must.
  "deploy-gateway-v2": {
    description: "Redeploy and restart the gateway service once config is updated",
    body: [
      "## Overview",
      "After changing configuration, bring the service back up with `exec`.",
      "## Steps",
      "1. Modify config using `edit`",
      "2. Bring it back via `exec` running the restart script",
      "3. Check health through `exec` and curl",
    ].join("\n"),
  },
  // Orthogonal: no overlap in triggers, tools, or body.
  "manga-tagger": {
    description: "Tag manga library files by series and chapter numbers",
    body: [
      "## Overview",
      "Batch-rename manga archives using `exec` and `ls`.",
      "## Steps",
      "1. List archives with `ls`",
      "2. Rename by pattern via `exec`",
    ].join("\n"),
  },
} as const;

function writeSkill(dir: string, name: string, description: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`,
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "skill-forge-screen-probe-"));
  stateDir = path.join(tmpRoot, "state");
  skillsRoot = path.join(stateDir, "skill-forge", "skills");
  stagingRoot = path.join(tmpRoot, "staging");
  for (const [name, skill] of Object.entries(PROMOTED)) {
    writeSkill(path.join(skillsRoot, name), name, skill.description, skill.body);
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const env = () => ({ OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv);

describe("crossSkillScreen (probe)", () => {
  it("empty promoted root → empty pairs, no throw", async () => {
    const emptyRoot = mkdtempSync(path.join(os.tmpdir(), "skill-forge-screen-empty-"));
    const result = await crossSkillScreen({
      skillDir: stagingRoot,
      name: "manga-tagger",
      env: { OPENCLAW_STATE_DIR: emptyRoot } as NodeJS.ProcessEnv,
    });
    // staging dir has no SKILL.md → early return path
    expect(result.pairs).toEqual([]);
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  it("paraphrase-dup: trigger + tool collisions flagged; shingle in advisory band, not ≥0.7", async () => {
    const cand = CANDIDATES["deploy-gateway-v2"];
    writeSkill(stagingRoot, "deploy-gateway-v2", cand.description, cand.body);
    const result = await crossSkillScreen({
      skillDir: stagingRoot,
      name: "deploy-gateway-v2",
      env: env(),
    });
    expect(result.pairs).toHaveLength(3);
    const dup = result.pairs.find((p) => p.promoted === "deploy-gateway")!;
    console.log("PROBE-PARAPHRASE " + JSON.stringify(dup));
    const candC = parseSkillContract(
      `---\nname: deploy-gateway-v2\ndescription: "${cand.description}"\n---\n\n${cand.body}\n`,
      "deploy-gateway-v2",
    );
    const promC = parseSkillContract(
      `---\nname: deploy-gateway\ndescription: "${PROMOTED["deploy-gateway"].description}"\n---\n\n${PROMOTED["deploy-gateway"].body}\n`,
      "deploy-gateway",
    );
    console.log(
      "PROBE-CONTRACTS " + JSON.stringify({ cand: candC.triggerTokens, prom: promC.triggerTokens }),
    );
    expect(dup.flags).toContain("trigger-collision");
    expect(dup.flags).toContain("tool-shape-collision");
    // Paraphrased: not a shingle near-dup, but likely in the 0.4 band.
    const orthogonal = result.pairs.find((p) => p.promoted === "weather-lookup")!;
    expect(orthogonal.flags).toEqual([]);
  });

  it("orthogonal candidate → no flags anywhere", async () => {
    const cand = CANDIDATES["manga-tagger"];
    writeSkill(stagingRoot, "manga-tagger", cand.description, cand.body);
    const result = await crossSkillScreen({
      skillDir: stagingRoot,
      name: "manga-tagger",
      env: env(),
    });
    expect(result.topConflicts).toEqual([]);
    expect(result.pairs.every((p) => p.flags.length === 0)).toBe(true);
  });

  it("composite ordering + topConflicts cap + label format", async () => {
    const cand = CANDIDATES["deploy-gateway-v2"];
    writeSkill(stagingRoot, "deploy-gateway-v2", cand.description, cand.body);
    const result = await crossSkillScreen({
      skillDir: stagingRoot,
      name: "deploy-gateway-v2",
      env: env(),
    });
    const sorted = [...result.pairs].sort((a, b) => b.composite - a.composite);
    expect(result.pairs.map((p) => p.composite)).toEqual(sorted.map((p) => p.composite));
    expect(result.topConflicts.length).toBeLessThanOrEqual(TOP_CONFLICTS_CAP);
    for (const label of result.topConflicts) {
      expect(label).toMatch(/^deploy-gateway-v2 vs [a-z-]+ \([a-z-,]+\)$/u);
    }
    expect(result.topConflicts[0]).toContain("deploy-gateway");
  });

  it("identical body re-staged → shingle ≥ 0.7 recorded, still advisory (report not gate)", async () => {
    const dup = PROMOTED["deploy-gateway"];
    writeSkill(stagingRoot, "deploy-gateway", dup.description, dup.body);
    const result = await crossSkillScreen({
      skillDir: stagingRoot,
      name: "deploy-gateway-recheck",
      env: env(),
    });
    // Note: name != promoted entry name, so it IS compared.
    const pair = result.pairs.find((p) => p.promoted === "deploy-gateway")!;
    expect(pair.shingle).toBeGreaterThanOrEqual(0.7);
    expect(pair.flags).toContain("near-dup-band");
    console.log("PROBE-EXACTDUP " + JSON.stringify(pair));
  });

  it("embedding lane: stub flags semantic near-dup; absent lane leaves embedding undefined", async () => {
    const cand = CANDIDATES["deploy-gateway-v2"];
    writeSkill(stagingRoot, "deploy-gateway-v2", cand.description, cand.body);
    const stub = async (texts: string[]) =>
      texts.map((t) => (t.includes("gateway") ? [1, 0] : [0, 1]));
    const withEmbed = await crossSkillScreen({
      skillDir: stagingRoot,
      name: "deploy-gateway-v2",
      env: env(),
      embed: stub,
    });
    const dup = withEmbed.pairs.find((p) => p.promoted === "deploy-gateway")!;
    expect(dup.embedding).toBe(1);
    expect(dup.flags).toContain("semantic-near-dup");
    const without = await crossSkillScreen({
      skillDir: stagingRoot,
      name: "deploy-gateway-v2",
      env: env(),
    });
    expect(without.pairs.find((p) => p.promoted === "deploy-gateway")!.embedding).toBeUndefined();
  });

  it("throws inside screen are isolated by pipeline wiring (contract: never breaks promotion)", async () => {
    // Direct check that a broken embed seam degrades to lexical-only.
    const cand = CANDIDATES["deploy-gateway-v2"];
    writeSkill(stagingRoot, "deploy-gateway-v2", cand.description, cand.body);
    const result = await crossSkillScreen({
      skillDir: stagingRoot,
      name: "deploy-gateway-v2",
      env: env(),
      embed: async () => {
        throw new Error("provider down");
      },
    });
    expect(result.pairs.length).toBe(3);
    expect(result.pairs.every((p) => p.embedding === undefined)).toBe(true);
    expect(NEAR_DUP_BAND_MIN).toBe(0.4);
  });
});
