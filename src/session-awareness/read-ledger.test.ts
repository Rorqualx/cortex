import { describe, it, expect, afterEach } from "vitest";
import { readLedger } from "./read-ledger.js";
import { runWithSessionContext } from "./session-context.js";

afterEach(() => {
  readLedger.clear();
});

describe("readLedger", () => {
  it("no-ops outside a session context", () => {
    readLedger.recordRead("/tmp/a.txt", { size: 10 });
    expect(readLedger.getRead("/tmp/a.txt")).toBeUndefined();
    expect(readLedger.wasReadFresh("/tmp/a.txt", { size: 10 })).toBe(false);
  });

  it("records and reports a read within a session", () => {
    runWithSessionContext({ sessionKey: "s1" }, () => {
      readLedger.recordRead("/tmp/a.txt", { size: 10, mtimeMs: 100 });
      const record = readLedger.getRead("/tmp/a.txt");
      expect(record?.size).toBe(10);
      expect(record?.mtimeMs).toBe(100);
    });
  });

  it("wasReadFresh requires matching size and mtime", () => {
    runWithSessionContext({ sessionKey: "s1" }, () => {
      readLedger.recordRead("/tmp/a.txt", { size: 10, mtimeMs: 100 });
      expect(readLedger.wasReadFresh("/tmp/a.txt", { size: 10, mtimeMs: 100 })).toBe(true);
      expect(readLedger.wasReadFresh("/tmp/a.txt", { size: 11, mtimeMs: 100 })).toBe(false);
      expect(readLedger.wasReadFresh("/tmp/a.txt", { size: 10, mtimeMs: 200 })).toBe(false);
    });
  });

  it("falls back to size-only when either side lacks mtime", () => {
    runWithSessionContext({ sessionKey: "s1" }, () => {
      readLedger.recordRead("/tmp/a.txt", { size: 10 });
      expect(readLedger.wasReadFresh("/tmp/a.txt", { size: 10, mtimeMs: 999 })).toBe(true);
      expect(readLedger.wasReadFresh("/tmp/a.txt", { size: 12 })).toBe(false);
    });
  });

  it("isolates reads per session and clears on teardown", () => {
    runWithSessionContext({ sessionKey: "s1" }, () => {
      readLedger.recordRead("/tmp/a.txt", { size: 10, mtimeMs: 100 });
    });
    runWithSessionContext({ sessionKey: "s2" }, () => {
      expect(readLedger.getRead("/tmp/a.txt")).toBeUndefined();
    });
    readLedger.clearSession("s1");
    runWithSessionContext({ sessionKey: "s1" }, () => {
      expect(readLedger.getRead("/tmp/a.txt")).toBeUndefined();
    });
  });
});
