import assert from "node:assert/strict";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = stripTypeScriptTypes(readFileSync(new URL("../../adapters/pi/extensions/iterm-bell.ts", import.meta.url), "utf8"))
	.replace(/^import .*;\n/gm, "").replace("export default function", "function bell") + "\nbell;";

test("pane reminders persist, route by session identity, ring once, acknowledge without controlling agents, and retain legacy fallback", async () => {
	const listeners = new Map(), output = [];
	const bus = { on: (channel, handler) => { const set = listeners.get(channel) || new Set(); set.add(handler); listeners.set(channel, set); return () => set.delete(handler); }, emit: (channel, data) => { for (const handler of listeners.get(channel) || []) handler(data); } };
	const runtimeGlobals = {};
	const load = () => runInNewContext(source, { globalThis: runtimeGlobals, path, stripVTControlCharacters, truncateToWidth: (text, width) => text.slice(0, width), process: { pid: 42, stdout: { isTTY: true, write: (value) => output.push(value) }, env: { TERM_PROGRAM: "iTerm.app" } } });
	const make = (name, mode = "tui") => {
		const events = new Map(), widgets = new Map(), status = new Map();
		load()({ events: bus, on: (name, handler) => events.set(name, handler) });
		const ctx = { mode, sessionManager: { getSessionId: () => name }, ui: { setWidget: (key, value) => value ? widgets.set(key, value) : widgets.delete(key), setStatus: (key, value) => value ? status.set(key, value) : status.delete(key) } };
		return { widgets, status, emit: (name, event = {}) => events.get(name)(event, ctx) };
	};
	const parent = make("parent"), child = make("child"), rpc = make("rpc", "rpc");
	parent.emit("session_start"); child.emit("session_start"); rpc.emit("session_start");
	const signal = { schemaVersion: 1, id: "42-child", workspace: "/work/project", attention: { id: "run-1:reply", reason: "reply" } };
	bus.emit("observer:attention", signal); bus.emit("observer:attention", signal);
	assert.equal(output.length, 1); assert.equal(parent.widgets.size, 0); assert.equal(child.widgets.size, 1);
	const lines = child.widgets.get("observer-attention")({}, { fg: (_color, text) => text }).render(200).join(" ");
	assert.ok(lines.includes("42-child")); assert.ok(lines.includes("等待下一步"));
	child.emit("agent_settled", { aborted: false }); assert.equal(output.length, 1, "Observer integration must disable duplicate legacy bells");
	bus.emit("observer:attention", { ...signal, attention: { ...signal.attention, acknowledgedAt: "now" } });
	assert.equal(child.widgets.size, 0); assert.equal(child.status.size, 0); assert.equal(output.length, 1);
	bus.emit("observer:attention", { ...signal, attention: null });
	bus.emit("observer:attention", { ...signal, attention: { id: "run-2:approval", reason: "approval" } });
	assert.equal(output.length, 2);
	bus.emit("observer:attention", { ...signal, id: "42-rpc" }); assert.equal(output.length, 2);
	parent.emit("agent_settled", { aborted: true }); assert.equal(output.length, 2);
	parent.emit("agent_settled", { aborted: false }); assert.equal(output.length, 3, "uninstrumented legacy session preserves the original bell");
	child.emit("session_shutdown", { reason: "reload" });
	const reloaded = make("child");
	reloaded.emit("session_start", { reason: "reload" });
	bus.emit("observer:attention", { ...signal, attention: { id: "run-2:approval", reason: "approval" } });
	assert.equal(output.length, 3, "reload must not ring again for the same unread attention");
	assert.equal(reloaded.widgets.size, 1, "unread widget must still return after reload");
	bus.emit("observer:attention", { ...signal, attention: { id: "run-3:reply", reason: "reply" } });
	assert.equal(output.length, 4, "a genuinely new attention still rings");
	for (const session of [parent, reloaded, rpc]) session.emit("session_shutdown");
	assert.ok([...listeners.values()].every((set) => set.size === 0));
});
