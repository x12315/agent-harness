import assert from "node:assert/strict";
import { basename } from "node:path";
import { test } from "node:test";
import plugin from "./index.mjs";

test("WebUI overview aggregates all sessions, not the last terminal summary", async () => {
	const now = new Date().toISOString();
	const files = new Map([
		["main.snapshot.json", { id: "main", pid: 42, active: false, phase: "idle", updatedAt: now, processInventory: { checkedAt: now, pids: [42, 43, 99] } }],
		["child.snapshot.json", { id: "child", pid: 43, active: true, phase: "running bash", updatedAt: now }],
		["main.summary.json", { id: "main", scope: "session", text: "当前会话空闲。", reportedAt: now }],
		["child.summary.json", { id: "child", scope: "session", text: "子会话正在构建。", reportedAt: now }],
		["legacy.summary.json", { id: "child", text: "Legacy unscoped summary", reportedAt: now }],
	]);
	let message;
	const sent = [];
	const host = {
		fs: {
			authorizedDirs: () => [], requestAccess: async () => true,
			listPath: async () => [...files.keys()].map((name) => ({ name, type: "file" })),
			readTextPath: async (path) => JSON.stringify(files.get(basename(path))),
		},
		onMessage: (handler) => { message = handler; return () => {}; },
		onAttach: () => () => {}, schedule: () => () => {}, log: () => {},
		sendTo: (_id, payload) => sent.push(payload), broadcast: () => {},
	};
	const close = await plugin.activate(host);
	await message({ type: "observer-authorize" }, "browser");
	const state = sent.at(-1);
	assert.equal(state.snapshots.length, 2);
	assert.equal(state.summary.scope, "global");
	assert.ok(state.summary.text.includes("2 个会话，1 个正在工作"));
	assert.ok(state.summary.text.includes("running bash：1"));
	assert.ok(state.summary.text.includes("1 个 Pi 进程未接入，状态未知"));
	assert.notEqual(state.summary.text, "当前会话空闲。");
	assert.equal(state.summaries.length, 2);
	assert.ok(!state.summaries.some((summary) => summary.text.includes("Legacy")));
	close();
});
