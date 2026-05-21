import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSkillForgeTelemetryDir } from "./paths.js";

export type SkillStatus = "staged" | "promoted" | "retired";

export type SkillTelemetryEntry = {
  name: string;
  status: SkillStatus;
  createdAt: string;
  promotedAt?: string;
  retiredAt?: string;
  retiredReason?: string;
  usageCount: number;
  lastUsedAt?: string;
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
}): Promise<SkillTelemetryEntry> {
  const existing = await readTelemetry({ name: params.name, env: params.env });
  const now = (params.now ?? new Date()).toISOString();
  const entry: SkillTelemetryEntry = existing
    ? { ...existing, status: "promoted", promotedAt: now }
    : {
        name: params.name,
        status: "promoted",
        createdAt: now,
        promotedAt: now,
        usageCount: 0,
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

export async function recordSkillUsage(params: {
  name: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillTelemetryEntry> {
  const existing = await readTelemetry({ name: params.name, env: params.env });
  const now = (params.now ?? new Date()).toISOString();
  const entry: SkillTelemetryEntry = existing
    ? { ...existing, usageCount: existing.usageCount + 1, lastUsedAt: now }
    : {
        name: params.name,
        status: "staged",
        createdAt: now,
        usageCount: 1,
        lastUsedAt: now,
      };
  await writeTelemetry({ entry, env: params.env });
  return entry;
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
