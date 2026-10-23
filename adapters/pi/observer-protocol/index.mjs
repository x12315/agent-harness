/**
 * Versioned observation protocol shared by every Observer consumer.
 *
 * The protocol separates three things that were previously implicit in one
 * snapshot file: observed facts (frames/events), authority over work (task
 * facts owned elsewhere), and requests to change something (control commands).
 * Observer never mints task identities or decides that a goal is complete.
 *
 * All functions here are pure or local-filesystem only; none of them reads a
 * model, starts work, or trusts a caller's claim about another process.
 */
import { appendFile, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Wire identifiers. Consumers must reject unknown versions instead of guessing. */
export const SCHEMA = Object.freeze({
	capability: "observer.capability/1",
	frame: "observer.frame/2",
	event: "observer.event/1",
	taskFact: "observer.taskfact/1",
	control: "observer.control/1",
});

/** Control actions any owner adapter may implement; absence in a capability is authoritative. */
export const CONTROL_ACTIONS = Object.freeze(["ack", "pause", "resume", "cancel", "summary"]);
const EVENT_TYPES = new Set(["control.requested", "control.applied", "control.rejected", "task.fact-changed", "attention", "note"]);
const ACTIVE_TASK_STATES = new Set(["starting", "running", "stopping"]);
const TERMINAL_TASK_STATES = new Set(["verified", "failed", "cancelled", "merged"]);
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,120}$/;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => typeof value === "string" && value.trim().length > 0 ? value.slice(0, limit) : undefined;
const timestamp = (value) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined; };
const age = (value, now) => { const parsed = timestamp(value); return parsed === undefined ? Infinity : now - parsed; };
const stale = (value, now, maxAgeMs) => age(value, now) > maxAgeMs;
const identifier = (value) => typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;

/** Resolve a protocol path and refuse identifiers that could escape the observation root. */
export function safeName(value) {
	const name = identifier(value);
	if (!name || name === "." || name === ".." || name.includes("..")) throw new TypeError("Invalid protocol identifier");
	return name;
}

/**
 * Describe what this Observer instance can actually serve.
 * `actions` is the union of control actions with at least one registered owner;
 * an empty list means consumers must not present control affordances.
 */
export function capability({ sources = [], actions = [], transports = ["http"], freshnessMs = 90_000, eventRetention = 2000, coverage = {} } = {}) {
	const uniqueActions = [...new Set(actions)];
	if (uniqueActions.some((action) => !CONTROL_ACTIONS.includes(action))) throw new TypeError("Unknown control action in capability");
	return {
		schemaVersion: SCHEMA.capability,
		generatedAt: new Date().toISOString(),
		sources: [...new Set(sources)].filter((source) => typeof source === "string"),
		actions: uniqueActions,
		transports: [...new Set(transports)],
		freshnessMs,
		eventRetention,
		coverage: {
			verified: coverage.verified === true,
			checkedAt: text(coverage.checkedAt, 40) ?? null,
			unobserved: Array.isArray(coverage.unobservedPids) ? coverage.unobservedPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0) : [],
			note: text(coverage.note, 300) ?? null,
		},
	};
}

/**
 * Translate the legacy `pi-session` snapshot into a frame.
 * Returns null for invalid, expired, or unrelated shapes so a stale file can
 * never be rendered as current activity. The legacy file format is unchanged.
 */
export function sessionFrame(snapshot, { now = Date.now(), freshnessMs = 90_000, summary } = {}) {
	if (!isRecord(snapshot) || typeof snapshot.id !== "string" || !Number.isSafeInteger(snapshot.pid)) return null;
	if (stale(snapshot.updatedAt, now, freshnessMs)) return null;
	const updatedAt = new Date(timestamp(snapshot.updatedAt)).toISOString();
	return {
		schemaVersion: SCHEMA.frame,
		subjectId: snapshot.id,
		kind: "pi-session",
		workspace: text(snapshot.cwd, 500) ?? null,
		observedAt: updatedAt,
		updatedAt,
		ageMs: Math.max(0, age(updatedAt, now)),
		freshnessMs,
		stale: false,
		active: snapshot.active === true,
		phase: text(snapshot.phase, 80) ?? (snapshot.active === true ? "working" : "idle"),
		sequence: Number.isSafeInteger(snapshot.sequence) ? snapshot.sequence : undefined,
		pid: snapshot.pid,
		tool: text(snapshot.lastTool, 120) ?? null,
		toolArgs: text(snapshot.lastToolArgs, 600) ?? null,
		toolError: text(snapshot.lastToolError, 600) ?? null,
		workElapsedMs: Number.isSafeInteger(snapshot.workElapsedMs) ? snapshot.workElapsedMs : null,
		compaction: isRecord(snapshot.compaction) ? { active: snapshot.compaction.active === true } : null,
		attention: isRecord(snapshot.attention) ? { reason: text(snapshot.attention.reason, 120) ?? "unknown", at: text(snapshot.attention.at, 40) ?? null } : null,
		summary: summary && typeof summary.text === "string" ? { text: summary.text.slice(0, 4000), scope: "session", reportedAt: text(summary.reportedAt, 40) ?? null } : null,
		provenance: { source: "pi-session", authoritative: false },
	};
}

/**
 * Translate an authoritative task fact published by its owner into a frame.
 * Observer only displays it; `authoritative` names the owning adapter so a
 * consumer can tell observation apart from goal authority.
 */
export function taskFrame(fact, { now = Date.now(), staleAfterMs = 180_000 } = {}) {
	if (!isRecord(fact) || fact.schemaVersion !== SCHEMA.taskFact) return null;
	if (!identifier(fact.owner) || !identifier(fact.taskId) || !Number.isSafeInteger(fact.revision) || fact.revision < 1) return null;
	if (!text(fact.objective, 8000) || typeof fact.status !== "string") return null;
	const observedAt = timestamp(fact.updatedAt);
	if (observedAt === undefined) return null;
	const isStale = now - observedAt > staleAfterMs;
	return {
		schemaVersion: SCHEMA.frame,
		subjectId: `${fact.owner}:${fact.taskId}`,
		kind: "webui-task",
		workspace: text(fact.workspace, 500) ?? null,
		taskRef: { owner: fact.owner, taskId: fact.taskId, revision: fact.revision },
		observedAt: new Date(observedAt).toISOString(),
		updatedAt: new Date(observedAt).toISOString(),
		ageMs: Math.max(0, now - observedAt),
		freshnessMs: staleAfterMs,
		stale: isStale,
		active: ACTIVE_TASK_STATES.has(fact.status),
		phase: fact.status.slice(0, 80),
		tool: text(fact.progress?.tool, 120) ?? null,
		progress: text(fact.progress?.summary, 1000) ?? null,
		workElapsedMs: Number.isSafeInteger(fact.elapsedMs) ? fact.elapsedMs : null,
		gap: text(fact.gap, 1000) ?? null,
		attention: fact.attention === true ? { reason: text(fact.attentionReason, 120) ?? "input-required", at: new Date(observedAt).toISOString() } : null,
		provenance: { source: "webui-task", authoritative: fact.owner },
	};
}

/** Sort frames for presentation: active work first, then most recently observed. */
export function orderFrames(frames) {
	return [...frames].sort((left, right) => Number(right.active) - Number(left.active) || Date.parse(right.observedAt) - Date.parse(left.observedAt));
}

/**
 * Derive cross-source discrepancies without resolving them.
 * A discrepancy is evidence for a human or a managing agent; it is never a
 * verdict about the goal, and Observer must not silently repair it.
 */
export function discrepancies({ frames = [], controls = [], coverage = {}, now = Date.now() } = {}) {
	const found = [];
	for (const frame of frames) {
		if (frame.stale) found.push({ code: "stale-fact", subjectId: frame.subjectId, detail: `事实已过期 ${Math.round((now - Date.parse(frame.observedAt)) / 1000)} 秒，不能视为当前状态。` });
		if (frame.kind === "webui-task" && TERMINAL_TASK_STATES.has(frame.phase) && controls.some((control) => control.state === "queued" && control.target?.taskRef?.taskId === frame.taskRef?.taskId)) {
			found.push({ code: "control-after-terminal", subjectId: frame.subjectId, detail: "任务已结束但仍有未处理的停止请求；需要核对而非重复派发。" });
		}
		if (frame.kind === "webui-task" && frame.gap) found.push({ code: "open-gap", subjectId: frame.subjectId, detail: frame.gap });
	}
	if (coverage?.verified !== true) found.push({ code: "coverage-unverified", subjectId: null, detail: "存在未被观测的 Pi 进程，整体状态不完整。" });
	return found;
}

/** Validate one control request. Requests carry intent only; owners apply them. */
export function controlRequest(value, { now = Date.now() } = {}) {
	if (!isRecord(value)) throw new TypeError("Control request must be an object");
	if (value.schemaVersion !== undefined && value.schemaVersion !== SCHEMA.control) throw new TypeError("Unsupported control schema");
	const commandId = safeName(value.commandId ?? randomUUID());
	const consumerId = safeName(value.consumerId);
	if (!CONTROL_ACTIONS.includes(value.action)) throw new TypeError("Unsupported control action");
	const target = isRecord(value.target) ? value.target : null;
	if (!target) throw new TypeError("Control target is required");
	const subjectId = target.subjectId === undefined ? undefined : safeName(target.subjectId);
	const taskRef = target.taskRef === undefined ? undefined : (() => {
		const ref = target.taskRef;
		if (!isRecord(ref) || !identifier(ref.owner) || !identifier(ref.taskId) || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new TypeError("Invalid task reference");
		return { owner: ref.owner, taskId: ref.taskId, revision: ref.revision };
	})();
	if (!subjectId && !taskRef) throw new TypeError("Control target requires subjectId or taskRef");
	if (["pause", "resume", "cancel"].includes(value.action) && !taskRef) throw new TypeError("State-changing control requires an authoritative task reference");
	return {
		schemaVersion: SCHEMA.control,
		commandId,
		consumerId,
		action: value.action,
		target: { ...(subjectId ? { subjectId } : {}), ...(taskRef ? { taskRef } : {}) },
		expectedRevision: Number.isSafeInteger(value.expectedRevision) ? value.expectedRevision : undefined,
		issuedAt: text(value.issuedAt, 40) ?? new Date(now).toISOString(),
		note: text(value.note, 500),
	};
}

const controlDirectory = (root) => join(root, "control");
const pendingPath = (root, commandId) => join(controlDirectory(root), "pending", `${safeName(commandId)}.json`);
const donePath = (root, commandId) => join(controlDirectory(root), "done", `${safeName(commandId)}.json`);

async function writeExclusive(path, value) {
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	const handle = await open(path, "wx", 0o600);
	try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
}

const receipt = (request, state, extra = {}) => ({
	schemaVersion: SCHEMA.control,
	commandId: request.commandId,
	consumerId: request.consumerId,
	state,
	recordedAt: new Date().toISOString(),
	...(request.target ? { target: request.target } : {}),
	...extra,
});

/**
 * Durably queue a control request. Re-sending the same commandId is idempotent:
 * it returns the existing state instead of creating a second request.
 */
export async function enqueueControl(root, request) {
	const validated = controlRequest(request);
	try { await writeExclusive(pendingPath(root, validated.commandId), validated); }
	catch (error) {
		if (error.code !== "EEXIST") throw error;
		const existing = await readControl(root, validated.commandId);
		return { duplicate: true, ...(existing ?? receipt(validated, "unknown", { detail: "pending file exists but is unreadable" })) };
	}
	return { duplicate: false, ...receipt(validated, "queued") };
}

/** Read the current state of one command from pending or completed records. */
export async function readControl(root, commandId) {
	const id = safeName(commandId);
	for (const [path, state] of [[donePath(root, id), null], [pendingPath(root, id), "queued"]]) {
		try {
			const value = JSON.parse(await readFile(path, "utf8"));
			if (!isRecord(value)) continue;
			return state ? receipt(value, state) : value;
		} catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	return null;
}

/** List queued requests for an owner adapter. Unreadable entries are skipped, never guessed. */
export async function listControls(root) {
	let names;
	try { names = await readdir(join(controlDirectory(root), "pending")); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
	const found = [];
	for (const name of names.filter((entry) => entry.endsWith(".json")).slice(0, 200)) {
		try {
			const value = JSON.parse(await readFile(join(controlDirectory(root), "pending", name), "utf8"));
			const validated = controlRequest(value);
			found.push(receipt(validated, "queued"));
		} catch { /* an unreadable request is not evidence of intent */ }
	}
	return found.sort((left, right) => Date.parse(left.issuedAt ?? left.recordedAt) - Date.parse(right.issuedAt ?? right.recordedAt));
}

/**
 * Record an owner's outcome and remove the queued request atomically enough for
 * retry: writing the receipt first means a crash leaves a claimable duplicate
 * rather than a lost decision. `applied` must only be used after the owner
 * observed the effect.
 */
export async function completeControl(root, commandId, state, detail = "") {
	if (!["applied", "rejected", "unknown"].includes(state)) throw new TypeError("Invalid completion state");
	const id = safeName(commandId);
	let request;
	try { request = JSON.parse(await readFile(pendingPath(root, id), "utf8")); }
	catch (error) { if (error.code === "ENOENT") return readControl(root, id); throw error; }
	const finished = receipt(request, state, { detail: detail.slice(0, 1000), completedAt: new Date().toISOString() });
	await writeExclusive(donePath(root, id), finished);
	await rm(pendingPath(root, id), { force: true });
	await appendEvent(root, { type: state === "applied" ? "control.applied" : state === "rejected" ? "control.rejected" : "note", subjectId: request.target?.subjectId, taskRef: request.target?.taskRef, payload: { commandId: id, action: request.action, detail: detail.slice(0, 500) } });
	return finished;
}

/** Publish one authoritative task fact. Written atomically so readers never see half a fact. */
export async function writeTaskFact(root, fact) {
	const owner = identifier(fact?.owner), taskId = identifier(fact?.taskId);
	if (!owner || !taskId) throw new TypeError("Task fact requires owner and taskId");
	if (!Number.isSafeInteger(fact.revision) || fact.revision < 1) throw new TypeError("Task fact requires a revision");
	if (!text(fact.objective, 8000)) throw new TypeError("Task fact requires the original objective");
	if (typeof fact.status !== "string") throw new TypeError("Task fact requires status");
	const directory = join(root, "tasks");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const body = { ...fact, schemaVersion: SCHEMA.taskFact, updatedAt: fact.updatedAt ?? new Date().toISOString() };
	for (const key of Object.keys(body)) if (key.startsWith("_")) delete body[key];
	const temporary = `${join(directory, `${owner}.${taskId}.json`)}.${randomUUID()}.tmp`;
	await writeExclusive(temporary, body);
	await rename(temporary, join(directory, `${owner}.${taskId}.json`));
	return body;
}

/** Read every published task fact, annotating staleness instead of hiding it. */
export async function readTaskFacts(root, { now = Date.now(), staleAfterMs = 180_000 } = {}) {
	const directory = join(root, "tasks");
	let names;
	try { names = await readdir(directory); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
	const facts = [];
	for (const name of names.filter((entry) => entry.endsWith(".json")).slice(0, 200)) {
		try {
			const fact = JSON.parse(await readFile(join(directory, name), "utf8"));
			const frame = taskFrame(fact, { now, staleAfterMs });
			if (frame) facts.push({ ...fact, stale: frame.stale, ageMs: frame.ageMs });
		} catch { /* corrupt fact is omitted, not inferred */ }
	}
	return facts.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

/** Append one event to the shared journal. Event IDs make duplicate delivery detectable. */
export async function appendEvent(root, event) {
	if (!isRecord(event) || !EVENT_TYPES.has(event.type)) throw new TypeError("Unsupported event type");
	const directory = join(root, "journal");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const record = {
		schemaVersion: SCHEMA.event,
		eventId: identifier(event.eventId) ?? randomUUID(),
		type: event.type,
		at: text(event.at, 40) ?? new Date().toISOString(),
		...(event.subjectId ? { subjectId: safeName(event.subjectId) } : {}),
		...(event.taskRef ? { taskRef: controlRequest({ commandId: "journal", consumerId: "journal", action: "cancel", target: { taskRef: event.taskRef } }).target.taskRef } : {}),
		...(event.payload !== undefined ? { payload: event.payload } : {}),
	};
	await appendFile(join(directory, "events.ndjson"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
	return record;
}

/**
 * Read recent events after `since` (an eventId), bounded so a large journal
 * cannot stall a consumer. Returns `{events, cursor}`; an unknown `since`
 * yields the retained tail with `truncated: true` rather than a silent gap.
 */
export async function readEvents(root, { since, limit = 200 } = {}) {
	const file = join(root, "journal", "events.ndjson");
	let body;
	try {
		const handle = await open(file, "r");
		try {
			const { size } = await handle.stat();
			const length = Math.min(size, 2 * 1024 * 1024);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, size - length);
			body = buffer.toString("utf8");
		} finally { await handle.close(); }
	} catch (error) { if (error.code === "ENOENT") return { events: [], cursor: null, truncated: false }; throw error; }
	const events = [];
	for (const line of body.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line);
			if (value?.schemaVersion === SCHEMA.event) events.push(value);
		} catch { /* a torn tail line is not an event */ }
	}
	const retained = events.slice(-Math.max(1, Math.min(limit, 2000)));
	const index = since ? retained.findIndex((entry) => entry.eventId === since) : -1;
	const truncated = Boolean(since) && index < 0;
	return { events: index >= 0 ? retained.slice(index + 1) : retained, cursor: retained.at(-1)?.eventId ?? null, truncated };
}
