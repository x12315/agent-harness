import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const reloadKey = Symbol.for("agent-harness.iterm-bell.reload.v1");
const reloadCache = ((globalThis as typeof globalThis & { [reloadKey]?: Map<string, string> })[reloadKey] ??= new Map());

/** Render session-local attention and ring once per event, including across reload; never control a terminal. */
export default function (pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let id: string | undefined;
	let observerConnected = false;
	let lastRung: string | undefined;
	const clear = () => {
		if (ctx?.mode === "tui") {
			ctx.ui.setWidget("observer-attention", undefined);
			ctx.ui.setStatus("observer-attention", undefined);
		}
	};
	const ring = () => {
		if (ctx?.mode === "tui" && process.stdout.isTTY && process.env.TERM_PROGRAM === "iTerm.app") process.stdout.write("\x07");
	};
	const off = pi.events.on("observer:attention", (data: unknown) => {
		if (!ctx || !data || typeof data !== "object") return;
		const value = data as { schemaVersion?: unknown; id?: unknown; workspace?: unknown; attention?: unknown };
		if (value.schemaVersion !== 1 || value.id !== id) return;
		observerConnected = true;
		if (!value.attention) { lastRung = undefined; clear(); return; }
		if (typeof value.attention !== "object") return;
		const attention = value.attention as { id?: unknown; reason?: unknown; acknowledgedAt?: unknown };
		if (typeof attention.id !== "string" || !["reply", "approval", "error"].includes(String(attention.reason))) return;
		if (attention.acknowledgedAt) { clear(); return; }
		const reason = attention.reason === "approval" ? "需要确认" : attention.reason === "error" ? "本轮出错，等待处理" : "本轮已结束，等待下一步";
		const workspace = typeof value.workspace === "string" ? path.basename(value.workspace) : "Pi";
		const label = stripVTControlCharacters(`${reason} · ${workspace} · ${id}`).replace(/[\u0000-\u001f\u007f]/g, "");
		if (ctx.mode === "tui") {
			ctx.ui.setStatus("observer-attention", `● ${reason} · ${workspace}`);
			ctx.ui.setWidget("observer-attention", (_tui, theme) => ({
				render: (width) => [truncateToWidth(theme.fg("warning", `待你处理 · ${label}`), width), truncateToWidth(theme.fg("muted", "/observer ack 标记已读；发送下一步请求才会清除待处理状态。"), width)],
				invalidate() {},
			}));
		}
		if (lastRung !== attention.id) { lastRung = attention.id; ring(); }
	});
	const bind = (event: { reason?: string }, context: ExtensionContext) => {
		ctx = context; clear();
		id = `${process.pid}-${context.sessionManager.getSessionId()}`;
		observerConnected = false;
		lastRung = event.reason === "reload" ? reloadCache.get(id) : undefined;
		reloadCache.delete(id);
		pi.events.emit("observer:request", { id });
	};
	pi.on("session_start", bind);
	pi.on("session_switch", bind);
	pi.on("session_fork", bind);
	pi.on("agent_start", () => { lastRung = undefined; clear(); });
	pi.on("agent_settled", (event, context) => {
		ctx = context;
		if (!observerConnected && !event.aborted) ring();
	});
	pi.on("session_shutdown", (event) => {
		if (id) {
			if (event.reason === "reload" && lastRung) {
				reloadCache.set(id, lastRung);
				if (reloadCache.size > 128) reloadCache.delete(reloadCache.keys().next().value!);
			} else reloadCache.delete(id);
		}
		clear(); off(); ctx = undefined;
	});
}
