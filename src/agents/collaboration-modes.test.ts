/**
 * Tests for collaboration mode templates.
 */
import { describe, expect, it } from "vitest";
import {
  collaborationModeToConfigOverrides,
  getAvailableModes,
  getCollaborationModeProfile,
  parseCollaborationMode,
} from "./collaboration-modes.js";

describe("getCollaborationModeProfile", () => {
  it("returns ask profile with execMode=deny", () => {
    const profile = getCollaborationModeProfile("ask");
    expect(profile.execMode).toBe("deny");
    expect(profile.sandboxEnabled).toBe(false);
    expect(profile.deniedTools).toContain("exec");
    expect(profile.label).toBe("Ask");
  });

  it("returns plan profile with execMode=ask", () => {
    const profile = getCollaborationModeProfile("plan");
    expect(profile.execMode).toBe("ask");
    expect(profile.sandboxEnabled).toBe(true);
    expect(profile.behaviorGuidance).toContain("PLAN mode");
  });

  it("returns code profile with execMode=auto", () => {
    const profile = getCollaborationModeProfile("code");
    expect(profile.execMode).toBe("auto");
    expect(profile.sandboxEnabled).toBe(true);
    expect(profile.deniedTools).toEqual([]);
  });

  it("returns full profile with execMode=full", () => {
    const profile = getCollaborationModeProfile("full");
    expect(profile.execMode).toBe("full");
    expect(profile.sandboxEnabled).toBe(false);
    expect(profile.deniedTools).toEqual([]);
  });

  it("returns code profile as fallback for unknown mode", () => {
    // Cast to test fallback behavior
    const profile = getCollaborationModeProfile("unknown" as any);
    expect(profile.execMode).toBe("auto");
  });
});

describe("getAvailableModes", () => {
  it("returns all four modes", () => {
    const modes = getAvailableModes();
    expect(modes).toEqual(["ask", "plan", "code", "full"]);
  });
});

describe("parseCollaborationMode", () => {
  it("parses lowercase input", () => {
    expect(parseCollaborationMode("ask")).toBe("ask");
    expect(parseCollaborationMode("plan")).toBe("plan");
    expect(parseCollaborationMode("code")).toBe("code");
    expect(parseCollaborationMode("full")).toBe("full");
  });

  it("parses mixed-case input", () => {
    expect(parseCollaborationMode("Ask")).toBe("ask");
    expect(parseCollaborationMode("PLAN")).toBe("plan");
    expect(parseCollaborationMode("Code")).toBe("code");
  });

  it("trims whitespace", () => {
    expect(parseCollaborationMode("  ask  ")).toBe("ask");
  });

  it("returns null for unknown input", () => {
    expect(parseCollaborationMode("unknown")).toBeNull();
    expect(parseCollaborationMode("")).toBeNull();
    expect(parseCollaborationMode("askme")).toBeNull();
  });
});

describe("collaborationModeToConfigOverrides", () => {
  it("ask mode produces deny exec and no sandbox", () => {
    const overrides = collaborationModeToConfigOverrides("ask");
    expect((overrides as any).agents.defaults.execMode).toBe("deny");
    expect((overrides as any).agents.defaults.sandbox.mode).toBe("off");
    expect((overrides as any).agents.defaults.tools.deny).toContain("exec");
  });

  it("code mode produces auto exec and sandbox=non-main", () => {
    const overrides = collaborationModeToConfigOverrides("code");
    expect((overrides as any).agents.defaults.execMode).toBe("auto");
    expect((overrides as any).agents.defaults.sandbox.mode).toBe("non-main");
    expect((overrides as any).agents.defaults.tools.deny).toBeUndefined();
  });

  it("full mode produces full exec and sandbox=off", () => {
    const overrides = collaborationModeToConfigOverrides("full");
    expect((overrides as any).agents.defaults.execMode).toBe("full");
    expect((overrides as any).agents.defaults.sandbox.mode).toBe("off");
  });
});
