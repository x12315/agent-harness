import test from "node:test";
import assert from "node:assert/strict";
import { Coordinator } from "./coordinator.mjs";

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

async function until(predicate) {
	const end = Date.now() + 1500;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("Condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

function fixture(options = {}) {
	let disk = options.saved ? structuredClone(options.saved) : null;
	let rejectWrites = false;
	const writes = [];
	const starts = [];
	const controls = [];
	const publications = [];
	const coordinator = new Coordinator({
		storage: {
			read: async () => disk,
			write: async (state) => {
				options.onWrite?.(state);
				if (rejectWrites) throw new Error("Disk unavailable");
				disk = structuredClone(state);
				writes.push(disk);
			},
		},
		classify: options.classify ?? (async (input) => JSON.parse(input.text)),
		executor: {
			start: async (task) => { starts.push(task); return `session-${task.id}-${task.revision}`; },
			revise: async (args) => { controls.push({ action: "revise", ...args }); return { stopped: true }; },
			pause: async (args) => { controls.push({ action: "pause", ...args }); return { stopped: true }; },
			resume: async (args) => { controls.push({ action: "resume", ...args }); return { running: true }; },
			cancel: async (args) => { controls.push({ action: "cancel", ...args }); return { stopped: true }; },
			...options.executor,
		},
		publish: (event) => publications.push(event),
		checkpointMs: 10_000,
		...options.config,
	});
	return { coordinator, starts, controls, writes, publications, disk: () => disk, fail: () => { rejectWrites = true; } };
}

const send = (coordinator, action, text = action, targetId) => coordinator.submit(JSON.stringify({ action, text, ...(targetId ? { targetId } : {}) }));
const tasks = (coordinator) => coordinator.snapshot().tasks;
const passed = (revision) => ({ revision, status: "passed", nativeReview: "passed" });

test("completed goals can be amended without replacing original text or retaining old completion time", async (t) => {
 const f=fixture();t.after(()=>f.coordinator.dispose());
 await send(f.coordinator,'task','original scope');await until(()=>tasks(f.coordinator)[0]?.status==='running');
 const id=tasks(f.coordinator)[0].id;await f.coordinator.observe(id,passed(1));
 assert.equal(tasks(f.coordinator)[0].status,'verified');assert.ok(Number.isFinite(tasks(f.coordinator)[0].finishedAt));
 await send(f.coordinator,'revise','additional constraint',id);await until(()=>f.starts.length===2);
 assert.equal(tasks(f.coordinator)[0].objective,'original scope');assert.equal(tasks(f.coordinator)[0].revision,2);assert.equal(tasks(f.coordinator)[0].finishedAt,undefined);
});

test("conversation receives actual completion output only after required coverage passes", async (t) => {
 const f=fixture({config:{requireCoverage:true}});t.after(()=>f.coordinator.dispose());await send(f.coordinator,'task','two phases');await until(()=>tasks(f.coordinator)[0]?.status==='running');
 const id=tasks(f.coordinator)[0].id;await f.coordinator.observe(id,{...passed(1),nativeEvidence:{executorReport:'Only phase one done'},coverage:{status:'missing',missing:[{requirement:'two phases',evidenceGap:'phase two missing'}]}});
 assert.equal(f.coordinator.snapshot().inputs[0].answer,undefined);await until(()=>f.starts.length===2);
 await f.coordinator.observe(id,{...passed(2),nativeEvidence:{executorReport:'Both files written and read'},coverage:{status:'passed',checked:[{requirement:'two phases',evidence:'two actual files'}]}});
 assert.match(f.coordinator.snapshot().inputs[0].answer,/Both files written and read/);assert.equal(tasks(f.coordinator)[0].status,'verified');
});

test("normal shutdown retains paused work but does not silently pause all future intake after restart", async (t) => {
 const f=fixture();await send(f.coordinator,'task','existing work');await until(()=>tasks(f.coordinator)[0]?.status==='running');await f.coordinator.stop();
 assert.equal(f.disk().paused,true);assert.equal(f.disk().dispatchPausedBeforeShutdown,false);
 const restored=fixture({saved:f.disk(),config:{maxConcurrent:1}});t.after(()=>restored.coordinator.dispose());await restored.coordinator.restore();
 assert.equal(restored.coordinator.snapshot().paused,false);assert.equal(tasks(restored.coordinator)[0].status,'paused');
 await send(restored.coordinator,'task','new explicit request');await until(()=>restored.starts.length===1);assert.equal(restored.starts[0].objective,'new explicit request');
});

test("targeted resume after pause-all leaves unrelated tasks paused", async (t) => {
 const f=fixture();t.after(()=>f.coordinator.dispose());await send(f.coordinator,'task','first');await send(f.coordinator,'task','second');await until(()=>f.starts.length===2);
 await send(f.coordinator,'pause');await until(()=>tasks(f.coordinator).every(task=>task.status==='paused'));
 await send(f.coordinator,'resume','continue first',tasks(f.coordinator)[0].id);await until(()=>tasks(f.coordinator)[0].status==='running');assert.equal(tasks(f.coordinator)[1].status,'paused');
});

test("receipt follows durable raw input and precedes classification", async (t) => {
	const gate = deferred();
	let classified = false;
	const f = fixture({ classify: async () => { classified = true; return gate.promise; } });
	t.after(() => f.coordinator.dispose());
	const receipt = await f.coordinator.submit("  exact raw input  ");
	assert.equal(classified, false);
	assert.equal(f.disk().inputs[0].text, "  exact raw input  ");
	assert.equal(f.disk().inputs[0].id, receipt.id);
	assert.equal(f.starts.length, 0);
	await until(() => classified);
	gate.resolve({ action: "question", text: "answer", answer: "42" });
	await until(() => f.coordinator.snapshot().inputs[0].answer === "42");
});

test("held worker does not block questions or another task", async (t) => {
	const worker = deferred();
	const starts = [];
	const f = fixture({ executor: { start: async (args) => { starts.push(args); return starts.length === 1 ? worker.promise : "second-handle"; } } });
	t.after(() => f.coordinator.dispose());
	await send(f.coordinator, "task", "first objective");
	await until(() => starts.length === 1);
	await send(f.coordinator, "question", "what is happening?");
	await send(f.coordinator, "task", "second objective");
	await until(() => starts.length === 2 && f.coordinator.snapshot().inputs.some((input) => input.status === "question"));
	assert.equal(tasks(f.coordinator)[0].status, "starting");
	worker.resolve("first-handle");
	await until(() => tasks(f.coordinator)[0].status === "running");
});

test("revision waits for cessation, preserves objective, and ignores old callbacks", async (t) => {
	const stopped = deferred();
	let revisions = 0;
	const f = fixture({ executor: { revise: async () => { revisions++; return stopped.promise; } } });
	t.after(() => f.coordinator.dispose());
	await send(f.coordinator, "task", "original objective");
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	const id = tasks(f.coordinator)[0].id;
	await send(f.coordinator, "revise", "also preserve the existing files", id);
	await until(() => revisions === 1);
	assert.equal(f.starts.length, 1);
	assert.equal(tasks(f.coordinator)[0].revision, 2);
	stopped.resolve({ stopped: true });
	await until(() => f.starts.length === 2 && tasks(f.coordinator)[0].status === "running");
	assert.equal(f.starts[1].objective, "original objective");
	assert.equal(f.starts[1].amendments[0].text, "also preserve the existing files");
	await f.coordinator.observe(id, passed(1));
	assert.equal(tasks(f.coordinator)[0].status, "running");
	await f.coordinator.observe(id, passed(2));
	assert.equal(tasks(f.coordinator)[0].status, "verified");
});

test("native pass without review evidence remains unverified; failed and unknown retain gaps", async (t) => {
	const f = fixture({ config: { maxConcurrent: 3 } });
	t.after(() => f.coordinator.dispose());
	for (let i = 0; i < 3; i++) await send(f.coordinator, "task", `objective ${i}`);
	await until(() => tasks(f.coordinator).length === 3 && tasks(f.coordinator).every((task) => task.status === "running"));
	const [a, b, c] = tasks(f.coordinator);
	await f.coordinator.observe(a.id, { revision: 1, status: "passed" });
	await f.coordinator.observe(b.id, { revision: 1, status: "failed", gap: "Native review rejected" });
	await f.coordinator.observe(c.id, { revision: 1, status: "unknown" });
	assert.deepEqual(tasks(f.coordinator).map((task) => task.status), ["needs_reconciliation", "failed", "needs_reconciliation"]);
	assert.ok(tasks(f.coordinator).every((task) => task.gap));
});

test("wall-clock timer publishes checkpoints and pauses at budget without another LLM turn", async (t) => {
	let classifications = 0;
	const f = fixture({
		config: { checkpointMs: 8, maxRuntimeMs: 35 },
		classify: async (input) => { classifications++; return JSON.parse(input.text); },
	});
	t.after(() => f.coordinator.dispose());
	await send(f.coordinator, "task", "long native task");
	await until(() => tasks(f.coordinator)[0]?.checkpoint != null);
	await until(() => tasks(f.coordinator)[0]?.status === "paused");
	assert.equal(classifications, 1);
	assert.match(tasks(f.coordinator)[0].gap, /budget/);
	assert.equal(f.starts.length, 1);
	assert.equal(f.controls[0].action, "pause");
	assert.ok(f.publications.some((event) => event.state.tasks[0]?.checkpoint));
});

test("pause is persisted before native control; resume uses same native handle", async (t) => {
	const f = fixture({ executor: { pause: async (args) => {
		assert.equal(f.disk().paused, true);
		assert.equal(f.disk().tasks[0].desired, "pause");
		return { stopped: true };
	} } });
	t.after(() => f.coordinator.dispose());
	await send(f.coordinator, "task", "original");
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	await send(f.coordinator, "pause");
	await until(() => tasks(f.coordinator)[0].status === "paused");
	await send(f.coordinator, "task", "queued while paused");
	await until(() => tasks(f.coordinator).length === 2);
	assert.equal(f.starts.length, 1);
	await send(f.coordinator, "resume");
	await until(() => tasks(f.coordinator).every((task) => task.status === "running"));
	assert.equal(f.starts.length, 2);
	assert.equal(f.controls.filter((control) => control.action === "resume").length, 1);
});

test("restore reconciles uncertain starts and refreshes known handles without redispatch", async (t) => {
	const saved = { schemaVersion: 1, nextId: 8, paused: false, inputs: [], tasks: [
		{ id: "task-1", objective: "unknown dispatch", revision: 1, runRevision: 1, amendments: [], desired: "run", status: "starting", handle: null },
		{ id: "task-2", objective: "known native run", revision: 1, runRevision: 1, amendments: [], desired: "run", status: "running", handle: "native-2" },
	] };
	let polls = 0;
	const f = fixture({ saved, executor: { status: async () => { polls++; return { revision: 1, status: "running" }; } } });
	t.after(() => f.coordinator.dispose());
	await f.coordinator.restore();
	await until(() => polls === 1 && tasks(f.coordinator)[1].status === "running");
	await f.coordinator.tick();
	assert.equal(tasks(f.coordinator)[0].status, "needs_reconciliation");
	assert.equal(f.starts.length, 0);
});

test("pending raw input survives restore and is classified once", async (t) => {
	const f = fixture({ saved: { schemaVersion: 1, nextId: 2, paused: false, inputs: [{ id: "input-1", text: JSON.stringify({ action: "question", text: "restored answer" }), status: "pending", acceptedAt: 1 }], tasks: [] } });
	t.after(() => f.coordinator.dispose());
	await f.coordinator.restore();
	await until(() => f.coordinator.snapshot().inputs[0].answer === "restored answer");
	assert.equal(f.starts.length, 0);
});

test("save failure rejects ACK and prevents classification/execution", async () => {
	let classified = 0;
	const f = fixture({ classify: async () => { classified++; return { action: "task", text: "unsafe" }; } });
	await f.coordinator.restore();
	f.fail();
	await assert.rejects(f.coordinator.submit("raw input"), /Disk unavailable/);
	assert.equal(classified, 0);
	assert.equal(f.starts.length, 0);
	assert.equal(f.coordinator.snapshot().inputs.length, 0);
	await assert.rejects(f.coordinator.dispose(), /Disk unavailable/);
});

test("failure saving classification prevents native start", async () => {
	const gate = deferred();
	const f = fixture({ classify: () => gate.promise });
	await send(f.coordinator, "task");
	f.fail();
	gate.resolve({ action: "task", text: "cannot dispatch" });
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(f.starts.length, 0);
	assert.equal(f.coordinator.snapshot().inputs[0].status, "pending");
	await assert.rejects(f.coordinator.dispose(), /Disk unavailable/);
});

test("default concurrency is two and a verified native completion releases exactly one slot", async (t) => {
	const f = fixture();
	t.after(() => f.coordinator.dispose());
	for (let i = 0; i < 4; i++) await send(f.coordinator, "task", `objective ${i}`);
	await until(() => tasks(f.coordinator).length === 4 && f.starts.length === 2);
	assert.equal(tasks(f.coordinator).filter((task) => task.status === "queued").length, 2);
	await f.coordinator.observe(tasks(f.coordinator)[0].id, passed(1));
	await until(() => f.starts.length === 3);
	assert.equal(tasks(f.coordinator).filter((task) => task.status === "running").length, 2);
});

test("uncertain stop is not retried and does not permit revised execution", async (t) => {
	let attempts = 0;
	const f = fixture({ executor: { revise: async () => { attempts++; return {}; } } });
	t.after(() => f.coordinator.dispose());
	await send(f.coordinator, "task", "original");
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	await send(f.coordinator, "revise", "new constraint", tasks(f.coordinator)[0].id);
	await until(() => tasks(f.coordinator)[0].status === "needs_reconciliation");
	await f.coordinator.tick();
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(attempts, 1);
	assert.equal(f.starts.length, 1);
});

test("untrusted classifier cannot add executable configuration", async (t) => {
	const f = fixture({ classify: async () => ({ action: "task", text: "work", cwd: "/", shell: "something", authorized: true }) });
	t.after(() => f.coordinator.dispose());
	await f.coordinator.submit("work");
	await until(() => f.starts.length === 1);
	const stored = f.disk().tasks[0];
	assert.equal(stored.objective, "work");
	assert.deepEqual(Object.keys(stored).filter((key) => ["cwd", "shell", "authorized"].includes(key)), []);
});

test("stop and dispose are idempotent and never manufacture success", async () => {
	const f = fixture();
	await send(f.coordinator, "task", "work");
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	const first = f.coordinator.stop();
	assert.equal(first, f.coordinator.dispose());
	await first;
	await until(() => tasks(f.coordinator)[0].status === "paused");
	assert.equal(f.coordinator.snapshot().paused, true);
	await assert.rejects(f.coordinator.submit("late"), /stopped/);
});

test("dispatch must itself be durable before calling native start", async () => {
	const f = fixture({ onWrite: (state) => {
		if (state.tasks.some((task) => task.status === "starting")) throw new Error("Cannot reserve execution");
	} });
	await send(f.coordinator, "task", "must not start");
	await until(() => tasks(f.coordinator).length === 1);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(f.starts.length, 0);
	assert.equal(tasks(f.coordinator)[0].status, "queued");
	await assert.rejects(f.coordinator.dispose(), /Cannot reserve/);
});

test("cancel waits for native cessation and cannot become success", async (t) => {
	const stopped = deferred();
	let cancelling = false;
	const f = fixture({ executor: { cancel: async () => { cancelling = true; return stopped.promise; } } });
	t.after(() => f.coordinator.dispose());
	await send(f.coordinator, "task", "work");
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	const id = tasks(f.coordinator)[0].id;
	await send(f.coordinator, "cancel", "stop work", id);
	await until(() => cancelling);
	assert.equal(tasks(f.coordinator)[0].status, "stopping");
	stopped.resolve({ stopped: true });
	await until(() => tasks(f.coordinator)[0].status === "cancelled");
	await f.coordinator.observe(id, passed(1));
	assert.equal(tasks(f.coordinator)[0].status, "cancelled");
});

test("ambiguous revisions ask for a target without changing objectives", async (t) => {
	const f = fixture();
	t.after(() => f.coordinator.dispose());
	await send(f.coordinator, "task", "one");
	await send(f.coordinator, "task", "two");
	await until(() => tasks(f.coordinator).length === 2);
	const receipt = await send(f.coordinator, "revise", "change it");
	await until(() => f.coordinator.snapshot().inputs.find((input) => input.id === receipt.id).status === "clarify");
	assert.deepEqual(tasks(f.coordinator).map((task) => task.revision), [1, 1]);
	assert.deepEqual(tasks(f.coordinator).map((task) => task.objective), ["one", "two"]);
});

test("old callback between stop confirmation and next reservation cannot overwrite the queue", async (t) => {
	let now = 100;
	let sequence = 0;
	const scheduled = new Map();
	const clock = {
		now: () => now,
		setTimeout: (fn) => { const id = ++sequence; scheduled.set(id, fn); return id; },
		clearTimeout: (id) => scheduled.delete(id),
	};
	const stopped = deferred();
	const f = fixture({ config: { clock }, executor: { revise: () => stopped.promise } });
	t.after(() => f.coordinator.dispose());
	const wake = async () => {
		const entries = [...scheduled.entries()];
		for (const [id, fn] of entries) { scheduled.delete(id); fn(); }
		await new Promise((resolve) => setTimeout(resolve, 2));
	};
	await send(f.coordinator, "task", "original");
	await wake();
	await wake();
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	const id = tasks(f.coordinator)[0].id;
	await send(f.coordinator, "revise", "amendment", id);
	await wake();
	await wake();
	stopped.resolve({ stopped: true });
	await until(() => tasks(f.coordinator)[0].status === "queued");
	await f.coordinator.observe(id, { revision: 1, status: "running" });
	assert.equal(tasks(f.coordinator)[0].status, "queued");
	now++;
	await wake();
	await until(() => f.starts.length === 2);
	assert.equal(f.starts[1].revision, 2);
});


test("retrying the same accepted client request does not create duplicate work", async (t) => {
 const f = fixture(); t.after(()=>f.coordinator.dispose());
 const text=JSON.stringify({action:'task',text:'one work item'});
 const a=await f.coordinator.submit(text,{requestId:'client-request-1'});
 const b=await f.coordinator.submit(text,{requestId:'client-request-1'});
 assert.deepEqual(a,b);
 await until(()=>f.starts.length===1);
 assert.equal(f.coordinator.snapshot().inputs.length,1);
 await assert.rejects(f.coordinator.submit('different',{requestId:'client-request-1'}),/already belongs/);
 assert.equal(tasks(f.coordinator)[0].sourceText,text);
});

test("resume before old pause confirmation reuses the stopped handle", async (t) => {
	const gate = deferred();
	let args;
	const f = fixture({ executor: { pause: (value) => { args = value; return gate.promise; } } });
	t.after(() => f.coordinator.dispose());
	await send(f.coordinator, "task", "work");
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	const handle = tasks(f.coordinator)[0].handle;
	await send(f.coordinator, "pause");
	await until(() => args);
	assert.equal(args.controlId, f.disk().tasks[0].control.id);
	await send(f.coordinator, "resume");
	await until(() => tasks(f.coordinator)[0].desired === "run");
	gate.resolve({ stopped: true });
	await until(() => f.controls.some((item) => item.action === "resume"));
	await until(() => tasks(f.coordinator)[0].status === "running");
	assert.equal(f.starts.length, 1);
	assert.equal(tasks(f.coordinator)[0].handle, handle);
});

for (const reviseDuringPause of [false, true]) test(`revision ${reviseDuringPause ? "during" : "after"} pause discards the old handle`, async (t) => {
	const gate = deferred();
	let pausing = false;
	const f = fixture({ executor: { pause: () => { pausing = true; return gate.promise; } } });
	t.after(() => f.coordinator.dispose());
	await send(f.coordinator, "task", "original");
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	const id = tasks(f.coordinator)[0].id;
	await send(f.coordinator, "pause");
	await until(() => pausing);
	if (!reviseDuringPause) {
		gate.resolve({ stopped: true });
		await until(() => tasks(f.coordinator)[0].status === "paused");
	}
	await send(f.coordinator, "revise", "new requirement", id);
	await until(() => tasks(f.coordinator)[0].revision === 2);
	gate.resolve({ stopped: true });
	await until(() => tasks(f.coordinator)[0].status === "paused" && tasks(f.coordinator)[0].handle == null);
	assert.equal(f.disk().tasks[0].stopEvidence.revision, 1);
	assert.equal(f.starts.length, 1);
	await send(f.coordinator, "resume");
	await until(() => tasks(f.coordinator)[0].status === "running");
	assert.deepEqual(f.starts.map((item) => item.revision), [1, 2]);
	assert.equal(f.controls.filter((item) => item.action === "resume").length, 0);
});

for (const passAfterStop of [false, true]) test(`native review pass ${passAfterStop ? "after" : "before"} pause confirmation survives reload`, async () => {
	const gate = deferred();
	let pausing = false;
	const f = fixture({ executor: { pause: () => { pausing = true; return gate.promise; } } });
	await send(f.coordinator, "task", "side effect only once");
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	const id = tasks(f.coordinator)[0].id;
	await send(f.coordinator, "pause");
	await until(() => pausing);
	if (passAfterStop) {
		gate.resolve({ stopped: true });
		await until(() => tasks(f.coordinator)[0].status === "paused");
	}
	await f.coordinator.observe(id, passed(1));
	assert.equal(f.disk().tasks[0].status, "verified");
	gate.resolve({ stopped: true });
	await f.coordinator.dispose();
	const restored = fixture({ saved: f.disk() });
	await restored.coordinator.restore();
	await send(restored.coordinator, "resume");
	await until(() => restored.coordinator.snapshot().inputs.at(-1).status === "classified");
	assert.equal(tasks(restored.coordinator)[0].status, "verified");
	assert.equal(restored.starts.length, 0);
	await restored.coordinator.dispose();
});

for (const action of ["pause", "cancel"]) test(`dispose drains an already running ${action} before transport teardown`, async () => {
	const gate = deferred();
	let entered = false;
	let transportClosed = false;
	const f = fixture({ executor: { [action]: async () => {
		entered = true;
		await gate.promise;
		assert.equal(transportClosed, false);
		return { stopped: true };
	} } });
	await send(f.coordinator, "task", "work");
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	await send(f.coordinator, action, action, tasks(f.coordinator)[0].id);
	await until(() => entered);
	const closing = f.coordinator.dispose().then((result) => { transportClosed = true; return result; });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(transportClosed, false);
	gate.resolve();
	assert.deepEqual(await closing, { status: "idle", pending: [] });
	assert.equal(tasks(f.coordinator)[0].status, action === "cancel" ? "cancelled" : "paused");
});

test("stale control IDs cannot stop a resumed run of the same revision", async (t) => {
	const f = fixture();
	t.after(() => f.coordinator.dispose());
	await send(f.coordinator, "task", "work");
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	await send(f.coordinator, "pause");
	await until(() => tasks(f.coordinator)[0].status === "paused");
	const stopped = tasks(f.coordinator)[0];
	assert.equal(stopped.stopEvidence.operationId, stopped.control.id);
	assert.equal(stopped.stopEvidence.revision, 1);
	await send(f.coordinator, "resume");
	await until(() => tasks(f.coordinator)[0].status === "running");
	await f.coordinator.observe(stopped.id, { revision: 1, controlId: stopped.control.id, stopped: true });
	assert.equal(tasks(f.coordinator)[0].status, "running");
	assert.equal(f.starts.length, 1);
});

test("reload after a paused revision dispatches only the current revision", async () => {
	const f = fixture();
	await send(f.coordinator, "task", "original");
	await until(() => tasks(f.coordinator)[0]?.status === "running");
	await send(f.coordinator, "pause");
	await until(() => tasks(f.coordinator)[0].status === "paused");
	await send(f.coordinator, "revise", "new requirement", tasks(f.coordinator)[0].id);
	await until(() => tasks(f.coordinator)[0].revision === 2);
	await f.coordinator.dispose();
	const restored = fixture({ saved: f.disk() });
	await restored.coordinator.restore();
	await send(restored.coordinator, "resume");
	await until(() => tasks(restored.coordinator)[0].status === "running");
	assert.deepEqual(restored.starts.map((item) => item.revision), [2]);
	assert.equal(restored.controls.length, 0);
	await restored.coordinator.dispose();
});

test("dispose waits for an in-flight start and its subsequent pause", async () => {
	const start = deferred();
	const pause = deferred();
	let entered = false;
	let pausing = false;
	let closed = false;
	const f = fixture({ executor: {
		start: () => { entered = true; return start.promise; },
		pause: () => { pausing = true; return pause.promise; },
	} });
	await send(f.coordinator, "task", "work");
	await until(() => entered);
	const stopping = f.coordinator.dispose().then((result) => { closed = true; return result; });
	start.resolve("late-handle");
	await until(() => pausing);
	assert.equal(closed, false);
	pause.resolve({ stopped: true });
	assert.equal((await stopping).status, "idle");
	assert.equal(tasks(f.coordinator)[0].status, "paused");
});

for (const operation of ["start", "pause"]) test(`uncontrolled ${operation} has a bounded unknown shutdown`, async () => {
	let entered = false;
	const f = fixture({ config: { controlDrainMs: 20 }, executor: {
		[operation]: () => { entered = true; return new Promise(() => {}); },
	} });
	await send(f.coordinator, "task", "work");
	await until(() => operation === "start" ? entered : tasks(f.coordinator)[0]?.status === "running");
	const result = await f.coordinator.dispose();
	assert.equal(result.status, "unknown");
	assert.deepEqual(result.pending, [tasks(f.coordinator)[0].id]);
	assert.equal(f.disk().paused, true);
	assert.notEqual(tasks(f.coordinator)[0].status, "verified");
});

test("shutdown fences a resume classification arriving while a pause is draining", async () => {
 const classification = deferred(), control = deferred(); let entered=false;
 const f=fixture({classify:async(input)=>{const value=JSON.parse(input.text);if(value.action==='resume'){entered=true;return classification.promise;}return value;},executor:{pause:()=>control.promise},config:{controlDrainMs:300}});
 await send(f.coordinator,'task','work'); await until(()=>tasks(f.coordinator)[0]?.status==='running');
 await send(f.coordinator,'resume'); await until(()=>entered);
 const stopping=f.coordinator.stop();
 await until(()=>f.coordinator.snapshot().paused===true);
 classification.resolve({action:'resume',text:'resume'});
 await new Promise(done=>setTimeout(done,5));
 assert.equal(f.coordinator.snapshot().paused,true);
 assert.equal(f.coordinator.snapshot().inputs.at(-1).status,'pending');
 control.resolve({stopped:true}); await stopping;
 assert.equal(tasks(f.coordinator)[0].status,'paused');
});

test("restored pause proof is delivered to the native resume operation before being cleared", async (t) => {
 const f=fixture(); await send(f.coordinator,'task','work');
 await until(()=>tasks(f.coordinator)[0]?.status==='running');
 await f.coordinator.stop();
 const saved=f.disk(); let received;
 const restored=fixture({saved,executor:{resume:async(args)=>{received=args.stopEvidence;return {running:true};}}});
 t.after(()=>restored.coordinator.dispose());
 await send(restored.coordinator,'resume');
 await until(()=>tasks(restored.coordinator)[0]?.status==='running');
 assert.equal(received.operation,'pause');
 assert.equal(received.revision,1);
 assert.equal(typeof received.operationId,'string');
 assert.equal(tasks(restored.coordinator)[0].stopEvidence,null);
});

test("whole-objective gaps automatically requeue existing scope without a user reminder", async (t) => {
 const f=fixture({config:{requireCoverage:true,maxCoverageRepairs:1}});t.after(()=>f.coordinator.dispose());
 await send(f.coordinator,'task','original with regression validation');
 await until(()=>tasks(f.coordinator)[0]?.status==='running'); const id=tasks(f.coordinator)[0].id;
 await f.coordinator.observe(id,passed(1));
 assert.notEqual(tasks(f.coordinator)[0].status,'verified');
 await f.coordinator.observe(id,{...passed(1),coverage:{status:'missing',missing:[{requirement:'regression validation',evidenceGap:'No result'}]}});
 await until(()=>f.starts.length===2 && tasks(f.coordinator)[0].status==='running');
 assert.equal(f.starts[1].objective,'original with regression validation');
 assert.match(f.starts[1].amendments[0].text,/regression validation/);
 await f.coordinator.observe(id,{...passed(2),coverage:{status:'passed',checked:[{requirement:'regression validation',evidence:'test result'}]}});
 assert.equal(tasks(f.coordinator)[0].status,'verified');
});

test("coverage uncertainty or exhausted repair budget pauses instead of reporting completion", async (t) => {
 for (const coverage of [{status:'unknown',gap:'provider unavailable'},{status:'missing',missing:[{requirement:'work',evidenceGap:'missing'}]}]) {
  const f=fixture({config:{requireCoverage:true,maxCoverageRepairs:0}});t.after(()=>f.coordinator.dispose());
  await send(f.coordinator,'task','work');await until(()=>tasks(f.coordinator)[0]?.status==='running');
  await f.coordinator.observe(tasks(f.coordinator)[0].id,{...passed(1),coverage});
  assert.equal(tasks(f.coordinator)[0].status,'paused');assert.equal(f.starts.length,1);
 }
});

test("coverage-only resume after reload never repeats native execution", async (t) => {
 const f=fixture({config:{requireCoverage:true}});
 await send(f.coordinator,'task','work');await until(()=>tasks(f.coordinator)[0]?.status==='running');
 await f.coordinator.observe(tasks(f.coordinator)[0].id,{...passed(1),coverage:{status:'unknown',gap:'coverage unavailable'},nativeEvidence:{feedback:'native passed'}});
 assert.equal(tasks(f.coordinator)[0].status,'paused');await f.coordinator.stop();
 const saved=f.disk(); saved.tasks[0].handle=null;
 let statusCalls=0;
 const restored=fixture({saved,config:{requireCoverage:true},executor:{status:async()=>{statusCalls++;return {...passed(1),coverage:{status:'passed',checked:[]}};}}});
 t.after(()=>restored.coordinator.dispose());
 await send(restored.coordinator,'resume');
 await until(()=>tasks(restored.coordinator)[0]?.status==='needs_reconciliation');
 await restored.coordinator.tick();await until(()=>tasks(restored.coordinator)[0].status==='verified');
 assert.equal(restored.starts.length,0);assert.equal(statusCalls,1);
 assert.equal(tasks(restored.coordinator)[0].nativeCompletion.nativeReview,'passed');
});

test("native progress before start returns cannot discard the durable control handle", async (t) => {
 let coordinator;
 const f=fixture({executor:{start:async(task)=>{await coordinator.observe(task.id,{revision:task.revision,status:'running'});return {clientId:'native-client',conversationId:'c2'};}}});
 coordinator=f.coordinator;t.after(()=>coordinator.dispose());
 await send(coordinator,'task','work');await until(()=>tasks(coordinator)[0]?.status==='running');
 assert.equal(tasks(coordinator)[0].handle.conversationId,'c2');
 assert.equal(f.disk().tasks[0].handle.clientId,'native-client');
});

test("unchanged native telemetry does not enqueue durable writes ahead of user input", async (t) => {
 const f=fixture();t.after(()=>f.coordinator.dispose());
 await send(f.coordinator,'task','work');await until(()=>tasks(f.coordinator)[0]?.status==='running');
 const before=f.writes.length;
 await Promise.all(Array.from({length:100},()=>f.coordinator.observe(tasks(f.coordinator)[0].id,{revision:1,status:'running'})));
 assert.equal(f.writes.length,before);
 await send(f.coordinator,'question','progress?');
 await until(()=>f.coordinator.snapshot().inputs.at(-1).status==='question');
});

test("uncertain start retains its safe native handle for later reconciliation", async (t) => {
 const f=fixture({executor:{start:async()=>{const e=Error('uncertain');e.handle={clientId:'safe-id',conversationId:'native'};throw e;}}});
 t.after(()=>f.coordinator.dispose());
 await send(f.coordinator,'task','work');
 await until(()=>tasks(f.coordinator)[0]?.status==='needs_reconciliation');
 assert.equal(tasks(f.coordinator)[0].handle.conversationId,'native');
});

test("direct control rejects stale revisions without changing durable state", async (t) => {
 const f=fixture();t.after(()=>f.coordinator.dispose());
 await send(f.coordinator,'task','stale control');await until(()=>tasks(f.coordinator)[0]?.status==='running');
 const task=tasks(f.coordinator)[0];
 await assert.rejects(f.coordinator.applyControl({action:'pause',taskId:task.id,expectedRevision:task.revision+1}),/revision-mismatch/);
 await assert.rejects(f.coordinator.applyControl({action:'pause',taskId:task.id,expectedRevision:undefined}),/revision-mismatch/);
 assert.equal(tasks(f.coordinator)[0].status,'running');assert.equal(f.disk().tasks[0].desired,'run');
});

test("direct control rejects terminal tasks and unknown tasks", async (t) => {
 const f=fixture();t.after(()=>f.coordinator.dispose());
 await send(f.coordinator,'task','terminal control');await until(()=>tasks(f.coordinator)[0]?.status==='running');
 const task=tasks(f.coordinator)[0];await f.coordinator.observe(task.id,passed(task.revision));
 await assert.rejects(f.coordinator.applyControl({action:'pause',taskId:task.id,expectedRevision:task.revision}),/terminal-task/);
 await assert.rejects(f.coordinator.applyControl({action:'pause',taskId:'task-missing',expectedRevision:1}),/unknown-task/);
 assert.equal(tasks(f.coordinator)[0].status,'verified');
});

test("direct control rejects actions that are not pause/resume/cancel", async (t) => {
 const f=fixture();t.after(()=>f.coordinator.dispose());
 await send(f.coordinator,'task','unsupported control');await until(()=>tasks(f.coordinator)[0]?.status==='running');
 const task=tasks(f.coordinator)[0];
 for (const action of ['ack','revise','pause-all','']) await assert.rejects(f.coordinator.applyControl({action,taskId:task.id,expectedRevision:task.revision}),/unsupported-action/);
 assert.equal(tasks(f.coordinator)[0].status,'running');
});

test("direct pause resolves only after the state change is durably written", async (t) => {
 let saved=null,blockWrites=false,release;
 const gate=new Promise((done)=>{release=done;});
 // Use a dedicated coordinator so this test can hold the write open.
 const coordinator=new Coordinator({
  storage:{read:async()=>saved,write:async(state)=>{if(blockWrites)await gate;saved=structuredClone(state);}},
  classify:async(input)=>JSON.parse(input.text),
  executor:{start:async(task)=>`handle-${task.id}`,pause:async()=>({stopped:true}),resume:async()=>({running:true}),cancel:async()=>({stopped:true}),revise:async()=>({stopped:true})},
  checkpointMs:10_000,
 });
 t.after(()=>coordinator.dispose());
 await coordinator.submit(JSON.stringify({action:'task',text:'durable pause'}));
 await until(()=>coordinator.snapshot().tasks[0]?.status==='running');
 const task=coordinator.snapshot().tasks[0];blockWrites=true;
 let settled=false;
 const applied=coordinator.applyControl({action:'pause',taskId:task.id,expectedRevision:task.revision}).then((result)=>{settled=true;return result;});
 await new Promise((done)=>setTimeout(done,10));
 assert.equal(settled,false);
 assert.equal(coordinator.snapshot().tasks[0].status,'running');
 release();
 const result=await applied;
 assert.deepEqual(result,{applied:true,status:'stopping',revision:1});
 assert.equal(saved.tasks[0].desired,'pause');assert.equal(saved.tasks[0].status,'stopping');
});

test("direct control never invokes the routing classifier", async (t) => {
 let classifications=0;
 const f=fixture({classify:async(input)=>{classifications++;return JSON.parse(input.text);}});
 t.after(()=>f.coordinator.dispose());
 await send(f.coordinator,'task','classifier stays idle');await until(()=>tasks(f.coordinator)[0]?.status==='running');
 assert.equal(classifications,1);
 const task=tasks(f.coordinator)[0];
 await f.coordinator.applyControl({action:'pause',taskId:task.id,expectedRevision:task.revision});
 await until(()=>tasks(f.coordinator)[0].status==='paused');
 assert.equal(classifications,1);
});
