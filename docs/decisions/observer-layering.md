# Observer layering decision

## Requirement

Extend the existing Observer rather than build a second one. Refine its interface
so one branch keeps today's human-facing behaviour and becomes the direct-control
path, while another branch serves managing agents and links to the coordinator
superstructure.

## Layers

| Layer | Responsibility | Current implementation |
| --- | --- | --- |
| L0 facts | Activity, tool, elapsed time, compaction, attention from a Pi session | `adapters/pi/extensions/pi-observer.ts` (unchanged) |
| L1 store | Fresh snapshots, append-only journal, owner task facts, control queue | `<observer>/` with `*.snapshot.json`, `journal/events.ndjson`, `tasks/`, `control/{pending,done}` |
| L2 interface | Capability negotiation, frames, events, coverage, control request and receipt | `adapters/pi/observer-protocol/index.mjs` (versioned, pure) |
| L3a human | Existing tab/cards/pending/bell + merged task view + direct control | `adapters/pi/observer-webui/client` |
| L3b programmatic | Loopback read/subscribe/control for agents | `adapters/pi/observer-webui` HTTP routes |
| L4 superstructure | Task identity, revisions, acceptance, dispatch | `pi-coordinator` (authority stays here) |

## Contracts that make the split real

- **Versioned identifiers** — `observer.frame/2`, `observer.event/1`,
  `observer.capability/1`, `observer.taskfact/1`, `observer.control/1`. Unknown
  versions are rejected, not guessed.
- **Weak task reference** — `{owner, taskId, revision}`. Observer never mints a
  task ID or decides completion; the owner publishes facts and receipts.
- **Facts vs authority** — frames carry `provenance.authoritative`. A `pass`
  verdict or a model summary can never become completion evidence here.
- **Requests, not mutations** — `ControlRequest` carries `commandId`,
  `consumerId`, target and `expectedRevision`. `enqueueControl` is idempotent;
  owners complete with `applied` only after observing the settled effect, and
  otherwise leave `unknown`.
- **Explicit unsupported** — a subject whose owner does not implement an action
  advertises no action; a Pi-session control target returns
  `422 unsupported-action`.
- **Coverage is data** — unobserved processes are reported, not classified as
  idle.

## Reuse decisions

- Snapshots, summaries, attention/bell, the extension's timing/compaction logic
  and the existing tab are reused. The file format the extension writes did not
  change.
- Task facts live with the coordinator; Observer only reads them. This avoids a
  second task database and keeps restart/revision truth in one place.
- The human and programmatic branches share one read model; there is no separate
  "agent view" with different data.
- The generated protocol copy inside each plugin exists because plugins install
  as self-contained directories. `scripts/sync-observer-protocol.mjs` regenerates
  both copies and a unit test compares bytes, so drift fails rather than
  diverging silently.

## Known limits

- The browser UI refreshes every 15 seconds. A task completed right after a
  render can show the previous phase until the next poll; the control receipt and
  `/frames` are already current. This is recorded as an observation, not hidden.
- Observer still does not control Pi sessions: there is no owner adapter for the
  session extension, so ad-hoc abort/ack from another process is deliberately
  unsupported.
- A task fact older than three minutes is shown as stale. Staleness is not proof
  that the task stopped.
- Cross-process delivery is at-least-once by design; duplicate `commandId`
  returns the existing receipt instead of creating a second request.

## Validation

- Protocol unit tests cover frame freshness, task authority, control
  validation/idempotency, journal cursors, fact atomicity and discrepancies.
- Coordinator bridge tests cover fact publication, stale revision rejection,
  exactly-once application, disabled policy and "unconfirmed stop stays unknown".
- Guest Chromium case `macos-observer-layer` runs both plugins in a fresh macOS
  clone: real approval flow, a seeded legacy Pi snapshot, a live coordinator
  task, merged view, and pause/resume/cancel each reaching `已生效` and the
  matching frame phase in a real browser.
- These are deterministic-fixture tests; they do not measure real-model intent
  quality.
