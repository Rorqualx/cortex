import { describe, expect, it } from "vitest";
import {
  encodeProjectLabel,
  parseProjectLabel,
  projectIconName,
  projectIdFromName,
} from "./project-label.ts";

describe("project label encode/parse", () => {
  it("round-trips a plain name/icon/dir", () => {
    const label = encodeProjectLabel("OpenClaw", "rocket", "~/code/openclaw");
    expect(parseProjectLabel(label)).toEqual({
      name: "OpenClaw",
      icon: "rocket",
      dir: "~/code/openclaw",
    });
  });

  it("preserves a colon in the project name (regression for label corruption)", () => {
    const label = encodeProjectLabel("Sprint: Q3", "folder", "/tmp/x");
    const parsed = parseProjectLabel(label);
    expect(parsed?.name).toBe("Sprint: Q3");
    expect(parsed?.icon).toBe("folder");
    expect(parsed?.dir).toBe("/tmp/x");
  });

  it("parses a legacy unencoded label without special chars", () => {
    expect(parseProjectLabel("project:Kaizoku:bookmark")).toEqual({
      name: "Kaizoku",
      icon: "bookmark",
      dir: undefined,
    });
  });

  it("returns null for non-project labels", () => {
    expect(parseProjectLabel("priority:high")).toBeNull();
    expect(parseProjectLabel("project:")).toBeNull();
  });
});

describe("projectIconName", () => {
  it("passes through a known icon name", () => {
    expect(projectIconName("rocket")).toBe("rocket");
  });
  it("maps a legacy emoji to an icon name", () => {
    expect(projectIconName("🚀")).toBe("rocket");
    expect(projectIconName("🌱")).toBe("spark");
  });
  it("falls back to folder for unknown values", () => {
    expect(projectIconName("???")).toBe("folder");
  });
});

describe("projectIdFromName", () => {
  it("slugifies a name", () => {
    expect(projectIdFromName("My Project")).toBe("my-project");
  });
});
