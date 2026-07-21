import { describe, expect, it } from "vitest";
import { groundAndDedupTypedFacts, groundTypedFact } from "./grounding.js";

describe("groundTypedFact", () => {
  const transcript = "user: my balance is $1,234.56 today\nassistant: noted";

  it("accepts when value appears inside sourceSpan and span appears in transcript", () => {
    expect(
      groundTypedFact({ value: "$1,234.56", sourceSpan: "balance is $1,234.56 today" }, transcript),
    ).toEqual({ ok: true });
  });

  it("rejects when value is empty", () => {
    expect(groundTypedFact({ value: "", sourceSpan: "anything" }, transcript)).toEqual({
      ok: false,
      reason: "value_empty",
    });
  });

  it("rejects when sourceSpan is empty", () => {
    expect(groundTypedFact({ value: "$1,234.56", sourceSpan: "" }, transcript)).toEqual({
      ok: false,
      reason: "span_empty",
    });
  });

  it("rejects when value is not inside the sourceSpan", () => {
    expect(
      groundTypedFact({ value: "$9,999.00", sourceSpan: "balance is $1,234.56 today" }, transcript),
    ).toEqual({ ok: false, reason: "value_not_in_span" });
  });

  it("rejects when sourceSpan does not appear verbatim in the transcript", () => {
    expect(
      groundTypedFact(
        { value: "$1,234.56", sourceSpan: "balance was $1,234.56 yesterday" },
        transcript,
      ),
    ).toEqual({ ok: false, reason: "span_not_in_transcript" });
  });

  it("is case- and whitespace-sensitive (verbatim grounding)", () => {
    expect(
      groundTypedFact({ value: "$1,234.56", sourceSpan: "Balance is $1,234.56 today" }, transcript),
    ).toEqual({ ok: false, reason: "span_not_in_transcript" });
  });
});

describe("groundAndDedupTypedFacts", () => {
  const transcript = "router at 192.168.50.1 and pi-hole at 192.168.50.128";

  it("drops facts that fail grounding and keeps the rest", () => {
    const facts = [
      {
        slot: "infra:router_ip",
        value: "192.168.50.1",
        sourceSpan: "router at 192.168.50.1",
        unit: null,
        confidence: 0.9,
      },
      {
        slot: "infra:pi_hole_ip",
        value: "192.168.50.128",
        sourceSpan: "pi-hole at 192.168.50.128",
        unit: null,
        confidence: 0.9,
      },
      {
        slot: "infra:hallucinated",
        value: "10.0.0.1",
        sourceSpan: "router at 10.0.0.1",
        unit: null,
        confidence: 0.5,
      },
    ];
    const result = groundAndDedupTypedFacts(facts, transcript);
    expect(result.map((f) => f.slot)).toEqual(["infra:router_ip", "infra:pi_hole_ip"]);
  });

  it("keeps the first occurrence per slot (matches dedupWithinChunk semantics)", () => {
    const facts = [
      {
        slot: "infra:router_ip",
        value: "192.168.50.1",
        sourceSpan: "router at 192.168.50.1",
        unit: null,
        confidence: 0.9,
      },
      {
        slot: "infra:router_ip",
        value: "192.168.50.128",
        sourceSpan: "pi-hole at 192.168.50.128",
        unit: null,
        confidence: 0.95,
      },
    ];
    const result = groundAndDedupTypedFacts(facts, transcript);
    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe("192.168.50.1");
  });
});
