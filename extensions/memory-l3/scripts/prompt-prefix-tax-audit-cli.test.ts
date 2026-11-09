import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// ARCH-3 card 9e633f3e (implement stage, lab 2026-11-07 Suite 3 / 2026-11-08
// review): exec-level CLI tests over a committed fixture feed. Runs the REAL
// script via child_process — no build step, pure node builtins.
//
// Fixture = 3 records: cold (turn 1, tax = full 800-token suffix),
// warm-stable (turn 2, 83.3% cache hit → tax 133), churned (turn 3, same
// facts with sections reordered — the QW4 evidence-first reorder shape —
// dropCause tracked-input-change, cache lost → full tax again).

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(new URL("./prompt-prefix-tax-audit.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/prompt-prefix-tax-feed.jsonl", import.meta.url));

function runAudit(extraArgs: string[] = []) {
  return execFileAsync(process.execPath, [SCRIPT, `--feed=${FIXTURE}`, ...extraArgs], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

const ROW_COLD = "| 1 | 800 | 300 | 37.5% | 0.0% | 800 |";
const ROW_WARM = "| 2 | 800 | 300 | 37.5% | 83.3% | 133 |";
const ROW_CHURNED = "| 3 | 800 | 300 | 37.5% | 0.0% | 800 |";

describe("prompt-prefix-tax-audit CLI (exec-level)", () => {
  it("T-C1: exits 0 on the fixture feed and renders per-record rows + aggregate histogram", async () => {
    const { stdout } = await runAudit();
    expect(stdout).toContain("# Prompt Prefix Tax Audit");
    expect(stdout).toContain("- Records: 3 (usage telemetry on 3)");
    expect(stdout).toContain(ROW_COLD);
    expect(stdout).toContain(ROW_WARM);
    expect(stdout).toContain(ROW_CHURNED);
    expect(stdout).toContain('dropCause histogram: {"(none)":2,"tracked-input-change":1}');
  });

  it("T-C2: cold record shows tax = full suffix; warm-stable shows reduced-tax math", async () => {
    const { stdout } = await runAudit();
    // Cold: no cached prefix → every suffix token re-prefilled.
    expect(stdout).toContain(ROW_COLD);
    // Warm: 4000/4800 cached → tax = round(800 × (1 − 4000/4800)) = 133.
    expect(stdout).toContain(ROW_WARM);
    expect(stdout).not.toContain("| 2 | 800 | 300 | 37.5% | 83.3% | 800 |");
  });

  it("T-C3: --out writes a file byte-identical to stdout (modulo trailing newline)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-prefix-tax-"));
    const outPath = join(dir, "report.md");
    try {
      const { stdout } = await runAudit([`--out=${outPath}`]);
      const written = await readFile(outPath, "utf8");
      const norm = (s: string) => s.replace(/\n$/, "");
      expect(norm(written)).toBe(norm(stdout));
      expect(written).toContain("# Prompt Prefix Tax Audit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("T-C4: reordered-sections record bucketed as tracked-input-change boundary break", async () => {
    const { stdout } = await runAudit();
    // Turn 3 carries the same facts with sections reordered (QW4 evidence-first
    // ordering shape) → suffix digest churn pins as a boundary break.
    expect(stdout).toContain("Boundary breaks: 1");
    expect(stdout).toContain('"tracked-input-change":1');
    expect(stdout).toContain(ROW_CHURNED);
  });
});
