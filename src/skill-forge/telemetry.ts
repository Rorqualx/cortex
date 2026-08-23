import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSkillForgeTelemetryDir } from "./paths.js";

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
  /**
   * Multi-run replay-judge agreement snapshot (QW3 2026-08-23): stamped on the
   * card when the promotion lane runs k judge replays. Variance is Bernoulli
   * p(1-p) over the pass indicator — low variance + high passRate = stable
   * promotion signal; high variance = judge disagreement worth a human look.
   */
  replayAgreement?: {
    runs: number;
    passRate: number;
    agreement: number;
    variance: number;
    provider: string;
    modelId: string;
    recordedAt: string;
  };
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
  /** Multi-run replay agreement stats to stamp on the card (see SkillTelemetryEntry). */
  replayAgreement?: {
    runs: number;
    passRate: number;
    agreement: number;
    variance: number;
    provider: string;
    modelId: string;
  };
}): Promise<SkillTelemetryEntry> {
  const existing = await readTelemetry({ name: params.name, env: params.env });
  const now = (params.now ?? new Date()).toISOString();
  const replayAgreement = params.replayAgreement
    ? { ...params.replayAgreement, recordedAt: now }
    : existing?.replayAgreement;
  const entry: SkillTelemetryEntry = existing
    ? {
        ...existing,
        status: "promoted",
        promotedAt: now,
        successScore: params.successScore ?? existing.successScore,
        ...(replayAgreement ? { replayAgreement } : {}),
      }
    : {
        name: params.name,
        status: "promoted",
        createdAt: now,
        promotedAt: now,
        usageCount: 0,
        successScore: params.successScore,
        ...(replayAgreement ? { replayAgreement } : {}),
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
        retiredAt: now,
        retiredReason: params.reason,
      }
    : {
        name: params.name,
        status: "retired",
        createdAt: now,
        retiredAt: now,
        retiredReason: params.reason,
        usageCount: 0,
      };
  await writeTelemetry({ entry, env: params.env });
  return entry;
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
    const entry: SkillTelemetryEntry = {
      ...existing,
      usageLog,
      ...(wanted.taskSucceeded === undefined ? {} : { lastTaskSucceeded: wanted.taskSucceeded }),
      ...(wanted.invocationOutcome === undefined
        ? {}
        : { lastInvocationOutcome: wanted.invocationOutcome }),
    };
    await writeTelemetry({ entry, env: params.env });
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
