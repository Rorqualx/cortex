/**
 * Entropy estimator (TTUR) tests — ARCH-3 manifest §1 (2026-08-21) with the
 * 2026-08-17 probe amendments (non-word tokenizer).
 */
import { describe, expect, it } from "vitest";
import { estimateEntropy } from "./entropy-estimator.js";

describe("estimateEntropy", () => {
  it("returns low/1.0 for empty string", () => {
    const result = estimateEntropy("");
    expect(result.bucket).toBe("low");
    expect(result.ttur).toBe(1.0);
    expect(result.totalTokens).toBe(0);
  });

  it("returns low/1.0 for short text (<10 tokens)", () => {
    // 1.2 — preserve-by-default for too-short-to-estimate content
    const result = estimateEntropy("queued queued queued queued");
    expect(result.bucket).toBe("low");
    expect(result.ttur).toBe(1.0);
    expect(result.totalTokens).toBe(4);
    expect(result.uniqueTokens).toBe(1);
  });

  it("classifies repetitive log lines as high (ttur < 0.3)", () => {
    // 1.3 — "INFO Processing request N" ×100 → ttur ≈ 0.26
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(`INFO Processing request ${i}`);
    }
    const result = estimateEntropy(lines.join("\n"));
    expect(result.bucket).toBe("high");
    expect(result.ttur).toBeLessThan(0.3);
  });

  it("classifies diverse prose as low (ttur > 0.6)", () => {
    // 1.4 — varied vocabulary, almost every token a new type
    const prose =
      "The onion knight sails past the blockade carrying smoked fish dried lizards " +
      "and salted pork. Davos Seaworth charts a course through storm waters toward " +
      "Dragonstone castle, where Stannis Baratheon broods over bitter defeats. " +
      "A smuggler turned hand of the king keeps his ledger honest, counting every " +
      "onion, every debt, every promise made across narrow sea voyages.";
    const result = estimateEntropy(prose);
    expect(result.bucket).toBe("low");
    expect(result.ttur).toBeGreaterThan(0.6);
  });

  it("medium band is reachable on naturally mixed content", () => {
    // 1.5 — varied log with prose preamble; no exact-ttur pin, band only
    const lines: string[] = [];
    lines.push(
      "Beginning the archival migration audit we gathered provenance samples epoch clusters and retention grace notes from every consolidation threshold ledger",
    );
    lines.push(
      "Frozen snapshots, survivor protection and cluster density checks were reviewed together before promotion gates opened for the nightly pass",
    );
    lines.push(
      "Across narrow straits the smuggler kept onions dried fish salted pork candles feathers ink and wool beneath deck planks",
    );
    for (let i = 0; i < 14; i++) {
      lines.push(
        `checkpoint ${i} recorded ${i} files during consolidation pass ${i} by worker${i}`,
      );
    }
    const result = estimateEntropy(lines.join("\n"));
    expect(result.bucket).toBe("medium");
    expect(result.ttur).toBeGreaterThan(0.3);
    expect(result.ttur).toBeLessThanOrEqual(0.6);
  });

  it("normalization: 'Run.' and 'run' count as one token type", () => {
    // 1.6 — lowercase + punctuation stripping merge surface forms
    const text = "Run. run RUN. run Run. run run. Run run. run Run. run run. Run.";
    const result = estimateEntropy(text);
    expect(result.uniqueTokens).toBe(1);
    expect(result.totalTokens).toBe(14);
    expect(result.bucket).toBe("high");
  });

  it("AMENDED tokenizer: minified JSON array is NOT low", () => {
    // 1.7 — whitespace tokenizer gave ttur 1.0 (whole payload one token);
    // the non-word tokenizer must classify compact JSON high or medium.
    const items: Array<{ id: number; ok: boolean }> = [];
    for (let i = 0; i < 100; i++) {
      items.push({ id: i, ok: true });
    }
    const result = estimateEntropy(JSON.stringify(items));
    expect(result.bucket).not.toBe("low");
    expect(["high", "medium"]).toContain(result.bucket);
  });

  it("AMENDED tokenizer: snake_case identifiers stay whole", () => {
    // 1.8 — split on /[^a-z0-9_]+/ after lowercase keeps 'src_index' one type.
    // 10 × "src_index" + 20 unique words: kept-whole ⇒ 21 types / 30 tokens;
    // a splitting tokenizer would see 22 types / 40 tokens.
    const tokens: string[] = [];
    for (let i = 0; i < 10; i++) {
      tokens.push("src_index");
    }
    tokens.push(
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
      "india",
      "juliet",
      "kilo",
      "lima",
      "mike",
      "november",
      "oscar",
      "papa",
      "quebec",
      "romeo",
      "sierra",
      "tango",
    );
    const result = estimateEntropy(tokens.join(" "));
    expect(result.uniqueTokens).toBe(21);
    expect(result.totalTokens).toBe(30);
    expect(result.bucket).toBe("low");
  });

  it("base64 blob classifies low (pinned known-edge)", () => {
    // 1.9 — giant alnum runs → few token types → low. DOCUMENTED limitation:
    // opaque blobs read as preserve-worthy; cost is a suboptimal ratio, not loss.
    const blob =
      "qR7jX1zP0aKmVbN3cL5wY8tH2sD4fG6hJ9kL1qW3eR5tY7uI1oP0aS2dF4gH6jK8lZ1xCvB3nM5qW7eR9tY".repeat(
        3,
      );
    const result = estimateEntropy(blob);
    expect(result.bucket).toBe("low");
  });

  it("returns counts: uniqueTokens/totalTokens consistent with ttur", () => {
    // 1.10 — ttur === unique/total to float tolerance (non-degenerate input)
    const lines: string[] = [];
    for (let i = 1; i <= 60; i++) {
      lines.push(`worker ${i} finished shard ${i} of 60`);
    }
    const result = estimateEntropy(lines.join("\n"));
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.ttur).toBeCloseTo(result.uniqueTokens / result.totalTokens, 10);
  });
});
