import { describe, expect, it } from "vitest";
import {
  generateActScenario,
  scoreActResponse,
  scoreActBatch,
  type ActScenario,
} from "./act-scenario.js";

describe("generateActScenario", () => {
  it("generates a language scenario for language slots", () => {
    const scenario = generateActScenario({
      id: "fact-1",
      slot: "favorite_language",
      value: "Rust",
    });
    expect(scenario.factId).toBe("fact-1");
    expect(scenario.expectedValue).toBe("Rust");
    expect(scenario.prompt).toContain("language");
    expect(scenario.applicationKeywords).toContain("rust");
    expect(scenario.prompt.length).toBeGreaterThan(20);
  });

  it("generates a timezone scenario for tz slots", () => {
    const scenario = generateActScenario({
      id: "fact-2",
      slot: "timezone",
      value: "America/Denver",
    });
    expect(scenario.applicationKeywords).toContain("america/denver");
    expect(scenario.prompt).toContain("meeting");
  });

  it("generates a preference scenario for preference slots", () => {
    const scenario = generateActScenario({
      id: "fact-3",
      slot: "preference",
      value: "dark mode",
    });
    expect(scenario.applicationKeywords).toContain("dark mode");
  });

  it("falls back to default for unknown slot patterns", () => {
    const scenario = generateActScenario({
      id: "fact-4",
      slot: "pi_hole:ip",
      value: "192.168.50.128",
    });
    expect(scenario.prompt).toContain("pi hole ip");
    expect(scenario.applicationKeywords).toContain("192.168.50.128");
  });

  it("always provides prompt, keywords, and description", () => {
    const scenarios = [
      generateActScenario({ id: "1", slot: "language", value: "Rust" }),
      generateActScenario({ id: "2", slot: "name", value: "Joe" }),
      generateActScenario({ id: "3", slot: "allergy", value: "peanuts" }),
      generateActScenario({ id: "4", slot: "unknown_slot", value: "unknown" }),
    ];
    for (const s of scenarios) {
      expect(s.prompt.length).toBeGreaterThan(0);
      expect(s.applicationKeywords.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});

describe("scoreActResponse", () => {
  const scenario: ActScenario = {
    factId: "f1",
    slot: "favorite_language",
    expectedValue: "Rust",
    prompt: "What language should I use?",
    applicationKeywords: ["rust"],
    antiKeywords: ["python", "javascript"],
    description: "Language preference test",
  };

  it("scores a response that applies the preference", () => {
    const score = scoreActResponse(
      "I'd recommend using Rust for this. Here's the code: ...",
      scenario,
    );
    expect(score.applied).toBe(true);
    expect(score.confidence).toBeGreaterThan(0);
    expect(score.matchedKeywords).toContain("rust");
  });

  it("scores a response that does NOT apply the preference", () => {
    const score = scoreActResponse("I'd recommend using Python for this task.", scenario);
    expect(score.applied).toBe(false);
    expect(score.matchedKeywords).toHaveLength(0);
  });

  it("detects anti-keywords as negative evidence", () => {
    const score = scoreActResponse(
      "While Rust is an option, I'd go with Python for simplicity.",
      scenario,
    );
    // Has positive (rust) AND negative (python) signals
    expect(score.matchedKeywords).toContain("rust");
    expect(score.matchedAntiKeywords).toContain("python");
    expect(score.confidence).toBeGreaterThanOrEqual(0);
  });

  it("handles case-insensitive matching", () => {
    const score = scoreActResponse("Definitely RUST for this project.", scenario);
    expect(score.applied).toBe(true);
    expect(score.matchedKeywords).toContain("rust");
  });

  it("returns confidence=0 when no keywords match", () => {
    const score = scoreActResponse("I suggest using Go for this project.", scenario);
    expect(score.applied).toBe(false);
    expect(score.confidence).toBe(0);
    expect(score.reason).toContain("No application");
  });
});

describe("scoreActBatch", () => {
  it("computes aggregate act utilization rate", () => {
    const scenario1: ActScenario = {
      factId: "f1",
      slot: "lang",
      expectedValue: "Rust",
      prompt: "?",
      applicationKeywords: ["rust"],
      antiKeywords: [],
      description: "test",
    };
    const scenario2: ActScenario = {
      factId: "f2",
      slot: "lang",
      expectedValue: "Go",
      prompt: "?",
      applicationKeywords: ["go"],
      antiKeywords: [],
      description: "test",
    };

    const results = scoreActBatch([
      { scenario: scenario1, response: "Use Rust for this." },
      { scenario: scenario2, response: "I'd pick something else." },
    ]);

    expect(results.actUtilizationRate).toBe(0.5);
    expect(results.avgConfidence).toBeGreaterThan(0);
    expect(results.perScenario).toHaveLength(2);
  });

  it("handles empty batch", () => {
    const results = scoreActBatch([]);
    expect(results.actUtilizationRate).toBe(0);
    expect(results.avgConfidence).toBe(0);
    expect(results.perScenario).toHaveLength(0);
  });

  it("computes 100% utilization when all apply", () => {
    const scenario: ActScenario = {
      factId: "f1",
      slot: "name",
      expectedValue: "Joe",
      prompt: "?",
      applicationKeywords: ["joe"],
      antiKeywords: [],
      description: "test",
    };
    const results = scoreActBatch([
      { scenario, response: "Hi Joe!" },
      { scenario, response: "Hey joe, welcome" },
    ]);
    expect(results.actUtilizationRate).toBe(1);
  });
});
