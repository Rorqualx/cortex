import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RESEARCH_ALLOWED_TOOLS,
  RESEARCH_DISALLOWED_TOOLS,
  assertTaskCwdAllowed,
  buildClaudeTurnArgs,
} from "./claude-args.js";

describe("buildClaudeTurnArgs", () => {
  it("emits the stream-json print contract", () => {
    const args = buildClaudeTurnArgs({ mode: "research" });
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
  });

  it("omits --resume on the first turn and includes it on resume", () => {
    expect(buildClaudeTurnArgs({ mode: "task" })).not.toContain("--resume");
    const resumed = buildClaudeTurnArgs({ mode: "task", resumeId: "abc-123" });
    expect(resumed).toContain("--resume");
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe("abc-123");
  });

  it("uses acceptEdits for task mode and no tool restrictions", () => {
    const args = buildClaudeTurnArgs({ mode: "task" });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).not.toContain("--disallowedTools");
  });

  it("locks research mode to read-only tools", () => {
    const args = buildClaudeTurnArgs({ mode: "research" });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(RESEARCH_ALLOWED_TOOLS);
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe(RESEARCH_DISALLOWED_TOOLS);
  });
});

describe("assertTaskCwdAllowed", () => {
  const original = process.env.OPENCLAW_STATE_DIR;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = original;
    }
  });

  it("rejects the state dir and its descendants", () => {
    const stateDir = path.join(path.sep, "tmp", "oc-state-test");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    expect(() => assertTaskCwdAllowed(stateDir)).toThrow(/cannot run inside/);
    expect(() => assertTaskCwdAllowed(path.join(stateDir, "agents", "x"))).toThrow(
      /cannot run inside/,
    );
  });

  it("allows an unrelated workspace", () => {
    process.env.OPENCLAW_STATE_DIR = path.join(path.sep, "tmp", "oc-state-test");
    expect(() => assertTaskCwdAllowed(path.join(path.sep, "tmp", "my-repo"))).not.toThrow();
  });
});
