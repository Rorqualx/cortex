import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { beginPromptCacheObservation } from "../../../../src/agents/embedded-agent-runner/prompt-cache-observability.js";
import { prepareProviderPrompt } from "../../../../src/agents/embedded-agent-runner/provider-prompt-serialization.js";
import { aggregate, renderReport } from "../prompt-prefix-tax-audit.mjs";

// ────────────────────────────────────────────────────────────────────────────
// THROWAWAY probe harness (card 9e633f3e, probe stage 2026-10-17).
// Regenerate the feed:
//   node scripts/run-vitest.mjs extensions/memory-l3/scripts/probe/prompt-cache-capture-harness.test.ts
// Feed + report land in /tmp/labcron/. Section lengths are measured HERE at
// capture because observation snapshots persist digests only (plan §0).
// ────────────────────────────────────────────────────────────────────────────

// Pinned from packages/ai/src/utils/system-prompt-cache-boundary.ts:3
const CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";
const OUT_DIR = "/tmp/labcron";

function openL3(): DatabaseSync | null {
  const dbPath =
    process.env.OPENCLAW_L3_DB ?? path.join(homedir(), ".openclaw/workspace/.openclaw/l3/l3.sqlite");
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[harness] l3 open failed at ${dbPath}:`, (err as Error).message);
    return null;
  }
}

/** Pull realistic fact-sized text from the live store (read-only). */
function loadFacts(db: DatabaseSync | null, count: number): string[] {
  if (!db) {
    return Array.from({ length: count }, (_, i) => `fallback fact ${i + 1}: harness ran without l3.sqlite.`);
  }
  try {
    const rows = db
      .prepare(
        `SELECT data FROM l3_entities ORDER BY id LIMIT ${count + 8}`,
      )
      .all() as Array<{ data: string }>;
    const facts: string[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.data);
        const text =
          parsed.fact ?? parsed.statement ?? parsed.text ?? parsed.content ?? parsed.summary ?? null;
        if (typeof text === "string" && text.length > 20) facts.push(text.slice(0, 220));
      } catch {
        /* skip non-JSON entity payloads */
      }
      if (facts.length >= count) break;
    }
    if (facts.length >= 4) return facts;
  } catch {
    /* fall through to l2 chunks */
  }
  const chunks = db
    .prepare(`SELECT body FROM l3_l2_chunks ORDER BY created_at DESC LIMIT ${count}`)
    .all() as Array<{ body: string }>;
  return chunks.map((c) => c.body.replace(/\s+/g, " ").slice(0, 220));
}

const STABLE_SYSTEM = [
  "# Role",
  "You are an embedded agent inside OpenClaw. Follow AGENTS.md, use tools precisely,",
  "and keep replies terse. This stable preamble stands in for the system prompt,",
  "tool definitions, and skill guidance that the runner places above the cache boundary.",
  "",
].join("\n");

function buildTurn(recallFacts: string[], userMsg: string) {
  const recall = ["## Memory Recall", ...recallFacts.map((f, i) => `${i + 1}. ${f}`)].join("\n");
  const systemPrompt = STABLE_SYSTEM + CACHE_BOUNDARY + recall;
  return {
    systemPrompt,
    payload: {
      model: "glm-5.2",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      max_tokens: 512,
    },
  };
}

const est = (chars: number) => Math.max(1, Math.ceil(chars / 4));

describe("probe: prompt-prefix capture harness", () => {
  const db = openL3();
  it.skipIf(!db)("captures 3 turns and audits the feed", () => {
    const facts = loadFacts(db, 12);
    expect(facts.length).toBeGreaterThanOrEqual(4);

    const factsA = facts;
    const factsChurned = [factsA[0], factsA[1], `churned fact ${Date.now()}: new observation replacing an old one.`, ...factsA.slice(3)];
    const turns = [
      { label: "cold", facts: factsA, msg: "Summarize the recalled facts in one line." },
      { label: "stable", facts: factsA, msg: "Summarize the recalled facts in one line." },
      { label: "churned", facts: factsChurned, msg: "Summarize the recalled facts in one line." },
    ];

    const records: Array<Record<string, unknown>> = [];
    let prevSuffixDigest: string | undefined;
    const digests: string[] = [];
    for (const [i, t] of turns.entries()) {
      const { systemPrompt, payload } = buildTurn(t.facts, t.msg);

      // 1. Real observation path — verifies the boundary actually splits above
      //    Memory Recall and reports suffix-section digests.
      const start = beginPromptCacheObservation({
        sessionId: "probe-arch3-9e633f3e",
        provider: "zai",
        modelId: "glm-5.2",
        streamStrategy: "probe",
        transport: "https",
        systemPrompt,
        tools: [],
        messages: [{ role: "user", content: t.msg }],
      });
      const suffixDigest = start.snapshot.systemPromptSuffixDigest;
      digests.push(suffixDigest ?? "none");
      expect(suffixDigest).toBeDefined();

      // 2. Real serialization path — stable-prefix share of the wire body.
      const prep = prepareProviderPrompt({ payload, encode: JSON.stringify });
      expect(prep.cachePrefix?.system).toBeDefined();

      // 3. Capture-time section lengths (digests alone can't size sections).
      const boundaryIdx = systemPrompt.indexOf(CACHE_BOUNDARY);
      const stablePart = systemPrompt.slice(0, boundaryIdx);
      const suffixPart = systemPrompt.slice(boundaryIdx + CACHE_BOUNDARY.length);
      const recallBlock = suffixPart.slice(0, suffixPart.indexOf("\n## ") > 0 ? suffixPart.indexOf("\n## ") : undefined);
      const sections = [
        { name: "Stable System", chars: stablePart.length, estTokens: est(stablePart.length) },
        { name: "Memory Recall", chars: recallBlock.length, estTokens: est(recallBlock.length) },
        { name: "User Turn", chars: t.msg.length, estTokens: est(t.msg.length) },
      ];
      records.push({
        turn: i + 1,
        label: t.label,
        stablePrefixTokens: est(stablePart.length),
        suffixTokens: est(suffixPart.length),
        sections,
        wireRequestBytes: prep.wire?.requestBytes,
        wirePrefixBytes: prep.wire?.prefixBytes,
        suffixDigestStable: prevSuffixDigest === suffixDigest,
        dropCause: i === 2 && prevSuffixDigest !== suffixDigest ? "tracked-input-change" : undefined,
      });
      prevSuffixDigest = suffixDigest;
    }

    // Boundary behavior: cold→stable identical digest; churn breaks it.
    expect(digests[0]).toBe(digests[1]);
    expect(digests[2]).not.toBe(digests[1]);
    expect((records[1] as { suffixDigestStable: boolean }).suffixDigestStable).toBe(true);
    expect((records[2] as { suffixDigestStable: boolean }).suffixDigestStable).toBe(false);

    mkdirSync(OUT_DIR, { recursive: true });
    const feedPath = path.join(OUT_DIR, "prompt-prefix-feed.jsonl");
    writeFileSync(feedPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const agg = aggregate(records);
    const report = renderReport(agg, { feed: feedPath, date: "2026-10-17" });
    writeFileSync(path.join(OUT_DIR, "prompt-prefix-tax-report.md"), report, "utf8");
    // eslint-disable-next-line no-console
    console.log(report);
    expect(agg.n).toBe(3);
    expect(agg.recallShareMean).toBeGreaterThan(0);
    expect(agg.boundaryBreaks).toBe(1);
  });
});
