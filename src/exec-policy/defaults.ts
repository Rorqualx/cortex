import { indexRules } from "./parser.js";
import type { PrefixRule, BannedPrefix, ExecPolicy } from "./types.js";

/**
 * Default prefix rules. Safe commands are allowed, dangerous ones are forbidden,
 * everything else prompts for approval.
 */
const DEFAULT_RULES: PrefixRule[] = [
  // === Git (read-only) === allow
  { pattern: [["git"], ["status"]], decision: "allow", justification: "Safe read-only git query" },
  { pattern: [["git"], ["diff"]], decision: "allow", justification: "Safe read-only diff" },
  { pattern: [["git"], ["log"]], decision: "allow", justification: "Safe read-only log" },
  { pattern: [["git"], ["show"]], decision: "allow", justification: "Safe read-only show" },
  {
    pattern: [["git"], ["branch", "-l", "--list"]],
    decision: "allow",
    justification: "Safe branch listing",
  },
  { pattern: [["git"], ["remote", "-v"]], decision: "allow", justification: "Safe remote listing" },
  { pattern: [["git"], ["stash", "list"]], decision: "allow", justification: "Safe stash listing" },
  { pattern: [["git"], ["tag", "-l"]], decision: "allow", justification: "Safe tag listing" },

  // === Git (write) === prompt (user decides)
  {
    pattern: [["git"], ["add"]],
    decision: "prompt",
    justification: "Git staging area modification",
  },
  { pattern: [["git"], ["commit"]], decision: "prompt", justification: "Git commit creation" },
  { pattern: [["git"], ["push"]], decision: "prompt", justification: "Git remote push" },
  { pattern: [["git"], ["pull"]], decision: "prompt", justification: "Git remote pull" },
  { pattern: [["git"], ["merge"]], decision: "prompt", justification: "Git merge" },
  { pattern: [["git"], ["rebase"]], decision: "prompt", justification: "Git rebase" },
  {
    pattern: [["git"], ["reset"]],
    decision: "prompt",
    justification: "Git reset — potentially destructive",
  },
  { pattern: [["git"], ["checkout"]], decision: "prompt", justification: "Git checkout" },
  { pattern: [["git"], ["switch"]], decision: "prompt", justification: "Git branch switch" },
  { pattern: [["git"], ["stash"]], decision: "prompt", justification: "Git stash modification" },

  // === Git force push === forbidden (must match full flags, not just "push")
  {
    pattern: [["git"], ["push"], ["--force"]],
    decision: "forbidden",
    justification: "Force push is destructive. Use normal push.",
  },
  {
    pattern: [["git"], ["push"], ["-f"]],
    decision: "forbidden",
    justification: "Force push is destructive. Use normal push.",
  },

  // === Safe read-only tools === allow
  { pattern: [["ls"]], decision: "allow", justification: "Safe directory listing" },
  { pattern: [["cat"]], decision: "allow", justification: "Safe file reading" },
  { pattern: [["head"]], decision: "allow", justification: "Safe file reading" },
  { pattern: [["tail"]], decision: "allow", justification: "Safe file reading" },
  { pattern: [["wc"]], decision: "allow", justification: "Safe word count" },
  { pattern: [["echo"]], decision: "allow", justification: "Safe echo" },
  { pattern: [["which"]], decision: "allow", justification: "Safe path lookup" },
  { pattern: [["pwd"]], decision: "allow", justification: "Safe working directory" },
  { pattern: [["whoami"]], decision: "allow", justification: "Safe identity check" },
  { pattern: [["uname"]], decision: "allow", justification: "Safe system info" },
  { pattern: [["date"]], decision: "allow", justification: "Safe date query" },
  { pattern: [["env"]], decision: "allow", justification: "Safe env listing" },
  { pattern: [["printenv"]], decision: "allow", justification: "Safe env listing" },
  { pattern: [["true"]], decision: "allow", justification: "Safe no-op" },
  { pattern: [["false"]], decision: "allow", justification: "Safe no-op (failure)" },
  { pattern: [["test"]], decision: "allow", justification: "Safe condition check" },
  { pattern: [["["]], decision: "allow", justification: "Safe test builtin" },

  // === File inspection tools === allow
  { pattern: [["find"]], decision: "allow", justification: "Safe file search" },
  { pattern: [["grep"]], decision: "allow", justification: "Safe text search" },
  { pattern: [["rg"]], decision: "allow", justification: "Safe text search (ripgrep)" },
  { pattern: [["fd"]], decision: "allow", justification: "Safe file search" },
  { pattern: [["ag"]], decision: "allow", justification: "Safe text search (silver searcher)" },
  { pattern: [["ack"]], decision: "allow", justification: "Safe text search" },
  { pattern: [["ast-grep"]], decision: "allow", justification: "Safe AST search" },
  { pattern: [["sg"]], decision: "allow", justification: "Safe AST search" },
  { pattern: [["file"]], decision: "allow", justification: "Safe file type detection" },
  { pattern: [["stat"]], decision: "allow", justification: "Safe file metadata" },
  { pattern: [["du"]], decision: "allow", justification: "Safe disk usage" },
  { pattern: [["df"]], decision: "allow", justification: "Safe disk free" },

  // === Package managers ===
  {
    pattern: [
      ["npm", "pnpm", "yarn", "bun"],
      ["install", "i"],
    ],
    decision: "allow",
    justification: "Package install is safe",
  },
  {
    pattern: [["npm", "pnpm", "yarn", "bun"], ["run"]],
    decision: "prompt",
    justification: "Arbitrary script execution",
  },
  {
    pattern: [["npm", "pnpm", "yarn", "bun"], ["test"]],
    decision: "allow",
    justification: "Test execution is safe",
  },
  {
    pattern: [["npm", "pnpm", "yarn", "bun"], ["build"]],
    decision: "allow",
    justification: "Build is safe",
  },
  {
    pattern: [["npm", "pnpm", "yarn", "bun"], ["lint"]],
    decision: "allow",
    justification: "Linting is safe",
  },

  // === Cargo ===
  { pattern: [["cargo"], ["build"]], decision: "allow", justification: "Cargo build is safe" },
  { pattern: [["cargo"], ["test"]], decision: "allow", justification: "Cargo test is safe" },
  { pattern: [["cargo"], ["check"]], decision: "allow", justification: "Cargo check is safe" },
  { pattern: [["cargo"], ["clippy"]], decision: "allow", justification: "Cargo clippy is safe" },
  { pattern: [["cargo"], ["run"]], decision: "prompt", justification: "Cargo run executes code" },

  // === Trash === allow (preferred over rm)
  { pattern: [["trash"]], decision: "allow", justification: "Recoverable deletion" },
  { pattern: [["trash-put"]], decision: "allow", justification: "Recoverable deletion" },
  { pattern: [["trash-list"]], decision: "allow", justification: "Trash listing" },
  { pattern: [["trash-restore"]], decision: "allow", justification: "Trash restore" },

  // === Destructive commands === forbidden
  {
    pattern: [["rm"], ["-rf", "-fr"]],
    decision: "forbidden",
    justification: "Use trash instead of rm -rf for recoverability",
  },
  {
    pattern: [["rm"]],
    decision: "forbidden",
    justification: "Use trash instead of rm for recoverability",
  },
  { pattern: [["rmdir"]], decision: "forbidden", justification: "Use trash for recoverability" },

  // === Shell interpreters inline eval === forbidden
  {
    pattern: [["bash", "sh", "zsh"], ["-c"]],
    decision: "forbidden",
    justification: "Inline shell eval blocked — use explicit script file",
  },
  {
    pattern: [["python", "python3"], ["-c"]],
    decision: "forbidden",
    justification: "Inline Python eval blocked — use explicit script file",
  },
  {
    pattern: [["node"], ["-e"]],
    decision: "forbidden",
    justification: "Inline Node eval blocked — use explicit script file",
  },
  {
    pattern: [["ruby"], ["-e"]],
    decision: "forbidden",
    justification: "Inline Ruby eval blocked — use explicit script file",
  },
  {
    pattern: [["perl"], ["-e"]],
    decision: "forbidden",
    justification: "Inline Perl eval blocked — use explicit script file",
  },

  // === sudo === forbidden
  {
    pattern: [["sudo"]],
    decision: "forbidden",
    justification: "Elevated permissions not allowed without explicit approval",
  },
  {
    pattern: [["doas"]],
    decision: "forbidden",
    justification: "Elevated permissions not allowed without explicit approval",
  },
  {
    pattern: [["pkexec"]],
    decision: "forbidden",
    justification: "Elevated permissions not allowed without explicit approval",
  },

  // === Disk/filesystem destruction === forbidden
  {
    pattern: [["mkfs"]],
    decision: "forbidden",
    justification: "Filesystem formatting is destructive",
  },
  {
    pattern: [["dd"]],
    decision: "forbidden",
    justification: "Low-level disk operations are dangerous",
  },
  { pattern: [["format"]], decision: "forbidden", justification: "Disk formatting is destructive" },

  // === Network tools === prompt
  { pattern: [["curl"]], decision: "prompt", justification: "Outbound network request" },
  { pattern: [["wget"]], decision: "prompt", justification: "Outbound network request" },
  { pattern: [["ssh"]], decision: "prompt", justification: "SSH connection" },
  { pattern: [["scp"]], decision: "prompt", justification: "Remote file copy" },

  // === Docker (read-only) === allow
  { pattern: [["docker"], ["ps"]], decision: "allow", justification: "Safe container listing" },
  { pattern: [["docker"], ["logs"]], decision: "allow", justification: "Safe log viewing" },
  { pattern: [["docker"], ["images"]], decision: "allow", justification: "Safe image listing" },
  { pattern: [["docker"], ["version"]], decision: "allow", justification: "Safe version info" },
  { pattern: [["docker"], ["inspect"]], decision: "allow", justification: "Safe inspection" },

  // === Development tools === allow
  { pattern: [["tsc"]], decision: "allow", justification: "TypeScript compiler is safe" },
  { pattern: [["eslint"]], decision: "allow", justification: "Linter is safe" },
  { pattern: [["prettier"]], decision: "allow", justification: "Formatter is safe" },
  { pattern: [["jest"]], decision: "allow", justification: "Test runner is safe" },
  { pattern: [["vitest"]], decision: "allow", justification: "Test runner is safe" },
  { pattern: [["tsx"]], decision: "allow", justification: "TypeScript execution" },
  { pattern: [["bun"]], decision: "prompt", justification: "Bun execution" },
];

const DEFAULT_BANNED: BannedPrefix[] = [
  { pattern: ["chmod", "-R", "777"], justification: "Recursive world-writable is never safe" },
  { pattern: ["sudo", "rm"], justification: "Elevated deletion is extremely dangerous" },
  { pattern: ["dd", "of=/dev/sd"], justification: "Direct disk write is destructive" },
];

export function getDefaultRules(): PrefixRule[] {
  return DEFAULT_RULES;
}

export function getDefaultBanned(): BannedPrefix[] {
  return DEFAULT_BANNED;
}

export function buildDefaultPolicy(): ExecPolicy {
  const rules = getDefaultRules();
  const banned = getDefaultBanned();
  return {
    rules: indexRules(rules),
    allRules: rules,
    banned,
    isDefault: true,
  };
}
