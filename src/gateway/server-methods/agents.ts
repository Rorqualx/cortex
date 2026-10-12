// Agents gateway methods expose agent listing, config mutation, workspace file
// reads/writes, identity merging, and safe deletion for operator clients.
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString as resolveOptionalStringParam } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateAgentsComposePromptParams,
  validateAgentsCreateParams,
  validateAgentsDeleteParams,
  validateAgentsFilesGetParams,
  validateAgentsFilesListParams,
  validateAgentsFilesSetParams,
  validateAgentsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSharedStoreOwnerError } from "../../agents/agent-delete-databases.js";
import {
  formatSharedAuthStoreOwnerDeleteError,
  isInheritedAuthStoreOwner,
} from "../../agents/agent-delete-safety.js";
import { listAgentIds } from "../../agents/agent-roster.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  createAgentIdentityConfig,
  normalizeIdentityForFile,
  sanitizeAgentIdentityLine,
} from "../../agents/identity-file.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../../agents/simple-completion-runtime.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  SOULS_DIRNAME,
  WORKSPACE_BOOTSTRAP_FILENAMES,
  agentSoulRelativePath,
  ensureAgentWorkspace,
  isExpectedAbsentBootstrapFile,
  isWorkspaceSetupCompleted,
} from "../../agents/workspace.js";
import { applyAgentConfig } from "../../commands/agents.config.js";
import {
  AgentDeletionTargetsPendingError,
  assertAgentDeletionTargetsUnchanged,
} from "../../config/agent-workspace-roster-transition.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { root, FsSafeError, type ReadResult } from "../../infra/fs-safe.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../../routing/session-key.js";
import { readAgentDeletionJournalAsync } from "../../state/agent-deletion-journal.js";
import { resolveUserPath } from "../../utils.js";
import { reviveAgentDatabasesAfterConfigCommit } from "../server-reload-agent-databases.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import {
  AgentConfigPreconditionError,
  AgentModelSelectionError,
  createAgentConfigEntry,
  isConfiguredAgent,
  isImplicitAgentModelUpdate,
  updateAgentConfigEntry,
  validateAgentModelSelectionUpdate,
} from "./agents-config-mutations.js";
import {
  AgentSharedAuthStoreOwnerError,
  agentOwnsSharedAuthStore,
  deleteGatewayAgent,
} from "./agents-delete.js";
import {
  buildIdentityMarkdownOrRespondUnsafe,
  writeWorkspaceFileOrRespond,
} from "./agents-files.js";
import { agentListHandler } from "./agents-list.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";
import { enqueueWorkspaceFileUpdate } from "./workspace-fs.js";

const agentsHandlerDeps = {
  root,
  isWorkspaceSetupCompleted,
};

export const testing = {
  setDepsForTests(
    overrides: Partial<{
      root: typeof root;
      isWorkspaceSetupCompleted: typeof isWorkspaceSetupCompleted;
    }>,
  ) {
    if (overrides.isWorkspaceSetupCompleted) {
      agentsHandlerDeps.isWorkspaceSetupCompleted = overrides.isWorkspaceSetupCompleted;
    }
    if (overrides.root) {
      agentsHandlerDeps.root = overrides.root;
    }
  },
  resetDepsForTests() {
    agentsHandlerDeps.root = root;
    agentsHandlerDeps.isWorkspaceSetupCompleted = isWorkspaceSetupCompleted;
  },
};

// IDENTITY.md is excluded: it is a parsed record that `agents.update` rewrites via
// mergeIdentityMarkdownContent, so a second freeform editor would clobber fields
// (Creature/Vibe, unfilled placeholders) that the identity form round-trips.
// It stays writable through agents.files.set for clients that want raw access.
const CORE_FILE_NAMES = WORKSPACE_BOOTSTRAP_FILENAMES.filter(
  (name) => name !== DEFAULT_IDENTITY_FILENAME,
);
const CORE_FILE_NAMES_POST_ONBOARDING = CORE_FILE_NAMES.filter(
  (name) => name !== DEFAULT_BOOTSTRAP_FILENAME,
);

// Writes stay capped to canonical workspace files, and deliberately remain wider
// than the listed core files: IDENTITY.md is not offered as an editor tab but is
// still writable for clients that manage it directly.
const ALLOWED_FILE_NAMES = new Set<string>(WORKSPACE_BOOTSTRAP_FILENAMES);

function respondWorkspaceFileMissing(params: {
  respond: RespondFn;
  agentId: string;
  workspaceDir: string;
  name: string;
  filePath: string;
}): void {
  params.respond(
    true,
    {
      agentId: params.agentId,
      workspace: params.workspaceDir,
      // Clients merge this entry over the listed one, so it must carry the same
      // absence classification or a picked optional file re-renders as a fault.
      file: {
        name: params.name,
        path: params.filePath,
        missing: true,
        expectedAbsent: isExpectedAbsentBootstrapFile(params.name),
      },
    },
    undefined,
  );
}

function hashWorkspaceFileContent(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readWorkspaceFileHash(
  workspaceRoot: WorkspaceRoot,
  name: string,
): Promise<string | undefined> {
  try {
    const safeRead = await workspaceRoot.read(name, {
      hardlinks: "reject",
      nonBlockingRead: true,
    });
    return hashWorkspaceFileContent(safeRead.buffer);
  } catch (err) {
    if (isMissingPathError(err)) {
      return undefined;
    }
    throw err;
  }
}

function respondWorkspaceFileConflict(
  respond: RespondFn,
  name: string,
  currentHash: string | undefined,
) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `agent file "${name}" changed since it was read`, {
      details: {
        type: "agent_file_conflict",
        name,
        ...(currentHash ? { currentHash } : {}),
      },
    }),
  );
}

function resolveAgentWorkspaceFileOrRespondError(
  params: Record<string, unknown>,
  respond: RespondFn,
  cfg: OpenClawConfig,
): {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  name: string;
} | null {
  const rawAgentId = params.agentId;
  const agentId = resolveAgentIdOrError(
    typeof rawAgentId === "string" || typeof rawAgentId === "number" ? String(rawAgentId) : "",
    cfg,
  );
  if (!agentId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }
  const rawName = params.name;
  const name = (
    typeof rawName === "string" || typeof rawName === "number" ? String(rawName) : ""
  ).trim();
  if (!ALLOWED_FILE_NAMES.has(name)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported file "${name}"`));
    return null;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return { cfg, agentId, workspaceDir, name };
}

type FileMeta = {
  size: number;
  updatedAtMs: number;
};

type WorkspaceRoot = Awaited<ReturnType<typeof root>>;

// Soul editor binding. The default agent's soul IS the workspace root SOUL.md
// (also the shared template + the runtime fallback for everyone else). Every
// other agent reads/writes only its own souls/<id>.md and never the root file
// here, so the editor always shows that agent's individual soul — empty until
// authored — instead of the shared template. Other workspace files pass through.
function resolveSoulRelPath(agentId: string, name: string, isDefaultAgent: boolean): string {
  if (name !== DEFAULT_SOUL_FILENAME || isDefaultAgent) {
    return name;
  }
  return agentSoulRelativePath(agentId) ?? DEFAULT_SOUL_FILENAME;
}

type AgentFileEntry = {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
  isDirectory?: boolean;
};

/**
 * List files in an arbitrary directory (used for the active-dir workspace rail).
 * Returns up to 100 files, sorted alphabetically.
 */
function listDirectoryFiles(dirPath: string): AgentFileEntry[] {
  try {
    const entries = fsSync.readdirSync(dirPath, { withFileTypes: true });
    const files: AgentFileEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      } // skip hidden files
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        try {
          const stat = fsSync.statSync(fullPath);
          files.push({
            name: entry.name,
            path: fullPath,
            missing: false,
            size: stat.size,
            updatedAtMs: stat.mtimeMs,
          });
        } catch {
          files.push({ name: entry.name, path: fullPath, missing: true });
        }
      }
    }
    return files.toSorted((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
  } catch {
    return [];
  }
}

/**
 * Lists subdirectories of an arbitrary directory for the project folder picker.
 * Separate from listDirectoryFiles so the active-dir file rail is unaffected.
 * Returns up to 200 directories, sorted alphabetically, hidden dirs excluded.
 */
function listDirectorySubdirs(dirPath: string): AgentFileEntry[] {
  try {
    const entries = fsSync.readdirSync(dirPath, { withFileTypes: true });
    const dirs: AgentFileEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.isDirectory()) {
        dirs.push({
          name: entry.name,
          path: path.join(dirPath, entry.name),
          missing: false,
          isDirectory: true,
        });
      }
    }
    return dirs.toSorted((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
  } catch {
    return [];
  }
}

// Standards/template the composer must follow when turning a brief into a full
// agent prompt. Mirrors docs/reference/templates/SOUL.md so generated prompts
// drop straight into the agent's SOUL.md (which is loaded into its context).
const AGENT_PROMPT_COMPOSER_SYSTEM =
  `You write SOUL.md files for OpenClaw agents — the persona/behavior prompt loaded into the agent's context.
Given a brief description of an agent, produce a complete, well-structured SOUL.md in markdown.

Output ONLY the markdown body (no code fences, no YAML frontmatter). Address the agent as "you". Use these sections:
- "# <Agent name or role>" title line.
- "## Core Truths" — 3-5 bullet points on who the agent is and what it's for.
- "## Boundaries" — what it must not do; safety/ownership limits.
- "## Vibe" — tone and working style.
- "## Continuity" — how it should carry context and follow up.
Keep it concise (under 1500 characters), concrete, and free of secrets or absolute filesystem paths.`.trim();

/** Flatten an LLM completion's content blocks into plain text. */
function collectComposedPromptText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

function isRegularWorkspaceFileStat(stat: {
  isFile: boolean | (() => boolean);
  isSymbolicLink: boolean | (() => boolean);
  nlink: number;
}): boolean {
  const isFile = typeof stat.isFile === "function" ? stat.isFile() : stat.isFile;
  const isSymbolicLink =
    typeof stat.isSymbolicLink === "function" ? stat.isSymbolicLink() : stat.isSymbolicLink;
  // Reject links even after path-root containment so workspace reads cannot follow shared files.
  return isFile && !isSymbolicLink && stat.nlink <= 1;
}

function toWorkspaceFileMeta(
  stat: {
    size: number;
    mtimeMs: number;
  } & Parameters<typeof isRegularWorkspaceFileStat>[0],
): FileMeta | null {
  if (!isRegularWorkspaceFileStat(stat)) {
    return null;
  }
  return {
    size: stat.size,
    updatedAtMs: Math.floor(stat.mtimeMs),
  };
}

async function statWorkspaceFileSafely(
  workspaceRoot: WorkspaceRoot | null,
  workspaceDir: string,
  name: string,
): Promise<FileMeta | null> {
  try {
    const stat = workspaceRoot
      ? await workspaceRoot.stat(name)
      : await fs.lstat(path.join(workspaceDir, name));
    return toWorkspaceFileMeta(stat);
  } catch {
    if (!workspaceRoot) {
      return null;
    }
    try {
      // fs-safe roots can reject fixtures that are still valid regular files for listing metadata.
      const stat = await fs.lstat(path.join(workspaceDir, name));
      return toWorkspaceFileMeta(stat);
    } catch {
      return null;
    }
  }
}

async function openWorkspaceRootSafely(workspaceDir: string): Promise<WorkspaceRoot | null> {
  try {
    return await agentsHandlerDeps.root(workspaceDir);
  } catch {
    return null;
  }
}

async function listAgentFiles(workspaceDir: string, options?: { hideBootstrap?: boolean }) {
  const files: Array<{
    name: string;
    path: string;
    missing: boolean;
    expectedAbsent?: boolean;
    size?: number;
    updatedAtMs?: number;
  }> = [];

  const workspaceRoot = await openWorkspaceRootSafely(workspaceDir);
  if (!workspaceRoot) {
    // Keep the UI shape stable when the workspace path is missing or unsafe.
    const missingNames = options?.hideBootstrap ? CORE_FILE_NAMES_POST_ONBOARDING : CORE_FILE_NAMES;
    return missingNames.map((name) => ({
      name,
      path: path.join(workspaceDir, name),
      missing: true,
      expectedAbsent: isExpectedAbsentBootstrapFile(name),
    }));
  }

  const coreFileNames = options?.hideBootstrap ? CORE_FILE_NAMES_POST_ONBOARDING : CORE_FILE_NAMES;
  for (const name of coreFileNames) {
    const filePath = path.join(workspaceDir, name);
    const meta = await statWorkspaceFileSafely(workspaceRoot, workspaceDir, name);
    if (meta) {
      files.push({
        name,
        path: filePath,
        missing: false,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
      });
    } else {
      files.push({
        name,
        path: filePath,
        missing: true,
        expectedAbsent: isExpectedAbsentBootstrapFile(name),
      });
    }
  }

  return files;
}

function resolveAgentIdOrError(agentIdRaw: string, cfg: OpenClawConfig) {
  const agentId = normalizeAgentId(agentIdRaw);
  const allowed = new Set(listAgentIds(cfg));
  if (!allowed.has(agentId)) {
    return null;
  }
  return agentId;
}

function respondAgentNotFound(respond: RespondFn, agentId: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`));
}

function createAgentConfigApplication(respond: RespondFn) {
  const application = createRuntimeConfigWriteApplication(
    captureGatewayRootWorkAdmissionContinuationScope()?.run,
  );
  return {
    attach: <T extends object>(options: T) =>
      attachRuntimeConfigWriteApplication(options, application),
    confirm: async () => {
      const outcome = application.claimed ? await application.result : "unclaimed";
      if (outcome === "applied") {
        return true;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Agent configuration was saved but its application to the active Gateway was not confirmed (${outcome}); run config.get, then apply the saved config or restart the Gateway.`,
        ),
      );
      return false;
    },
  };
}

function respondWorkspaceFileUnsafe(respond: RespondFn, name: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `unsafe workspace file "${name}"`),
  );
}

export const agentsHandlers: GatewayRequestHandlers = {
  "agents.list": agentListHandler,
  "agents.create": async (options) => {
    const { params, respond, client, context } = options;
    if (!assertValidParams(params, validateAgentsCreateParams, "agents.create", respond)) {
      return;
    }

    let assertOwnerCurrent: (() => void) | undefined;
    try {
      assertOwnerCurrent = params.expectedOwnerId
        ? captureLocalStateMutationGuard(params.expectedOwnerId, options)
        : undefined;
    } catch (error) {
      respond(false, undefined, localStateOwnerChangedError(error));
      return;
    }
    const application = createAgentConfigApplication(respond);
    try {
      const result = await createAgentConfigEntry(
        {
          name: params.name,
          workspace: params.workspace,
          model: params.model,
          emoji: params.emoji,
          avatar: params.avatar,
          beforePersistentApply: assertOwnerCurrent,
          assertIdentityInputAllowed: captureGatewayClientUploadCommitGuard({
            method: "agents.create",
            requestParams: params,
            client,
            context,
          }),
        },
        application.attach({}),
      );
      if (result.status === "error") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.message));
        return;
      }
      await reviveAgentDatabasesAfterConfigCommit([result.agentId], (message) =>
        context.logGateway.warn(message),
      );
      if (!(await application.confirm())) {
        return;
      }
      respond(
        true,
        {
          ok: true,
          agentId: result.agentId,
          name: result.name,
          workspace: result.workspace,
          agentDir: result.agentDir,
          ...(result.model ? { model: result.model } : {}),
        },
        undefined,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
      throw error;
    }
  },
  "agents.composePrompt": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateAgentsComposePromptParams, "agents.composePrompt", respond)
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const briefRaw = (params as { brief?: unknown }).brief;
    const brief = typeof briefRaw === "string" ? briefRaw.trim() : "";
    if (!brief) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "brief is required"));
      return;
    }
    const rawAgentId = (params as { agentId?: unknown }).agentId;
    const agentId =
      typeof rawAgentId === "string" && rawAgentId.trim()
        ? normalizeAgentId(rawAgentId.trim())
        : resolveDefaultAgentId(cfg);

    let prepared;
    try {
      prepared = await prepareSimpleCompletionModelForAgent({
        cfg,
        agentId,
        allowMissingApiKeyModes: ["aws-sdk"],
        skipAgentDiscovery: true,
      });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `model preparation failed: ${error instanceof Error ? error.message : "unknown"}`,
        ),
      );
      return;
    }
    if ("error" in prepared) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, prepared.error));
      return;
    }

    let result;
    try {
      result = await completeWithPreparedSimpleCompletionModel({
        model: prepared.model,
        auth: prepared.auth,
        cfg,
        context: {
          systemPrompt: AGENT_PROMPT_COMPOSER_SYSTEM,
          messages: [{ role: "user", content: brief, timestamp: Date.now() }],
        },
        options: {
          maxTokens:
            typeof prepared.model.maxTokens === "number" &&
            Number.isFinite(prepared.model.maxTokens)
              ? Math.min(prepared.model.maxTokens, 2000)
              : 2000,
        },
      });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `prompt composition failed: ${error instanceof Error ? error.message : "unknown"}`,
        ),
      );
      return;
    }

    const prompt = collectComposedPromptText(result.content).trim();
    if (!prompt) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "model returned no text for prompt composition"),
      );
      return;
    }
    respond(true, { ok: true, prompt }, undefined);
  },
  "agents.update": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateAgentsUpdateParams, "agents.update", respond)) {
      return;
    }

    const assertUploadCurrent = captureGatewayClientUploadCommitGuard({
      method: "agents.update",
      requestParams: params,
      client,
      context,
    });
    let identityPublished = false;
    const assertUploadAllowed = () => {
      if (!identityPublished) {
        assertUploadCurrent?.();
      }
    };
    const cfg = context.getRuntimeConfig();
    const normalized = normalizeAgentIdStrict(params.agentId);
    if (!normalized.ok) {
      respondAgentNotFound(respond, params.agentId);
      return;
    }
    const agentId = normalized.value;
    const workspace = resolveOptionalStringParam(params.workspace);
    const workspaceDir = workspace ? resolveUserPath(workspace) : undefined;

    const model = params.model === null ? null : resolveOptionalStringParam(params.model);

    const name = resolveOptionalStringParam(params.name);
    const safeName = name ? sanitizeAgentIdentityLine(name) : undefined;

    const description = resolveOptionalStringParam(params.description);
    const role = resolveOptionalStringParam(params.role);
    const baseIdentity = createAgentIdentityConfig({
      name: safeName,
      emoji: params.emoji,
      avatar: params.avatar,
    });
    // Role is a display-only identity label the shared helper does not model;
    // layer it on top so role-only updates still produce an identity patch.
    const identity = role
      ? { ...baseIdentity, role: sanitizeAgentIdentityLine(role) }
      : baseIdentity;
    const hasIdentityFields = Boolean(identity);

    const agentConfigUpdate: Parameters<typeof updateAgentConfigEntry>[0] = {
      agentId,
      ...(safeName ? { name: safeName } : {}),
      ...(workspaceDir ? { workspace: workspaceDir } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(params.agentRuntime ? { agentRuntime: params.agentRuntime } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(params.thinkingDefault ? { thinkingDefault: params.thinkingDefault } : {}),
      ...(identity ? { identity } : {}),
    };
    const selectionError = validateAgentModelSelectionUpdate(params);
    if (selectionError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectionError));
      return;
    }
    const configured = isConfiguredAgent(cfg, agentId);
    if (!configured && !isImplicitAgentModelUpdate(cfg, agentConfigUpdate)) {
      respondAgentNotFound(respond, agentId);
      return;
    }
    const nextConfig = configured ? applyAgentConfig(cfg, agentConfigUpdate) : cfg;
    const application = createAgentConfigApplication(respond);

    try {
      let ensuredWorkspace: Awaited<ReturnType<typeof ensureAgentWorkspace>> | undefined;
      if (workspaceDir) {
        await assertAgentDeletionTargetsUnchanged(cfg, nextConfig);
        const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
        ensuredWorkspace = await ensureAgentWorkspace({
          dir: workspaceDir,
          guard: { assertHost: assertUploadAllowed },
          ensureBootstrapFiles: !skipBootstrap,
          skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
        });
      }

      const persistedIdentity = normalizeIdentityForFile(resolveAgentIdentity(nextConfig, agentId));
      if (persistedIdentity && (workspaceDir || hasIdentityFields)) {
        const identityWorkspaceDir = resolveAgentWorkspaceDir(nextConfig, agentId);
        const previousWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
        const fallbackWorkspaceDir =
          workspaceDir && identityWorkspaceDir !== previousWorkspaceDir
            ? previousWorkspaceDir
            : undefined;
        // A workspace service may be replaced while the identity read is awaiting I/O.
        // Keep both the source and destination pinned for this read/merge/write.
        const workspaceAccess = [
          identityWorkspaceDir,
          ...(fallbackWorkspaceDir ? [fallbackWorkspaceDir] : []),
        ].map((dir) => [dir, getAgentWorkspaceAccess(dir)] as const);
        const assertWorkspaceAccessCurrent = () => {
          assertUploadAllowed?.();
          for (const [dir, access] of workspaceAccess) {
            if (getAgentWorkspaceAccess(dir) !== access) {
              throw new Error("Workspace access changed while updating Agent identity");
            }
          }
        };
        const identityContent = await buildIdentityMarkdownOrRespondUnsafe({
          respond,
          workspaceDir: identityWorkspaceDir,
          identity: persistedIdentity,
          fallbackWorkspaceDir,
          preferFallbackWorkspaceContent:
            Boolean(fallbackWorkspaceDir) && ensuredWorkspace?.identityPathCreated === true,
        });
        if (identityContent === null) {
          return;
        }
        assertWorkspaceAccessCurrent();
        if (
          !(await writeWorkspaceFileOrRespond({
            respond,
            workspaceDir: identityWorkspaceDir,
            name: DEFAULT_IDENTITY_FILENAME,
            content: identityContent,
            assertCurrent: assertWorkspaceAccessCurrent,
          }))
        ) {
          return;
        }
        // The write accepted these exact bytes. Settle their config projection,
        // without retiring workspace authority or admitting another upload.
        identityPublished = true;
        assertWorkspaceAccessCurrent();
      }

      await updateAgentConfigEntry(
        { ...agentConfigUpdate, assertCurrent: assertUploadAllowed },
        application.attach({}),
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
      if (error instanceof AgentConfigPreconditionError) {
        respondAgentNotFound(respond, agentId);
        return;
      }
      if (
        error instanceof AgentModelSelectionError ||
        error instanceof AgentDeletionTargetsPendingError
      ) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
        return;
      }
      throw error;
    }

    if (await application.confirm()) {
      respond(true, { ok: true, agentId }, undefined);
    }
  },
  "agents.delete": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateAgentsDeleteParams, "agents.delete", respond)) {
      return;
    }

    const cfg = context.getRuntimeConfig();
    const normalized = normalizeAgentIdStrict(params.agentId);
    if (!normalized.ok) {
      respondAgentNotFound(respond, params.agentId);
      return;
    }
    const agentId = normalized.value;
    if (agentOwnsSharedAuthStore(cfg, agentId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatSharedAuthStoreOwnerDeleteError(agentId)),
      );
      return;
    }
    const existingJournal = await readAgentDeletionJournalAsync(agentId);
    if (
      !isConfiguredAgent(cfg, agentId) &&
      (!existingJournal || existingJournal.cleanupCompleted)
    ) {
      respondAgentNotFound(respond, agentId);
      return;
    }
    if (agentId === resolveDefaultAgentId(cfg)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Agent "${agentId}" is the default and cannot be deleted. Reassign default first.`,
        ),
      );
      return;
    }
    if (isInheritedAuthStoreOwner(cfg, agentId)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Agent "${agentId}" owns inherited credentials through agents.defaults.authInheritance.agentId and cannot be deleted. Relocate those credentials, then re-point or remove that binding before retrying.`,
        ),
      );
      return;
    }

    const requestedDeleteFiles = params.deleteFiles ?? true;
    const application = createAgentConfigApplication(respond);
    try {
      const result = await deleteGatewayAgent(agentId, requestedDeleteFiles, context, {
        writeOptions: application.attach({}),
      });
      // Reload may need the mutation/deletion leases; wait only after they settle.
      if (!(await application.confirm())) {
        return;
      }
      if (result.purgeFailed || result.failed?.length) {
        const failures = result.failed?.map(({ path, reason }) => `${path}: ${reason}`) ?? [];
        if (result.purgeFailed) {
          failures.unshift("session-store cleanup failed");
        }
        respond(
          false,
          result,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Agent "${agentId}" was removed from configuration, but deletion cleanup is still pending: ${failures.join("; ")}. Resolve the cleanup failure, then retry agents.delete.`,
          ),
        );
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      if (
        error instanceof AgentSharedAuthStoreOwnerError ||
        error instanceof AgentSharedStoreOwnerError
      ) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      if (error instanceof AgentConfigPreconditionError) {
        respondAgentNotFound(respond, agentId);
        return;
      }
      throw error;
    }
  },
  "agents.files.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateAgentsFilesListParams, "agents.files.list", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const agentId = resolveAgentIdOrError(params.agentId, cfg);
    if (!agentId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    let hideBootstrap = false;
    try {
      hideBootstrap = await agentsHandlerDeps.isWorkspaceSetupCompleted(workspaceDir);
    } catch {
      // Fall back to showing BOOTSTRAP if workspace state cannot be read.
    }
    const files = await listAgentFiles(workspaceDir, { hideBootstrap });
    // If an alternate path is requested, list files + subdirectories from it.
    // activeDirSubdirs powers the project folder picker; ~ expands to home.
    let activeDirFiles: AgentFileEntry[] | undefined;
    let activeDirSubdirs: AgentFileEntry[] | undefined;
    if (typeof params.path === "string" && params.path.trim()) {
      const requestedPath = resolveUserPath(params.path.trim());
      // Only allow listing if the path exists and is a directory
      try {
        const stat = fsSync.statSync(requestedPath);
        if (stat.isDirectory()) {
          activeDirFiles = listDirectoryFiles(requestedPath);
          activeDirSubdirs = listDirectorySubdirs(requestedPath);
        }
      } catch {
        // Path doesn't exist or isn't readable — skip
      }
    }
    respond(
      true,
      { agentId, workspace: workspaceDir, files, activeDirFiles, activeDirSubdirs },
      undefined,
    );
  },
  "agents.files.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateAgentsFilesGetParams, "agents.files.get", respond)) {
      return;
    }

    // If a full path is provided (active directory file), read it directly
    if (typeof params.path === "string" && params.path.trim()) {
      const filePath = path.resolve(params.path.trim());
      const name = path.basename(filePath);
      try {
        const stat = fsSync.statSync(filePath);
        if (!stat.isFile()) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "not a file"));
          return;
        }
        // Cap at 500KB
        if (stat.size > 500 * 1024) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "file too large"));
          return;
        }
        const content = await fs.readFile(filePath, "utf-8");
        respond(
          true,
          {
            agentId: params.agentId ?? "main",
            workspace: path.dirname(filePath),
            file: { name, path: filePath, content, size: stat.size, updatedAtMs: stat.mtimeMs },
          },
          undefined,
        );
      } catch {
        respondWorkspaceFileMissing({
          respond,
          agentId: params.agentId ?? "main",
          workspaceDir: path.dirname(filePath),
          name,
          filePath,
        });
      }
      return;
    }

    const resolved = resolveAgentWorkspaceFileOrRespondError(
      params,
      respond,
      context.getRuntimeConfig(),
    );
    if (!resolved) {
      return;
    }
    const { cfg, agentId, workspaceDir, name } = resolved;
    const isDefaultAgent = resolveDefaultAgentId(cfg) === agentId;
    const readRelPath = resolveSoulRelPath(agentId, name, isDefaultAgent);
    const filePath = path.join(workspaceDir, readRelPath);
    let safeRead: ReadResult;
    try {
      const workspaceRoot = await agentsHandlerDeps.root(workspaceDir);
      safeRead = await workspaceRoot.read(readRelPath, {
        hardlinks: "reject",
        nonBlockingRead: true,
      });
    } catch (err) {
      if (err instanceof FsSafeError && err.code === "not-found") {
        if (name === DEFAULT_SOUL_FILENAME && !isDefaultAgent) {
          // Non-default agent with no souls/<id>.md yet: show an empty editor,
          // not the shared root SOUL.md, so the field reflects this agent. It
          // still inherits the shared soul at runtime until one is saved here.
          // The default agent keeps the plain missing-file response below.
          respond(
            true,
            {
              agentId,
              workspace: workspaceDir,
              file: { name, path: filePath, missing: true, content: "" },
            },
            undefined,
          );
          return;
        }
        respondWorkspaceFileMissing({ respond, agentId, workspaceDir, name, filePath });
        return;
      }
      if (err instanceof FsSafeError) {
        respondWorkspaceFileUnsafe(respond, name);
        return;
      }
      throw err;
    }
    respond(
      true,
      {
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: safeRead.stat.size,
          updatedAtMs: Math.floor(safeRead.stat.mtimeMs),
          hash: hashWorkspaceFileContent(safeRead.buffer),
          content: safeRead.buffer.toString("utf-8"),
        },
      },
      undefined,
    );
  },
  "agents.files.set": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateAgentsFilesSetParams, "agents.files.set", respond)) {
      return;
    }
    const resolved = resolveAgentWorkspaceFileOrRespondError(
      params,
      respond,
      context.getRuntimeConfig(),
    );
    if (!resolved) {
      return;
    }
    const { cfg, agentId, workspaceDir, name } = resolved;
    const isDefaultAgent = resolveDefaultAgentId(cfg) === agentId;
    const writeRelPath = resolveSoulRelPath(agentId, name, isDefaultAgent);
    await fs.mkdir(workspaceDir, { recursive: true });
    if (writeRelPath !== name) {
      // Ensure souls/ exists before the guarded write targets souls/<id>.md.
      await fs.mkdir(path.join(workspaceDir, SOULS_DIRNAME), { recursive: true });
    }
    const filePath = path.join(workspaceDir, writeRelPath);
    const content = params.content;
    let workspaceRoot: WorkspaceRoot;
    let conflict: { currentHash: string | undefined } | undefined;
    try {
      workspaceRoot = await agentsHandlerDeps.root(workspaceDir);
      const writeRoot = workspaceRoot;
      const expectedHash = params.expectedHash?.toLowerCase();
      // Fork: the soul-editor redirect writes non-default agents' SOUL.md to
      // souls/<id>.md (writeRelPath). The optimistic-concurrency check must read
      // and write that same redirected path, since agents.files.get hashes it too.
      conflict = await enqueueWorkspaceFileUpdate(async () => {
        if (expectedHash) {
          const currentHash = await readWorkspaceFileHash(writeRoot, writeRelPath);
          if (currentHash !== expectedHash) {
            return { currentHash };
          }
        }
        await writeRoot.write(writeRelPath, content, { encoding: "utf8" });
        return undefined;
      });
    } catch (err) {
      if (!(err instanceof FsSafeError)) {
        throw err;
      }
      respondWorkspaceFileUnsafe(respond, name);
      return;
    }
    if (conflict) {
      respondWorkspaceFileConflict(respond, name, conflict.currentHash);
      return;
    }
    const meta = await statWorkspaceFileSafely(workspaceRoot, workspaceDir, writeRelPath);
    respond(
      true,
      {
        ok: true,
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: meta?.size,
          updatedAtMs: meta?.updatedAtMs,
          hash: hashWorkspaceFileContent(content),
          content,
        },
      },
      undefined,
    );
  },
};
export { testing as __testing };
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
