import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS } from "./legacy-config-migrations.runtime.skills.js";

function migrate(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

const ENABLE_AUTO_HINT =
  "Run `openclaw config set skills.forge.autonomous.mode auto` to let agents save and update skills automatically (every change is announced and undoable).";
const MOVED = "Moved skills.workshop settings → skills.forge.";
const REMOVED_WORKSHOP =
  "Removed retired skills.workshop config (Skill Workshop was replaced by Skill Forge).";

describe("skills.workshop -> skills.forge migration", () => {
  it("carries surviving workshop settings onto skills.forge and repairs retired ones", () => {
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
          autonomous: { mode: "off" },
          approvalPolicy: "pending",
          maxSkillBytes: 12_345,
        },
      },
    });
    expect(result.changes).toEqual([
      MOVED,
      REMOVED_WORKSHOP,
      `Skill Workshop proposals were removed; set skills.forge.autonomous.mode to "off" (was "propose"). ${ENABLE_AUTO_HINT}`,
      "Removed skills.forge.maxPending; Skill Workshop proposals were removed.",
      "Removed retired skills.forge.allowSymlinkTargetWrites; Skill Workshop writes only inside its own directory.",
    ]);
  });

  it("keeps existing forge settings and never overwrites them from workshop", () => {
    const result = migrate({
      skills: {
        forge: { approvalPolicy: "auto", autonomous: { mode: "off" } },
        workshop: { approvalPolicy: "pending", autonomous: { mode: "auto" }, maxSkillBytes: 9000 },
      },
    });

    expect(result.raw).toEqual({
      skills: {
        forge: { approvalPolicy: "auto", autonomous: { mode: "off" }, maxSkillBytes: 9000 },
      },
    });
    expect(result.changes).toEqual([MOVED, REMOVED_WORKSHOP]);
  });

  it.each([
    {
      enabled: true,
      change: `Mapped skills.forge.autonomous.enabled to mode: "off" because Skill Workshop proposals were removed. ${ENABLE_AUTO_HINT}`,
    },
    { enabled: false, change: 'Mapped skills.forge.autonomous.enabled to mode: "off".' },
  ] as const)("maps legacy workshop enabled=$enabled to forge mode off", ({ enabled, change }) => {
    const result = migrate({
      skills: { workshop: { autonomous: { enabled } } },
    });

    expect(result.raw).toEqual({
      skills: { forge: { autonomous: { mode: "off" } } },
    });
    expect(result.changes).toEqual([MOVED, REMOVED_WORKSHOP, change]);
  });

  it("removes an empty retired workshop block without inventing forge settings", () => {
    const result = migrate({ skills: { workshop: {} } });

    expect(result.raw).toEqual({ skills: {} });
    expect(result.changes).toEqual([REMOVED_WORKSHOP]);
  });
});

describe("skills.forge retired-setting migration", () => {
  it("maps the removed propose mode to off and keeps Skill Forge approval policy", () => {
    const result = migrate({
      skills: {
        forge: {
          autonomous: { mode: "propose" },
          approvalPolicy: "pending",
          autoInvoke: false,
          maxPending: 20,
          maxSkillBytes: 8000,
        },
      },
    });

    expect(result.raw).toEqual({
      skills: {
        forge: {
          autonomous: { mode: "off" },
          approvalPolicy: "pending",
          autoInvoke: false,
          maxSkillBytes: 8000,
        },
      },
    });
    expect(result.changes).toEqual([
      `Skill Workshop proposals were removed; set skills.forge.autonomous.mode to "off" (was "propose"). ${ENABLE_AUTO_HINT}`,
      "Removed skills.forge.maxPending; Skill Workshop proposals were removed.",
    ]);
  });

  it("keeps current modes unchanged", () => {
    for (const mode of ["off", "auto"]) {
      const result = migrate({ skills: { forge: { autonomous: { mode } } } });
      expect(result.raw).toEqual({ skills: { forge: { autonomous: { mode } } } });
      expect(result.changes).toEqual([]);
    }
  });

  it("leaves an absent mode absent so the auto default applies", () => {
    const result = migrate({ skills: { forge: { autonomous: {}, approvalPolicy: "auto" } } });

    expect(result.raw).toEqual({ skills: { forge: { autonomous: {}, approvalPolicy: "auto" } } });
    expect(result.changes).toEqual([]);
  });

  it("drops the retired symlink write option", () => {
    const result = migrate({
      skills: {
        forge: {
          allowSymlinkTargetWrites: true,
          autonomous: { mode: "auto" },
        },
      },
    });

    expect(result.raw).toEqual({
      skills: { forge: { autonomous: { mode: "auto" } } },
    });
    expect(result.changes).toEqual([
      "Removed retired skills.forge.allowSymlinkTargetWrites; Skill Workshop writes only inside its own directory.",
    ]);
  });
});
