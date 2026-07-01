# Auto-Cherry Ledger — nightly upstream sync

Append-only log for the autonomous `upstream-merge-nightly` cron (`4986d9df`).
Each nightly run appends one dated block. The cron **cherry-picks provably-safe
upstream fixes only** (`fix`/`perf`/security, no convergent-surface files, no
codex); wholesale merges are classified, deferred, and left for a maintainer
`$openclaw-upstream-resync` pass.

Classification is produced by `scripts/upstream-divergence-report.mjs` (canonical
convergent surface = `.gitattributes merge=ours` ∪ `extensions/codex/**`). Proof
is `scripts/remote-proof.sh` (Linux build + 7 tsgo lanes + `test:fast`) plus a
`claude-connect` `$autoreview` on the applied cherry diff. Nothing lands without
green proof; every land sets `main-backup-pre-autocherry` + a tag for one-command
rollback.

## Entry format

```
## <YYYY-MM-DD>  —  <LANDED n | DEFERRED | NOOP>
N=<behind> (mix …) · cherry=<c> (borderline=<b>) · deferred=<d>
Landed:   <sha> <subject>            (or "none")
Deferred: <count> — <top reasons>    (backlog trend vs prior night)
Proof:    build ✓ · tsgo <lanes> ✓ · test:fast ✓ · $autoreview <verdict>
Rollback: main-backup-pre-autocherry @ <sha> / tag <name>
Notes:    <conflicts skipped, transport, anomalies>
```

---

<!-- runs appended below -->

## 2026-07-01 — DEFERRED (proof FAIL)

N=679 (2 merges) — fix:436 · test:63 · other:52 · chore:47 · feat:30 · docs:22 · refactor:12 · ci:11 · perf:1
Cherry candidates: 375 (borderline=104) · Deferred: 304
Pick list: 39 SHAs (32 non-borderline + 7/8 borderline approved; 1 borderline deferred: 9c95abd49d45 too large/entangled)
Cherry-picked: 36 (3 conflicts → deferred: 199700de264a, 07b934901a32, c6ade83a5ccb)
Landed: none
Deferred: 369 total — top reasons: type=test(58), type=chore(46), type=other(40), type=feat(23), type=docs(21), codex hard-gate(16), touches protected surface(37), type=ci(11), type=refactor(8)
Proof: build ✓ · tsgo all 7 lanes ✓ (zero regressions: core 16=16, extensions 9=9, core:test 1=1, extensions:test 27=27, test:src 1=1, test:ui 7=7, test:packages 0=0) · test:fast ✗ (1 NEWFAIL: src/skills/loading/workspace-sync.test.ts — inode preservation assertion, likely flaky/timing)
Claude-connect: unavailable (ACP not configured), borderline classified inline
Rollback: main untouched @ 73b58f4a0b
Notes: Worktree resync/auto-cherry-2026-07-01 created, 36 picks applied cleanly, all guards passed, proof FAILED on workspace-sync inode test. All deferred backlog rolls to tomorrow. Needs maintainer `$openclaw-upstream-resync` for the large merge-shaped backlog (679 behind).
