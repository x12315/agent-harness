import { Outbox } from "./outbox.mjs";
import { markdown } from "./markdown.mjs";
import { statusLabel, gapLabel, taskControlText, taskCounts, elapsedLabel, nativeEvidenceFor } from "./view-utils.mjs";

const node = (tag, text, className) => {
	const element = document.createElement(tag);
	if (text != null) element.textContent = text;
	if (className) element.className = className;
	return element;
};
const timeLabel = (value) => value == null || !Number.isFinite(new Date(value).getTime()) ? "—" : new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const button = (text, handler, className = "co-button") => {
	const element = node("button", text, className);
	element.type = "button";
	element.addEventListener("click", handler);
	return element;
};
const paragraph = (text, className = "co-text") => node("p", text, className);
const details = (label, key) => {
	const element = node("details", null, "co-details");
	element.dataset.key = key;
	element.append(node("summary", label));
	return element;
};

/** Workspace-bound conversation and evidence view; only durable receipts acknowledge submission. */
export default {
	mount(el, ctx) {
		const stylesheet = node("link");
		stylesheet.rel = "stylesheet";
		stylesheet.href = new URL("./styles.css", import.meta.url).href;
		const root = node("section", null, "co-workspace");
		root.setAttribute("aria-label", "任务协调工作区");
		const header = node("header", null, "co-header");
		const identity = node("div", null, "co-identity");
		identity.append(node("span", "协", "co-mark"), node("h1", "任务协调"));
		const connection = node("span", "正在连接…", "co-connection");
		const refresh = button("刷新", () => requestState(true));
		const headerActions = node("div", null, "co-header-actions");
		headerActions.append(connection, refresh);
		header.append(identity, headerActions);
		const runtimeLine = node("div", null, "co-runtime");
		const workspaceLabel = node("span", "等待工作区信息", "co-workspace-path");
		const modelLabel = node("span", "", "co-model");
		runtimeLine.append(workspaceLabel, modelLabel);
		const layout = node("div", null, "co-layout");
		const chat = node("section", null, "co-chat");
		chat.setAttribute("aria-label", "对话");
		const chatHeading = node("div", null, "co-section-heading");
		chatHeading.append(node("h2", "对话"), node("span", "提问、补充或调整方向", "co-muted"));
		const conversation = node("div", null, "co-conversation");
		conversation.tabIndex = 0;
		conversation.setAttribute("aria-label", "按时间排列的对话记录");
		const jump = button("查看最新消息", () => { conversation.scrollTop = conversation.scrollHeight; jump.hidden = true; }, "co-jump co-button");
		jump.hidden = true;
		const form = node("form", null, "co-composer");
		const input = node("textarea");
		input.placeholder = "说说要做什么，也可以随时补充或提问…";
		input.setAttribute("aria-label", "你的需求或补充");
		input.maxLength = 16000;
		input.rows = 3;
		const composerFooter = node("div", null, "co-composer-footer");
		const keyHint = node("span", "Enter 发送，Shift + Enter 换行", "co-muted co-key-hint");
		const send = node("button", "发送", "co-send");
		send.type = "submit";
		send.disabled = true;
		composerFooter.append(keyHint, send);
		const feedback = paragraph("连接后即可发送。请求保存后才算受理。", "co-feedback");
		feedback.setAttribute("role", "status");
		feedback.setAttribute("aria-live", "polite");
		form.append(input, composerFooter, feedback);
		chat.append(chatHeading, conversation, jump, form);
		const sidebar = node("aside", null, "co-sidebar");
		sidebar.setAttribute("aria-label", "任务与证据");
		const taskHeading = node("div", null, "co-section-heading co-task-heading");
		taskHeading.append(node("h2", "任务与证据"));
		const counts = node("p", "", "co-counts");
		const taskList = node("div", null, "co-task-list");
		taskList.tabIndex = 0;
		taskList.setAttribute("aria-label", "任务详情，可独立滚动");
		sidebar.append(taskHeading, counts, taskList);
		layout.append(chat, sidebar);
		root.append(stylesheet, header, runtimeLine, layout);
		el.replaceChildren(root);

		let outbox, workspace, state = { inputs: [], tasks: [] }, disposed = false, refreshTimer;
		let taskSignature = "", conversationSignature = "", receivedAt = null;
		const inFlight = new Map();
		try { outbox = new Outbox(sessionStorage); }
		catch { feedback.textContent = "浏览器无法保存待发记录，暂不发送。请允许此页面使用会话存储后重新加载。"; }
		const announce = (text) => { feedback.textContent = text; };
		const updateSend = () => { send.disabled = !outbox || !workspace || !input.value.trim(); };
		const transmit = (item, force = false) => {
			if (!force && Date.now() - (inFlight.get(item.requestId) || 0) < 15000) return;
			inFlight.set(item.requestId, Date.now());
			try {
				Promise.resolve(ctx.send({ type: "coordinator-input", ...item })).catch(() => {
					if (!disposed) { inFlight.delete(item.requestId); announce("连接中断，请求仍保存在本机。点“刷新”可用原编号重试。"); }
				});
			} catch { inFlight.delete(item.requestId); announce("发送未确认，请求已保留。点“刷新”重试，不会重复创建请求。"); }
		};
		const enqueue = (text) => {
			if (!outbox || !workspace || !text.trim()) return false;
			if (text.length > 16000) { announce("这条请求超过 16000 字，请缩短后发送。"); return false; }
			try {
				const item = { requestId: crypto.randomUUID(), text, workspace };
				outbox.add(item);
				announce("正在保存，尚未确认受理…");
				renderConversation();
				transmit(item);
				return true;
			} catch { announce("未能保存待发记录，尚未发送。请保留文本，检查浏览器存储或待发数量后重试。"); return false; }
		};
		function requestState(retry = false) {
			if (disposed) return;
			connection.textContent = "正在刷新…";
			clearTimeout(refreshTimer);
			refreshTimer = setTimeout(() => {
				if (disposed) return;
				connection.textContent = "等待连接";
				announce("尚未收到更新。请检查连接后点“刷新”；已输入和待发内容不会清空。");
			}, 8000);
			try {
				Promise.resolve(ctx.send({ type: "coordinator-get" })).catch(() => { if (!disposed) connection.textContent = "连接不可用"; });
				if (retry && workspace && outbox) for (const item of outbox.items.filter((entry) => entry.workspace === workspace)) transmit(item, true);
			} catch { connection.textContent = "连接不可用"; }
		}
		function renderConversation() {
			const pending = outbox?.items.filter((item) => item.workspace === workspace && !state.inputs.some((saved) => saved.requestId === item.requestId)) || [];
			const signature = JSON.stringify([state.inputs, pending, state.tasks.map(({ id, status }) => [id, status])]);
			if (signature === conversationSignature) return;
			conversationSignature = signature;
			const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 90;
			const scrollTop = conversation.scrollTop;
			const fragment = document.createDocumentFragment();
			const inputs = [...state.inputs].sort((a, b) => (a.acceptedAt || 0) - (b.acceptedAt || 0));
			if (!inputs.length && !pending.length) {
				const empty = node("div", null, "co-chat-empty");
				empty.append(node("h3", "从一个具体需求开始"), paragraph("描述目标和限制就好。任务执行时，你仍可以在这里提问或补充。"), paragraph("例如：调查偶发超时，先给出证据，不要改动部署。", "co-example"));
				fragment.append(empty);
			}
			for (const item of [...inputs, ...pending]) {
				const message = node("article", null, "co-message co-message-user");
				const meta = node("div", null, "co-message-meta");
				meta.append(node("strong", "你"), node("time", item.acceptedAt ? timeLabel(item.acceptedAt) : "待确认受理"), node("span", item.acceptedAt ? statusLabel(state.tasks.find((task) => task.inputId === item.id)?.status || item.status) : "本机已保留", "co-message-status"));
				message.append(meta, paragraph(item.text));
				fragment.append(message);
				if (item.answer) {
					const reply = node("article", null, "co-message co-message-assistant");
					reply.append(node("div", "协调助手", "co-message-meta"), markdown(/^Classification unavailable:/i.test(item.answer) ? gapLabel(item.answer) : item.answer));
					fragment.append(reply);
				}
			}
			conversation.replaceChildren(fragment);
			if (nearBottom) { conversation.scrollTop = conversation.scrollHeight; jump.hidden = true; }
			else { conversation.scrollTop = scrollTop; jump.hidden = false; }
		}
		function renderTask(task) {
			const article = node("article", null, "co-task");
			article.dataset.taskId = task.id;
			const heading = node("div", null, "co-task-title");
			heading.append(node("h3", task.objective), node("span", statusLabel(task.status), `co-status co-status-${task.status}`));
			article.append(heading);
			const original = task.sourceText ?? state.inputs.find((item) => item.id === task.sourceInputId || item.id === task.inputId)?.text;
			article.append(node("h4", "原始需求"), paragraph(original ?? task.objective));
			if (!original) article.append(paragraph("未提供独立原文；此处显示任务目标，对话中保留已收件原文。", "co-muted"));
			if (task.amendments?.length) {
				const amendments = details(`补充与调整（${task.amendments.length}）`, `${task.id}:amendments`);
				for (const amendment of task.amendments) amendments.append(paragraph(amendment.source === "coverage-review" ? "证据检查要求补齐未覆盖的原始需求。" : amendment.text));
				article.append(amendments);
			}
			if (task.progress?.summary || task.progress?.tool) {
				const progress = node("div", null, "co-progress");
				progress.append(node("h4", "当前进展"));
				if (task.progress.summary) progress.append(paragraph(task.progress.summary));
				if (task.progress.tool) progress.append(paragraph(`正在使用：${typeof task.progress.tool === "string" ? task.progress.tool : task.progress.tool.name || "执行工具"}`, "co-muted"));
				article.append(progress);
			}
			const timing = node("dl", null, "co-timing");
			const terminal = ["verified", "failed", "cancelled"].includes(task.status);
			const endedAt = task.completedAt ?? task.finishedAt;
			const elapsed = terminal && task.startedAt != null && endedAt == null ? "未提供结束时间" : elapsedLabel(task.startedAt, endedAt ?? Date.now());
			for (const [label, value] of [["开始", timeLabel(task.startedAt)], ["已用时", elapsed], ["最近检查", timeLabel(task.checkpoint?.at)], ["下次检查", terminal ? "已结束" : task.nextCheckAt ? timeLabel(task.nextCheckAt) : "等待安排"]]) {
				timing.append(node("dt", label), node("dd", value));
			}
			article.append(timing);
			const coverage = task.coverage || task.evidence?.coverage || (task.evidence?.checked || task.evidence?.missing ? task.evidence : null);
			const evidence = node("section", null, "co-evidence");
			evidence.append(node("h4", "需求证据"));
			if (!coverage?.checked?.length && !coverage?.missing?.length) evidence.append(paragraph(coverage?.status === "passed" ? "覆盖检查已通过，尚无逐项证据明细。" : "尚未取得逐项覆盖证据。执行结束不等于需求已全部完成。", "co-muted"));
			for (const [kind, items] of [["checked", coverage?.checked], ["missing", coverage?.missing]]) {
				for (const item of items || []) {
					const row = node("div", null, `co-evidence-item co-evidence-${kind}`);
					row.append(node("span", kind === "checked" ? "已有证据" : "缺少证据", "co-evidence-label"), paragraph(item.requirement), paragraph(kind === "checked" ? item.evidence : gapLabel(item.evidenceGap), "co-muted"));
					evidence.append(row);
				}
			}
			article.append(evidence);
			if (task.gap || coverage?.gap) article.append(paragraph(`尚未完成：${gapLabel(task.gap || coverage.gap)}`, "co-gap"));
			const native = nativeEvidenceFor(task);
			if (native || task.nativeReference) {
				const nativePanel = details("原生执行与检查记录", `${task.id}:native`);
				if (native?.feedback) nativePanel.append(node("h4", "检查反馈"), paragraph(native.feedback));
				if (native?.round != null) nativePanel.append(paragraph(`执行轮次：${native.round}`, "co-muted"));
				if (native?.summary) nativePanel.append(paragraph(native.summary));
				for (const message of native?.messages || []) {
					const text = typeof message.text === "string" ? message.text : typeof message.content === "string" ? message.content : "";
					if (text) nativePanel.append(node("h4", { user: "执行要求", assistant: "执行记录", tool: "工具结果" }[message.role] || "执行记录"), paragraph(text));
				}
				const reference = task.nativeReference || task.handle;
				if (reference?.clientId) nativePanel.append(paragraph(`客户端：${reference.clientId}`, "co-reference"));
				if (reference?.conversationId) nativePanel.append(paragraph(`会话：${reference.conversationId}`, "co-reference"));
				if (!native?.feedback && !native?.messages?.length && !native?.summary) nativePanel.append(paragraph("原生记录已关联，暂未提供可展示的检查内容。", "co-muted"));
				nativePanel.append(paragraph("仅展示此任务提供的记录，不根据会话编号跳转到可能同名的会话。", "co-muted"));
				article.append(nativePanel);
			}
			if (!terminal) {
				const controls = node("div", null, "co-task-controls");
				for (const [action, label] of task.status === "paused" ? [["resume", "继续"], ["cancel", "取消任务"]] : [["pause", "暂停"], ["cancel", "取消任务"]]) {
					const control = button(label, () => {
						if (enqueue(taskControlText(action, task))) announce(`已发送“${label}”请求，等待受理和执行侧确认。`);
					});
					control.dataset.action = action;
					control.disabled = !outbox || !workspace || task.status === "stopping";
					control.setAttribute("aria-label", `${label}：${task.objective}`);
					controls.append(control);
				}
				article.append(controls);
				if (task.status === "stopping") article.append(paragraph("停止请求仍在确认，状态确认前不重复派发。", "co-muted"));
			}
			return article;
		}
		function renderTasks() {
			const signature = JSON.stringify([state.tasks, state.inputs.map(({ id, text }) => [id, text]), workspace, !!outbox]);
			if (signature === taskSignature) return;
			taskSignature = signature;
			const opened = new Set([...taskList.querySelectorAll("details[open]")].map((entry) => entry.dataset.key));
			const scrollTop = taskList.scrollTop;
			const focusedTask = document.activeElement?.closest?.("[data-task-id]")?.dataset.taskId;
			const focusedAction = document.activeElement?.dataset.action;
			const rank = (task) => ["verified", "failed", "cancelled"].includes(task.status) ? 2 : task.status === "paused" || task.status === "queued" ? 1 : 0;
			const ordered = [...state.tasks].sort((a, b) => rank(a) - rank(b) || (b.createdAt || 0) - (a.createdAt || 0));
			taskList.replaceChildren(...ordered.map(renderTask));
			if (!state.tasks.length) taskList.append(paragraph("任务会在这里继续。发送明确的工作需求后，可查看进展、检查时间与证据。", "co-sidebar-empty"));
			for (const entry of taskList.querySelectorAll("details")) entry.open = opened.has(entry.dataset.key);
			taskList.scrollTop = scrollTop;
			if (focusedTask && focusedAction) {
				const replacement = [...taskList.querySelectorAll("[data-action]")].find((control) => control.dataset.action === focusedAction && control.closest("[data-task-id]").dataset.taskId === focusedTask);
				replacement?.focus({ preventScroll: true });
			}
		}
		function render() {
			const runtime = state.runtime || {};
			workspaceLabel.textContent = runtime.workspace || workspace || "等待工作区信息";
			workspaceLabel.title = workspaceLabel.textContent;
			const model = typeof runtime.model === "string" ? runtime.model : runtime.model ? [runtime.model.provider, runtime.model.id || runtime.model.name].filter(Boolean).join("/") : "";
			modelLabel.textContent = `${runtime.executionEnabled === false ? "仅收件 · 执行未开启" : runtime.executionEnabled === true ? "后台执行已开启" : "执行权限由插件设置决定"}${model ? `　模型 ${model}` : ""}`;
			const totals = taskCounts(state.tasks);
			counts.textContent = `${totals.active} 进行中　${totals.waiting} 等待或暂停　${totals.complete} 已验证`;
			renderConversation(); renderTasks(); updateSend();
		}
		const off = ctx.onData((message) => {
			if (disposed) return;
			try {
				if (message?.type === "coordinator-state") {
					if (!Array.isArray(message.state?.inputs) || !Array.isArray(message.state?.tasks) || typeof message.workspace !== "string" || !message.workspace) return;
					const changedWorkspace = workspace && workspace !== message.workspace;
					workspace = message.workspace;
					state = message.state;
					receivedAt = Date.now();
					clearTimeout(refreshTimer);
					connection.textContent = `已更新 ${new Date(receivedAt).toLocaleTimeString("zh-CN", { hour12: false })}`;
					if (outbox) for (const item of outbox.reconcile(workspace, state.inputs)) transmit(item);
					render();
					const otherWorkspace = outbox?.items.some((item) => item.workspace !== workspace);
					if (changedWorkspace || otherWorkspace) announce("工作区已切换。其他工作区的待发请求仍保留，未发送到此处；发送前请核对上方路径。");
					else if (outbox && !outbox.items.length) announce("已连接。请求保存后才算受理；停止操作需等待确认。");
				}
				if (message?.type === "coordinator-accepted") {
					outbox?.acknowledge(message.requestId);
					inFlight.delete(message.requestId);
					announce("已保存，你可以继续说。");
					requestState();
				}
				if (message?.type === "coordinator-error") {
					inFlight.delete(message.requestId);
					announce(`${gapLabel(message.error)} 原请求仍保留在待发记录中，点“刷新”可重试。`);
				}
			} catch { announce("待发记录保存失败，请保留输入并重新加载页面核对。暂不发送新请求。"); outbox = null; updateSend(); }
		});
		const submit = (event) => { event.preventDefault(); if (enqueue(input.value)) { input.value = ""; updateSend(); } };
		const keydown = (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); form.requestSubmit(); } };
		const onScroll = () => { if (conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 90) jump.hidden = true; };
		const onOnline = () => requestState(true);
		const onOffline = () => { connection.textContent = "连接已中断"; announce("待发记录保留在本机，恢复连接后可刷新重试。"); };
		input.addEventListener("keydown", keydown);
		input.addEventListener("input", updateSend);
		form.addEventListener("submit", submit);
		conversation.addEventListener("scroll", onScroll);
		window.addEventListener("online", onOnline);
		window.addEventListener("offline", onOffline);
		render(); requestState();
		return () => {
			disposed = true; clearTimeout(refreshTimer); off?.();
			input.removeEventListener("keydown", keydown); input.removeEventListener("input", updateSend);
			form.removeEventListener("submit", submit); conversation.removeEventListener("scroll", onScroll);
			window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline);
			root.remove();
		};
	},
};
