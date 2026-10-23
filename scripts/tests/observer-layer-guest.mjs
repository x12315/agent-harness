/**
 * Guest-only layered Observer case: real WebUI 0.100.0 with pi-coordinator and
 * pi-observer activated in one process, a bounded loopback model fixture, and
 * guest Chromium. Proves the merged "运行与任务" view, the WS directory
 * authorization handshake, and Observer -> coordinator pause/resume/cancel.
 * This is deterministic protocol evidence, never a model-quality test.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { buildClient } from "../../adapters/pi/coordinator-webui/build-client.mjs";

assert.equal(process.platform, "darwin", "macOS guest required");
assert.ok(process.env.AHSB_RUNTIME_DIR, "sandbox runtime required; never execute on host");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(await realpath(project), await realpath("/tmp/ahsb-push"), "sandbox pushed source only");
const runtimeRoot = await realpath(process.env.AHSB_RUNTIME_DIR);
const modules = join(runtimeRoot, existsSync(join(runtimeRoot, "lib/node_modules")) ? "lib/node_modules" : "node_modules");
const webDir = join(modules, "pi-web-ui"), piDir = join(modules, "@earendil-works/pi-coding-agent");
const browserBin = join(modules, "agent-browser/bin/agent-browser-darwin-arm64");
const installedHome = process.env.HOME;

const root = await realpath(await mkdtemp("/tmp/observer-layer-"));
const home = join(root, "home"), agent = join(home, ".pi/agent"), cwd = join(root, "workspace");
const data = join(root, "data"), observerDir = join(root, "observer"), artifacts = "/tmp/ah-artifacts";
for (const dir of [agent, cwd, data, observerDir, artifacts]) await mkdir(dir, { recursive: true, mode: 0o700 });
const workspace = await realpath(cwd);

const startedAt = Date.now(), budgetMs = 140000;
const liveSessionId = "observer-layer-live-session";
const expiredSessionId = "observer-layer-expired-session";
const expiredWorkspace = "/tmp/observer-layer-expired-workspace";
const objective = "OBSERVER_LAYER_HOLD：在隔离工作区持续执行，等待暂停、继续或取消，并保留完整原始要求。";
const receipt = {
	schemaVersion: 1, ok: false, result: "FAIL", platform: process.platform,
	fixture: "guest-loopback-deterministic", modelQualityTest: false, budgetMs,
	runtimeDir: runtimeRoot, workspace, observerDirectory: observerDir,
	checks: {}, issues: [], observations: [], sources: {}, screenshots: [],
	legacy: { liveSessionId, expiredSessionId, expiredWorkspace, snapshotIds: [], authorizedPayloads: 0 },
	frames: { kinds: [], capabilities: [], phases: {}, taskRef: null, taskId: null },
	controls: [],
	mock: { requests: 0, executorCalls: 0, classifications: [], externalAttempts: [] },
};

const transcript = [], artifactNames = new Set(), pendingCommands = new Set(), held = new Set();
let child, childExit, serverLog = "", provider, registry, registryRequests = [], fatal, browserStarted = false, snapshotTimer;
const stop = new AbortController();
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = async (name, content) => { await writeFile(join(artifacts, name), content, { mode: 0o600 }); artifactNames.add(name); };
const check = (name, condition, detail) => {
	receipt.checks[name] = !!condition;
	if (!condition) { receipt.issues.push({ check: name, detail }); console.error(`OBSERVER_LAYER_FAILURE ${JSON.stringify({ check: name, detail })}`); }
};
async function wait(predicate, label, ms = 8000, interval = 80) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		stop.signal.throwIfAborted();
		if (fatal) throw fatal;
		if (childExit) throw Error(`WebUI exited before ${label}: ${JSON.stringify(childExit)}`);
		const value = await predicate(); if (value) return value;
		await delay(interval);
	}
	throw Error(`Timed out: ${label}`);
}

let browserEnv, origin;
async function command(args, timeout = 10000, { raw = false, allowFailure = false } = {}) {
	stop.signal.throwIfAborted();
	const begin = Date.now();
	const proc = spawn(browserBin, args, { cwd, env: browserEnv, stdio: ["ignore", "pipe", "pipe"] });
	pendingCommands.add(proc);
	let stdout = "", stderr = "";
	proc.stdout.on("data", (part) => { stdout += part; if (stdout.length > 1500000) proc.kill("SIGKILL"); });
	proc.stderr.on("data", (part) => { stderr = (stderr + part).slice(-30000); });
	const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
	const code = await new Promise((done, reject) => { proc.on("error", reject); proc.on("close", done); }).finally(() => { clearTimeout(timer); pendingCommands.delete(proc); });
	const record = { command: args[0], args: args[0] === "eval" ? ["<DOM expression>"] : args.slice(1), code, elapsedMs: Date.now() - begin, stdout, stderr };
	transcript.push(record);
	if (code !== 0 && !allowFailure) throw Error(`agent-browser ${args[0]} failed (${code}): ${stderr || stdout}`);
	if (raw || code !== 0) return stdout;
	const result = JSON.parse(stdout);
	if (result.success === false && !allowFailure) throw Error(`agent-browser ${args[0]}: ${JSON.stringify(result)}`);
	return result.data;
}
const browser = (...args) => command(["--json", ...args]);
const evaluate = async (expression) => (await browser("eval", "-b", Buffer.from(expression).toString("base64")))?.result;
const waitDom = (expression, label, ms) => wait(() => evaluate(expression), label, ms);
async function screenshot(name) {
	await browser("screenshot", join(artifacts, name));
	const image = await readFile(join(artifacts, name));
	assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	artifactNames.add(name);
	receipt.screenshots.push({ name, sha256: sha(image), bytes: image.length, width: image.readUInt32BE(16), height: image.readUInt32BE(20) });
	console.error(`OBSERVER_LAYER_SCREENSHOT ${name}`);
}

/** The page-side recorder keeps every control-status transition, so a 15s observer re-render cannot hide a receipt. */
const recorderExpression = `(() => {
 if (!window.__observerLayerRecorder) {
  const state = { states: [] };
  window.__observerLayerRecorder = state;
  const record = () => {
   for (const frame of document.querySelectorAll('.run-tasks .frame')) {
    const status = frame.querySelector('.control-status')?.textContent ?? '';
    if (!status) continue;
    const detail = frame.querySelector('.control-detail')?.textContent ?? '';
    const buttons = [...frame.querySelectorAll('button.control-button')].map(button => ({ label: button.getAttribute('aria-label'), disabled: button.disabled }));
    const last = state.states[state.states.length - 1];
    if (last && last.status === status && last.detail === detail && JSON.stringify(last.buttons) === JSON.stringify(buttons)) continue;
    state.states.push({ at: Date.now(), status, detail, buttons });
    if (state.states.length > 400) state.states.shift();
   }
  };
  new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
  record();
 }
 return window.__observerLayerRecorder.states.length;
})()`;
const readControlStates = async (mark) => (await evaluate(`window.__observerLayerRecorder.states.slice(${mark})`)) ?? [];
const controlStateExpression = `(() => {
 const list = [...document.querySelectorAll('.run-tasks .frame')].filter(item => item.querySelector('button.control-button'));
 if (!list.length) return null;
 const buttons = [...list[0].querySelectorAll('button.control-button')];
 return { status: list[0].querySelector('.control-status')?.textContent ?? '', detail: list[0].querySelector('.control-detail')?.textContent ?? '', buttons: buttons.map(button => ({ label: button.getAttribute('aria-label'), disabled: button.disabled })) };
})()`;

const domExpression = `(() => {
 const section = document.querySelector('.run-tasks');
 const observer = document.querySelector('.observer');
 return {
  url: location.href,
  viewport: { width: innerWidth, height: innerHeight },
  pageWidth: document.documentElement.scrollWidth,
  pageHeight: document.documentElement.scrollHeight,
  title: document.title,
  text: document.body.innerText,
  sectionTitle: section?.querySelector('.section-title')?.textContent ?? null,
  groups: [...(section?.querySelectorAll('.frame-group-title') ?? [])].map(el => el.textContent),
  frames: [...(section?.querySelectorAll('.frame') ?? [])].map(frame => ({
   kind: frame.querySelector('.badge.kind')?.textContent ?? null,
   headline: frame.querySelector('.frame-headline')?.textContent ?? null,
   phase: frame.querySelector('.frame-phase')?.textContent ?? null,
   workspace: frame.querySelector('.frame-workspace')?.textContent ?? null,
   reference: frame.querySelector('.frame-ref')?.textContent ?? null,
   active: frame.classList.contains('is-active'),
   buttons: [...frame.querySelectorAll('button.control-button')].map(button => ({ label: button.textContent, aria: button.getAttribute('aria-label'), disabled: button.disabled })),
   status: frame.querySelector('.control-status')?.textContent ?? null,
   detail: frame.querySelector('.control-detail')?.textContent ?? null
  })),
  observer: observer ? { width: observer.getBoundingClientRect().width, scrollWidth: observer.scrollWidth, clientWidth: observer.clientWidth } : null,
  resources: [...new Set(performance.getEntriesByType('resource').map(entry => { try { return new URL(entry.name).hostname; } catch { return 'invalid'; } }))]
 };
})()`;
async function captureDom(name) {
	const dom = await evaluate(domExpression);
	assert.ok(dom?.sectionTitle, "real rendered merged Observer section required");
	await save(name, JSON.stringify(dom, null, 2));
	return dom;
}

const respond = (res, text) => {
	if (res.destroyed) return;
	for (const [delta, finish_reason] of [[{ role: "assistant", content: text }, null], [{}, "stop"]]) res.write(`data: ${JSON.stringify({ id: "observer-layer-fixture", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
	res.end("data: [DONE]\n\n");
};
const lastUserText = (messages) => { const value = messages.filter((message) => message.role === "user").at(-1)?.content; return typeof value === "string" ? value : (value ?? []).map((part) => part.text ?? "").join("\n"); };

/** One legacy Observer snapshot file; the live one is refreshed like a real running session. */
const snapshotBody = (id, updatedAt, cwdValue) => ({
	id, pid: 48123, cwd: cwdValue, active: true, phase: "working", updatedAt,
	runStartedAt: new Date(Date.parse(updatedAt) - 12000).toISOString(), lastActivityAt: updatedAt,
	lastTool: "read_file", workElapsedMs: 12000,
	processInventory: { checkedAt: updatedAt, pids: [48123] },
});
async function writeSnapshot(name, body) {
	const temporary = join(observerDir, `.${name}.${process.pid}.tmp`);
	await writeFile(temporary, JSON.stringify(body), { mode: 0o600 });
	await rename(temporary, join(observerDir, name));
}
const refreshLiveSnapshot = () => writeSnapshot(`${liveSessionId}.snapshot.json`, snapshotBody(liveSessionId, new Date().toISOString(), workspace));

class GuestSocket {
	constructor(url) {
		this.socket = new WebSocket(url);
		this.opened = new Promise((done, reject) => {
			this.socket.addEventListener("open", () => done(true), { once: true });
			this.socket.addEventListener("error", () => reject(Error("guest plugin WebSocket failed to open")), { once: true });
		});
		this.plugins = null;
		this.pathRequests = [];
		this.observerStates = [];
		this.coordinatorAccepted = 0;
		this.socket.addEventListener("message", ({ data }) => {
			let message;
			try { message = JSON.parse(String(data)); } catch { return; }
			if (message.type === "plugins") this.plugins = message.plugins ?? [];
			if (message.type === "plugin_path_request") this.pathRequests.push(message);
			if (message.type === "plugin_data" && message.pluginId === "pi-observer" && message.payload?.type === "observer-state") {
				this.observerStates.push({ at: Date.now(), payload: message.payload });
				if (this.observerStates.length > 40) this.observerStates.shift();
			}
			if (message.type === "plugin_data" && message.payload?.type === "coordinator-accepted") this.coordinatorAccepted++;
			if (message.type === "plugin_data" && message.payload?.type === "coordinator-error") this.lastError = message.payload.payload;
		});
		this.socket.addEventListener("error", () => { fatal = Error("guest plugin WebSocket failed"); });
	}
	send(payload) { this.socket.send(JSON.stringify(payload)); }
	close() { try { this.socket.close(); } catch { /* already closed */ } }
}

async function main() {
	const webPackage = await json(join(webDir, "package.json"));
	receipt.pi = (await json(join(piDir, "package.json"))).version;
	receipt.webui = webPackage.version;
	receipt.agentBrowser = (await json(join(modules, "agent-browser/package.json"))).version;

	const pluginDirs = ["adapters/pi/coordinator-webui", "adapters/pi/observer-webui"];
	const sourcePaths = ["scripts/tests/observer-layer-guest.mjs"];
	for (const directory of pluginDirs) {
		const absolute = join(project, directory);
		const entries = await readdir(absolute, { recursive: true, withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			sourcePaths.push(`${directory}/${join(entry.parentPath ?? entry.path, entry.name).slice(absolute.length + 1)}`);
		}
	}
	for (const file of [...new Set(sourcePaths)].sort()) receipt.sources[file] = sha(await readFile(join(project, file)));

	// 1. Seed one recent and one expired legacy snapshot before the plugin activates.
	await refreshLiveSnapshot();
	await writeSnapshot(`${expiredSessionId}.snapshot.json`, snapshotBody(expiredSessionId, new Date(Date.now() - 10 * 60_000).toISOString(), expiredWorkspace));
	snapshotTimer = setInterval(() => { void refreshLiveSnapshot(); }, 10_000);
	snapshotTimer.unref?.();

	// 2. Bounded loopback model fixture: routing intent plus a held executor.
	provider = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; if (body.length > 2000000) req.destroy(Error("fixture request budget")); });
		req.on("end", () => {
			try {
				assert.equal(req.url, "/v1/chat/completions");
				assert.ok(++receipt.mock.requests <= 30, "bounded local model calls");
				const request = JSON.parse(body);
				assert.equal(request.model, "local"); assert.equal(request.stream, true);
				const prompt = lastUserText(request.messages);
				if ((prompt.includes('{"currentInput":') && prompt.includes('"taskCandidates":[')) || (prompt.includes('{"userMessage":') && prompt.includes('"tasks":['))) {
					const at = Math.max(prompt.indexOf('{"userMessage":'), prompt.indexOf('{"currentInput":'));
					assert.ok(at >= 0, "classifier JSON envelope required");
					const envelope = JSON.parse(prompt.slice(at));
					const input = { userMessage: envelope.userMessage ?? envelope.currentInput?.text, tasks: envelope.tasks ?? envelope.taskCandidates };
					receipt.mock.classifications.push(input.userMessage);
					assert.equal(input.userMessage, objective, "only the declared fixture objective is routed");
					res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
					respond(res, JSON.stringify({ action: "task", text: input.userMessage }));
					return;
				}
				if (/^(?:\[Goal · round |【目标 · 第)/.test(prompt)) {
					receipt.mock.executorCalls++;
					assert.ok(prompt.includes("OBSERVER_LAYER_HOLD"), "only the known fixture objective may execute");
					res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
					res.write(": bounded held executor for the layered observer case\n\n");
					held.add(res);
					res.on("close", () => held.delete(res));
					return;
				}
				assert.fail(`unexpected native model request: ${prompt.slice(0, 600)}`);
			} catch (error) { fatal = error; res.destroy(); console.error(`OBSERVER_LAYER_FIXTURE_FAILURE ${error.message}`); }
		});
	});
	await new Promise((done) => provider.listen(0, "127.0.0.1", done));
	const model = { id: "local", name: "Guest observer-layer deterministic fixture", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "fixture-local": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [model] } } }), { mode: 0o600 });
	await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture-local", defaultModel: "local", defaultThinkingLevel: "off", compaction: { enabled: false }, packages: [], extensions: [], skills: [] }), { mode: 0o600 });

	// The app shell performs its own npm update check; point that registry at a
	// loopback stub so the guest fixture stays offline instead of reaching npmjs.org.
	registry = createServer((req, res) => {
		if (registryRequests.length < 100) registryRequests.push(req.url);
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end('{"error":"offline-test-registry"}');
	});
	await new Promise((done) => registry.listen(0, "127.0.0.1", done));
	await mkdir(join(agent, "npm"), { recursive: true, mode: 0o700 });
	await writeFile(join(agent, "npm/.npmrc"), `registry=http://127.0.0.1:${registry.address().port}/\n`, { mode: 0o600 });
	receipt.registry = { baseUrl: `http://127.0.0.1:${registry.address().port}/`, requests: 0 };

	const guard = join(root, "loopback-only.mjs");
	await writeFile(guard, `import net from 'node:net';import {appendFileSync} from 'node:fs';const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const host=typeof first==='object'?first.host:(typeof args[1]==='string'?args[1]:'localhost');if(host&&!['127.0.0.1','localhost','::1'].includes(host)){appendFileSync(process.env.FIXTURE_NETWORK_LOG,JSON.stringify({host})+'\\n');throw Error('fixture denied non-loopback network');}return connect.apply(this,args);};\n`, { mode: 0o600 });

	// 3. Both plugins copied into the same data directory; only the coordinator needs a client build.
	const coordinatorSource = join(project, "adapters/pi/coordinator-webui");
	const coordinatorDir = join(data, "plugins/pi-coordinator");
	await cp(coordinatorSource, coordinatorDir, { recursive: true, errorOnExist: true, force: false });
	receipt.uiComponents = await buildClient({ webPackage: webDir, pluginDirectory: coordinatorDir });
	await cp(join(project, "adapters/pi/observer-webui"), join(data, "plugins/pi-observer"), { recursive: true, errorOnExist: true, force: false });
	await mkdir(join(data, "plugin-overrides"), { recursive: true });
	await writeFile(join(data, "plugin-overrides/pi-observer.json"), JSON.stringify({ settings: { allowControl: true } }));

	const probe = createServer(); await new Promise((done) => probe.listen(0, "127.0.0.1", done));
	const port = probe.address().port; await new Promise((done) => probe.close(done));
	assert.notEqual(port, 8793, "never use the production port");
	origin = `http://127.0.0.1:${port}`;
	await writeFile(join(data, "plugin-overrides/pi-coordinator.json"), JSON.stringify({ settings: { allowExecution: true, allowObserverControl: true, endpoint: `ws://127.0.0.1:${port}/ws` } }));

	browserEnv = { PATH: `${join(runtimeRoot, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: root, LANG: "en_US.UTF-8", AGENT_BROWSER_SESSION: `observer-${process.pid}`, AGENT_BROWSER_SOCKET_DIR: join(root, "sockets"), AGENT_BROWSER_DEFAULT_TIMEOUT: "4000", AGENT_BROWSER_IDLE_TIMEOUT_MS: "120000" };
	const env = {
		...browserEnv, PI_OBSERVER_DIR: observerDir, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
		PI_WEB_PLUGIN_CATALOG_URL: "off", PI_WEB_HOST: "127.0.0.1", PI_WEB_PORT: String(port), PI_WEB_CWD: workspace,
		PI_WEB_DATA_DIR: data, PI_WEB_SDK_DIR: piDir, PI_WEB_SDK: "global", NO_PROXY: "127.0.0.1,localhost",
		NODE_OPTIONS: `--import=${guard}`, FIXTURE_NETWORK_LOG: join(root, "network.jsonl"),
	};
	const bin = typeof webPackage.bin === "string" ? webPackage.bin : webPackage.bin["pi-web-ui"];
	child = spawn(process.execPath, [join(webDir, bin), "--no-browser", "--host", "127.0.0.1", "--port", String(port), "--cwd", workspace, "--data-dir", data], { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	child.on("error", (error) => { fatal = error; });
	child.on("exit", (code, signal) => { childExit = { code, signal }; });
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { serverLog = (serverLog + chunk).slice(-120000); });
	await wait(async () => {
		try {
			const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
			if (!response.ok) return false;
			receipt.health = await response.json();
			return true;
		} catch { return false; }
	}, "isolated WebUI health", 20000, 300);
	assert.equal(receipt.health.piVersion, receipt.pi, "WebUI must use the declared guest Pi SDK");

	const client = new GuestSocket(`ws://127.0.0.1:${port}/ws`);
	await client.opened;
	client.send({ type: "hello", clientId: "22222222-3333-4444-8555-666666666666", locale: "zh" });
	await wait(() => client.plugins, "plugin manifest push", 25000, 200);
	check("bothPluginsActivated", client.plugins.some((plugin) => plugin.id === "pi-coordinator" && plugin.active) && client.plugins.some((plugin) => plugin.id === "pi-observer" && plugin.active), client.plugins.map(({ id, active, error }) => ({ id, active, error })));
	check("coordinatorClientBuildPresent", existsSync(join(coordinatorDir, "client/vendor/marked.mjs")) && existsSync(join(data, "plugins/pi-observer/client/entry.mjs")), "coordinator build artifact and plain observer client");
	await wait(() => serverLog.includes("[plugin:pi-observer] Pi Observer tab activated") && serverLog.includes("[plugin:pi-coordinator] Responsive coordinator active"), "plugin activation logs", 15000, 200);
	check("observerControlOwnerLogged", serverLog.includes("Observer control actions are owned by pi-coordinator"), serverLog.slice(-2000));

	// 4. Explicit Observer directory approval over the plugin message channel.
	const initialState = await wait(() => client.observerStates.find((item) => item.payload && item.payload.authorized === false), "initial unauthorized observer state", 10000, 150);
	check("unapprovedViewHidesSnapshots", initialState.payload.snapshots.length === 0 && initialState.payload.frames.length === 0, { authorized: initialState.payload.authorized, snapshots: initialState.payload.snapshots.length });
	client.send({ type: "plugin_message", pluginId: "pi-observer", payload: { type: "observer-authorize" } });
	const request = await wait(() => client.pathRequests.find((item) => item.pluginId === "pi-observer"), "observer plugin_path_request", 15000, 150);
	check("observerPathRequestNamesDirectory", request.path === observerDir && typeof request.id === "string", request);
	client.send({ type: "plugin_path_response", id: request.id, ok: true });
	const authorized = await wait(() => client.observerStates.find((item) => item.payload?.authorized === true && item.payload.snapshots?.length), "authorized observer-state payload", 15000, 150);
	receipt.legacy.authorizedPayloads = client.observerStates.filter((item) => item.payload?.authorized === true).length;
	receipt.legacy.snapshotIds = authorized.payload.snapshots.map((snapshot) => snapshot.id);
	check("legacyPayloadStillArrives", authorized.payload.snapshots.length === 1 && authorized.payload.snapshots[0].id === liveSessionId && authorized.payload.snapshots[0].phase === "working", authorized.payload.snapshots);
	check("expiredSnapshotFilteredFromLegacy", !receipt.legacy.snapshotIds.includes(expiredSessionId), receipt.legacy.snapshotIds);

	// 5. Drive a real held native task through the coordinator WS input.
	client.send({ type: "plugin_message", pluginId: "pi-coordinator", payload: { type: "coordinator-input", requestId: "observer-layer-task", workspace, text: objective } });
	await wait(() => held.size > 0, "held native executor", 20000, 100);
	const activeFrame = await wait(async () => {
		const view = await framesAt();
		return view.frames.find((frame) => frame.kind === "webui-task" && frame.active === true) ?? false;
	}, "active webui-task frame", 25000, 400);
	receipt.frames.taskId = activeFrame.taskRef?.taskId ?? null;
	receipt.frames.taskRef = activeFrame.taskRef ?? null;
	receipt.frames.phases.initial = activeFrame.phase;
	check("taskFrameOwnedByCoordinator", activeFrame.taskRef?.owner === "pi-coordinator" && Number.isSafeInteger(activeFrame.taskRef?.revision), activeFrame.taskRef);

	const view = await framesAt();
	receipt.frames.kinds = [...new Set(view.frames.map((frame) => frame.kind))].sort();
	receipt.frames.factObjective = view.tasks?.[0]?.objective ?? null;
	check("framesIncludeBothKinds", receipt.frames.kinds.includes("pi-session") && receipt.frames.kinds.includes("webui-task"), receipt.frames.kinds);
	check("framesControlRootShared", view.controlRoot === observerDir, view.controlRoot);
	const sessionFrames = view.frames.filter((frame) => frame.kind === "pi-session");
	const taskFrames = view.frames.filter((frame) => frame.kind === "webui-task");
	check("onlyRecentSessionFrame", sessionFrames.length === 1 && sessionFrames[0].subjectId === liveSessionId, sessionFrames.map((frame) => frame.subjectId));
	check("sessionFrameOffersNoControlTarget", sessionFrames.every((frame) => !frame.taskRef), sessionFrames.map((frame) => frame.taskRef));
	check("taskFrameCarriesObjective", taskFrames.length === 1 && view.tasks[0]?.objective === objective && taskFrames[0].workspace === workspace && taskFrames[0].subjectId === `${taskFrames[0].taskRef?.owner}:${taskFrames[0].taskRef?.taskId}`, { facts: view.tasks, frame: taskFrames[0] });
	check("expiredSnapshotFilteredFromFrames", !sessionFrames.some((frame) => frame.subjectId === expiredSessionId) && !view.frames.some((frame) => frame.workspace === expiredWorkspace), sessionFrames.map((frame) => frame.subjectId));
	const capability = await (await fetch(`${origin}/plugins-api/pi-observer/capability`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) })).json();
	receipt.frames.capabilities = capability.actions;
	check("capabilityAdvertisesOwnedActions", ["pause", "resume", "cancel"].every((action) => capability.actions.includes(action)), capability);
	check("capabilityNamesBothSources", capability.sources.includes("pi-session") && capability.sources.includes("webui-task"), capability.sources);

	// 6. Real guest Chromium: open the app root and the Pi Observer tab.
	const chromeCandidates = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"];
	for (const cache of [join(installedHome, ".agent-browser/browsers"), join(installedHome, ".cache/agent-browser"), join(installedHome, ".cache/ms-playwright"), join(installedHome, "Library/Caches/ms-playwright")]) {
		try {
			const files = await readdir(cache, { recursive: true, withFileTypes: true });
			chromeCandidates.push(...files.filter((file) => file.isFile() && ["Google Chrome for Testing", "Chromium", "chrome-headless-shell"].includes(file.name)).map((file) => join(file.parentPath ?? file.path, file.name)));
		} catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	let chrome;
	for (const candidate of chromeCandidates) { try { await access(candidate); chrome = candidate; break; } catch { /* keep looking */ } }
	receipt.browserRuntime = { binary: browserBin, chromeCandidates, chrome, allowlist: "not used: agent-browser allowlist replaces WebSocket and breaks the plugin socket" };
	await save("browser-runtime.json", JSON.stringify(receipt.browserRuntime, null, 2));
	assert.ok(chrome, "prepared guest Chrome missing; inspect browser-runtime.json, never download in a test");
	browserEnv.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
	browserStarted = true;
	await command(["--json", "--executable-path", chrome, "open", `${origin}/`], 20000);
	await browser("set", "viewport", "1440", "1000");
	await waitDom("!!document.querySelector('button.plugin-tab')", "app shell with plugin tabs", 20000);
	const baselineErrors = JSON.stringify((await browser("errors"))?.errors ?? []);
	const tabSelector = 'button.plugin-tab[data-tip="Pi Observer"]';
	try { await browser("click", tabSelector); }
	catch (error) {
		receipt.observations.push({ code: "NATIVE_TAB_CLICK_UNAVAILABLE", severity: "harness", detail: String(error.message).slice(0, 300) });
		await evaluate(`document.querySelector(${JSON.stringify(tabSelector)}).click()`);
	}
	await waitDom("!!document.querySelector('.observer')", "observer plugin view mounted", 15000);
	await waitDom("!!document.querySelector('.run-tasks')", "merged run and task section", 15000);
	await evaluate(recorderExpression);

	const merged = await captureDom("observer-merged-dom.json");
	check("mergedSectionTitle", /^运行与任务 · \d+$/.test(merged.sectionTitle ?? ""), merged.sectionTitle);
	check("mergedGroupsShowBothKinds", merged.groups.includes("Pi 会话 · 1") && merged.groups.includes("协调任务 · 1"), merged.groups);
	const renderedTask = merged.frames.find((frame) => frame.kind === "协调任务");
	const renderedSession = merged.frames.find((frame) => frame.kind === "Pi 会话");
	check("renderedTaskObjectiveAndWorkspace", renderedTask?.headline === objective && renderedTask?.workspace === workspace, renderedTask);
	check("renderedSessionWorkspace", renderedSession?.workspace === workspace && renderedSession?.active === true, renderedSession);
	check("renderedSessionPhase", renderedSession?.headline === "working" && renderedSession?.active === true, { headline: renderedSession?.headline, active: renderedSession?.active });
	check("expiredSnapshotNeverRendered", !merged.text.includes(expiredSessionId) && !merged.text.includes(expiredWorkspace), { expiredSessionId, expiredWorkspace });
	check("piSessionFrameHasNoControls", (renderedSession?.buttons.length ?? -1) === 0 && !renderedSession?.reference, renderedSession);
	check("taskFrameShowsAllControls", ["暂停", "继续", "取消"].every((label) => renderedTask?.buttons.some((button) => button.label === label)), renderedTask?.buttons);
	check("desktopNoHorizontalOverflow", merged.pageWidth <= merged.viewport.width + 1, { pageWidth: merged.pageWidth, viewport: merged.viewport });
	await browser("scrollintoview", ".run-tasks");
	await screenshot("observer-merged.png");

	async function applyControl(label, action) {
		const mark = await evaluate(recorderExpression);
		const beganAt = Date.now();
		await browser("click", `button.control-button[aria-label^="${label}任务"]`);
		const immediate = await evaluate(controlStateExpression);
		const applied = await wait(async () => (await readControlStates(mark)).find((entry) => entry.status === "已生效") ?? false, `${action} applied receipt in the UI`, 25000, 150);
		const entries = await readControlStates(mark);
		receipt.controls.push({ action, latencyMs: applied.at - beganAt, appliedDetail: applied.detail, states: entries.map(({ status, detail, buttons }) => ({ status, detail, disabled: buttons.map((button) => button.disabled) })) });
		const pending = entries.filter((entry) => entry.status === "正在提交" || entry.status === "排队中");
		const first = entries[0];
		return { action, immediate, applied, entries, pending, first };
	}

	const pause = await applyControl("暂停", "pause");
	check("pauseHasNoOptimisticReceipt", pause.first?.status !== "已生效" && pause.pending.length >= 1 && pause.pending.every((entry) => entry.buttons.length > 0 && entry.buttons.every((button) => button.disabled)), { first: pause.first, pending: pause.pending.map((entry) => entry.status) });
	check("pausePendingBeforeReceipt", pause.pending.some((entry) => entry.status === "排队中") || (pause.immediate?.buttons ?? []).every((button) => button.disabled), { pending: pause.pending.map((entry) => entry.status), immediate: pause.immediate });
	check("pauseAppliedReceipt", pause.applied.detail.startsWith("pause:"), pause.applied);
	const paused = await wait(async () => {
		const frame = (await framesAt()).frames.find((item) => item.kind === "webui-task");
		return frame?.phase === "paused" ? frame : false;
	}, "paused task phase via frames", 15000, 300);
	receipt.frames.phases.paused = paused.phase;

	const resume = await applyControl("继续", "resume");
	check("resumeHasNoOptimisticReceipt", resume.first?.status !== "已生效" && resume.pending.length >= 1 && resume.pending.every((entry) => entry.buttons.length > 0 && entry.buttons.every((button) => button.disabled)), { first: resume.first, pending: resume.pending.map((entry) => entry.status) });
	check("resumeAppliedReceipt", resume.applied.detail.startsWith("resume:"), resume.applied);
	const resumed = await wait(async () => {
		const frame = (await framesAt()).frames.find((item) => item.kind === "webui-task");
		return frame && ["running", "starting"].includes(frame.phase) ? frame : false;
	}, "resumed task phase via frames", 20000, 300);
	receipt.frames.phases.resumed = resumed.phase;

	const cancel = await applyControl("取消", "cancel");
	check("cancelHasNoOptimisticReceipt", cancel.first?.status !== "已生效" && cancel.pending.length >= 1 && cancel.pending.every((entry) => entry.buttons.length > 0 && entry.buttons.every((button) => button.disabled)), { first: cancel.first, pending: cancel.pending.map((entry) => entry.status) });
	check("cancelAppliedReceipt", cancel.applied.detail.startsWith("cancel:"), cancel.applied);
	const cancelled = await wait(async () => {
		const frame = (await framesAt()).frames.find((item) => item.kind === "webui-task");
		return frame?.phase === "cancelled" ? frame : false;
	}, "cancelled task phase via frames", 15000, 300);
	receipt.frames.phases.cancelled = cancelled.phase;
	await browser("scrollintoview", ".run-tasks");
	await screenshot("observer-control.png");
	const controlDom = await captureDom("observer-control-dom.json");
	check("appliedLabelObservedForEveryControl", receipt.controls.length === 3 && receipt.controls.every((control) => control.states.some((state) => state.status === "已生效")), receipt.controls.map((control) => ({ action: control.action, states: control.states.map((state) => state.status) })));
	check("renderRetainsBothFrameKindsAfterCancel", controlDom.frames.filter((frame) => frame.kind === "协调任务").length === 1 && controlDom.frames.filter((frame) => frame.kind === "Pi 会话").length === 1, controlDom.frames.map((frame) => ({ kind: frame.kind, phase: frame.phase, status: frame.status })));

	await browser("set", "viewport", "390", "844");
	await waitDom("window.innerWidth === 390 && window.innerHeight === 844", "mobile viewport", 8000);
	await browser("scrollintoview", ".run-tasks");
	const mobile = await captureDom("observer-mobile-dom.json");
	check("mobileNoHorizontalOverflow", mobile.pageWidth <= mobile.viewport.width + 1, { pageWidth: mobile.pageWidth, viewport: mobile.viewport });
	check("mobileObserverNoOverflow", !!mobile.observer && mobile.observer.scrollWidth <= mobile.observer.clientWidth + 1, mobile.observer);
	check("mobileMergedSectionRetained", mobile.groups.includes("Pi 会话 · 1") && mobile.groups.includes("协调任务 · 1"), mobile.groups);
	if (!(mobile.frames.find((frame) => frame.kind === "协调任务")?.phase ?? "").includes("cancelled")) receipt.observations.push({ code: "OBSERVER_POLL_LAG", severity: "presentation", evidence: "observer-mobile-dom.json", detail: "The rendered task card keeps its pre-cancel phase text until the next 15s observer poll; the server frames already report cancelled and the control receipt shows 已生效 cancel:cancelled." });
	await screenshot("observer-mobile.png");

	const errors = await browser("errors");
	await save("browser-errors.json", JSON.stringify(errors, null, 2));
	const finalErrors = (errors?.errors ?? []).map((entry) => JSON.stringify(entry));
	const baseline = JSON.parse(baselineErrors);
	const newErrors = finalErrors.filter((entry) => !baseline.map((item) => JSON.stringify(item)).includes(entry));
	check("noBrowserErrors", newErrors.length === 0, { baseline, final: errors?.errors ?? [] });
	check("noExternalBrowserRequests", (mobile.resources ?? []).every((host) => ["127.0.0.1", "localhost", "invalid"].includes(host)), mobile.resources);
	check("fixtureHeldExecutor", receipt.mock.executorCalls >= 2, { executorCalls: receipt.mock.executorCalls, held: held.size });
	check("taskObjectivePreserved", receipt.mock.classifications.length >= 1 && receipt.mock.classifications.every((text) => text === objective), receipt.mock.classifications);
	await save("frames.json", JSON.stringify({ initial: view, paused, resumed, cancelled }, null, 2));

	receipt.ok = receipt.issues.length === 0;
	receipt.result = receipt.ok ? "PASS" : "FAIL";
}

async function framesAt() {
	const response = await fetch(`${origin}/plugins-api/pi-observer/frames`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
	assert.equal(response.status, 200, `frames route must answer 200, got ${response.status}`);
	return await response.json();
}
let budget;
const deadline = new Promise((_, reject) => {
	budget = setTimeout(() => {
		const error = Error("guest layered observer case exceeded 140s execution budget");
		stop.abort(error);
		for (const proc of pendingCommands) proc.kill("SIGKILL");
		reject(error);
	}, budgetMs);
});
try {
	await Promise.race([main(), deadline]);
} catch (error) {
	receipt.error = error.stack;
	console.error(`OBSERVER_LAYER_CASE_FAILURE ${error.stack}`);
	if (!stop.signal.aborted) {
		try { await screenshot("failure.png"); await captureDom("failure-dom.json"); } catch { /* best effort */ }
		try { await command(["doctor", "--offline", "--quick"], 8000, { raw: true, allowFailure: true }); await save("browser-doctor.log", transcript.at(-1).stdout + transcript.at(-1).stderr); } catch { /* best effort */ }
	}
} finally {
	clearTimeout(budget);
	clearInterval(snapshotTimer);
	if (browserStarted && !stop.signal.aborted) { try { await browser("close"); receipt.checks.browserClosed = true; } catch (error) { receipt.cleanupError = error.message; } }
	for (const proc of pendingCommands) proc.kill("SIGKILL");
	if (child?.pid) {
		try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
		await delay(500);
		try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
		try { process.kill(-child.pid, 0); receipt.cleanupError = "WebUI process group still alive"; } catch (error) { if (error.code === "ESRCH") receipt.checks.webuiProcessGroupCleaned = true; }
	}
	for (const response of held) response.destroy();
	provider?.closeAllConnections();
	if (provider?.listening) await new Promise((done) => provider.close(done));
	registry?.closeAllConnections();
	if (registry?.listening) await new Promise((done) => registry.close(done));
	receipt.registry = { ...(receipt.registry ?? {}), requests: registryRequests.length };
	try {
		receipt.mock.externalAttempts = (await readFile(join(root, "network.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch (error) { if (error.code !== "ENOENT") receipt.cleanupError = error.message; }
	receipt.legacy.authorizedPayloads ||= 0;
	if (receipt.mock.externalAttempts.length || receipt.cleanupError || !receipt.checks.browserClosed || !receipt.checks.webuiProcessGroupCleaned) { receipt.ok = false; receipt.result = "FAIL"; }
	receipt.elapsedMs = Date.now() - startedAt;
	receipt.childExit = childExit;
	await save("browser-transcript.json", JSON.stringify(transcript.map(({ stdout, ...rest }) => rest), null, 2));
	await save("webui-server.log", serverLog);
	await save("receipt.json", JSON.stringify(receipt, null, 2));
	for (const name of artifactNames) {
		const content = await readFile(join(artifacts, name));
		assert.ok(content.length <= 1500000, "bounded artifact transfer");
		console.log(`OBSERVER_LAYER_ARTIFACT ${JSON.stringify({ name, sha256: sha(content), base64: content.toString("base64") })}`);
	}
	console.log(`OBSERVER_LAYER_RESULT ${JSON.stringify(receipt)}`);
	process.exitCode = receipt.ok ? 0 : 1;
}
