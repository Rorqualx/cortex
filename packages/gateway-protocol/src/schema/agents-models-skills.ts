// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { GatewayAgentRuntimeSchema } from "./session-row.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Agent, model, skill, and tool catalog schemas.
 *
 * These contracts back dashboard selectors, agent management, model catalogs,
 * skill upload/install flows, and effective tool discovery. Keep public request/result schemas documented because they are
 * shared by gateway RPC, CLI, and UI clients.
 */

/** Model option shown in selectors and model catalog results. */
export const ModelChoiceSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    alias: Type.Optional(NonEmptyString),
    available: Type.Optional(Type.Boolean()),
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Semantic owner of an agent roster entry. */
export const AgentKindSchema = Type.Union([Type.Literal("agent"), Type.Literal("system")]);

/** Condensed agent record returned by list APIs. */
export const AgentSummarySchema = closedObject({
  id: NonEmptyString,
  kind: Type.Optional(AgentKindSchema),
  name: Type.Optional(NonEmptyString),
  identity: Type.Optional(
    closedObject({
      name: Type.Optional(NonEmptyString),
      // Fork: display-only identity role label surfaced in agent lists.
      role: Type.Optional(NonEmptyString),
      theme: Type.Optional(NonEmptyString),
      emoji: Type.Optional(NonEmptyString),
      avatar: Type.Optional(NonEmptyString),
      avatarUrl: Type.Optional(NonEmptyString),
    }),
  ),
  workspace: Type.Optional(NonEmptyString),
  workspaceGit: Type.Optional(Type.Boolean()),
  model: Type.Optional(
    closedObject({
      primary: Type.Optional(NonEmptyString),
      fallbacks: Type.Optional(Type.Array(NonEmptyString)),
    }),
  ),
  agentRuntime: Type.Optional(GatewayAgentRuntimeSchema),
  thinkingLevels: Type.Optional(
    Type.Array(
      closedObject({
        id: NonEmptyString,
        label: NonEmptyString,
      }),
    ),
  ),
  thinkingOptions: Type.Optional(Type.Array(NonEmptyString)),
  thinkingDefault: Type.Optional(NonEmptyString),
});

/** Empty request payload for listing configured agents. */
export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

/** Agent list result including the default agent and session scoping mode. */
export const AgentsListResultSchema = Type.Object(
  {
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
    agents: Type.Array(AgentSummarySchema),
  },
  { additionalProperties: false },
);

/** Creates a configured agent with workspace, identity, and optional model. */
export const AgentsCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    workspace: NonEmptyString,
    model: Type.Optional(NonEmptyString),
    emoji: Type.Optional(Type.String()),
    avatar: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    role: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Result returned after creating an agent. */
export const AgentsCreateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    name: NonEmptyString,
    workspace: NonEmptyString,
    model: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Updates mutable agent identity, workspace, model, and thinking fields. */
export const AgentsUpdateParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    workspace: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    emoji: Type.Optional(Type.String()),
    avatar: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    role: Type.Optional(Type.String()),
    // Per-agent default thinking level; mirrors the config enum in
    // src/config/types.agents.ts so the RPC rejects unknown levels at the boundary.
    thinkingDefault: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("adaptive"),
        Type.Literal("max"),
      ]),
    ),
  },
  { additionalProperties: false },
);

/** Result returned after updating an agent. */
export const AgentsUpdateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Deletes an agent and optionally its workspace/config files. */
export const AgentsDeleteParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    deleteFiles: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Result returned after deleting an agent and unbinding sessions. */
export const AgentsDeleteResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    removedBindings: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** File metadata and optional content for agent-local editable files. */
export const AgentsFileEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    path: NonEmptyString,
    missing: Type.Boolean(),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    content: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Lists editable files for one agent. */
export const AgentsFilesListParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    path: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Editable file list for an agent workspace. */
export const AgentsFilesListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    files: Type.Array(AgentsFileEntrySchema),
  },
  { additionalProperties: false },
);

/** Reads one editable agent file by name. */
export const AgentsFilesGetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
    path: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Result for reading one editable agent file. */
export const AgentsFilesGetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

/** Writes one editable agent file. */
export const AgentsFilesSetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
    content: Type.String(),
  },
  { additionalProperties: false },
);

/** Result returned after writing an editable agent file. */
export const AgentsFilesSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

/** Model catalog request with optional visibility scope. */
export const ModelsListParamsSchema = Type.Object(
  {
    view: Type.Optional(
      Type.Union([Type.Literal("default"), Type.Literal("configured"), Type.Literal("all")]),
    ),
  },
  { additionalProperties: false },
);

/** Reads model-provider credential health for one configured agent. */
export const ModelsAuthStatusParamsSchema = closedObject({
  refresh: Type.Optional(Type.Boolean()),
  agentId: Type.Optional(Type.String()),
});

/** Removes saved model-provider credentials from one configured agent. */
export const ModelsAuthLogoutParamsSchema = closedObject({
  provider: NonEmptyString,
  profileIds: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  agentId: Type.Optional(Type.String()),
});

/** Model catalog result. */
export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
  },
  { additionalProperties: false },
);

/** Runs a bounded live credential probe for one model provider. */
export const ModelsProbeParamsSchema = closedObject({
  provider: NonEmptyString,
  profileId: Type.Optional(NonEmptyString),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  agentId: Type.Optional(Type.String()),
});

export const AuthProbeStatusSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("auth"),
  Type.Literal("rate_limit"),
  Type.Literal("billing"),
  Type.Literal("timeout"),
  Type.Literal("format"),
  Type.Literal("unknown"),
  Type.Literal("no_model"),
]);

/** Secret-free result for one provider credential target. */
export const ModelsProbeTargetResultSchema = Type.Object(
  {
    profileId: Type.Optional(NonEmptyString),
    label: NonEmptyString,
    status: AuthProbeStatusSchema,
    latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Provider-level live probe rollup plus per-credential results. */
export const ModelsProbeResultSchema = Type.Object(
  {
    provider: NonEmptyString,
    status: AuthProbeStatusSchema,
    latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.String()),
    results: Type.Array(ModelsProbeTargetResultSchema),
  },
  { additionalProperties: false },
);

/** Reads installed skill status, optionally for a selected agent. */
export const SkillsStatusParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Empty request payload for listing available skill bins. */
export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

/** Skill bin names available to the gateway. */
export const SkillsBinsResultSchema = Type.Object(
  {
    bins: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

const Sha256String = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-fA-F0-9]{64}$",
});
const SkillUploadIdempotencyKeyString = Type.String({
  minLength: 1,
  maxLength: 2048,
});
const SkillUploadDataBase64String = Type.String({
  minLength: 1,
  maxLength: 5_592_408,
});

/** Starts a chunked skill archive upload. */
export const SkillsUploadBeginParamsSchema = Type.Object(
  {
    kind: Type.Literal("skill-archive"),
    slug: NonEmptyString,
    sizeBytes: Type.Integer({ minimum: 1 }),
    sha256: Type.Optional(Sha256String),
    force: Type.Optional(Type.Boolean()),
    idempotencyKey: Type.Optional(SkillUploadIdempotencyKeyString),
  },
  { additionalProperties: false },
);

/** Uploads one base64-encoded chunk for a skill archive. */
export const SkillsUploadChunkParamsSchema = Type.Object(
  {
    uploadId: NonEmptyString,
    offset: Type.Integer({ minimum: 0 }),
    dataBase64: SkillUploadDataBase64String,
  },
  { additionalProperties: false },
);

/** Commits a completed skill archive upload. */
export const SkillsUploadCommitParamsSchema = Type.Object(
  {
    uploadId: NonEmptyString,
    sha256: Type.Optional(Sha256String),
  },
  { additionalProperties: false },
);

/** Installs a skill from legacy install id, ClawHub, or uploaded archive. */
export const SkillsInstallParamsSchema = Type.Union([
  Type.Object(
    {
      name: NonEmptyString,
      installId: NonEmptyString,
      dangerouslyForceUnsafeInstall: Type.Optional(
        Type.Boolean({
          deprecated: true,
          description:
            "Deprecated compatibility field. Current servers ignore it; install policy is controlled by security.installPolicy.",
        }),
      ),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("clawhub"),
      slug: NonEmptyString,
      version: Type.Optional(NonEmptyString),
      force: Type.Optional(Type.Boolean()),
      acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("upload"),
      uploadId: NonEmptyString,
      slug: NonEmptyString,
      force: Type.Optional(Type.Boolean()),
      sha256: Type.Optional(Sha256String),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    },
    { additionalProperties: false },
  ),
]);

/** Updates installed skill settings or refreshes ClawHub-installed skills. */
export const SkillsUpdateParamsSchema = Type.Union([
  Type.Object(
    {
      skillKey: NonEmptyString,
      enabled: Type.Optional(Type.Boolean()),
      apiKey: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("clawhub"),
      slug: Type.Optional(NonEmptyString),
      all: Type.Optional(Type.Boolean()),
      acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);

/** Searches the skill registry. */
export const SkillsSearchParamsSchema = Type.Object(
  {
    query: Type.Optional(NonEmptyString),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

/** Ranked skill registry search results. */
export const SkillsSearchResultSchema = Type.Object(
  {
    results: Type.Array(
      Type.Object(
        {
          score: Type.Number(),
          slug: NonEmptyString,
          displayName: NonEmptyString,
          summary: Type.Optional(Type.String()),
          version: Type.Optional(NonEmptyString),
          updatedAt: Type.Optional(Type.Integer()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Reads registry detail for one skill slug. */
export const SkillsDetailParamsSchema = Type.Object(
  {
    slug: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Reads current security verdicts for configured skills. */
export const SkillsSecurityVerdictsParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Skill registry detail, latest version, metadata, and owner info. */
export const SkillsDetailResultSchema = Type.Object(
  {
    skill: Type.Union([
      Type.Object(
        {
          slug: NonEmptyString,
          displayName: NonEmptyString,
          summary: Type.Optional(Type.String()),
          tags: Type.Optional(Type.Record(NonEmptyString, Type.String())),
          channel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          isOfficial: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
          createdAt: Type.Integer(),
          updatedAt: Type.Integer(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    latestVersion: Type.Optional(
      Type.Union([
        Type.Object(
          {
            version: NonEmptyString,
            createdAt: Type.Integer(),
            changelog: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    metadata: Type.Optional(
      Type.Union([
        Type.Object(
          {
            os: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
            systems: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    owner: Type.Optional(
      Type.Union([
        Type.Object(
          {
            handle: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
            displayName: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
            image: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            official: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
            channel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            isOfficial: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: false },
);

/** Security verdict report for installed/requested skills. */
export const SkillsSecurityVerdictsResultSchema = Type.Object(
  {
    schema: Type.Literal("openclaw.skills.security-verdicts.v1"),
    items: Type.Array(
      Type.Object(
        {
          registry: NonEmptyString,
          ok: Type.Boolean(),
          decision: NonEmptyString,
          reasons: Type.Array(Type.String()),
          requestedSlug: NonEmptyString,
          requestedVersion: NonEmptyString,
          slug: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
          version: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
          displayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          publisherHandle: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          publisherDisplayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          createdAt: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
          checkedAt: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
          skillUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          securityAuditUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          securityStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          securityPassed: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
          error: Type.Optional(
            Type.Object(
              {
                code: Type.Optional(Type.String()),
                message: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Reads the rendered skill card for one installed skill. */
export const SkillsSkillCardParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    skillKey: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Rendered skill card content and file metadata. */
export const SkillsSkillCardResultSchema = Type.Object(
  {
    schema: Type.Literal("openclaw.skills.skill-card.v1"),
    skillKey: NonEmptyString,
    path: NonEmptyString,
    sizeBytes: Type.Integer({ minimum: 0 }),
    content: Type.String(),
  },
  { additionalProperties: false },
);

/** Reads the configured tool catalog for an agent. */
export const ToolsCatalogParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    includePlugins: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Reads the effective tool set for one session. */
export const ToolsEffectiveParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Invokes one tool through the gateway tool dispatcher. */
export const ToolsInvokeParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    sessionKey: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    confirm: Type.Optional(Type.Boolean()),
    idempotencyKey: Type.Optional(NonEmptyString),
    /**
     * Explicit operation-local marker for an authenticated direct operator.
     * Missing values remain delegated, and agent runtime identity wins server-side.
     */
    conversationReadOrigin: Type.Optional(Type.Literal("direct-operator")),
  },
  { additionalProperties: false },
);

/** Tool profile shown in catalog views. */
export const ToolCatalogProfileSchema = Type.Object(
  {
    id: Type.Union([
      Type.Literal("minimal"),
      Type.Literal("coding"),
      Type.Literal("messaging"),
      Type.Literal("full"),
    ]),
    label: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Tool catalog entry before session-specific filtering is applied. */
export const ToolCatalogEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    description: Type.String(),
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
    pluginId: Type.Optional(NonEmptyString),
    optional: Type.Optional(Type.Boolean()),
    risk: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
    tags: Type.Optional(Type.Array(NonEmptyString)),
    defaultProfiles: Type.Array(
      Type.Union([
        Type.Literal("minimal"),
        Type.Literal("coding"),
        Type.Literal("messaging"),
        Type.Literal("full"),
      ]),
    ),
  },
  { additionalProperties: false },
);

/** Group of related catalog tools from core or a plugin. */
export const ToolCatalogGroupSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
    pluginId: Type.Optional(NonEmptyString),
    tools: Type.Array(ToolCatalogEntrySchema),
  },
  { additionalProperties: false },
);

/** Tool catalog result for agent configuration UI. */
export const ToolsCatalogResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    profiles: Type.Array(ToolCatalogProfileSchema),
    groups: Type.Array(ToolCatalogGroupSchema),
  },
  { additionalProperties: false },
);

/** Effective tool entry after session/profile/channel/plugin filtering. */
export const ToolsEffectiveEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    description: Type.String(),
    rawDescription: Type.String(),
    source: Type.Union([
      Type.Literal("core"),
      Type.Literal("plugin"),
      Type.Literal("channel"),
      Type.Literal("mcp"),
    ]),
    pluginId: Type.Optional(NonEmptyString),
    channelId: Type.Optional(NonEmptyString),
    risk: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
    tags: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

/** Effective tool group shown to runtime/session callers. */
export const ToolsEffectiveGroupSchema = Type.Object(
  {
    id: Type.Union([
      Type.Literal("core"),
      Type.Literal("plugin"),
      Type.Literal("channel"),
      Type.Literal("mcp"),
    ]),
    label: NonEmptyString,
    source: Type.Union([
      Type.Literal("core"),
      Type.Literal("plugin"),
      Type.Literal("channel"),
      Type.Literal("mcp"),
    ]),
    tools: Type.Array(ToolsEffectiveEntrySchema),
  },
  { additionalProperties: false },
);

/** Notice explaining runtime filtering such as quarantined tool schemas. */
export const ToolsEffectiveNoticeSchema = Type.Object(
  {
    id: NonEmptyString,
    severity: Type.Union([Type.Literal("info"), Type.Literal("warning")]),
    message: Type.String(),
  },
  { additionalProperties: false },
);

/** Effective tool set for a session, including profile and filtering notices. */
export const ToolsEffectiveResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    profile: NonEmptyString,
    groups: Type.Array(ToolsEffectiveGroupSchema),
    notices: Type.Optional(Type.Array(ToolsEffectiveNoticeSchema)),
  },
  { additionalProperties: false },
);

/** Normalized error shape for tool invocation failures. */
export const ToolsInvokeErrorSchema = Type.Object(
  {
    code: NonEmptyString,
    message: NonEmptyString,
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

/** Tool invocation result, including approval handoff when required. */
export const ToolsInvokeResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    toolName: NonEmptyString,
    output: Type.Optional(Type.Unknown()),
    requiresApproval: Type.Optional(Type.Boolean()),
    approvalId: Type.Optional(NonEmptyString),
    source: Type.Optional(
      Type.Union([
        Type.Literal("core"),
        Type.Literal("plugin"),
        Type.Literal("mcp"),
        Type.Literal("channel"),
        Type.String(),
      ]),
    ),
    error: Type.Optional(ToolsInvokeErrorSchema),
  },
  { additionalProperties: false },
);

/** Compose a draft agent prompt (SOUL.md) from a brief description via the default model. */
export const AgentsComposePromptParamsSchema = Type.Object(
  {
    brief: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Result of composing an agent prompt. */
export const AgentsComposePromptResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    prompt: Type.String(),
  },
  { additionalProperties: false },
);

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type AgentKind = Static<typeof AgentKindSchema>;
export type AgentSummary = Static<typeof AgentSummarySchema>;
export type AgentsFileEntry = Static<typeof AgentsFileEntrySchema>;
export type AgentsCreateParams = Static<typeof AgentsCreateParamsSchema>;
export type AgentsCreateResult = Static<typeof AgentsCreateResultSchema>;
export type AgentsUpdateParams = Static<typeof AgentsUpdateParamsSchema>;
export type AgentsUpdateResult = Static<typeof AgentsUpdateResultSchema>;
export type AgentsDeleteParams = Static<typeof AgentsDeleteParamsSchema>;
export type AgentsDeleteResult = Static<typeof AgentsDeleteResultSchema>;
export type AgentsFilesListParams = Static<typeof AgentsFilesListParamsSchema>;
export type AgentsFilesListResult = Static<typeof AgentsFilesListResultSchema>;
export type AgentsFilesGetParams = Static<typeof AgentsFilesGetParamsSchema>;
export type AgentsFilesGetResult = Static<typeof AgentsFilesGetResultSchema>;
export type AgentsFilesSetParams = Static<typeof AgentsFilesSetParamsSchema>;
export type AgentsFilesSetResult = Static<typeof AgentsFilesSetResultSchema>;
export type AgentsListParams = Static<typeof AgentsListParamsSchema>;
export type AgentsListResult = Static<typeof AgentsListResultSchema>;
export type ModelChoice = Static<typeof ModelChoiceSchema>;
export type ModelsListParams = Static<typeof ModelsListParamsSchema>;
export type ModelsListResult = Static<typeof ModelsListResultSchema>;
export type ModelsAuthStatusParams = Static<typeof ModelsAuthStatusParamsSchema>;
export type ModelsAuthLogoutParams = Static<typeof ModelsAuthLogoutParamsSchema>;
export type AuthProbeStatus = Static<typeof AuthProbeStatusSchema>;
export type ModelsProbeParams = Static<typeof ModelsProbeParamsSchema>;
export type ModelsProbeTargetResult = Static<typeof ModelsProbeTargetResultSchema>;
export type ModelsProbeResult = Static<typeof ModelsProbeResultSchema>;
export type SkillsStatusParams = Static<typeof SkillsStatusParamsSchema>;
export type ToolsCatalogParams = Static<typeof ToolsCatalogParamsSchema>;
export type ToolCatalogProfile = Static<typeof ToolCatalogProfileSchema>;
export type ToolCatalogEntry = Static<typeof ToolCatalogEntrySchema>;
export type ToolCatalogGroup = Static<typeof ToolCatalogGroupSchema>;
export type ToolsCatalogResult = Static<typeof ToolsCatalogResultSchema>;
export type ToolsEffectiveParams = Static<typeof ToolsEffectiveParamsSchema>;
export type ToolsEffectiveEntry = Static<typeof ToolsEffectiveEntrySchema>;
export type ToolsEffectiveGroup = Static<typeof ToolsEffectiveGroupSchema>;
export type ToolsEffectiveNotice = Static<typeof ToolsEffectiveNoticeSchema>;
export type ToolsEffectiveResult = Static<typeof ToolsEffectiveResultSchema>;
export type ToolsInvokeParams = Static<typeof ToolsInvokeParamsSchema>;
export type ToolsInvokeResult = Static<typeof ToolsInvokeResultSchema>;
export type SkillsBinsParams = Static<typeof SkillsBinsParamsSchema>;
export type SkillsBinsResult = Static<typeof SkillsBinsResultSchema>;
export type SkillsSearchParams = Static<typeof SkillsSearchParamsSchema>;
export type SkillsSearchResult = Static<typeof SkillsSearchResultSchema>;
export type SkillsDetailParams = Static<typeof SkillsDetailParamsSchema>;
export type SkillsDetailResult = Static<typeof SkillsDetailResultSchema>;
export type SkillsSecurityVerdictsParams = Static<typeof SkillsSecurityVerdictsParamsSchema>;
export type SkillsSecurityVerdictsResult = Static<typeof SkillsSecurityVerdictsResultSchema>;
export type SkillsSkillCardParams = Static<typeof SkillsSkillCardParamsSchema>;
export type SkillsSkillCardResult = Static<typeof SkillsSkillCardResultSchema>;
export type SkillsUploadBeginParams = Static<typeof SkillsUploadBeginParamsSchema>;
export type SkillsUploadChunkParams = Static<typeof SkillsUploadChunkParamsSchema>;
export type SkillsUploadCommitParams = Static<typeof SkillsUploadCommitParamsSchema>;
export type SkillsInstallParams = Static<typeof SkillsInstallParamsSchema>;
export type SkillsUpdateParams = Static<typeof SkillsUpdateParamsSchema>;
