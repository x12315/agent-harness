import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { stripTypeScriptTypes } from "node:module";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import webPlugin from "../../adapters/pi/observer-webui/index.mjs";

const source = stripTypeScriptTypes(readFileSync(new URL("../../adapters/pi/extensions/pi-observer.ts", import.meta.url), "utf8"))
	.replace(/^import .*;\n/gm, "").replace("export default function", "function observer") + "\nobserver;";

function fixture(deferred = false, interval = "1") {
	const files = new Map(), timers = new Map(), requests = [], notifications = [], widgets = new Map();
	const signals = [], listeners = new Map(), webRequests = [], browserRequests = [];
	let health = { ok: true, engine: "pi", piVersion: "fixture" }, openerCode = 0;
	const runtimeProcess = { pid: 42, getuid: () => 501, platform: "darwin", env: { PI_OBSERVER_INTERVAL_MINUTES: interval } };
	const bus = {
		emit: (channel, data) => { signals.push({ channel, data }); for (const handler of listeners.get(channel) || []) handler(data); },
		on: (channel, handler) => { const set = listeners.get(channel) || new Set(); set.add(handler); listeners.set(channel, set); return () => set.delete(handler); },
	};
	let response = { content: [{ type: "text", text: "Pi is thinking." }] };
	let now = Date.now(), counter = 0;
	let piPids = [42], inventoryError = null, snapshotReads = 0;
	class Clock extends Date {
		constructor(...args) { super(...(args.length ? args : [now])); }
		static now() { return now; }
	}
	const fs = { promises: {
		mkdir: async () => {},
		writeFile: async (name, value) => files.set(name, value),
		rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
		rm: async (name) => files.delete(name),
		readdir: async () => { snapshotReads++; return [...files.keys()].map((name) => path.basename(name)); },
		readFile: async (name) => { if (!files.has(name)) throw Error("missing fixture file"); return files.get(name); },
	} };
	const runtimeGlobals = {};
	const load = () => runInNewContext(source, { globalThis: runtimeGlobals, structuredClone, fs, path, Date: Clock, AbortController, AbortSignal, stripVTControlCharacters,
		truncateToWidth: (text, width) => Array.from(text).slice(0, width).join(""),
		wrapTextWithAnsi: (text, width) => {
			const chars = Array.from(text), lines = [];
			for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(""));
			return lines;
		},
		fetch: async (url, options) => { webRequests.push({ url, options }); if (health instanceof Error) throw health; return { ok: true, json: async () => health }; },
		execFile: (command, args, options, callback) => {
			assert.equal(command, "ps");
			assert.deepEqual(Array.from(args), ["-u", "501", "-o", "pid=,comm="]);
			assert.equal(options.timeout, 2000);
			callback(inventoryError, piPids.map((pid) => `${pid} pi`).join("\n") + "\n500 unrelated");
		},
		process: runtimeProcess,
		getAgentDir: () => "/guest/agent", uuidv7: () => `summary-${++counter}`,
		setInterval: (callback, ms) => { const timer = { callback, ms }; timers.set(timer, timer); return timer; },
		clearInterval: (timer) => timers.delete(timer),
		setTimeout: (callback, ms) => { const timer = { callback, ms }; timers.set(timer, timer); return timer; },
		clearTimeout: (timer) => timers.delete(timer),
	});
	const flush = async () => { for (let i = 0; i < 8; i++) await setImmediate(); };
	const make = (initialId, mode = "rpc") => {
		let id = initialId;
		let valid = true, idle = true, selectedAction;
		const menus = [];
		const events = new Map(), commands = new Map();
		load()({
			events: bus,
			exec: async (command, args, options) => { browserRequests.push({ command, args: Array.from(args), options }); return { code: openerCode }; },
			on: (name, callback) => {
				assert.ok(!["context", "input", "before_agent_start", "tool_call"].includes(name), "no model-loop interception");
				events.set(name, callback);
			},
			registerCommand: (name, command) => commands.set(name, command),
		});
		const ctx = Object.freeze({ cwd: `/guest/${initialId}`, model: { id: "fixture" }, mode,
			isIdle: () => { if (!valid) throw Error("stale ctx"); return idle; },
			sessionManager: { getSessionId: () => { if (!valid) throw Error("stale ctx"); return id; }, getSessionFile: () => `/guest/${id}.jsonl` },
			ui: {
				select: async (title, options) => {
					menus.push({ title, options });
					await events.get("ui_prompt_start")({ title, kind: "select" }, ctx);
					const selected = options.find((option) => option.startsWith(`/observer ${selectedAction} ·`));
					await events.get("ui_prompt_end")({}, ctx);
					return selected;
				},
				notify: (text, type) => notifications.push({ id: `42-${id}`, text, type }),
				setWidget: (key, content) => { assert.equal(key, "pi-observer"); if (content) widgets.set(`42-${id}`, content); else widgets.delete(`42-${id}`); },
			}, modelRegistry: {
				complete: async (model, context, options) => {
					requests.push({ model, context, options });
					if (deferred) return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
					if (response instanceof Error) throw response;
					return response;
				},
			},
		});
		return {
			menus,
			choose: (action) => { selectedAction = action; },
			complete: (prefix) => commands.get("observer").getArgumentCompletions(prefix),
			invalidate: () => { valid = false; },
			setBusy: (busy) => { idle = !busy; },
			start: async (reason) => { events.get("session_start")({ reason }, ctx); await flush(); },
			emit: async (name, event = {}) => {
				if (name === "agent_start") idle = false;
				if (name === "agent_settled") idle = true;
				await events.get(name)(event, ctx); await flush();
			},
			command: async (args) => { await commands.get("observer").handler(args, ctx); await flush(); },
			switch: async (next, event) => { id = next; await events.get(event)({}, ctx); await flush(); },
		};
	};
	return { files, timers, requests, notifications, widgets, signals, webRequests, browserRequests, make, flush,
		health: (value) => { health = value; },
		opener: (code) => { openerCode = code; },
		platform: (value) => { runtimeProcess.platform = value; },
		port: (value) => { runtimeProcess.env.PI_WEB_PORT = value; },
		panel: (id, width = 120, rows = 24) => widgets.get(`42-${id}`)?.({ terminal: { rows } }, { fg: (_color, text) => text }).render(width).join("\n") || "",
		respond: (value) => { response = value; },
		get snapshotReads() { return snapshotReads; },
		inventory: (pids, error = null) => { piPids = pids; inventoryError = error; },
		advance: (ms) => { now += ms; },
		tick: async (ms) => { now += ms; for (const timer of [...timers.values()]) if (timer.ms <= ms) timer.callback(); await flush(); },
		snapshots: () => [...files].filter(([name]) => name.endsWith(".snapshot.json")).map(([, value]) => JSON.parse(value)),
	};
}

test("automatic off survives agent runs; on/manual summaries stay isolated; session transitions and shutdown clean up", async () => {
	const f = fixture(), pi = f.make("original");
	await pi.start(); await pi.emit("agent_start"); await f.tick(60000);
	assert.equal(f.requests.length, 1);
	await pi.command("off"); await pi.emit("agent_settled"); await pi.emit("agent_start"); await f.tick(60000);
	assert.equal(f.requests.length, 1, "off must not silently re-enable on the next task");
	await pi.command("now"); await pi.command("on"); await f.tick(60000);
	assert.equal(f.requests.length, 3);
	assert.equal(new Set(f.requests.map((request) => request.options.sessionId)).size, 3);
	for (const request of f.requests) {
		assert.equal(request.context.messages.length, 1);
		assert.equal(request.context.messages[0].role, "user");
		assert.equal(request.context.tools, undefined);
		assert.equal(request.options.cacheRetention, "none");
	}
	for (const [event, id] of [["session_switch", "new"], ["session_fork", "fork"]]) {
		await pi.switch(id, event);
		assert.deepEqual(f.snapshots().map((snapshot) => snapshot.id), [`42-${id}`]);
	}
	await pi.start(); assert.equal(f.snapshots().length, 1, "reload must not delete a same-session snapshot");
	await pi.emit("session_shutdown"); assert.equal(f.files.size, 0); assert.equal(f.timers.size, 0);
	await pi.emit("agent_settled"); await pi.emit("agent_start");
	assert.equal(f.files.size, 0, "late SDK abort events must not resurrect disposed session snapshots");
	assert.equal(f.timers.size, 0);
});

test("reload preserves owning-session summary, attention acknowledgments, tool history and settled compaction-adjusted clocks", async () => {
	const f = fixture(), old = f.make("reload", "tui");
	await old.start(); await old.emit("agent_start");
	await old.emit("turn_start", { turnIndex: 3 });
	await old.emit("tool_execution_end", { toolName: "bash", isError: true });
	const signal = new AbortController();
	await old.emit("session_before_compact", { reason: "threshold", signal: signal.signal });
	f.advance(5000); await old.emit("session_compact");
	f.advance(10000); await old.command("now"); await old.emit("agent_settled");
	await old.command("ack");
	const before = f.snapshots()[0], summary = [...f.files].find(([name]) => name.endsWith(".summary.json"))[1];
	await old.emit("session_shutdown", { reason: "reload" });
	assert.equal(f.files.size, 2, "reload must not remove the shared snapshot or summary");
	assert.equal(f.timers.size, 0, "old timers must still be released");
	assert.ok(f.snapshots()[0].attention.acknowledgedAt);
	await old.emit("tool_execution_end", { toolName: "late-shutdown", isError: false });
	f.advance(60000);
	const fresh = f.make("reload", "tui"); await fresh.start("reload");
	const after = f.snapshots()[0];
	for (const field of ["startedAt", "lastActivityAt", "runId", "runStartedAt", "workElapsedMs", "turn", "lastTool", "lastToolError", "attention", "compaction", "recentEvents"]) assert.deepEqual(after[field], before[field], field);
	assert.equal([...f.files].find(([name]) => name.endsWith(".summary.json"))[1], summary);
	assert.equal(f.panel("reload"), "", "reload must not redisplay a settled run's summary");
	await fresh.command("last"); assert.equal(f.requests.length, 1, "reload and replay must not call the model");
	assert.ok(f.notifications.at(-1).text.includes("Pi is thinking."));
	assert.equal(f.panel("reload"), "", "explicit replay returns text without restoring a stale progress panel");
	await fresh.emit("agent_start"); assert.equal(f.snapshots()[0].attention, undefined);
	assert.ok(!f.panel("reload").includes("Pi is thinking."), "a real new run still clears the old panel");
	await fresh.emit("session_shutdown", { reason: "quit" });
	assert.equal(f.files.size, 0); assert.equal(f.timers.size, 0);
});

test("reload preserves automatic off and isolates same-process session handovers", async () => {
	const f = fixture(), parent = f.make("reload-parent"), child = f.make("reload-child");
	await parent.start(); await child.start();
	await parent.command("now"); await child.command("off");
	await parent.emit("session_shutdown", { reason: "reload" });
	await child.emit("session_shutdown", { reason: "reload" });
	const childNext = f.make("reload-child"), parentNext = f.make("reload-parent");
	await childNext.start("reload"); await parentNext.start("reload");
	await childNext.command("last");
	assert.ok(f.notifications.at(-1).text.includes("尚无缓存"));
	await parentNext.command("last"); assert.ok(f.notifications.at(-1).text.includes("Pi is thinking."));
	await childNext.emit("agent_start"); await f.tick(60000);
	assert.equal(f.requests.length, 1, "reload must not silently turn automatic summaries back on");
	assert.equal(f.snapshots().find((s) => s.id === "42-reload-child").automaticReports, false);
	await parentNext.emit("session_shutdown"); await childNext.emit("session_shutdown");
	assert.equal(f.files.size, 0); assert.equal(f.timers.size, 0);
});

test("reload retains an explicitly enabled positive interval even when the environment default is disabled", async () => {
	const f = fixture(false, "0"), old = f.make("reload-enabled");
	await old.start(); await old.command("on"); await old.emit("agent_start"); await f.tick(60000);
	assert.equal(f.requests.length, 1);
	await old.emit("session_shutdown", { reason: "reload" });
	const fresh = f.make("reload-enabled"); fresh.setBusy(true); await fresh.start("reload");
	assert.ok([...f.timers.values()].every((timer) => timer.ms > 0), "restoring on must not create a zero-delay request loop");
	await f.tick(15000); assert.equal(f.requests.length, 1);
	await f.tick(300000); assert.equal(f.requests.length, 2);
	await fresh.emit("session_shutdown"); assert.equal(f.files.size, 0); assert.equal(f.timers.size, 0);
});

test("reload cancels only the in-flight Observer request and restores the existing active run without an immediate retry", async () => {
	const f = fixture(true), old = f.make("pending-reload");
	await old.start(); await old.emit("agent_start"); await f.tick(60000);
	const before = f.snapshots()[0];
	await old.emit("session_shutdown", { reason: "reload" });
	assert.equal(f.requests[0].options.signal.aborted, true);
	assert.equal(f.timers.size, 0);
	const fresh = f.make("pending-reload"); fresh.setBusy(true); await fresh.start("reload");
	assert.equal(f.snapshots()[0].runId, before.runId);
	assert.equal(f.snapshots()[0].runStartedAt, before.runStartedAt);
	await f.tick(15000); assert.equal(f.requests.length, 1);
	await fresh.command("status"); assert.ok(!f.notifications.at(-1).text.includes("生成中（"));
	await fresh.emit("session_shutdown"); assert.equal(f.files.size, 0); assert.equal(f.timers.size, 0);
});

test("same-process sessions stay distinct and heartbeat preserves quiet sessions without inventing activity", async () => {
	const f = fixture(false, "0"), parent = f.make("parent"), child = f.make("child");
	await parent.start(); await child.start(); await child.emit("agent_start");
	const activity = f.snapshots().find((snapshot) => snapshot.id === "42-child").lastActivityAt;
	f.advance(2 * 60 * 60 * 1000); await f.tick(15000);
	assert.equal(f.snapshots().length, 2);
	assert.equal(f.snapshots().find((snapshot) => snapshot.id === "42-child").lastActivityAt, activity);
	await parent.command("now");
	const input = f.requests[0].context.messages[0].content[0].text;
	assert.ok(input.includes("42-parent"));
	assert.ok(!input.includes("42-child"), "same PID must not merge different session summaries");
	await child.command("now");
	const childInput = f.requests[1].context.messages[0].content[0].text;
	assert.ok(childInput.includes("42-child") && !childInput.includes("42-parent"));
	assert.equal(f.snapshotReads, 0, "terminal summaries must not read the shared session directory");
	await parent.emit("session_shutdown"); assert.equal(f.snapshots().length, 1);
	await child.emit("session_shutdown"); assert.equal(f.files.size, 0); assert.equal(f.timers.size, 0);
});

test("slow summary requests cannot overlap and stop/timeout cancel only the separate completion", async () => {
	const f = fixture(true), pi = f.make("slow");
	await pi.start(); await pi.emit("agent_start");
	await f.tick(60000); await f.tick(60000);
	assert.equal(f.requests.length, 1);
	await f.tick(45000);
	assert.equal(f.requests[0].options.signal.aborted, true);
	const summary = JSON.parse([...f.files].find(([name]) => name.endsWith(".summary.json"))[1]);
	assert.ok(summary.text.includes("42-slow"), "timeout must fall back to bounded observation facts");
	await f.tick(60000); assert.equal(f.requests.length, 2);
	await pi.emit("agent_settled");
	assert.equal(f.requests[1].options.signal.aborted, true);
	assert.equal(f.snapshots()[0].active, false);
	await pi.emit("session_shutdown"); assert.equal(f.files.size, 0); assert.equal(f.timers.size, 0);
});

test("explicit on overrides a disabled default and stale SDK contexts stop heartbeats", async () => {
	const f = fixture(false, "0"), pi = f.make("disabled");
	await pi.start(); await pi.emit("agent_start"); await f.tick(300000);
	assert.equal(f.requests.length, 0);
	await pi.command("on"); await f.tick(300000); assert.equal(f.requests.length, 1);
	await pi.emit("agent_settled"); await pi.emit("agent_start"); await f.tick(300000);
	assert.equal(f.requests.length, 2);
	pi.invalidate(); await f.tick(15000);
	assert.equal(f.files.size, 0); assert.equal(f.timers.size, 0);
});

test("bounded terminal summary input stays valid JSON and excludes other sessions",  async () => {
	const f = fixture(), sessions = [];
	for (let i = 0; i < 10; i++) {
		const pi = f.make(`session-${i}`); sessions.push(pi);
		await pi.start(); await pi.emit("agent_start");
		await pi.emit("tool_execution_start", { toolName: "bash", args: { command: "x".repeat(10000) } });
	}
	await sessions[0].command("now");
	const text = f.requests[0].context.messages[0].content[0].text;
	const json = text.match(/<observed-data>\n([\s\S]+)\n<\/observed-data>/)[1];
	assert.ok(json.length <= 2400);
	const facts = JSON.parse(json);
	assert.equal(facts.scope, "session");
	assert.equal(facts.observedSessions, 1); assert.equal(facts.activeSessions, 1);
	assert.equal(facts.phases["running bash"], 1);
	assert.equal(facts.sessions.length, 1);
	assert.equal(facts.sessions[0].id, "42-session-0");
	for (let i = 1; i < 10; i++) assert.ok(!text.includes(`42-session-${i}`));
	assert.equal(f.snapshotReads, 0);
	for (const pi of sessions) await pi.emit("session_shutdown");
});

test("attach during work and missed start events use live isIdle; long silence does not imply idle", async () => {
	const f = fixture(), pi = f.make("already-working");
	pi.setBusy(true); await pi.start();
	assert.equal(f.snapshots()[0].active, true);
	assert.equal(f.snapshots()[0].phase, "working");
	const activity = f.snapshots()[0].lastActivityAt;
	f.advance(60 * 60 * 1000); await f.tick(15000);
	assert.equal(f.snapshots()[0].active, true);
	assert.equal(f.snapshots()[0].lastActivityAt, activity);
	assert.equal(f.requests.length, 1, "elapsed wait can trigger a summary on the heartbeat checkpoint");
	await f.tick(60000); assert.equal(f.requests.length, 2);
	pi.setBusy(false); await f.tick(15000);
	assert.equal(f.snapshots()[0].active, false);
	pi.setBusy(true); await f.tick(15000);
	assert.equal(f.snapshots()[0].active, true, "heartbeat must recover a missed agent_start");
	await f.tick(60000); assert.equal(f.requests.length, 3);
	await pi.command("off"); await f.tick(15000); await f.tick(60000);
	assert.equal(f.requests.length, 3, "live reconciliation must respect automatic off");
	await pi.emit("session_shutdown");
});

test("process inventory remains available to WebUI but never enters terminal summary context",  async () => {
	const f = fixture(), pi = f.make("connected-idle");
	f.inventory([42, 99]); await pi.start();
	assert.deepEqual(Array.from(f.snapshots()[0].processInventory.pids), [42, 99]);
	await pi.command("now");
	const input = f.requests[0].context.messages[0].content[0].text;
	const facts = JSON.parse(input.match(/<observed-data>\n([\s\S]+)\n<\/observed-data>/)[1]);
	assert.equal(facts.activeSessions, 0);
	assert.equal(facts.scope, "session");
	assert.equal(facts.coverageVerified, undefined);
	assert.equal(facts.unobservedProcesses, undefined);
	assert.equal(facts.unobservedPids, undefined);
	assert.ok(!input.includes("processInventory"));
	assert.ok(input.includes("不汇报其他终端、会话或全机进程"));
	f.inventory([], Error("ps unavailable")); f.advance(15000); await f.tick(15000);
	assert.equal(f.snapshots()[0].processInventory, undefined);
	await pi.emit("session_shutdown");
});

test("local fallback reports only the current session even when other processes exist",  async () => {
	const f = fixture(true), pi = f.make("idle-fallback");
	f.inventory([42, 99]); await pi.start();
	const pending = pi.command("now"); await f.flush(); await f.tick(45000); await pending;
	const summary = JSON.parse([...f.files].find(([name]) => name.endsWith(".summary.json"))[1]);
	assert.equal(summary.scope, "session");
	assert.equal(summary.status, "error");
	assert.equal(summary.error, "timeout");
	assert.ok(summary.text.startsWith("任务摘要生成失败（超时）"));
	assert.ok(summary.text.endsWith("当前会话空闲。"));
	assert.ok(!summary.text.includes("进程"));
	await pi.emit("session_shutdown");
});

test("owning terminals and WebUI reuse the same per-session results, including failure, without viewer model calls", async () => {
	const f = fixture(), parent = f.make("shared-parent"), child = f.make("shared-child");
	await parent.start(); await child.start();
	await parent.emit("agent_start"); await child.emit("agent_start");
	f.respond({ content: [{ type: "text", text: "主会话正在修复共享摘要。" }] });
	await parent.command("now");
	f.respond(Error("mock-provider-sensitive-detail"));
	await child.command("now");
	assert.equal(f.requests.length, 2, "exactly one completion per self-summary");
	assert.equal(f.snapshotReads, 0, "neither terminal reads another session");
	let message, poll;
	const sent = [];
	const close = await webPlugin.activate({
		fs: {
			authorizedDirs: () => [], requestAccess: async () => true,
			listPath: async () => [...f.files.keys()].map((name) => ({ name: path.basename(name), type: "file" })),
			readTextPath: async (name) => [...f.files].find(([file]) => path.basename(file) === path.basename(name))[1],
		},
		get llm() { throw Error("WebUI must never access a model"); },
		onMessage: (handler) => { message = handler; return () => {}; },
		onAttach: () => () => {}, schedule: (_ms, callback) => { poll = callback; return () => {}; }, log: () => {},
		sendTo: (_id, payload) => sent.push(payload), broadcast: (payload) => sent.push(payload),
	});
	await message({ type: "observer-authorize" }, "viewer");
	const web = sent.at(-1);
	assert.equal(web.summaries.length, 2);
	for (const summary of web.summaries) {
		const saved = JSON.parse([...f.files].find(([name]) => name.endsWith(`${summary.id}.summary.json`))[1]);
		assert.deepEqual(summary, saved, "viewer returns the exact saved self-summary");
		const own = f.notifications.filter((notification) => notification.id === summary.id && notification.text === `Pi observer: ${summary.text}`);
		assert.equal(own.length, 1);
		assert.equal(own[0].text, `Pi observer: ${summary.text}`);
		assert.equal(own[0].type, summary.status === "error" ? "warning" : "info");
	}
	const failure = web.summaries.find((summary) => summary.id === "42-shared-child");
	assert.equal(failure.status, "error"); assert.equal(failure.error, "provider");
	assert.ok(!JSON.stringify(web).includes("mock-provider-sensitive-detail"));
	assert.ok(!f.notifications.find((notification) => notification.id === "42-shared-parent").text.includes("失败"));
	await message({ type: "observer-refresh" }, "viewer");
	poll(); await f.flush();
	assert.equal(f.requests.length, 2, "view refresh and polling never duplicate completions");
	await parent.command("off");
	assert.equal(f.snapshots().find((snapshot) => snapshot.id === "42-shared-parent").automaticReports, false);
	assert.ok(f.snapshots().every((snapshot) => snapshot.summaryScope === "session"));
	close(); await parent.emit("session_shutdown"); await child.emit("session_shutdown");
});

test("progress stays near the editor, starts after human wait thresholds, and cached replay does not call a model", async () => {
	const f = fixture(false, "5"), pi = f.make("ux", "tui");
	await pi.start(); await pi.emit("agent_start"); await f.tick(9000);
	assert.equal(f.panel("ux"), ""); assert.equal(f.requests.length, 0);
	await f.tick(1000); assert.ok(f.panel("ux").includes("已运行 10 秒"));
	await f.tick(50000); assert.equal(f.requests.length, 1);
	const original = f.panel("ux"); assert.ok(original.includes("Pi is thinking."));
	assert.equal(f.notifications.length, 0, "automatic TUI summaries update a persistent widget, not scrolling notifications");
	await pi.emit("tool_execution_start", { toolName: "bash", args: { command: "echo later output" } });
	await f.tick(15000); assert.ok(f.panel("ux").includes("Pi is thinking."), "later tool output must not replace the summary");
	await pi.command("last"); assert.equal(f.requests.length, 1);
	await f.tick(270000); assert.equal(f.requests.length, 1, "five-minute refresh limit starts at the previous request");
	await f.tick(15000); assert.equal(f.requests.length, 2);
	await pi.emit("agent_settled"); assert.equal(f.panel("ux"), "", "settled progress summaries hide instead of implying ongoing thought");
	await pi.command("last"); assert.ok(f.notifications.at(-1).text.includes("Pi is thinking."));
	assert.equal(f.panel("ux"), "");
	await pi.emit("agent_start"); assert.ok(!f.panel("ux").includes("Pi is thinking."), "new tasks do not inherit an old summary");
	await pi.command("off"); await f.tick(60000); assert.equal(f.panel("ux"), ""); assert.equal(f.requests.length, 2);
	await pi.emit("session_shutdown"); assert.equal(f.widgets.size, 0); assert.equal(f.timers.size, 0);
});

test("settlement and live idle hide only the owning progress panel while keeping summary cache and attention", async () => {
	const f = fixture(false, "5"), parent = f.make("hide-parent", "tui"), child = f.make("hide-child", "tui");
	await parent.start(); await child.start(); await parent.emit("agent_start"); await child.emit("agent_start");
	await parent.command("now"); await child.command("now");
	await child.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Task result." }] } });
	assert.ok(f.panel("hide-child"), "a message can still be followed by tools, recovery or queued work");
	await child.emit("agent_settled", { aborted: false });
	assert.equal(f.panel("hide-child"), ""); assert.ok(f.panel("hide-parent"));
	assert.equal(f.snapshots().find((s) => s.id === "42-hide-child").attention.reason, "reply");
	await child.command("last"); assert.equal(f.panel("hide-child"), ""); assert.equal(f.requests.length, 2);
	assert.ok(f.notifications.at(-1).text.includes("Pi is thinking."));
	parent.setBusy(false); await f.tick(15000);
	assert.equal(f.panel("hide-parent"), "", "missed settlement is reconciled via live isIdle");
	await child.command("now"); assert.equal(f.panel("hide-child"), "", "manual idle summaries finish as notification/cache, not persistent stale progress");
	await child.emit("agent_start"); await child.command("now"); await child.emit("agent_settled", { aborted: true });
	assert.equal(f.panel("hide-child"), "");
	assert.equal([...f.files.keys()].filter((name) => name.endsWith(".summary.json")).length, 2, "hiding is not deleting");
	await parent.emit("session_shutdown"); await child.emit("session_shutdown");
	assert.equal(f.files.size, 0); assert.equal(f.timers.size, 0);
});

test("visible text suppresses summaries but thinking and tool chatter do not; approval waits never trigger model calls", async () => {
	const f = fixture(false, "5"), pi = f.make("responsive", "tui");
	await pi.start(); await pi.emit("agent_start");
	for (let i = 0; i < 8; i++) {
		await pi.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "visible response" } });
		await f.tick(30000);
	}
	assert.equal(f.requests.length, 0);
	await pi.emit("ui_prompt_start", { title: "Confirm access", kind: "confirm" });
	assert.ok(f.panel("responsive").includes("需要你操作"));
	await f.tick(600000); assert.equal(f.requests.length, 0);
	await pi.emit("ui_prompt_end");
	await pi.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "hidden reasoning" } });
	await f.tick(60000); assert.equal(f.requests.length, 1);
	await pi.emit("session_shutdown");
});

test("resumed visible output cancels only automatic summaries; explicit manual summaries are not canceled by text streaming", async () => {
	const f = fixture(true, "5"), pi = f.make("resumed");
	await pi.start(); await pi.emit("agent_start"); await f.tick(60000);
	assert.equal(f.requests.length, 1);
	await pi.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "response resumed" } });
	assert.equal(f.requests[0].options.signal.aborted, true);
	assert.ok(![...f.files.keys()].some((name) => name.endsWith(".summary.json")), "canceled automatic result must not be published");
	assert.equal(f.snapshots()[0].active, true, "the observed task is never aborted");
	const manual = pi.command("now"); await f.flush();
	await pi.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "still responding" } });
	assert.equal(f.requests[1].options.signal.aborted, false);
	await pi.command("off"); await manual;
	await pi.emit("session_shutdown");
});

test("Observer menu, help, status and completions share actions and never call a model implicitly", async () => {
	const f = fixture(false, "0"), pi = f.make("commands", "tui");
	await pi.start(); await pi.command("");
	assert.equal(pi.menus.length, 1); assert.equal(f.requests.length, 0);
	assert.equal(pi.menus[0].options.length, 8);
	assert.ok(pi.menus[0].options.find((option) => option.startsWith("/observer now")).includes("可能计费"));
	const values = Array.from(pi.complete(""), (item) => item.value);
	assert.deepEqual(values, ["status", "web", "last", "now", "on", "off", "ack", "help"]);
	assert.equal(pi.complete("zz"), null);
	assert.deepEqual(Array.from(pi.complete("n"), (item) => item.value), ["now"]);
	await pi.command("help"); await pi.command("status"); await pi.command("last"); await pi.command("invalid");
	assert.equal(f.requests.length, 0, "help, typos and cache misses must not fall through to a model");
	assert.ok(f.notifications.some((notification) => notification.text.includes("必须带 /")));
	assert.ok(f.notifications.some((notification) => notification.text.includes("尚无缓存")));
	assert.ok(f.notifications.some((notification) => notification.text.includes("未知 Observer 操作")));
	pi.choose("now"); await pi.command(""); assert.equal(f.requests.length, 1);
	assert.ok(f.notifications.some((notification) => notification.text.includes("正在生成本会话摘要")));
	await pi.command("last"); assert.equal(f.requests.length, 1);
	await pi.emit("session_shutdown");
	const rpc = f.make("rpc-help"); await rpc.start(); await rpc.command("");
	assert.equal(rpc.menus.length, 0); assert.equal(f.requests.length, 1);
	await rpc.emit("session_shutdown");
});

test("local task summaries wrap across a bounded panel, preserve text, and offer full cached text on narrow terminals", async () => {
	const f = fixture(false, "0"), pi = f.make("expanded", "tui");
	const text = "正在定位状态同步的原因，并核验当前会话与子会话的身份。".repeat(4) + "即将完成回归验证。";
	f.respond({ content: [{ type: "text", text: `\x1b[31m${text}\x1b[0m` }] });
	await pi.start(); await pi.emit("agent_start"); await pi.command("now");
	const normal = f.panel("expanded", 60).split("\n");
	assert.ok(normal.length > 2 && normal.length <= 6);
	assert.equal(normal.slice(1, -1).join(""), text, "body uses available lines instead of cutting the entire summary to one line");
	assert.ok(normal[0].includes("Pi 进度")); assert.ok(normal.at(-1).includes("最近摘要"));
	assert.ok(!normal.join("").includes("\x1b"));
	const narrow = f.panel("expanded", 28, 16).split("\n");
	assert.ok(narrow.length <= 4 && narrow.every((line) => Array.from(line).length <= 28));
	assert.ok(narrow.at(-1).includes("/observer last"));
	await pi.command("last"); assert.equal(f.requests.length, 1);
	assert.ok(f.notifications.at(-1).text.includes(text));
	assert.equal(f.panel("expanded", 0), "");
	await pi.emit("session_shutdown");
});

test("web menu and shortcut open only a verified local WebUI, never launch models/services, and fail explicitly", async () => {
	const f = fixture(false, "0"), pi = f.make("web", "tui");
	await pi.start(); pi.choose("web"); await pi.command("");
	assert.equal(f.browserRequests.length, 1);
	assert.equal(f.browserRequests[0].command, "open");
	assert.deepEqual(f.browserRequests[0].args, ["http://127.0.0.1:8787/"]);
	assert.equal(f.webRequests[0].options.redirect, "error");
	assert.equal(f.browserRequests[0].options.timeout, 5000);
	assert.ok(f.notifications.at(-1).text.includes("按网页提示授权"));
	f.port("9123"); f.platform("linux"); await pi.command("web");
	assert.equal(f.browserRequests.at(-1).command, "xdg-open");
	assert.equal(f.browserRequests.at(-1).args[0], "http://127.0.0.1:9123/");
	f.platform("win32"); await pi.command("web");
	assert.equal(f.browserRequests.at(-1).command, "rundll32.exe");
	f.opener(1); await pi.command("web"); assert.ok(f.notifications.at(-1).text.includes("手动访问"));
	const before = f.browserRequests.length;
	f.health(new Error("refused")); await pi.command("web");
	assert.equal(f.browserRequests.length, before); assert.ok(f.notifications.at(-1).text.includes("/webui"));
	f.health({ ok: true, engine: "unrelated" }); await pi.command("web"); assert.equal(f.browserRequests.length, before);
	f.port("8787;echo unsafe"); const probes = f.webRequests.length; await pi.command("web");
	assert.equal(f.webRequests.length, probes); assert.equal(f.browserRequests.length, before);
	f.port("8787"); f.health({ ok: true, engine: "pi", piVersion: "fixture" });
	const rpc = f.make("remote-web"); await rpc.start(); await rpc.command("web");
	assert.equal(f.browserRequests.length, before, "RPC returns a URL instead of opening a browser on the server");
	assert.equal(f.requests.length, 0);
	await rpc.emit("session_shutdown"); await pi.emit("session_shutdown");
});

test("manual summaries immediately show progress even when idle, and repeated requests get explicit feedback", async () => {
	const f = fixture(true, "0"), pi = f.make("idle-manual", "tui");
	await pi.start(); const pending = pi.command("now"); await f.flush();
	assert.ok(f.panel("idle-manual").includes("正在生成进度摘要"));
	assert.ok(f.notifications.some((notification) => notification.text.includes("最多等待 45 秒")));
	await pi.command("now"); assert.equal(f.requests.length, 1);
	assert.ok(f.notifications.some((notification) => notification.text.includes("已有摘要正在生成")));
	await pi.command("status"); assert.ok(f.notifications.at(-1).text.includes("生成中"));
	await pi.command("off"); await pending;
	assert.ok(f.notifications.some((notification) => notification.text.includes("本次摘要已取消")));
	await pi.emit("session_shutdown");
});

test("automatic compaction freezes work time and summary deadlines, including failure and cancellation; manual compaction is not subtracted", async () => {
	const f = fixture(false, "5"), pi = f.make("compaction", "tui");
	await pi.start(); await pi.emit("agent_start"); await f.tick(30000);
	const controller = new AbortController();
	await pi.emit("session_before_compact", { reason: "threshold", signal: controller.signal });
	await f.tick(600000);
	assert.equal(f.requests.length, 0); assert.equal(f.snapshots()[0].workElapsedMs, 30000);
	assert.ok(f.panel("compaction").includes("工作计时暂停"));
	await pi.command("now"); assert.equal(f.requests.length, 0);
	await pi.emit("session_compact_failed", { reason: "threshold", aborted: false });
	assert.equal(f.snapshots()[0].compaction.excludedMs, 600000);
	await f.tick(15000); assert.equal(f.requests.length, 0);
	await f.tick(15000); assert.equal(f.requests.length, 1);
	const next = new AbortController();
	await pi.emit("session_before_compact", { reason: "overflow", signal: next.signal });
	f.advance(120000); next.abort(); await f.flush();
	await pi.emit("session_compact_failed", { reason: "overflow", aborted: true });
	assert.equal(f.snapshots()[0].compaction.excludedMs, 720000, "abort and failed event count the interval only once");
	await pi.emit("session_before_compact", { reason: "manual", signal: new AbortController().signal });
	await f.tick(15000); assert.equal(f.snapshots()[0].compaction.excludedMs, 720000);
	await pi.emit("agent_settled"); const stopped = f.snapshots()[0].workElapsedMs;
	await f.tick(15000); assert.equal(f.snapshots()[0].workElapsedMs, stopped, "idle waiting is not working time");
	await pi.emit("session_shutdown");
});

test("attention belongs to a run/session, persists after completion, acknowledges without starting work, and ignores Observer's own menu", async () => {
	const f = fixture(false, "0"), pi = f.make("attention", "tui");
	await pi.start(); assert.equal(f.snapshots()[0].attention, undefined);
	await pi.emit("agent_start"); await pi.command("");
	assert.equal(f.snapshots()[0].attention, undefined, "Observer's own menu is not an Agent approval request");
	await pi.emit("ui_prompt_start", { title: "Confirm access", kind: "confirm" });
	assert.equal(f.snapshots()[0].attention.reason, "approval");
	await pi.emit("ui_prompt_end"); assert.equal(f.snapshots()[0].attention, undefined);
	await pi.emit("agent_settled", { aborted: false });
	const first = f.snapshots()[0].attention;
	assert.equal(first.reason, "reply");
	await pi.command("ack"); assert.ok(f.snapshots()[0].attention.acknowledgedAt);
	assert.equal(f.snapshots()[0].active, false); assert.equal(f.requests.length, 0);
	await pi.emit("agent_start"); assert.equal(f.snapshots()[0].attention, undefined);
	await pi.emit("message_end", { message: { role: "assistant", content: [], stopReason: "error" } });
	await pi.emit("agent_settled", { aborted: false });
	assert.equal(f.snapshots()[0].attention.reason, "error");
	await pi.emit("agent_start"); await pi.emit("agent_settled", { aborted: true });
	assert.equal(f.snapshots()[0].attention, undefined, "user cancellation must not become a successful completion alert");
	assert.ok(f.signals.filter((signal) => signal.channel === "observer:attention").every((signal) => signal.data.id === "42-attention"));
	await pi.emit("session_shutdown");
});

test("empty or failed provider responses are labeled as failed summaries, not successful task descriptions", async () => {
	for (const [response, category] of [
		[{ content: [], stopReason: "stop" }, "empty-response"],
		[{ content: [{ type: "text", text: "partial failed output" }], stopReason: "error" }, "provider"],
	]) {
		const f = fixture(), pi = f.make(category);
		await pi.start(); f.respond(response); await pi.command("now");
		const saved = JSON.parse([...f.files].find(([name]) => name.endsWith(".summary.json"))[1]);
		assert.equal(saved.status, "error"); assert.equal(saved.error, category);
		assert.ok(saved.text.includes("以下仅为活动状态"));
		assert.ok(!saved.text.includes("partial failed output"));
		await pi.emit("session_shutdown");
	}
});
