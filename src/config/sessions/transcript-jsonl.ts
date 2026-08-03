// JSONL artifact helpers retain only the production batch serializer.
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";

type WriteJsonlFileOptions = {
  encoding?: BufferEncoding;
  flag?: string;
  mode?: number;
};

export function serializeJsonlLines(lines: readonly string[]): string {
  // Transcript readers expect every persisted entry batch to end with a newline.
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export async function writeJsonlLines(
  filePath: string,
  lines: readonly string[],
  options?: WriteJsonlFileOptions,
): Promise<string> {
  const content = serializeJsonlLines(lines);
  await fs.writeFile(filePath, content, {
    encoding: options?.encoding ?? "utf-8",
    ...(options?.flag ? { flag: options.flag } : {}),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
  return content;
}

// Fork-owned: chat branching still appends single entries to a named JSONL
// artifact, which upstream's SQLite-only transcript path no longer covers.
export function appendJsonlEntrySync(
  filePath: string,
  entry: unknown,
  options?: { prefixNewline?: boolean },
): string {
  const serialized = JSON.stringify(entry);
  // JSON.stringify returns undefined for a root undefined/function/symbol. The
  // template literal below would write the literal string "undefined", which
  // readers silently skip — a fail-silent loss of a transcript entry.
  if (serialized === undefined) {
    throw new TypeError(
      `appendJsonlEntrySync: entry of type ${typeof entry} is not JSON-serializable (JSON.stringify returned undefined)`,
    );
  }
  const serializedEntry = `${serialized}\n`;
  const content = options?.prefixNewline ? `\n${serializedEntry}` : serializedEntry;
  appendFileSync(filePath, content, "utf-8");
  return content;
}
