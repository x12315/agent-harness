const initialState = {
	authorized: false,
	snapshots: [],
	summary: null,
	refreshedAt: null,
};

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

function render(root, state, send, rememberChoice) {
	root.replaceChildren();
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

export default {
	mount(container, ctx) {
		const style = document.createElement("style");
		style.textContent = `
			.observer { max-width: 980px; margin: 0 auto; padding: 24px; color: var(--text, #e7e9ed); font: 14px/1.5 system-ui, sans-serif; }
			.observer-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--border, #363a43); padding-bottom: 16px; }
			.observer-title { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: 0; }
			.sessions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); column-gap: 16px; }
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
			@media (max-width: 600px) { .observer { padding: 16px; } .sessions { grid-template-columns: 1fr; } .details { grid-template-columns: 1fr; gap: 1px; } .details dd { margin-bottom: 7px; } }
		`;
		const root = element("div");
		container.append(style, root);
		let state = initialState;
		let rememberChoice;
		const send = (payload) => {
			if (payload.type === "observer-remember-access") {
				rememberChoice = payload.remember;
				if (!state.authorized && payload.remember) return;
			}
			ctx.send(payload);
		};
		const update = (payload) => {
			if (!payload || payload.type !== "observer-state") return;
			if (payload.directory !== state.directory || payload.authorized || payload.error) rememberChoice = undefined;
			state = payload;
			render(root, state, send, rememberChoice);
		};
		const offData = ctx.onData(update);
		render(root, state, send, rememberChoice);
		ctx.send({ type: "observer-get" });
		return () => {
			offData();
			style.remove();
			root.remove();
		};
	},
};
