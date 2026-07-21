/**
 * Tests for subagent isolated transcript storage.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateIsolatedTranscriptId,
  resolveIsolatedTranscriptDir,
  resolveIsolatedTranscriptPath,
  writeIsolatedTranscript,
  readIsolatedTranscript,
  cleanupIsolatedTranscripts,
  isolatedTranscriptExists,
  deleteIsolatedTranscript,
  isolatedTranscriptReferenceToken,
  parseIsolatedTranscriptReferenceToken,
} from "./subagent-isolated-transcripts.js";

describe("subagent-isolated-transcripts", () => {
  let testAgentDir: string;
  let testIsolatedId: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    const tmpBase = tmpdir();
    const testId = crypto.randomUUID();
    testAgentDir = path.join(tmpBase, `openclaw-test-${testId}`);
    testIsolatedId = generateIsolatedTranscriptId();

    await fs.mkdir(testAgentDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testAgentDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("generateIsolatedTranscriptId", () => {
    it("should generate a unique UUID", () => {
      const id1 = generateIsolatedTranscriptId();
      const id2 = generateIsolatedTranscriptId();

      expect(id1).toMatch(/^[a-f0-9-]{36}$/);
      expect(id2).toMatch(/^[a-f0-9-]{36}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe("resolveIsolatedTranscriptDir", () => {
    it("should resolve the isolated transcripts subdirectory", () => {
      const result = resolveIsolatedTranscriptDir(testAgentDir);
      const expected = path.join(testAgentDir, "subagent-isolated");

      expect(result).toBe(expected);
    });
  });

  describe("resolveIsolatedTranscriptPath", () => {
    it("should resolve the full path to an isolated transcript file", () => {
      const result = resolveIsolatedTranscriptPath(testAgentDir, testIsolatedId);
      const expected = path.join(testAgentDir, "subagent-isolated", `${testIsolatedId}.jsonl`);

      expect(result).toBe(expected);
    });
  });

  describe("writeIsolatedTranscript", () => {
    it("should write isolated transcript to file", async () => {
      const content = "Test subagent output content";

      const result = await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
        content,
        runId: "test-run-123",
        childSessionKey: "child-session-456",
        tokens: 100,
      });

      expect(result.id).toBe(testIsolatedId);
      expect(result.path).toBe(resolveIsolatedTranscriptPath(testAgentDir, testIsolatedId));

      // Verify file exists
      const exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: testIsolatedId,
      });
      expect(exists).toBe(true);
    });

    it("should create the isolated transcripts directory if it doesn't exist", async () => {
      const newAgentDir = path.join(testAgentDir, "new-agent");

      await writeIsolatedTranscript({
        agentDir: newAgentDir,
        id: testIsolatedId,
        content: "Test content",
      });

      const exists = await isolatedTranscriptExists({
        agentDir: newAgentDir,
        id: testIsolatedId,
      });
      expect(exists).toBe(true);
    });
  });

  describe("readIsolatedTranscript", () => {
    beforeEach(async () => {
      // Write a test transcript
      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
        content: "Test content for reading",
        runId: "test-run-123",
        childSessionKey: "child-session-456",
        tokens: 250,
      });
    });

    it("should read isolated transcript successfully", async () => {
      const result = await readIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe(testIsolatedId);
      expect(result!.content).toBe("Test content for reading");
      expect(result!.tokens).toBe(250);
      expect(result!.createdAt).toBeGreaterThan(0);
      expect(result!.accessedAt).toBeDefined(); // Updated by default on first read
    });

    it("should update accessedAt on first read by default", async () => {
      const result1 = await readIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
      });

      expect(result1!.accessedAt).toBeDefined();

      // Read again - accessedAt should not change
      const result2 = await readIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
      });

      expect(result2!.accessedAt).toBe(result1!.accessedAt);
    });

    it("should not update accessedAt when updateAccessedAt is false", async () => {
      const result = await readIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
        updateAccessedAt: false,
      });

      expect(result!.accessedAt).toBeUndefined();
    });

    it("should return null for non-existent transcript", async () => {
      const result = await readIsolatedTranscript({
        agentDir: testAgentDir,
        id: "non-existent-id",
      });

      expect(result).toBeNull();
    });
  });

  describe("cleanupIsolatedTranscripts", () => {
    it("should delete old unaccessed transcripts", async () => {
      // Create an old transcript (manually set old timestamp)
      const oldId = generateIsolatedTranscriptId();
      const oldPath = resolveIsolatedTranscriptPath(testAgentDir, oldId);

      await fs.mkdir(resolveIsolatedTranscriptDir(testAgentDir), { recursive: true });

      // Write file with old timestamp metadata
      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      await fs.writeFile(
        oldPath,
        JSON.stringify({ meta: { id: oldId, createdAt: oldTimestamp, tokens: 100 } }) +
          "\n" +
          JSON.stringify({ content: "Old content" }) +
          "\n",
        { mode: 0o600 },
      );

      // Create a recent transcript
      const recentId = generateIsolatedTranscriptId();
      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: recentId,
        content: "Recent content",
      });

      // Run cleanup with 7-day TTL
      const result = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 7,
        dryRun: false,
      });

      expect(result.deletedCount).toBe(1);
      expect(result.preservedCount).toBe(1);
      expect(result.deletedPaths).toContain(oldPath);

      // Verify old transcript was deleted
      const oldExists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: oldId,
      });
      expect(oldExists).toBe(false);

      // Verify recent transcript was preserved
      const recentExists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: recentId,
      });
      expect(recentExists).toBe(true);
    });

    it("should preserve accessed transcripts regardless of age", async () => {
      // Create an old accessed transcript
      const accessedId = generateIsolatedTranscriptId();
      const accessedPath = resolveIsolatedTranscriptPath(testAgentDir, accessedId);

      await fs.mkdir(resolveIsolatedTranscriptDir(testAgentDir), { recursive: true });

      const oldTimestamp = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
      const accessedTimestamp = Date.now() - 5 * 24 * 60 * 60 * 1000; // Accessed 5 days ago

      await fs.writeFile(
        accessedPath,
        JSON.stringify({
          meta: {
            id: accessedId,
            createdAt: oldTimestamp,
            accessedAt: accessedTimestamp,
            tokens: 100,
          },
        }) +
          "\n" +
          JSON.stringify({ content: "Accessed content" }) +
          "\n",
        { mode: 0o600 },
      );

      // Run cleanup
      const result = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 7,
        dryRun: false,
      });

      expect(result.deletedCount).toBe(0);
      expect(result.preservedCount).toBe(1);

      // Verify accessed transcript was preserved
      const exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: accessedId,
      });
      expect(exists).toBe(true);
    });

    it("should support dry-run mode", async () => {
      // Create an old transcript
      const oldId = generateIsolatedTranscriptId();
      const oldPath = resolveIsolatedTranscriptPath(testAgentDir, oldId);

      await fs.mkdir(resolveIsolatedTranscriptDir(testAgentDir), { recursive: true });

      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
      await fs.writeFile(
        oldPath,
        JSON.stringify({ meta: { id: oldId, createdAt: oldTimestamp, tokens: 100 } }) +
          "\n" +
          JSON.stringify({ content: "Old content" }) +
          "\n",
        { mode: 0o600 },
      );

      // Run cleanup in dry-run mode
      const result = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 7,
        dryRun: true,
      });

      expect(result.deletedCount).toBe(1);
      expect(result.deletedPaths).toContain(oldPath);

      // Verify file still exists (dry-run)
      const exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: oldId,
      });
      expect(exists).toBe(true);
    });

    it("should filter by runId when specified", async () => {
      // Create two transcripts with different runIds
      const id1 = generateIsolatedTranscriptId();
      const id2 = generateIsolatedTranscriptId();

      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: id1,
        content: "Content 1",
        runId: "run-1",
      });

      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: id2,
        content: "Content 2",
        runId: "run-2",
      });

      // Age the files so they're considered "old" for cleanup
      const path1 = resolveIsolatedTranscriptPath(testAgentDir, id1);
      const path2 = resolveIsolatedTranscriptPath(testAgentDir, id2);
      const oldTimestamp = Date.now() - 1000; // 1 second ago (enough for ttlDays: 0)

      for (const filePath of [path1, path2]) {
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim() !== "");
        const metaRaw = lines[0];
        if (!metaRaw) throw new Error("expected transcript meta line");
        const metaLine = JSON.parse(metaRaw);
        metaLine.meta.createdAt = oldTimestamp;

        const agedContent = JSON.stringify({ meta: metaLine.meta }) + "\n" + lines[1] + "\n";
        await fs.writeFile(filePath, agedContent, { mode: 0o600 });
      }

      // Cleanup only run-1
      const result = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 0, // Delete immediately
        dryRun: false,
        runId: "run-1",
      });

      expect(result.deletedCount).toBe(1);
      expect(result.preservedCount).toBe(1);

      // Verify run-2 transcript still exists
      const exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: id2,
      });
      expect(exists).toBe(true);
    });
  });

  describe("isolatedTranscriptExists", () => {
    it("should return true for existing transcript", async () => {
      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
        content: "Test content",
      });

      const exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: testIsolatedId,
      });

      expect(exists).toBe(true);
    });

    it("should return false for non-existent transcript", async () => {
      const exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: "non-existent",
      });

      expect(exists).toBe(false);
    });
  });

  describe("deleteIsolatedTranscript", () => {
    it("should delete the transcript file", async () => {
      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
        content: "Test content",
      });

      // Verify it exists
      let exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: testIsolatedId,
      });
      expect(exists).toBe(true);

      // Delete it
      await deleteIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
      });

      // Verify it's gone
      exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: testIsolatedId,
      });
      expect(exists).toBe(false);
    });
  });

  describe("isolatedTranscriptReferenceToken", () => {
    it("should generate correct reference token format", () => {
      const token = isolatedTranscriptReferenceToken(testIsolatedId);

      expect(token).toBe(`[isolated:${testIsolatedId}]`);
    });
  });

  describe("parseIsolatedTranscriptReferenceToken", () => {
    it("should parse valid reference token", () => {
      const token = `[isolated:${testIsolatedId}]`;
      const parsed = parseIsolatedTranscriptReferenceToken(token);

      expect(parsed).toBe(testIsolatedId);
    });

    it("should return null for invalid token format", () => {
      const invalidTokens = [
        "not-a-token",
        "[isolated:]",
        "[isolated:invalid-uuid]",
        "[ISOLATED:some-id]",
        "[isolated:some-id]extra",
      ];

      for (const token of invalidTokens) {
        const parsed = parseIsolatedTranscriptReferenceToken(token);
        expect(parsed).toBeNull();
      }
    });
  });

  describe("integration: write and read lifecycle", () => {
    it("should complete full write-read-cleanup lifecycle", async () => {
      // Write
      const content = "Full lifecycle test content";
      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
        content,
        runId: "lifecycle-run-123",
        childSessionKey: "lifecycle-child-456",
        tokens: 500,
      });

      // Read
      const read = await readIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
      });

      expect(read).not.toBeNull();
      expect(read!.content).toBe(content);
      expect(read!.tokens).toBe(500);
      expect(read!.accessedAt).toBeDefined(); // Should be updated on read

      // Verify reference token generation
      const token = isolatedTranscriptReferenceToken(testIsolatedId);
      expect(token).toMatch(/^\[isolated:[a-f0-9-]+\]$/);

      // Verify token parsing
      const parsed = parseIsolatedTranscriptReferenceToken(token);
      expect(parsed).toBe(testIsolatedId);

      // Cleanup should preserve accessed transcript
      const cleanupResult = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 0,
        dryRun: false,
      });

      expect(cleanupResult.preservedCount).toBe(1);
      expect(cleanupResult.deletedCount).toBe(0);

      // Explicit delete
      await deleteIsolatedTranscript({
        agentDir: testAgentDir,
        id: testIsolatedId,
      });

      const exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: testIsolatedId,
      });
      expect(exists).toBe(false);
    });
  });
});
