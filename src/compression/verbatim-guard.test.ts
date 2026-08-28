import { describe, expect, it } from "vitest";
import { applyVerbatimGuard, extractVerbatimSpans } from "./verbatim-guard.js";

// F3 extractive-span guard (2026-08-28): unique verbatim-critical spans must
// survive tool-output compression; duplicated (bulk) spans may legitimately
// be dropped. Patterns are linear-time — these tests pin the shapes.

describe("extractVerbatimSpans", () => {
  it("collects unique paths, hex constants, and config keys", () => {
    const spans = extractVerbatimSpans(
      "edited /etc/unbound/unbound.conf then ioctl 0x40046d2b with frame_rate=60",
    );
    expect(spans).toContain("/etc/unbound/unbound.conf");
    expect(spans).toContain("0x40046d2b");
    expect(spans).toContain("frame_rate=60");
  });

  it("drops bulk-duplicated spans", () => {
    const spans = extractVerbatimSpans("/var/log/app.log line1 /var/log/app.log line2");
    expect(spans).not.toContain("/var/log/app.log");
  });

  it("returns empty for plain prose", () => {
    expect(extractVerbatimSpans("the build finished successfully today")).toEqual([]);
  });
});

describe("applyVerbatimGuard", () => {
  it("re-attaches dropped unique spans as a tail line", () => {
    const before = "configured /etc/unbound/unbound.conf with max_ttl=86400 and ioctl 0x40046d2b";
    const after = "configured resolver settings with TTL and ioctl constant";
    const guarded = applyVerbatimGuard(before, after);
    expect(guarded).not.toBe(after);
    expect(guarded).toContain("[verbatim]");
    expect(guarded).toContain("/etc/unbound/unbound.conf");
    expect(guarded).toContain("max_ttl=86400");
    expect(guarded).toContain("0x40046d2b");
  });

  it("is a no-op when everything survived", () => {
    const before = "set ioctl 0x40046d2b on /dev/video0";
    const after = "set ioctl 0x40046d2b on /dev/video0 (done)";
    expect(applyVerbatimGuard(before, after)).toBe(after);
  });

  it("is a no-op when the source has no verbatim spans", () => {
    expect(applyVerbatimGuard("plain output only", "plain output")).toBe("plain output");
  });

  it("caps the tail length", () => {
    const paths = Array.from(
      { length: 30 },
      (_, i) => `/opt/svc${i}/very/deeply/nested/path/segment${i}/file${i}.conf`,
    ).join(" ");
    const guarded = applyVerbatimGuard(paths, "all settings applied", { maxSpans: 5 });
    const tail = guarded.slice(guarded.indexOf("[verbatim]"));
    expect(tail.length).toBeLessThan(400);
  });
});
