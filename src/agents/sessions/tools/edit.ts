/**
 * Built-in edit session tool.
 *
 * Applies exact targeted replacements with queued file mutation.
 */
import { constants } from "node:fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { repairJson } from "@openclaw/ai/internal/runtime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import { captureAgentToolSourceExecutionGuard } from "../../agent-tool-source-execution-guard.js";
import { normalizeToLF } from "../../line-endings.js";
import type { AgentTool } from "../../runtime/index.js";
import { textResult } from "../../tools/common.js";
import { decodeUtf8File } from "../../utf8-file.js";
import type { ToolDefinition } from "../extensions/types.js";
import {
  applyEditsPreservingLineEndings,
  EditNoChangeError,
  type Edit,
  generateDiffString,
  generateUnifiedPatch,
  splitNoOpEdits,
  stripBom,
  validateNoOpEditTargets,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveLocalPathToCwd, resolveToCwd } from "./path-utils.js";
import type { EditToolDetails, EditToolInput } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description: "Exact original text; unique and non-overlapping in this call.",
    }),
    newText: Type.String({
      description: "Replacement text.",
    }),
  },
  {},
);

const editSchema = Type.Object(
  {
    path: Type.String({
      description: "File path; relative/absolute.",
    }),
    edits: Type.Array(replaceEditSchema, {
      description:
        "Targeted replacements against original file; no overlap/nesting. Merge nearby changes.",
    }),
  },
  {},
);

const EditToolOutputSchema = Type.Union([
  Type.Object({ changed: Type.Literal(false) }, { additionalProperties: false }),
  Type.Object(
    {
      changed: Type.Literal(true),
      diff: Type.String(),
      patch: Type.String(),
      firstChangedLine: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
]);

const EDIT_MISMATCH_MESSAGE = "Could not find the exact text in";
const EDIT_MISMATCH_HINT_LIMIT = 800;

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
  /** Resolve the physical identity used to order this backend's file operations. */
  resolveQueueKey?: (absolutePath: string, signal?: AbortSignal) => string | Promise<string>;
  /** Read file contents as a Buffer */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Write content to a file */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Check if file is readable and writable (throw if not) */
  access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
  /** Custom operations for file editing. Default: local filesystem */
  operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
  if (!input || typeof input !== "object") {
    return input as EditToolInput;
  }

  const args = { ...(input as Record<string, unknown>) };

  // Serialized replacements contain literal file text, so valid JSON escapes must
  // survive rather than being reinterpreted by the repair owner's path heuristic.
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(repairJson(args.edits, { preserveValidControlEscapes: true }));
      if (Array.isArray(parsed)) {
        args.edits = parsed;
      }
    } catch {}
  }

  let edits = Array.isArray(args.edits)
    ? args.edits.map((edit) => {
        if (!isRecord(edit)) {
          return edit;
        }
        return { oldText: edit.oldText, newText: edit.newText };
      })
    : args.edits;

  const { oldText, newText } = args;
  if (typeof oldText === "string" && typeof newText === "string") {
    const batch = Array.isArray(edits) ? edits : [];
    if (
      !batch.some(
        (edit: unknown) => isRecord(edit) && edit.oldText === oldText && edit.newText === newText,
      )
    ) {
      batch.push({ oldText, newText });
    }
    edits = batch;
  }

  // Keep the strict provider schema while tolerating model-added metadata.
  return { path: args.path, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): {
  path: string;
  edits: Edit[];
} {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits: input.edits };
}

function removeExactOccurrences(content: string, needle: string): string {
  return needle.length > 0 ? content.split(needle).join("") : content;
}

function didEditLikelyApply(params: {
  originalContent: string;
  currentContent: string;
  edits: Edit[];
}): boolean {
  if (params.edits.length === 0) {
    return false;
  }
  const normalizedOriginal = normalizeToLF(params.originalContent);
  const normalizedCurrent = normalizeToLF(params.currentContent);
  if (normalizedOriginal === normalizedCurrent) {
    return false;
  }

  let withoutInsertedNewText = normalizedCurrent;
  for (const edit of params.edits) {
    const normalizedNew = normalizeToLF(edit.newText);
    if (normalizedNew.length > 0 && !normalizedCurrent.includes(normalizedNew)) {
      return false;
    }
    withoutInsertedNewText = removeExactOccurrences(withoutInsertedNewText, normalizedNew);
  }

  return params.edits.every(
    (edit) => !withoutInsertedNewText.includes(normalizeToLF(edit.oldText)),
  );
}

function appendMismatchHint(error: Error, currentContent: string): Error {
  const snippet =
    currentContent.length <= EDIT_MISMATCH_HINT_LIMIT
      ? currentContent
      : `${truncateUtf16Safe(currentContent, EDIT_MISMATCH_HINT_LIMIT)}\n... (truncated)`;
  const enhanced = new Error(`${error.message}\nCurrent file contents:\n${snippet}`, {
    cause: error,
  });
  enhanced.stack = error.stack;
  return enhanced;
}

export function createEditToolDefinition(
  cwd: string,
  options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails> {
  const ops = options?.operations ?? defaultEditOperations;
  const resolvePath = options?.operations ? resolveToCwd : resolveLocalPathToCwd;
  return {
    name: "edit",
    label: "edit",
    description:
      "Exact single-file replacements. oldText unique/non-overlapping against original. Merge nearby changes; omit large unchanged spans.",
    promptSnippet: "Exact file edits; multiple disjoint edits per call",
    promptGuidelines: [
      "oldText must match exactly",
      "Multiple disjoint locations: one call, multiple edits[]",
      "Match original file; no overlap/nesting; merge nearby",
      "oldText minimal but unique; no padding",
    ],
    parameters: editSchema,
    outputSchema: EditToolOutputSchema,
    prepareArguments: prepareEditArguments,
    async execute(toolCallId, input: EditToolInput, signal?: AbortSignal, onUpdate?, ctx?) {
      void toolCallId;
      void onUpdate;
      void ctx;
      const assertCurrent = captureAgentToolSourceExecutionGuard();
      const { path, edits: originalEdits } = validateEditInput(input);
      const absolutePath = resolvePath(path, cwd);

      return withFileMutationQueue(
        absolutePath,
        async () => {
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }
          assertCurrent();

          let realEdits: Edit[] = [];

          try {
            await ops.access(absolutePath);
          } catch (error: unknown) {
            const errorMessage =
              error instanceof Error && "code" in error
                ? `Error code: ${String(error.code)}`
                : String(error);
            throw new Error(`Could not edit file: ${path}. ${errorMessage}.`, {
              cause: error,
            });
          }

          const buffer = await ops.readFile(absolutePath);
          const rawContent = decodeUtf8File(buffer, absolutePath);
          try {
            if (signal?.aborted) {
              throw new Error("Operation aborted");
            }
            assertCurrent();

            const { bom, text: content } = stripBom(rawContent);
            const normalizedContent = normalizeToLF(content);
            const editSets = splitNoOpEdits(normalizedContent, originalEdits, path);
            const noOpEdits = editSets.noOpEdits;
            realEdits = editSets.realEdits;
            validateNoOpEditTargets(normalizedContent, noOpEdits, realEdits, path);
            if (realEdits.length === 0) {
              return textResult(
                `No changes made to ${path}. The replacement text is identical to the original.`,
                { changed: false } satisfies EditToolDetails,
              );
            }
            const { baseContent, newContent, finalContent } = applyEditsPreservingLineEndings(
              content,
              realEdits,
              path,
            );
            await ops.writeFile(absolutePath, bom + finalContent);
            if (signal?.aborted) {
              throw new Error("Operation aborted");
            }
            assertCurrent();

            assertCurrent();
            const diffResult = generateDiffString(baseContent, newContent);
            const patch = generateUnifiedPatch(path, baseContent, newContent);
            return {
              content: [
                {
                  type: "text",
                  text: `Successfully replaced ${realEdits.length} block(s) in ${path}.`,
                },
              ],
              details: {
                changed: true,
                diff: diffResult.diff,
                patch,
                ...(diffResult.firstChangedLine === undefined
                  ? {}
                  : { firstChangedLine: diffResult.firstChangedLine }),
              },
            };
          } catch (error: unknown) {
            assertCurrent();
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            const currentContent = await ops
              .readFile(absolutePath)
              .then((current) => current.toString("utf-8"))
              .catch(() => rawContent);
            if (
              didEditLikelyApply({
                originalContent: rawContent,
                currentContent,
                edits: realEdits,
              })
            ) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Successfully replaced ${realEdits.length} block(s) in ${path}.`,
                  },
                ],
                details: { changed: true, diff: "", patch: "" },
              };
            }
            if (normalizedError.message.includes(EDIT_MISMATCH_MESSAGE)) {
              throw appendMismatchHint(normalizedError, currentContent);
            }
            // No-op: the edit matched but produced identical content. Not
            // terminal — the model may still be mid-task and needs a continuation.
            if (normalizedError instanceof EditNoChangeError) {
              return textResult(
                `No changes made to ${path}. The replacement produced identical content.`,
                { changed: false } satisfies EditToolDetails,
              );
            }
            throw normalizedError;
          }
        },
        { toolName: "edit", resolveQueueKey: ops.resolveQueueKey, signal },
      );
    },
  };
}

export function createEditTool(
  cwd: string,
  options?: EditToolOptions,
): AgentTool<typeof editSchema> {
  return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
