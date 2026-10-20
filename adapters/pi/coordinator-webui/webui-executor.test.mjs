import test from "node:test";
import assert from "node:assert/strict";
import { WebUiExecutor } from "./webui-executor.mjs";

// Wire shapes checked against installed pi-web-ui 0.100.0 index.js,
// agent-service.js buildLightState/emitSnapshotNow, GoalService.finishDelegated.
class FakeWebSocket extends EventTarget {
	static sockets = [];
	static silence = null;
	static earlyVerdict = null;
	static removeRoleOnClear = false;
	constructor(url) {
		super();
		this.url = url;
		this.sent = [];
		this.rev = 0;
		FakeWebSocket.sockets.push(this);
		queueMicrotask(() => this.dispatchEvent(new Event("open")));
	}
	emit(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
	snapshot(patch = {}) {
		this.state = { ...this.state, ...patch, rev: ++this.rev };
		this.emit({ type: "snapshot", state: this.state });
	}
	send(raw) {
		const message = JSON.parse(raw);
		this.sent.push(message);
		if (FakeWebSocket.silence === message.type) return;
		switch (message.type) {
			case "hello":
				this.emit({ type: "ready", clientId: message.clientId });
				if (FakeWebSocket.silence === "initial_snapshot") break;
				this.snapshot({ clientId: message.clientId, conversationId: "initial", cwd: "/old", isEphemeral: false, isStreaming: false, messages: [] });
				break;
			case "new_chat": this.snapshot({ conversationId: `dedicated-${FakeWebSocket.sockets.indexOf(this)}`, isEphemeral: true }); break;
			case "persist_conversation": assert.equal(message.id, this.state.conversationId); this.snapshot({ isEphemeral: false }); break;
			case "set_cwd": this.snapshot({ cwd: message.path, conversationId: "project-landing" }); break;
			case "set_model": {
				const [provider, ...parts] = message.modelId.split("/");
				this.snapshot({ model: { provider, id: parts.join("/") } });
				break;
			}
			case "set_goal":
				this.goal = { ...message, conversationId: this.state.conversationId, verdict: "pending", phase: "executing", roles: { executor: { convId: "native-worker", streaming: true } } };
				delete this.goal.type;
				this.emit({ type: "goal_status", status: this.goal });
				this.emit({ type: "conversations", conversations: [{ id: "native-worker", isStreaming: true }] });
				if (FakeWebSocket.earlyVerdict) this.finish(FakeWebSocket.earlyVerdict);
				break;
			case "clear_goal":
				if (FakeWebSocket.removeRoleOnClear) this.emit({ type: "conversations", conversations: [] });
				this.goal = { goal: null, conversationId: null, phase: "idle", verdict: "pending", roles: {} };
				this.emit({ type: "goal_status", status: this.goal });
				break;
			case "abort": this.snapshot({ isStreaming: false }); break;
			case "get_state": this.snapshot(); break;
		}
	}
	finish(verdict, phase = verdict === "blocked" ? "blocked" : "idle") {
		this.goal = { ...this.goal, verdict, phase, roles: {}, ...(verdict === "pass" ? { goal: null, conversationId: null } : {}) };
		this.emit({ type: "goal_status", status: this.goal });
	}
	close() { this.dispatchEvent(new Event("close")); }
}

function fixture(options = {}) {
	FakeWebSocket.sockets = [];
	FakeWebSocket.silence = null;
	FakeWebSocket.earlyVerdict = null;
	FakeWebSocket.removeRoleOnClear = false;
	return new WebUiExecutor({ url: "ws://127.0.0.1:8000/ws", cwd: "/workspace", WebSocketImpl: FakeWebSocket, timeoutMs: 25, ...options });
}
const task = { id: "task-1", objective: "Original objective", revision: 2, amendments: [{ revision: 2, text: "Correction", inputId: "not-needed" }] };
const args = (handle) => ({ id: task.id, revision: task.revision, handle });

test("real message order, isolated clients, persisted conversation, finite native goal and no token in handle", async () => {
	const executor = fixture({ token: "private-token", model: "provider/model" });
	try {
		const handle = await executor.start(task);
		const socket = FakeWebSocket.sockets[0];
		assert.deepEqual(socket.sent.map((m) => m.type), ["hello", "set_cwd", "new_chat", "persist_conversation", "set_model", "set_goal"]);
		assert.equal(socket.sent[2].ephemeral, true);
		assert.deepEqual(socket.sent.at(-1), { type: "set_goal", goal: "Original objective\n\nAdditional requirement, not a replacement objective:\nCorrection", locked: true, maxRounds: 3, execModel: "provider/model" });
		assert.equal(new URL(socket.url).searchParams.get("token"), "private-token");
		assert.ok(!JSON.stringify(handle).includes("private-token"));
		assert.ok(!JSON.stringify(executor).includes("private-token"));
		assert.ok(!("url" in handle));
		assert.deepEqual(await executor.status(args(handle)), { revision: 2, status: "running" });
		assert.deepEqual(await executor.start(task), handle);
		const other = await executor.start({ ...task, id: "task-2" });
		assert.notEqual(other.clientId, handle.clientId);
		assert.notEqual(other.conversationId, handle.conversationId);
	} finally { executor.dispose(); }
});

test("native pass must be terminal; native blocked and exhausted fail", async () => {
	for (const verdict of ["pass", "fail", "blocked"]) {
		const executor = fixture();
		try {
			const handle = await executor.start(task);
			const socket = FakeWebSocket.sockets[0];
			socket.finish(verdict, "reviewing");
			assert.notEqual((await executor.status(args(handle))).status, "passed");
			socket.finish(verdict);
			const evidence = await executor.status(args(handle));
			assert.equal(evidence.status, verdict === "pass" ? "passed" : "failed");
			assert.equal(evidence.nativeReview, verdict === "pass" ? "passed" : undefined);
		} finally { executor.dispose(); }
	}
});

test("early terminal event before handle persistence remains recoverable by status", async () => {
	const executor = fixture();
	FakeWebSocket.earlyVerdict = "pass";
	try {
		const handle = await executor.start(task);
		assert.equal((await executor.status(args(handle))).status, "passed");
	} finally { executor.dispose(); }
});

test("missing native goal acknowledgement times out, exposes safe recovery handle, never repeats dispatch", async () => {
	const executor = fixture({ token: "private-token" });
	FakeWebSocket.silence = "set_goal";
	try {
		let recovery;
		await assert.rejects(executor.start(task), (error) => {
			recovery = error.handle;
			assert.ok(recovery.conversationId);
			assert.ok(!JSON.stringify(error).includes("private-token"));
			return true;
		});
		await assert.rejects(executor.start(task));
		assert.equal(FakeWebSocket.sockets[0].sent.filter((m) => m.type === "set_goal").length, 1);
		assert.equal((await executor.status(args(recovery))).status, "unknown");
	} finally { executor.dispose(); }
});

test("ready alone cannot advance handshake, and no goal starts without persistence or cwd confirmation", async () => {
	for (const silence of ["hello", "initial_snapshot", "persist_conversation", "set_cwd", "set_model"]) {
		const executor = fixture({ model: "provider/model" });
		FakeWebSocket.silence = silence;
		try {
			await assert.rejects(executor.start(task));
			assert.ok(!FakeWebSocket.sockets[0].sent.some((m) => m.type === "set_goal"));
		} finally { executor.dispose(); }
	}
});

test("delta revision gap requests one full resync, never accepts a forged completion", async () => {
	const executor = fixture();
	try {
		const handle = await executor.start(task);
		const socket = FakeWebSocket.sockets[0];
		FakeWebSocket.silence = "get_state";
		const rev = socket.state.rev;
		socket.emit({ type: "snapshot_delta", conversationId: handle.conversationId, baseRev: rev, rev: rev + 1, appended: [{ role: "assistant", content: "passed" }], state: { isStreaming: true } });
		assert.equal((await executor.status(args(handle))).status, "running");
		const gap = { type: "snapshot_delta", conversationId: handle.conversationId, baseRev: 999, rev: 1000, appended: [], state: {} };
		socket.emit(gap);
		socket.emit(gap);
		assert.equal(socket.sent.filter((m) => m.type === "get_state").length, 1);
		assert.equal((await executor.status(args(handle))).status, "unknown");
		socket.snapshot();
		assert.equal((await executor.status(args(handle))).status, "running");
	} finally { executor.dispose(); }
});

test("clear_goal and abort ACKs do not prove worker cessation; revise/pause/cancel stay in reconciliation", async () => {
	for (const operation of ["pause", "cancel", "revise"]) {
		const executor = fixture();
		try {
			const handle = await executor.start(task);
			const socket = FakeWebSocket.sockets[0];
			const result = await executor[operation](args(handle));
			assert.equal(result.stopped, false);
			assert.deepEqual(socket.sent.slice(-3).map((m) => m.type), ["clear_goal", "abort", "get_state"]);
			assert.equal((await executor.status(args(handle))).status, "unknown");
			assert.equal((await executor.resume(args(handle))).running, false);
			assert.equal(socket.sent.filter((m) => m.type === "set_goal").length, 1);
		} finally { executor.dispose(); }
	}
});

test("disconnect remains unknown and dispose closes transport without cancellation", async () => {
	const executor = fixture();
	const handle = await executor.start(task);
	const socket = FakeWebSocket.sockets[0];
	socket.close();
	assert.equal((await executor.status(args(handle))).status, "unknown");
	assert.equal(FakeWebSocket.sockets.flatMap((s) => s.sent).filter((m) => m.type === "set_goal").length, 1);
	executor.dispose();
	assert.ok(!FakeWebSocket.sockets.flatMap((s) => s.sent).some((m) => ["clear_goal", "abort"].includes(m.type)));
});

test("reject remote, query, credentials, alternate loopback spellings, unbounded rounds", () => {
	for (const url of ["ws://example.com", "wss://localhost", "http://localhost", "ws://127.1", "ws://user:password@localhost", "ws://localhost?token=secret", "ws://localhost?", "ws://localhost/#fragment", "ws://[::1]"]) {
		assert.throws(() => fixture({ url }));
	}
	for (const maxRounds of [0, -1, 51, Infinity]) assert.throws(() => fixture({ maxRounds }));
});


test("exact native role removal confirms session cessation and allows a new bounded round", async () => {
 const executor = fixture(); FakeWebSocket.removeRoleOnClear = true;
 try {
  const handle = await executor.start(task);
  const stopped = await executor.pause(args(handle));
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.externalSideEffectsRolledBack, false);
  const resumed = await executor.resume(args(handle));
  assert.equal(resumed.running, true); assert.equal(resumed.restartedRound, true);
  assert.equal(FakeWebSocket.sockets[0].sent.filter((m)=>m.type==='set_goal').length, 2);
 } finally { executor.dispose(); }
});

test("foreign native goals are never cleared by a stale coordinator handle", async () => {
 const executor = fixture();
 try {
  const handle = await executor.start(task);
  const socket = FakeWebSocket.sockets[0];
  socket.goal = {...socket.goal, goal:'A new objective set from the native UI', roles:{executor:{convId:'someone-else'}}};
  socket.emit({type:'goal_status',status:socket.goal});
  const before=socket.sent.length;
  const result=await executor.cancel(args(handle));
  assert.equal(result.stopped,false);
  assert.equal(socket.sent.length,before);
 } finally { executor.dispose(); }
});

test("new revision gets a new native identity and original raw requirements remain binding", async () => {
 const executor = fixture();
 try {
  const old = await executor.start(task);
  const current = await executor.start({...task, revision:3, sourceText:'Original scope with mandatory acceptance criteria'});
  assert.notEqual(old.clientId,current.clientId);
  assert.match(FakeWebSocket.sockets.at(-1).sent.at(-1).goal,/mandatory acceptance criteria/);
 } finally { executor.dispose(); }
});
