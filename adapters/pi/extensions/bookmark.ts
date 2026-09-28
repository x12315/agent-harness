/**
 * Bookmark extension — pin a pi answer and get an externally clickable link.
 *
 * Design: the label lives inside the session (`label` entries appended to the
 * original JSONL, so no history is forked or lost), while the link lives in an
 * HTML snapshot plus a markdown index under PI_BOOKMARKS_DIR.
 *
 * Usage:
 *   /bookmark [label]    label the last assistant message, re-export, copy link
 *   /bookmarks           refresh the snapshot and copy every label link
 *   /goto [label|id]     jump to a bookmark in this session (lists when omitted)
 *   /unbookmark [label]  clear a label (last labelled entry when omitted)
 *
 * The snapshot link is read-only; /goto is the way back into the live session,
 * and it only resolves against the session currently open in pi.
 *
 * Config (env):
 *   PI_BOOKMARKS_DIR       output dir, default ~/.pi/agent/bookmarks
 *   PI_BOOKMARKS_BASE_URL  serve links from here instead of file://
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

type Bookmark = { entryId: string; label: string };

function bookmarksDir(): string {
	return process.env.PI_BOOKMARKS_DIR ?? path.join(os.homedir(), ".pi", "agent", "bookmarks");
}

/** Session file basename without the .jsonl suffix; undefined for ephemeral sessions. */
function sessionSlug(ctx: ExtensionCommandContext): string | undefined {
	const file = ctx.sessionManager.getSessionFile();
	return file ? path.basename(file).replace(/\.jsonl$/, "") : undefined;
}

/** Latest label per entry, honouring clear-then-relabel ordering. */
function collectBookmarks(ctx: ExtensionCommandContext): Bookmark[] {
	const order: string[] = [];
	const labels = new Map<string, string | undefined>();
	for (const entry of ctx.sessionManager.getEntries() as SessionEntry[]) {
		if (entry.type !== "label" || !entry.targetId) continue;
		if (!labels.has(entry.targetId)) order.push(entry.targetId);
		labels.set(entry.targetId, entry.label);
	}
	return order.filter((id) => labels.get(id)).map((id) => ({ entryId: id, label: labels.get(id)! }));
}

function lastAssistantEntry(ctx: ExtensionCommandContext): SessionEntry | undefined {
	const entries = ctx.sessionManager.getEntries() as SessionEntry[];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message.role === "assistant") return entry;
	}
	return undefined;
}

/**
 * Export the session to an HTML snapshot. Uses the same `pi --export` path as
 * the CLI so the snapshot matches what /export would produce.
 */
function exportSnapshot(ctx: ExtensionCommandContext, dir: string, slug: string): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) {
		throw new Error("session is not persisted (--no-session); nothing to export");
	}
	const html = path.join(dir, `${slug}.html`);
	const result = spawnSync("pi", ["--export", sessionFile, html], { encoding: "utf-8" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(result.stderr?.trim() || `pi --export exited with ${result.status}`);
	}
	return html;
}

/** Deep link into one entry. leafId pins the viewer to the entry's own branch. */
function linkFor(html: string, slug: string, entryId: string): string {
	const base = process.env.PI_BOOKMARKS_BASE_URL
		? `${process.env.PI_BOOKMARKS_BASE_URL.replace(/\/$/, "")}/${slug}.html`
		: pathToFileURL(html).href;
	return `${base}?leafId=${entryId}&targetId=${entryId}`;
}

/** Regenerate the per-session markdown index from the session's labels. */
function writeIndex(
	ctx: ExtensionCommandContext,
	dir: string,
	slug: string,
	bookmarks: Bookmark[],
	html: string | undefined,
): string {
	const md = path.join(dir, `${slug}.md`);
	const name = ctx.sessionManager.getSessionName() ?? slug;
	const sessionFile = ctx.sessionManager.getSessionFile();
	const header = [
		`# pi bookmarks — ${name}`,
		"",
		`- session: \`${sessionFile ?? "ephemeral"}\``,
		sessionFile ? `- resume: \`pi --session "${sessionFile}"\`` : undefined,
		html ? `- snapshot: \`${html}\`` : undefined,
		sessionFile ? `- raw: <${pathToFileURL(sessionFile).href}>` : undefined,
		"- jump: open the session in pi, then `/goto <label>`",
		"",
	].filter((line): line is string => line !== undefined);
	const lines = [
		...header,
		...bookmarks.map((b) =>
			html
				? `- [${b.label}](${linkFor(html, slug, b.entryId)}) <!-- ${b.entryId} -->`
				: `- ${b.label} <!-- ${b.entryId} (no snapshot) -->`,
		),
		"",
	];
	fs.writeFileSync(md, lines.join("\n"), "utf-8");
	return md;
}

/** Best-effort lookup: which other session indexes contain this label. */
function sessionsWithLabel(dir: string, label: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const needle = `[${label}](`;
	const hits: string[] = [];
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		const text = fs.readFileSync(path.join(dir, file), "utf-8");
		if (!text.includes(needle)) continue;
		const match = text.match(/^- session: `(.+)`$/m);
		if (match) hits.push(match[1]);
	}
	return hits;
}

/** Export + rewrite the index; returns the current bookmarks and their links. */
function refresh(
	ctx: ExtensionCommandContext,
): { bookmarks: Bookmark[]; html?: string; links: string[]; md?: string } {
	const bookmarks = collectBookmarks(ctx);
	const slug = sessionSlug(ctx);
	if (!slug) return { bookmarks, links: [] };

	const dir = bookmarksDir();
	fs.mkdirSync(dir, { recursive: true });
	const html = exportSnapshot(ctx, dir, slug);
	const md = writeIndex(ctx, dir, slug, bookmarks, html);
	return { bookmarks, html, md, links: bookmarks.map((b) => linkFor(html, slug, b.entryId)) };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("bookmark", {
		description: "Bookmark last message and copy a clickable link (usage: /bookmark [label])",
		handler: async (args, ctx) => {
			const label = args.trim() || `bookmark-${new Date().toISOString().slice(0, 16)}`;
			const entry = lastAssistantEntry(ctx);
			if (!entry) {
				ctx.ui.notify("No assistant message to bookmark", "warning");
				return;
			}
			pi.setLabel(entry.id, label);
			try {
				const { bookmarks, links, html } = refresh(ctx);
				const index = bookmarks.findIndex((b) => b.entryId === entry.id);
				const link = index >= 0 ? links[index] : undefined;
				if (link) {
					await copyToClipboard(link);
					ctx.ui.notify(`Bookmarked "${label}" — link copied\n${link}`, "info");
				} else {
					ctx.ui.notify(`Bookmarked "${label}" (snapshot: ${html})`, "info");
				}
			} catch (error) {
				ctx.ui.notify(
					`Bookmarked "${label}", but export failed: ${error instanceof Error ? error.message : error}`,
					"warning",
				);
			}
		},
	});

	pi.registerCommand("bookmarks", {
		description: "Refresh the snapshot and copy every bookmark link in this session",
		handler: async (_args, ctx) => {
			let result: ReturnType<typeof refresh>;
			try {
				result = refresh(ctx);
			} catch (error) {
				ctx.ui.notify(`Export failed: ${error instanceof Error ? error.message : error}`, "error");
				return;
			}
			if (!result.bookmarks.length) {
				ctx.ui.notify("No bookmarks in this session", "warning");
				return;
			}
			await copyToClipboard(result.links.join("\n"));
			const list = result.bookmarks.map((b) => `• ${b.label}`).join("\n");
			ctx.ui.notify(`Copied ${result.bookmarks.length} link(s):\n${list}`, "info");
		},
	});

	pi.registerCommand("goto", {
		description: "Jump to a bookmark in this session (usage: /goto [label|entryId])",
		handler: async (args, ctx) => {
			const query = args.trim();
			const bookmarks = collectBookmarks(ctx);

			if (!query) {
				if (!bookmarks.length) {
					ctx.ui.notify("No bookmarks in this session", "warning");
					return;
				}
				await copyToClipboard(bookmarks.map((b) => b.label).join("\n"));
				const list = bookmarks.map((b) => `• ${b.label} (${b.entryId})`).join("\n");
				ctx.ui.notify(`Bookmarks in this session:\n${list}`, "info");
				return;
			}

			// Resolve by exact entry id first, then by label, then accept any
			// entry id present in the session (bookmarked or not).
			const byId = bookmarks.find((b) => b.entryId === query);
			const byLabel = byId ? [] : bookmarks.filter((b) => b.label === query);
			const target = byId ?? byLabel[0] ?? { entryId: query, label: query };

			if (!byId && !byLabel.length && !ctx.sessionManager.getEntry(query)) {
				const elsewhere = sessionsWithLabel(bookmarksDir(), query).filter(
					(p) => p !== ctx.sessionManager.getSessionFile(),
				);
				const hint = elsewhere.length
					? `\nFound in another session — open it first:\n${elsewhere.map((p) => `pi --session "${p}"`).join("\n")}`
					: `\n/goto only resolves within the session currently open in pi.`;
				ctx.ui.notify(`No bookmark or entry "${query}" in this session.${hint}`, "warning");
				return;
			}

			try {
				await ctx.navigateTree(target.entryId);
				if (byLabel.length > 1) {
					ctx.ui.notify(`Jumped to "${query}" (${byLabel.length} entries share this label; used the first)`, "warning");
				}
			} catch (error) {
				ctx.ui.notify(
					`Cannot navigate here: ${error instanceof Error ? error.message : error}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("unbookmark", {
		description: "Clear a label (usage: /unbookmark [label]; defaults to the last one)",
		handler: async (args, ctx) => {
			const wanted = args.trim();
			const bookmarks = collectBookmarks(ctx);
			const targets = wanted ? bookmarks.filter((b) => b.label === wanted) : bookmarks.slice(-1);
			if (!targets.length) {
				ctx.ui.notify(wanted ? `No bookmark named "${wanted}"` : "No bookmarks to clear", "warning");
				return;
			}
			for (const target of targets) pi.setLabel(target.entryId, undefined);
			try {
				refresh(ctx);
			} catch (error) {
				ctx.ui.notify(`Cleared, but export failed: ${error instanceof Error ? error.message : error}`, "warning");
				return;
			}
			ctx.ui.notify(`Removed ${targets.length} bookmark(s): ${targets.map((t) => t.label).join(", ")}`, "info");
		},
	});
}
