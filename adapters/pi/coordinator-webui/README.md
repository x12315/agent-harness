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

Describe a goal and constraints. While a command runs, ask what is happening, add another task, amend the original requirement, or pause/resume/cancel only the affected work. Task buttons submit the same natural-language requests through the durable inbox; they are not a parallel control database.

The page shows conversation, exact original requests, amendments, native progress, elapsed/checkpoint times, coverage evidence and retained native review records. Browser outbox requests keep stable IDs across reload/reconnect, and are acknowledged only after private durable storage. Ambiguous references ask a question rather than requiring a human-maintained ID queue.

Native functional pass is provisional until whole-objective coverage is checked. Genuinely missing original requirements trigger at most two bounded repair revisions. Repair reuses completed evidence and does not blindly repeat already completed long commands. Failure/uncertainty stays visible instead of becoming success.

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

Separate real-model operational acceptance used the independent delivered instance: actual long commands during questions, exact files and regression results, targeted pause/resume/revision/cancellation, and a two-phase goal where premature native pass was caught and phase two completed automatically without a user reminder. Private transcripts/authentication remain outside Git. See `docs/tasks/2026-10-20-responsive-coordination.md` for failures, fixes and evidence scope.

Broader work remains beyond this first usable experience: arbitrary parent tool-ceiling inheritance, isolated multiwriter dependency/resource scheduling, calibrated duration estimates, bounded anticipation, native TUI input integration and closed-server automatic continuation. Coverage checks can err; no claim of finding every unknown gap.
