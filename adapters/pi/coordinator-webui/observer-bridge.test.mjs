import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObserverBridge, MAX_TASK_FACTS, OWNER } from "./observer-bridge.mjs";
import { enqueueControl, listControls, readControl, readTaskFacts } from "./protocol.generated.mjs";

const task = (overrides = {}) => ({
	id: "task-1",
	revision: 1,
	objective: "original objective",
	sourceText: "the exact original request",
	status: "running",
	gap: null,
	progress: { summary: "running tests", tool: "bash" },
	startedAt: 1_000,
	createdAt: 1,
	...overrides,
});

function fakeCoordinator(tasks = [task()], apply = null) {
	const state = { tasks: structuredClone(tasks) };
	const calls = [];
	return {
		calls,
		snapshot: () => structuredClone(state),
		setTasks(next) { state.tasks = structuredClone(next); },
		applyControl: apply ?? (async (args) => {
			calls.push(args);
			const item = state.tasks.find((entry) => entry.id === args.taskId);
			if (!item) throw new Error("unknown-task");
			if (item.revision !== args.expectedRevision) throw new Error("revision-mismatch");
			item.desired = args.action;
			item.status = args.action === "cancel" ? "cancelled" : args.action === "resume" ? "running" : "paused";
			return { applied: true, status: item.status, revision: item.revision };
		}),
	};
}

const control = (commandId, action, revision = 1, owner = OWNER, taskId = "task-1") => ({
	commandId,
	consumerId: "observer-test",
	action,
	target: { subjectId: `${owner}:${taskId}`, taskRef: { owner, taskId, revision } },
	expectedRevision: revision,
});

async function until(predicate) {
	const end = Date.now() + 1_500;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("Condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

test("task facts are written, overwritten and annotated as stale without hiding them", async () => {
	const root = await mkdtemp(join(tmpdir(), "observer-bridge-facts-"));
	try {
		const coordinator = fakeCoordinator();
		const bridge = createObserverBridge({ coordinator, workspace: "/trusted/workspace", root });
		assert.equal(await bridge.publishTaskFacts(), 1);
		let [fact] = await readTaskFacts(root);
		assert.equal(fact.schemaVersion, "observer.taskfact/1");
		assert.equal(fact.owner, OWNER);
		assert.equal(fact.taskId, "task-1");
		assert.equal(fact.revision, 1);
		assert.equal(fact.objective, "original objective");
		assert.equal(fact.sourceText, "the exact original request");
		assert.equal(fact.workspace, "/trusted/workspace");
		assert.deepEqual(fact.progress, { summary: "running tests", tool: "bash" });
		assert.ok(fact.elapsedMs >= 0);

		coordinator.setTasks([task({ revision: 2, status: "paused", gap: "waiting for input", progress: { summary: "paused after tests", tool: null }, finishedAt: 4_000 })]);
		assert.equal(await bridge.publishTaskFacts(), 1);
		[fact] = await readTaskFacts(root);
		assert.equal(fact.revision, 2);
		assert.equal(fact.status, "paused");
		assert.equal(fact.gap, "waiting for input");
		assert.equal(fact.progress.summary, "paused after tests");
		assert.equal(fact.elapsedMs, 3_000);
		assert.equal(fact.attention, true);
		assert.equal(fact.attentionReason, "waiting for input");

		const later = Date.parse(fact.updatedAt) + 180_001;
		[fact] = await readTaskFacts(root, { now: later });
		assert.equal(fact.stale, true);
		assert.equal(fact.status, "paused");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("task facts are bounded to the newest fifty", async () => {
	const root = await mkdtemp(join(tmpdir(), "observer-bridge-bound-"));
	try {
		const bridge = createObserverBridge({ coordinator: fakeCoordinator(), workspace: "/w", root });
		const tasks = Array.from({ length: MAX_TASK_FACTS + 5 }, (_, index) => task({ id: `task-${index + 1}`, createdAt: index + 1 }));
		assert.equal(await bridge.publishTaskFacts({ tasks }), MAX_TASK_FACTS);
		const facts = await readTaskFacts(root);
		assert.equal(facts.length, MAX_TASK_FACTS);
		assert.equal(facts.some((fact) => fact.taskId === "task-1"), false);
		assert.equal(facts.some((fact) => fact.taskId === `task-${MAX_TASK_FACTS + 5}`), true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a queued control is applied exactly once and leaves a done receipt", async () => {
	const root = await mkdtemp(join(tmpdir(), "observer-bridge-apply-"));
	try {
		const coordinator = fakeCoordinator();
		const bridge = createObserverBridge({ coordinator, workspace: "/w", root });
		await enqueueControl(root, control("cmd-once", "pause"));
		await bridge.consumeControls({ allowControl: true });
		assert.equal(coordinator.calls.length, 1);
		assert.ok(Number.isFinite(Date.parse(coordinator.calls[0].issuedAt)));
		assert.deepEqual(coordinator.calls.map(({ issuedAt, ...command }) => command), [{ action: "pause", taskId: "task-1", expectedRevision: 1 }]);
		assert.equal((await readControl(root, "cmd-once")).state, "applied");
		assert.deepEqual(await listControls(root), []);
		await bridge.consumeControls({ allowControl: true });
		assert.equal(coordinator.calls.length, 1);
		assert.equal((await readControl(root, "cmd-once")).state, "applied");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("consumeControls serializes overlapping ticks and never applies twice", async () => {
	const root = await mkdtemp(join(tmpdir(), "observer-bridge-serial-"));
	try {
		let release, entered = false, applyCalls = 0;
		const gate = new Promise((done) => { release = done; });
		const coordinator = fakeCoordinator([task()], async (args) => {
			applyCalls++;
			entered = true;
			await gate;
			coordinator.setTasks([task({ status: "paused", desired: "pause" })]);
			return { applied: true, status: "paused", revision: args.expectedRevision };
		});
		const bridge = createObserverBridge({ coordinator, workspace: "/w", root, confirmTimeoutMs: 5_000 });
		await enqueueControl(root, control("cmd-serial", "pause"));
		const first = bridge.consumeControls({ allowControl: true });
		await until(() => entered);
		const second = bridge.consumeControls({ allowControl: true });
		await new Promise((done) => setTimeout(done, 10));
		assert.equal(applyCalls, 1);
		release();
		await Promise.all([first, second]);
		assert.equal(applyCalls, 1);
		assert.equal((await readControl(root, "cmd-serial")).state, "applied");
		assert.deepEqual(await listControls(root), []);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("stale revisions are rejected before the coordinator is touched", async () => {
	const root = await mkdtemp(join(tmpdir(), "observer-bridge-stale-"));
	try {
		const coordinator = fakeCoordinator([task({ revision: 2 })]);
		const bridge = createObserverBridge({ coordinator, workspace: "/w", root });
		await enqueueControl(root, control("cmd-stale", "pause", 1));
		await bridge.consumeControls({ allowControl: true });
		assert.equal(coordinator.calls.length, 0);
		const receipt = await readControl(root, "cmd-stale");
		assert.equal(receipt.state, "rejected");
		assert.equal(receipt.detail, "revision-mismatch");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("controls owned by another adapter are ignored without a receipt", async () => {
	const root = await mkdtemp(join(tmpdir(), "observer-bridge-foreign-"));
	try {
		const coordinator = fakeCoordinator();
		const bridge = createObserverBridge({ coordinator, workspace: "/w", root });
		await enqueueControl(root, control("cmd-foreign", "pause", 1, "another-coordinator"));
		await bridge.consumeControls({ allowControl: true });
		assert.equal(coordinator.calls.length, 0);
		assert.equal((await readControl(root, "cmd-foreign")).state, "queued");
		assert.equal((await listControls(root)).length, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Observer control is rejected while allowControl is false", async () => {
	const root = await mkdtemp(join(tmpdir(), "observer-bridge-disabled-"));
	try {
		const coordinator = fakeCoordinator();
		const bridge = createObserverBridge({ coordinator, workspace: "/w", root });
		await enqueueControl(root, control("cmd-disabled", "pause"));
		await bridge.consumeControls();
		assert.equal(coordinator.calls.length, 0);
		const receipt = await readControl(root, "cmd-disabled");
		assert.equal(receipt.state, "rejected");
		assert.equal(receipt.detail, "control-disabled");
		assert.deepEqual(await listControls(root), []);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("ack and other non-task actions are rejected, and corrupt requests are skipped", async () => {
	const root = await mkdtemp(join(tmpdir(), "observer-bridge-actions-"));
	try {
		const coordinator = fakeCoordinator();
		const logs = [];
		const bridge = createObserverBridge({ coordinator, workspace: "/w", root, log: (level, message) => logs.push({ level, message }) });
		await enqueueControl(root, control("cmd-ack", "ack"));
		await mkdir(join(root, "control", "pending"), { recursive: true });
		await writeFile(join(root, "control", "pending", "corrupt.json"), "{not json");
		await enqueueControl(root, control("cmd-pause", "pause"));
		await bridge.consumeControls({ allowControl: true });
		assert.equal(coordinator.calls.length, 1);
		assert.ok(Number.isFinite(Date.parse(coordinator.calls[0].issuedAt)));
		assert.deepEqual(coordinator.calls.map(({ issuedAt, ...command }) => command), [{ action: "pause", taskId: "task-1", expectedRevision: 1 }]);
		const ack = await readControl(root, "cmd-ack");
		assert.equal(ack.state, "rejected");
		assert.equal(ack.detail, "unsupported-action");
		assert.equal((await readControl(root, "cmd-pause")).state, "applied");
		assert.deepEqual(logs, []);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("coordinator errors become rejected receipts and never crash the tick", async () => {
	const root = await mkdtemp(join(tmpdir(), "observer-bridge-error-"));
	try {
		const logs = [];
		const coordinator = fakeCoordinator([task()], async () => { throw new Error("durable-write-failed"); });
		const bridge = createObserverBridge({ coordinator, workspace: "/w", root, log: (level, message) => logs.push({ level, message }) });
		await enqueueControl(root, control("cmd-error", "pause"));
		await bridge.consumeControls({ allowControl: true });
		const receipt = await readControl(root, "cmd-error");
		assert.equal(receipt.state, "rejected");
		assert.equal(receipt.detail, "durable-write-failed");
		await bridge.consumeControls({ allowControl: true });
		assert.equal(logs.length, 0);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a stop that has not been confirmed by the owner stays unknown instead of applied", async () => {
	const root = await mkdtemp(join(tmpdir(), "observer-bridge-pending-"));
	try {
		const coordinator = fakeCoordinator([task()], async () => ({ applied: true, status: "stopping", revision: 1 }));
		const bridge = createObserverBridge({ coordinator, workspace: "/w", root, confirmTimeoutMs: 60, confirmPollMs: 10 });
		await enqueueControl(root, control("cmd-pending", "pause"));
		await bridge.consumeControls({ allowControl: true });
		const receipt = await readControl(root, "cmd-pending");
		assert.equal(receipt.state, "unknown");
		assert.match(receipt.detail, /awaiting owner confirmation/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
