/** Run the current Observer in two real guest PTYs against a bounded loopback mock; no external provider or desktop GUI. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const expected = process.argv[2];
assert.ok(["darwin", "linux"].includes(expected));
assert.equal(process.platform, expected, "must execute inside the requested guest OS");
const runtime = process.env.AHSB_RUNTIME_DIR;
assert.ok(runtime, "sandbox must prepare and validate the runtime before execution");
const modules = existsSync(join(runtime, "lib/node_modules")) ? join(runtime, "lib/node_modules") : join(runtime, "node_modules");
const piPackageDir = join(modules, "@earendil-works/pi-coding-agent");
const piPackage = JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8"));
const webPackage = JSON.parse(readFileSync(join(modules, "pi-web-ui/package.json"), "utf8"));
const piEntry = join(piPackageDir, typeof piPackage.bin === "string" ? piPackage.bin : piPackage.bin.pi);
const require = createRequire(join(modules, "pi-web-ui/package.json"));
const pty = require("node-pty");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extension = join(project, "adapters/pi/extensions/pi-observer.ts");
const bell = join(project, "adapters/pi/extensions/iterm-bell.ts");
const root = await mkdtemp(join(tmpdir(), "observer-settlement-"));
const snapshotsDir = join(root, "observer");
await mkdir(snapshotsDir, { mode: 0o700 });
const artifacts = "/tmp/ah-artifacts";
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const workers = [];
const pendingTasks = new Map();
let taskCalls = 0, summaryCalls = 0;
const summaryText = "PROGRESS_ONLY: 当前会话正在思考，等待本地测试返回结果。";
const wait = async (predicate, label, ms = 8000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
	throw Error(`deadline: ${label}`);
};
const readJson = async (file) => { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const snapshot = async (worker) => {
	const name = (await readdir(snapshotsDir)).find((name) => name.startsWith(`${worker.terminal.pid}-`) && name.endsWith(".snapshot.json"));
	return name ? readJson(join(snapshotsDir, name)) : null;
};
const summary = async (worker) => {
	const name = (await readdir(snapshotsDir)).find((name) => name.startsWith(`${worker.terminal.pid}-`) && name.endsWith(".summary.json"));
	return name ? readJson(join(snapshotsDir, name)) : null;
};
const events = async (worker) => {
	try { return (await readFile(join(worker.agentDir, "ui.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
};
const panel = async (worker) => readJson(join(worker.agentDir, "widget.json"));
const respond = (res, text) => {
	for (const [delta, finish_reason] of [[{ role: "assistant", content: text }, null], [{}, "stop"]]) {
		res.write(`data: ${JSON.stringify({ id: "owned-local", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
	}
	res.end("data: [DONE]\n\n");
};
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (part) => { body += part; });
	req.on("end", () => {
		const isSummary = body.includes("<observed-data>");
		if (isSummary) summaryCalls++; else taskCalls++;
		if (taskCalls > 2 || summaryCalls > 2) { res.writeHead(503); res.end("fixture request budget exhausted"); return; }
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		if (isSummary) {
			try {
				const request = JSON.parse(body);
				assert.equal(request.tools, undefined, "Observer completions must have no tools");
				const input = request.messages.map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text || "").join("\n")).join("\n");
				const facts = JSON.parse(input.match(/<observed-data>\n([\s\S]+)\n<\/observed-data>/)[1]);
				assert.equal(facts.scope, "session"); assert.equal(facts.sessions.length, 1);
				respond(res, summaryText);
			} catch (error) { res.destroy(error); }
		} else {
			const label = body.includes("FIXTURE_A") ? "A" : body.includes("FIXTURE_B") ? "B" : null;
			if (!label || pendingTasks.has(label)) { res.destroy(Error("unexpected task")); return; }
			res.write(": owned guest-local task waiting\n\n");
			pendingTasks.set(label, () => respond(res, `RESULT_${label}: 本地验证任务已经结束。`));
		}
	});
});
await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
const recorder = join(root, "recorder.ts");
await writeFile(recorder, `import observer from ${JSON.stringify(extension)};
import { writeFileSync, appendFileSync } from 'node:fs';
export default function(pi) {
 const trace = (value) => appendFileSync(process.env.OWNED_UI_LOG,JSON.stringify(value)+'\\n');
 const instrument = (ctx) => new Proxy(ctx,{get:(target,key)=>key==='ui'?new Proxy(ctx.ui,{get:(ui,key)=>key==='setWidget'?((name,content,...rest)=>{if(name==='pi-observer')writeFileSync(process.env.OWNED_WIDGET_LOG,JSON.stringify({visible:!!content}));return ui.setWidget(name,content,...rest);}):key==='notify'?((message,type)=>{trace({kind:'notify',message,type});return ui.notify(message,type);}):Reflect.get(ui,key)}):Reflect.get(target,key)});
 observer(new Proxy(pi,{get:(target,key)=>key==='on'?((name,handler)=>pi.on(name,(event,ctx)=>handler(event,instrument(ctx)))):key==='registerCommand'?((name,command)=>pi.registerCommand(name,{...command,handler:async(args,ctx)=>{trace({kind:'command',args,stage:'start'});try{return await command.handler(args,instrument(ctx));}finally{trace({kind:'command',args,stage:'end'});}}})):Reflect.get(target,key)}));
}
`, { mode: 0o600 });
async function launch(label) {
	const agentDir = join(root, label); await mkdir(agentDir);
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "observer-local": {
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-fixture",
		models: [{ id: "local", name: "Owned loopback fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }), { mode: 0o600 });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "observer-local", defaultModel: "local", defaultThinkingLevel: "off", theme: "dark", compaction: { enabled: false } }), { mode: 0o600 });
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OBSERVER_DIR: snapshotsDir, PI_OBSERVER_INTERVAL_MINUTES: "0", PI_OFFLINE: "1", TERM: "xterm-256color", OWNED_UI_LOG: join(agentDir, "ui.jsonl"), OWNED_WIDGET_LOG: join(agentDir, "widget.json"), NO_PROXY: "127.0.0.1,localhost" };
	for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_CODING_AGENT_SESSION_DIR", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL", "PI_OBSERVER_KEEP_SNAPSHOTS", "TERM_PROGRAM", "ITERM_SESSION_ID", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
	const terminal = pty.spawn(process.execPath, [piEntry, "--no-session", "--offline", "--no-tools", "--no-extensions", "--no-skills", "--extension", recorder, "--extension", bell], { cwd: agentDir, env, cols: 120, rows: 32, name: "xterm-256color" });
	const worker = { terminal, agentDir, output: "", exit: null, label }; workers.push(worker);
	terminal.onData((data) => { worker.output += data; }); terminal.onExit((value) => { worker.exit = value; });
	await wait(async () => !!await snapshot(worker), `${label}: native startup`);
	terminal.write(`FIXTURE_${label}: Wait for the owned local task result.\r`);
	await wait(() => pendingTasks.has(label), `${label}: active mock task`);
	terminal.write("/observer now\r");
	await wait(async () => (await summary(worker))?.text === summaryText && (await events(worker)).some((event) => event.kind === "command" && event.args === "now" && event.stage === "end"), `${label}: native session-scoped summary`);
	assert.equal((await snapshot(worker)).active, true); assert.equal((await panel(worker)).visible, true);
	console.log(`checkpoint ${label}: real Pi active with persistent progress panel`);
	return worker;
}
async function command(worker, name) {
	const prior = (await events(worker)).filter((event) => event.kind === "command" && event.args === name && event.stage === "end").length;
	worker.terminal.write(`/observer ${name}\r`);
	await wait(async () => (await events(worker)).filter((event) => event.kind === "command" && event.args === name && event.stage === "end").length > prior, `${worker.label}: /observer ${name} completed`);
}
const deadline = setTimeout(() => { for (const worker of workers) if (!worker.exit) worker.terminal.kill(); server.closeAllConnections(); }, 65000);
let evidence;
try {
	const a = await launch("A"), b = await launch("B");
	const cached = await summary(a); pendingTasks.get("A")();
	await wait(async () => (await snapshot(a))?.attention?.reason === "reply" && (await panel(a))?.visible === false, "A: final settlement hides panel");
	assert.equal((await snapshot(a)).active, false);
	assert.equal((await snapshot(b)).active, true); assert.equal((await panel(b)).visible, true);
	assert.deepEqual(await summary(a), cached);
	console.log("checkpoint settlement: A hidden with cache/reminder retained; B still active and visible");
	await command(a, "last");
	assert.equal((await panel(a)).visible, false);
	assert.ok((await events(a)).some((event) => event.kind === "notify" && event.message === `Pi observer: ${cached.text}`));
	const beforeReload = await snapshot(a);
	a.terminal.write("/reload\r");
	await wait(async () => (await snapshot(a))?.updatedAt !== beforeReload.updatedAt, "A: actual native reload");
	assert.equal((await panel(a)).visible, false); assert.deepEqual(await summary(a), cached);
	assert.deepEqual((await snapshot(a)).attention, beforeReload.attention);
	assert.equal((await snapshot(a)).runId, beforeReload.runId);
	assert.equal((await snapshot(a)).workElapsedMs, beforeReload.workElapsedMs);
	assert.equal((await snapshot(a)).automaticReports, false);
	await command(a, "last"); await command(a, "ack");
	assert.ok((await snapshot(a)).attention.acknowledgedAt);
	assert.equal((await panel(a)).visible, false);
	assert.equal((await panel(b)).visible, true);
	pendingTasks.get("B")();
	await wait(async () => (await snapshot(b))?.attention?.reason === "reply" && (await panel(b))?.visible === false, "B: final settlement hides panel");
	assert.equal(taskCalls, 2); assert.equal(summaryCalls, 2);
	console.log("checkpoint reload: summary, clock, off and attention retained; neither last nor reload redisplays idle progress");
	for (const worker of workers) {
		worker.terminal.write("\x03"); await delay(250); worker.terminal.write("\x03");
		await wait(() => !!worker.exit, `${worker.label}: owned native exit`, 5000);
	}
	assert.equal((await readdir(snapshotsDir)).filter((name) => name.endsWith(".json")).length, 0);
	evidence = { ok: true, platform: process.platform, arch: process.arch, node: process.version, nodeAbi: process.versions.modules, pi: piPackage.version, webui: webPackage.version, nativeWorkers: 2, localTaskCalls: taskCalls, localSummaryCalls: summaryCalls, externalProviderRequests: 0, settlementHidesOnlyOwningPanel: true, cachedReplayRetainedWithoutPanel: true, nativeReloadRetainsFactsWithoutPanel: true, attentionAndAcknowledgmentPreserved: true, automaticOffPreserved: true, exitSnapshotCleanup: true, desktopGuiVerified: false };
	console.log(`OBSERVER_SETTLEMENT_RECEIPT ${JSON.stringify(evidence)}`);
} catch (error) {
	console.error(`observer-settlement failure: ${error.stack}`);
	for (const worker of workers) console.error(`native ${worker.label} terminal tail: ${worker.output.slice(-12000)}`);
	throw error;
} finally {
	clearTimeout(deadline);
	for (const worker of workers) {
		if (!worker.exit) { try { worker.terminal.kill(); } catch {} }
		await writeFile(join(artifacts, `observer-${worker.label}-terminal.log`), worker.output, { mode: 0o600 });
		await writeFile(join(artifacts, `observer-${worker.label}-ui.jsonl`), (await events(worker)).map((event) => JSON.stringify(event)).join("\n"), { mode: 0o600 });
	}
	if (evidence) await writeFile(join(artifacts, "observer-settlement.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
	server.closeAllConnections(); await new Promise((accept) => server.close(accept));
}
