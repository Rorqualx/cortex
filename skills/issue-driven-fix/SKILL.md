---
name: issue-driven-fix
description: "Empirical end-to-end loop for resolving GitHub issues: review/triage, root-cause via codebase analysis, design and run live probes/experiments, analyze data, design a minimal evidence-driven fix, implement with tests, verify locally and re-probe live for regressions, deploy to a test harness, ship via branch then CI then merge then release, and report back on the issue. Use for 'review/work the issues', 'investigate and fix issue N', or anti-bot/fingerprint/Cloudflare debugging that needs a real browser."
user-invocable: true
metadata: { "openclaw": { "requires": { "bins": ["git", "gh", "go", "docker", "ssh"] } } }
---

# Issue-Driven Fix Loop

A disciplined, **empirical** loop for turning GitHub issues into shipped, validated fixes. Governing principle: **probe, don't guess — and re-probe after fixing.** Most wasted effort comes from plausible-but-wrong hypotheses that one live measurement would have refuted.

Follow the phases in order; skip one only when genuinely N/A, and say so. The concrete commands below are the worked example from a Go anti-bot service (flaresolverr-go) driven against a remote Docker harness — **swap the host/build/test specifics for your project** while keeping the method.

## Per-project anchors (read first, verify before relying on)

- The repo's `CLAUDE.md`/`AGENTS.md` for coding standards — follow them exactly.
- Code search: prefer `ast-grep --pattern '...'` for code; `rg`/`grep` for non-code text only.
- A **live test harness** you can deploy to and probe (a real browser/runtime, not just unit tests). Record its address/build/deploy steps in memory. Never disturb production.
- `gh` CLI for issues/PRs/releases/runs.

---

## Phase 1 — Review & triage

```bash
gh issue list --state open --limit 30
gh issue view <N>; gh issue view <N> --comments
```

Read the **full** thread — prior commenters often already root-caused or refuted a path. Separate a **confirmed code bug** from an **environmental/external wall**; conflating them sends you down the wrong path. Triage: close not-planned (with a documented reason) for external/won't-fix; keep open for actionable work; split "fixable now" from "residual". When you post triage, quote the evidence and name what's ruled out.

## Phase 2 — Root-cause analysis

Map the relevant code (`ast-grep`/read). Trace the **actual** call paths (request types often diverge across code paths). Write down **competing hypotheses** and, for each, the decisive check that confirms or refutes it. Build a model before measuring (e.g. "two stacked gates"). Verify framework/library behavior against the vendored source, not memory or blog lore.

## Phase 3 — Design & run probes (live experiments)

The differentiator. Design experiments that **isolate one variable each** and run them against the live harness.

- Use a probe driver (see `scripts/probe_template.py`) that exercises the real runtime and returns **structured** evidence (e.g. a JSON dump of the JS fingerprint surface; a raw fingerprint endpoint body).
- **Deploy current code first** so you measure shipped behavior, not a stale image. Example:
  ```bash
  tar --exclude=.git -czf /tmp/app.tgz -C <repo> .
  scp -q /tmp/app.tgz user@harness:/tmp/
  ssh user@harness 'cd ~/app-invest && rm -rf ./* && tar -xzf /tmp/app.tgz -C . && \
    docker build -q -t app:invest . && docker rm -f app-invest 2>/dev/null; \
    docker run -d --name app-invest -p 8195:8191 -e LOG_LEVEL=debug app:invest'
  ```
- Use **A/B probes** to localize a defect (e.g. path-A vs path-B reveals which layer ships the bug).
- Pick targets that reliably exhibit the phenomenon; one that passes natively proves nothing about a stuck case.

## Phase 4 — Analyze the data

State what each probe **confirmed** and **ruled out** — ruling a vector out is as valuable as finding the bug; it stops the whole thread chasing a dead path. Reduce to concrete, named defects with evidence (file:line + measured value), ranked by signal strength.

## Phase 5 — Design the solution

**Minimal and surgical** — the smallest change that fixes the measured defect beats a broad rewrite (broad changes regress adjacent properties). Respect couplings (a cache keyed by an identity must move in lockstep with whatever sets that identity). Be honest about the **value ceiling**: if a fix can't help the reported case, say so and pick the path with real, testable payoff.

## Phase 6 — Implement

Follow the repo standards. Add table-driven unit tests next to the code for every new component; make time/randomness injectable for determinism.

## Phase 7 — Verify (local + live re-probe)

```bash
go build ./... && go vet ./... && go test -short ./...   # adapt to the stack
```

**Then re-deploy and re-probe.** Confirm the target metric flipped AND run a **regression probe** (e.g. an automation-detector grid still all-pass) — a hot-path fix can silently break an adjacent property. A green build is **not** validation for a behavioral/fingerprint change. Validate config/CI changes with the real tool, not assumption (e.g. `goreleaser check`, installing the exact version CI floats to).

## Phase 8 — Deploy / end-to-end

Run a real end-to-end action through the harness to confirm the happy path still works; capture timing/cookies/logs as evidence. Tear down any scratch infra you stood up.

## Phase 9 — Ship

Branch from the default branch (never commit straight to it): `git checkout -b <type>/<slug>`. Commit with a body explaining the **measured finding + fix**; add a `Co-Authored-By:` trailer if your workflow uses one. Push, **watch CI to green** (`gh run watch <id> --exit-status`), then `--no-ff` merge, push, delete the branch (local + remote). For a release: bump CHANGELOG, tag `vX.Y.Z` (features → minor), push the tag, watch Release + Docker workflows, and verify the published assets/images exist.

## Phase 10 — Report on the issue

Post a structured comment: what was **ruled out** (with data), what was **fixed** (with validation evidence), **honest scope** (does and doesn't), and the residual. Tag participants; ask for the one data point you can't generate yourself. Persist non-obvious findings and ruled-out vectors to memory so the next session doesn't re-investigate.

---

## Anti-patterns

- Shipping an anti-bot/behavioral change without a live repro/validation — the class of change that most needs it.
- Cargo-culting fixes from blogs ("improve the TLS layer", "patch the Runtime.enable leak") without checking they apply — measure first.
- Treating a green build as proof a behavioral change works — re-probe.
- Broad fixes that regress adjacent properties — prefer surgical.
- Over-claiming in issue comments — state the value ceiling plainly.
