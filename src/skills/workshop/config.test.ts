import { describe, expect, it } from "vitest";
import { resolveSkillWorkshopConfig } from "./config.js";

describe("resolveSkillWorkshopConfig", () => {
  it("defaults autonomous learning to auto with channel notices off", () => {
    expect(resolveSkillWorkshopConfig().autonomous).toEqual({
      mode: "auto",
      channelNotices: false,
    });
  });

  it.each([false, true])("reads channel notices %s", (channelNotices) => {
    expect(
      resolveSkillWorkshopConfig({ skills: { forge: { autonomous: { channelNotices } } } })
        .autonomous.channelNotices,
    ).toBe(channelNotices);
  });

  it.each(["off", "auto"] as const)("reads autonomous mode %s from skills.forge", (mode) => {
    expect(
      resolveSkillWorkshopConfig({ skills: { forge: { autonomous: { mode } } } }).autonomous.mode,
    ).toBe(mode);
  });

  it("reads maxSkillBytes from skills.forge and ignores SkillForge-only settings", () => {
    const resolved = resolveSkillWorkshopConfig({
      skills: {
        forge: {
          autonomous: { mode: "off" },
          approvalPolicy: "pending",
          autoInvoke: false,
          maxSkillBytes: 12_345,
        },
      },
    });
    expect(resolved).toEqual({
      autonomous: { mode: "off" },
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
