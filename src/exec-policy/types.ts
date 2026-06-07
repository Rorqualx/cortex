/** Decision returned by prefix-rule evaluation. */
export type ExecPolicyDecision = "allow" | "prompt" | "forbidden";

/** A single prefix rule loaded from TOML config. */
export interface PrefixRule {
  /** Ordered token patterns. Each element is an array of alternatives.
   *  Example: [["git"], ["status", "diff"]] matches "git status" or "git diff" */
  pattern: string[][];
  /** Decision for this rule. */
  decision: ExecPolicyDecision;
  /** Human-readable reason shown in approval UIs. */
  justification?: string;
}

/** A banned prefix — always forbidden regardless of other rules. */
export interface BannedPrefix {
  /** Token pattern. */
  pattern: string[];
  /** Why it's banned. */
  justification?: string;
}

/** The full policy object loaded from config. */
export interface ExecPolicy {
  /** Prefix rules indexed by first-token for O(1) lookup. */
  rules: Map<string, PrefixRule[]>;
  /** Flat list of all rules (for serialization). */
  allRules: PrefixRule[];
  /** Banned prefixes. */
  banned: BannedPrefix[];
  /** Whether this is a default-generated policy (no user file). */
  isDefault: boolean;
}

/** Result of evaluating a command against the policy. */
export interface PolicyEvaluation {
  /** Final decision. */
  decision: ExecPolicyDecision;
  /** All rules that matched (for audit/display). */
  matchedRules: PrefixRule[];
  /** Banned prefix that matched, if any. */
  bannedMatch?: BannedPrefix;
  /** Whether any rule matched at all. */
  matched: boolean;
}

/** TOML schema for the config file. */
export interface ExecPolicyToml {
  rule?: Array<{
    pattern: string | string[];
    decision: string;
    justification?: string;
  }>;
  banned?: Array<{
    pattern: string | string[];
    justification?: string;
  }>;
}
