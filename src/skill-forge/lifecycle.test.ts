import { describe, expect, it } from "vitest";
import {
  SKILL_LIFECYCLE_FIELD,
  extractFrontmatterField,
  isAutoInvocableLifecycle,
  parseSkillLifecycle,
  readSkillLifecycleFromContent,
  stampSkillLifecycleInFrontmatter,
} from "./lifecycle.js";

const BASE = `---\nname: forge-recover-exec-via-read\ndescription: Recover from exec failures\n---\n\nBody prose.\n`;

describe("skill lifecycle helpers", () => {
  it("backfills absent/invalid lifecycle markers to active", () => {
    expect(parseSkillLifecycle(undefined)).toBe("active");
    expect(parseSkillLifecycle("")).toBe("active");
    expect(parseSkillLifecycle("bogus")).toBe("active");
    expect(parseSkillLifecycle("  Trial ")).toBe("trial");
    expect(parseSkillLifecycle("active")).toBe("active");
    expect(parseSkillLifecycle("stable")).toBe("stable");
    expect(parseSkillLifecycle("retired")).toBe("retired");
  });

  it("reads the lifecycle from frontmatter content, defaulting to active", () => {
    expect(readSkillLifecycleFromContent(BASE)).toBe("active");
    expect(readSkillLifecycleFromContent("no frontmatter at all")).toBe("active");
    const stamped = stampSkillLifecycleInFrontmatter(BASE, "trial");
    expect(readSkillLifecycleFromContent(stamped)).toBe("trial");
  });

  it("extracts arbitrary frontmatter fields linearly", () => {
    expect(extractFrontmatterField(BASE, "name")).toBe("forge-recover-exec-via-read");
    expect(extractFrontmatterField(BASE, "missing")).toBeUndefined();
  });

  it("stamps and replaces the lifecycle line idempotently", () => {
    const once = stampSkillLifecycleInFrontmatter(BASE, "trial");
    expect(once).toContain(`${SKILL_LIFECYCLE_FIELD}: trial`);
    const twice = stampSkillLifecycleInFrontmatter(once, "active");
    expect(twice).not.toContain(`${SKILL_LIFECYCLE_FIELD}: trial`);
    expect(twice).toContain(`${SKILL_LIFECYCLE_FIELD}: active`);
    // Round-tripping back to trial keeps exactly one lifecycle line.
    const thrice = stampSkillLifecycleInFrontmatter(twice, "trial");
    expect(thrice.match(new RegExp(SKILL_LIFECYCLE_FIELD, "gu"))?.length).toBe(1);
  });

  it("prepends a frontmatter block when missing", () => {
    const stamped = stampSkillLifecycleInFrontmatter("Just prose.\n", "stable");
    expect(stamped.startsWith("---\n")).toBe(true);
    expect(readSkillLifecycleFromContent(stamped)).toBe("stable");
    expect(stamped.endsWith("Just prose.\n")).toBe(true);
  });

  it("gates auto-invoke to active and stable only", () => {
    expect(isAutoInvocableLifecycle("active")).toBe(true);
    expect(isAutoInvocableLifecycle("stable")).toBe(true);
    expect(isAutoInvocableLifecycle("trial")).toBe(false);
    expect(isAutoInvocableLifecycle("retired")).toBe(false);
  });
});
