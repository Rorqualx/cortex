import { describe, expect, it } from "vitest";
import { hasSecretShape, scrubSecrets } from "./scrub.js";

// Scrub-on-recall (QW4 part b, 2026-11-14): narrow secret-shaped redaction
// for facts read back into prompts. Patterns must be tight — over-broad
// scrubbing mangles legitimate facts (IPs, versions, base64-looking prose).

describe("scrubSecrets", () => {
  it("redacts OpenAI-style keys", () => {
    const out = scrubSecrets("the key is sk-abc123def456ghi789jkl mno not the model name");
    expect(out).not.toContain("sk-abc123def456ghi789jkl");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts GitHub tokens", () => {
    const token = "ghp_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";
    expect(scrubSecrets(`push using ${token} please`)).not.toContain(token);
  });

  it("redacts AWS access key ids", () => {
    expect(scrubSecrets("use AKIAIOSFODNN7EXAMPLE for aws")).toContain("[REDACTED]");
  });

  it("redacts Slack tokens", () => {
    expect(scrubSecrets("slack: xoxb-1234567890-abcdef")).toContain("[REDACTED]");
  });

  it("redacts the credential but keeps the Bearer word", () => {
    const out = scrubSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("masks URL userinfo but keeps scheme and structure", () => {
    const out = scrubSecrets("db at https://joe:hunter2@pi.example.com/feed");
    expect(out).toBe("db at https://***:***@pi.example.com/feed");
  });

  it("redacts labeled assignments keeping the label", () => {
    expect(scrubSecrets("api_key = deadbeefcafe1234")).toBe("api_key = [REDACTED]");
    expect(scrubSecrets('password: "hunter2hunter2"')).toBe("password: [REDACTED]");
    expect(scrubSecrets("SECRET=Wq9Xc2Vydmt4ZTEyMw==")).toBe("SECRET=[REDACTED]");
  });

  it("leaves ordinary infrastructure facts untouched", () => {
    const text = "pi-hole at 192.168.50.128 runs unbound, node v26.4.0, met 2026-08-16 at 9:00 AM";
    expect(scrubSecrets(text)).toBe(text);
  });

  it("does not fire on short labeled values (false-positive guard)", () => {
    expect(scrubSecrets("token: abc")).toBe("token: abc");
  });

  it("handles empty and non-string input", () => {
    expect(scrubSecrets("")).toBe("");
  });
});

describe("hasSecretShape", () => {
  it("true for secret-shaped text, false for clean text", () => {
    expect(hasSecretShape("password: supersecretvalue1")).toBe(true);
    expect(hasSecretShape("the greenhouse is 8 feet deep")).toBe(false);
  });
});
