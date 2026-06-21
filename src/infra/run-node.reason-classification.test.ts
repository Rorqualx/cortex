// Guards the suppression contract: every build / runtime-postbuild reason that
// compute* can return must be explicitly classified as STALE (suppressed inside
// the managed gateway) or NON-STALE (always allowed to build/sync). A new reason
// added to a label map but left unclassified silently falls through to a rebuild,
// which inside the gateway is the build-suicide regression the suppression exists
// to prevent. This test fails the moment a reason is unclassified.
import { describe, expect, it } from "vitest";
import {
  BUILD_REASON_LABELS,
  RUNTIME_POSTBUILD_REASON_LABELS,
  STALE_REBUILD_REASONS,
  STALE_RUNTIME_POSTBUILD_REASONS,
} from "../../scripts/run-node.mjs";

// `auto_build_suppressed_in_service` is the wrapper's OUTPUT reason, never a
// compute* result, so it is not subject to stale/non-stale classification.
const SUPPRESSION_OUTPUT_REASON = "auto_build_suppressed_in_service";

// Reasons that mean "missing/forced/clean" — always safe to build/sync even in
// the gateway (a fresh/partial worktree must self-heal). Keep in sync with the
// missing-* and terminal reasons that compute* returns.
const NON_STALE_REBUILD_REASONS = new Set([
  "force_build",
  "missing_build_stamp",
  "missing_dist_entry",
  "missing_bundled_plugin_dist_entry",
  "missing_private_qa_dist",
  "clean",
]);

const NON_STALE_RUNTIME_POSTBUILD_REASONS = new Set([
  "force_runtime_postbuild",
  "missing_runtime_postbuild_output",
  "missing_runtime_postbuild_stamp",
  "missing_build_stamp",
  "clean",
]);

function assertEveryReasonClassified(
  labels: Record<string, string>,
  staleReasons: Set<string>,
  nonStaleReasons: Set<string>,
): void {
  for (const reason of Object.keys(labels)) {
    if (reason === SUPPRESSION_OUTPUT_REASON) {
      continue;
    }
    const classified = staleReasons.has(reason) || nonStaleReasons.has(reason);
    expect(classified, `reason "${reason}" is not classified as stale or non-stale`).toBe(true);
  }
  // A reason cannot be both — that would make suppression ambiguous.
  for (const reason of staleReasons) {
    expect(nonStaleReasons.has(reason), `reason "${reason}" is both stale and non-stale`).toBe(
      false,
    );
  }
}

describe("run-node reason classification", () => {
  it("classifies every build reason as stale or non-stale", () => {
    assertEveryReasonClassified(
      BUILD_REASON_LABELS,
      STALE_REBUILD_REASONS,
      NON_STALE_REBUILD_REASONS,
    );
  });

  it("classifies every runtime-postbuild reason as stale or non-stale", () => {
    assertEveryReasonClassified(
      RUNTIME_POSTBUILD_REASON_LABELS,
      STALE_RUNTIME_POSTBUILD_REASONS,
      NON_STALE_RUNTIME_POSTBUILD_REASONS,
    );
  });

  it("every stale reason has a label", () => {
    for (const reason of STALE_REBUILD_REASONS) {
      expect(
        BUILD_REASON_LABELS[reason],
        `stale build reason "${reason}" missing a label`,
      ).toBeTypeOf("string");
    }
    for (const reason of STALE_RUNTIME_POSTBUILD_REASONS) {
      expect(
        RUNTIME_POSTBUILD_REASON_LABELS[reason],
        `stale runtime reason "${reason}" missing a label`,
      ).toBeTypeOf("string");
    }
  });
});
