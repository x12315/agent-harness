# Pi Observer

Read-only Pi activity snapshots and per-session one-sentence summaries. The
extension is `../extensions/pi-observer.ts`; this directory is its standalone
`pi-web-ui` plugin. Initial implementation was validated in
`agent-harness-sandbox/pi-observer`; Engine now owns the installed source.

Enable `pi-observer` and the installed `pi-web-ui` package in Catalog Profile
extension selections, then compose and bootstrap through `harness`. Create
`~/.pi/agent/observer` before launching Profiles: pi-profile-switch mirrors
this runtime directory into its isolated instances, sharing snapshots without
sharing or changing model context. Existing sessions must reselect their Profile
or restart; `/reload` alone may retain the old resource selection.

Install the plugin using the existing WebUI CLI:

```sh
pi-web-ui install /absolute/path/to/engine/adapters/pi/observer-webui --name pi-observer
```

Open the Pi Observer tab. The displayed snapshot directory has an unchecked
**记住此目录的读取授权，下次自动访问** checkbox. Check it, then click **Allow read
access** to explicitly approve and remember that directory. Checking alone never
reads snapshots or grants permission. Without the checkbox, access lasts only
for the current Web service/plugin activation; the native host may retain its
own grant, but Observer asks again after reactivation.

A remembered choice is saved through the native plugin storage API, outside
Engine/Catalog, bound to the exact directory and the read-only consent schema.
It survives browser refresh and service restart; cancel the checkbox at any time
to stop future automatic access without interrupting the current view. Directory
changes or incompatible consent schemas require confirmation again. The native
host still checks every filesystem operation: remembered consent never creates
or restores a revoked directory grant. If access is revoked or the directory is
unavailable, Observer shows no snapshots and asks for manual confirmation rather
than automatically requesting new permission. Native filesystem grants can also
be revoked in WebUI settings. No user-directory grant is preinstalled by deployment.

A plugin update may require browser refresh or renewed authorization when the
host's grant no longer applies. The viewer refreshes every 15 seconds and never
calls a model or registers agent tools.

## Terminal commands

Commands require the leading `/`; plain `observer` is normal chat input.
`/observer` opens an interactive menu with arrow keys, Enter and Escape. In RPC
it prints help instead of opening a dialog. Opening the menu, canceling it or
reading help never requests a summary. Subcommand completions show descriptions
and model-call costs from the same action list as the menu and help.

| Command | Behavior |
| --- | --- |
| `/observer status` | Automatic setting, phase, generation/cache status; no model call |
| `/observer web` | Open the existing local Pi WebUI in TUI, or return its URL in RPC; no model call |
| `/observer last` | Current runtime's cached summary; no model call |
| `/observer now` | Generate a current-session summary using its model; may incur cost |
| `/observer on` | Enable automatic progress hints and summaries |
| `/observer off` | Hide the panel and stop automatic summaries; Agent keeps working |
| `/observer ack` | Mark this session's reminder read without replying to or starting the Agent |
| `/observer help` | All actions, costs and reload guidance; no model call |

The Web action probes the local `/api/health` with a two-second deadline and
rejects redirects or unrelated services before invoking the OS browser opener.
It uses port 8787 by default, or `PI_WEB_PORT`. It does not start, restart or install
a second Web service: if unavailable, use the existing `/webui` command to start
it. Select the Pi Observer tab in the browser and explicitly approve directory
read access; the action never grants permission. Missing desktop openers report
the URL for manual access. RPC clients get the URL without opening a browser on
the server. It never injects a `/webui` message into the observed conversation.

Manual generation immediately acknowledges the request and keeps the progress
panel visible even while the Agent is idle. Repeated requests report that a
summary is already pending rather than silently returning or duplicating calls.
Canceled manual requests get explicit feedback. Unknown operations show help,
never fall through to a model request. Older sessions load these command changes
with `/reload` when idle; use `/profile reload` if Observer is not in the current
resource selection.

## Reload versus exit

`/reload` replaces the extension runtime, not the task. Observer preserves the
owning session's recent summary, activity/tool history, run identity, adjusted
work clock, attention/acknowledgment, and automatic setting/interval. Existing
snapshot and summary files remain available to the Web viewer during reload;
active progress widgets return from the same data without another model call or
another bell for the same attention ID. Settled progress stays hidden after reload;
the saved summary remains available through `/observer last`.

Only plain Observer data transfers within the same process, keyed by PID plus
session ID and checked against workspace/session file. The handover is consumed
once and bounded to 128 entries; no agent context or transcript entry is written.
Old timers, subscriptions and pending Observer completions are still stopped.
The replacement runtime creates fresh timers and uses live `isIdle()` for activity.
A real new run clears the old displayed summary and attention as before. Quit,
session replacement, fork, or process restart does not restore this reload-only
handover. Information already deleted by an older extension cannot be recovered;
the first upgrade from that version can still lose its old runtime data.

## Attention and compaction

Engine's `../extensions/iterm-bell.ts` consumes the versioned `observer:attention`
event (`schemaVersion: 1`, PID+session `id`, workspace, nullable `attention`).
Observer produces one attention record per run/reason, for final non-aborted
settlement, final assistant failure, or a blocking prompt during an active run.
Observer's own menu does not count as a blocking Agent approval. Tool errors and
summary-generation failures do not by themselves imply that the Agent failed.
A new run clears the record; acknowledgment only marks it read. Final settlement
means the run stopped and awaits input, not proof that the user's goal succeeded.

Bell renders a persistent warning widget and footer in the owning terminal pane,
rings the existing iTerm BEL once per event, and never focuses windows, changes
titles/badges or requests Automation permissions. PID+session routing prevents
same-process subagents from ringing another session's terminal. Without the new
Observer protocol, Bell retains the prior settlement-only behavior. The Web tab
shows a persistent pending list including acknowledged-but-unresolved sessions,
workspace/session identity, and iTerm pane identity when available. It has no
write permission and cannot acknowledge or focus a pane; use `/observer ack` in
that session. Unconnected and older Agents are not silently classified as done.
There is no separate bell summarizer or model cost.

Automatic `threshold`/`overflow` compaction pauses working time, quiet-response
thresholds, and automatic summary requests. Success, failure and abort all resume
the clocks exactly once. The native panel and Web card label compaction explicitly;
`workElapsedMs` excludes these intervals and stops increasing after settlement.
Manual `/compact` is not subtracted. These handlers observe and return nothing;
they never cancel, customize or initiate compaction. The timing starts at the
public before-compaction event, so earlier SDK preparation is not measurable.

## Shared summaries

Terminal `/observer now` and automatic progress summaries summarize **only the current
session**, using its current model. They never read other sessions' snapshot
files or send global process inventory to the model. Each completion produces one shared result: the terminal displays its text and
the WebUI reads the same saved result, identified by PID plus session ID. Saved
summaries carry `scope: "session"`, `status: "ready" | "error"` and a safe error
category on failure. Timeout, provider failure, missing model and empty responses
are explicit errors, not successful task summaries. The fallback is labeled as
activity status, and the same error text is shown in the owning terminal and its
Web card; raw provider error messages are never persisted.

The WebUI alone aggregates all fresh snapshots. Its **Overall status** is a
current, deterministic overview (counts and activity phases), not the latest
terminal's summary and not an extra model call. Session summaries appear only
on their matching session cards, with a generation time. Raw assistant replies
are never shown as substitute summaries. Cards without a valid session summary
explicitly say that the task summary is not available; older unscoped summaries
are ignored. Still-running older Observer instances require a reload when idle
to produce scoped summaries. Cards distinguish unknown summary settings from
older Observers, automatic summaries turned off, and waiting for the next
self-summary. The WebUI does not
have a separate summarization pipeline, model permission or additional model
calls: it reuses every Agent's self-summary. Tool errors and unconnected processes
remain visible alongside those shared summaries.
`/observer off` disables automatic summaries for that session, including future
tasks and hides the terminal progress panel. `/observer on` enables them.
Interactive terminals keep a width-bounded panel above the editor. The current
activity occupies one header line, with the task summary prominently wrapped
across up to four lines; elapsed time, summary age and menu/Web shortcuts are
secondary. The panel uses at most six rows, shrinking to three or four rows in
short terminals. Native terminal-width helpers handle Chinese, emoji and resize.
When the summary cannot fit, it shows `/observer last` for the full cached text
without another model call. Automatic summaries replace its content instead of
adding scrolling notifications; panel enlargement does not change the summary
pipeline or automatic model-call schedule.
Ten seconds without visible assistant text shows a local activity hint with no
model call. After sixty seconds without visible text, the first summary becomes
due; subsequent requests are limited to one per five minutes (checked at most
every fifteen seconds). Visible text streaming suppresses automatic requests;
hidden thinking and tool chatter do not count as a human-readable response.
While a UI prompt awaits user action, the panel prioritizes that prompt and does
not request summaries. A visible response resuming cancels only a pending
automatic summary, never the Agent. Short tasks get no automatic model call.
Custom positive `PI_OBSERVER_INTERVAL_MINUTES` values below one minute also shorten
the first delay; zero disables automatic requests and hints.

Final settlement hides the owning terminal's progress panel immediately. Live
idle reconciliation also hides it if the settlement event was missed. The Web
card collapses idle sessions on its next 15-second refresh to workspace and
**等待输入** only: no recent summary, generation age, activity age, work time,
historical tool/error details, or automatic-summary setting notices. Session/PID
identity remains in its tooltip and the separate pending list. Idle pending
records also omit waiting-age counters while keeping unread/acknowledgment and
pane identity. Active and compacting sessions retain their progress clocks;
active cards also omit prior-run summaries.
Intermediate messages, tools and automatic compaction do not imply settlement.
This is display-only: saved summaries, activity history and pending/acknowledged
attention remain intact. `/observer last` replays the cached summary as a
notification without restoring the idle progress panel or calling a model.
Manual generation while idle shows temporary progress, then returns the result
as a notification/cache and hides the panel again. A real new run still clears
the old displayed-summary cache. Manual requests
and RPC clients retain notifications; JSON/print modes do not install widgets.
The first request is earlier than the old five-minute schedule, so tasks lasting
one to five minutes can now incur one summary call. Each instrumented session can
incur its own model calls. These calls
receive bounded facts from that session only, potentially including its file
paths, tool argument excerpts and assistant text, but no observed-session context
or model tools.

`PI_OBSERVER_DIR` overrides the shared directory; set the same value for Pi and
the WebUI server. `PI_OBSERVER_INTERVAL_MINUTES=0` disables initial automatic
summaries. `PI_OBSERVER_KEEP_SNAPSHOTS=1` retains snapshots only for diagnosis;
quit or session replacement removes session snapshots and summaries; reload keeps them.

Each connected session reads `ctx.isIdle()` at startup and every 15 seconds:
long silence does not imply idle, and missing lifecycle events are reconciled
without inventing activity timestamps. It also uses a bounded, current-user
`ps` query (PID and executable name only, no command arguments or environment)
to identify Pi-named processes without fresh snapshots. The viewer labels those
processes **Unknown / not connected**, never Idle. Inventory failure or older
extensions produce an explicit coverage-unverified warning. Inventory checking
is limited to Pi-named processes; it does not prove coverage of all runtimes.

Uninstrumented sessions, `--no-extensions`, and separate agent directories
without a shared Observer directory have no reliable activity details. To connect
an existing Profile session, run `/profile reload` after its current task finishes.
Observer does not inject itself into, interrupt or restart a running agent. Installation does not
change models, credentials, native settings or login services.

Checks (no external provider requests):

```sh
node --test scripts/tests/pi-observer.test.mjs scripts/tests/iterm-bell.test.mjs adapters/pi/observer-webui/*.test.mjs adapters/pi/observer-webui/client/*.test.mjs
```

The Engine-owned `tests/sandbox/{macos,linux}-observer-settlement` cases run this
suite and `scripts/tests/observer-settlement-guest.mjs` inside disposable VMs via
Sandbox's `bin/test.sh --project <engine> <case-id>`. They require prepared Pi
0.87.1 / WebUI 0.96.1, validate actual CLI/native PTY availability, and inject the
current Engine files rather than the older Sandbox Observer copy. No guest
package installation or upgrade occurs. macOS uses a private Tart clone; Linux
uses an ephemeral, no-NIC vmspawn guest on a Linux host with an independent
checkout/output directory. Select the prepared runtime through Sandbox's native
configuration; never synchronize shared directories during active tests.

Each guest launches two real Pi PTYs against an owned loopback mock (two task
calls and two summary calls total). Final settlement of one worker hides only its
panel; the other worker remains active and visible. Cached replay, native reload,
run/clock/automatic-off retention, attention/acknowledgment and exit cleanup have
explicit native API/file checkpoints and bounded deadlines. UI command completion
is traced directly, not inferred from a fresh substring in a differential ANSI
stream. Runtime receipts, source hashes, terminal traces and host assertions stay
outside Git. These cases establish guest OS/native PTY behavior; client rendering
is covered by synthetic DOM tests, not desktop/iTerm GUI or browser screenshots.
