import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import view from "./entry.mjs";

class Element {
	children = [];
	style = {};
	textContent = "";
	listeners = {};
	constructor(tag) { this.tag = tag; }
	append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
	replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
	addEventListener(name, callback) { this.listeners[name] = callback; }
	remove() { this.parent.children = this.parent.children.filter((node) => node !== this); }
	get text() { return this.textContent + this.children.map((child) => child.text).join(" "); }
}

test("directory-specific remember checkbox is opt-in, survives polling, and saves only with explicit approval", () => {
	const previous = globalThis.document;
	globalThis.document = { createElement: (tag) => new Element(tag) };
	try {
		const root = new Element("div"), sent = []; let update;
		const close = view.mount(root, { send: (payload) => sent.push(payload), onData: (handler) => { update = handler; return () => {}; } });
		const find = (node, predicate) => predicate(node) ? node : node.children.map((child) => find(child, predicate)).find(Boolean);
		const checkbox = () => find(root, (node) => node.type === "checkbox");
		assert.equal(checkbox().checked, false); assert.equal(checkbox().disabled, true);
		const state = { type: "observer-state", directory: "/owned-fixture/observer", authorized: false, rememberAccess: false, snapshots: [] };
		update(state); assert.equal(checkbox().disabled, false);
		checkbox().checked = true; checkbox().listeners.change();
		assert.deepEqual(sent, [{ type: "observer-get" }], "checking alone must not approve access");
		update(state); assert.equal(checkbox().checked, true, "background status polling must not erase an unsent checkbox choice");
		find(root, (node) => node.textContent === "Allow read access").listeners.click();
		assert.deepEqual(sent.at(-1), { type: "observer-authorize", remember: true });
		update({ ...state, authorized: true, rememberAccess: true });
		assert.equal(checkbox().checked, true); assert.ok(root.text.includes("/owned-fixture/observer"));
		checkbox().checked = false; checkbox().listeners.change();
		assert.deepEqual(sent.at(-1), { type: "observer-remember-access", remember: false });
		update({ ...state, authorized: true, rememberAccess: false }); assert.equal(checkbox().checked, false);
		update({ ...state, directory: "/different/observer" }); assert.equal(checkbox().checked, false, "choices never transfer to another directory");
		update({ ...state, error: "无法保存记忆选项" }); assert.ok(root.text.includes("无法保存记忆选项"));
		close(); assert.equal(root.children.length, 0);
	} finally { globalThis.document = previous; }
});

test("top-level Observer view uses a self-contained client and renders multiple processes after authorization", () => {
	const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url)));
	assert.equal(manifest.ui["topbar.primary"][0].view, "plugin:pi-observer");
	assert.deepEqual(manifest.permissions, ["fs:read", "ui"]);
	const previous = globalThis.document;
	globalThis.document = { createElement: (tag) => new Element(tag) };
	try {
		const container = new Element("div");
		let update;
		let unsubscribed = false;
		const sent = [];
		const cleanup = view.mount(container, {
			send: (payload) => sent.push(payload),
			onData: (handler) => { update = handler; return () => { unsubscribed = true; }; },
		});
		assert.ok(container.text.includes("Allow read access"));
		assert.ok(!container.text.includes("not connected"), "no process metadata before authorization");
		assert.deepEqual(sent, [{ type: "observer-get" }]);
		update({ type: "observer-state", authorized: true, snapshots: [
			{ pid: 10, cwd: "/main", active: true, phase: "thinking", lastAssistantText: "RAW_AGENT_OUTPUT_DO_NOT_SHOW" },
			{ pid: 20, cwd: "/child", active: true, phase: "running read", lastTool: "read" },
		], summary: { scope: "global", text: "Two agents are working." } });
		assert.ok(container.text.includes("2 observed sessions · 2 processes · 2 active"));
		for (const value of ["10", "20", "/main", "/child", "Two agents are working."]) assert.ok(container.text.includes(value));
		assert.equal(container.children[0].tag, "style");
		assert.ok(container.text.includes("尚未生成本会话的任务摘要"));
		assert.ok(!container.text.includes("RAW_AGENT_OUTPUT_DO_NOT_SHOW"), "raw agent replies must never masquerade as summaries");
		update({ type: "observer-state", authorized: true, snapshots: [
			{ id: "parent", pid: 10, cwd: "/memory-parent", active: true, phase: "thinking" },
			{ id: "child", pid: 10, cwd: "/memory-child", active: true, phase: "thinking" },
		] });
		assert.ok(container.text.includes("2 observed sessions · 1 process · 2 active"));
		for (const value of ["parent", "child", "/memory-parent", "/memory-child"]) assert.ok(container.text.includes(value));
		assert.ok(container.text.includes("other Pi agents may still be working"));
		update({ type: "observer-state", authorized: true, snapshots: [
			{ id: "parent", pid: 10, active: false, phase: "idle" },
			{ id: "child", pid: 20, active: true, phase: "thinking" },
		], summary: { scope: "global", text: "One of two sessions is working." }, summaries: [
			{ scope: "session", id: "parent", text: "Parent alone is idle." },
			{ scope: "session", id: "child", text: "Child alone is working." },
		] });
		assert.ok(container.text.includes("Overall status"));
		assert.ok(container.text.includes("One of two sessions is working."));
		const find = (node, className) => node.className === className ? [node] : node.children.flatMap((child) => find(child, className));
		const cards = find(container, "session ");
		assert.equal(cards.length, 1);
		assert.ok(!cards[0].text.includes("Parent alone is idle."));
		assert.ok(cards[0].text.includes("等待输入"));
		assert.equal(find(cards[0], "details").length, 0, "idle cards contain no activity or historical tool detail");
		assert.ok(!cards[0].text.includes("生成于"));
		assert.ok(container.text.includes("Child alone is working."), "active sibling keeps its own progress summary");
		assert.ok(!cards[0].text.includes("Child alone is working."));
		update({ type: "observer-state", authorized: true, snapshots: [
			{ id: "parent", pid: 10, active: true, phase: "thinking", summaryScope: "session", automaticReports: false },
			{ id: "child", pid: 10, active: true, phase: "failed bash", lastTool: "bash", lastToolError: true, summaryScope: "session" },
			{ id: "old", pid: 20, active: true, phase: "thinking" },
			{ id: "previous", pid: 30, active: true, phase: "thinking", runStartedAt: new Date().toISOString() },
		], summaries: [{ id: "child", scope: "session", status: "error", text: "任务摘要生成失败（模型请求失败）", reportedAt: new Date().toISOString() },
			{ id: "previous", scope: "session", text: "Older task summary.", reportedAt: new Date(Date.now() - 60000).toISOString() }] });
		assert.ok(container.text.includes("自动摘要已关闭"));
		assert.ok(container.text.includes("持续无文字回复约一分钟后首次生成"));
		assert.ok(container.text.includes("尚未上报摘要设置"));
		assert.ok(container.text.includes("最近工具执行失败：bash"));
		assert.ok(!container.text.includes("Older task summary."), "a new run must not redisplay a prior run's thinking summary");
		const failed = find(container, "summary-text error");
		assert.equal(failed.length, 1);
		assert.ok(failed[0].parent.text.includes("child"));
		assert.ok(!failed[0].parent.text.includes("parent"), "failure belongs to its own session, even with shared PID");
		update({ type: "observer-state", authorized: true, snapshots: [
			{ id: "pane-A", pid: 10, active: false, phase: "idle", cwd: "/workspace/A", terminal: { pane: "w0t0p0:fixture-A" }, attention: { reason: "reply", since: new Date().toISOString(), acknowledgedAt: new Date().toISOString() }, runStartedAt: new Date().toISOString(), workElapsedMs: 42000, compaction: { active: false, excludedMs: 120000 } },
			{ id: "pane-B", pid: 20, active: true, phase: "compacting", runStartedAt: new Date().toISOString(), workElapsedMs: 7000, compaction: { active: true, excludedMs: 0 } },
		] });
		for (const value of ["待你处理 · 1 个会话", "pane-A", "已读，仍待处理", "w0t0p0:fixture-A", "工作计时暂停", "Compacting"]) assert.ok(container.text.includes(value), value);
		for (const value of ["工作耗时约 42 秒", "已排除自动压缩 120 秒"]) assert.ok(!container.text.includes(value), "idle work time is not displayed");
		update({ type: "observer-state", authorized: true, snapshots: [
			{ id: "idle", pid: 10, active: false, phase: "STALE_THINKING_PHASE", attention: { reason: "reply", since: new Date().toISOString() } },
		], summaries: [{ id: "idle", scope: "session", text: "STALE_THINKING_SUMMARY" }], coverage: { verified: true, unobservedPids: [99] } });
		assert.ok(!container.text.includes("STALE_THINKING_PHASE"));
		assert.ok(!container.text.includes("STALE_THINKING_SUMMARY"));
		assert.ok(container.text.includes("等待输入"));
		assert.ok(container.text.includes("待你处理 · 1 个会话"), "hiding stale progress never hides the settlement reminder");
		assert.ok(container.text.includes("Activity is unknown, not idle"));
		assert.ok(container.text.includes("Pi process 99 Unknown"));
		assert.ok(container.text.includes("1 observed session · 1 process · 0 active"));
		assert.ok(container.text.includes("Do not interrupt ongoing work"));
		cleanup();
		assert.equal(unsubscribed, true);
		assert.equal(container.children.length, 0);
	} finally { globalThis.document = previous; }
});

test("idle cards only await input, omit all timers and stale details across polls, and preserve data and reminders", () => {
	const previous = globalThis.document, realNow = Date.now;
	globalThis.document = { createElement: (tag) => new Element(tag) };
	try {
		const root = new Element("div"), sent = []; let update;
		const cleanup = view.mount(root, { send: (payload) => sent.push(payload), onData: (handler) => { update = handler; return () => {}; } });
		const time = new Date(realNow() - 60000).toISOString();
		const snapshot = Object.freeze({ id: "idle", pid: 10, active: false, phase: "STALE_THINKING", cwd: "/workspace/idle", lastActivityAt: time, lastTool: "OLD_TOOL", lastToolError: true, automaticReports: false, runStartedAt: time, workElapsedMs: 42000, compaction: Object.freeze({ active: false, excludedMs: 120000 }), attention: Object.freeze({ reason: "reply", since: time, acknowledgedAt: time }) });
		const summary = Object.freeze({ id: "idle", scope: "session", text: "CACHED_SUMMARY", reportedAt: time });
		const state = Object.freeze({ type: "observer-state", authorized: true, snapshots: Object.freeze([snapshot]), summaries: Object.freeze([summary]) });
		const find = (node, className) => node.className === className ? [node] : node.children.flatMap((child) => find(child, className));
		let idleText;
		for (const elapsed of [0, 60000, 3600000]) {
			Date.now = () => realNow() + elapsed;
			update(state);
			const card = find(root, "session ")[0];
			assert.ok(card.text.includes("等待输入"));
			assert.equal(card.title, "Session idle · PID 10");
			assert.equal(find(card, "details").length, 0);
			assert.equal(find(card, "summary-time").length, 0);
			for (const value of ["工作耗时", "Activity", "Latest tool", "OLD_TOOL", "自动摘要已关闭", "STALE_THINKING", "CACHED_SUMMARY", "ago"]) assert.ok(!root.text.includes(value), value);
			if (idleText) assert.equal(card.text, idleText, "idle card never starts counting with wall clock or polling");
			idleText = card.text;
			assert.ok(root.text.includes("待你处理 · 1 个会话"));
			assert.ok(root.text.includes("已读，仍待处理"));
		}
		assert.equal(snapshot.workElapsedMs, 42000); assert.equal(state.summaries[0], summary);
		assert.deepEqual(sent, [{ type: "observer-get" }], "rendering never requests summaries or controls the agent");
		update({ ...state, snapshots: [{ ...snapshot, active: true }] });
		for (const value of ["CACHED_SUMMARY", "工作耗时约 42 秒", "Activity", "OLD_TOOL"]) assert.ok(root.text.includes(value), value);
		update({ ...state, snapshots: [{ ...snapshot, compaction: { active: true, excludedMs: 120000 } }] });
		assert.ok(root.text.includes("自动压缩中")); assert.ok(root.text.includes("工作计时暂停"));
		assert.ok(!find(root, "session ")[0].text.includes("等待输入"), "compaction is not idle settlement");
		cleanup();
	} finally { globalThis.document = previous; Date.now = realNow; }
});
