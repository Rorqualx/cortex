import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  L3_LAYERS,
  isL3LayerId,
  renderL3Layer,
  renderL3LayerForAllAgents,
} from "./doctor.memory-l3-layers.js";

describe("doctor.memory.l3Layers rendering", () => {
  let rootDir = "";
  let workspaceDir = "";
  let l3Root = "";
  let config: OpenClawConfig;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-l3-layers-"));
    workspaceDir = path.join(rootDir, "workspace");
    l3Root = path.join(workspaceDir, ".openclaw", "l3");
    await fs.mkdir(l3Root, { recursive: true });
    config = { agents: { list: [{ id: "main", workspace: workspaceDir }] } } as OpenClawConfig;
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function writeExport(rel: string, frontmatter: unknown, body: string): Promise<void> {
    const file = path.join(l3Root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\n${JSON.stringify(frontmatter)}\n---\n${body}\n`, "utf8");
  }

  it("exposes seven layers and validates layer ids", () => {
    expect(L3_LAYERS).toHaveLength(7);
    expect(L3_LAYERS.map((layer) => layer.id)).toEqual([
      "l1",
      "l2",
      "l3",
      "longterm",
      "longterm-typed",
      "procedural",
      "shared",
    ]);
    expect(isL3LayerId("longterm")).toBe(true);
    expect(isL3LayerId("nope")).toBe(false);
  });

  it("renders the long-term prose body with frontmatter stripped", async () => {
    await writeExport(
      "longterm.md",
      { version: 1, agentId: "main" },
      "## pref:tabs\nUser prefers tabs.",
    );
    const md = await renderL3Layer(config, "main", "longterm");
    expect(md).toContain("## pref:tabs");
    expect(md).toContain("User prefers tabs.");
    expect(md).not.toContain("agentId"); // frontmatter is stripped
  });

  it("renders recent L2 chunk bodies under id headings", async () => {
    await writeExport("l2/2026-05-06/c1.md", { id: "c1" }, "extracted fact list");
    const md = await renderL3Layer(config, "main", "l2");
    expect(md).toContain("## c1");
    expect(md).toContain("extracted fact list");
  });

  it("returns a friendly note for an empty layer", async () => {
    const md = await renderL3Layer(config, "main", "longterm");
    expect(md.toLowerCase()).toContain("no long-term prose");
  });

  it("renders active shared facts ordered by importance (archived excluded)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sharedDir = path.join(rootDir, "shared-memory");
    await fs.mkdir(sharedDir, { recursive: true });
    const db = new DatabaseSync(path.join(sharedDir, "longterm-shared.sqlite"));
    db.exec(
      "CREATE TABLE l3_shared_longterm (row_id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "fact_id TEXT, source_agent_id TEXT, dedup_key TEXT, archived INTEGER, payload TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO l3_shared_longterm (fact_id, source_agent_id, dedup_key, archived, payload) VALUES (?, ?, ?, ?, ?)",
    );
    const mk = (id: string, dedupKey: string, importance: number, archived: boolean) => ({
      id,
      text: `fact ${dedupKey}`,
      dedupKey,
      importance,
      sourceAgentId: "agent-1",
      archived,
    });
    insert.run("f1", "agent-1", "k:low", 0, JSON.stringify(mk("f1", "k:low", 0.3, false)));
    insert.run("f2", "agent-1", "k:high", 0, JSON.stringify(mk("f2", "k:high", 0.9, false)));
    insert.run("f3", "agent-1", "k:dead", 1, JSON.stringify(mk("f3", "k:dead", 0.99, true)));
    db.close();

    const prev = process.env.OPENCLAW_SHARED_MEMORY_DIR;
    process.env.OPENCLAW_SHARED_MEMORY_DIR = sharedDir;
    try {
      const md = await renderL3Layer(config, "main", "shared");
      expect(md).toContain("k:high");
      expect(md).toContain("k:low");
      expect(md).not.toContain("k:dead"); // archived excluded
      // highest importance first
      expect(md.indexOf("k:high")).toBeLessThan(md.indexOf("k:low"));
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_SHARED_MEMORY_DIR;
      } else {
        process.env.OPENCLAW_SHARED_MEMORY_DIR = prev;
      }
    }
  });

  it("aggregates a layer across all agents (single shared workspace → one render)", async () => {
    await writeExport("longterm.md", { version: 1 }, "## pref:tabs\nUser prefers tabs.");
    // config has one agent → one unique workspace → renders that root once.
    const md = await renderL3LayerForAllAgents(config, "longterm");
    expect(md).toContain("User prefers tabs.");
  });

  it("renders an empty-note for the shared store when its DB is absent", async () => {
    const prev = process.env.OPENCLAW_SHARED_MEMORY_DIR;
    process.env.OPENCLAW_SHARED_MEMORY_DIR = path.join(rootDir, "shared-memory");
    try {
      const md = await renderL3Layer(config, "main", "shared");
      expect(md.toLowerCase()).toContain("no cross-context shared facts");
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_SHARED_MEMORY_DIR;
      } else {
        process.env.OPENCLAW_SHARED_MEMORY_DIR = prev;
      }
    }
  });
});
