import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SCHEMA, safeName, capability, sessionFrame, taskFrame, orderFrames, discrepancies,
	controlRequest, enqueueControl, readControl, listControls, completeControl,
	writeTaskFact, readTaskFacts, appendEvent, readEvents,
} from "./index.mjs";

const now = Date.parse("2026-10-21T08:00:00.000Z");
const snapshot = { id: "42-abc", pid: 42, cwd: "/work", active: true, phase: "working", updatedAt: new Date(now - 1000).toISOString(), lastTool: "bash", lastToolArgs: '{"command":"npm test"}', workElapsedMs: 5000 };
const fact = { schemaVersion: SCHEMA.taskFact, owner: "pi-coordinator", taskId: "task-1", revision: 2, objective: "fix pagination", status: "running", workspace: "/work", updatedAt: new Date(now - 2000).toISOString(), progress: { summary: "正在执行 bash" }, gap: null };

test("session frames reject expired or malformed snapshots instead of showing them as current", () => {
	assert.equal(sessionFrame({ ...snapshot, updatedAt: new Date(now - 120_000).toISOString() }, { now }), null);
	assert.equal(sessionFrame({ ...snapshot, pid: "42" }, { now }), null);
	const frame = sessionFrame(snapshot, { now, summary: { text: "做测试", reportedAt: snapshot.updatedAt } });
	assert.equal(frame.schemaVersion, SCHEMA.frame);
	assert.equal(frame.subjectId, "42-abc");
	assert.equal(frame.kind, "pi-session");
	assert.equal(frame.tool, "bash");
	assert.equal(frame.summary.text, "做测试");
	assert.equal(frame.provenance.authoritative, false);
});

test("task frames are authoritative references, keep stale facts visible and never invent identity", () => {
	assert.equal(taskFrame({ ...fact, owner: "../escape" }, { now }), null);
	assert.equal(taskFrame({ ...fact, revision: 0 }, { now }), null);
	const current = taskFrame(fact, { now });
	assert.equal(current.kind, "webui-task");
	assert.equal(current.subjectId, "pi-coordinator:task-1");
	assert.deepEqual(current.taskRef, { owner: "pi-coordinator", taskId: "task-1", revision: 2 });
	assert.equal(current.active, true);
	assert.equal(current.provenance.authoritative, "pi-coordinator");
	const staleFrame = taskFrame({ ...fact, updatedAt: new Date(now - 400_000).toISOString() }, { now });
	assert.equal(staleFrame?.stale, true);
	assert.equal(orderFrames([taskFrame({ ...fact, status: "verified" }, { now }), current]).at(0), current);
});

test("capability advertises only implemented actions and preserves unknown coverage honestly", () => {
	const value = capability({ sources: ["pi-session", "webui-task"], actions: ["pause", "pause"], coverage: { verified: false, unobservedPids: [7] } });
	assert.deepEqual(value.actions, ["pause"]);
	assert.equal(value.coverage.verified, false);
	assert.deepEqual(value.coverage.unobserved, [7]);
	assert.throws(() => capability({ actions: ["delete-everything"] }));
	assert.deepEqual(capability().actions, [], "no registered owner means no control affordance");
});

test("control requests validate authority, identity and path safety", () => {
	const request = controlRequest({ commandId: "cmd-1", consumerId: "observer-ui", action: "pause", target: { taskRef: { owner: "pi-coordinator", taskId: "task-1", revision: 2 } } });
	assert.equal(request.schemaVersion, SCHEMA.control);
	assert.equal(request.expectedRevision, undefined);
	assert.throws(() => controlRequest({ consumerId: "ui", action: "pause", target: { subjectId: "42-abc" } }), /authoritative task reference/);
	assert.throws(() => controlRequest({ commandId: "../x", consumerId: "ui", action: "ack", target: { subjectId: "42" } }), /Invalid protocol identifier/);
	assert.throws(() => controlRequest({ consumerId: "ui", action: "nuke", target: { subjectId: "42" } }), /Unsupported control action/);
	assert.throws(() => safeName(".."));
});

test("queued control is durable, idempotent and only completes once", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "observer-control-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const request = { commandId: "cmd-1", consumerId: "observer-ui", action: "cancel", expectedRevision: 2, target: { taskRef: { owner: "pi-coordinator", taskId: "task-1", revision: 2 } } };
	const first = await enqueueControl(root, request);
	assert.equal(first.state, "queued");
	const repeat = await enqueueControl(root, request);
	assert.equal(repeat.duplicate, true);
	assert.equal(repeat.state, "queued");
	assert.deepEqual((await listControls(root)).map((entry) => entry.commandId), ["cmd-1"]);
	assert.equal((await completeControl(root, "cmd-1", "applied", "native executor removed")).state, "applied");
	assert.equal((await completeControl(root, "cmd-1", "applied")).state, "applied");
	assert.equal((await readControl(root, "cmd-1")).state, "applied");
	assert.deepEqual(await listControls(root), [], "completed requests leave the queue");
	const journal = await readEvents(root);
	assert.equal(journal.events.at(-1).type, "control.applied");
	assert.equal(journal.events.at(-1).payload.commandId, "cmd-1");
});

test("task facts round-trip atomically, reject escaping identities and omit corrupt files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "observer-facts-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await assert.rejects(writeTaskFact(root, { ...fact, taskId: "../x" }), /owner and taskId/);
	await writeTaskFact(root, fact);
	await mkdir(join(root, "tasks"), { recursive: true });
	await writeFile(join(root, "tasks", "broken.json"), "{not json");
	const facts = await readTaskFacts(root, { now });
	assert.equal(facts.length, 1);
	assert.equal(facts[0].taskId, "task-1");
	assert.equal(facts[0].stale, false);
	assert.equal((await readTaskFacts(root, { now: now + 600_000 }))[0].stale, true);
});

test("journal reads after a cursor, reports truncation and stays bounded", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "observer-journal-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const first = await appendEvent(root, { type: "note", subjectId: "42-abc", payload: { text: "started" } });
	await appendEvent(root, { type: "attention", subjectId: "42-abc", payload: { reason: "blocked" } });
	const after = await readEvents(root, { since: first.eventId });
	assert.equal(after.events.length, 1);
	assert.equal(after.events[0].type, "attention");
	assert.equal(after.truncated, false);
	const unknown = await readEvents(root, { since: "does-not-exist" });
	assert.equal(unknown.truncated, true);
	assert.equal(unknown.events.length, 2);
	await assert.rejects(appendEvent(root, { type: "delete-everything" }), /Unsupported event type/);
});

test("discrepancies surface conflicts for a human or agent without resolving them", () => {
	const frames = [taskFrame(fact, { now }), taskFrame({ ...fact, taskId: "task-2", status: "verified", gap: "missing tests" }, { now })];
	const controls = [{ state: "queued", target: { taskRef: { owner: "pi-coordinator", taskId: "task-2", revision: 2 } } }];
	const found = discrepancies({ frames, controls, coverage: { verified: false }, now });
	assert.deepEqual(found.map((entry) => entry.code).sort(), ["control-after-terminal", "coverage-unverified", "open-gap"]);
	assert.ok(found.every((entry) => typeof entry.detail === "string" && entry.detail.length > 0));
});

test("installed protocol copies are byte-identical to the canonical module", async () => {
	const canonical = await readFile(new URL("./index.mjs", import.meta.url), "utf8");
	for (const copy of ["../observer-webui/protocol.generated.mjs", "../coordinator-webui/protocol.generated.mjs"]) {
		const body = await readFile(new URL(copy, import.meta.url), "utf8");
		assert.ok(body.startsWith("// GENERATED from adapters/pi/observer-protocol/index.mjs"), copy);
		assert.equal(body.slice(body.indexOf("\n") + 1), canonical, `${copy} drifted; run node scripts/sync-observer-protocol.mjs`);
	}
});
