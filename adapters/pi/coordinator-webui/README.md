# Pi responsive coordination experiment

An opt-in **Pi Web UI plugin**, not another agent runtime. It keeps a free-form inbox while the installed Web UI GoalService runs its existing executor/reviewer loop. The normal chat, native subagent tools, goal UI, Observer and session-window extension are not replaced.

## Current boundary

This is a first practice, not a production rollout or a promise to discover every unknown gap. Execution is **off by default**. This entry creates independent native conversations using the server's normal workspace capabilities; it does not yet prove inheritance of an arbitrary parent conversation's narrower Profile/tool ceiling. Use an isolated, trusted test workspace until that boundary is integrated and validated.

Requirements: Pi 1.1.0, Pi Web UI 0.100.0, Node 22.19+ with WebSocket, one Web UI server per data directory, and a writable plugin directory. Pi's package cohort must be version-aligned, not merely its top-level CLI version. The sandbox recipe pins those transitive packages.

The v1 UI lives in a separate **任务协调 / Coordinator** tab. It does not intercept the ordinary chat composer or native terminal input. It accepts text, not realtime audio. “Realtime” here means incoming requests and questions are independent of long worker runs, not zero model latency.

## Use in a private test instance

Review the plugin first. Use the existing Web UI CLI to install the local Engine source into a separate test data directory:

```sh
pi-web-ui install /path/to/engine/adapters/pi/coordinator-webui \
  --name pi-coordinator --data-dir /path/to/private-test-data
```

Do not use `--force` over an existing plugin. Start the server with the same data directory, an explicit trusted `--cwd`, and `--no-browser` if running headless. The default loopback endpoint is `ws://127.0.0.1:8787/ws`; set the plugin's endpoint to the actual local server port before enabling execution. Existing `PI_WEB_TOKEN`, when configured, stays in process memory and is not written to task handles or logs.

In plugin settings, explicitly enable the experimental execution entry only for the intended workspace. Send natural language in the Coordinator tab. Examples:

- “调查这个超时，保留现有接口，给出复现和回归证据。”
- “现在确认了什么？”
- “刚才的任务先暂停。”
- “继续，但先检查控制链路。”

The system stores the exact input before acknowledging it. It interprets the target from retained task context; ambiguous references ask a focused question. The browser retains unacknowledged text and stable request IDs in session storage, so reload/retry does not silently lose or duplicate the request. Do not close the browser tab before receipt if session storage is unavailable.

Native goals use a finite three-round review budget. The v1 coordinator permits one active workspace task at a time to avoid simultaneous unisolated writers; questions and durable intake remain independent. Multiple concurrent read-only or worktree-isolated writers are not yet configured through this UI.

## Ownership and recovery

- Coordinator: original messages, interpretations, revisions, queue, desired pause/cancel state and wall-clock checkpoints.
- Native Web UI: persistent reviewer/executor conversations, tools, review loop and worker state.
- Observer: its existing progress/attention presentation. Observer attention is never used as proof of task completion.

Runtime state is private `state/<workspace-hash>/coordination-state.json` under the installed plugin. It is not source, a Git artifact or a replacement for the native session store. Reload fences the retiring writer before the next plugin instance takes ownership. Workspace changes stop dispatch; each canonical workspace has separate retained state.

Unknown start or stop outcomes reserve the task for reconciliation instead of launching it again. A stop is confirmed only when the exact known native executor session disappears after the control request and the owning goal is cleared/idle. This does not roll back files, deployments, messages or independently detached commands. Early cancellation before an executor identity exists can remain unconfirmed.

Pause/resume starts a new bounded native goal round after confirmed cessation, not an operating-system process checkpoint. A process/server restart can retain tasks and sessions but is not a guarantee of automatic continuation; uncertain work remains visible for reconciliation. Closing the whole Web UI server removes its timer. No launchd/systemd service is installed by this experiment.

## Completion limitation

The installed native reviewer currently concentrates on items claimed complete in the current round. Its `pass` is therefore provisional: this plugin additionally performs a no-tool **whole-objective coverage check** over the original request, amendments and native evidence. Missing items must quote an existing requirement; up to two bounded repair revisions are automatically dispatched without another user reminder. Unknown evidence or exhausted repair budget pauses rather than reporting completion. Questions remain independent while this review runs.

This is an evidence-coverage model check, not a second tool-based functional review or a mathematical proof that every unknown gap was found. It can make judgment errors. Its scope is deliberately original requirements, not unsolicited scope expansion; native functional validation is still necessary.

Other remaining work: inherited tool-ceiling enforcement, semantic dependency/resource-aware task decomposition, bounded speculative preparation, calibrated duration ranges, actual-model intent evaluation, background continuity with a closed server, native TUI input adaptation, and wider end-to-end controls/reload testing.

## Tests

```sh
node --test adapters/pi/coordinator-webui/*.test.mjs
/path/to/agent-harness-sandbox/bin/test.sh \
  --project /path/to/engine macos-responsive-coordination
```

The consumer case requires a separately prepared Pi 1.1.0/Web UI 0.100.0 macOS base and uses a bounded guest-local model fixture, not real credentials. It checks actual native execution/review wiring and plugin receipt/classification; it does **not** measure real-model judgment quality. Inspect `COORDINATOR_WEBUI_RECEIPT`, runtime evidence and source hashes. Host unit tests are not VM behavior evidence.
