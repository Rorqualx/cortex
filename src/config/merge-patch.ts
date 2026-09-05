// Creates and applies JSON merge-patch updates to config-like objects.
// Import the guard from its defining package, not the src/utils.js barrel: the
// Control UI imports this module, and the barrel pulls src/infra/home-dir.js,
// which throws at module-eval in a browser (no HOME/OPENCLAW_HOME) and aborts
// the app bundle before openclaw-app registers.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isPlainObject } from "../infra/plain-object.js";
import { formatConfigPatchPath, isMergePatchObjectKeyAllowed } from "./patch-replace-paths.js";

type PlainObject = Record<string, unknown>;

type MergePatchOptions = {
  mergeObjectArraysById?: boolean;
  replaceArrayPaths?: ReadonlySet<string>;
  path?: string;
};

function cloneUnknown<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Structural equality for config values.
 *
 * Replaces `node:util`'s `isDeepStrictEqual`: the Control UI imports this
 * module, and Vite externalizes node builtins for the browser, so touching that
 * binding throws at import time and takes the whole dashboard down with it.
 *
 * Config values are JSON-shaped (primitives, arrays, plain objects, null), so a
 * structural walk suffices — but it keeps the semantics createMergePatch relies
 * on: NaN equals NaN, 0 and -0 differ, arrays compare by order and length, and
 * objects compare by exact key set. Non-JSON values (Date, Map, class
 * instances) never reach config, and would compare unequal here.
 */
function isDeepEqualConfigValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => isDeepEqualConfigValue(item, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) {
    return false;
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  return aKeys.every((key) => Object.hasOwn(b, key) && isDeepEqualConfigValue(a[key], b[key]));
}

/** Builds an RFC-7396-style merge patch between source and target config values. */
export function createMergePatch(base: unknown, target: unknown): unknown {
  if (!isRecord(base) || !isRecord(target)) {
    return cloneUnknown(target);
  }

  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const key of keys) {
    const hasBase = Object.hasOwn(base, key);
    const hasTarget = Object.hasOwn(target, key);
    if (!hasTarget) {
      patch[key] = null;
      continue;
    }
    const targetValue = target[key];
    if (!hasBase) {
      patch[key] = cloneUnknown(targetValue);
      continue;
    }
    const baseValue = base[key];
    if (isRecord(baseValue) && isRecord(targetValue)) {
      const childPatch = createMergePatch(baseValue, targetValue);
      if (isRecord(childPatch) && Object.keys(childPatch).length === 0) {
        continue;
      }
      patch[key] = childPatch;
      continue;
    }
    if (!isDeepEqualConfigValue(baseValue, targetValue)) {
      patch[key] = cloneUnknown(targetValue);
    }
  }
  return patch;
}

function isObjectWithStringId(value: unknown): value is Record<string, unknown> & { id: string } {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.id === "string" && value.id.length > 0;
}

function formatMergePatchArrayEntryPath(arrayPath: string): string {
  return `${arrayPath}[]`;
}

/**
 * Merge arrays of object-like entries keyed by `id`.
 *
 * Contract:
 * - Base array must be fully id-keyed; otherwise return undefined (caller should replace).
 * - Patch entries with valid id merge by id (or append when the id is new).
 * - Patch entries without valid id append as-is, avoiding destructive full-array replacement.
 */
function mergeObjectArraysById(
  base: unknown[],
  patch: unknown[],
  options: MergePatchOptions,
  arrayPath: string,
): unknown[] | undefined {
  if (!base.every(isObjectWithStringId)) {
    return undefined;
  }

  const merged: unknown[] = [...base];
  const indexById = new Map<string, number>();
  for (const [index, entry] of merged.entries()) {
    if (!isObjectWithStringId(entry)) {
      return undefined;
    }
    indexById.set(entry.id, index);
  }

  for (const patchEntry of patch) {
    if (!isObjectWithStringId(patchEntry)) {
      merged.push(structuredClone(patchEntry));
      continue;
    }

    const existingIndex = indexById.get(patchEntry.id);
    if (existingIndex === undefined) {
      merged.push(structuredClone(patchEntry));
      indexById.set(patchEntry.id, merged.length - 1);
      continue;
    }

    merged[existingIndex] = applyMergePatch(merged[existingIndex], patchEntry, {
      ...options,
      path: formatMergePatchArrayEntryPath(arrayPath),
    });
  }

  return merged;
}

/**
 * Applies an RFC 7396-style object merge patch with OpenClaw config safeguards.
 *
 * Non-object patches replace the base, `null` deletes keys, blocked prototype
 * keys are ignored outside schema-owned record-key paths, and id-keyed arrays
 * may merge when the caller opts in.
 */
export function applyMergePatch(
  base: unknown,
  patch: unknown,
  options: MergePatchOptions = {},
): unknown {
  if (!isPlainObject(patch)) {
    return patch;
  }

  const result: PlainObject = isPlainObject(base) ? { ...base } : {};

  for (const [key, value] of Object.entries(patch)) {
    const path = formatConfigPatchPath(options.path, key);
    if (!isMergePatchObjectKeyAllowed(key, options.path)) {
      continue;
    }
    if (value === null) {
      delete result[key];
      continue;
    }
    if (options.mergeObjectArraysById && Array.isArray(result[key]) && Array.isArray(value)) {
      if (options.replaceArrayPaths?.has(path)) {
        result[key] = value;
        continue;
      }
      // Config arrays like agents/plugins can patch by id; non-id arrays keep RFC replacement.
      const mergedArray = mergeObjectArraysById(result[key] as unknown[], value, options, path);
      if (mergedArray) {
        result[key] = mergedArray;
        continue;
      }
    }
    if (isPlainObject(value)) {
      const baseValue = result[key];
      result[key] = applyMergePatch(isPlainObject(baseValue) ? baseValue : {}, value, {
        ...options,
        path,
      });
      continue;
    }
    result[key] = value;
  }

  return result;
}
