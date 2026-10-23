# Pi task coordination workspace

A directly openable, persistent coordination workspace built on **Pi 1.1.0 / pi-web-ui 0.100.0**. Reuses native executor conversations and GoalService review, not a second agent runtime. Existing ordinary chat, subagent, Observer and session-window installations are not replaced.

## Open the experience

On a prepared installation:

```sh
node scripts/pi-coordinator.mjs
node scripts/pi-coordinator.mjs shortcut
```

The first command starts/reuses an independent loopback server and opens its actual workspace page; the second creates a local `任务协调.command` Desktop launcher without installing a system service. The page is `/plugins-api/pi-coordinator/experience`, not a nonfunctional deep-link into the ordinary chat. No manual plugin configuration or queue syntax is required.

Default port: 8793. Default private runtime directory: `~/.local/share/harness/coordinator`. An initial dependency-free Node example workspace is created without overwriting existing files. The native model defaults to the user's existing selection; `--model provider/model` is an explicit standalone override.

```sh
node scripts/pi-coordinator.mjs status
node scripts/pi-coordinator.mjs stop
node scripts/pi-coordinator.mjs restart --workspace /path/to/trusted/project
```

Closing the browser does not stop background work. Stop/restart retains the inbox and native sessions; uncertain in-flight work is reconciled rather than blindly replayed. Paused work can be continued in normal language. Shutdown does not secretly leave all future intake globally paused.

## Use naturally

Describe a goal and constraints. While a command runs, ask what is happening, add another task, amend the original requirement, or pause/resume/cancel only the affected work. Task buttons submit explicit version-checked operation batches through the same durable inbox, without asking a model to reinterpret the button. They do not maintain a parallel control database.

The page shows conversation, exact original requests, amendments, native progress, elapsed/checkpoint times, coverage evidence and retained native review records. Browser outbox requests keep stable IDs across reload/reconnect, and are acknowledged only after private durable storage. Ambiguous references ask a question rather than requiring a human-maintained ID queue.

Native functional pass is provisional until whole-objective coverage is checked. Genuinely missing original requirements trigger at most two bounded repair revisions. Repair reuses completed evidence and does not blindly repeat already completed long commands. Failure/uncertainty stays visible instead of becoming success.

## Related work, communication and atomic arrangements

Use ordinary language, for example:

- “原调查继续，另开初稿与终稿；终稿等初稿通过，两项分别验收。”
- “把调查任务已有发现转交给报告任务核对，不扩大范围。”
- “这两项其实属于同一需求；先给合并方案，等我确认。”
- “把终稿并回初稿，保留两项全部要求、证据和历史。”
- “调查负责根因、报告负责整理；把分工和等待关系一起调整。”

The coordinator owns three distinct relations: `derivedFrom` pins provenance without imposing a wait, `partOf` retains a parent integration goal, and `dependencies` gates execution on the specified prerequisite scope passing verification. An executor without internal stage gates uses separate preparation/finalization tasks; a free-text dependency condition is a description of that task-verification gate, not an executable predicate. Controller-only evidence repair/delivery rounds can satisfy the original scope pin; a user scope change cannot silently replace it. Parent completion still requires actual whole-goal integration acceptance.

A complete operation batch is validated on a clone and durably committed before dispatch. Invalid versions, references, cycles or incompatible arrangements leave **all** operations unapplied. Supported batches include task creation/fork/decomposition, scope changes, dependency addition/removal, per-task control, merge, queue reorder, mediated messages and proposals. Source workers must confirm cessation before a replacement runs. A merge retains requirements, evidence, native-record references and historical source aliases; it does not pretend an arbitrary external operation or filesystem write was transactional. An unmet internal prerequisite cannot simply disappear during a merge: such a batch is rejected until the prerequisite is verified or the user explicitly changes the dependency. Removing a wait does not waive artifact, approval or permission requirements.

Communication is **coordinator-mediated**, not a new peer-to-peer agent runtime. Messages carry fixed-version source result excerpts obtained from the owner, never caller-supplied completion evidence. A missing excerpt may be attached later only from the same pinned user scope; an existing pinned excerpt is not silently rewritten. Paused recipients remain paused; a completed recipient can perform a scoped followup. Cancelled/failed goals are not silently revived. Reports may give feedback and suggest a new allocation, but injection does not mean read, agreement, authorization or acceptance. A proposal changes nothing until explicitly accepted; its entire operation set is revalidated together. Exact normalized duplicate objectives generate a notice, not an automatic semantic merge.

Intake remains verbatim in the ledger. Execution receives the assigned scope, applicable constraints, actual intake/latest clarification provenance and bounded relationship evidence; compound intake does not assign every other task to the current worker. A single new goal binds its full original request rather than a model summary. Clarification preserves the original request and answered question. Task routing can semantically match older work through up to three compact historical title-index pages, alongside lexical matching over complete task text. It can request up to three read-only context pages (up to 3,500 characters each); original scope is not replaced by the clipped candidate view. A guessed-but-unobserved task must be read before an executable verdict. Oversized/ambiguous work remains visibly unresolved rather than being declared complete.

All revision operation plans, including direct UI/API ingress and proposals, must explicitly select additive or replacement semantics. Explicit scope reduction/replacement also supplies the complete new acceptance array, so withdrawn criteria cannot accidentally survive as defaults; unaffected requirements and applicable constraints remain binding. Single-operation message/proposal replies use the same validated atomic envelope as batches. Model service failures preserve the request, expose a safe technical category and do not blindly launch another in-flight call.

Evidence excerpts are historical references, not a universal artifact-freshness guarantee. Scope changes invalidate affected dependency proofs, while native consumers must check the current applicable files/results before reuse; this version does not add a filesystem watcher.

Current bounded message contract: up to 1,800 characters and one source per message, up to 64 pending messages per recipient. Multiple messages can be committed in one atomic batch. Complete messages are fitted into the native context; only IDs actually included are acknowledged as injected, and remaining messages are processed at later execution boundaries. These are internal contracts, not a format the user must maintain. One workspace writer still runs at a time; unknown/stopping work continues to occupy its slot. Native subagents and ordinary Pi chat remain separate existing execution paths, not globally rescheduled by this plugin.

## Observer link

The coordinator publishes a reference-only task fact (`owner`,
`taskId`, `revision`, objective, status, progress) into the shared Observer root,
and drains queued control requests from it. `allowObserverControl` is off by
default; the launcher enables it for this standalone instance. A control is
`applied` only after the coordinator reaches the settled state, and stays
`unknown` when the native stop is still unconfirmed. The Observer tab shows
task frames beside Pi sessions and offers pause/resume/cancel; the coordinator
remains the only owner of task identity and acceptance. See
`docs/decisions/observer-layering.md`.

## Reuse decisions

- Native Pi Web UI: model authentication, agent tools, executor/reviewer lifecycle, plugin message transport, settings, native topbar and composer entry slots.
- Marked **18.0.11**, MIT: mature Markdown grammar for model replies. esbuild **0.28.2** compiles the already installed, version-checked dependency into private plugin artifacts; no vendored third-party source or second React runtime. Raw HTML, executable links and automatic remote images are not enabled. Code blocks have explicit copy actions.
- Native HTML form/button/details and a small domain-specific view: durable receipt states, original-goal evidence and targeted controls, which generic chat components do not own.
- assistant-ui and AG-UI/CopilotKit were evaluated, not adopted by name alone. Detailed tradeoffs and primary sources: `docs/decisions/responsive-coordination-ui.md`.

The official Web UI local-plugin installer/build path is reused. Updates compare the existing source fingerprint and preserve an installation snapshot; unknown existing plugin content is not overwritten. Runtime coordination state is outside plugin source under `<data-dir>/coordinator-state/<workspace-hash>/`.

## Authentication and authority

Independent agent settings, session root, data directory and port preserve daily Profiles/settings/conversations and the daily server. Native authentication/model configuration is referenced locally, never embedded in source, handed to a guest, or placed in command arguments. Normal native OAuth refresh can update its native auth store; this is not a new login, password or credential export. If an existing `PI_WEB_TOKEN` is supplied, its native protection is preserved: launcher authentication does not authenticate a fresh browser. The launcher reports that browser authentication is still required and does not open an unauthorized page or put that token in a URL/shortcut/process argument. Complete the existing native browser authentication first. Do not edit shared provider configuration in the independent native workbench unless that is intended.

This is a **standalone trusted-workspace entry**, not a child that claims to inherit any arbitrary parent TUI Profile's narrower tool allowlist. Its native workspace permission rules are not an OS sandbox. The launcher explicitly enables execution only in this independent instance; an ordinary manual plugin installation remains off by default. One workspace writer runs at a time; conversation/intake stay independent. No sudo, new passwords, launchd/systemd service or automatic main merge.

A confirmed pause stops the exact known native executor session; real acceptance also checked owned long-tool PIDs exited. Pause/resume starts a new bounded native round, not an OS-process checkpoint. Cancellation does not undo earlier file/network effects or prove arbitrary detached processes have been rolled back.

## Validation

```sh
node --test adapters/pi/coordinator-webui/*.test.mjs adapters/pi/coordinator-webui/client/*.test.mjs
/path/to/agent-harness-sandbox/bin/test.sh --project /path/to/engine macos-responsive-coordination
/path/to/agent-harness-sandbox/bin/test.sh --project /path/to/engine macos-coordinator-browser
```

Native protocol and real Chromium desktop/mobile cases run entirely in guests using bounded local model responses and source-hash/PNG integrity checks. They do not claim model-quality validation.

Separate real-model operational acceptance used the independent delivered instance: actual long commands during questions, exact files and regression results, targeted pause/resume/revision/cancellation, and a two-phase goal where premature native pass was caught and phase two completed automatically without a user reminder. Private transcripts/authentication remain outside Git. See `docs/tasks/2026-10-20-responsive-coordination.md` for the original delivery and `docs/tasks/2026-10-23-task-composition-acceptance.md` for B01–B24, communication/merge evidence and remaining rollout checks.

Broader work remains beyond this first usable experience: arbitrary parent tool-ceiling inheritance, isolated multiwriter dependency/resource scheduling, calibrated duration estimates, bounded anticipation, native TUI input integration and closed-server automatic continuation. Coverage checks can err; no claim of finding every unknown gap.
