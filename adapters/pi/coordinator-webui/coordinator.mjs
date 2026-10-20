import { isDeepStrictEqual } from "node:util";

const ACTIONS = new Set(["task", "question", "revise", "pause", "resume", "cancel", "clarify"]);
const TERMINAL = new Set(["verified", "failed", "cancelled"]);
const OCCUPIED = new Set(["starting", "running", "stopping", "needs_reconciliation"]);
const copy = (value) => structuredClone(value);
const systemClock = { now: () => Date.now(), setTimeout, clearTimeout };

/**
 * Durable ingress and bounded scheduling around a trusted native goal executor.
 * storage.read() returns a snapshot or null; storage.write(snapshot) MUST atomically
 * persist it before resolving. Use one coordinator per storage namespace.
 * classify(input, snapshot) returns ONLY {action, text, targetId?, answer?}; it has
 * no authority to choose cwd, commands, permissions, or executor configuration.
 * executor.start({id, objective, revision, amendments}) returns a JSON-safe native
 * handle, not a task-completion promise. Other operations receive
 * {id, handle, revision, controlId?, nextRevision?, text?}; revise must stop the old run.
 * pause/revise/cancel resolve with {stopped:true} only after confirmed cessation;
 * otherwise the host must later call observe(). resume confirms with
 * {running:true} or {status:'running'} and reuses the paused handle.
 * status is optional and returns the same evidence format as observe().
 * publish receives {type:'coordinator-state', state}; delivery is best effort.
 * clock supplies now(), setTimeout(fn, ms), clearTimeout(token), in milliseconds.
 */
export class Coordinator {
	/** Construct without I/O; call restore() before use (submit/tick do so too). */
	constructor({ storage, classify, executor, publish = () => {}, clock = systemClock, maxConcurrent = 2, checkpointMs = 15_000, maxRuntimeMs = 30 * 60_000, controlDrainMs = 1000, requireCoverage = false, maxCoverageRepairs = 2 }) {
		if (!storage?.read || !storage?.write || typeof classify !== "function" || !executor?.start) throw new TypeError("Missing coordinator dependencies");
		if (![maxConcurrent, checkpointMs, maxRuntimeMs, controlDrainMs].every((n) => Number.isSafeInteger(n) && n > 0)) throw new TypeError("Invalid coordinator limits");
		if (typeof requireCoverage !== "boolean" || !Number.isSafeInteger(maxCoverageRepairs) || maxCoverageRepairs < 0 || maxCoverageRepairs > 5) throw new TypeError("Invalid coverage limits");
		Object.assign(this, { storage, classify, executor, publish, clock, maxConcurrent, checkpointMs, maxRuntimeMs, controlDrainMs, requireCoverage, maxCoverageRepairs });
		this._state = { schemaVersion: 1, nextId: 1, paused: false, inputs: [], tasks: [] };
		this._tail = Promise.resolve();
		this._effects = new Map();
		this._polls = new Set();
		this._closed = false;
		this._fault = null;
	}

	/** Load once; uncertain dispatches are reconciled, never automatically restarted. */
	restore() {
		if (!this._ready) this._ready = this._load();
		return this._ready;
	}

	async _load() {
		const saved = await this.storage.read();
		if (saved != null) {
			if (saved.schemaVersion !== 1 || !Array.isArray(saved.inputs) || !Array.isArray(saved.tasks) || !Number.isSafeInteger(saved.nextId)) throw new Error("Unsupported coordinator snapshot");
			this._state = copy(saved);
			await this._change((state) => {
				for (const task of state.tasks) {
					if (OCCUPIED.has(task.status)) {
						task.status = "needs_reconciliation";
						task.gap = "Reload requires native execution reconciliation";
					}
				}
			});
		}
		this._kick();
		this._arm();
		for (const task of this._state.tasks) if (task.handle != null && !TERMINAL.has(task.status)) this._poll(task);
		return this.snapshot();
	}

	/** Return an isolated snapshot; mutating it cannot change durable state. */
	snapshot() { return copy(this._state); }

	/** Persist the exact raw text before returning its receipt; never waits for classification. */
	async submit(text, { requestId } = {}) {
		await this.restore();
		if (this._closed) throw new Error("Coordinator stopped");
		if (typeof text !== "string" || !text.trim() || text.length > 16000) throw new TypeError("Bounded input text is required");
		if (requestId != null && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId))) throw new TypeError("Invalid request ID");
		const receipt = await this._change((state) => {
			const previous = requestId && state.inputs.find((item) => item.requestId === requestId);
			if (previous) {
				if (previous.text !== text) throw new Error("Request ID already belongs to another input");
				return { id: previous.id, acceptedAt: previous.acceptedAt };
			}
			const id = `input-${state.nextId++}`;
			const acceptedAt = this.clock.now();
			state.inputs.push({ id, text, ...(requestId ? { requestId } : {}), acceptedAt, status: "pending" });
			return { id, acceptedAt };
		});
		this._kick();
		return receipt;
	}

	/**
	 * Consume trusted native evidence, never model claims. Events require revision
	 * and status. Only status:'passed', nativeReview:'passed' for the current run
	 * may verify a task. Terminal statuses imply cessation; {stopped:true} also
	 * confirms it. Old-run events cannot overwrite a newer run. Unknown evidence
	 * reserves the execution slot until reconciliation rather than causing retries.
	 * Stop callbacks may echo controlId to bind evidence to the issued operation;
	 * current-revision native review passes remain terminal even while paused.
	 */
	async observe(id, event) {
		await this.restore();
		if (!event || !Number.isSafeInteger(event.revision)) throw new TypeError("Native event requires revision");
		await this._change((state) => {
			const task = state.tasks.find((item) => item.id === id);
			if (!task || task.runRevision !== event.revision || TERMINAL.has(task.status)) return;
			if (event.controlId != null && task.control?.id !== event.controlId) return;
			if (task.revision === event.revision && event.status === "passed" && event.nativeReview === "passed") {
				task.nativeCompletion = { revision: event.revision, nativeReview: "passed", ...(event.nativeEvidence ? { nativeEvidence: copy(event.nativeEvidence) } : {}) };
				if (task.desired === "cancel") { task.status = "cancelled"; task.handle = null; task.gap = "Native work completed before cancellation; side effects are not rolled back"; return; }
				if (this.requireCoverage && event.coverage?.status !== "passed") {
					task.coverage = copy(event.coverage || { status: "pending" });
					if (task.coverage.status === "pending") { task.gap = "Whole-objective coverage check pending"; return; }
					if (task.coverage.status === "missing" && Array.isArray(task.coverage.missing) && task.coverage.missing.length && (task.coverageRepairs || 0) < this.maxCoverageRepairs && task.desired === "run" && !state.paused) {
						task.coverageRepairs = (task.coverageRepairs || 0) + 1;
						task.handle = null;
						task.revision++;
						task.amendments.push({ revision: task.revision, text: `Existing requirements still need evidence; preserve the entire original objective:\n${task.coverage.missing.map((item) => `${item.requirement}: ${item.evidenceGap}`).join("\n")}`, source: "coverage-review" });
						task.status = "queued";
						task.gap = "Native round passed but whole-objective coverage is incomplete";
					} else {
						task.status = task.desired === "cancel" ? "cancelled" : "paused";
						task.desired = task.desired === "cancel" ? "cancel" : "pause";
						task.gap = task.coverage.gap || "Whole-objective coverage unresolved or repair budget exhausted";
					}
					return;
				}
				task.coverage = copy(event.coverage || null);
				task.status = "verified";
				task.handle = null;
				task.gap = null;
				return;
			}
			if (["queued", "paused"].includes(task.status)) return;
			const ended = event.stopped === true || ["passed", "failed", "cancelled", "stopped", "paused"].includes(event.status);
			if (ended) {
				const control = task.control?.revision === event.revision ? task.control : null;
				task.stopEvidence = { revision: event.revision, operationId: control?.id ?? null, operation: control?.operation ?? event.status };
				const resumable = task.revision === event.revision && (control?.operation === "pause" || event.status === "paused") && !["passed", "failed", "cancelled"].includes(event.status);
				if (!resumable) task.handle = null;
				if (task.desired === "cancel") { task.status = "cancelled"; task.handle = null; }
				else if (task.desired === "pause" || state.paused) task.status = "paused";
				else if (task.revision !== event.revision || resumable) task.status = "queued";
				else {
					task.status = event.status === "failed" ? "failed" : "needs_reconciliation";
					task.gap = event.gap || "Native goal review has not passed";
				}
			} else if (event.status === "running") {
				const interrupted = task.desired !== "run" || task.revision !== task.runRevision || state.paused;
				if (interrupted) task.status = "stopping";
				else if (task.handle != null) task.status = "running";
			} else {
				task.status = "needs_reconciliation";
				task.gap = event.gap || "Native execution status is unknown";
			}
		});
		this._kick();
	}

	/** Check wall-clock deadlines and native status; never runs an LLM or retries a goal. */
	async tick() {
		await this.restore();
		if (this._closed || this._fault) return;
		const now = this.clock.now();
		if (!this._state.tasks.some((task) => OCCUPIED.has(task.status) && ((task.nextCheckAt != null && task.nextCheckAt <= now) || (task.deadlineAt != null && task.deadlineAt <= now && task.desired === "run")))) return;
		const due = await this._change((state) => {
			const ids = [];
			const now = this.clock.now();
			for (const task of state.tasks) {
				if (!OCCUPIED.has(task.status)) continue;
				if (task.deadlineAt != null && now >= task.deadlineAt && task.desired === "run") {
					task.desired = "pause";
					task.status = task.handle != null ? "stopping" : "needs_reconciliation";
					task.gap = "Wall-clock runtime budget exceeded";
				}
				if (task.nextCheckAt != null && now >= task.nextCheckAt) {
					task.checkpoint = { at: now, status: task.status };
					task.nextCheckAt = now + this.checkpointMs;
					ids.push(task.id);
				}
			}
			return ids;
		});
		for (const id of due) this._poll(this._state.tasks.find((task) => task.id === id));
		this._kick();
	}

	/** Stop dispatch and timers, request pauses, then return the bounded whenIdleControls result. */
	stop() {
		this._closed = true;
		if (!this._stopPromise) this._stopPromise = (async () => {
			await this.restore();
			try { await this._change((state) => this._pauseAll(state)); }
			finally {
				this._closed = true;
				this.clock.clearTimeout(this._timer);
				this.clock.clearTimeout(this._wake);
				this._wake = null;
			}
			return this.whenIdleControls();
		})();
		return this._stopPromise;
	}

	/** Alias for stop(); returns the same bounded transport-drain result. */
	dispose() { return this.stop(); }

	/**
	 * Transport teardown barrier, including controls needed after in-flight starts.
	 * Resolves {status:'idle'|'unknown', pending:[task IDs]} within timeoutMs even
	 * if an executor never settles. Unknown is NOT evidence of native cessation.
	 */
	async whenIdleControls({ timeoutMs = this.controlDrainMs } = {}) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("Invalid control drain timeout");
		let timer;
		let expired = false;
		const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
		const drain = (async () => {
			do {
				await this._drive();
				await this._tail;
				if (this._effects.size) await Promise.all([...this._effects.values()]);
				else if (!this._driving) return true;
				else await new Promise((resolve) => setTimeout(resolve, 0));
			} while (!expired);
			return false;
		})();
		try {
			const drained = await Promise.race([drain, deadline]);
			const pending = [...new Set([...this._effects.keys(), ...this._state.tasks.filter((task) => OCCUPIED.has(task.status)).map((task) => task.id)])];
			return { status: drained && pending.length === 0 ? "idle" : "unknown", pending };
		} finally { expired = true; clearTimeout(timer); }
	}

	_change(update) {
		const operation = this._tail.then(async () => {
			if (this._fault) throw this._fault;
			const next = copy(this._state);
			const result = update(next);
			if (isDeepStrictEqual(next, this._state)) return result;
			try { await this.storage.write(copy(next)); }
			catch (error) { this._fault = error; throw error; }
			this._state = next;
			try { Promise.resolve(this.publish({ type: "coordinator-state", state: this.snapshot() })).catch(() => {}); } catch {}
			return result;
		});
		this._tail = operation.catch(() => {});
		return operation;
	}

	_arm() {
		if (this._closed || this._fault) return;
		this._timer = this.clock.setTimeout(() => {
			this.tick().catch(() => {}).finally(() => this._arm());
		}, this.checkpointMs);
		this._timer?.unref?.();
	}

	_kick() {
		if (this._fault) return;
		if (this._closed) { void this._drive().catch(() => {}); return; }
		if (this._wake != null) return;
		this._wake = this.clock.setTimeout(() => {
			this._wake = null;
			void this._classifyPending().catch(() => {});
			void this._drive().catch(() => {});
		}, 0);
		this._wake?.unref?.();
	}

	async _classifyPending() {
		if (this._classifying || this._closed || this._fault) return;
		this._classifying = true;
		try {
			while (!this._closed && !this._fault) {
				const input = this._state.inputs.find((item) => item.status === "pending");
				if (!input) break;
				let result;
				try {
					result = await this.classify(copy(input), this.snapshot());
					if (!result || Array.isArray(result) || !ACTIONS.has(result.action) || typeof result.text !== "string" || Object.keys(result).some((key) => !["action", "text", "targetId", "answer"].includes(key)) || (result.targetId != null && typeof result.targetId !== "string") || (result.answer != null && typeof result.answer !== "string")) throw new Error("Invalid classification contract");
				} catch (error) {
					result = { action: "clarify", text: `Classification unavailable: ${error.message}` };
				}
				await this._change((state) => this._route(state, input.id, result));
				this._kick();
			}
		} finally { this._classifying = false; }
	}

	_pauseAll(state) {
		state.paused = true;
		for (const task of state.tasks) {
			if (TERMINAL.has(task.status) || task.desired === "cancel") continue;
			task.desired = "pause";
			if (task.nativeCompletion?.revision === task.revision) { task.status = "paused"; continue; }
			if (task.handle != null && task.status !== "paused") task.status = "stopping";
			else if (task.status === "queued") task.status = "paused";
		}
	}

	_route(state, inputId, result) {
		if (this._closed) return;
		const input = state.inputs.find((item) => item.id === inputId);
		input.status = "classified";
		input.classification = copy(result);
		if (["question", "clarify"].includes(result.action)) {
			input.status = result.action;
			input.answer = result.answer ?? result.text;
			return;
		}
		if (result.action === "task") {
			const id = `task-${state.nextId++}`;
			state.tasks.push({ id, inputId, sourceText: input.text, objective: result.text, revision: 1, amendments: [], desired: state.paused ? "pause" : "run", status: state.paused ? "paused" : "queued", handle: null, createdAt: this.clock.now() });
			input.taskId = id;
			return;
		}
		if (!result.targetId && result.action === "pause") { this._pauseAll(state); return; }
		if (!result.targetId && result.action === "resume") {
			state.paused = false;
			for (const task of state.tasks) if (task.desired === "pause") this._resume(task);
			return;
		}
		const candidates = state.tasks.filter((task) => !TERMINAL.has(task.status));
		const task = result.targetId ? state.tasks.find((item) => item.id === result.targetId) : candidates.length === 1 ? candidates[0] : null;
		if (!task || TERMINAL.has(task.status)) {
			input.status = "clarify";
			input.answer = "Specify one non-terminal task ID";
			return;
		}
		input.taskId = task.id;
		if (result.action === "revise") {
			task.revision++;
			task.amendments.push({ revision: task.revision, text: result.text, inputId });
			if (task.stopEvidence?.revision === task.runRevision || task.nativeCompletion?.revision === task.runRevision) task.handle = null;
			if (task.nativeCompletion?.revision === task.runRevision) task.status = task.desired === "run" ? "queued" : "paused";
			else if (task.handle != null) task.status = "stopping";
			else if (task.status !== "starting" && task.status !== "needs_reconciliation") task.status = task.desired === "run" ? "queued" : "paused";
		} else if (result.action === "resume") this._resume(task);
		else {
			task.desired = result.action;
			if (task.nativeCompletion?.revision === task.revision) { task.handle = null; task.status = result.action === "cancel" ? "cancelled" : "paused"; }
			else if (task.handle != null) task.status = "stopping";
			else if (!["starting", "needs_reconciliation"].includes(task.status)) task.status = result.action === "cancel" ? "cancelled" : "paused";
		}
	}

	_resume(task) {
		task.desired = "run";
		if (task.nativeCompletion?.revision === task.revision && task.status === "paused") {
			task.coverageAttempt = (task.coverageAttempt || 0) + 1;
			task.status = "needs_reconciliation";
			task.nextCheckAt = this.clock.now();
			return;
		}
		if (task.status === "paused") task.status = "queued";
		else if (task.status === "stopping" && task.handle != null && task.control == null && task.runRevision === task.revision) task.status = "running";
	}

	async _drive() {
		if (this._driving || this._fault) return;
		this._driving = true;
		try {
			for (const task of this._state.tasks) {
				if (this._effects.has(task.id) || task.handle == null || TERMINAL.has(task.status)) continue;
				if (task.status === "paused") continue;
				if (task.desired !== "run" || task.runRevision !== task.revision || this._state.paused) {
					const operation = task.desired === "cancel" ? "cancel" : task.runRevision !== task.revision ? "revise" : "pause";
					if ((task.control?.key ?? task.control) !== `${operation}:${task.runRevision}:${task.revision}`) this._effect(task, () => this._control(task));
				}
			}
			while (!this._closed && !this._state.paused && !this._fault) {
				if (this._state.tasks.filter((task) => OCCUPIED.has(task.status)).length >= this.maxConcurrent) break;
				const task = this._state.tasks.find((item) => item.status === "queued" && item.desired === "run" && !this._effects.has(item.id));
				if (!task) break;
				const reserved = await this._change((state) => {
					const item = state.tasks.find((entry) => entry.id === task.id);
					if (state.paused || item.status !== "queued" || item.desired !== "run") return null;
					const now = this.clock.now();
					if (item.deadlineAt != null && now >= item.deadlineAt) {
						item.status = "paused"; item.desired = "pause"; item.gap = "Wall-clock runtime budget exceeded"; return null;
					}
					if (item.handle != null && item.runRevision !== item.revision) {
						if (item.stopEvidence?.revision === item.runRevision) item.handle = null;
						else { item.status = "stopping"; return null; }
					}
					item.control = null;
					item.status = "starting";
					item.runRevision = item.revision;
					item.startedAt ??= now;
					item.deadlineAt ??= now + this.maxRuntimeMs;
					item.nextCheckAt = now + this.checkpointMs;
					return copy(item);
				});
				if (reserved) this._effect(reserved, () => this._start(reserved));
				else this._kick();
			}
		} finally { this._driving = false; }
	}

	_effect(task, operation) {
		const promise = Promise.resolve().then(operation).catch(async (error) => {
			if (this._fault) return;
			await this._change((state) => {
				const current = state.tasks.find((item) => item.id === task.id);
				if (current.runRevision !== task.runRevision || TERMINAL.has(current.status)) return;
				if (current.stopEvidence?.revision === task.runRevision && ["queued", "paused"].includes(current.status)) return;
				if (error.notStarted === true && current.handle == null) {
					current.status = "paused"; current.desired = "pause"; current.gap = error.message;
					delete current.startedAt; delete current.deadlineAt; delete current.nextCheckAt;
					return;
				}
				if (error.handle != null && current.handle == null) current.handle = copy(error.handle);
				current.status = "needs_reconciliation";
				current.gap = `Native operation uncertain: ${error.message}`;
			});
		}).catch(() => {}).finally(() => { this._effects.delete(task.id); this._kick(); });
		this._effects.set(task.id, promise);
	}

	async _start(task) {
		const latest = this._state.tasks.find((item) => item.id === task.id);
		if (this._closed || this._state.paused || latest.desired !== "run" || latest.revision !== task.runRevision) {
			await this._change((state) => {
				const item = state.tasks.find((entry) => entry.id === task.id);
				item.status = item.desired === "cancel" ? "cancelled" : item.desired === "pause" || state.paused ? "paused" : "queued";
			});
			return;
		}
		let handle;
		if (task.handle != null) {
			if (!this.executor.resume) throw new Error("Native resume unavailable");
			const event = await this.executor.resume({ id: task.id, handle: copy(task.handle), revision: task.runRevision, stopEvidence: copy(task.stopEvidence) });
			if (event?.running !== true && event?.status !== "running") throw new Error("Native resume not confirmed");
			handle = task.handle;
		} else handle = await this.executor.start({ id: task.id, objective: task.objective, sourceText: task.sourceText, revision: task.runRevision, amendments: copy(task.amendments) });
		if (handle == null) throw new Error("Native start returned no handle");
		await this._change((state) => {
			const current = state.tasks.find((item) => item.id === task.id);
			if (current.runRevision !== task.runRevision || !["starting", "stopping", "needs_reconciliation", "running"].includes(current.status)) return;
			current.handle = copy(handle);
			if (!current.coverage) current.gap = null;
			current.stopEvidence = null;
			current.status = current.desired === "run" && !state.paused && current.revision === task.runRevision ? "running" : "stopping";
		});
	}

	async _control(task) {
		const operation = task.desired === "cancel" ? "cancel" : task.runRevision !== task.revision ? "revise" : "pause";
		const args = { id: task.id, handle: copy(task.handle), revision: task.runRevision };
		if (operation === "revise") Object.assign(args, { nextRevision: task.revision, text: task.amendments.at(-1)?.text });
		const approved = await this._change((state) => {
			const current = state.tasks.find((item) => item.id === task.id);
			if (current.runRevision !== task.runRevision || current.revision !== task.revision || current.desired !== task.desired || current.handle == null || TERMINAL.has(current.status)) return false;
			current.control = { id: `control-${state.nextId++}`, operation, revision: task.runRevision, key: `${operation}:${task.runRevision}:${task.revision}` };
			return copy(current.control);
		});
		if (!approved) return;
		args.controlId = approved.id;
		const response = await this.executor[operation]?.(args);
		if (response?.stopped === true) await this.observe(task.id, { revision: task.runRevision, controlId: approved.id, status: "stopped", stopped: true });
		else await this._change((state) => {
			const current = state.tasks.find((item) => item.id === task.id);
			if (current.runRevision === task.runRevision && current.control?.id === approved.id && !TERMINAL.has(current.status) && !["queued", "paused"].includes(current.status)) {
				current.status = "needs_reconciliation";
				current.gap = "Awaiting native stop confirmation";
			}
		});
	}

	_poll(task) {
		if (!task || (task.handle == null && task.nativeCompletion?.revision !== task.revision) || !this.executor.status || this._polls.has(task.id) || this._effects.has(task.id)) return;
		this._polls.add(task.id);
		Promise.resolve().then(() => this.executor.status({ id: task.id, handle: copy(task.handle), revision: task.runRevision }))
			.then((event) => this.observe(task.id, event ?? { revision: task.runRevision, status: "unknown" }))
			.catch((error) => this.observe(task.id, { revision: task.runRevision, status: "unknown", gap: `Native status unavailable: ${error.message}` }).catch(() => {}))
			.finally(() => this._polls.delete(task.id));
	}
}
