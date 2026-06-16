import { afterEach, describe, expect, it } from "vitest";
import {
  clearDynamicSecrets,
  redactSensitiveText,
  registerDynamicSecret,
  scrubDynamicSecrets,
} from "./redact.js";

describe("dynamic secret redaction", () => {
  afterEach(() => {
    clearDynamicSecrets();
  });

  it("scrubs a registered value from arbitrary text", () => {
    registerDynamicSecret("sk_live_abcdef123456");
    expect(scrubDynamicSecrets("token is sk_live_abcdef123456 here")).toBe(
      "token is [redacted secret] here",
    );
  });

  it("ignores values shorter than the minimum length", () => {
    registerDynamicSecret("abc");
    expect(scrubDynamicSecrets("abc def")).toBe("abc def");
  });

  it("scrubs registered secrets even when pattern redaction would pass text through", () => {
    registerDynamicSecret("plainvalue-no-pattern-match-987654");
    // This text matches no built-in secret pattern, so only the dynamic registry
    // can catch it — proving the unconditional scrub path.
    const out = redactSensitiveText("here: plainvalue-no-pattern-match-987654", { mode: "off" });
    expect(out).not.toContain("plainvalue-no-pattern-match-987654");
    expect(out).toContain("[redacted secret]");
  });

  it("clears registered secrets on reset", () => {
    registerDynamicSecret("temporary-secret-value-123");
    clearDynamicSecrets();
    expect(scrubDynamicSecrets("temporary-secret-value-123")).toBe("temporary-secret-value-123");
  });
});
