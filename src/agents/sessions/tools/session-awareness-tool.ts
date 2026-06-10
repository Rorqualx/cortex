import { resolve } from "node:path";
/**
 * Session Awareness Tool — lets agents query active sessions and file claims.
 *
 * Gives agents visibility into what other sessions are doing so they can
 * self-coordinate instead of being surprised by write guard blocks.
 */
import { Type } from "typebox";
import {
  sessionActivityRegistry,
  type SessionActivity,
  type FileClaim,
} from "../../../session-awareness/session-activity-registry.js";
import type { AgentTool } from "../../runtime/index.js";

const sessionAwarenessSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list", { description: "List active sessions and their file claims" }),
      Type.Literal("check", { description: "Check if a specific file is claimed" }),
      Type.Literal("status", { description: "Get overall registry status" }),
    ],
    {
      description:
        "Action: 'list' active sessions, 'check' a specific file, or get overall 'status'.",
      default: "status",
    },
  ),
  file_path: Type.Optional(
    Type.String({
      description: "File path to check (used with action='check').",
    }),
  ),
});

type SessionAwarenessParams = {
  action?: "list" | "check" | "status";
  file_path?: string;
};

type SessionClaimView = {
  sessionKey: string;
  agentId?: string;
  label?: string;
  claimedFiles: string[];
};

type SessionAwarenessDetails = {
  activeSessionCount: number;
  activeClaimCount: number;
  sessions?: SessionClaimView[];
  fileClaimed?: boolean;
  claimOwner?: string;
};

export function createSessionAwarenessTool(
  options: { cwd?: string } = {},
): AgentTool<typeof sessionAwarenessSchema, SessionAwarenessDetails> {
  const cwd = options.cwd ?? process.cwd();

  return {
    name: "session_awareness",
    label: "session_awareness",
    description:
      "Check what other agent sessions are active and which files they have claimed for writing. " +
      "Use before writing to shared files to avoid conflicts. " +
      "Actions: 'status' (default) for overview, 'list' for session details, 'check' for a specific file.",
    parameters: sessionAwarenessSchema,
    execute: async (_toolCallId, args) => {
      const params = args as SessionAwarenessParams;
      const action = params.action ?? "status";

      if (!sessionActivityRegistry.enabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Session awareness is disabled. No cross-session write protection is active.",
            },
          ],
          details: {
            activeSessionCount: 0,
            activeClaimCount: 0,
          },
        };
      }

      // Expire stale claims before reporting
      sessionActivityRegistry.expireStaleClaims();

      if (action === "check") {
        return handleCheck(params.file_path, cwd);
      }

      if (action === "list") {
        return handleList();
      }

      // action === "status"
      return handleStatus();
    },
  };
}

function handleStatus() {
  const sessions = sessionActivityRegistry.getActiveSessions();
  const claims = sessionActivityRegistry.getAllClaims();
  const scopedClaims = sessionActivityRegistry.getAllScopedClaims();

  const lines: string[] = [
    `Session Awareness Status:`,
    `  Active sessions: ${sessions.length}`,
    `  Active file claims: ${claims.length}`,
    `  Active scoped claims: ${scopedClaims.length}`,
    `  Guard enabled: ${sessionActivityRegistry.enabled}`,
  ];

  if (scopedClaims.length > 0) {
    lines.push("");
    lines.push("Active operations:");
    for (const claim of scopedClaims) {
      const sessionLabel = claim.agentId
        ? `${claim.sessionKey} (${claim.agentId})`
        : claim.sessionKey;
      lines.push(`  • [${claim.scope}] ${claim.description} — ${sessionLabel}`);
    }
  }

  if (claims.length > 0) {
    lines.push("");
    lines.push("Active file claims:");
    for (const claim of claims) {
      const sessionLabel = claim.agentId
        ? `${claim.sessionKey} (${claim.agentId})`
        : claim.sessionKey;
      const path =
        claim.resolvedPath.length > 80 ? "..." + claim.resolvedPath.slice(-77) : claim.resolvedPath;
      lines.push(`  • ${path} — ${sessionLabel} via ${claim.toolName}`);
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      activeSessionCount: sessions.length,
      activeClaimCount: claims.length,
    },
  };
}

function handleList() {
  const sessions = sessionActivityRegistry.getActiveSessions();
  const allClaims = sessionActivityRegistry.getAllClaims();

  // Group claims by session
  const sessionClaims = new Map<string, FileClaim[]>();
  for (const claim of allClaims) {
    const existing = sessionClaims.get(claim.sessionKey) ?? [];
    existing.push(claim);
    sessionClaims.set(claim.sessionKey, existing);
  }

  const lines: string[] = ["Active Sessions:"];

  if (sessions.length === 0) {
    lines.push("  No active sessions with file claims.");
  }

  const sessionViews: SessionClaimView[] = [];

  for (const session of sessions) {
    const claims = sessionClaims.get(session.sessionKey) ?? [];
    const view: SessionClaimView = {
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      label: session.label,
      claimedFiles: claims.map((c) =>
        c.resolvedPath.length > 80 ? "..." + c.resolvedPath.slice(-77) : c.resolvedPath,
      ),
    };
    sessionViews.push(view);

    const agentLabel = session.agentId ? ` (agent: ${session.agentId})` : "";
    lines.push(`  Session "${session.sessionKey}"${agentLabel}:`);
    if (claims.length === 0) {
      lines.push("    No active file claims");
    } else {
      for (const claim of claims) {
        const path =
          claim.resolvedPath.length > 80
            ? "..." + claim.resolvedPath.slice(-77)
            : claim.resolvedPath;
        lines.push(`    • ${path} (${claim.toolName})`);
      }
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      activeSessionCount: sessions.length,
      activeClaimCount: allClaims.length,
      sessions: sessionViews,
    },
  };
}

function handleCheck(filePath: string | undefined, cwd: string) {
  if (!filePath) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Provide a file_path to check.",
        },
      ],
      details: {
        activeSessionCount: sessionActivityRegistry.getActiveSessions().length,
        activeClaimCount: sessionActivityRegistry.getAllClaims().length,
      },
    };
  }

  const absPath = resolve(cwd, filePath);
  const claim = sessionActivityRegistry.getFileClaim(absPath);

  if (!claim) {
    return {
      content: [
        {
          type: "text" as const,
          text: `File "${filePath}" is not claimed. Safe to write.`,
        },
      ],
      details: {
        activeSessionCount: sessionActivityRegistry.getActiveSessions().length,
        activeClaimCount: sessionActivityRegistry.getAllClaims().length,
        fileClaimed: false,
      },
    };
  }

  const sessionLabel = claim.agentId
    ? `${claim.sessionKey} (agent: ${claim.agentId})`
    : claim.sessionKey;
  const timeSince = Date.now() - claim.claimedAt;
  const timeStr =
    timeSince < 60_000
      ? `${Math.round(timeSince / 1000)}s ago`
      : `${Math.round(timeSince / 60_000)}m ago`;

  return {
    content: [
      {
        type: "text" as const,
        text: `File "${filePath}" is claimed by ${sessionLabel} via ${claim.toolName} (claimed ${timeStr}). Wait for it to finish before writing.`,
      },
    ],
    details: {
      activeSessionCount: sessionActivityRegistry.getActiveSessions().length,
      activeClaimCount: sessionActivityRegistry.getAllClaims().length,
      fileClaimed: true,
      claimOwner: claim.sessionKey,
    },
  };
}
