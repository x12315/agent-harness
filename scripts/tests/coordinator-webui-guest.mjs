/** Guest-only deterministic protocol integration; not a real-model intent/quality test. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Coordinator } from "../../adapters/pi/coordinator-webui/coordinator.mjs";
import { WebUiExecutor } from "../../adapters/pi/coordinator-webui/webui-executor.mjs";
import { localStorage } from "../../adapters/pi/coordinator-webui/index.mjs";
import { buildClient } from "../../adapters/pi/coordinator-webui/build-client.mjs";

const runtime = process.env.AHSB_RUNTIME_DIR;
assert.ok(runtime, "AHSB_RUNTIME_DIR is required: never run the tested service on the host");
assert.equal(process.platform, process.argv[2], "requested guest platform");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(await realpath(project), await realpath("/tmp/ahsb-push"), "sandbox pushed source only");
const modules = join(runtime, existsSync(join(runtime, "lib/node_modules")) ? "lib/node_modules" : "node_modules");
const webDir = join(modules, "pi-web-ui");
const piDir = join(modules, "@earendil-works/pi-coding-agent");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const webPackage = await json(join(webDir, "package.json"));
const piPackage = await json(join(piDir, "package.json"));
const sourcePaths = ["scripts/tests/coordinator-webui-guest.mjs", ...["index.mjs", "coordinator.mjs", "webui-executor.mjs", "task-graph.mjs", "task-context.mjs", "observer-bridge.mjs", "protocol.generated.mjs", "coverage.mjs", "model-json.mjs", "native-evidence.mjs", "native-session.mjs", "build-client.mjs", "client/markdown.mjs", "manifest.json", "experience.html", "client/entry.mjs", "client/outbox.mjs", "client/view-utils.mjs", "client/styles.css", "client/experience.mjs", "client/experience.css"].map((name) => `adapters/pi/coordinator-webui/${name}`)];
const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, createHash("sha256").update(await readFile(join(project, path))).digest("hex")])));
const root = await mkdtemp(join(tmpdir(), "coordinator-webui-"));
const home = join(root, "home"), agent = join(home, ".pi/agent"), cwd = join(root, "workspace");
for (const path of [agent, cwd, join(root, "data"), "/tmp/ah-artifacts"]) await mkdir(path, { recursive: true, mode: 0o700 });
const receipt = { schemaVersion: 1, ok: false, result: "FAIL", platform: process.platform, node: process.version, pi: piPackage.version, webui: webPackage.version, sources, protocolTimeoutMs: 10000, totalBudgetMs: 90000, classifier: { mode: "injected-no-tools", modelQualityTest: false }, capabilities: {}, checks: {}, native: { goals: [], reviews: [] }, mock: { executorCalls: 0, reviewCalls: 0, settlementCalls: 0, requests: 0, externalAttempts: [] } };
const protocols = [], held = new Map(), executions = new Map(), reviews = new Map(), sockets = new Set(), commandPids = new Map();
const commandPidFile = (label) => join(cwd, `owned-command-${label}.pid`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
let child, childExit, childLog = "", coordinator, executor, provider, fatal, released = false;
const stop = new AbortController();
const wait = async (predicate, label, ms = 10000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (stop.signal.aborted) throw stop.signal.reason;
		if (fatal) throw fatal;
		if (childExit) throw Error(`WebUI exited before ${label}: ${JSON.stringify(childExit)}`);
		const value = await predicate(); if (value) return value;
		await delay(30);
	}
	throw Error(`protocol timeout: ${label}`);
};
const respond = (res, text) => {
	assert.ok(!res.destroyed, "held provider connection must remain live");
	for (const [delta, finish_reason] of [[{ role: "assistant", content: text }, null], [{}, "stop"]]) res.write(`data: ${JSON.stringify({ id: "local-fixture", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
	res.end("data: [DONE]\n\n");
};
const respondTool = (res, id, command) => {
	const tool = { index: 0, id, type: "function", function: { name: "bash", arguments: JSON.stringify({ command, timeout: 60, persist: false }) } };
	for (const [delta, finish_reason] of [[{ role: "assistant", tool_calls: [tool] }, null], [{}, "tool_calls"]]) res.write(`data: ${JSON.stringify({ id: "owned-command", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
	res.end("data: [DONE]\n\n");
};
const lastUserText = (messages) => {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content;
	return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
};
const goalA = "FIXTURE_GOAL_A: preserve this original objective through independent fail then retry then pass.";
const goalB = "FIXTURE_GOAL_B: independent queued work must pass native review.";
const goalC = "FIXTURE_GOAL_C: write regression evidence and verify all original requirements.";
const goalD = "FIXTURE_GOAL_D: pause and resume the native executor without losing the original objective.";
const goalE = "FIXTURE_GOAL_E: cancel only this held native executor.";
const gate = () => { let release; const promise = new Promise((done) => { release = done; }); return { promise, release }; };
const classifyGates = new Map();
const classify = async (input, snapshot) => {
	await classifyGates.get(input.text)?.promise;
	if (input.text === goalA || input.text === goalB) return { action: "task", text: input.text };
	assert.equal(input.text, "FIXTURE_QUERY");
	const task = snapshot.tasks.find((item) => item.objective === goalA);
	return { action: "question", text: input.text, answer: JSON.stringify({ taskId: task.id, status: task.status, objective: task.objective }) };
};
const capture = (event, owner) => {
	try {
		const message = JSON.parse(String(event.data));
		protocols.push({ ...message, fixtureClientId: owner?.clientId });
		if (protocols.length > 6000) throw Error("native protocol event budget exceeded");
		if (message.type === "goal_status") receipt.native.goals.push({ ...message.status, fixtureClientId: owner?.clientId });
		for (const item of [...(message.state?.messages ?? []), ...(message.appended ?? [])]) {
			if (item.customType === "goal-review" && item.details?.phase === "result") {
				const record = { conversationId: message.state?.conversationId ?? message.conversationId, clientId: owner?.clientId, ...item.details };
				if (!receipt.native.reviews.some((prior) => prior.clientId === record.clientId && prior.conversationId === record.conversationId && prior.round === record.round)) receipt.native.reviews.push(record);
			}
		}
	} catch (error) { fatal = error; }
};
const NativeSocket = globalThis.WebSocket ?? createRequire(join(webDir, "package.json"))("ws");
class RecordingSocket {
	constructor(url) {
		this.socket = new NativeSocket(url); sockets.add(this.socket);
		if (typeof this.socket.addEventListener === "function") this.socket.addEventListener("message", (event) => capture(event, this));
		else this.socket.on("message", (data) => capture({ data }, this));
	}
	addEventListener(type, listener) {
		if (typeof this.socket.addEventListener === "function") this.socket.addEventListener(type, listener);
		else this.socket.on(type, type === "message" ? (data) => listener({ data }) : listener);
	}
	send(data) { const message = JSON.parse(data); if (message.type === "hello") this.clientId = message.clientId; this.socket.send(data); }
	close() { this.socket.close(); }
}
async function main() {
	provider = createServer((req, res) => {
		let body = "";
		req.on("data", (part) => { body += part; if (body.length > 2000000) req.destroy(Error("request size budget")); });
		req.on("end", () => {
			try {
				assert.equal(req.url, "/v1/chat/completions");
				assert.ok(++receipt.mock.requests <= 40, "local provider request budget");
				const request = JSON.parse(body); assert.equal(request.model, "local"); assert.equal(request.stream, true);
				const prompt = lastUserText(request.messages);
				if ((prompt.includes('{"currentInput":') && prompt.includes('"taskCandidates":[')) || (prompt.includes('{"userMessage":') && prompt.includes('"tasks":['))) {
					receipt.mock.pluginIntentCalls = (receipt.mock.pluginIntentCalls ?? 0) + 1;
					assert.ok(receipt.mock.pluginIntentCalls <= 8);
					res.writeHead(200, { "Content-Type": "text/event-stream" });
					const start = Math.max(prompt.indexOf('{"userMessage":'), prompt.indexOf('{"currentInput":'));
					assert.ok(start >= 0, "native host classifier envelope must retain the supplied JSON");
					const envelope = JSON.parse(prompt.slice(start));
					const input = { userMessage: envelope.userMessage ?? envelope.currentInput?.text, tasks: envelope.tasks ?? envelope.taskCandidates };
					let intent = { action: "question", text: input.userMessage, answer: "Plugin classifier answered from the isolated fixture." };
					if ([goalC, goalD, goalE].includes(input.userMessage)) intent = { action: "task", text: input.userMessage };
					if (["FIXTURE_PAUSE_D", "FIXTURE_RESUME_D", "FIXTURE_CANCEL_E"].includes(input.userMessage)) {
						const objective = input.userMessage.endsWith("_D") ? goalD : goalE;
						intent = { action: input.userMessage.includes("PAUSE") ? "pause" : input.userMessage.includes("RESUME") ? "resume" : "cancel", text: input.userMessage, targetId: input.tasks.find((task) => task.objective === objective).id };
					}
					respond(res, JSON.stringify(intent));
					return;
				}
				if (body.includes("Check WHOLE-OBJECTIVE COVERAGE")) {
					receipt.mock.coverageCalls = (receipt.mock.coverageCalls ?? 0) + 1;
					assert.ok(receipt.mock.coverageCalls <= 3, "bounded plugin coverage repair");
					res.writeHead(200, { "Content-Type": "text/event-stream" });
					respond(res, JSON.stringify(receipt.mock.coverageCalls === 1 ? { complete: false, checked: [], missing: [{ requirement: "verify all original requirements", evidenceGap: "A native round passed but regression coverage was not evidenced" }] } : { complete: true, checked: [{ requirement: body.includes("FIXTURE_GOAL_D") ? goalD : goalC, evidence: "Deterministic native fixture executed the preserved objective and coverage repair" }], missing: [] }));
					return;
				}
				if (/^[❌✅🔍].*(?:Review round|第 .*轮审查)/.test(prompt)) {
					receipt.mock.reviewCardCalls = (receipt.mock.reviewCardCalls ?? 0) + 1;
					assert.ok(receipt.mock.reviewCardCalls <= 8, "bounded native review-card continuations");
					res.writeHead(200, { "Content-Type": "text/event-stream" });
					respond(res, "Native review card acknowledged."); return;
				}
				const label = prompt.includes("FIXTURE_GOAL_A") ? "A" : prompt.includes("FIXTURE_GOAL_B") ? "B" : prompt.includes("FIXTURE_GOAL_C") ? "C" : prompt.includes("FIXTURE_GOAL_D") ? "D" : prompt.includes("FIXTURE_GOAL_E") ? "E" : null;
				assert.ok(label, `unexpected native model request: ${prompt.slice(0, 2500)}`);
				res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
				if (/^(?:你是严格、独立的验收者|You are a strict, independent acceptor)/.test(prompt)) {
					receipt.mock.reviewCalls++;
					const round = (reviews.get(label) ?? 0) + 1; reviews.set(label, round);
					respond(res, JSON.stringify({ verdict: label === "A" && round === 1 ? "fail" : "pass", feedback: `fixture-${label}-review-${round}` }));
				} else if (/^(?:\[Goal · round |【目标 · 第)/.test(prompt)) {
					receipt.mock.executorCalls++;
					const round = (executions.get(label) ?? 0) + 1; executions.set(label, round);
					const summary = `executor(summary): fixture ${label} round ${round}, deterministic local protocol evidence only.`;
					if (["D", "E"].includes(label) && round === 1) {
						assert.ok(request.tools?.some((tool) => tool.function?.name === "bash"), "native executor must expose its real bash tool");
						const script = `require('node:fs').writeFileSync(${JSON.stringify(commandPidFile(label))},String(process.pid)); console.log('OWNED_COORDINATION_COMMAND_${label}'); setInterval(()=>console.log('owned command active'),1000);`;
						respondTool(res, `owned-command-${label}`, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);
						held.set(label, () => {}); return;
					}
					if (["A", "D", "E"].includes(label) && round === 1) { res.write(": held executor\n\n"); held.set(label, () => respond(res, summary)); }
					else respond(res, summary);
				} else {
					assert.ok(/Goal achieved and passed review|目标已达成并通过审查/.test(prompt), "only native settlement follow-up is allowed");
					assert.ok(++receipt.mock.settlementCalls <= 5, "bounded native settlement follow-ups");
					respond(res, "Fixture settlement acknowledged.");
				}
			} catch (error) { fatal = error; res.destroy(); }
		});
	});
	await new Promise((done) => provider.listen(0, "127.0.0.1", done));
	const model = { id: "local", name: "Bounded guest loopback fixture", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "fixture-local": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-secret", models: [model] } } }), { mode: 0o600 });
	await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture-local", defaultModel: "local", defaultThinkingLevel: "off", compaction: { enabled: false }, packages: [], extensions: [], skills: [] }), { mode: 0o600 });
	const guard = join(root, "loopback-only.mjs");
	await writeFile(guard, `import net from 'node:net';import {appendFileSync} from 'node:fs';
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const host=typeof first==='object'?first.host:(typeof args[1]==='string'?args[1]:'localhost');if(host&&!['127.0.0.1','localhost','::1'].includes(host)){appendFileSync(process.env.FIXTURE_NETWORK_LOG,JSON.stringify({host})+'\\n');throw Error('fixture denied non-loopback network');}return connect.apply(this,args);};\n`, { mode: 0o600 });
	const portProbe = createServer(); await new Promise((done) => portProbe.listen(0, "127.0.0.1", done));
	const port = portProbe.address().port; await new Promise((done) => portProbe.close(done));
	const pluginDir = join(root, "data/plugins/pi-coordinator");
	await mkdir(join(pluginDir, "client"), { recursive: true });
	for (const path of sourcePaths.filter((path) => path.startsWith("adapters/"))) await writeFile(join(pluginDir, path.replace("adapters/pi/coordinator-webui/", "")), await readFile(join(project, path)), { mode: 0o600 });
	await buildClient({webPackage:webDir,pluginDirectory:pluginDir});
	await mkdir(join(root, "data/plugin-overrides"), { recursive: true });
	await writeFile(join(root, "data/plugin-overrides/pi-coordinator.json"), JSON.stringify({ settings: { endpoint: `ws://127.0.0.1:${port}/ws`, allowExecution: true } }));
	const env = { PATH: `${join(runtime, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: root, LANG: "en_US.UTF-8", TERM: "xterm-256color", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_WEB_PLUGIN_CATALOG_URL: "off", PI_WEB_HOST: "127.0.0.1", PI_WEB_PORT: String(port), PI_WEB_CWD: cwd, PI_WEB_DATA_DIR: join(root, "data"), PI_WEB_SDK_DIR: piDir, PI_WEB_SDK: "global", NO_PROXY: "127.0.0.1,localhost", NODE_OPTIONS: `--import=${guard}`, FIXTURE_NETWORK_LOG: join(root, "network.jsonl") };
	const bin = typeof webPackage.bin === "string" ? webPackage.bin : webPackage.bin["pi-web-ui"];
	child = spawn(process.execPath, [join(webDir, bin), "--no-browser", "--host", "127.0.0.1", "--port", String(port), "--cwd", cwd, "--data-dir", join(root, "data")], { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	child.on("error", (error) => { fatal = error; });
	child.on("exit", (code, signal) => { childExit = { code, signal }; });
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (part) => { childLog = (childLog + part).slice(-100000); });
	await wait(async () => {
		try { const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }); if (!res.ok) return false; receipt.health = await res.json(); return true; } catch { return false; }
	}, "real isolated WebUI health");
	assert.equal(receipt.health.piVersion, piPackage.version, "WebUI must use the declared guest Pi SDK, not another bundled version");
	const browser = new RecordingSocket(`ws://127.0.0.1:${port}/ws`);
	browser.addEventListener("open", () => browser.send(JSON.stringify({ type: "hello", clientId: "11111111-2222-4333-8444-555555555555" })));
	await wait(() => protocols.some((message) => message.type === "snapshot" && message.state?.clientId === "11111111-2222-4333-8444-555555555555"), "browser attach and plugin chain ready before task intake", 20000);
	assert.ok(childLog.includes("[plugin:pi-coordinator] activated"), "actual plugin activation required");
	let goalSource = "";
	try { goalSource = await readFile(join(webDir, "dist/server/goal-service.js"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
	receipt.capabilities = { probe: "installed GoalService implementation + live protocol", goalServiceSha256: createHash("sha256").update(goalSource).digest("hex"), delegatedExecutor: goalSource.includes("spawnRoleAgent"), independentReviewer: goalSource.includes("askDelegatedReview"), roleState: goalSource.includes("g.roles") || goalSource.includes("goal.roles") };
	if (!receipt.capabilities.delegatedExecutor || !receipt.capabilities.independentReviewer || !receipt.capabilities.roleState) {
		receipt.result = "NOT_READY";
		receipt.gap = { code: "NATIVE_GOAL_SERVICE_2_REQUIRED", package: `pi-web-ui@${webPackage.version}`, path: "dist/server/goal-service.js", missing: Object.entries(receipt.capabilities).filter(([, value]) => value === false).map(([key]) => key), next: "Prepare a new independent sandbox base with native executor roles and independent review; do not modify existing dependency recipes in this fixture." };
		return;
	}
	const storage = localStorage(join(root, "coordinator"));
	executor = new WebUiExecutor({ url: `ws://127.0.0.1:${port}/ws`, cwd, model: "fixture-local/local", maxRounds: 3, timeoutMs: 10000, WebSocketImpl: RecordingSocket, onEvent: (id, event) => coordinator.observe(id, event) });
	coordinator = new Coordinator({ storage, classify, executor, maxConcurrent: 1, checkpointMs: 500, maxRuntimeMs: 60000 });
	await coordinator.restore();
	const durableSubmit = async (text) => {
		const barrier = gate(); classifyGates.set(text, barrier);
		const start = Date.now(); const accepted = await coordinator.submit(text);
		const elapsed = Date.now() - start;
		(receipt.receiptLatencyMs ??= []).push(elapsed);
		assert.ok(elapsed < 1000, "receipt must not wait on classifier/executor");
		const persisted = (await storage.read()).inputs.find((item) => item.id === accepted.id);
		assert.equal(persisted.text, text); assert.equal(persisted.acceptedAt, accepted.acceptedAt); assert.equal(persisted.status, "pending");
		barrier.release(); return accepted;
	};
	await durableSubmit(goalA);
	await wait(() => held.has("A") && coordinator.snapshot().tasks[0]?.status === "running" && coordinator.snapshot().tasks[0]?.handle?.clientId, "held native executor");
	const active = coordinator.snapshot().tasks[0];
	browser.send(JSON.stringify({ type: "plugin_message", pluginId: "pi-coordinator", payload: { type: "coordinator-get" } }));
	const pluginState = await wait(() => protocols.find((message) => message.type === "plugin_data" && message.pluginId === "pi-coordinator" && message.payload?.workspace)?.payload, "actual plugin activation");
	browser.send(JSON.stringify({ type: "plugin_message", pluginId: "pi-coordinator", payload: { type: "coordinator-input", requestId: "fixture-plugin-request", workspace: pluginState.workspace, text: "后台工作中，我现在仍能提问吗？" } }));
	await wait(() => protocols.some((message) => message.type === "plugin_data" && message.payload?.type === "coordinator-accepted" && message.payload.requestId === "fixture-plugin-request"), "actual plugin durable receipt during held executor");
	await wait(() => protocols.some((message) => message.type === "plugin_data" && message.payload?.state?.inputs?.some((input) => input.requestId === "fixture-plugin-request" && input.status === "question")), "actual plugin classifier answer during held executor");
	assert.equal(released, false);
	receipt.checks.actualPluginAcceptedAndAnswered = true;
	assert.ok(receipt.native.goals.some((goal) => goal?.roles?.executor?.convId), "native executor role evidence required");
	const query = await durableSubmit("FIXTURE_QUERY");
	await wait(() => coordinator.snapshot().inputs.find((input) => input.id === query.id)?.status === "question", "foreground answer during held executor");
	const answer = JSON.parse(coordinator.snapshot().inputs.find((input) => input.id === query.id).answer);
	assert.equal(answer.taskId, active.id); assert.equal(answer.objective, goalA); assert.equal(answer.status, "running");
	await durableSubmit(goalB);
	await wait(() => coordinator.snapshot().tasks.find((task) => task.objective === goalB)?.status === "queued", "new task queued during held executor");
	assert.equal(released, false); assert.equal(receipt.mock.executorCalls, 1); assert.equal(receipt.mock.reviewCalls, 0);
	receipt.checks.durableReceiptsBeforeClassification = true;
	receipt.checks.queryAndNewTaskWhileExecutorHeld = true;
	const before = coordinator.snapshot().tasks[0].checkpoint?.at ?? 0;
	await wait(() => (coordinator.snapshot().tasks[0].checkpoint?.at ?? 0) > before, "real timer checkpoint without user input");
	assert.equal(released, false); assert.equal(receipt.mock.reviewCalls, 0);
	receipt.checks.autonomousTimerCheckpoint = true;
	await coordinator.tick();
	receipt.checks.externalTickAccepted = true;
	released = true; held.get("A")();
	await wait(() => coordinator.snapshot().tasks.length === 2 && coordinator.snapshot().tasks.every((task) => task.status === "verified"), "native fail/retry/pass and queued goal pass", 40000);
	const tasks = coordinator.snapshot().tasks;
	assert.deepEqual(tasks.map((task) => task.objective), [goalA, goalB]);
	assert.deepEqual([...executions], [["A", 2], ["B", 1]]);
	assert.deepEqual([...reviews], [["A", 2], ["B", 1]]);
	const aReviews = receipt.native.reviews.filter((item) => item.clientId === active.handle.clientId && item.conversationId === active.handle.conversationId).sort((a, b) => a.round - b.round);
	assert.deepEqual(aReviews.map(({ round, verdict }) => ({ round, verdict })), [{ round: 1, verdict: "fail" }, { round: 2, verdict: "pass" }]);
	assert.ok(receipt.native.goals.filter((goal) => goal?.phase === "idle" && goal?.verdict === "pass").length >= 2);
	assert.deepEqual((await storage.read()).tasks.map(({ objective, status }) => ({ objective, status })), [{ objective: goalA, status: "verified" }, { objective: goalB, status: "verified" }]);
	receipt.checks.nativeReviewFailRetryPass = true;
	receipt.checks.originalObjectivesPreserved = true;
	receipt.checks.nativeQueuedGoalPassed = true;
	browser.send(JSON.stringify({ type: "plugin_message", pluginId: "pi-coordinator", payload: { type: "coordinator-input", requestId: "fixture-plugin-goal", workspace: pluginState.workspace, text: goalC } }));
	const finalPlugin = await wait(() => protocols.filter((message) => message.type === "plugin_data" && message.pluginId === "pi-coordinator").map((message) => message.payload?.state).findLast((state) => state?.tasks?.some((task) => task.status === "verified" && task.coverageRepairs === 1)), "actual plugin whole-objective coverage repair without another user instruction", 30000);
	const completed = finalPlugin.tasks.find((task) => task.status === "verified");
	assert.equal(completed.objective, goalC); assert.equal(completed.revision, 2); assert.equal(completed.coverage.status, "passed");
	assert.equal(executions.get("C"), 2); assert.equal(reviews.get("C"), 2); assert.equal(receipt.mock.coverageCalls, 2);
	receipt.checks.actualPluginCoverageRepair = true;
	const sendPlugin = (text, requestId) => browser.send(JSON.stringify({ type: "plugin_message", pluginId: "pi-coordinator", payload: { type: "coordinator-input", requestId, workspace: pluginState.workspace, text } }));
	const latestTask = (objective) => protocols.filter((message) => message.type === "plugin_data" && message.pluginId === "pi-coordinator").map((message) => message.payload?.state?.tasks?.find((task) => task.objective === objective)).filter(Boolean).at(-1);
	sendPlugin(goalD, "fixture-plugin-pause-task");
	await wait(() => held.has("D") && existsSync(commandPidFile("D")) && latestTask(goalD)?.status === "running" && latestTask(goalD)?.handle, "real native long command running");
	const pidD = Number(await readFile(commandPidFile("D"), "utf8")); assert.ok(Number.isSafeInteger(pidD) && pidD > 1); commandPids.set("D", pidD); assert.ok(alive(pidD));
	sendPlugin("FIXTURE_QUERY_D", "fixture-plugin-command-query");
	await wait(() => protocols.some((message) => message.type === "plugin_data" && message.payload?.state?.inputs?.some((input) => input.requestId === "fixture-plugin-command-query" && input.status === "question")), "foreground question while native tool process is alive");
	assert.ok(alive(pidD)); receipt.checks.actualLongCommandInteractive = true;
	sendPlugin("FIXTURE_PAUSE_D", "fixture-plugin-pause");
	await wait(() => latestTask(goalD)?.status === "paused" && latestTask(goalD)?.stopEvidence?.operation === "pause", "exact native executor stop confirmation", 15000);
	assert.equal(executions.get("D"), 1);
	await wait(() => !alive(pidD), "owned native command ceased after pause", 5000);
	sendPlugin("FIXTURE_RESUME_D", "fixture-plugin-resume");
	await wait(() => latestTask(goalD)?.status === "verified", "native pause/resume with existing session and final review", 15000);
	assert.equal(executions.get("D"), 2); assert.equal(latestTask(goalD).objective, goalD);
	receipt.checks.actualPluginPauseResume = true;
	sendPlugin(goalE, "fixture-plugin-cancel-task");
	await wait(() => held.has("E") && existsSync(commandPidFile("E")) && latestTask(goalE)?.status === "running" && latestTask(goalE)?.handle, "native plugin cancel target running");
	const pidE = Number(await readFile(commandPidFile("E"), "utf8")); assert.ok(Number.isSafeInteger(pidE) && pidE > 1); commandPids.set("E", pidE); assert.ok(alive(pidE));
	sendPlugin("FIXTURE_CANCEL_E", "fixture-plugin-cancel");
	await wait(() => latestTask(goalE)?.status === "cancelled", "exact native executor cancellation", 15000);
	assert.equal(executions.get("E"), 1); assert.equal(reviews.get("E"), undefined);
	await wait(() => !alive(pidE), "owned native command ceased after cancel", 5000);
	receipt.checks.actualPluginCancellation = true;
	receipt.checks.ownedToolProcessesStopped = true;
	receipt.pluginTasks = [latestTask(goalC), latestTask(goalD), latestTask(goalE)];
	receipt.tasks = tasks;
	receipt.result = "PASS"; receipt.ok = true;
}
let budget;
const deadline = new Promise((_, reject) => { budget = setTimeout(() => { const error = Error("guest fixture execution budget exceeded (84s + cleanup <=90s)"); stop.abort(error); reject(error); }, 84000); });
const interrupt = (signal) => { fatal = Error(`interrupted: ${signal}`); stop.abort(fatal); };
process.on("SIGTERM", interrupt); process.on("SIGINT", interrupt);
try { await Promise.race([main(), deadline]); }
catch (error) { receipt.error = error.stack; receipt.result = "FAIL"; receipt.ok = false; receipt.debugState = coordinator?.snapshot(); receipt.protocolTypesTail = protocols.slice(-40).map(({type,fixtureClientId}) => ({type,fixtureClientId})); console.error(`isolated WebUI failure log:\n${childLog.slice(-10000)}`); }
finally {
	clearTimeout(budget); stop.abort(Error("fixture cleanup"));
	for (const label of ["D", "E"]) {
		try { const pid = Number(await readFile(commandPidFile(label), "utf8")); if (Number.isSafeInteger(pid) && pid > 1) commandPids.set(label, pid); } catch {}
	}
	for (const pid of commandPids.values()) if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} }
	executor?.dispose();
	if (coordinator) await Promise.race([coordinator.stop().catch(() => {}), delay(300)]);
	for (const socket of sockets) { try { socket.terminate?.(); socket.close(); } catch {} }
	if (child?.pid) {
		try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") receipt.cleanupError = error.message; }
		await delay(600);
		try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") receipt.cleanupError = error.message; }
		await delay(50);
	}
	provider?.closeAllConnections(); if (provider?.listening) await new Promise((done) => provider.close(done));
	try { receipt.mock.externalAttempts = (await readFile(join(root, "network.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (error) { if (error.code !== "ENOENT") receipt.cleanupError = error.message; }
	receipt.childExit = childExit ?? null;
	receipt.checks.ownedProcessGroupCleaned = false;
	try { if (child?.pid) process.kill(-child.pid, 0); } catch (error) { if (error.code === "ESRCH") receipt.checks.ownedProcessGroupCleaned = true; }
	if (receipt.mock.externalAttempts.length || receipt.cleanupError || (child?.pid && !receipt.checks.ownedProcessGroupCleaned)) { receipt.ok = false; receipt.result = "FAIL"; }
	for (const [name, value] of [["coordinator-webui.json", JSON.stringify(receipt, null, 2)], ["coordinator-webui-server.log", childLog], ["coordinator-webui-protocol.jsonl", protocols.map((message) => JSON.stringify(message)).join("\n")]]) await writeFile(join("/tmp/ah-artifacts", name), value, { mode: 0o600 });
	console.log(`COORDINATOR_WEBUI_RECEIPT ${JSON.stringify(receipt)}`);
	process.exitCode = receipt.result === "PASS" ? 0 : receipt.result === "NOT_READY" ? 78 : 1;
	process.off("SIGTERM", interrupt); process.off("SIGINT", interrupt);
}
