import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

const clone = (value) => structuredClone(value);
const terminal = (goal) => goal && ["idle", "blocked", "exhausted", "failed"].includes(goal.phase) && ["pass", "fail", "blocked", "exhausted", "failed"].includes(goal.verdict);

/**
 * Loopback-only adapter for pi-web-ui 0.100's native GoalService protocol.
 * No prompts, executor or reviewer are implemented here. Each task owns a client
 * and persistent reviewer conversation; GoalService owns the executor and audit.
 * onEvent(id, evidence) is best effort: callers must also poll status after saving
 * the returned handle (native completion can precede start's return).
 * timeoutMs bounds each protocol wait. Authentication stays in private memory.
 */
export class WebUiExecutor {
	#endpoint;
	#WebSocket;
	#records = new Map();
	#starts = new Map();
	#closed = false;

	constructor({ url, token, cwd, model, maxRounds = 3, WebSocketImpl = globalThis.WebSocket, onEvent = () => {}, timeoutMs = 10_000 }) {
		let endpoint;
		try { endpoint = new URL(url); } catch { throw new TypeError("Invalid Web UI endpoint"); }
		if (!/^ws:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^?#]*)?$/.test(url) || endpoint.protocol !== "ws:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new TypeError("Web UI requires a query-free loopback ws:// endpoint");
		if (token != null && typeof token !== "string") throw new TypeError("Invalid token");
		if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new TypeError("An absolute cwd is required");
		if (model != null && (typeof model !== "string" || !model.includes("/"))) throw new TypeError("Model must be provider/model");
		if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 50 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("Invalid finite limits");
		if (typeof WebSocketImpl !== "function") throw new TypeError("WebSocket implementation required");
		if (token) endpoint.searchParams.set("token", token);
		this.#endpoint = endpoint.href;
		this.#WebSocket = WebSocketImpl;
		Object.assign(this, { cwd, model, maxRounds, onEvent, timeoutMs });
	}

	/** Start once per task ID. Failed/uncertain dispatches are never retried. */
	start(task) {
		if (this.#closed) return Promise.reject(new Error("Executor disposed"));
		if (!task || typeof task.id !== "string" || !task.id || typeof task.objective !== "string" || !task.objective.trim() || !Number.isSafeInteger(task.revision)) return Promise.reject(new TypeError("Invalid task"));
		const key = `${task.id}:${task.revision}`;
		if (this.#starts.has(key)) return this.#starts.get(key);
		const promise = this._start(task);
		this.#starts.set(key, promise);
		return promise;
	}

	async _start(task) {
		const amendments = (task.amendments ?? []).map((item) => {
			if (typeof item.text !== "string") throw new TypeError("Invalid amendment");
			return { revision: item.revision, text: item.text };
		});
		const handle = { clientId: randomUUID(), conversationId: null, objective: task.objective, ...(task.sourceText ? { sourceText: task.sourceText } : {}), revision: task.revision, amendments };
		const record = this._record(task.id, handle);
		this.#records.set(handle.clientId, record);
		try {
			await this._connect(record);
			if (record.state.cwd !== this.cwd) await this._command(record, { type: "set_cwd", path: this.cwd }, () => record.state?.cwd === this.cwd);
			const previousId = record.state.conversationId;
			await this._command(record, { type: "new_chat", ephemeral: true }, () => record.state?.conversationId && record.state.conversationId !== previousId && record.state.isEphemeral === true);
			handle.conversationId = record.state.conversationId;
			record.handle.conversationId = handle.conversationId;
			await this._command(record, { type: "persist_conversation", id: handle.conversationId }, () => this._same(record) && record.state.isEphemeral === false);
			if (!this._same(record) || record.state.cwd !== this.cwd) throw new Error("Conversation or cwd not confirmed");
			if (this.model) await this._command(record, { type: "set_model", modelId: this.model }, () => this._same(record) && `${record.state.model?.provider}/${record.state.model?.id}` === this.model);
			await this._setGoal(record);
			return clone(handle);
		} catch {
			const error = new Error("Native start unconfirmed; reconcile before any new dispatch");
			error.handle = clone(handle);
			throw error;
		}
	}

	_record(id, handle) {
		return { id, handle: clone(handle), state: null, goal: null, goalSeq: 0, seq: 0, waits: new Set(), connected: false, syncing: false, stopping: false };
	}

	_same(record) { return record.state?.conversationId === record.handle.conversationId; }
	_goalText(handle) {
		return [handle.objective, ...(handle.sourceText && handle.sourceText !== handle.objective ? [`Original user request (all requirements remain binding):\n${handle.sourceText}`] : []), ...handle.amendments.map((item) => `Additional requirement, not a replacement objective:\n${item.text}`)].join("\n\n").trim();
	}

	async _connect(record) {
		if (this.#closed) throw new Error("Executor disposed");
		if (record.connected) return;
		if (record.connecting) return record.connecting;
		record.connecting = (async () => {
			record.state = null;
			record.goal = null;
			record.ready = false;
			record.syncing = false;
			let socket;
			try { socket = new this.#WebSocket(this.#endpoint); } catch { throw new Error("Web UI connection unavailable"); }
			record.socket = socket;
			const disconnected = () => {
				if (record.socket !== socket) return;
				record.connected = false;
				for (const wait of [...record.waits]) wait.fail();
				this._publish(record);
			};
			socket.addEventListener("open", () => {
				if (this.#closed || record.socket !== socket) return;
				record.connected = true;
				this._send(record, { type: "hello", clientId: record.handle.clientId });
			});
			socket.addEventListener("message", (event) => {
				if (record.socket !== socket) return;
				let message;
				try { message = JSON.parse(String(event.data)); } catch { return; }
				this._receive(record, message);
			});
			socket.addEventListener("close", disconnected);
			socket.addEventListener("error", disconnected);
			try {
				await this._wait(record, () => record.ready && record.state != null);
				if (record.handle.conversationId && !this._same(record)) throw new Error("Native conversation changed; reconciliation required");
			} catch {
				record.connected = false;
				try { socket.close(); } catch {}
				throw new Error("Web UI handshake unconfirmed");
			}
		})();
		try { await record.connecting; } finally { record.connecting = null; }
	}

	_send(record, message) {
		if (!record.connected || this.#closed) throw new Error("Web UI disconnected");
		try { record.socket.send(JSON.stringify(message)); } catch { throw new Error("Web UI send unconfirmed"); }
	}

	_wait(record, predicate) {
		if (predicate()) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const finish = (error) => {
				clearTimeout(timer);
				record.waits.delete(wait);
				error ? reject(error) : resolve();
			};
			const wait = { check: () => { if (predicate()) finish(); }, fail: () => finish(new Error("Web UI response unconfirmed")) };
			const timer = setTimeout(wait.fail, this.timeoutMs);
			record.waits.add(wait);
		});
	}

	async _command(record, message, predicate) {
		const seq = record.seq;
		const pending = this._wait(record, () => record.seq > seq && predicate());
		try { this._send(record, message); } catch {
			for (const wait of [...record.waits]) wait.fail();
		}
		await pending;
	}

	_receive(record, message) {
		record.seq++;
		if (message.type === "ready") record.ready = message.clientId === record.handle.clientId;
		if (message.type === "snapshot") {
			if (message.state?.clientId !== record.handle.clientId || !Number.isSafeInteger(message.state.rev)) return;
			record.state = clone(message.state);
			record.syncing = false;
		} else if (message.type === "snapshot_delta") {
			if (!record.syncing && record.state && message.baseRev === record.state.rev && message.conversationId === record.state.conversationId && Number.isSafeInteger(message.rev) && message.rev > message.baseRev && Array.isArray(message.appended)) {
				record.state = { ...record.state, ...message.state, rev: message.rev, messages: [...(record.state.messages ?? []), ...message.appended] };
			} else {
				if (!record.syncing) {
					record.syncing = true;
					try { this._send(record, { type: "get_state" }); } catch {}
				}
			}
		} else if (message.type === "goal_status") {
			record.goal = clone(message.status);
			record.goalSeq++;
		} else if (message.type === "conversations" && Array.isArray(message.conversations)) {
			record.conversations = clone(message.conversations);
			record.conversationListSeq = record.seq;
		}
		for (const wait of [...record.waits]) wait.check();
		this._publish(record);
	}

	async _setGoal(record) {
		if (!this._same(record) || record.state.cwd !== this.cwd || record.state.isEphemeral !== false || record.syncing) throw new Error("Native execution context not confirmed");
		const goal = this._goalText(record.handle);
		const seq = record.goalSeq;
		await this._command(record, { type: "set_goal", goal, locked: true, maxRounds: this.maxRounds, ...(this.model ? { execModel: this.model } : {}) }, () => record.goalSeq > seq && record.goal?.conversationId === record.handle.conversationId && record.goal.goal === goal && record.goal.locked === true && record.goal.maxRounds === this.maxRounds);
		record.accepted = true;
	}

	_evidence(record) {
		const base = { revision: record.handle.revision };
		if (!record.connected || !this._same(record) || record.syncing || record.stopping) return { ...base, status: "unknown", gap: record.stopping ? "Native stop is best-effort; executor cessation is not provable through this protocol" : "Native connection or snapshot requires reconciliation" };
		const goal = record.goal;
		const matches = goal?.conversationId === record.handle.conversationId && goal.goal === this._goalText(record.handle);
		const passed = record.accepted && goal?.goal == null && goal?.conversationId == null && goal?.verdict === "pass" && goal?.phase === "idle";
		if (passed) return { ...base, status: "passed", nativeReview: "passed", nativeEvidence: {
			feedback: String(goal.feedback || "").slice(0, 2000), round: goal.round,
			messages: (record.state.messages || []).slice(-10).map((message) => ({ role: message.role, text: (typeof message.content === "string" ? message.content : (message.content || []).filter((part) => typeof part.text === "string").map((part) => part.text).join("\n")).slice(0, 6000) })),
		} };
		if (matches && terminal(goal)) return { ...base, status: "failed", gap: "Native goal review failed" };
		if (matches) return { ...base, status: "running" };
		return { ...base, status: "unknown", gap: "No matching native goal evidence" };
	}

	_publish(record) {
		if (!record.handle.conversationId) return;
		const evidence = this._evidence(record);
		const signature = JSON.stringify(evidence);
		if (record.lastEvidenceSignature === signature) return;
		record.lastEvidenceSignature = signature;
		try { Promise.resolve(this.onEvent(record.id, evidence)).catch(() => {}); } catch {}
	}

	async _lookup({ id, handle, revision }) {
		if (!handle?.clientId || !handle.conversationId || handle.revision !== revision) throw new Error("Invalid native handle");
		let record = this.#records.get(handle.clientId);
		if (!record) {
			record = this._record(id, handle);
			record.accepted = true;
			this.#records.set(handle.clientId, record);
		}
		if (record.handle.conversationId !== handle.conversationId || record.handle.revision !== revision || record.id !== id) throw new Error("Native handle mismatch");
		await this._connect(record);
		if (!this._same(record) || record.state.cwd !== this.cwd || record.syncing) throw new Error("Native execution context changed");
		return record;
	}

	/** Reattach only; never starts or repeats a goal. Disconnection stays unknown. */
	async status(args) {
		try {
			const record = await this._lookup(args);
			return this._evidence(record);
		} catch { return { revision: args.revision, status: "unknown", gap: "Native status unavailable; reconciliation required" }; }
	}

	async _stop(args, reason) {
		try {
			const record = await this._lookup(args);
			if (record.goal?.conversationId !== record.handle.conversationId || record.goal?.goal !== this._goalText(record.handle)) {
				return { revision: args.revision, status: "unknown", stopped: false, gap: "Native goal changed outside coordinator; no control message sent" };
			}
			record.stopping = true;
			record.stopReason = reason;
			record.previousExecutorId = record.goal?.roles?.executor?.convId ?? null;
			const knownRole = record.previousExecutorId && record.conversations?.some((item) => item.id === record.previousExecutorId);
			const beforeStop = record.seq;
			this._send(record, { type: "clear_goal" });
			this._send(record, { type: "abort" });
			await this._command(record, { type: "get_state" }, () => this._same(record) && record.state.isStreaming === false && record.goal?.goal == null && knownRole && record.conversationListSeq > beforeStop && !record.conversations.some((item) => item.id === record.previousExecutorId));
			record.stopConfirmed = true;
			return { revision: args.revision, status: "stopped", stopped: true, scope: "native-executor-session", externalSideEffectsRolledBack: false };
		} catch {}
		return { revision: args.revision, status: "unknown", stopped: false, gap: "clear_goal/abort requested; no confirmed removal of the exact native executor session" };
	}

	/** Request a pause; confirm only the exact previously observed native role's removal. */
	pause(args) { return this._stop(args, "pause"); }
	/** Stop the old revision, without replacing or silently restarting its objective. */
	revise(args) { return this._stop(args, "revise"); }
	/** Request cancellation, reserving the task for reconciliation until proven stopped. */
	cancel(args) { return this._stop(args, "cancel"); }
	/**
	 * Resume only with in-memory or persisted exact-role cessation evidence and an
	 * unchanged idle reviewer conversation. This sets the original goal again:
	 * it starts a NEW bounded native round, never resumes an OS process.
	 */
	async resume(args) {
		const record = await this._lookup(args);
		const retainedPause = args.stopEvidence?.revision === args.revision && args.stopEvidence?.operation === "pause" && typeof args.stopEvidence.operationId === "string";
		if ((!record.stopConfirmed && !retainedPause) || record.goal?.goal != null || record.state.isStreaming) return { revision: args.revision, status: "unknown", running: false, restartedRound: false, gap: "Resume requires confirmed cessation and an unchanged idle native conversation" };
		record.stopping = false;
		await this._setGoal(record);
		record.stopConfirmed = false;
		return { revision: args.revision, status: "running", running: true, restartedRound: true };
	}

	/** Close transport only; deliberately does not clear goals or kill workers. */
	dispose() {
		this.#closed = true;
		for (const record of this.#records.values()) {
			record.connected = false;
			for (const wait of [...record.waits]) wait.fail();
			try { record.socket?.close(); } catch {}
		}
	}
}
