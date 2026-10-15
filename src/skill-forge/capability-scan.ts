import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Deterministic capability vector for skill bundles (openclaw-analysis-2026-10-15,
 * QW2 / finding 12).
 *
 * `staticSecurityScan()` (gate.ts) looks for *malicious* patterns;
 * `security-judge.ts` adds an LLM judge for semantic attacks. This module is
 * the third, orthogonal layer: a cheap, fully deterministic inventory of
 * which capability *classes* a skill's bundle references — shell execution,
 * filesystem read/write, network egress, credential access — recorded as a
 * sidecar next to the judge verdict. Per the analysis it ships
 * DISPLAY-ONLY: the vector is recorded and surfaced, never used to block
 * promotion. Later enforcement (deny undeclared capabilities via
 * tool-policy / exec-policy) is a separate flagged stage.
 *
 * Detection is literal-substring only (`String.includes`) — no regexes, no
 * nested quantifiers, linear in input size by construction (see the RW-3
 * catastrophic-backtracking lesson). Markers name *actions* (curl, wget,
 * fetch()…) rather than bare URLs so docs that merely link a page don't
 * light up network-egress; a skill that only mentions a tool in prose can
 * still fire, which is acceptable for an informational vector.
 */

export type SkillCapabilityClass =
  | "shell-exec"
  | "fs-read"
  | "fs-write"
  | "network-egress"
  | "credential-access";

export const SKILL_CAPABILITY_CLASSES: readonly SkillCapabilityClass[] = [
  "shell-exec",
  "fs-read",
  "fs-write",
  "network-egress",
  "credential-access",
] as const;

/** Literal substring markers per capability class (NO regex — see header). */
export const CAPABILITY_MARKERS: Readonly<Record<SkillCapabilityClass, readonly string[]>> = {
  "shell-exec": [
    "child_process",
    "execSync",
    "spawnSync",
    "os.system",
    "popen(",
    "system(",
    "exec(",
    "spawn(",
    "bash -c",
    "sh -c",
  ],
  "fs-read": ["readFile", "readFileSync", "os.listdir", "open(", "cat ", "grep "],
  "fs-write": [
    "writeFile",
    "writeFileSync",
    "unlink",
    "mkdir ",
    "rmdir",
    "rm ",
    "os.remove",
    "touch ",
    "tee ",
  ],
  "network-egress": [
    "curl",
    "wget",
    "fetch(",
    "requests.get",
    "requests.post",
    "netcat",
    "nc ",
    "ssh ",
    "scp ",
    "sftp ",
  ],
  "credential-access": [
    "process.env",
    "os.environ",
    "~/.ssh",
    "id_rsa",
    ".env",
    "keychain",
    "api_key",
    "apiKey",
    "API_KEY",
    "~/.aws",
    "aws_secret",
    ".netrc",
  ],
};

/** Matched markers per class; empty array = class not referenced. */
export type CapabilityVector = Record<SkillCapabilityClass, string[]>;

export type CapabilityScanResult = {
  at: string;
  /** Number of text files scanned (bounded by caps). */
  filesScanned: number;
  /** True when the file/size caps truncated the walk — vector may be partial. */
  truncated: boolean;
  /** Deterministic scan — informational only; enforcement is a later stage. */
  mode: "advisory";
  capabilities: CapabilityVector;
};

/** Text extensions scanned; everything else (binaries, images) is skipped. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".txt",
  ".sh",
  ".bash",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
]);

export type CapabilityScanCaps = {
  /** Max files scanned before the walk stops and `truncated` is set. */
  maxFiles: number;
  /** Max bytes read per file; larger files set `truncated`. */
  maxFileBytes: number;
};

export const DEFAULT_CAPABILITY_SCAN_CAPS: CapabilityScanCaps = {
  maxFiles: 200,
  maxFileBytes: 256 * 1024,
};

/** Scan one text blob. Pure, linear, allocation-bounded by marker count. */
export function scanTextForCapabilities(text: string): CapabilityVector {
  const vector = {} as CapabilityVector;
  for (const cls of SKILL_CAPABILITY_CLASSES) {
    const hits: string[] = [];
    for (const marker of CAPABILITY_MARKERS[cls]) {
      if (text.includes(marker)) {
        hits.push(marker);
      }
    }
    vector[cls] = hits;
  }
  return vector;
}

function mergeVectors(into: CapabilityVector, from: CapabilityVector): void {
  for (const cls of SKILL_CAPABILITY_CLASSES) {
    const merged = new Set(into[cls]);
    for (const marker of from[cls]) {
      merged.add(marker);
    }
    into[cls] = [...merged].sort();
  }
}

/**
 * Walk a skill bundle and scan its text files. Never throws for expected
 * problems: an unreadable directory returns a zero-file result with
 * `truncated: true` so the caller can record the gap instead of failing.
 */
export async function scanSkillBundle(
  skillDir: string,
  caps: CapabilityScanCaps = DEFAULT_CAPABILITY_SCAN_CAPS,
): Promise<CapabilityScanResult> {
  const vector = {} as CapabilityVector;
  for (const cls of SKILL_CAPABILITY_CLASSES) {
    vector[cls] = [];
  }
  let filesScanned = 0;
  let truncated = false;
  const queue: string[] = [skillDir];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) {
      break;
    }
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      truncated = true;
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name))) {
        continue;
      }
      if (filesScanned >= caps.maxFiles) {
        truncated = true;
        break;
      }
      filesScanned += 1;
      let text: string;
      try {
        const handle = await fsp.open(fullPath, "r");
        try {
          const buffer = Buffer.alloc(caps.maxFileBytes);
          const { bytesRead } = await handle.read(buffer, 0, caps.maxFileBytes, 0);
          const stat = await handle.stat();
          if (stat.size > caps.maxFileBytes) {
            truncated = true;
          }
          text = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          await handle.close();
        }
      } catch {
        truncated = true;
        continue;
      }
      mergeVectors(vector, scanTextForCapabilities(text));
    }
    if (filesScanned >= caps.maxFiles) {
      break;
    }
  }
  return {
    at: new Date().toISOString(),
    filesScanned,
    truncated,
    mode: "advisory",
    capabilities: vector,
  };
}

/** Sidecar filename for the recorded vector (inside the promoted skill dir). */
export const CAPABILITY_SCAN_SIDECAR = "_capability-scan.json";

/** Persist the scan next to the promoted skill (best-effort, never throws). */
export async function writeCapabilityScanSidecar(
  promotedDir: string,
  result: CapabilityScanResult,
): Promise<void> {
  await fsp
    .writeFile(path.join(promotedDir, CAPABILITY_SCAN_SIDECAR), JSON.stringify(result, null, 2))
    .catch(() => {
      // Advisory record only — a failed write must never break promotion.
    });
}
