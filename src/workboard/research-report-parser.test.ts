import { describe, expect, it } from "vitest";
import {
  parseAnalysisReport,
  parseImplementationReport,
  parseResearchReport,
} from "./research-report-parser.js";

const LLM_RESEARCH = `# LLM Research Daily Scan — 2026-06-21

## Top Findings

### 1. H-RePlan: Hierarchical Recovery for Cross-Device Agent Systems

- **Source:** arXiv:2606.20487 (Jun 18, 2026)
- **Summary:** Proposes a hierarchical replanning framework for multi-device agents.
- **OpenClaw Integration Relevance:** Maps to agent runtime & cooperative steering.

### 2. Learning What to Remember

- **Source:** arXiv:2606.12945 (Jun 11, 2026)
- **Summary:** Proposes a multi-factor memory value function over seven factors.
- **OpenClaw Integration Relevance:** Directly maps to Memory-L3 / L3 retrieval.

## Quick Wins

1. **Add goal-relevance and reliability factors to L3 promotion scoring** (from Finding 2).
2. **Replace recency truncation with query-aware selection** (from Finding 3).

## Longer Bets

1. **Implement residual-tree organization for L3 typed facts** (from Finding 8).

## Watch List

- **Vortex (arXiv:2606.06453)** — programmable sparse attention serving for AI agents.
`;

const ANALYSIS = `# OpenClaw Source Analysis — 2026-06-21

## ⚡ Quick Wins

### QW-1: Add goal-relevance & reliability factors to L3 promotion scoring
**Source finding:** #2 (Learning What to Remember — multi-factor value model)
**Complexity:** S · **Risk:** Low

**Current state:** scoring.ts already uses a weighted composite.

**Change:**
1. Add goalRelevance and reliability to the Signals type.

## 🏗️ Architecture

### ARCH-1: Replace recency truncation with query-aware submodular selection (PACMS)
**Source finding:** #3 (PACMS — Submodular Context Selection)
**Complexity:** L · **Risk:** Medium

**Current state:** compaction.ts implements the 5-phase pipeline.

## ⚠️ Contradictory

### CONTRA-1: Vortex — Programmable sparse attention serving
**Source finding:** #6 (Vortex)

Monitor for provider adoption, but don't implement.

## Recommended Action Order

1. **QW-3** (model discovery) — zero code, verify config
2. **QW-1** (add goal-relevance + reliability to scoring) — small, additive
3. **ARCH-1** (PACMS submodular selection) — larger, needs design doc
`;

const IMPLEMENTATION = `# OpenClaw Implementation Report — 2026-06-21
Status: COMPLETE — 2 implemented, 1 skipped, 0 failed
Source: openclaw-analysis-2026-06-21.md

## Implemented

### QW-1: Add goal-relevance & reliability factors to L3 scoring ✅
- **Files changed:** \`scoring.ts\`, \`scoring.test.ts\`, \`retrieval.ts\`
- **Tests:** 31 passed (scoring.test.ts)
- **Commit:** \`22f4a4e36a\` — feat(daily-research): QW-1

## Skipped

### QW-3: Onboard DeepSeek-V4-Flash via live model discovery
- **Reason:** Zero code change required.

## Remaining Backlog

### 🏗️ Architecture
- **ARCH-1:** Replace recency truncation with query-aware submodular selection (PACMS) — Large
- **ARCH-3:** Decouple L2→L3 consolidation into fully async parallel process — XL
`;

describe("parseResearchReport", () => {
  it("extracts findings with source/summary/relevance", () => {
    const { data } = parseResearchReport(LLM_RESEARCH);
    expect(data.findings).toHaveLength(2);
    expect(data.findings[0]).toMatchObject({
      index: 1,
      title: expect.stringContaining("H-RePlan"),
    });
    expect(data.findings[1].source).toContain("arXiv:2606.12945");
    expect(data.findings[1].relevance).toContain("Memory-L3");
  });

  it("extracts quick-win / longer-bet / watch lists", () => {
    const { data } = parseResearchReport(LLM_RESEARCH);
    expect(data.quickWins).toHaveLength(2);
    expect(data.quickWins[0]).toContain("goal-relevance");
    expect(data.longerBets[0]).toContain("residual-tree");
    expect(data.watchList[0]).toContain("Vortex");
  });
});

describe("parseAnalysisReport", () => {
  it("parses categorized items with facets and source finding", () => {
    const { data } = parseAnalysisReport(ANALYSIS);
    const byId = Object.fromEntries(data.items.map((i) => [i.itemId, i]));
    expect(Object.keys(byId).sort()).toEqual(["ARCH-1", "CONTRA-1", "QW-1"]);
    expect(byId["QW-1"]).toMatchObject({ category: "quick-win", complexity: "S", risk: "Low" });
    expect(byId["QW-1"].sourceFinding).toBe("#2");
    expect(byId["ARCH-1"]).toMatchObject({ category: "architecture", risk: "Medium" });
    expect(byId["CONTRA-1"].category).toBe("contradictory");
  });

  it("applies recommended action order ranks", () => {
    const { data } = parseAnalysisReport(ANALYSIS);
    const byId = Object.fromEntries(data.items.map((i) => [i.itemId, i]));
    expect(byId["QW-1"].actionOrder).toBe(2);
    expect(byId["ARCH-1"].actionOrder).toBe(3);
  });
});

describe("parseImplementationReport", () => {
  it("parses implemented + skipped outcomes with commit + files", () => {
    const { data } = parseImplementationReport(IMPLEMENTATION);
    const byId = Object.fromEntries(data.items.map((i) => [i.itemId, i]));
    expect(byId["QW-1"]).toMatchObject({ outcome: "implemented", commit: "22f4a4e36a" });
    expect(byId["QW-1"].filesChanged).toContain("scoring.ts");
    expect(byId["QW-3"].outcome).toBe("skipped");
  });

  it("parses remaining backlog with item ids", () => {
    const { data } = parseImplementationReport(IMPLEMENTATION);
    expect(data.status).toContain("COMPLETE");
    const ids = data.backlog.map((b) => b.itemId);
    expect(ids).toContain("ARCH-1");
    expect(ids).toContain("ARCH-3");
  });
});
