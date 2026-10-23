import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { localStorage, intentClassifier } from "./index.mjs";
import { Outbox } from "./client/outbox.mjs";

let observerDir, previousObserverDir;
before(async () => {
	observerDir = await mkdtemp(join(tmpdir(), "coordinator-observer-"));
	previousObserverDir = process.env.PI_OBSERVER_DIR;
	process.env.PI_OBSERVER_DIR = observerDir;
});
after(async () => {
	if (previousObserverDir === undefined) delete process.env.PI_OBSERVER_DIR;
	else process.env.PI_OBSERVER_DIR = previousObserverDir;
	await rm(observerDir, { recursive: true, force: true });
});

test("state is private, atomically replaced and reloadable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "coordinator-store-"));
	try {
		const storage = localStorage(dir); assert.equal(await storage.read(), null);
		await storage.write({ schemaVersion: 1, inputs: [{ text: "original" }] });
		assert.equal((await stat(join(dir, "coordination-state.json"))).mode & 0o777, 0o600);
		await storage.write({ schemaVersion: 1, inputs: [{ text: "next" }] });
		assert.deepEqual(await storage.read(), JSON.parse(await readFile(join(dir, "coordination-state.json"), "utf8")));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("classifier passes bounded factual state without task handles or executable authority", async () => {
	let request;
	const classify = intentClassifier({ llm: { complete: async (value) => { request = value; return { ok: true, text: JSON.stringify({ action: "question", text: "进度", answer: "尚未完成" }) }; } } });
	const result = await classify({ text: "到哪里了" }, { inputs: [], tasks: [{ id: "task-1", objective: "work", status: "running", revision: 1, amendments: [], handle: { token: "not-input" } }] });
	assert.equal(result.action, "question"); assert.equal(request.timeoutMs, 90000);
	assert.equal(request.prompt.includes("not-input"), false); assert.ok(request.system.includes("NOT permission"));
});

test("unknown targets and unavailable models never become execution authority", async () => {
	const host = { llm: { complete: async () => ({ ok: true, text: '{"action":"cancel","text":"stop","targetId":"invented"}' }) } };
	await assert.rejects(intentClassifier(host)({ text: "stop" }, { tasks: [], inputs: [] }), /未知任务/);
	host.llm.complete = async () => ({ ok: false });
	await assert.rejects(intentClassifier(host)({ text: "work" }, { tasks: [], inputs: [] }), /已保留/);
});

const wait = async (predicate) => {
	for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((done) => setTimeout(done, 5)); }
	throw Error("test checkpoint exceeded");
};
const fakeHost = (dir, cwd, complete) => {
	const host = { dir, cwd, effects: [], sent: [], handlers: {}, getSettings: () => ({}), llm: { complete },
		broadcast(value) { this.sent.push(value); }, sendTo(id, value) { this.sent.push(value); },
		onMessage(fn) { this.handlers.message = fn; }, onAttach(fn) { this.handlers.attach = fn; }, onCwdChange(fn) { this.handlers.cwd = fn; },
		registerBackgroundTask() {}, effect(label, fn) { this.effects.push(fn); }, log() {}, notify() {},
	};
	return host;
};
const answer = (text) => ({ ok: true, text: JSON.stringify({ action: "question", text, answer: text }) });

test("actual plugin reload fences late old classification writes and preserves accepted requests", async () => {
	const dir = await mkdtemp(join(tmpdir(), "coordinator-plugin-"));
	let release, entered = false;
	const slow = new Promise((done) => { release = done; });
	const a = fakeHost(dir, dir, async () => { entered = true; return slow; });
	const b = fakeHost(dir, dir, async () => answer("new owner"));
	try {
		await plugin.activate(a); a.handlers.attach("client"); const workspace = a.sent.at(-1).workspace;
		a.handlers.message({ type: "coordinator-input", text: "where are we?", requestId: "retained-input", workspace }, "client");
		await wait(() => entered);
		a.effects.forEach((dispose) => dispose());
		await plugin.activate(b);
		await wait(() => b.sent.some((event) => event.state?.inputs[0]?.answer === "new owner"));
		release(answer("retired owner"));
		await new Promise((done) => setTimeout(done, 20));
		b.handlers.message({ type: "coordinator-get" }, "client");
		assert.equal(b.sent.at(-1).state.inputs.length, 1);
		assert.equal(b.sent.at(-1).state.inputs[0].answer, "new owner");
	} finally { release?.(answer("cleanup")); b.effects.forEach((dispose) => dispose()); await new Promise((done) => setTimeout(done, 30)); await rm(dir, { recursive: true, force: true }); }
});

test("workspace state stays isolated and foreign-workspace requests are not admitted", async () => {
	const dir = await mkdtemp(join(tmpdir(), "coordinator-workspaces-"));
	const aDir = join(dir, "a"), bDir = join(dir, "b");
	const { mkdir, realpath } = await import("node:fs/promises");
	await mkdir(aDir); await mkdir(bDir);
	const a = fakeHost(dir, aDir, async () => answer("a"));
	const b = fakeHost(dir, bDir, async () => answer("b"));
	try {
		await plugin.activate(a);
		a.handlers.message({ type: "coordinator-input", text: "question a", requestId: "a-input", workspace: await realpath(aDir) }, "client");
		await wait(() => a.sent.some((event) => event.state?.inputs[0]?.answer === "a"));
		await plugin.activate(b);
		b.handlers.message({ type: "coordinator-get" }, "client"); assert.deepEqual(b.sent.at(-1).state.inputs, []);
		b.handlers.message({ type: "coordinator-input", text: "wrong workspace", requestId: "foreign", workspace: aDir }, "client");
		assert.equal(b.sent.at(-1).type, "coordinator-error");
	} finally { b.effects.forEach((dispose) => dispose()); await new Promise((done) => setTimeout(done, 30)); await rm(dir, { recursive: true, force: true }); }
});

test("execution is opt-in and denied tasks stay retained without opening a native socket", async () => {
 const dir=await mkdtemp(join(tmpdir(),'coordinator-opt-in-'));
 const original=globalThis.WebSocket;let connections=0;
 globalThis.WebSocket=class {constructor(){connections++;throw Error('must not connect');}};
 const host=fakeHost(dir,dir,async()=>({ok:true,text:JSON.stringify({action:'task',text:'retained work'})}));
 try {
  await plugin.activate(host);host.handlers.attach('client');const workspace=host.sent.at(-1).workspace;
  host.handlers.message({type:'coordinator-input',text:'retained work',requestId:'disabled-work',workspace},'client');
  await wait(()=>host.sent.some((event)=>event.state?.tasks[0]?.status==='paused'));
  assert.equal(connections,0);assert.ok(host.sent.some((event)=>event.state?.tasks[0]?.sourceText==='retained work'));
 } finally {host.effects.forEach(fn=>fn());await new Promise(done=>setTimeout(done,30));globalThis.WebSocket=original;await rm(dir,{recursive:true,force:true});}
});

test("browser outbox retains stable IDs across reload and only acknowledges durable input", () => {
	const memory = new Map();
	const storage = { getItem: (key) => memory.get(key), setItem: (key, value) => memory.set(key, value) };
	const a = new Outbox(storage); a.add({ requestId: "stable-id", text: "do work", workspace: "/a" });
	const b = new Outbox(storage);
	assert.equal(b.reconcile("/b", []).length, 0);
	assert.equal(b.reconcile("/a", [])[0].requestId, "stable-id");
	assert.equal(b.reconcile("/a", [{ requestId: "stable-id" }]).length, 0);
	assert.equal(new Outbox(storage).items.length, 0);
});
