const initialState = {
	authorized: false,
	snapshots: [],
	frames: [],
	tasks: [],
	discrepancies: [],
	capability: null,
	summary: null,
	refreshedAt: null,
};

const TERMINAL_PHASES = new Set(["verified", "failed", "cancelled"]);
const CONTROL_ACTIONS = Object.freeze([
	{ action: "pause", label: "暂停" },
	{ action: "resume", label: "继续" },
	{ action: "cancel", label: "取消" },
]);
const CONTROL_STATE_TEXT = Object.freeze({ submitting: "正在提交", queued: "排队中", applied: "已生效", rejected: "被拒绝", unconfirmed: "未确认", error: "提交失败" });
const CONTROL_POLL_MS = 1_000;
const CONTROL_DEADLINE_MS = 20_000;
const CONTROL_ENDPOINT = "/plugins-api/pi-observer/control";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function valueText(value) {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (isRecord(value) && typeof value.text === "string" && value.text.trim()) return value.text.trim();
	return "";
}

function taskRefLabel(taskRef) {
	if (!isRecord(taskRef) || !taskRef.owner || !taskRef.taskId) return "";
	return `${taskRef.owner}#${taskRef.taskId}@${taskRef.revision ?? "?"}`;
}

function frameKey(frame) {
	return valueText(frame.subjectId) || taskRefLabel(frame.taskRef) || `${frame.kind}:${valueText(frame.phase)}`;
}

function sourceLabel(kind) {
	if (kind === "webui-task") return "协调任务";
	if (kind === "pi-session") return "Pi 会话";
	return "其他来源";
}

function frameHeadline(frame, fact) {
	const objective = valueText(frame.objective) || valueText(fact?.objective);
	if (objective) return objective;
	if (frame.kind === "webui-task") {
		const summary = valueText(frame.summary) || valueText(fact?.summary);
		if (summary) return summary;
	}
	return text(frame.phase);
}

function shortAge(ageMs) {
	if (!Number.isFinite(ageMs) || ageMs < 0) return "";
	if (ageMs < 1_000) return "<1s";
	if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s`;
	if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
	return `${Math.floor(ageMs / 3_600_000)}h`;
}

function frameAge(frame) {
	if (Number.isFinite(frame.ageMs)) return frame.ageMs;
	const elapsed = Date.now() - Date.parse(frame.observedAt || frame.updatedAt || "");
	return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

function frameAttention(frame) {
	const attention = frame.attention;
	if (!attention) return "";
	if (typeof attention === "string") return attention.trim();
	if (!isRecord(attention)) return "";
	const reason = valueText(attention.reason) || valueText(attention.detail);
	if (!reason) return "";
	const since = attention.at || attention.since;
	return since ? `${reason}（${formatAge(since)}）` : reason;
}

function allowedControlActions(state, frame) {
	const permitted = Array.isArray(state.capability?.actions) ? state.capability.actions : [];
	if (!permitted.length) return [];
	if (frame.kind !== "webui-task" || !isRecord(frame.taskRef)) return [];
	if (TERMINAL_PHASES.has(frame.phase)) return [];
	return CONTROL_ACTIONS.filter(({ action }) => permitted.includes(action));
}

function commandId() {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (typeof uuid === "string" && uuid) return uuid;
	return `observer-ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatTime(value) {
	if (!value) return "-";
	const time = new Date(value);
	return Number.isNaN(time.getTime()) ? "-" : time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatAge(value) {
	const elapsed = Date.now() - Date.parse(value || "");
	if (!Number.isFinite(elapsed) || elapsed < 0) return "just now";
	if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
	if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
	return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

function text(value) {
	return typeof value === "string" && value.trim() ? value.trim() : "-";
}

function element(name, className, value) {
	const node = document.createElement(name);
	if (className) node.className = className;
	if (value !== undefined) node.textContent = value;
	return node;
}

function applyControlState(binding, current) {
	const pending = Boolean(current && (current.state === "submitting" || current.state === "queued"));
	for (const button of binding.buttons) button.disabled = pending;
	binding.status.textContent = current ? CONTROL_STATE_TEXT[current.state] || "状态未知" : "";
	binding.detail.textContent = current?.detail || "";
}

function renderFrame(frame, state, controls, onControl, bindings, fact) {
	const article = element("article", `frame${frame.active ? " is-active" : ""}${frame.stale ? " is-stale" : ""}`);
	const headline = frameHeadline(frame, fact);
	const top = element("div", "frame-top");
	top.append(element("span", "badge kind", sourceLabel(frame.kind)));
	top.append(element("strong", "frame-headline", headline));
	const badges = element("div", "badges");
	badges.append(element("span", `status ${frame.active ? "active" : "idle"}`, frame.active ? "进行中" : "已停止"));
	const elapsed = frameAge(frame);
	if (elapsed !== undefined) badges.append(element("span", "age", `${shortAge(elapsed) || "<1s"} 前`));
	if (frame.stale) badges.append(element("span", "status stale", "已过期"));
	top.append(badges);
	article.append(top);

	const phase = text(frame.phase) || text(fact?.status);
	if (phase !== "-" && phase !== headline) article.append(element("p", "empty frame-phase", `阶段：${phase}`));
	const workspace = valueText(frame.workspace);
	if (workspace) {
		const node = element("p", "workspace frame-workspace", workspace);
		node.title = workspace;
		node.setAttribute("aria-label", `工作区：${workspace}`);
		article.append(node);
	}
	const summary = valueText(frame.summary) || valueText(fact?.summary);
	if (summary && summary !== headline) article.append(element("p", "frame-summary", `摘要：${summary}`));
	const tool = valueText(frame.tool);
	const progress = valueText(frame.progress);
	if (tool || progress) {
		const parts = [];
		if (tool) parts.push(`工具：${tool}`);
		if (progress) parts.push(`进展：${progress}`);
		article.append(element("p", "frame-progress", parts.join(" · ")));
	}
	const gap = valueText(frame.gap) || valueText(fact?.gap);
	if (gap) article.append(element("p", "frame-gap", `缺口：${gap}`));
	const attention = frameAttention(frame);
	if (attention) article.append(element("p", "frame-attention", `需要注意：${attention}`));
	const reference = taskRefLabel(frame.taskRef);
	if (reference) {
		const node = element("p", "frame-ref", reference);
		node.title = `任务引用 ${reference}`;
		article.append(node);
	}

	const actions = allowedControlActions(state, frame);
	if (actions.length) {
		const key = frameKey(frame);
		const group = element("div", "control-actions");
		const buttons = [];
		for (const { action, label } of actions) {
			const button = element("button", "control-button", label);
			const buttonLabel = `${label}任务 ${frame.taskRef.taskId}`;
			button.type = "button";
			button.ariaLabel = buttonLabel;
			button.setAttribute("aria-label", buttonLabel);
			button.addEventListener("click", () => onControl(frame, action));
			buttons.push(button);
			group.append(button);
		}
		const status = element("p", "control-status");
		status.role = "status";
		status.ariaLive = "polite";
		status.setAttribute("role", "status");
		status.setAttribute("aria-live", "polite");
		const detail = element("p", "empty control-detail");
		group.append(status, detail);
		article.append(group);
		bindings.set(key, { buttons, status, detail });
		applyControlState(bindings.get(key), controls.get(key));
	}
	return article;
}

function renderFrames(shell, state, controls, onControl, bindings) {
	const frames = Array.isArray(state.frames) ? state.frames.filter(isRecord) : [];
	if (!frames.length) return;
	const section = element("section", "run-tasks");
	section.append(element("h2", "section-title", `运行与任务 · ${frames.length}`));
	const facts = new Map();
	for (const task of Array.isArray(state.tasks) ? state.tasks : []) {
		if (!isRecord(task) || !task.owner || !task.taskId) continue;
		facts.set(`${task.owner}:${task.taskId}`, task);
	}
	const factFor = (frame) => {
		const subject = valueText(frame.subjectId);
		if (facts.has(subject)) return facts.get(subject);
		if (isRecord(frame.taskRef)) return facts.get(`${frame.taskRef.owner}:${frame.taskRef.taskId}`);
		return undefined;
	};
	const ordered = [...frames].sort((left, right) => Number(right.active === true) - Number(left.active === true));
	const groups = new Map();
	for (const frame of ordered) {
		const kind = frame.kind === "webui-task" || frame.kind === "pi-session" ? frame.kind : "other";
		if (!groups.has(kind)) groups.set(kind, []);
		groups.get(kind).push(frame);
	}
	for (const kind of ["pi-session", "webui-task", "other"]) {
		const group = groups.get(kind);
		if (!group) continue;
		section.append(element("h3", "frame-group-title", `${sourceLabel(kind)} · ${group.length}`));
		const list = element("div", "frame-list");
		for (const frame of group) list.append(renderFrame(frame, state, controls, onControl, bindings, factFor(frame)));
		section.append(list);
	}
	shell.append(section);
}

function renderDiscrepancies(shell, state) {
	const found = Array.isArray(state.discrepancies) ? state.discrepancies.filter(isRecord) : [];
	if (!found.length) return;
	const section = element("section", "discrepancies");
	section.append(element("h2", "section-title", `需要核对 · ${found.length}`));
	section.append(element("p", "empty", "以下差异只做提示，不自动处理，也不会隐藏过期信息。"));
	const list = element("ul", "notice-list");
	for (const entry of found) {
		const item = element("li", "notice");
		item.append(element("strong", "notice-code", text(entry.code)));
		const subject = valueText(entry.subjectId);
		if (subject) item.append(element("span", "notice-subject", ` · ${subject}`));
		const detail = valueText(entry.detail);
		if (detail) item.append(element("span", "notice-detail", `：${detail}`));
		list.append(item);
	}
	section.append(list);
	shell.append(section);
}

function render(root, state, send, rememberChoice, controls, onControl, bindings) {
	root.replaceChildren();
	bindings.clear();
	const shell = element("main", "observer");
	const header = element("header", "observer-header");
	const title = element("div", "title-wrap");
	title.append(element("h1", "observer-title", "Pi Observer"));
	title.append(element("p", "updated", state.refreshedAt ? `Updated ${formatTime(state.refreshedAt)}` : "Waiting for status"));
	const refresh = element("button", "icon-button", "Refresh");
	refresh.type = "button";
	refresh.title = "Refresh observer status";
	refresh.addEventListener("click", () => send({ type: "observer-refresh" }));
	header.append(title, refresh);
	shell.append(header);

	if (state.error) shell.append(element("p", "error", state.error));
	const access = element("section", "access");
	access.append(element("p", "empty", state.directory ? `快照目录：${state.directory}` : "正在确认快照目录…"));
	const rememberLabel = element("label", "remember-access");
	const remember = element("input");
	remember.type = "checkbox";
	remember.checked = rememberChoice ?? state.rememberAccess === true;
	remember.disabled = !state.directory;
	remember.addEventListener("change", () => send({ type: "observer-remember-access", remember: remember.checked }));
	rememberLabel.append(remember, element("span", "", "记住此目录的读取授权，下次自动访问"));
	access.append(rememberLabel, element("p", "empty", "不勾选时仅本次 Web 服务会话有效；取消勾选可停止下次自动访问。权限撤销或目录变化时仍需重新确认。"));
	if (!state.authorized) {
		access.append(element("p", "", "Observer needs read access to Pi's snapshot directory."));
		const grant = element("button", "primary", "Allow read access");
		grant.type = "button";
		grant.disabled = !state.directory;
		grant.addEventListener("click", () => send({ type: "observer-authorize", remember: remember.checked }));
		access.append(grant);
	}
	shell.append(access);
	if (!state.authorized) { root.append(shell); return; }
	const missingPids = state.coverage?.unobservedPids || [];
	const coverage = element("section", "coverage");
	coverage.role = "status";
	if (missingPids.length) {
		coverage.append(element("p", "", `${missingPids.length} Pi process${missingPids.length === 1 ? " is" : "es are"} not connected to Observer. Activity is unknown, not idle.`));
		coverage.append(element("p", "", `PID: ${missingPids.join(", ")}. In those sessions, run /profile reload after the current task finishes. Do not interrupt ongoing work.`));
	} else if (!state.coverage?.verified) {
		coverage.append(element("p", "", "Process coverage has not been checked. This view shows only connected sessions; other Pi agents may still be working."));
	} else {
		coverage.append(element("p", "", "All recently detected Pi-named processes have snapshots. Other agent directories and runtimes may not be covered."));
	}
	shell.append(coverage);
	renderFrames(shell, state, controls, onControl, bindings);
	renderDiscrepancies(shell, state);
	if (state.summary?.scope === "global" && state.summary.text) {
		const summary = element("section", "summary");
		summary.append(element("div", "eyebrow", "Overall status"));
		summary.append(element("p", "summary-text", state.summary.text));
		summary.append(element("div", "summary-time", `${formatAge(state.summary.reportedAt)} at ${formatTime(state.summary.reportedAt)}`));
		shell.append(summary);
	}

	const pending = state.snapshots.filter((snapshot) => snapshot.attention && ["reply", "approval", "error"].includes(snapshot.attention.reason))
		.sort((a, b) => Date.parse(a.attention.since) - Date.parse(b.attention.since));
	const inbox = element("section", "coverage");
	inbox.append(element("h2", "section-title", `待你处理 · ${pending.length} 个会话`));
	if (!pending.length) inbox.append(element("p", "empty", "已接入会话暂无待处理记录；未接入或旧版 Agent 的状态不能据此判断。"));
	for (const snapshot of pending) {
		const reason = snapshot.attention.reason === "approval" ? "需要确认" : snapshot.attention.reason === "error" ? "本轮出错" : "本轮已结束，等待下一步";
		inbox.append(element("p", "", `${reason} · ${text(snapshot.cwd)} · ${snapshot.id}${snapshot.active ? ` · ${formatAge(snapshot.attention.since)}` : ""}${snapshot.attention.acknowledgedAt ? " · 已读，仍待处理" : " · 未读"}`));
		if (snapshot.terminal?.pane) inbox.append(element("p", "empty", `iTerm 分屏：${text(snapshot.terminal.pane)}`));
	}
	shell.append(inbox);
	const sessions = element("section", "sessions");
	const active = state.snapshots.filter((snapshot) => snapshot.active).length;
	const processes = new Set(state.snapshots.map((snapshot) => snapshot.pid)).size;
	sessions.append(element("div", "section-title", `${state.snapshots.length} observed session${state.snapshots.length === 1 ? "" : "s"} · ${processes} process${processes === 1 ? "" : "es"} · ${active} active`));
	if (state.snapshots.length === 0) {
		sessions.append(element("p", "empty", "No current Pi observer snapshots."));
	}
	for (const snapshot of state.snapshots) {
		const card = element("article", `session ${snapshot.active ? "is-active" : ""}`);
		const top = element("div", "session-top");
		top.append(element("strong", "phase", snapshot.compaction?.active ? "自动压缩中" : snapshot.active ? text(snapshot.phase) : "等待输入"));
		top.append(element("span", `status ${snapshot.active ? "active" : "idle"}`, snapshot.compaction?.active ? "Compacting" : snapshot.active ? "Active" : "Idle"));
		card.append(top);
		const cwd = text(snapshot.cwd);
		const parts = cwd.split(/[\\/]+/).filter(Boolean);
		const directory = parts.length > 2 ? parts.at(-1) : cwd;
		const workspace = element("p", "workspace", directory);
		workspace.title = cwd;
		workspace.ariaLabel = `Working directory: ${cwd}`;
		card.append(workspace);
		if (!snapshot.active && !snapshot.compaction?.active) {
			card.title = `Session ${text(snapshot.id)} · PID ${snapshot.pid ?? "-"}`;
			sessions.append(card);
			continue;
		}
		const details = element("dl", "details");
		const rows = [
			["Process", String(snapshot.pid ?? "-")],
			["Session", text(snapshot.id)],
			["Latest tool", text(snapshot.lastTool)],
			["Activity", formatAge(snapshot.lastActivityAt)],
		];
		for (const [label, value, fullValue] of rows) {
			const detail = element("dd", "", value);
			detail.title = fullValue || value;
			details.append(element("dt", "", label), detail);
		}
		card.append(details);
		if (snapshot.runStartedAt) {
			const excluded = snapshot.compaction?.excludedMs || 0;
			if (typeof snapshot.workElapsedMs === "number") card.append(element("p", "empty", snapshot.compaction?.active ? "自动压缩中 · 工作计时暂停" : `本轮工作耗时约 ${Math.max(0, Math.floor(snapshot.workElapsedMs / 1000))} 秒 · 已排除自动压缩 ${Math.floor(excluded / 1000)} 秒`));
		}
		if (snapshot.lastToolError) card.append(element("p", "error", `最近工具执行失败：${text(snapshot.lastTool)}`));
		const cachedSummary = state.summaries?.find((summary) => summary.scope === "session" && summary.id === snapshot.id);
		const previousRun = cachedSummary && snapshot.runStartedAt && Date.parse(cachedSummary.reportedAt) < Date.parse(snapshot.runStartedAt);
		const sessionSummary = snapshot.active && !previousRun ? cachedSummary : undefined;
		if (snapshot.active) card.append(element("div", "eyebrow", "任务摘要"));
		if (sessionSummary) {
			card.append(element("p", sessionSummary.status === "error" ? "summary-text error" : "summary-text", sessionSummary.text));
			card.append(element("div", "summary-time", `生成于 ${formatTime(sessionSummary.reportedAt)}（${formatAge(sessionSummary.reportedAt)}）`));
		} else if (snapshot.active) {
			card.append(element("p", "empty", "尚未生成本会话的任务摘要；原始输出不会代替摘要。"));
			const reason = snapshot.summaryScope !== "session"
				? "此 Agent 尚未上报摘要设置；如摘要持续缺失，等任务结束后执行 /reload。"
				: "等待此 Agent 自行总结（持续无文字回复约一分钟后首次生成，之后最多每五分钟一次），也可在其终端执行 /observer now。";
			card.append(element("p", "empty", reason));
		}
		if (snapshot.automaticReports === false) card.append(element("p", "empty", "此 Agent 的自动摘要已关闭；可在其终端执行 /observer on。"));
		sessions.append(card);
	}
	for (const pid of missingPids) {
		const card = element("article", "session is-unknown");
		const top = element("div", "session-top");
		top.append(element("strong", "phase", `Pi process ${pid}`));
		top.append(element("span", "status unknown", "Unknown"));
		card.append(top, element("p", "assistant-text", "Observer is not connected. No reliable activity status is available."));
		sessions.append(card);
	}
	shell.append(sessions);
	root.append(shell);
}

async function responseJson(response) {
	try { return await response.json(); } catch { return null; }
}

function controlReceipt(value) {
	if (!isRecord(value)) return null;
	for (const key of ["command", "receipt", "control"]) if (isRecord(value[key])) return value[key];
	return value;
}

function receiptState(receipt) {
	return isRecord(receipt) && typeof receipt.state === "string" ? receipt.state : undefined;
}

function receiptDetail(receipt) {
	return isRecord(receipt) ? valueText(receipt.detail) || valueText(receipt.message) || valueText(receipt.error) : "";
}

export default {
	mount(container, ctx) {
		const style = document.createElement("style");
		style.textContent = `
			.observer { max-width: 980px; margin: 0 auto; padding: 24px; color: var(--text, #e7e9ed); font: 14px/1.5 system-ui, sans-serif; }
			.observer-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--border, #363a43); padding-bottom: 16px; }
			.observer-title { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: 0; }
			.sessions, .frame-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); column-gap: 16px; }
			.run-tasks, .discrepancies { margin-top: 22px; }
			.frame-group-title { margin: 14px 0 2px; color: var(--muted, #a0a6b2); font-size: 12px; font-weight: 650; }
			.frame { min-width: 0; border-top: 1px solid var(--border, #363a43); padding: 12px 0; overflow-wrap: anywhere; }
			.frame-top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
			.frame-headline { flex: 1 1 100%; font-size: 14px; overflow-wrap: anywhere; }
			.badges { display: flex; flex-wrap: wrap; gap: 4px 6px; }
			.badge.kind { border: 1px solid var(--border, #4b5260); border-radius: 4px; padding: 1px 6px; font-size: 11px; color: var(--muted, #c1c6d0); }
			.status.stale { background: #4a3a1c; color: #e8d39a; }
			.age { color: var(--muted, #a0a6b2); font-size: 11px; }
			.frame-phase, .frame-summary, .frame-progress, .frame-gap, .frame-attention, .frame-ref, .control-detail { margin: 6px 0 0; font-size: 12px; overflow-wrap: anywhere; }
			.frame-gap { color: #e0c07a; }
			.frame-attention { border-left: 2px solid #8d7a44; padding-left: 8px; }
			.frame-ref { color: var(--muted, #a0a6b2); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
			.control-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
			.control-button { border: 1px solid var(--border, #4b5260); border-radius: 5px; padding: 5px 9px; background: var(--button, #272b33); color: inherit; cursor: pointer; font: inherit; font-size: 12px; }
			.control-button:hover { background: var(--button-hover, #363c47); }
			.control-status { margin: 0; font-size: 12px; font-weight: 600; }
			.control-status:empty, .control-detail:empty { display: none; }
			.notice-list { margin: 6px 0 0; padding-left: 18px; color: var(--muted, #c1c6d0); font-size: 12px; }
			.notice { margin: 4px 0; overflow-wrap: anywhere; }
			.notice-code { color: var(--text, #e7e9ed); }
			.sessions > .section-title, .sessions > .empty { grid-column: 1 / -1; }
			.updated, .summary-time, .empty { margin: 3px 0 0; color: var(--muted, #a0a6b2); font-size: 12px; }
			.icon-button, .primary { border: 1px solid var(--border, #4b5260); border-radius: 5px; padding: 7px 10px; background: var(--button, #272b33); color: inherit; cursor: pointer; font: inherit; }
			.icon-button:hover, .primary:hover { background: var(--button-hover, #363c47); }
			.primary { margin-top: 14px; background: var(--accent, #2671d9); border-color: var(--accent, #2671d9); color: #fff; }
			.access, .summary, .sessions { margin-top: 22px; }
			.access { max-width: 700px; }
			.remember-access { display: flex; align-items: center; gap: 8px; margin-top: 10px; cursor: pointer; }
			.remember-access input { flex: 0 0 auto; accent-color: var(--accent, #2671d9); }
			button:disabled { cursor: wait; opacity: 0.5; }
			.eyebrow, .section-title { color: var(--muted, #a0a6b2); font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: 0; }
			.summary-text { margin: 7px 0 0; font-size: 16px; }
			.error { color: #e86d75; }
			.coverage { margin-top: 16px; border-left: 3px solid var(--accent, #2671d9); padding: 1px 12px; font-size: 12px; }
			.status.unknown { border: 1px solid var(--border, #4b5260); }
			.session { border-top: 1px solid var(--border, #363a43); padding: 14px 0; }
			.session:first-of-type { margin-top: 8px; }
			.session-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
			.phase { overflow-wrap: anywhere; }
			.status { flex: 0 0 auto; border-radius: 999px; padding: 2px 7px; font-size: 11px; }
			.status.active { background: #174d35; color: #a8e6c3; }
			.status.idle { background: #3a3f49; color: #d3d7de; }
			.workspace { font-size: 12px; margin: 6px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted, #a0a6b2); }
			.details { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 4px 8px; margin: 8px 0 0; font-size: 12px; }
			.details dt { color: var(--muted, #a0a6b2); }
			.details dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.assistant-text { margin: 12px 0 0; color: var(--muted, #c1c6d0); overflow-wrap: anywhere; }
			@media (max-width: 600px) { .observer { padding: 16px; } .sessions, .frame-list { grid-template-columns: 1fr; } .details { grid-template-columns: 1fr; gap: 1px; } .details dd { margin-bottom: 7px; } }
		`;
		const root = element("div");
		container.append(style, root);
		let state = initialState;
		let rememberChoice;
		let disposed = false;
		const controls = new Map();
		const bindings = new Map();
		const timers = new Set();
		const send = (payload) => {
			if (payload.type === "observer-remember-access") {
				rememberChoice = payload.remember;
				if (!state.authorized && payload.remember) return;
			}
			ctx.send(payload);
		};
		const renderView = () => render(root, state, send, rememberChoice, controls, requestControl, bindings);
		const setControl = (key, value) => {
			if (disposed) return;
			controls.set(key, value);
			if (controls.size > 64) controls.delete(controls.keys().next().value);
			const binding = bindings.get(key);
			if (binding) applyControlState(binding, value);
		};
		const scheduleControlPoll = (key, id, deadline) => {
			if (disposed) return;
			if (Date.now() >= deadline) {
				setControl(key, { commandId: id, state: "unconfirmed", detail: "20 秒内未收到结果；未自动重试，请刷新后核实。" });
				return;
			}
			const timer = setTimeout(async () => {
				timers.delete(timer);
				if (disposed) return;
				if (Date.now() >= deadline) {
					setControl(key, { commandId: id, state: "unconfirmed", detail: "20 秒内未收到结果；未自动重试，请刷新后核实。" });
					return;
				}
				try {
					const response = await fetch(`${CONTROL_ENDPOINT}?id=${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
					const receipt = controlReceipt(await responseJson(response));
					if (disposed) return;
					if (!response.ok) {
						setControl(key, { commandId: id, state: "unconfirmed", detail: `查询控制状态失败（服务端返回 ${response.status ?? "未知"}）；未自动重试提交，请刷新后核实。` });
						return;
					}
					const detail = receiptDetail(receipt);
					if (receiptState(receipt) === "applied") {
						setControl(key, { commandId: id, state: "applied", detail });
						return;
					}
					if (receiptState(receipt) === "rejected") {
						setControl(key, { commandId: id, state: "rejected", detail });
						return;
					}
					setControl(key, { commandId: id, state: "queued", detail: detail || "服务端已受理，等待执行结果。" });
					scheduleControlPoll(key, id, deadline);
				} catch {
					if (disposed) return;
					setControl(key, { commandId: id, state: "unconfirmed", detail: "查询控制状态失败；未自动重试提交，请刷新后核实。" });
				}
			}, CONTROL_POLL_MS);
			timers.add(timer);
		};
		async function requestControl(frame, action) {
			if (disposed || !isRecord(frame.taskRef)) return;
			const key = frameKey(frame);
			const id = commandId();
			setControl(key, { commandId: id, action, state: "submitting", detail: "等待服务端受理。" });
			try {
				const response = await fetch(CONTROL_ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ commandId: id, consumerId: "observer-ui", action, target: { taskRef: frame.taskRef }, expectedRevision: frame.taskRef.revision }),
				});
				const receipt = controlReceipt(await responseJson(response));
				if (disposed) return;
				if (!response.ok) {
					const detail = receiptDetail(receipt) || `服务端返回 ${response.status ?? "未知"}。`;
					setControl(key, { commandId: id, action, state: "error", detail: `提交失败：${detail} 未自动重试，请手动再试。` });
					return;
				}
				const detail = receiptDetail(receipt);
				if (receiptState(receipt) === "rejected") {
					setControl(key, { commandId: id, action, state: "rejected", detail });
					return;
				}
				if (receiptState(receipt) === "applied") {
					setControl(key, { commandId: id, action, state: "applied", detail });
					return;
				}
				setControl(key, { commandId: id, action, state: "queued", detail: detail || "服务端已受理，等待执行结果。" });
				scheduleControlPoll(key, id, Date.now() + CONTROL_DEADLINE_MS);
			} catch {
				if (disposed) return;
				setControl(key, { commandId: id, action, state: "error", detail: "提交失败。未自动重试，请手动再试。" });
			}
		}
		const update = (payload) => {
			if (!payload || payload.type !== "observer-state") return;
			if (payload.directory !== state.directory || payload.authorized || payload.error) rememberChoice = undefined;
			state = payload;
			renderView();
		};
		const offData = ctx.onData(update);
		renderView();
		ctx.send({ type: "observer-get" });
		return () => {
			disposed = true;
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
			offData();
			style.remove();
			root.remove();
		};
	},
};
