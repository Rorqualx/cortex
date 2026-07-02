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

## 2026-07-02

- Divergence: 814 commits (fix=518, test=73, chore=65, feat=34, docs=26, other=63, refactor=13, ci=13, improve=3, perf=2, doctor=3, style=1)
- Cherry-picked: 37/40 (oldest non-borderline fixes)
  - b8e3de11608d fix(telegram): recover stalled ingress spool claims
  - 6c5a9fde9f1c fix(msteams): truncate reflection prompt on UTF-16 boundary
  - d693ed4af3e7 fix(qqbot): truncate reminder job name on code-point boundary
  - cb8bc71ff80f fix(whatsapp): elide auto-reply text on UTF-16 boundary
  - 90c20d15c22e fix(slack): truncate approval mrkdwn on UTF-16 boundary
  - 2e881ab1c679 fix(googlechat): truncate approval card text on UTF-16 boundary
  - e5c3c59c6757 fix(synology-chat): truncate sanitized input on UTF-16 boundary
  - ce15f348bbc4 fix(telegram): use idempotent retry context for delete/reaction
  - 2720ac06b7c8 fix(duckduckgo): guard out-of-range numeric HTML entities
  - c53dbcaf4dff fix: surface delegated Testbox proof status
  - 4d292caaa429 fix(plugin-sdk): follow paginated live model catalogs
  - 2d2a50c00dfa fix(discord): bound REST response body to prevent OOM flood
  - f1e4980a9705 fix(embedding): bound OpenAI-compatible embedding response reads
  - d577cb2fe9ea fix(nextcloud-talk): bound external send/reaction response reads
  - 9241b9701d9c fix(mattermost): bound successful REST JSON/text response reads
  - 25e184aeab64 fix(minimax): bound video control response reads
  - 2f851ecfe9df fix(speech): bound TTS response reads
  - 891096926e27 fix(opencode): restore Zen model catalog
  - 0d59280131c0 fix(deepinfra): bound video generation JSON response reads
  - c0883a531de9 fix(openrouter): bound generation-cost JSON response reads
  - 949b1af433c6 fix(status): distinguish runtime-loaded plugins from installed inventory
  - 4a0cd56139f9 fix(ui): roll formatTokens over to "M" instead of rendering "1000k"
  - 2e5e5e5af905 fix(media-understanding): append actionable install hint when media provider is missing
  - 6ce88ca51d05 fix(irc): prevent ghost nick collisions on rejoin after network delay
  - b580258e94e0 fix(heartbeat): suppress stream-error placeholders
  - a10add753189 fix(models): mark local Ollama rows available
  - 9ff8510f5297 fix path to Discord Developer Mode in setup guide
  - 55d7b5b36ca1 fix(matrix): truncate reply context on code-point boundaries
  - 48f34b1d4df7 fix(openrouter): bound video response reads
  - 45f261ff7ad1 fix(memory-wiki): truncate import insights safely
  - 881ec2f93f37 fix(mattermost): truncate draft previews on code-point boundaries
  - eff68d2c7714 fix(line): truncate action fields on code-point boundaries
  - 51064bda4def fix(signal): bound GitHub release info JSON response
  - bd0c052aa5e1 fix(oauth): bound github-copilot OAuth response reads at 16 MiB
  - 4c477ee6321e fix(openai): bound embedding-batch and realtime session JSON response reads
  - 3c826ed5c9a6 fix: shorten managed npm generation paths
  - 25490d4c4212 fix(matrix): sanitize internal tool-trace lines from outbound text
- Deferred: 3 (conflict on cherry-pick)
  - 199700de264a fix(telegram): replay retained preview gaps
  - 07b934901a32 fix: scanned PDF pages reach chat vision models
  - 71347ef999ed fix(msteams): handle message card submit values
- Remaining cherry candidates: 287 non-borderline + 125 borderline (for next night)
- Remote proof: PASS (BUILD_EXIT=0, all 7 TSGO lanes matched, test:fast green)
- Guard: clean (no conflict markers, no protected files touched, fork dirs intact, merge=ours count stable)
- Review: clean (all fixes, no correctness/security concerns)
- Status: LANDED, deploy pending (cron-deploy-build.sh quiescing, will auto-resume after this cron ends)
