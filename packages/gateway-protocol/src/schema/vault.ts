// Gateway Protocol schema for the egress secret vault.
//
// Secret material (token / username+password / header values) crosses this
// boundary only on save (UI -> gateway over the secure-context channel); it is
// encrypted immediately server-side and is never returned by list. List/delete
// results stay metadata-only (auth kind + non-secret config, never values).
import { type Static, Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/** Whether the runtime injects silently ('auto') or prompts per host ('ask'). */
export const VaultApprovalPolicySchema = Type.Union([Type.Literal("auto"), Type.Literal("ask")]);

/** Closed discriminator for how a saved credential authenticates a request. */
export const VaultAuthKindSchema = Type.Union([
  Type.Literal("bearer"),
  Type.Literal("basic"),
  Type.Literal("header"),
  Type.Literal("login"),
  Type.Literal("ssh"),
]);

/** Where the login response carries the session token (non-secret). */
const VaultLoginExtractSchema = Type.Union([
  Type.Object(
    { from: Type.Literal("set-cookie"), cookieName: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    { from: Type.Literal("header"), header: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    { from: Type.Literal("json"), path: NonEmptyString },
    { additionalProperties: false },
  ),
]);

/** How the captured token is replayed on subsequent requests (non-secret). */
const VaultLoginPlaceSchema = Type.Union([
  Type.Object(
    { as: Type.Literal("cookie"), cookieName: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    { as: Type.Literal("header"), template: NonEmptyString },
    { additionalProperties: false },
  ),
]);

/** Non-secret config for the stateful 'login' kind. Credentials live elsewhere. */
export const VaultLoginConfigSchema = Type.Object(
  {
    loginUrl: NonEmptyString,
    method: Type.Optional(Type.Union([Type.Literal("POST"), Type.Literal("GET")])),
    bodyTemplate: Type.String(),
    contentType: Type.Optional(Type.String()),
    extraHeaders: Type.Optional(Type.Record(Type.String(), Type.String())),
    extract: VaultLoginExtractSchema,
    place: VaultLoginPlaceSchema,
    ttlSeconds: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** Value-free config describing how an entry authenticates (returned by list). */
export const VaultAuthConfigSchema = Type.Union([
  Type.Object({ kind: Type.Literal("bearer") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("basic") }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("header"), headers: Type.Array(Type.String()) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("login"), login: VaultLoginConfigSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("ssh"),
      port: Type.Optional(Type.Number()),
      username: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

/** Vault entry metadata. Never carries secret material. */
export const VaultSecretEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    hostAllowlist: Type.Array(NonEmptyString),
    approvalPolicy: VaultApprovalPolicySchema,
    authKind: VaultAuthKindSchema,
    authConfig: VaultAuthConfigSchema,
    description: Type.Optional(Type.String()),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
);

/** Request to list saved vault entries (metadata only). */
export const VaultListParamsSchema = Type.Object({}, { additionalProperties: false });

/** Vault list result. */
export const VaultListResultSchema = Type.Object(
  {
    entries: Type.Array(VaultSecretEntrySchema),
  },
  { additionalProperties: false },
);

const vaultSaveCommon = {
  name: NonEmptyString,
  hostAllowlist: Type.Array(NonEmptyString, { minItems: 1 }),
  approvalPolicy: Type.Optional(VaultApprovalPolicySchema),
  description: Type.Optional(Type.String()),
};

/** Create or replace a saved credential. Secret fields are encrypted server-side. */
export const VaultSaveParamsSchema = Type.Union([
  Type.Object(
    { ...vaultSaveCommon, authKind: Type.Literal("bearer"), token: NonEmptyString },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...vaultSaveCommon,
      authKind: Type.Literal("basic"),
      username: NonEmptyString,
      password: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...vaultSaveCommon,
      authKind: Type.Literal("header"),
      headers: Type.Array(
        Type.Object(
          { name: NonEmptyString, value: NonEmptyString },
          { additionalProperties: false },
        ),
        { minItems: 1 },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...vaultSaveCommon,
      authKind: Type.Literal("login"),
      username: NonEmptyString,
      password: NonEmptyString,
      login: VaultLoginConfigSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...vaultSaveCommon,
      authKind: Type.Literal("ssh"),
      username: Type.Optional(Type.String()),
      password: Type.Optional(Type.String()),
      privateKey: Type.Optional(Type.String()),
      passphrase: Type.Optional(Type.String()),
      port: Type.Optional(Type.Number()),
    },
    { additionalProperties: false },
  ),
]);

/** Delete a saved credential by name. */
export const VaultDeleteParamsSchema = Type.Object(
  {
    name: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Generic mutation acknowledgement. */
export const VaultMutationResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type VaultApprovalPolicy = Static<typeof VaultApprovalPolicySchema>;
export type VaultAuthKind = Static<typeof VaultAuthKindSchema>;
export type VaultLoginConfig = Static<typeof VaultLoginConfigSchema>;
export type VaultAuthConfig = Static<typeof VaultAuthConfigSchema>;
export type VaultSecretEntry = Static<typeof VaultSecretEntrySchema>;
export type VaultListParams = Static<typeof VaultListParamsSchema>;
export type VaultListResult = Static<typeof VaultListResultSchema>;
export type VaultSaveParams = Static<typeof VaultSaveParamsSchema>;
export type VaultDeleteParams = Static<typeof VaultDeleteParamsSchema>;
export type VaultMutationResult = Static<typeof VaultMutationResultSchema>;
