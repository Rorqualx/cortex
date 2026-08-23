import { describe, expect, it } from "vitest";
import { resolveSkillWorkshopConfig } from "./config.js";

describe("resolveSkillWorkshopConfig", () => {
  it("defaults autonomous learning to auto", () => {
    expect(resolveSkillWorkshopConfig().autonomous.mode).toBe("auto");
  });

  it.each(["off", "propose", "auto"] as const)(
    "reads autonomous mode %s from skills.forge",
    (mode) => {
      expect(
        resolveSkillWorkshopConfig({ skills: { forge: { autonomous: { mode } } } }).autonomous.mode,
      ).toBe(mode);
    },
  );

  it("reads every forge setting from skills.forge", () => {
    const resolved = resolveSkillWorkshopConfig({
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
    expect(resolved).toEqual({
      autonomous: { mode: "propose" },
      approvalPolicy: "pending",
      allowSymlinkTargetWrites: true,
      maxPending: 7,
      maxSkillBytes: 12_345,
    });
  });

  it("ignores the retired skills.workshop key at runtime", () => {
    // The reader must not fall back to the retired path; retired config is repaired
    // to skills.forge by the doctor migration, and strict validation rejects skills.workshop.
    expect(
      resolveSkillWorkshopConfig({
        skills: { workshop: { autonomous: { mode: "off" } } },
      } as never).autonomous.mode,
    ).toBe("auto");
  });
});
