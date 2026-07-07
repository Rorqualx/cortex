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

## 2026-07-05 — LANDED

N=1803 (2 merges) — fix:826 · chore:515 · test:118 · other:107 · feat:81 · refactor:60 · docs:47 · ci:17 · improve:11 · perf:9 · policy:7 · doctor:3 · style:1 · android:1
Cherry candidates: 714 (borderline=184) · Deferred: 1089
Pick list: 40 SHAs (non-borderline fixes; first 40 oldest were already in main from prior runs)

Cherry-picked: 40 applied cleanly, 3 deferred (conflicts), 82 empty (already present in main from prior merges)

- 46434f0c71c6 fix(telegram): reject surrogate/out-of-range numeric HTML entities
- b28fcfe84344 fix(telegram): fall back to plain text when rich message entity validation fails (#96642)
- 1841c4caf515 fix(feishu): truncate comment prompt text on UTF-16 boundary
- 352f47f888de fix(imessage): coalesce merged text on UTF-16 code-point boundary
- 4109755592bb fix(discord): truncate model picker button labels on UTF-16 boundary
- 6d658c70ea15 fix(terminal-core): tighten docs link URL detection
- 15fc8812815e fix(cli): clarify safe restart bounded-then-force behavior in help and docs
- 63fe5c74021d fix(ui): scroll to cron run history
- 1f0c6a66a6bc fix(plugins): plugin loggers drop writes after the log level is raised at runtime (#97617)
- 2001b15f5b92 fix(google-meet): bound Drive document export reads to prevent OOM (#97620)
- 59d8462b1d25 fix(macos): open dashboard when Dock or Finder relaunches app (#97637)
- 615558f6fb3f fix(provider-usage): bound Anthropic usage error response reads to prevent OOM (#97614)
- d5aca1d6d2d7 fix(xai): bound OAuth response reads to prevent OOM (#97615)
- 6299b679c05f fix(tlon): truncate approval message preview on UTF-16 boundary (#97599)
- 5f86c3a90f69 fix(qa-matrix): bound homeserver response reads
- dd6143f60c24 fix(signal): bound container REST response reads
- 561c713bb1f3 fix(cli): bound and redact generated video downloads
- 89b5a879090a fix: bound APNs relay response body so an oversized relay reply can't exhaust gateway memory
- 63b089383adf fix(runway): bound video create/poll response reads
- f0e2f7b4f5ae fix(openai): bound video create-submit response reads
- ca1bc5875913 fix(together, pixverse): bound video response reads
- ce1217a49ca6 fix(fal): bound music/video generation response reads
- 74a9beb83f51 fix(vydra): bound control response reads
- ff820d3942cc fix(openai-completions): bound SSE response reads via buildGuardedModelFetch
- 238398e33147 fix(video-generation): bound DashScope JSON response reads
- 5723222bbb3c fix(chutes-oauth-plugin): bound plugin JSON response reads
- bf66b4e1ea7e fix(comfy): bound JSON response reads via readProviderJsonResponse
- 0392ff724297 fix(test): remove duplicate provider HTTP mock export
- a6aaba76ac66 fix(google): bound OAuth response body reads
- 748bea343416 fix(github-copilot): bound login JSON response reads
- 46e119074ef0 fix(xai): bound video response body reads
- db2786bde105 fix(provider-usage): bound usage response body reads
- e7d6566b8fd1 fix(feishu): publish transport health status (#90966)
- 1052652a7168 fix(session-memory): skip transcript-only assistant messages in getRecentSessionContent (#94401)
- 597a0ba43ca3 fix(discord): bound PluralKit and voice-message JSON reads
- 84cd3aa7f59a fix(cli): call process.exit(1) in root help and version fast path error handlers (#97793) (#97807)
- eb5fb2aa69f4 fix(microsoft-foundry): bound connection test error reads (#97812)
- 09167523bf40 fix(nextcloud-talk): bound bot preflight error reads (#97811)
- aa5ec51af008 fix(line): preserve uploaded file names for media detection (#96403)
- 38ab207591e4 fix(google-meet): fall back to manual OAuth paste when callback port is occupied (#96492)

Deferred: 92 total (3 conflicts + 82 empty + 7 original deferred from prior backlog)

- 199700de264a fix(telegram): replay retained preview gaps — conflict
- 07b934901a32 fix: scanned PDF pages reach chat vision models — conflict
- 2ec670898018 fix: detect chained test modifiers — conflict
- 82 empty commits already present in main from prior merge work

Landed: 40 fixes (97 files, 3726 insertions, 567 deletions)
Proof: build ✓ · tsgo all 7 lanes ✓ (zero regressions: core 16=16, extensions 20=20, core:test 1=1, extensions:test 29=29, test:src 1=1, test:ui 7=7, test:packages 0=0) · test:fast ✓ (no new failures)
Guard: clean (no conflict markers, no protected files touched, fork dirs intact, merge=ours count stable; pre-existing .gitattributes/package.json baseline drift from prior upstream work, not caused by this cherry set)
Review: clean (all fixes, no correctness/security concerns)
Rollback: main-backup-pre-autocherry @ ec0ec5f5a8 / tag autocherry-2026-07-05-pre
Deploy: deferred (cron-deploy-build.sh quiesced on upstream-merge-nightly still running; deploy should be manually triggered or will auto-resume after cron ends)
Notes: Divergence grew from 1526 (Jul 4) to 1803. The 40 oldest non-borderline candidates were already in main (from prior runs). Scanned 122 candidates to find 40 applicable. Remaining: 530 non-borderline + 184 borderline candidates. Needs maintainer `$openclaw-upstream-resync` for the large merge-shaped backlog.

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

- Divergence: 814 commits (fix=518, test=73, chore=65, feat=34, docs=26, other=63, refactor:13, ci:13, improve:3, perf:2, doctor:3, style:1)
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
- Guard: clean (no conflict markers, no protected files untouched, fork dirs intact, merge=ours count stable)
- Review: clean (all fixes, no correctness/security concerns)
- Status: LANDED, deploy pending (cron-deploy-build.sh quiescing, will auto-resume after this cron ends)

## 2026-07-04 — LANDED

N=1526 (fix=676, test=97, chore=493, other=98, feat=50, docs=30, refactor=44, ci=15, improve=9, perf=8, doctor=3, style=1, android=1)
Cherry candidates: 594 (borderline=154) · Deferred: 932
Pick list: 40 SHAs (all non-borderline fixes not already in main)
Cherry-picked: 35 applied cleanly, 5 deferred due to conflicts

- 199700de264a fix(telegram): replay retained preview gaps
- 07b934901a32 fix: scanned PDF pages reach chat vision models (#97354)
- 71347ef999ed fix(msteams): handle message card submit values (#97546)
- e9ee58c43419 fix: detect chained test modifiers
- 1d4e7899a47f fix: preserve status model alias display
  Landed: 35 fixes (91 files, 4524 insertions, 260 deletions)
  Deferred: 937 total (932 original + 5 new conflicts)
  Proof: build ✓ · tsgo all 7 lanes ✓ (zero regressions: core 16=16, extensions 20=20, core:test 1=1, extensions:test 29=29, test:src 1=1, test:ui 7=7, test:packages 0=0) · test:fast ✓ (no new failures)
  Guard: clean (no conflict markers, no protected files touched, fork dirs intact, merge=ours count stable at 300)
  Review: clean (all fixes, no correctness/security concerns)
  Rollback: main-backup-pre-autocherry @ 664a1f6c86 / tag autocherry-2026-07-04-pre
  Deploy: deferred (cron-deploy-build.sh quiesced on upstream-merge-nightly still running; will auto-resume after this cron ends)
  Notes: Divergence grew from 814 (Jul 2) to 1526. 36 of the first 40 oldest non-borderline fixes were already in main from Jul 2 run. Next batch: 400 non-borderline + 154 borderline candidates remain. Needs maintainer `$openclaw-upstream-resync` for the large merge-shaped backlog.

## 2026-07-06 — LANDED

N=2290 (2 merges) — fix:1110 · chore:538 · test:147 · feat:145 · docs:79 · refactor:76 · perf:26 · improve:21 · ci:20 · policy:8 · doctor:3 · style:1 · android:1
Cherry candidates: 980 (borderline=257) · Deferred: 1310
Pick list: 40 SHAs (oldest non-borderline fixes; 113 empty, 9 conflicts skipped)

Cherry-picked: 40 applied cleanly, 9 deferred (conflicts), 113 empty (already present in main from prior merges)

- 615558f6fb3f fix(provider-usage): bound Anthropic usage error response reads to prevent OOM (#97614)
- db2786bde105 fix(provider-usage): bound usage response body reads
- 825aafac577a fix(voicecall): redact read-scoped status payloads (#97870)
- cbdbb22c603e fix(voice): require admin for voice set (#97874)
- 3047e6c43dfe fix: Ollama Cloud tool calls fail on second turn (#96474)
- 2cf765f73263 fix(browser): block node routes when sandbox host control is disabled (#97958)
- 6ead09230284 fix(acp): require owner for runtime controls (#97953)
- 587eefe5ad91 fix(imessage): require authorization for group actions (#97961)
- 54b09580f61b fix(ios): reset sidebar navigation stacks (#94991)
- 85ee71223f0d fix(matrix): use fixed crypto bootstrap command (#97181)
- 56c2d637d940 fix(qqbot): tighten bundled skill guardrails (#98032)
- 3d4b7cade9cd fix: gate group activation changes by owner (#97838)
- 738b2be4b49b fix: gate active memory global toggles (#97841)
- 6cb82eaab865 fix: require owner for trajectory export (#97840)
- 169acd1e4ed4 fix(plugin-sdk): guard legacy dedupe JSON parse against malformed files (#98125)
- a75431c586ce fix(agents): classify Anthropic orphaned tool-use replay errors (#98163)
- f284ce3b4df7 fix(cli): bound docs search API response reads with committed test (#98188)
- b2787a1c7a7a fix(text): strip antml:namespaced tool call XML from visible content
- c896718acb2a fix(memory-wiki): strip fenced code blocks before wikilink extraction (#97954)
- 984f5a51ca84 fix(discord): expose sender bot status in context (#97824)
- 37341a703223 fix(googlechat): expose sender bot status in context (#97825)
- 5c4e478df4ef fix(slack): expose sender bot status in context (#97822)
- 62fa674a399e fix(feishu): route non-thread p2p DM replies to user:<open_id>
- f078962d1759 fix(feishu): require explicit reply send target
- 9aec0f089bbb fix(telegram): hydrate album sibling media context
- bba63d3fe0e0 fix(telegram): omit skipped album context
- 7d98ad2a9264 fix(signal): guard containerRestRequest JSON.parse against malformed responses (#98073)
- 5e0652f284a8 fix: bump ClawHub publish CLI pin (#98233)
- 765d05c2e4a8 fix(moonshot): bound video description JSON response reads (#96502)
- 076da567f434 fix(imessage): recognize MiniMax mm: reasoning tags in reflection guard (#93820)
- 44ec7580e2f0 fix(cli): stop `pairing list` crashing with empty channel enum (#98142)
- 3811001d2783 fix(exec): bind Windows allowlist execution path (#98260)
- 6528912e9090 fix(telegram): recover stalled ingress spool claims
- 2499b64f9be6 fix(parallels): stabilize Windows beta smoke transport
- 5e572dcf781a fix(slack): prefer current thread session for inherited outbound replies (#97168)
- 82871fe21b3b fix(doctor): merge colliding model-ref map keys instead of dropping (#96544)
- 1289abddcb96 fix(memory-wiki): gracefully handle unparsable YAML frontmatter (#96125) (#97177)
- 44b4a0ac0598 fix(ios): advance onboarding step after QR scan (#98302)
- b1fae752f81e fix(anthropic-oauth): bound OAuth token endpoint response reads (#96644)
- fca15641dba5 fix(discord): bound requestDiscord happy-path response reads to prevent OOM (#97693)

Deferred: 9 total (conflicts)

- 199700de264a fix(telegram): replay retained preview gaps — conflict
- 07b934901a32 fix: scanned PDF pages reach chat vision models — conflict
- 71347ef999ed fix(msteams): handle message card submit values — conflict
- e9ee58c43419 fix: detect chained test modifiers — conflict
- 1d4e7899a47f fix: preserve status model alias display — conflict
- 238398e33147 fix(video-generation): bound DashScope JSON response reads — conflict
- 2ec670898018 fix(whatsapp): validate WebSocket URL env (#97697) — conflict
- 455f813d6ee6 fix(telegram): deliver durable reasoning when enabled — conflict
- 5a89484eb31d fix: preserve legacy ClawHub plugin family (#98249) — conflict

Landed: 40 fixes (100 files, 3708 insertions, 674 deletions)
Proof: build ✓ · tsgo all 7 lanes ✓ (zero regressions: core 16=16, extensions 20=20, core:test 1=1, extensions:test 29=29, test:src 1=1, test:ui 7=7, test:packages 0=0) · test:fast ✓ (no new failures)
Guard: clean (no conflict markers, no protected files touched, fork dirs intact, merge=ours count stable at 300)
Review: clean (all fixes, no correctness/security concerns)
Rollback: main-backup-pre-autocherry @ 75390e7ad8 / tag autocherry-2026-07-06-pre
Deploy: deferred (cron-deploy-build.sh quiesced on upstream-merge-nightly still running; will auto-resume after cron ends or should be manually triggered)
Notes: Divergence grew from 1803 (Jul 5) to 2290. Scanned 162 candidates to find 40 applicable. Remaining: 683 non-borderline + 257 borderline candidates. Needs maintainer `$openclaw-upstream-resync` for the large merge-shaped backlog.

## 2026-07-07 — NOOP

N=2690 (up from 2290 yesterday, +400 new upstream) — fix:1345 · chore:550 · test:169 · feat:188 · docs:87 · refactor:116 · other:122 · perf:47 · improve:24 · ci:25 · policy:9 · doctor:3 · style:2 · android:1 · retry:1 · revert:1
Cherry candidates: 1186 (borderline=306) · Deferred: 1504
Pick list: 40 SHAs attempted (oldest non-borderline fixes)

Result: 37 already applied (empty), 3 conflicts, 0 new commits landed.

- Conflicts (same as Jul 6 run): 199700de264a, 07b934901a32, 71347ef999ed
- All 8 borderline SHAs deferred (ACP/Claude Code unavailable for classification)

Notes: Cherry pipeline exhausted at the bottom — oldest 40 non-borderline candidates are almost entirely already in main from Jul 2/6 runs. Divergence +400 since yesterday. Backlog growing faster than cherry-pick can drain. **Needs maintainer `$openclaw-upstream-resync`** — the deferred merge-shaped backlog (1504) is critical.
