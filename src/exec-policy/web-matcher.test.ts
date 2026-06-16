import { describe, expect, it } from "vitest";
import type { ExecPolicy, WebPolicy } from "./types.js";
import { evaluateWebPolicy } from "./web-matcher.js";

function policy(web?: WebPolicy): ExecPolicy {
  return { rules: new Map(), allRules: [], banned: [], isDefault: false, web };
}

describe("evaluateWebPolicy", () => {
  it("allows everything when no web policy is configured", () => {
    expect(evaluateWebPolicy("https://anything.test/x", policy())).toBe("allow");
  });

  it("allows hosts on the allowlist and forbids others", () => {
    const p = policy({ allow: ["docs.openclaw.ai"], deny: [] });
    expect(evaluateWebPolicy("https://docs.openclaw.ai/page", p)).toBe("allow");
    expect(evaluateWebPolicy("https://evil.test/page", p)).toBe("forbidden");
  });

  it("deny wins over allow", () => {
    const p = policy({ allow: ["*"], deny: ["evil.test"] });
    expect(evaluateWebPolicy("https://evil.test/", p)).toBe("forbidden");
    expect(evaluateWebPolicy("https://good.test/", p)).toBe("allow");
  });

  it("matches *.example.com against subdomains and the apex", () => {
    const p = policy({ allow: ["*.github.com"], deny: [] });
    expect(evaluateWebPolicy("https://api.github.com/x", p)).toBe("allow");
    expect(evaluateWebPolicy("https://github.com/x", p)).toBe("allow");
    expect(evaluateWebPolicy("https://notgithub.com/x", p)).toBe("forbidden");
  });

  it("allows non-denied hosts when only a denylist is configured", () => {
    const p = policy({ allow: [], deny: ["tracker.test"] });
    expect(evaluateWebPolicy("https://anything.test/", p)).toBe("allow");
    expect(evaluateWebPolicy("https://tracker.test/", p)).toBe("forbidden");
  });

  it("forbids unparseable URLs when a web policy is configured", () => {
    const p = policy({ allow: ["*"], deny: [] });
    expect(evaluateWebPolicy("not a url", p)).toBe("forbidden");
  });
});
