import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { completeControl, listControls, safeName, writeTaskFact } from "./protocol.generated.mjs";

/** The namespace this adapter owns in the shared Observer protocol. */
export const OWNER = "pi-coordinator";
export const MAX_TASK_FACTS = 50;
export const CONTROL_INTERVAL_MS = 15_000;
const CONTROL_ACTIONS = new Set(["pause", "resume", "cancel"]);
const SETTLED = { pause: new Set(["paused", "cancelled", "failed"]), resume: new Set(["running"]), cancel: new Set(["cancelled"]) };

/** Observation root shared by the Observer and its owner adapters. */
export function observerRoot(env = process.env) {
	return env.PI_OBSERVER_DIR || join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "observer");
}

function elapsedMs(task, now) {
	if (!Number.isFinite(task.startedAt)) return undefined;
	return Math.max(0, (Number.isFinite(task.finishedAt) ? task.finishedAt : now) - task.startedAt);
}

function taskFact(task, workspace, now) {
	const summary = task.progress?.summary;
	const tool = task.progress?.tool;
	const fact = {
		owner: OWNER,
		taskId: task.id,
		revision: task.revision,
		objective: task.objective,
		sourceText: task.sourceText,
		status: task.status,
		gap: task.gap ?? null,
		workspace,
		progress: { summary: summary ?? null, tool: tool ?? null },
		attention: task.status === "paused" && Boolean(task.gap),
	};
	const elapsed = elapsedMs(task, now);
	if (elapsed !== undefined) fact.elapsedMs = elapsed;
	if (Number.isFinite(task.startedAt)) fact.startedAt = task.startedAt;
	if (Number.isFinite(task.finishedAt)) fact.finishedAt = task.finishedAt;
	if (task.gap != null) fact.attentionReason = task.gap;
	return fact;
}

function newestTasks(tasks, limit = MAX_TASK_FACTS) {
	return [...tasks]
		.sort((left, right) => (Number.isFinite(left.createdAt) ? left.createdAt : 0) - (Number.isFinite(right.createdAt) ? right.createdAt : 0))
		.slice(-limit);
}

function subjectTaskId(control) {
	const subjectId = control.target?.subjectId;
	if (typeof subjectId !== "string" || !subjectId.startsWith(`${OWNER}:`)) return undefined;
	return subjectId.slice(OWNER.length + 1);
}

function ownerOf(control) {
	return control.target?.taskRef?.owner ?? (subjectTaskId(control) ? OWNER : undefined);
}

/**
 * Bridge one Coordinator to the layered Observer protocol.
 *
 * Facts are display-only copies of durable coordinator state. Controls are
 * requests from another process; only pause/resume/cancel are applied, and only
 * through Coordinator.applyControl. The bridge never touches the executor and
 * never starts or revises work.
 */
export function createObserverBridge(options = {}, extra = {}) {
	const positional = typeof options?.snapshot === "function";
	const settings = positional ? (extra ?? {}) : (options ?? {});
	const coordinator = positional ? options : settings.coordinator;
	const { workspace = null, root = observerRoot(), log = () => {}, confirmTimeoutMs = 10_000, confirmPollMs = 200, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = settings;
	if (typeof coordinator?.snapshot !== "function" || typeof coordinator?.applyControl !== "function") throw new TypeError("Observer bridge requires a Coordinator");
	const directory = root;

	/** Publish the newest tasks; writing the same state again is harmless. */
	async function publishTaskFacts(snapshot = coordinator.snapshot()) {
		if (!snapshot || !Array.isArray(snapshot.tasks)) throw new TypeError("Observer snapshot requires tasks");
		const now = Date.now();
		const tasks = newestTasks(snapshot.tasks);
		for (const task of tasks) await writeTaskFact(directory, taskFact(task, workspace, now));
		return tasks.length;
	}

	async function reject(control, detail) {
		await completeControl(directory, control.commandId, "rejected", detail);
	}

	async function handleControl(control, allowControl) {
		const owner = ownerOf(control);
		if (owner !== OWNER) return; // another adapter owns this fact or request
		if (!allowControl) { await reject(control, "control-disabled"); return; }
		if (!CONTROL_ACTIONS.has(control.action)) { await reject(control, "unsupported-action"); return; }
		const taskId = control.target?.taskRef?.taskId ?? subjectTaskId(control);
		const task = coordinator.snapshot().tasks.find((item) => item.id === taskId);
		if (!task) { await reject(control, "unknown-task"); return; }
		const expectedRevision = control.target?.taskRef?.revision ?? control.expectedRevision;
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== task.revision) { await reject(control, "revision-mismatch"); return; }
		if (control.expectedRevision != null && control.expectedRevision !== task.revision) { await reject(control, "revision-mismatch"); return; }
		try {
			await coordinator.applyControl({ action: control.action, taskId, expectedRevision });
			// "Applied" means the owner saw the settled effect, not merely that it
			// accepted the request. A stop that is still waiting for native
			// confirmation stays honest as `unknown`.
			const expected = SETTLED[control.action];
			let status = coordinator.snapshot().tasks.find((item) => item.id === taskId)?.status;
			const end = Date.now() + confirmTimeoutMs;
			while (!expected.has(status) && Date.now() < end) { await sleep(confirmPollMs); status = coordinator.snapshot().tasks.find((item) => item.id === taskId)?.status; }
			if (expected.has(status)) await completeControl(directory, control.commandId, "applied", `${control.action}:${status}`);
			else await completeControl(directory, control.commandId, "unknown", `${control.action}: awaiting owner confirmation (${status ?? "missing"})`);
		} catch (error) {
			await reject(control, error?.message || "apply-failed");
		}
	}

	/** Protocol receipts omit the requested action; the queued request still carries intent. */
	async function withRequestedAction(control) {
		const request = JSON.parse(await readFile(join(directory, "control", "pending", `${safeName(control.commandId)}.json`), "utf8"));
		return { ...control, action: request.action, expectedRevision: request.expectedRevision ?? control.expectedRevision };
	}

	async function consumeOnce(allowControl) {
		let controls;
		try { controls = await listControls(directory); }
		catch (error) { log("error", `Observer controls unavailable: ${error.message}`); return; }
		for (const queued of controls) {
			let control;
			try { control = await withRequestedAction(queued); }
			catch (error) { if (error.code !== "ENOENT") log("error", `Observer control ${queued.commandId} unreadable: ${error.message}`); continue; }
			try { await handleControl(control, allowControl); }
			catch (error) { log("error", `Observer control ${control.commandId} failed: ${error.message}`); }
		}
	}

	let tail = Promise.resolve();
	/**
	 * Drain queued controls one run at a time. Errors are logged and never
	 * reject the caller, so a timer tick cannot crash or overlap.
	 */
	function consumeControls({ allowControl = false } = {}) {
		const run = tail.then(() => consumeOnce(allowControl === true)).catch((error) => { log("error", `Observer control tick failed: ${error.message}`); });
		tail = run;
		return run;
	}

	return { root: directory, publishTaskFacts, consumeControls };
}

export const observerBridge = createObserverBridge;
export default createObserverBridge;
