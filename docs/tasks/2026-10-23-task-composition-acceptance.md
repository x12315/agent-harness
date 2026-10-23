# Task composition acceptance

Status: delivered to the standalone workspace; performance acceptance remains incomplete as documented below.

## Delivery contract

Extend the existing coordinator ledger, native GoalService executor and Observer. A natural-language request can atomically create, fork, decompose, revise, control, associate or merge tasks. Source history, parent coverage and execution dependencies are different relations. Communication and proposals carry data, not delegated authority. No new agent runtime or task database.

A committed graph transaction is not a rollback guarantee for file or external effects. Pending stops and unknown native state occupy execution capacity. The standalone workspace uses one concurrent writer; branching does not grant parallel execution or new permissions.

## Evidence tiers

- **Deterministic:** 182 coordinator, graph, recovery, executor, coverage, protocol and client tests passed. These include injected model responses and simulated failures; they do not prove model understanding.
- **Real model interpretation:** designated `qingxian-high/gpt-6-luna`, bounded no-tools calls. The 16-case baseline gave 13 direct passes. Two retrieval failures were repaired and passed in a separate current-source rerun: genuinely omitted authentication/login history and a named omitted original clause. One discussion-only response asked an optional boundary question rather than explaining immediately; it did not execute anything. Count that as an unnecessary clarification, not an unsafe action or a clean 16/16 quality result. Earlier envelope/scope-mode failures are retained. The corrected historical fixture omits the target; the original 61-task fixture did not.
- **Real execution:** continuation and merge passed on actual seed/findings/draft/report files; the draft proof did not launch another native execution. A separate real communication acceptance passed: completed producer stayed verified at the same revision; a completed independent recipient received a bounded followup, identified the actual message ID and `retry-budget` finding in its native report, independently passed review/coverage, and preserved all file bytes. Service cleanup confirmed.
- **Guest UI/protocol:** earlier browser passes cover fork, proposal confirmation, mediated messages, direct merge, reload and desktop/mobile. Frozen-source native, Observer and desktop/mobile browser cases all passed: `20261023T065031Z-38920`, `20261023T065143Z-39658`, `20261023T065344Z-40932`. Fixed local provider responses prove integration, not Luna quality.
- **Control plane:** six layers passed; installed canonical doctor exited 0. Do not apply the worktree doctor's proposed canonical projection changes. After one concurrent run exceeded installed Catalog-merge test deadlines, an isolated final doctor passed in 102.984 seconds. That timeout remains recorded. Current-source independent review found a direct-ingress replacement validation gap; central graph validation and an atomic no-partial-commit/no-dispatch ingress regression cover the repair.

Private operational artifacts are retained under the operator's `coordination-practice` directory. Failed runs remain failures; later passes have separate reports. No credentials or authentication state belong in these records.

## Requirement matrix

The rows map the full B01–B24 specification to concrete checks, rather than treating a valid JSON response as successful task understanding. Test paths below are relative to `adapters/pi/coordinator-webui/` unless stated otherwise.

| ID | Required behavior | Deterministic evidence | Operational evidence / limit |
| --- | --- | --- | --- |
| B01 | Durable intake during running work; preserve source and fork report | `coordinator.test.mjs`: receipt before classification, held worker; `task-composition.test.mjs`: multi-operation transaction | Frozen native guest ingress and real-model fork/continue interpretation passed |
| B02 | Amend same goal without an invented fork | `routing-contract.test.mjs`, `task-graph.contract.test.mjs` | Same-goal and multi-target interpretation; no new execution solely from omitted/invalid interpretation |
| B03 | Two branches and source pause commit together | `task-composition.test.mjs`, `branching.integration.test.mjs` | Native controls distinguish requested stop from settled stop; no replacement while stopping |
| B04 | Fork paused/completed source without waking it | `task-composition.test.mjs`, `branching.integration.test.mjs` | Real branches derived from an already verified investigation; source remained verified |
| B05 | Material ambiguity gets one bound clarification | `routing-contract.test.mjs`, `routing-boundaries.test.mjs`, `branching.integration.test.mjs` | Real ambiguous-continue interpretation; original request and answer retained together |
| B06 | Older semantic reference plus complete context access | `routing-boundaries.test.mjs`: historical index pages, omitted middle, unobserved-ID guard, bounded reads | Actual Luna case passed with 161 tasks and an authentication/login synonym mismatch; query-matching original excerpts also passed. Up to three lookup pages and three context reads per classification; capacity exhaustion is explicit, not a guessed target |
| B07 | Control named report/investigation only | `task-composition.test.mjs`, `branching.integration.test.mjs`; existing targeted-resume tests | Frozen native guest pause/resume/cancel and real-model selective-control interpretation passed |
| B08 | One input updates both selected tasks | `task-composition.test.mjs`, `routing-contract.test.mjs` | Real two-target amendment interpretation, with explicit additive/replacement mode |
| B09 | Decomposition preserves parent integration goal | `task-graph.contract.test.mjs`: parent invalidation, all children only unblock integration | Parent native execution still needs whole-objective acceptance; child count is never a pass |
| B10 | Derivation does not impose an execution dependency | `task-graph.contract.test.mjs`, `task-composition.test.mjs` | Read-only source findings remain references, not an implicit prerequisite |
| B11 | Draft ready now; final waits for exact verified stage | `task-graph.contract.test.mjs`, `branching.integration.test.mjs` | Real draft/final continuation passed. Gates are whole-task verification, not executable free-text predicates; finer stages must be separate tasks |
| B12 | Cancelled prerequisite blocks rather than cancels consumer | `task-composition.test.mjs`, `branching.integration.test.mjs` | Gap identifies the unavailable prerequisite; no invented result or silent cascade |
| B13 | Pin source evidence; invalidate affected dependencies, not everything | `task-graph.contract.test.mjs`, `composition-recovery.test.mjs`, `task-context.test.mjs` | User scope changes invalidate dependent proof; same-scope coverage/delivery rounds preserve the pin. No filesystem watcher or universal artifact freshness oracle: excerpts are historical, and the native worker must inspect applicable current artifacts before reuse |
| B14 | Stable retry ID prevents duplicate logical work | `coordinator.test.mjs`, `composition-recovery.test.mjs`, client outbox tests | Browser reload preserves request IDs and committed graph; same ID/different content rejected |
| B15 | Crash boundaries do not leave half a graph or repeat unknown effects | `composition-recovery.test.mjs`, `coordinator.test.mjs`, `webui-executor.test.mjs` | Retained experimental interrupted-start failure is explicitly unknown, not replayed. Restore reconciles known native handles; an unannounced start can require operator reconciliation |
| B16 | Stale versions, unknown identities and cycles rejected atomically | `task-graph.contract.test.mjs`, `task-composition.test.mjs`, `routing-boundaries.test.mjs` | Explicit model revisions are preserved for graph CAS, never silently replaced with current values |
| B17 | Branching does not bypass shared-workspace writer limit | `branching.integration.test.mjs`; native cessation/slot tests | Standalone max concurrency remains 1; stopping/unknown runs retain the slot |
| B18 | No configuration/permission expansion through model output or fork | `routing-contract.test.mjs`, `index.test.mjs`, `webui-executor.test.mjs` | Loopback/native identity, cwd and goal ownership checked; unavailable authority blocks only its task. No claim of arbitrary parent TUI tool-ceiling inheritance |
| B19 | Source and branch verify independently | `task-graph.contract.test.mjs`, `branching.integration.test.mjs` | Real investigation, draft/final, merge and independent communication recipient verified separately |
| B20 | Cancelled necessary child leaves parent incomplete | `task-composition.test.mjs`, `task-graph.contract.test.mjs` | Parent dependency gap stays open; no parent pass based on remaining child count |
| B21 | Background/other-tab events do not silently change reference focus | `routing-contract.test.mjs`, `routing-boundaries.test.mjs`, `branching.integration.test.mjs` | Focus is persisted per conversation; browser session storage isolates tab focus |
| B22 | Discussion/suggestion is not execution permission | `routing-contract.test.mjs`, `task-composition.test.mjs` | Proposal creation does not execute it; exact explicit acceptance revalidates every operation |
| B23 | UI and language share graph checks, idempotency and lifecycle | `experience.test.mjs`, `index.test.mjs`, `branching.integration.test.mjs` | Frozen guest fork/merge controls, proposal confirmation, receipts, reload and desktop/mobile passed |
| B24 | Explicit scope reduction and separately verified integration | `task-graph.contract.test.mjs`, `routing-boundaries.test.mjs` | Every revise plan selects `replaces` and supplies the complete new acceptance array on replacement, including direct ingress and proposals. Real merge and scope-reduction interpretation passed |

## Communication and atomic rearrangement

Additional integration checks cover:

- owner-pinned source excerpts, redaction and complete-message context limits;
- only message IDs actually in a native handle being marked injected;
- injection not being represented as reading, agreement or acceptance;
- completed-recipient followup without reopening the producer;
- explicit proposal acceptance/rejection, stale proposal validation and no self-approval;
- merge preserving original scopes, constraints, native evidence references, messages, aliases and history;
- a merge with an unresolved internal prerequisite being rejected, not silently deleting the gate;
- bidirectional messages using pre-commit source snapshots;
- exact normalized-goal duplicate notices without automatic semantic merging.

## Performance evidence gap

A real installed `harness benchmark --runs=3` attempt failed in serial round 1: 162,346 ms, exit 1; the control-plane verifier exceeded its 150-second subprocess deadline. No successful parallel median or baseline comparison exists. The report archives installed Engine `0146d48` dirty and Catalog `d55f9a1` dirty, fingerprints, coverage and the failed sample. This installed control-plane measurement is not feature-branch task latency. Canonical sources/projections were not modified. Direct control-plane and parallel doctor passed separately; that does not turn the failed benchmark into a pass. VM/model-fixture timing is not used as a substitute.

## Standalone rollout and remaining limits

The port8793 standalone instance was snapshotted and updated from the validated source. Post-restart checks verified both installed plugin source pins, HTTP/page readiness, the same model/workspace, all original task IDs/revisions/scopes/statuses, all 50 input IDs across two namespaces, unchanged private/plugin settings, and the same independent port8787 listener. The existing paused task remained paused. No test goal was submitted to the user's live ledger. Private rollback copies contain only the owned ledgers/plugins/configuration, not native authentication/provider files.

Remaining: the failed installed serial benchmark has no accepted median/baseline; one discussion-only model response asked an optional clarification; artifact freshness and other declared first-version boundaries remain explicit. These do not become successful acceptance evidence merely because the functional rollout passed. Save the reviewed source on the existing feature branch/PR without merging main.

This is evidence for a usable first version, not proof of arbitrary external-side-effect rollback, complete artifact freshness, unlimited context, generic multiwriter scheduling or autonomous operation while the server is closed.
