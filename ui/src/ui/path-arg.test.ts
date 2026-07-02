import { describe, expect, it } from "vitest";
import { resolveAgentArgPath } from "./path-arg.ts";

describe("resolveAgentArgPath", () => {
  const root = "/ws";

  it("joins a relative arg onto the workspace root", () => {
    expect(resolveAgentArgPath("src/foo.ts", root)).toBe("/ws/src/foo.ts");
    expect(resolveAgentArgPath("foo.ts", root)).toBe("/ws/foo.ts");
  });

  it("normalizes an absolute arg (matching the server's path.resolve)", () => {
    expect(resolveAgentArgPath("/abs/foo.ts", root)).toBe("/abs/foo.ts");
    expect(resolveAgentArgPath("/ws//src/foo.ts", root)).toBe("/ws/src/foo.ts");
    expect(resolveAgentArgPath("/ws/x/../foo.ts", root)).toBe("/ws/foo.ts");
    expect(resolveAgentArgPath("/ws/./foo.ts", root)).toBe("/ws/foo.ts");
  });

  it("decodes file:// URLs to their filesystem path", () => {
    expect(resolveAgentArgPath("file:///abs/foo.ts", root)).toBe("/abs/foo.ts");
    expect(resolveAgentArgPath("file:///ws/a%20b.ts", root)).toBe("/ws/a b.ts");
  });

  it("returns null for ~ paths the browser cannot expand", () => {
    // No home dir client-side → callers fall back to a basename match instead
    // of comparing a non-comparable string.
    expect(resolveAgentArgPath("~/foo.ts", root)).toBeNull();
    expect(resolveAgentArgPath("~", root)).toBeNull();
  });

  it("collapses . and .. segments", () => {
    expect(resolveAgentArgPath("./src/foo.ts", root)).toBe("/ws/src/foo.ts");
    expect(resolveAgentArgPath("src/../lib/foo.ts", root)).toBe("/ws/lib/foo.ts");
    expect(resolveAgentArgPath("a/b/../../c.ts", root)).toBe("/ws/c.ts");
  });

  it("normalizes a trailing slash on the workspace root", () => {
    expect(resolveAgentArgPath("foo.ts", "/ws/")).toBe("/ws/foo.ts");
  });

  it("returns null when a relative arg has no root to resolve against", () => {
    expect(resolveAgentArgPath("src/foo.ts", undefined)).toBeNull();
    expect(resolveAgentArgPath("", root)).toBeNull();
  });
});
