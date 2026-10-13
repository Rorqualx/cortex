import fsp from "node:fs/promises";
import path from "node:path";
import { stampSkillLifecycleInFrontmatter } from "./lifecycle.js";
import { resolveSkillForgePromotedSkillDir, resolveSkillForgeTelemetryDir } from "./paths.js";
import type { SkillLifecycle } from "./types.js";

export type SkillStatus = "staged" | "promoted" | "retired";

/**
 * Outcome of a skill invocation relative to the task it was invoked for
 * (actual-use precision, cf. skill-pool growth collapsing precision 29.6%→3.3%).
 * Logged separately from `taskSucceeded` — the two decouple.
 */
export type SkillInvocationOutcome = "correct" | "wrong" | "missed";

/** One invoke-time or outcome-stamped usage record (capped ring in `usageLog`). */
export type SkillUsageRecord = {
  at: string;
  /** Snapshot of the skill-pool size at invoke time — the x-axis of the
   *  precision-vs-pool-size curve. */
  poolSize?: number;
  /** Stamped post-run, not at invoke time; absent until known. */
  taskSucceeded?: boolean;
  /** Stamped post-run (needs a judge or heuristics; may stay absent). */
  invocationOutcome?: SkillInvocationOutcome;
};

/** Cap on per-skill usage records kept (drops oldest first). */
export const USAGE_LOG_MAX_RECORDS = 200;

export type SkillTelemetryEntry = {
  name: string;
  status: SkillStatus;
  /** Lifecycle of the promoted skill (2026-10-13). Absent on legacy entries
   * means "active" — see parseSkillLifecycle for the backfill rule. */
  lifecycle?: SkillLifecycle;
  createdAt: string;
  promotedAt?: string;
  retiredAt?: string;
  retiredReason?: string;
  usageCount: number;
  lastUsedAt?: string;
  successScore?: number;
  /** Capped invoke-time records with pool-size snapshots + post-run outcome stamps. */
  usageLog?: SkillUsageRecord[];
  lastPoolSize?: number;
  lastTaskSucceeded?: boolean;
  lastInvocationOutcome?: SkillInvocationOutcome;
};

async function ensureTelemetryDir(env: NodeJS.ProcessEnv): Promise<string> {
  const dir = resolveSkillForgeTelemetryDir(env);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function entryFilePath(dir: string, name: string): string {
  return path.join(dir, `${name}.json`);
}

export async function readTelemetry(params: {
  name: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillTelemetryEntry | null> {
  const dir = await ensureTelemetryDir(params.env ?? process.env);
  try {
    const raw = await fsp.readFile(entryFilePath(dir, params.name), "utf8");
    return JSON.parse(raw) as SkillTelemetryEntry;
  } catch {
    return null;
  }
}

export async function writeTelemetry(params: {
  entry: SkillTelemetryEntry;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const dir = await ensureTelemetryDir(params.env ?? process.env);
  const file = entryFilePath(dir, params.entry.name);
  await fsp.writeFile(file, `${JSON.stringify(params.entry, null, 2)}\n`, "utf8");
  return file;
}

export async function recordSkillCreation(params: {
  name: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillTelemetryEntry> {
  const existing = await readTelemetry({ name: params.name, env: params.env });
  if (existing) {
    return existing;
  }
  const entry: SkillTelemetryEntry = {
    name: params.name,
    status: "staged",
    createdAt: (params.now ?? new Date()).toISOString(),
    usageCount: 0,
  };
  await writeTelemetry({ entry, env: params.env });
  return entry;
}

export async function recordSkillPromotion(params: {
  name: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  successScore?: number;
}): Promise<SkillTelemetryEntry> {
  const existing = await readTelemetry({ name: params.name, env: params.env });
  const now = (params.now ?? new Date()).toISOString();
  const entry: SkillTelemetryEntry = existing
    ? {
        ...existing,
        status: "promoted",
        // 2026-10-13 fitness gate: promotions land in "trial"; the first
        // verified successful task (recordSkillUsageOutcome) flips them to
        // "active" so the auto-invoke gate re-admits them.
        lifecycle: "trial",
        promotedAt: now,
        successScore: params.successScore ?? existing.successScore,
      }
    : {
        name: params.name,
        status: "promoted",
        lifecycle: "trial",
        createdAt: now,
        promotedAt: now,
        usageCount: 0,
        successScore: params.successScore,
      };
  await writeTelemetry({ entry, env: params.env });
  return entry;
}

export async function recordSkillDemotion(params: {
  name: string;
  reason: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillTelemetryEntry> {
  const existing = await readTelemetry({ name: params.name, env: params.env });
  const now = (params.now ?? new Date()).toISOString();
  const entry: SkillTelemetryEntry = existing
    ? {
        ...existing,
        status: "retired",
        lifecycle: "retired",
        retiredAt: now,
        retiredReason: params.reason,
      }
    : {
        name: params.name,
        status: "retired",
        lifecycle: "retired",
        createdAt: now,
        retiredAt: now,
        retiredReason: params.reason,
        usageCount: 0,
      };
  await writeTelemetry({ entry, env: params.env });
  return entry;
}

/**
 * Record a forward lifecycle transition (trial→active, active→stable) on the
 * telemetry entry and, while the skill is promoted, mirror it into the
 * promoted SKILL.md frontmatter (the runtime auto-invoke gate reads the file).
 */
export async function recordSkillLifecycle(params: {
  name: string;
  lifecycle: Exclude<SkillLifecycle, "retired">;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillTelemetryEntry | null> {
  const existing = await readTelemetry({ name: params.name, env: params.env });
  if (!existing) {
    return null;
  }
  const entry: SkillTelemetryEntry = { ...existing, lifecycle: params.lifecycle };
  await writeTelemetry({ entry, env: params.env });
  if (existing.status === "promoted") {
    await stampPromotedSkillLifecycle({
      name: params.name,
      lifecycle: params.lifecycle,
      env: params.env,
    });
  }
  return entry;
}

/** Best-effort mirror of the lifecycle into the promoted SKILL.md frontmatter. */
async function stampPromotedSkillLifecycle(params: {
  name: string;
  lifecycle: SkillLifecycle;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  try {
    const skillMdPath = path.join(
      resolveSkillForgePromotedSkillDir({
        name: params.name,
        env: params.env ?? process.env,
      }),
      "SKILL.md",
    );
    const content = await fsp.readFile(skillMdPath, "utf8");
    await fsp.writeFile(
      skillMdPath,
      stampSkillLifecycleInFrontmatter(content, params.lifecycle),
      "utf8",
    );
  } catch {
    // Promoted dir may be gone (retired/moved externally); telemetry carries
    // the lifecycle either way.
  }
}

function appendUsageRecord(
  entry: SkillTelemetryEntry,
  record: SkillUsageRecord,
): SkillTelemetryEntry {
  const usageLog = [...(entry.usageLog ?? []), record];
  return {
    ...entry,
    usageLog:
      usageLog.length > USAGE_LOG_MAX_RECORDS
        ? usageLog.slice(usageLog.length - USAGE_LOG_MAX_RECORDS)
        : usageLog,
  };
}

export async function recordSkillUsage(params: {
  name: string;
  now?: Date;
  /** Override the pool-size snapshot (tests/backfill); defaults to counting entries. */
  poolSize?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillTelemetryEntry> {
  const existing = await readTelemetry({ name: params.name, env: params.env });
  const now = (params.now ?? new Date()).toISOString();
  const base: SkillTelemetryEntry = existing
    ? { ...existing, usageCount: existing.usageCount + 1, lastUsedAt: now }
    : {
        name: params.name,
        status: "staged",
        createdAt: now,
        usageCount: 1,
        lastUsedAt: now,
      };
  // Pool-size snapshot per usage — the precision-vs-pool-size curve needs this
  // captured at invoke time. Count after write so the pool includes this skill.
  const poolSize =
    params.poolSize ?? (await listTelemetryEntries(params.env ?? process.env)).length;
  const entry = appendUsageRecord(base, { at: now, poolSize });
  const stamped: SkillTelemetryEntry = { ...entry, lastPoolSize: poolSize };
  await writeTelemetry({ entry: stamped, env: params.env });
  return stamped;
}

/**
 * Stamp the post-run outcome onto the most recent usage record still missing
 * it. Outcome is known only after the run completes, so it is recorded
 * separately from `recordSkillUsage`: `taskSucceeded` is cheap and unambiguous;
 * `invocationOutcome` ("correct"/"wrong"/"missed") needs a judge or heuristics
 * and may arrive later, landing on the same record. Each call stamps the most
 * recent record that lacks at least one of the provided fields; when every
 * record already carries them, returns null — never invents a record.
 */
export async function recordSkillUsageOutcome(params: {
  name: string;
  taskSucceeded?: boolean;
  invocationOutcome?: SkillInvocationOutcome;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillTelemetryEntry | null> {
  const existing = await readTelemetry({ name: params.name, env: params.env });
  if (!existing?.usageLog?.length) {
    return null;
  }
  const wanted: Partial<SkillUsageRecord> = {};
  if (params.taskSucceeded !== undefined) {
    wanted.taskSucceeded = params.taskSucceeded;
  }
  if (params.invocationOutcome !== undefined) {
    wanted.invocationOutcome = params.invocationOutcome;
  }
  if (Object.keys(wanted).length === 0) {
    return existing;
  }
  const usageLog = [...existing.usageLog];
  for (let i = usageLog.length - 1; i >= 0; i -= 1) {
    const record = usageLog[i];
    if (!record) continue;
    const missing = Object.fromEntries(
      Object.entries(wanted).filter(
        ([field]) => record[field as keyof SkillUsageRecord] === undefined,
      ),
    );
    if (Object.keys(missing).length === 0) {
      continue;
    }
    usageLog[i] = { ...record, ...missing } as SkillUsageRecord;
    const stamped: SkillTelemetryEntry = {
      ...existing,
      usageLog,
      ...(wanted.taskSucceeded === undefined ? {} : { lastTaskSucceeded: wanted.taskSucceeded }),
      ...(wanted.invocationOutcome === undefined
        ? {}
        : { lastInvocationOutcome: wanted.invocationOutcome }),
    };
    // 2026-10-13 fitness gate: the first verified successful task after
    // promotion proves a trial skill in production — flip it to active so the
    // auto-invoke gate re-admits it (telemetry + SKILL.md frontmatter).
    const entry: SkillTelemetryEntry =
      wanted.taskSucceeded === true && stamped.lifecycle === "trial"
        ? { ...stamped, lifecycle: "active" }
        : stamped;
    await writeTelemetry({ entry, env: params.env });
    if (entry.lifecycle === "active" && stamped.lifecycle === "trial") {
      await stampPromotedSkillLifecycle({
        name: params.name,
        lifecycle: "active",
        env: params.env,
      });
    }
    return entry;
  }
  return null;
}

export async function listTelemetryEntries(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkillTelemetryEntry[]> {
  const dir = await ensureTelemetryDir(env);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const entries: SkillTelemetryEntry[] = [];
  for (const fileName of names) {
    if (!fileName.endsWith(".json")) {
      continue;
    }
    try {
      const raw = await fsp.readFile(path.join(dir, fileName), "utf8");
      entries.push(JSON.parse(raw) as SkillTelemetryEntry);
    } catch {
      // Skip unreadable entries.
    }
  }
  return entries;
}
