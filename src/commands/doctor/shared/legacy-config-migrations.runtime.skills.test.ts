import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS } from "./legacy-config-migrations.runtime.skills.js";

function migrate(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

describe("skills.workshop -> skills.forge migration", () => {
  it("carries every retired workshop setting onto skills.forge and drops workshop", () => {
    const result = migrate({
      skills: {
        workshop: {
          autonomous: { mode: "propose" },
          approvalPolicy: "pending",
          allowSymlinkTargetWrites: true,
          maxPending: 7,
          maxSkillBytes: 12_345,
        },
      },
    });

    expect(result.raw).toEqual({
      skills: {
        forge: {
          autonomous: { mode: "propose" },
          approvalPolicy: "pending",
          allowSymlinkTargetWrites: true,
          maxPending: 7,
          maxSkillBytes: 12_345,
        },
      },
    });
    expect(result.changes).toEqual([
      "Moved skills.workshop settings → skills.forge.",
      "Removed retired skills.workshop config (Skill Workshop was replaced by Skill Forge).",
    ]);
  });

  it("keeps existing forge settings and never overwrites them from workshop", () => {
    const result = migrate({
      skills: {
        forge: { approvalPolicy: "auto", autonomous: { mode: "off" } },
        workshop: { approvalPolicy: "pending", autonomous: { mode: "propose" }, maxPending: 9 },
      },
    });

    expect(result.raw).toEqual({
      skills: {
        forge: { approvalPolicy: "auto", autonomous: { mode: "off" }, maxPending: 9 },
      },
    });
    expect(result.changes).toEqual([
      "Moved skills.workshop settings → skills.forge.",
      "Removed retired skills.workshop config (Skill Workshop was replaced by Skill Forge).",
    ]);
  });

  it("removes an empty retired workshop block without inventing forge settings", () => {
    const result = migrate({ skills: { workshop: {} } });

    expect(result.raw).toEqual({ skills: {} });
    expect(result.changes).toEqual([
      "Removed retired skills.workshop config (Skill Workshop was replaced by Skill Forge).",
    ]);
  });

  it("leaves config without a workshop block untouched", () => {
    const result = migrate({ skills: { forge: { approvalPolicy: "auto" } } });

    expect(result.raw).toEqual({ skills: { forge: { approvalPolicy: "auto" } } });
    expect(result.changes).toEqual([]);
  });
});
