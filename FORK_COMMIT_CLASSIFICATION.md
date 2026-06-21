# Cortex Fork — Commit Conflict Classification vs upstream/main

Generated 2026-06-18. Merge base e06f6ffc (2026-06-07).
A commit is **CONFLICT** if it touches at least one file upstream also changed (274 overlap files); **CLEAN** otherwise.

- CLEAN commits (cherry-pick / replay with ~no merge work): **157**
- CONFLICT commits (need manual reconciliation): **167**

---

## CLEAN — 157 commits (no overlap with upstream changes)

```
64249819f5 docs: remove alpha release note
e071c3321f chore: repair alpha release metadata
1bdf1378a3 docs: fold 2026.4.30 into 2026.5.2 changelog
5305b172a3 fix: honor package excludes in channel pack smoke
202b7fd597 ci: fix release publish repo context
abe2b294ae fix: align postpublish verification with external plugins
c22af827fd test: align release dependency fixture
35af235755 fix(plugins): keep bare installs on npm for launch
4b72d8e73c docs: clarify beta validation-only fixes
0f1b1e0293 fix: backport release validation fixes
d761910457 fix: backport gateway start repair
11932ccd92 build: refresh generated config schema
de42d35441 build: use ci config baseline hash
beefac0564 build: restore postbuild config baseline
c96e62d5ab build: avoid ambiguous runtime aliases
13424b9b3e test: accept externalized discord voice fallback
bf91494035 test: keep windows smoke compatible with old agent cli
8771cfb5b7 fix: resolve bundled public surfaces from packaged dist
b2c4c2daa4 docs: refresh release metadata after rebase
8ecc5fcc51 docs: prepare 2026.5.2 changelog
3d69cd0a1d test: align release assertions with beta metadata
61349d6bdc test: isolate prerelease catalog fixture
f352caf07e fix: keep runtime model auth alias after build
0126dbe171 chore: refresh stable config schema
dfad38d153 test: align stable release expectations
6cb548475e test(plugins): harden package plugin e2e lanes
13e8c49ee0 test(plugins): pin kitchen sink npm fixture
a121f98e55 test(plugins): avoid kitchen sink config drift
dd22838630 test(docker): expect discord onboard package lane
d8f31a2bfb fix(plugins): allow Discord install repair
90079f5790 test(tooling): align plugin prerelease expectations
c975bff486 fix: trusted installs
8842a5bd43 test(e2e): allow npm configured plugin installs
8b2a6e57fe docs: refresh plugin inventory for bundled channels
e9ebb6ce6c fix(release): prune externalized plugin chunks
766d02ff3b fix(build): route externalized plugin chunks
12e1c67f22 fix(build): route externalized plugin entry chunks
32e36d355d fix: recover missing Codex bound threads
079b937b46 fix(plugins): repair missing openclaw peer links on update
696f639cf6 docs: note plugin peer-link update repair
f8f18d53fc fix: start configured generation providers
cac973972c fix: slack mention-gating thread participation
9f15c29397 fix: explain missing git during plugin install
6204a6fecc fix(update): authenticate restart health probes
997f8af734 fix(whatsapp): normalize onboarding allowlist numbers
ade922ba98 fix(telegram): reuse preview for long text finals (#77658)
30b73bbf41 fix(plugins): honor beta channel for auto installs
578d9072cf test: align beta plugin repair expectations
8017dc4c3b fix(gateway): skip IPv6 loopback binding on Windows (#69701)
303ff716d4 chore(release): refresh plugin SDK API baseline
41f028e2ea fix(diagnostics): drop stale session recovery event cases
2fc80754cf ci: parallelize release publish workflows
1b8ddcf034 feat(memory-l3): add persistence layer
be97c3e7e1 feat(memory-l3): wire L1 sliding-window selector into assemble()
d24aedf762 feat(memory-l3): wire ingest buffer per session
02dab3f6d4 feat(memory-l3): wire L2 compactor with extract+update prompt v2
ac9c22395c feat(memory-l3): add retrieval scorer + assemble integration
c7ad40e35b feat(memory-l3): write L3 epoch digests at chunk boundaries
0b4e372358 feat(memory-l3): blend L3 epoch boost into retrieval + afterTurn trigger
e6c66547d2 test(memory-l3): port Loop A/C/5 deterministic regression tests
3402c982cd fix(memory-l3): make plugin actually wire into the OpenClaw runtime
0232042716 chore(memory-l3): silence success-path compaction trace + drop stale stage-2 comment
5e33cbc4c7 tools(memory-l3): add check-retrieval.mjs for live retrieval debugging
7554273485 feat(memory-l3): add long-term tier schema + storage helpers
cc5ce3c50e feat(memory-l3): consolidation scorer for cross-chunk recurrence
e52496b3f1 feat(memory-l3): write longterm.md with promotion/demotion logic
758a56763d feat(memory-l3): trigger consolidation on epoch boundaries
3079cbd95d feat(memory-l3): blend long-term tier into retrieval
ecaa663e99 test(memory-l3): port Loop E (promotion) and Loop F (demotion)
6eeb92de56 tools(memory-l3): add preview-consolidation.mjs for live promotion previews
380b30e060 feat(memory-l3): blend memory-core QMD into retrieval (cross-store tier)
ddfc333550 feat(memory-l3): mirror long-term tier into memory/.l3/<date>.md (Phase 6.3 — α approach)
81b739d607 fix(memory-l3): track compactedMessageCount per session, not engine-wide
118acaf1e2 chore(memory-l3): revert Phase 6 dry-run thresholds to production values
6062be01c9 chore(memory-fork): add merge=ours driver for memory paths
205bddff5d chore(memory-fork): trim .gitattributes — dreaming-* are upstream-owned
020d347ae7 chore(memory-fork): revert cosmetic drift in pi-bundle-lsp-runtime to upstream
65cc9786e4 chore(memory-fork): protect canonical-file fork features in .gitattributes
5c79176a6e fix(memory-l3): PROMPT_VERSION=3 — drop already-known list to fix over-suppression
24ccb1080a fix(memory-l3): tokenize preserves numerics and single digits
aff965cc69 fix(memory-l3): surface silent extract failures via gated debug logging
c4f98fcfce fix(memory-l3): drop strict zero-lexical skip on long-term tier
77494518d1 feat(memory-l3): left-brain v0 — typed facts via PROMPT_VERSION=4 + regex grounding
208e303d83 feat(memory-l3): left-brain v0.2 — surface typed facts in retrieveTopK
a4ae15940f feat(memory-l3): corpus callosum — typed-fact long-term consolidation
8ec187cdaa feat(memory-l3): cross-brain reconciliation — flag stale prose vs typed values
74d857d278 feat(memory-l3): LongMemEval adapter — first-signal benchmark harness
d6ed0153c5 feat(memory-l3): LongMemEval harness — concurrency, stratified sampling, smarter answer prompt
96ecfd5963 feat(memory-l3): LongMemEval LLM-judge scorer — calibrated benchmark numbers
cb8e66666a feat(memory-l3): LongMemEval Bundle 1 — +16pp via no-UNKNOWN, CoT, semantic embeddings, top-K bump
84dc7f7b18 feat(memory-l3): timestamps + soft guidance in memory section — 64% → 70% LLM-judge (+6pp)
092e7bfb2a feat(memory-l3): clarify recall-vs-event in memory section — temporal-reasoning recovers (70% → 71%)
2c2fa75b6d fix(memory-l3): tolerate alternate field names in extract parser (silent fact loss bug)
97c0fe3274 feat(skill-forge): autonomous self-improvement pipeline (Phase 1–5)
adfb6c8022 docs: add FORK.md — comprehensive fork documentation
d8a5420dd0 feat(memory): add hallucination reduction prompts to memory section
3daf4ddbae docs: add Cortex branding to README
ffecd91528 docs(fork): add comprehensive .gitattributes protection for all fork features
6acee50fd2 feat(fork): merge guard system — 4-layer upstream merge protection
e0601bbda9 dev: add dev-restart.sh for build + gateway restart
fdd6fb50ec dev: dev-restart.sh uses full build (build-all), not just ui:build
e57804c7bc feat: daemonized restart via double-fork for agent-initiated restarts
a170e44e5b feat(memory-l3): add BM25 scoring signal and reasoning field to L2 facts
58ac7c5be9 feat(memory-l3): implement 5 research-backed improvements
44601b98bf fix(memory-l3): epoch-grace archival loop + test fix
abbb6bb2ff feat(memory-l3): ZenBrain layers 5, 7, Hebbian learning, emotional tagging
cdb9fc3c0e feat(exec-policy): TOML-based exec allowlist/denylist (44 tests)
50d5003e69 feat(memory-l3): embedding-based semantic dedup and retrieval (Option B)
36acfba060 feat(memory-l3): Phase 2 & 3 — LLM-driven decisions/actions, message-level index, entity extraction, dynamic importance
a1d0f88a67 feat(transcripts): generate embeddings for session summaries
d73b30ec2c fix(ui): avatar URL cache-busting to prevent stale images after update
19f6113b1f chore(workboard): enable by default
f2f150256d chore(canvas): rebuild bundle hash
b1208374fe feat(ui): wire avatar lightbox into chat and quick-settings avatars
759d1b5fb5 feat(workboard): Phase 1 core integration — lift-and-shift from plugin
37ccb50f7e docs(workboard): expanded Phase 2 deep-integration plan
d0e97e0422 feat(workboard): Phase 2.5 — core CLI integration
c8e700bfa1 chore(workboard): cleanup — remove old CLI files replaced by core registration
6fa7c95c9f feat(workboard): wire gateway handlers into core startup
2fe8f9d5eb fix(conversations): pass row object to isSessionRunActive instead of status string
c139166a4d fix(gateway-protocol): raise chat.history/startup limit cap to match whole-history requests
4a3475af6d feat(ui): sub-label Kimi Code plan vs pay-as-you-go models in the composer picker
98d978fe2c chore(fork): protect full fork surface in .gitattributes
f690ea22d3 chore(fork): protect badge/timer + merge-repair surface in .gitattributes
17ed656984 fix(telegram): reject webhook payloads without a valid update_id envelope
c9f14e3e2f fix(agents): restore memory_get catalog entry; align tool-list test expectations
c68ec33b4d feat(memory-l3): add read-only memory_insights agent tool
301938e1ed feat(memory-l3): certainty-aware promotion, information gain, segmented compaction, 2-hop hebbian
221a75db86 feat(skill-forge): session success score gates skill promotion
12ac7575df feat(memory-l3): revision history for long-term prose facts
fcedefc2ca test(memory-l3): fix stale hierarchical-l3 engine id assertion
4a760c56bf test(skill-forge): add successScore to candidate fixtures
cebd9c336e fix(memory-l3): declare memory_insights in contracts.tools
253b3522c7 feat(memory-l3): ingest Claude Code session transcripts
85f851f37d feat(model-catalog): Anthropic-protocol discovery + live display-name refresh
7faecfaffd feat(doctor): auto-repoint silently-upgraded model pins in doctor --fix
90cb824f95 fix(doctor): drop redundant source alias instead of clobbering an aliased target
2c6efc32a5 fix(gateway): gate cron completion announcements on the completion destination mode
a6ad74561b chore(lint): drop 2 unused eslint-disable directives in agentmcp schemas
bc3efa6eee fix(workboard): correct off-by-one relative import paths
176936e957 fix(workboard): repair live store types, delete dead superseded modules
68d2fa4eaf feat(skill-forge): wire embedding clustering + llm-replay judge lanes
70d515f0fe fix(compression): clear mechanical type errors + type the ccr retrieve tool
eb51d7a4d2 fix(compression): remove superseded cache-aligner, fix tool-result content typing
f0bfc61a9b feat(control-ui): finish skill-forge grid view
0293c38919 feat(delegation): move agentmcp tools into core; config-driven router + fallback
a7b3e31c11 feat(daily-research): Sufficient Context Agent for memory-l3 (2026-06-17)
1b36092a28 chore(cron): isolate LLM-research pipeline in a git worktree
f85a8975d6 chore(cron): repoint deploy pipeline from memory-fork to main
3f25b47a41 feat(ui): channels configure modal for Quick Settings add button
147250c3c2 chore(canvas): sync a2ui .bundle.hash with committed bundle inputs
4c252d9a9e feat(cron): add pre-deploy build gate for the Validate & Deploy pipeline
415aec91b4 feat(cron): deterministic test gate + post-deploy health check
d8575be85d refactor(swarm): remove dead v1 swarm-loop pipeline
1a2c64c7fc feat(swarm): centralize v2 result helpers + adversarial verify_claims layer
fe3c6b79e5 fix(swarm): address code-review findings in verify_claims layer
ef6bd257f8 chore(swarm): apply oxfmt formatting bypassed by earlier --no-verify commits
```

---

## CONFLICT — 167 commits (touch >=1 file upstream also changed)

```
8412f3369d chore: bump 2026.5.2 alpha 1
afd8ad14b2 chore: switch 2026.5.2 prerelease to beta 1
4dc9c43df8 fix: stabilize beta update and OpenAI transport paths
793485a472 chore: bump beta release to 2026.5.2-beta.3
57b158ff90 chore: prepare stable release metadata
0accc7f745 fix(channels): keep matrix and mattermost bundled
e0002c4b5b chore(release): prepare 2026.5.4 beta 2
8f6bf65162 fix(agents): enforce exact skill path from <available_skills> [AI-assisted] (#74161)
b73317c217 fix(sandbox): support Windows drive-letter bind sources
5fcdeae80c chore(release): bump to 2026.5.4-beta.3
325df3efef chore(release): bump to 2026.5.4
61ede61bf0 feat(memory-l3): scaffold hierarchical context engine plugin
f781c31fbe Merge upstream v2026.5.4 into memory-fork (staged catch-up leg 1/2)
c9aacb676b Merge upstream/main into memory-fork (staged catch-up leg 2/2)
33eb8c6e33 chore(deps): add sqlite-vec-darwin-arm64 for forward arm64 compat
f904759007 Merge upstream/main into memory-fork (catch-up 2026-06-02)
8850b8fabc feat(ui): stream LLM thinking to Control UI in real-time
69ffe49b99 feat(agents): cherry-pick three improvements from OpenCode comparison
09a3885daf feat(agents): cherry-pick three improvements from OpenCode comparison
83bb0cf347 fix(build): correct doom-loop-guard import path in run.ts
8e845f6710 fix(types): add doom_loop status to SessionRunStatus and TaskStatus
ddabfe6576 Merge remote-tracking branch 'upstream/main' into memory-fork
f1aff80861 chore: update pnpm-lock.yaml after upstream merge
de5cce54c1 fix: resolve merge build errors and restore fork features
fc855b7462 fix: clear update banner when resolved version equals current version
47b8b6b4d5 feat(ui): dynamically show active directory in workspace rail
ffe7c447bb feat(ui): highlight active file in workspace rail
75a109b51a fix(ui): workspace tracking handles all message shapes, no workspace filter
b851957ba8 fix(ui): workspace rail - skip toolResults, add exec to tool names
f9e45def9c feat(ui): workspace rail shows files from active directory
12a45296ba feat(ui): open files from active directory in preview
65f4f01cdf feat(ui): file type icons for workspace rail
832dcf8574 feat(ui): line numbers in code blocks + revert emoji file icons
6efd33f787 feat(ui): auto-preview files when agent reads them
52173444ae feat(ui): auto-preview, IDE code viewer, workspace scroll, layout polish
16bf0c98af fix(ui): syntax highlighting colors for code viewer
363b3f0cb8 feat(ui): reading scan line effect, edit diff preview, syntax colors for code viewer
310feb4e67 feat(ui): edit diff detection (recently-completed approach)
4c5b959417 UI: inline edit diff preview with scan-to-diff animation
263b0ee0f7 UI: write tool detection — auto-open new files, diff writes to existing files
c473003424 UI chat: fix streaming/queue bugs, always-show context badge
928fdf0aa3 UI chat: fix follow-up delivery — send immediately via sendChatMessageNow
3e7f37c4c3 UI chat: P1 — prominent reading indicator + history refresh stream guard
62574cb435 UI chat: P2 — atomic stream→final transitions
39db3ec38a UI chat: fix thinking indicator flash — defer chatSending clear until run ends
0a28090013 UI chat: live elapsed timer — ticks every second while thinking
0172522fd8 UI chat: live ticking timer with stable send-start timestamp
5c1bc34bed UI chat: fix thinking timer — set chatStream on send to activate tick interval
006806694f chore: remove debug console.log from thinking tick interval
079e474831 UI chat: fix thinking indicator killed by history refresh — guard empty stream
b94afcab3b UI chat: runId-based thinking indicator — survives tool execution
d96ed6c821 UI: chat grouping, code viewer, reading/edit effects, layout polish
5b112c4286 Merge upstream/main into memory-fork (auto-sync 2026-06-06)
0b240bcfb0 Merge upstream/main into memory-fork (auto-sync 2026-06-06)
d57ab0744a feat(ui): chat tab bar + fix workspace file loading
2954336d4e fix(types): correct bash-tools exec policy types
b2f1e79150 feat: attestation module — 4-layer cryptographic provenance (72 tests)
6a66d28248 feat(compression): context compression pipeline — all 5 phases (75 tests)
beed11ae86 Merge upstream/main into memory-fork (auto-sync 2026-06-07)
ef660e2a3a wire onResponse into Google and Mistral providers for attestation
ebf82b7805 deps: add smol-toml for TOML config parsing
d1073c3b18 feat(sandbox): configurable OS-level sandbox (Seatbelt) for host exec
4c5c425641 feat(chat): session branching — chat.branch and chat.branches gateway methods
a1e0ac1b97 feat(ui): chat branching, tab persistence, avatar lightbox, history expansion
0ca01728dc fix(embedded-agent): compression module type safety + providerResponseHeaders
837ebb7a44 fix(ui): WebRTC ICE gathering completion before SDP offer send
aa20e474f3 feat(ui): add tab status indicator — spinning circle while working, bouncing red dot when done
4c7565f991 feat(ui): pixel-office foot stomp animation + workboard scroll fix
06a4ed3848 feat(workboard): Phase 2 — DB merge + subagent wiring + TypeBox fix
5569220606 feat(workboard): Phase 2.2 — core gateway method specs + API bridge
14e83c5185 chore: delete extensions/workboard/ — fully replaced by core src/workboard/
fa28adc3f6 feat: Skill Forge replaces Skill Workshop — full UI + backend swap
9e15537a1b feat: session awareness + workboard project CRUD + channel nav fixes
25c18ed479 feat(ui): context meta expanded by default; agent dropdown shows model instead of duplicate ID
c6dc631d34 feat(ui): move Workboard to top of control submenu; fix Usage page lazy-load
23a95dd43d fix(ui): remove stray ch.key references breaking channels and recent menu
e7e20ed736 fix(ui): remove remaining stray ch.key references from click handlers
7f5c579e49 feat(ui): add Crew.md panel to agents overview
f80fe94be0 feat: add All sessions button to session picker dropdown
87ebef7965 feat: dedicated conversations page with search and click-to-chat
d82bb4abbf fix(conversations): load sessions when navigating to conversations tab
8e911660a9 fix(conversations): include global and unknown sessions in conversation list
9786255448 feat(conversations): add first-message preview to conversation rows
08d9b903e2 fix(conversations): load all agents' sessions regardless of selected agent
c31629b4d1 fix(agents): synthesize tool results for strict openai-completions replay
1be5d2ed89 feat(conversations): surface thread's first user message as row preview
e459cb2ba7 feat(conversations): add per-row delete button
559b948243 feat(skills): load skill-forge promoted skills into the skills list
d5f655bfb3 fix(conversations): hide delete action for the protected main session
7103a0b6d6 feat(chat): defer session registration until the first message is sent
dccff77a42 feat(chat): always load and render the full session history
0c83af4ed5 fix(chat): wire message edit save to the branch+resend flow
0902ed6412 feat(chat): track per-turn file changes and offer code rollback on message edit
3c22dfa039 feat(models): always extend failed model calls through all configured models
386e9160a7 feat(chat): reflect served fallback model in session override and composer picker
49dd7bfece feat(ui): decouple agents from models in the sidebar
dd05718600 fix(ui): stop sidebar model select overlapping the agents dropdown
bbcaba4b51 feat(ui): make sidebar agent picker select the new-session combo without switching chat
eea0b3b0d5 fix(ui): guard chat history pagination against stale session and reload races
4e43a7e827 fix(ui): stop superseded chat scroll chains and manual retries from re-pinning scroll
7c7a62264b fix(ui): drop stale model catalog results from a replaced gateway client
a3413719cb fix(ui): keep the thinking indicator alive across concurrent chat sends
540279f817 fix(ui): defer session.message history reload while a chat send awaits its ack
fbb0fa014e fix(ui): skip earlier-load scroll restoration when the page load was discarded
5d5c223670 feat(gateway): self-restart when dist rotates under a live process
b8a5231597 feat(ui): realtime context token badge, per-second thinking timer, compaction-in-badge
3883b7ffce fix(build): stop entry-dts cache from restoring stale private-subpath forwarders
5cb7f5e206 fix(ui): port upstream stream-reconciliation + forwarded handoffs; realign tests with fork behavior
99c1b8beb0 feat(protocol): single-source gateway event schemas (session rows, approvals, presence, chat timing/side-result)
ed604d7933 refactor(gateway): derive session/approval/presence event payloads from protocol schemas
ee9e58960a refactor(ui): alias gateway wire types; drop drifted session-row fields
530ad036bc feat(cron): support announce-mode completion destinations
6dfb79c34f feat(hooks): bundled message-completion-notifier; thread cfg into message_sent context
5183c4f47f feat(agents): add memory_insights read-only tool
fa30de91be refactor(agents): reuse shared transport stream helpers in OpenAI/Azure transports
b4184e1bfc feat(agents): set AI_AGENT=openclaw in exec shell environment
0b43bfadf6 i18n(ui): add channels/conversations nav and linked-agent description strings
8e29c85edc style(ui): code viewer + syntax highlight styles; oxfmt CSS reflow
3d552efab3 chore: formatting and typing cleanups (workflow yaml, agentmcp, d.mts shims)
80dde7b0d1 fix(cron): add completion columns to schema baseline; type announce threadId + optional job
fd77326e6b fix(skills): complete skill_forge swap — repoint approval gate, codex guidance, retire dead workshop tool
f8300651e8 feat(skills)!: remove Skill Workshop — Skill Forge is the only skills pipeline
cdfcdb2ca9 fix(agents): clamp cron idle watchdog to default so stalled model calls fail over
9671bb3c27 feat(skill-forge): record skill usage on SKILL.md reads and run LLM distillation by default
49dad30c8f feat(ui): auto-follow tool calls during live chat runs
b023d08cfb feat(ui): expand truncated user messages to full text
6a0f185bb2 fix(ui): stabilize live tool-card keys to stop preview animation loop
8d11870b0c fix(ui): keep run spinner alive on mid-run hasActiveRun:false blips
65a5551edb feat(ui): agent PFP crop routing + message-edit UX
29c0fce0a1 fix(hooks): register message-completion-notifier and forward the agent reply
4bd2bb7968 fix(ui): keep run alive on stale {status:done, hasActiveRun:true} rows
a05becbf93 fix(auto-reply): retry steer across compaction instead of whole-run demotion
afd7be79fc feat(agent-core): opt-in cooperative steering preemption of in-flight tools
a6beb95b86 fix(agent-core): preempt batch when a steer is queued during streaming
72183d0b9a feat(model-catalog): live provider model discovery + deprecated-model reassignment
bada55e09c feat(onboard): auto-discover provider models after a service is configured
0be5ff7767 feat(model-catalog): harvest served-but-unlisted models via response probe
a5bb5d26df fix(embedded-runner): don't trip the session takeover fence on a legitimate session-file creation
6be0d83d32 feat(auto-reply): steer a follow-up into an active run and deliver its reply to webchat
ead629dc38 fix(ui): match chat events for sessions selected by a bare key
d63c9b9edd fix(skill-forge): auto-invoke recovery skills, dedupe forging, wire CLI
82c650856d fix(auto-reply): surface a calm busy notice when a live run holds the session lock
ba39cdc0bd feat(vault): model-blind, egress-bound secret vault
240d1babf8 feat(ui): composer control buttons + live elapsed badge
02c2194708 feat(agents): read-before-edit guard, session read-ledger, web egress allowlist
6610fc0341 chore(lint): clear preexisting lint debt in exec-policy + session-awareness
3bfb8cb01f chore(lint): repo-wide safe autofix + exclude generated bundle
ca1de1efb0 test(agents): activate property-based test harness
c3d70a786d fix: clear tsgo:core typecheck baseline + workboard create RPC
ea17fe2468 feat(agents): opt-in grounding faithfulness gate + metrics
424b6013d4 feat(ui): ESC to interrupt run; double-ESC edits last message and branches
52b751f3c1 fix(ui): defer ESC abort so double-press edit keeps the transcript
d77cb90b07 feat(ui): inline model dropdown in Quick Settings
9a8ea5667c feat(gateway,ui): preserve dashboard chats on reset + confirm before wipe
d1aed5d65b feat(ui): show all agents in Personal card with per-agent avatars
cb079223f7 feat(ui): compact channel configuration cards
d0b68cfbd2 feat(ui): channels config as tiles opening a focused modal
ea42832aec feat(ui): collapsible Telegram channel card showing metrics by default
16e6abde60 feat(telegram): order primary channel config fields first
5f9c07e2dd fix(ui): load model catalog on config tab so Quick Settings dropdown populates
68c4b0f0f9 fix(ui): pack config fields into responsive columns, span structural cards full-width
ba77f906fe fix(workboard): unify CLI and gateway on the shared core DB
9a819a3e4e feat(workboard): close the idea-to-task LLM loop
c700d388a7 feat(ui): consolidate channel config into Channels tab, move Vault into Settings
70b82ea20d test(workboard): adapt board tests to sectioned layout
f6046bfee9 test(ui): cover config tab loading skills and cron for Automations card
c9cedb1413 fix(hooks): make pre-commit node-tool runner TTY-safe
```
