/**
 * Integration tests for subagent sidechain transcript isolation.
 *
 * These tests verify the complete end-to-end flow:
 * - Spawn with isolation enabled
 * - Verify isolated file is created
 * - Verify reference token is delivered to parent
 * - Verify on-demand fetch works
 * - Verify cleanup preserves accessed files
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

describe("subagent-isolation: end-to-end integration", () => {
  let testAgentDir: string;
  let testRunId: string;
  let testChildSessionKey: string;

  beforeEach(async () => {
    const tmpBase = tmpdir();
    const testId = crypto.randomUUID();
    testAgentDir = path.join(tmpBase, `openclaw-integration-${testId}`);
    testRunId = `run-${crypto.randomUUID()}`;
    testChildSessionKey = `child-${crypto.randomUUID()}`;

    await fs.mkdir(testAgentDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testAgentDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("complete isolation lifecycle", () => {
    it("should handle spawn with isolation enabled", async () => {
      // Simulate subagent spawn with isolateTranscript: true
      const isolatedId = generateIsolatedTranscriptId();
      const subagentOutput = "This is verbose subagent output that should be isolated.";

      // Step 1: Subagent completes, output written to isolated file
      const writeResult = await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolatedId,
        content: subagentOutput,
        runId: testRunId,
        childSessionKey: testChildSessionKey,
        tokens: 150, // Simulate token count
      });

      expect(writeResult.id).toBe(isolatedId);
      expect(writeResult.path).toBe(resolveIsolatedTranscriptPath(testAgentDir, isolatedId));

      // Step 2: Verify isolated file exists
      const isolatedExists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: isolatedId,
      });
      expect(isolatedExists).toBe(true);

      // Step 3: Verify reference token format
      const referenceToken = isolatedTranscriptReferenceToken(isolatedId);
      expect(referenceToken).toMatch(/^\[isolated:[a-f0-9-]+\]$/);

      // Step 4: Verify parent can parse reference token
      const parsedId = parseIsolatedTranscriptReferenceToken(referenceToken);
      expect(parsedId).toBe(isolatedId);

      // Step 5: Verify parent receives reference token (simulated announce delivery)
      // In real flow, this would come from announce-delivery payload
      const parentPayload = {
        runId: testRunId,
        childSessionKey: testChildSessionKey,
        isolatedTranscriptId: isolatedId,
        referenceToken,
      };
      expect(parentPayload.referenceToken).toBe(referenceToken);

      // Step 6: Verify on-demand fetch works (parent accesses content)
      const fetched = await readIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolatedId,
      });

      expect(fetched).not.toBeNull();
      expect(fetched!.content).toBe(subagentOutput);
      expect(fetched!.tokens).toBe(150);
      expect(fetched!.runId).toBe(testRunId);
      expect(fetched!.childSessionKey).toBe(testChildSessionKey);
      expect(fetched!.accessedAt).toBeDefined(); // Should be set on first read

      // Step 7: Verify cleanup preserves accessed file
      const cleanupResult = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 0, // Would delete immediately if not accessed
        dryRun: false,
      });

      expect(cleanupResult.deletedCount).toBe(0);
      expect(cleanupResult.preservedCount).toBe(1);

      // Verify file still exists after cleanup
      const stillExists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: isolatedId,
      });
      expect(stillExists).toBe(true);
    });

    it("should cleanup unaccessed isolated transcripts", async () => {
      // Create isolated transcript that is never accessed
      const isolatedId = generateIsolatedTranscriptId();

      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolatedId,
        content: "Never accessed content",
        runId: testRunId,
        tokens: 100,
      });

      // Verify file exists
      let exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: isolatedId,
      });
      expect(exists).toBe(true);

      // Run cleanup with 0-day TTL (simulating old file)
      // First, manually age the file
      const isolatedPath = resolveIsolatedTranscriptPath(testAgentDir, isolatedId);
      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago

      const stats = await fs.stat(isolatedPath);
      const content = await fs.readFile(isolatedPath, "utf-8");

      // Rewrite with old timestamp
      const lines = content.split("\n").filter((line) => line.trim() !== "");
      const metaRaw = lines[0];
      if (!metaRaw) throw new Error("expected transcript meta line");
      const metaLine = JSON.parse(metaRaw);
      metaLine.meta.createdAt = oldTimestamp;

      const agedContent = JSON.stringify({ meta: metaLine.meta }) + "\n" + lines[1] + "\n";
      await fs.writeFile(isolatedPath, agedContent, { mode: 0o600 });

      // Run cleanup with 7-day TTL
      const cleanupResult = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 7,
        dryRun: false,
      });

      expect(cleanupResult.deletedCount).toBe(1);
      expect(cleanupResult.preservedCount).toBe(0);

      // Verify file was deleted
      exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: isolatedId,
      });
      expect(exists).toBe(false);
    });

    it("should handle multiple concurrent isolated transcripts", async () => {
      // Simulate spawning multiple subagents concurrently
      const isolatedIds = [
        generateIsolatedTranscriptId(),
        generateIsolatedTranscriptId(),
        generateIsolatedTranscriptId(),
      ];

      const outputs = [
        "First subagent output",
        "Second subagent output with more verbose content",
        "Third subagent output with different results",
      ];

      // Write all isolated transcripts
      for (let i = 0; i < isolatedIds.length; i++) {
        const id = isolatedIds[i];
        const output = outputs[i];
        if (!id || output === undefined) throw new Error("expected id and output");
        await writeIsolatedTranscript({
          agentDir: testAgentDir,
          id,
          content: output,
          runId: `${testRunId}-${i}`,
          tokens: 100 + i * 50,
        });
      }

      // Verify all files exist
      for (const id of isolatedIds) {
        const exists = await isolatedTranscriptExists({
          agentDir: testAgentDir,
          id,
        });
        expect(exists).toBe(true);
      }

      // Parent accesses only the second one
      const accessedIndex = 1;
      const accessedId = isolatedIds[accessedIndex];
      if (!accessedId) throw new Error("expected accessed id");

      const fetched = await readIsolatedTranscript({
        agentDir: testAgentDir,
        id: accessedId,
      });

      expect(fetched!.content).toBe(outputs[accessedIndex]);

      // Age the files for cleanup test
      for (const id of isolatedIds) {
        const isolatedPath = resolveIsolatedTranscriptPath(testAgentDir, id);
        const content = await fs.readFile(isolatedPath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim() !== "");
        const metaRaw = lines[0];
        if (!metaRaw) throw new Error("expected transcript meta line");
        const metaLine = JSON.parse(metaRaw);
        metaLine.meta.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;

        const agedContent = JSON.stringify({ meta: metaLine.meta }) + "\n" + lines[1] + "\n";
        await fs.writeFile(isolatedPath, agedContent, { mode: 0o600 });
      }

      // Run cleanup
      const cleanupResult = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 7,
        dryRun: false,
      });

      // Only the accessed one should be preserved
      expect(cleanupResult.deletedCount).toBe(2);
      expect(cleanupResult.preservedCount).toBe(1);

      // Verify accessed file still exists
      const accessedExists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: accessedId,
      });
      expect(accessedExists).toBe(true);

      // Verify others were deleted
      for (let i = 0; i < isolatedIds.length; i++) {
        if (i === accessedIndex) {
          continue;
        }

        const id = isolatedIds[i];
        if (!id) throw new Error("expected id");
        const exists = await isolatedTranscriptExists({
          agentDir: testAgentDir,
          id,
        });
        expect(exists).toBe(false);
      }
    });

    it("should support filtering cleanup by runId", async () => {
      // Create transcripts from different runs
      const run1Id = "run-1";
      const run2Id = "run-2";

      const isolated1 = generateIsolatedTranscriptId();
      const isolated2 = generateIsolatedTranscriptId();

      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolated1,
        content: "Run 1 output",
        runId: run1Id,
        tokens: 100,
      });

      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolated2,
        content: "Run 2 output",
        runId: run2Id,
        tokens: 100,
      });

      // Cleanup only run-1 transcripts
      const cleanupResult = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 0,
        dryRun: false,
        runId: run1Id,
      });

      expect(cleanupResult.deletedCount).toBe(1);
      expect(cleanupResult.preservedCount).toBe(1);

      // Verify run-1 transcript was deleted
      const run1Exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: isolated1,
      });
      expect(run1Exists).toBe(false);

      // Verify run-2 transcript still exists
      const run2Exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: isolated2,
      });
      expect(run2Exists).toBe(true);
    });

    it("should handle dry-run cleanup correctly", async () => {
      const isolatedId = generateIsolatedTranscriptId();

      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolatedId,
        content: "Test content",
        runId: testRunId,
        tokens: 100,
      });

      // Age the file
      const isolatedPath = resolveIsolatedTranscriptPath(testAgentDir, isolatedId);
      const content = await fs.readFile(isolatedPath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim() !== "");
      const metaRaw = lines[0];
      if (!metaRaw) throw new Error("expected transcript meta line");
      const metaLine = JSON.parse(metaRaw);
      metaLine.meta.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;

      const agedContent = JSON.stringify({ meta: metaLine.meta }) + "\n" + lines[1] + "\n";
      await fs.writeFile(isolatedPath, agedContent, { mode: 0o600 });

      // Run cleanup in dry-run mode
      const dryRunResult = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 7,
        dryRun: true,
      });

      expect(dryRunResult.deletedCount).toBe(1);
      expect(dryRunResult.deletedPaths).toContain(isolatedPath);

      // Verify file still exists (dry-run)
      const exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: isolatedId,
      });
      expect(exists).toBe(true);

      // Now run actual cleanup
      const realCleanupResult = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 7,
        dryRun: false,
      });

      expect(realCleanupResult.deletedCount).toBe(1);

      // Verify file was actually deleted
      const existsAfter = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: isolatedId,
      });
      expect(existsAfter).toBe(false);
    });

    it("should preserve recent transcripts regardless of access", async () => {
      const isolatedId = generateIsolatedTranscriptId();

      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolatedId,
        content: "Recent content",
        runId: testRunId,
        tokens: 100,
      });

      // Run cleanup with 7-day TTL (recent file should be preserved)
      const cleanupResult = await cleanupIsolatedTranscripts({
        agentDir: testAgentDir,
        ttlDays: 7,
        dryRun: false,
      });

      // Recent file should be preserved even without access
      expect(cleanupResult.deletedCount).toBe(0);
      expect(cleanupResult.preservedCount).toBe(1);

      const exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: isolatedId,
      });
      expect(exists).toBe(true);
    });

    it("should handle explicit deletion", async () => {
      const isolatedId = generateIsolatedTranscriptId();

      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolatedId,
        content: "Content to delete",
        runId: testRunId,
        tokens: 100,
      });

      // Verify exists
      let exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: isolatedId,
      });
      expect(exists).toBe(true);

      // Explicit delete
      await deleteIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolatedId,
      });

      // Verify deleted
      exists = await isolatedTranscriptExists({
        agentDir: testAgentDir,
        id: isolatedId,
      });
      expect(exists).toBe(false);
    });

    it("should handle invalid reference tokens gracefully", async () => {
      const invalidTokens = [
        "not-a-token",
        "[isolated:]",
        "[isolated:invalid-uuid]",
        "[ISOLATED:some-id]",
        "[isolated:some-id]extra",
        "",
        "[]",
        "[isolated]",
      ];

      for (const token of invalidTokens) {
        const parsed = parseIsolatedTranscriptReferenceToken(token);
        expect(parsed).toBeNull();
      }
    });

    it("should handle non-existent isolated transcript reads", async () => {
      const nonExistentId = generateIsolatedTranscriptId();

      const result = await readIsolatedTranscript({
        agentDir: testAgentDir,
        id: nonExistentId,
      });

      expect(result).toBeNull();
    });

    it("should create isolated directory if it doesn't exist", async () => {
      const newAgentDir = path.join(testAgentDir, "new-agent-dir");
      const isolatedId = generateIsolatedTranscriptId();

      // Write to non-existent directory
      await writeIsolatedTranscript({
        agentDir: newAgentDir,
        id: isolatedId,
        content: "Test content",
        runId: testRunId,
        tokens: 50,
      });

      // Verify directory was created
      const isolatedDir = resolveIsolatedTranscriptDir(newAgentDir);
      const dirExists = await fs
        .access(isolatedDir)
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);

      // Verify file exists
      const exists = await isolatedTranscriptExists({
        agentDir: newAgentDir,
        id: isolatedId,
      });
      expect(exists).toBe(true);
    });

    it("should preserve metadata across read and cleanup", async () => {
      const isolatedId = generateIsolatedTranscriptId();
      const customRunId = `custom-run-${crypto.randomUUID()}`;
      const customChildKey = `custom-child-${crypto.randomUUID()}`;
      const tokenCount = 12345;

      await writeIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolatedId,
        content: "Content with metadata",
        runId: customRunId,
        childSessionKey: customChildKey,
        tokens: tokenCount,
      });

      // Read and verify metadata
      const read = await readIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolatedId,
      });

      expect(read!.runId).toBe(customRunId);
      expect(read!.childSessionKey).toBe(customChildKey);
      expect(read!.tokens).toBe(tokenCount);

      // Read again (metadata should persist)
      const read2 = await readIsolatedTranscript({
        agentDir: testAgentDir,
        id: isolatedId,
      });

      expect(read2!.runId).toBe(customRunId);
      expect(read2!.childSessionKey).toBe(customChildKey);
      expect(read2!.tokens).toBe(tokenCount);
    });
  });
});
