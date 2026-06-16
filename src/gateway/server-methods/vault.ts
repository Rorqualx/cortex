// Gateway methods for the egress secret vault: list, save, delete.
//
// Save accepts the plaintext value once (UI -> gateway) and encrypts it in the
// store immediately. List returns metadata only — values never leave the host.
import {
  ErrorCodes,
  errorShape,
  validateVaultDeleteParams,
  validateVaultSaveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { registerDynamicSecret } from "../../logging/redact.js";
import { deleteVaultSecret, listVaultSecrets, saveVaultSecret } from "../../secrets/vault/store.js";
import type { GatewayRequestHandlers } from "./types.js";

export const vaultHandlers: GatewayRequestHandlers = {
  "vault.list": async ({ respond }) => {
    respond(true, { entries: listVaultSecrets() });
  },
  "vault.save": async ({ params, respond }) => {
    if (!validateVaultSaveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid vault.save params"),
      );
      return;
    }
    // The plaintext only transits this handler; register it so any later log
    // line that incidentally captures it is scrubbed before it is written.
    registerDynamicSecret(params.value);
    saveVaultSecret({
      name: params.name,
      value: params.value,
      hostAllowlist: params.hostAllowlist,
      ...(params.headerTemplate ? { headerTemplate: params.headerTemplate } : {}),
      ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
      ...(params.credentialType ? { credentialType: params.credentialType } : {}),
      ...(params.description ? { description: params.description } : {}),
    });
    respond(true, { ok: true });
  },
  "vault.delete": async ({ params, respond }) => {
    if (!validateVaultDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid vault.delete params"),
      );
      return;
    }
    deleteVaultSecret(params.name);
    respond(true, { ok: true });
  },
};
