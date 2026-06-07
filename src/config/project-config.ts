import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Multi-layer project config discovery and loading.
 *
 * Layers (highest priority first):
 *   1. Environment variables (handled elsewhere)
 *   2. Project local:  <project>/.openclaw.local.json  (gitignored)
 *   3. Project shared: <project>/.openclaw.json         (committed)
 *   4. Global:         ~/.openclaw/openclaw.json         (passed in)
 *   5. Built-in defaults (handled elsewhere)
 *
 * Project config can only override a specific allowlist of fields.
 * Security-sensitive fields (gateway, channels, secrets, hooks, plugins)
 * are silently stripped.
 */
import JSON5 from "json5";

export interface ProjectConfigResult {
  projectRoot: string | null;
  mergedConfig: Record<string, unknown> | null;
  sources: { shared: boolean; local: boolean };
}

interface CacheEntry {
  parsed: Record<string, unknown>;
  mtimeMs: number;
}

const ALLOWED_PREFIXES: readonly string[] = [
  "agents.defaults.model",
  "agents.defaults.thinkingDefault",
  "agents.defaults.reasoningDefault",
  "agents.defaults.params",
  "agents.defaults.skills",
  "agents.defaults.contextInjection",
  "agents.defaults.workspace",
  "agents.defaults.sandbox.docker.image",
  "agents.defaults.sandbox.docker.binds",
  "agents.defaults.sandbox.docker.env",
  "agents.defaults.sandbox.docker.network",
  "agents.defaults.sandbox.docker.setupCommand",
  "agents.defaults.sandbox.workspaceAccess",
  "agents.defaults.sandbox.workdir",
  "models.providers",
  "mcp.servers",
  "logging.level",
  "ui",
];

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 50;

function getCached(filePath: string): CacheEntry | null {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat) return null;
  const entry = cache.get(filePath);
  if (entry && entry.mtimeMs === stat.mtimeMs) return entry;
  return null;
}

function setCached(filePath: string, parsed: Record<string, unknown>, mtimeMs: number): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(filePath, { parsed, mtimeMs });
}

export function clearCache(): void {
  cache.clear();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSubPathOrEqual(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + ".");
}

export function discoverProjectRoot(cwd: string): string | null {
  const home = os.homedir();
  const globalDir = path.join(home, ".openclaw");
  let current = path.resolve(cwd);
  while (true) {
    if (current === globalDir) {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
      continue;
    }
    const candidate = path.join(current, ".openclaw.json");
    if (fs.existsSync(candidate)) return current;
    if (current === home || current === "/") return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function filterProjectFields(config: Record<string, unknown>): Record<string, unknown> {
  function recurse(obj: Record<string, unknown>, prefix: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const dotPath = prefix ? `${prefix}.${key}` : key;
      const allowed = ALLOWED_PREFIXES.some(
        (a) => isSubPathOrEqual(dotPath, a) || isSubPathOrEqual(a, dotPath),
      );
      if (!allowed) continue;
      if (isObject(value)) {
        const filtered = recurse(value, dotPath);
        if (Object.keys(filtered).length > 0) result[key] = filtered;
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  return recurse(config, "");
}

export function deepMerge(
  base: Record<string, unknown>,
  ...overrides: (Record<string, unknown> | null | undefined)[]
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const override of overrides) {
    if (!override) continue;
    for (const key of Object.keys(override)) {
      const val = override[key];
      if (isObject(val) && isObject(result[key])) {
        result[key] = deepMerge(result[key] as Record<string, unknown>, val);
      } else if (val !== undefined) {
        result[key] = val;
      }
    }
  }
  return result;
}

export function validateProjectConfig(raw: string, filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON5.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid project config at ${filePath}: ${message}`);
  }
}

export function loadProjectConfig(
  projectRoot: string,
  globalConfig: Record<string, unknown>,
): ProjectConfigResult {
  if (!projectRoot) {
    return { projectRoot: null, mergedConfig: null, sources: { shared: false, local: false } };
  }
  const sharedPath = path.join(projectRoot, ".openclaw.json");
  const localPath = path.join(projectRoot, ".openclaw.local.json");
  const sources = { shared: false, local: false };

  function loadLayer(filePath: string): Record<string, unknown> | null {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat) return null;
    const cached = getCached(filePath);
    if (cached) return cached.parsed;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = validateProjectConfig(raw, filePath);
    setCached(filePath, parsed, stat.mtimeMs);
    return parsed;
  }

  let config: Record<string, unknown> = { ...globalConfig };
  const shared = loadLayer(sharedPath);
  if (shared) {
    sources.shared = true;
    config = deepMerge(config, filterProjectFields(shared));
  }
  const local = loadLayer(localPath);
  if (local) {
    sources.local = true;
    config = deepMerge(config, filterProjectFields(local));
  }
  return { projectRoot, mergedConfig: config, sources };
}
