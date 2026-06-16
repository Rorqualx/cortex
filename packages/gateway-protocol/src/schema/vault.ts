// Gateway Protocol schema for the egress secret vault.
//
// The plaintext `value` crosses this boundary only on save (UI -> gateway over
// the secure-context channel); it is encrypted immediately server-side and is
// never returned by list. List/delete results stay metadata-only.
import { type Static, Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/** Whether the runtime injects silently ('auto') or prompts per host ('ask'). */
export const VaultApprovalPolicySchema = Type.Union([Type.Literal("auto"), Type.Literal("ask")]);

/** Vault entry metadata. Never carries the plaintext value. */
export const VaultSecretEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    hostAllowlist: Type.Array(NonEmptyString),
    headerTemplate: Type.String(),
    approvalPolicy: VaultApprovalPolicySchema,
    credentialType: Type.Optional(Type.String()),
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

/** Create or replace a saved credential. `value` is the plaintext to encrypt. */
export const VaultSaveParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    value: NonEmptyString,
    hostAllowlist: Type.Array(NonEmptyString, { minItems: 1 }),
    headerTemplate: Type.Optional(Type.String()),
    approvalPolicy: Type.Optional(VaultApprovalPolicySchema),
    credentialType: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

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
export type VaultSecretEntry = Static<typeof VaultSecretEntrySchema>;
export type VaultListParams = Static<typeof VaultListParamsSchema>;
export type VaultListResult = Static<typeof VaultListResultSchema>;
export type VaultSaveParams = Static<typeof VaultSaveParamsSchema>;
export type VaultDeleteParams = Static<typeof VaultDeleteParamsSchema>;
export type VaultMutationResult = Static<typeof VaultMutationResultSchema>;
