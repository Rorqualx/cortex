// Gateway methods for the egress secret vault: list, save, delete.
//
// Save accepts the secret material once (UI -> gateway) and encrypts it in the
// store immediately. List returns metadata only — values never leave the host.
import {
  ErrorCodes,
  errorShape,
  validateVaultDeleteParams,
  validateVaultSaveParams,
  type VaultSaveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { registerDynamicSecret } from "../../logging/redact.js";
import {
  deleteVaultSecret,
  listVaultSecrets,
  saveVaultSecret,
  type VaultLoginConfig,
  type VaultSecretInput,
} from "../../secrets/vault/store.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Register every secret field so an incidental later log line is scrubbed. */
function registerSaveSecrets(params: VaultSaveParams): void {
  switch (params.authKind) {
    case "bearer":
      registerDynamicSecret(params.token);
      return;
    case "basic":
    case "login":
      registerDynamicSecret(params.password);
      return;
    case "header":
      for (const header of params.headers) {
        registerDynamicSecret(header.value);
      }
  }
}

/** Map the validated protocol params to the store's input union. */
function toVaultSecretInput(params: VaultSaveParams): VaultSecretInput {
  const common = {
    name: params.name,
    hostAllowlist: params.hostAllowlist,
    ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
    ...(params.description ? { description: params.description } : {}),
  };
  switch (params.authKind) {
    case "bearer":
      return { ...common, authKind: "bearer", token: params.token };
    case "basic":
      return { ...common, authKind: "basic", username: params.username, password: params.password };
    case "header":
      return { ...common, authKind: "header", headers: params.headers };
    case "login":
      return {
        ...common,
        authKind: "login",
        username: params.username,
        password: params.password,
        login: params.login as VaultLoginConfig,
      };
    default: {
      const exhaustive: never = params;
      return exhaustive;
    }
  }
}

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
    registerSaveSecrets(params);
    saveVaultSecret(toVaultSecretInput(params));
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
