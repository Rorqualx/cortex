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
