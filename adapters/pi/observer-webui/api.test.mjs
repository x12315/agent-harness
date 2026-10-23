import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const observerRoot = await mkdtemp(join(tmpdir(), "observer-api-"));
process.env.PI_OBSERVER_DIR = observerRoot;

const plugin = (await import("./index.mjs")).default;
const protocol = await import("./protocol.generated.mjs");

after(() => rm(observerRoot, { recursive: true, force: true }));

function createHost({ settings = {} } = {}) {
	const handlers = new Map();
	const routes = new Map();
	const sent = [];
	const host = {
		storage: {
			get: () => undefined,
			set: () => {},
			delete: () => {},
			all: () => ({}),
		},
		fs: {
			requestAccess: async () => true,
			authorizedDirs: () => [observerRoot],
			listPath: async (directory) => {
				const entries = await readdir(directory, { withFileTypes: true });
				return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }));
			},
			readTextPath: async (path) => readFile(path, "utf8"),
		},
		getSettings: () => settings,
		onMessage: (handler) => { handlers.set("message", handler); return () => handlers.delete("message"); },
		onAttach: () => () => {},
		schedule: () => () => {},
		sendTo: (_clientId, payload) => sent.push(payload),
		broadcast: (payload) => sent.push(payload),
		log: () => {},
		route: (method, path, handler) => {
			const key = `${method} ${path}`;
			routes.set(key, handler);
			return () => routes.delete(key);
		},
	};
	return { host, handlers, routes, sent, settings };
}

function createResponse() {
	let body = "";
	let finish;
	const done = new Promise((resolve) => { finish = resolve; });
	const response = {
		statusCode: 200,
		headers: {},
		headersSent: false,
		setHeader: (name, value) => { response.headers[name.toLowerCase()] = value; },
		end: (chunk) => {
			if (chunk !== undefined) body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
			response.headersSent = true;
			finish();
		},
	};
	Object.defineProperty(response, "body", { get: () => body });
	return { response, done };
}

function createRequest({ path = "/", remoteAddress = "127.0.0.1", headers = {}, body } = {}) {
	const request = { url: path, socket: { remoteAddress }, headers };
	if (body !== undefined) {
		const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
		request[Symbol.asyncIterator] = async function* () { yield bytes; };
	}
	return request;
}

async function call(routes, method, path, options = {}) {
	const routePath = path.split("?")[0];
	const handler = routes.get(`${method} ${routePath}`);
	assert.ok(handler, `expected route ${method} ${routePath}`);
	const { response, done } = createResponse();
	handler(createRequest({ path, ...options }), response);
	await done;
	const parsed = response.body ? JSON.parse(response.body) : undefined;
	return { status: response.statusCode, headers: response.headers, body: parsed, raw: response.body };
}

async function activate(options) {
	const fixture = createHost(options);
	const close = await plugin.activate(fixture.host);
	return { ...fixture, close };
}

async function authorize(fixture) {
	const handler = fixture.handlers.get("message");
	assert.ok(handler, "expected a message handler");
	await handler({ type: "observer-authorize", remember: false }, "test-browser");
}

const jsonHeaders = { "content-type": "application/json" };
const pauseTask = (commandId, taskId = "task-api") => ({
	commandId,
	consumerId: "observer-test",
	action: "pause",
	target: { taskRef: { owner: "pi-coordinator", taskId, revision: 1 } },
});

test("capability advertises control only when allowControl is enabled", async () => {
	const disabled = await activate({ settings: { allowControl: false } });
	const off = await call(disabled.routes, "GET", "/capability");
	assert.equal(off.status, 200);
	assert.equal(off.body.schemaVersion, "observer.capability/1");
	assert.deepEqual(off.body.actions, [], "default-disabled control must not advertise affordances");
	assert.deepEqual(off.body.sources, ["pi-session", "webui-task"]);
	disabled.close();

	const enabled = await activate({ settings: { allowControl: true } });
	const on = await call(enabled.routes, "GET", "/capability");
	assert.equal(on.status, 200);
	assert.deepEqual(on.body.actions, ["pause", "resume", "cancel"]);
	assert.deepEqual(on.body.transports, ["http"]);
	enabled.close();
});

test("frames combine fresh Pi sessions with owner task facts and attach summaries", async () => {
	const now = new Date().toISOString();
	await writeFile(join(observerRoot, "sess-frames.snapshot.json"), JSON.stringify({
		id: "sess-frames", pid: 4242, cwd: "/work", active: true, phase: "running test", updatedAt: now,
	}));
	await writeFile(join(observerRoot, "sess-frames.summary.json"), JSON.stringify({
		id: "sess-frames", scope: "session", text: "正在运行接口测试。", reportedAt: now,
	}));
	await protocol.writeTaskFact(observerRoot, {
		owner: "pi-coordinator", taskId: "task-api", revision: 1, objective: "验证 Observer 接口",
		status: "running", workspace: "/work", updatedAt: now, progress: { summary: "正在读取任务事实" },
	});

	const fixture = await activate({ settings: { allowControl: true } });
	const result = await call(fixture.routes, "GET", "/frames");
	assert.equal(result.status, 200);
	assert.equal(result.body.viewSchema, "observer.view/1");
	assert.equal(result.body.controlRoot, observerRoot);
	const session = result.body.frames.find((frame) => frame.kind === "pi-session" && frame.subjectId === "sess-frames");
	assert.equal(session.summary.text, "正在运行接口测试。");
	assert.equal(session.tool, null);
	const task = result.body.frames.find((frame) => frame.kind === "webui-task" && frame.subjectId === "pi-coordinator:task-api");
	assert.deepEqual(task.taskRef, { owner: "pi-coordinator", taskId: "task-api", revision: 1 });
	assert.equal(task.progress, "正在读取任务事实");
	assert.ok(Array.isArray(result.body.discrepancies));

	await authorize(fixture);
	const sent = fixture.sent.at(-1);
	assert.equal(sent.authorized, true);
	assert.equal(sent.viewSchema, "observer.view/1");
	assert.ok(sent.frames.some((frame) => frame.kind === "pi-session" && frame.subjectId === "sess-frames"));
	assert.ok(sent.tasks.some((entry) => entry.taskId === "task-api"));
	fixture.close();
});

test("POST /control is refused while control remains disabled", async () => {
	const fixture = await activate({ settings: { allowControl: false } });
	const result = await call(fixture.routes, "POST", "/control", {
		headers: jsonHeaders,
		body: pauseTask("cmd-disabled"),
	});
	assert.equal(result.status, 403);
	assert.deepEqual(result.body, { error: "control-disabled" });
	assert.equal(await protocol.readControl(observerRoot, "cmd-disabled"), null, "a disabled API must not queue anything");
	fixture.close();
});

test("POST /control rejects a Pi session target instead of inventing an owner", async () => {
	const fixture = await activate({ settings: { allowControl: true } });
	const result = await call(fixture.routes, "POST", "/control", {
		headers: jsonHeaders,
		body: { commandId: "cmd-session", consumerId: "observer-test", action: "pause", target: { subjectId: "sess-frames" } },
	});
	assert.equal(result.status, 422);
	assert.deepEqual(result.body, { error: "unsupported-action", detail: "Pi sessions advertise no control owner" });
	assert.equal(await protocol.readControl(observerRoot, "cmd-session"), null);
	fixture.close();
});

test("accepted control is queued durably, journaled once and readable", async () => {
	const fixture = await activate({ settings: { allowControl: true } });
	const body = pauseTask("cmd-accepted");
	const first = await call(fixture.routes, "POST", "/control", { headers: jsonHeaders, body });
	assert.equal(first.status, 202);
	assert.equal(first.body.state, "queued");
	assert.equal(first.body.commandId, "cmd-accepted");
	assert.equal(first.body.duplicate, false);
	assert.deepEqual((await protocol.readControl(observerRoot, "cmd-accepted")).target.taskRef, body.target.taskRef);

	const journal = await protocol.readEvents(observerRoot, { limit: 2000 });
	const requested = journal.events.filter((event) => event.type === "control.requested" && event.payload?.commandId === "cmd-accepted");
	assert.equal(requested.length, 1);
	assert.deepEqual(requested[0].taskRef, body.target.taskRef);
	const events = await call(fixture.routes, "GET", "/events?limit=2000");
	assert.equal(events.status, 200);
	assert.ok(events.body.events.some((event) => event.payload?.commandId === "cmd-accepted"));
	const badLimit = await call(fixture.routes, "GET", "/events?limit=0");
	assert.equal(badLimit.status, 400);
	assert.deepEqual(badLimit.body, { error: "invalid-query" });

	const fetched = await call(fixture.routes, "GET", "/control?id=cmd-accepted");
	assert.equal(fetched.status, 200);
	assert.equal(fetched.body.state, "queued");
	assert.equal(fetched.body.commandId, "cmd-accepted");
	const unknown = await call(fixture.routes, "GET", "/control?id=missing");
	assert.equal(unknown.status, 404);

	const duplicate = await call(fixture.routes, "POST", "/control", { headers: jsonHeaders, body });
	assert.equal(duplicate.status, 202);
	assert.equal(duplicate.body.commandId, "cmd-accepted");
	assert.equal(duplicate.body.duplicate, true, "the same commandId is idempotent");
	const afterDuplicate = await protocol.readEvents(observerRoot, { limit: 2000 });
	assert.equal(afterDuplicate.events.filter((event) => event.type === "control.requested" && event.payload?.commandId === "cmd-accepted").length, 1);
	fixture.close();
});

test("invalid, oversized and non-JSON control bodies fail without internals", async () => {
	const fixture = await activate({ settings: { allowControl: true } });
	const oversized = "x".repeat(9 * 1024);
	for (const [label, options] of [
		["oversized", { headers: jsonHeaders, body: oversized }],
		["invalid json", { headers: jsonHeaders, body: "{not json" }],
		["wrong content type", { headers: { "content-type": "text/plain" }, body: pauseTask("cmd-wrong-type") }],
		["unknown action", { headers: jsonHeaders, body: { commandId: "cmd-unknown", consumerId: "observer-test", action: "nuke", target: { taskRef: { owner: "pi-coordinator", taskId: "task-api", revision: 1 } } } }],
		["escaping command id", { headers: jsonHeaders, body: { commandId: "../cmd", consumerId: "observer-test", action: "pause", target: { subjectId: "sess-frames" } } }],
	]) {
		const result = await call(fixture.routes, "POST", "/control", options);
		assert.equal(result.status, 400, label);
		assert.equal(typeof result.body.error, "string", label);
		assert.ok(!result.raw.includes("Error"), `${label} must not leak an exception`);
		assert.ok(!result.raw.includes("at "), `${label} must not leak a stack trace`);
	}
	assert.equal(await protocol.readControl(observerRoot, "cmd-wrong-type"), null);
	assert.equal(await protocol.readControl(observerRoot, "cmd-unknown"), null);
	fixture.close();
});

test("every HTTP route refuses non-loopback callers", async () => {
	const fixture = await activate({ settings: { allowControl: true } });
	const remote = { remoteAddress: "192.0.2.10" };
	const capability = await call(fixture.routes, "GET", "/capability", remote);
	assert.equal(capability.status, 403);
	assert.deepEqual(capability.body, { error: "loopback-only" });
	const post = await call(fixture.routes, "POST", "/control", { ...remote, headers: jsonHeaders, body: pauseTask("cmd-remote") });
	assert.equal(post.status, 403);
	assert.equal(await protocol.readControl(observerRoot, "cmd-remote"), null);
	fixture.close();
});

test("an unreadable snapshot directory degrades HTTP routes to a stable 503", async () => {
	const fixture = await activate({ settings: { allowControl: false } });
	await authorize(fixture);
	fixture.host.fs.listPath = async () => { throw new Error("EACCES: native permission revoked"); };
	const result = await call(fixture.routes, "GET", "/frames");
	assert.equal(result.status, 503);
	assert.deepEqual(result.body, { error: "unavailable" });
	assert.ok(!result.raw.includes("EACCES"));
	fixture.close();
});
