import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import view from "./entry.mjs";

class Element {
	children = [];
	style = {};
	textContent = "";
	listeners = {};
	attributes = {};
	constructor(tag) { this.tag = tag; }
	append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
	replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
	addEventListener(name, callback) { this.listeners[name] = callback; }
	setAttribute(name, value) { this.attributes[name] = String(value); }
	getAttribute(name) { return this.attributes[name]; }
	remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
	get text() { return this.textContent + this.children.map((child) => child.text).join(" "); }
}

const flatten = (node, predicate, found = []) => {
	if (predicate(node)) found.push(node);
	for (const child of node.children) flatten(child, predicate, found);
	return found;
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

const runningTask = {
	subjectId: "coordinator:task-7",
	kind: "webui-task",
	workspace: "/workspace/coord",
	phase: "running",
	active: true,
	stale: true,
	ageMs: 125_000,
	tool: "bash",
	progress: "running tests",
	gap: "缺少验证证据",
	attention: { reason: "input-required" },
	objective: "完成响应式协调界面",
	summary: "still working",
	taskRef: { owner: "coordinator", taskId: "task-7", revision: 3 },
	provenance: { source: "webui-task", authoritative: "coordinator" },
};

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
	assert.deepEqual(manifest.permissions, ["fs:read", "ui", "http"]);
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

test("merged run section renders task facts, discrepancies, and no controls when capability has no actions", () => {
	const previous = globalThis.document;
	globalThis.document = { createElement: (tag) => new Element(tag) };
	try {
		const root = new Element("div"); let update;
		const close = view.mount(root, { send: () => {}, onData: (handler) => { update = handler; return () => {}; } });
		update({ type: "observer-state", authorized: true, snapshots: [], frames: [runningTask], discrepancies: [
			{ code: "stale-fact", subjectId: "coordinator:task-7", detail: "事实已过期，不能视为当前状态。" },
		], capability: { schemaVersion: "observer.capability/1", actions: [], freshnessMs: 90000 } });
		for (const value of ["运行与任务 · 1", "协调任务", "完成响应式协调界面", "/workspace/coord", "进行中", "2m 前", "已过期", "工具：bash", "进展：running tests", "缺口：缺少验证证据", "需要注意：input-required", "coordinator#task-7@3", "需要核对 · 1", "stale-fact", "事实已过期，不能视为当前状态。", "不自动处理"]) assert.ok(root.text.includes(value), value);
		const buttons = flatten(root, (node) => node.tag === "button");
		assert.ok(!buttons.some((button) => ["暂停", "继续", "取消"].includes(button.textContent)), "empty capability authorizes no control affordance");
		update({ type: "observer-state", authorized: true, snapshots: [], frames: [{ ...runningTask, objective: undefined, summary: undefined, gap: undefined }], tasks: [
			{ owner: "coordinator", taskId: "task-7", revision: 3, objective: "来自任务事实的目标", gap: "事实中的缺口" },
		], capability: { actions: [] } });
		assert.ok(root.text.includes("来自任务事实的目标"), "task facts supply the objective when the frame omits it");
		assert.ok(root.text.includes("事实中的缺口"));
		update({ type: "observer-state", authorized: true, snapshots: [], frames: [{ ...runningTask, phase: "verified" }], capability: { actions: ["pause", "resume", "cancel"] } });
		assert.ok(!flatten(root, (node) => node.tag === "button").some((button) => ["暂停", "继续", "取消"].includes(button.textContent)), "terminal task hides controls");
		close();
	} finally { globalThis.document = previous; }
});

test("pause POST carries the task reference and expected revision, then polling reports queued followed by applied", async () => {
	const previousDocument = globalThis.document, realFetch = globalThis.fetch, realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
	globalThis.document = { createElement: (tag) => new Element(tag) };
	const calls = [];
	const pending = new Map();
	let nextTimer = 0;
	let pollCount = 0;
	globalThis.fetch = async (url, init = {}) => {
		calls.push({ url, init });
		if (init.method === "POST") return { ok: true, status: 202, json: async () => ({ state: "queued", detail: "已受理" }) };
		pollCount += 1;
		return { ok: true, status: 200, json: async () => pollCount === 1
			? { state: "queued", detail: "排队中：owner 尚未处理" }
			: { state: "applied", detail: "已执行暂停" } };
	};
	globalThis.setTimeout = (callback) => { const id = ++nextTimer; pending.set(id, callback); return id; };
	globalThis.clearTimeout = (id) => { cleared.push(id); pending.delete(id); };
	try {
		const root = new Element("div"); let update;
		const close = view.mount(root, { send: () => {}, onData: (handler) => { update = handler; return () => {}; } });
		update({ type: "observer-state", authorized: true, snapshots: [], frames: [runningTask], capability: { actions: ["pause", "resume", "cancel"], freshnessMs: 90000 } });
		const pause = flatten(root, (node) => node.tag === "button" && node.textContent === "暂停")[0];
		assert.ok(pause);
		assert.equal(pause.getAttribute("aria-label"), "暂停任务 task-7");
		await pause.listeners.click();
		await settle();
		assert.equal(pause.disabled, true, "controls are disabled while a command is pending");
		assert.ok(root.text.includes("排队中"));
		assert.ok(root.text.includes("已受理"));
		const post = calls[0];
		const body = JSON.parse(post.init.body);
		assert.equal(post.url, "/plugins-api/pi-observer/control");
		assert.equal(post.init.method, "POST");
		assert.equal(post.init.headers["content-type"], "application/json");
		assert.equal(body.consumerId, "observer-ui");
		assert.equal(body.action, "pause");
		assert.deepEqual(body.target.taskRef, { owner: "coordinator", taskId: "task-7", revision: 3 });
		assert.equal(body.expectedRevision, 3);
		assert.equal(typeof body.commandId, "string");
		assert.deepEqual(Object.keys(body), ["commandId", "consumerId", "action", "target", "expectedRevision"]);
		assert.equal(calls.length, 1, "no optimistic poll before the POST resolves");
		assert.equal(pending.size, 1);
		const firstPoll = [...pending.values()][0];
		pending.clear();
		await firstPoll();
		await settle();
		assert.equal(calls[1].url, `/plugins-api/pi-observer/control?id=${body.commandId}`);
		assert.ok(root.text.includes("排队中：owner 尚未处理"));
		assert.ok(!root.text.includes("已生效"), "a queued command is never displayed as applied");
		assert.equal(pending.size, 1);
		const secondPoll = [...pending.values()][0];
		pending.clear();
		await secondPoll();
		await settle();
		assert.ok(root.text.includes("已生效"));
		assert.ok(root.text.includes("已执行暂停"));
		assert.equal(pause.disabled, false);
		assert.equal(pending.size, 0);
		close();
	} finally {
		globalThis.document = previousDocument;
		globalThis.fetch = realFetch;
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
});

test("control POST failure is reported without automatic retry", async () => {
	const previousDocument = globalThis.document, realFetch = globalThis.fetch, realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
	globalThis.document = { createElement: (tag) => new Element(tag) };
	let attempts = 0;
	const pending = new Map();
	globalThis.fetch = async () => { attempts += 1; throw new Error("network down"); };
	globalThis.setTimeout = (callback) => { const id = pending.size + 1; pending.set(id, callback); return id; };
	globalThis.clearTimeout = (id) => pending.delete(id);
	try {
		const root = new Element("div"); let update;
		const close = view.mount(root, { send: () => {}, onData: (handler) => { update = handler; return () => {}; } });
		update({ type: "observer-state", authorized: true, snapshots: [], frames: [runningTask], capability: { actions: ["pause"] } });
		const pause = flatten(root, (node) => node.tag === "button" && node.textContent === "暂停")[0];
		await pause.listeners.click();
		await settle();
		assert.equal(attempts, 1);
		assert.equal(pending.size, 0, "a failed POST schedules no retry timer");
		assert.ok(root.text.includes("提交失败"));
		assert.ok(root.text.includes("未自动重试"));
		assert.equal(pause.disabled, false, "the user can deliberately retry after a failure");
		close();
	} finally {
		globalThis.document = previousDocument;
		globalThis.fetch = realFetch;
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
});

test("dispose clears pending control polling and ignores the detached callback", async () => {
	const previousDocument = globalThis.document, realFetch = globalThis.fetch, realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
	globalThis.document = { createElement: (tag) => new Element(tag) };
	const calls = [];
	const pending = new Map();
	const cleared = [];
	let nextTimer = 0;
	globalThis.fetch = async (url, init = {}) => {
		calls.push({ url, init });
		return { ok: true, status: 200, json: async () => ({ state: "queued", detail: "等待执行" }) };
	};
	globalThis.setTimeout = (callback) => { const id = ++nextTimer; pending.set(id, callback); return id; };
	globalThis.clearTimeout = (id) => { cleared.push(id); pending.delete(id); };
	try {
		const root = new Element("div"); let update;
		const close = view.mount(root, { send: () => {}, onData: (handler) => { update = handler; return () => {}; } });
		update({ type: "observer-state", authorized: true, snapshots: [], frames: [runningTask], capability: { actions: ["pause"] } });
		const pause = flatten(root, (node) => node.tag === "button" && node.textContent === "暂停")[0];
		await pause.listeners.click();
		await settle();
		const firstPoll = [...pending.values()][0];
		pending.clear();
		await firstPoll();
		await settle();
		assert.equal(pending.size, 1, "a queued command keeps exactly one pending poll");
		const detachedPoll = [...pending.values()][0];
		close();
		assert.equal(pending.size, 0);
		assert.ok(cleared.length >= 1);
		const before = calls.length;
		await detachedPoll();
		await settle();
		assert.equal(calls.length, before, "disposed polling never fetches or renders again");
	} finally {
		globalThis.document = previousDocument;
		globalThis.fetch = realFetch;
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
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
