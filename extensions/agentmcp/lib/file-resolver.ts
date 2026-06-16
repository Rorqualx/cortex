// file_paths server-side resolver. Used by index.ts (MCP tool handlers) and
// harness/run.ts (so harness cases can exercise the same code path the live
// MCP tools see). Each resolved path becomes one context[] entry of the form
// "--- file: <path> ---\n<content>"; entries are prepended to whatever the
// caller already passed in context[].
//
// Behavior:
//   - Paths must be absolute. Relative paths are rejected.
//   - Paths must be inside an allowed root (default: $HOME and /tmp; override
//     via MCP_FILE_PATHS_ALLOWED_ROOTS, colon-separated).
//   - Each file is capped at MAX_FILE_BYTES (200KB). Larger files are truncated
//     with a marker line ("... [truncated; X bytes total, kept Y]").
//   - Errors throw FilePathError with a user-facing message.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_FILE_BYTES = 200_000;

export class FilePathError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "FilePathError";
  }
}

function defaultAllowedRoots(): string[] {
  return [os.homedir(), "/tmp"];
}

function readAllowedRoots(): string[] {
  const raw = process.env["MCP_FILE_PATHS_ALLOWED_ROOTS"];
  if (!raw) {
    return defaultAllowedRoots();
  }
  const roots = raw
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((r) => (r.startsWith("~") ? path.join(os.homedir(), r.slice(1)) : r))
    .map((r) => path.resolve(r));
  return roots.length > 0 ? roots : defaultAllowedRoots();
}

const ALLOWED_ROOTS = readAllowedRoots();

function isUnderAllowed(absPath: string): boolean {
  const normalized = path.resolve(absPath);
  return ALLOWED_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(root + path.sep),
  );
}

export async function resolveOneFile(p: string): Promise<string> {
  if (!path.isAbsolute(p)) {
    throw new FilePathError(`file_paths entry must be absolute: '${p}'`);
  }
  if (!isUnderAllowed(p)) {
    throw new FilePathError(
      `file_paths entry '${p}' is outside MCP_FILE_PATHS_ALLOWED_ROOTS (${ALLOWED_ROOTS.join(":")})`,
    );
  }
  let stat: { size: number };
  try {
    stat = await fs.stat(p);
  } catch (err) {
    throw new FilePathError(`file_paths entry '${p}' not readable: ${(err as Error).message}`);
  }
  const handle = await fs.open(p, "r");
  try {
    const cap = Math.min(stat.size, MAX_FILE_BYTES);
    const buf = Buffer.alloc(cap);
    await handle.read(buf, 0, cap, 0);
    let content = buf.toString("utf8");
    if (stat.size > MAX_FILE_BYTES) {
      content += `\n... [truncated; ${stat.size} bytes total, kept ${MAX_FILE_BYTES}]\n`;
    }
    return `--- file: ${p} ---\n${content}`;
  } finally {
    await handle.close();
  }
}

export async function resolveFilePaths(paths: string[] | undefined): Promise<string[]> {
  if (!paths || paths.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const p of paths) {
    out.push(await resolveOneFile(p));
  }
  return out;
}
