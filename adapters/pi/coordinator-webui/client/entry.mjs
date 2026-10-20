import { Outbox } from "./outbox.mjs";

const labels = { pending: "已收件", classified: "已安排", question: "已回答", clarify: "需要澄清", queued: "等待执行", starting: "正在启动", running: "后台执行与审查中", stopping: "等待停止确认", paused: "已暂停", cancelled: "已取消", failed: "审查未通过", verified: "原生审查与目标覆盖检查通过", needs_reconciliation: "需要核对执行状态" };
const node = (tag, text) => { const el = document.createElement(tag); if (text != null) el.textContent = text; return el; };

/** A free-form inbox; UI state never acknowledges work before durable receipt. */
export default {
	mount(el, ctx) {
		const root = node("section");
		root.style.cssText = "padding:24px;max-width:1000px;margin:auto;display:grid;gap:18px;color:inherit;font:inherit";
		const title = node("h2", "说你的需求，任务在后台继续");
		const hint = node("p", "随时提问、补充或纠正方向。不必替 AI 维护待办；停止请求要等执行侧确认。实验版仅管理此入口收到的任务。");
		hint.style.cssText = "opacity:.7;max-width:76ch;line-height:1.6";
		const form = node("form"), input = node("textarea"), send = node("button", "发送"), feedback = node("p");
		input.placeholder = "例如：先调查偶发超时；同时别动部署。";
		input.setAttribute("aria-label", "自由表达需求");
		input.rows = 3; input.style.cssText = "width:100%;box-sizing:border-box;padding:12px;background:transparent;color:inherit;border:1px solid #777;border-radius:8px;font:inherit;resize:vertical";
		send.type = "submit"; send.style.cssText = "margin-top:8px;padding:7px 18px;font:inherit;cursor:pointer";
		feedback.setAttribute("role", "status");
		const conversation = node("div"), taskList = node("div");
		form.append(input, send, feedback); root.append(title, hint, form, node("h3", "已接住的需求"), conversation, node("h3", "后台任务"), taskList); el.replaceChildren(root);
		let outbox, workspace;
		try { outbox = new Outbox(sessionStorage); }
		catch { feedback.textContent = "浏览器无法保存待发请求，暂不发送，避免刷新后丢失。"; }
		send.disabled = true;
		const transmit = (item) => ctx.send({ type: "coordinator-input", ...item });
		const render = (state) => {
			conversation.replaceChildren(); taskList.replaceChildren();
			for (const item of state.inputs.slice(-12)) {
				const row = node("article"); row.style.cssText = "padding:10px 0;border-bottom:1px solid #7774;white-space:pre-wrap;overflow-wrap:anywhere";
				row.append(node("small", `${labels[item.status] || item.status} · ${new Date(item.acceptedAt).toLocaleTimeString()}`), node("p", item.text));
				if (item.answer) row.append(node("p", item.answer)); conversation.append(row);
			}
			if (!state.inputs.length) conversation.append(node("p", "还没有请求。发送后先保存，再判断如何安排。"));
			for (const task of state.tasks) {
				const row = node("article"); row.style.cssText = "padding:12px 0;border-bottom:1px solid #7774;overflow-wrap:anywhere";
				row.append(node("strong", `${task.id} · ${labels[task.status] || task.status}`), node("p", task.objective));
				for (const amendment of task.amendments) row.append(node("p", `补充：${amendment.text}`));
				if (task.gap) row.append(node("p", `未完成：${task.gap}`));
				if (task.startedAt) row.append(node("small", `开始 ${new Date(task.startedAt).toLocaleTimeString()}；下次检查 ${task.nextCheckAt ? new Date(task.nextCheckAt).toLocaleTimeString() : "—"}`));
				taskList.append(row);
			}
			if (!state.tasks.length) taskList.append(node("p", "还没有已派发任务。普通讨论不会自动变成执行授权。"));
		};
		const off = ctx.onData((message) => {
			try {
				if (message?.type === "coordinator-state") {
					workspace = message.workspace; render(message.state);
					send.disabled = !workspace || !outbox;
					if (outbox) for (const item of outbox.reconcile(workspace, message.state.inputs)) transmit(item);
				}
				if (message?.type === "coordinator-accepted") { outbox?.acknowledge(message.requestId); feedback.textContent = "已保存，你可以继续说。"; }
				if (message?.type === "coordinator-error") {
					const text = outbox?.items.find((item) => item.requestId === message.requestId)?.text;
					if (text && !input.value) input.value = text;
					feedback.textContent = `${message.error} 原请求仍保留在待发记录中。`;
				}
			} catch { feedback.textContent = "本机待发记录保存失败，请保留输入并重新核对。"; send.disabled = true; }
		});
		const submit = (event) => {
			event.preventDefault(); const text = input.value.trim(); if (!text) return;
			if (!outbox || !workspace) return;
			const requestId = crypto.randomUUID();
			try {
				const item = { requestId, text, workspace }; outbox.add(item); transmit(item);
				input.value = ""; feedback.textContent = "正在保存，尚未确认受理…";
			} catch { feedback.textContent = "未能发送；文本保留在输入框或本机待发记录，请检查连接。"; }
		};
		const keydown = (event) => {
			if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
		};
		input.addEventListener("keydown", keydown); form.addEventListener("submit", submit); ctx.send({ type: "coordinator-get" });
		return () => { off(); input.removeEventListener("keydown", keydown); form.removeEventListener("submit", submit); root.remove(); };
	},
};
