// Control UI helpers for resolving agent file-tool path args to absolute paths.
//
// The Control UI only ever sees the raw, model-supplied path arg of a
// read/write/edit tool call (e.g. "src/foo.ts" or "foo.ts"). To identify and
// refetch the file it must resolve that arg the same way the agent runtime
// does. The agent's tool cwd is its workspace root (see the server-side
// resolveToCwd in src/agents/sessions/tools/path-utils.ts), and that root ships
// to the UI on the agents.list row (GatewayAgentRow.workspace) and the
// agents.files.list response — so the UI can mirror the resolution locally.

/** Resolve a raw tool-arg path to a normalized absolute path that is directly
 * comparable to the server-canonical path (agents.files.get returns a
 * path.resolve()d / path.join()d absolute path). Mirrors the server's
 * expandPath + resolveToCwd:
 *   - `file://` URLs decode to their filesystem path (server: fileURLToPath).
 *   - a relative arg joins the workspace root.
 *   - every result collapses empty/`.`/`..` segments so it matches path.resolve
 *     (a verbatim absolute arg like "/ws//a/../b" would otherwise never match).
 * Returns null — so callers fall back to a basename match or the raw arg rather
 * than compare a non-comparable string — when there is no root for a relative
 * arg, the arg is empty, or it is `~`/`~/…` (the browser cannot expand the
 * agent host's home dir, so an exact match is impossible). */
export function resolveAgentArgPath(
  rawArg: string,
  workspaceRoot: string | undefined,
): string | null {
  let arg = rawArg.trim();
  if (!arg) {
    return null;
  }
  if (arg.startsWith("file://")) {
    try {
      arg = decodeURIComponent(new URL(arg).pathname);
    } catch {
      return null;
    }
  } else if (arg === "~" || arg.startsWith("~/")) {
    return null;
  }
  let base: string;
  if (arg.startsWith("/")) {
    base = arg;
  } else if (workspaceRoot) {
    base = `${workspaceRoot}/${arg}`;
  } else {
    return null;
  }
  const segments: string[] = [];
  for (const part of base.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return `/${segments.join("/")}`;
}
