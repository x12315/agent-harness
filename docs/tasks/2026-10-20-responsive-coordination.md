# Responsive coordination first practice

## Goal and authorization
Implement the user's responsive, persistent, wall-clock-aware task coordination idea by integrating already installed Pi Web UI background executor and independent goal review, plus existing Observer presentation. Test through x12315/agent-harness-sandbox. User authorized starting implementation and long-task execution; no system service installation, password changes, force push or main merge.

## Source and isolation
- Engine worktree: /Users/montana/Projects/pi-responsive-coordination, branch feat/responsive-coordination, baseline 0146d48.
- Existing Engine/Catalog worktrees are dirty and must not be overwritten. New files/isolated branch only.
- Sandbox: /Users/montana/Desktop/agent-harness-sandbox, baseline 822a6cb, existing untracked cases untouched.
- Installed Web UI 0.100.0 and Pi 1.1.0. Existing macOS guest base has Web UI 0.96.1/Pi 0.87.1; compatibility must be measured, not assumed.

## Required first-version behavior
1. Natural-language input durably received before classification or execution; no user-maintained message queue.
2. Independent foreground interpretation while native Web UI goal executor runs; use native auditor/continuation, not another execution engine.
3. New tasks, questions, corrections and pause/resume/cancel routed with persistent IDs and revisions; ambiguous targets ask only necessary clarification.
4. Original objective remains recorded; a correction does not silently replace it; native goal approval plus current-revision validation required for completion.
5. Real-time checkpoints independent of user turns; bounded concurrency/time/review and safe pause/cancel gates.
6. Durable pending input survives reload; uncertain dispatched work is reconciled, never blindly restarted.
7. Existing Observer remains independently compatible; do not infer goal success from observer attention.

## Implementation choice
Add an opt-in Web UI coordination plugin in Engine. Reuse native public WebSocket protocol for dedicated worker/reviewer conversations and host.llm.complete for lightweight foreground intent interpretation. The native GoalService owns executor + audit loops; coordinator owns ingress/revisions/budgets only. Use a plugin tab with a free-form composer; no required slash syntax. Existing standard conversation UI remains unchanged.

## Acceptance evidence
- Pure state/queue failure tests, actual Web UI protocol fixture with bounded loopback provider, guest VM consumer case.
- Verify input acceptance and question/correction before held task release, independent native goal review failure/continuation, timer without user input, pause/cancel, reload, stale result rejection, no external model calls in fixture.
- Separate deterministic protocol/fixture verification from real-model intent quality; no claims of universal prediction or gap coverage.

## Progress
- Inventory complete: native Web UI GoalService/background executor found; pi-goal-x source exists but is not enabled in current Profile.
- harness status now passes (previous ponytail issue no longer present); both original repositories still dirty.
- Isolated Engine branch created. Read sandbox consumer/security/routes/assets instructions; no VM started yet.

## Implementation milestones
- Added opt-in coordination Web UI plugin, persistent raw-input receipt and request-ID deduplication, original-request retention, revision-aware queue, real clock checkpoints, native WS executor adapter, free-form UI with persistent browser outbox. Native Web UI remains executor/reviewer owner; Observer remains untouched.
- Independent reviewer found seven P1 issues. Fixed owner handoff/write fencing on reload, workspace isolation, pause/resume/revision/pass interleavings, native control target checks, and browser outbox. Core/plugin/adapter unit tests now 49/49 passing. More runtime validation remains.
- Original `harness status` succeeds; prior ponytail problem no longer present. Original dirty worktrees untouched.

## Experiments and setbacks
1. VM old base (`ahsb-macos-runtime-20261010T071746Z`): runtime Pi 0.87.1/WebUI 0.96.1 valid, but new native role-based GoalService absent. First fixture also detected a blocked startup catalog fetch; disabled via supported `PI_WEB_PLUGIN_CATALOG_URL=off`. Evidence: `~/ahsb-build/runs/macos-responsive-coordination/20261020T104625Z-87729/`.
2. Independent sandbox worktree `/Users/montana/Projects/coordination-sandbox`, branch `test/responsive-coordination`, pins Pi 1.1.0/WebUI 0.100.0. New base prepared successfully without modifying old base/profile.
3. Matching top-level versions were insufficient: WebUI startup failed because npm selected Pi codemode 1.3.0 under ^1.1.0, missing MCP_TYPESCRIPT_PREAMBLE. Evidence: `~/ahsb-build/runs/macos-responsive-coordination/20261020T105424Z-19225/guest/tmp/ah.err`. Added explicit overrides for the matching Pi 1.1.0 package cohort in the isolated sandbox lock. Preparing a second new base `ahsb-coordination-runtime-aligned-20261020`; log `~/.local/state/harness/coordination-practice/prepare-aligned.log`.

4. New aligned base initially lost node-pty spawn-helper executable mode after immediate VM stop: guest diagnostic found mode 0600 and posix_spawnp failure. Added `sync` at the end of the trusted runtime preparation recipe, prepared a fresh durable base `ahsb-coordination-runtime-durable-20261020`; the next fresh clone passed native PTY and started Web UI 0.100.0 and the actual coordination plugin. Old bases remain untouched.
5. Actual plugin classifier host wraps system instructions into its user envelope; corrected the deterministic fixture parser (not production classifier). Latest scenario is running; log `~/.local/state/harness/coordination-practice/vm-durable-2.log`.
6. Independent follow-up review found two remaining shutdown/reload races; fixed immediate shutdown routing fence and retaining pause proof until successful native resume. Unit tests now 52/52. Added opt-in execution disabled by default because arbitrary parent tool-ceiling inheritance is not yet proven.
7. Engine worktree `node scripts/test-control-plane.mjs`: exit 0, six layers including real RPC/TUI. Installed `harness doctor`: exit 0; it validates existing installed Engine/Catalog, not rollout of this new plugin. Logs in `~/.local/state/harness/coordination-practice/{control-plane,doctor}.log`.

8. Added a separate no-tool whole-objective coverage gate after native functional pass. Existing-scope missing requirements automatically create at most two repair revisions; uncertainty pauses. Exact requirement quotes are required, original raw text remains binding. Independent review caught coverage-only resume replaying native work; saved native completion proof now permits coverage-only recheck without repeating execution.
9. Real VM exposed an early progress event arriving before start returned: core marked running before saving the control handle, so the returned handle was discarded. Fixed reservation/progress ordering and added a regression test.
10. Full native/plugin VM scenario PASS: `~/ahsb-build/runs/macos-responsive-coordination/20261020T112249Z-4037/`. Actual plugin accepted/answered while native executor was held; timer fired; native fail→retry→pass; queued task passed; native pass followed by whole-objective coverage failure automatically repaired once without a user reminder. This is deterministic local-provider protocol evidence, not actual-model reasoning quality.
11. Extended the next VM scenario to require actual native pause/resume and targeted cancellation; running with log `~/.local/state/harness/coordination-practice/vm-controls.log`. Final source identity must be checked against this run after current fixes.

12. Extended native controls scenario passed twice in fresh clones: `~/ahsb-build/runs/macos-responsive-coordination/20261020T115221Z-8833/` and `20261020T115407Z-9557/`. One prior run exposed redundant telemetry fsync starving receipt latency; coalesced unchanged native evidence and skipped no-op state writes, with regression coverage.
13. Stronger real-tool scenario PASS: `~/ahsb-build/runs/macos-responsive-coordination/20261020T115819Z-11695/`. The mock model invoked the actual native bash tool to start owned long-lived Node processes. Frontend questions were processed while a tool process was demonstrably alive; pause/resume and targeted cancellation completed, and owned tool PIDs were verified gone. Actual plugin coverage repair also passed. Executed source hashes match all final application files. Three controlled receipt latencies: 27/11/21ms; these are fixture measurements, not real-model ETA or production performance claims. Model fixture had 36 bounded local requests, no external network attempts.
14. Final unit tests: 62/62 Engine coordinator tests; 13/13 sandbox recipe/runtime/consumer tests; `git diff --check` and secrets scans passed for both worktrees. Existing installed control-plane/doctor evidence remains as above; new plugin is not globally installed or enabled.

## First-practice result and remaining goal
The opt-in Web UI prototype is implemented and VM-tested, not a complete delivery of the user's broader leadership system. Published draft PRs: Engine https://github.com/x12315/agent-harness/pull/4 (base `feat/catalog-resource-sync`) and sandbox https://github.com/x12315/agent-harness-sandbox/pull/1 (base `feat/multi-backend-cli`). These bases preserve existing unmerged work and keep this review limited to the experiment. No main merge/global profile rollout.

Outstanding acceptance work: real-model intent/coverage quality and representative complex debugging evaluation; inherited arbitrary parent Profile/tool ceilings; semantic dependency/resource-aware decomposition and multiple isolated workers; bounded anticipatory work; calibrated duration estimates; native TUI input adaptation; fully reconciled closed-server/background continuity; browser-rendered interactive UI validation beyond the actual plugin WS path and outbox unit tests. Unknown gaps cannot be proven absent. Keep these visible against the overall goal rather than calling the prototype complete automation.
