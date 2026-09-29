import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const REPO = join(homedir(), ".agents");
const HARNESS_SCRIPT = join(REPO, "scripts", "harness.mjs");
const PROFILES_DIR = join(REPO, "profiles");
const ACTIONS = ["status", "profiles", "switch", "edit", "apply", "doctor", "restore", "help"];
const HELP = `Harness Control Plane / Harness 管理面

/harness                       打开管理面
/harness status                查看 catalog 与 runtime 状态
/harness profiles              查看全部 Profile
/harness switch <name>         切换当前 Pi 工作 Profile
/harness edit <name>           编辑中立 Profile 并应用
/harness apply                 生成、投影并验收
/harness doctor                运行只读完整检查
/harness restore               通过官方工具恢复声明依赖

这是人类触发的管理命令，不受当前工作 Profile 的 tools 权限约束。`;

function profileNames(): string[] {
	if (!existsSync(PROFILES_DIR)) return [];
	return readdirSync(PROFILES_DIR)
		.filter((name) => name.endsWith(".json") && name !== "profile.schema.json")
		.map((name) => basename(name, ".json"))
		.sort();
}

function compactOutput(stdout: string, stderr: string): string {
	const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
	if (!text) return "Command completed with no output.";
	return text.length > 12_000 ? `${text.slice(0, 12_000)}\n… output truncated` : text;
}

export default function harnessManager(pi: ExtensionAPI) {
	async function runHarness(args: string[], ctx: ExtensionCommandContext, timeout = 600_000) {
		ctx.ui.setStatus("harness-manager", `harness ${args.join(" ")}`);
		try {
			return await pi.exec(process.execPath, [HARNESS_SCRIPT, ...args], { timeout });
		} finally {
			ctx.ui.setStatus("harness-manager", undefined);
		}
	}

	async function notifyRun(args: string[], ctx: ExtensionCommandContext, timeout?: number): Promise<boolean> {
		const result = await runHarness(args, ctx, timeout);
		ctx.ui.notify(compactOutput(result.stdout, result.stderr), result.code === 0 ? "info" : "error");
		return result.code === 0;
	}

	async function chooseProfile(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
		const names = profileNames();
		if (!names.length) {
			ctx.ui.notify(`No profiles found in ${PROFILES_DIR}`, "error");
			return undefined;
		}
		return ctx.ui.select(title, names);
	}

	async function switchProfile(name: string | undefined, ctx: ExtensionCommandContext) {
		const selected = name || await chooseProfile(ctx, "选择工作 Profile");
		if (!selected) return;
		if (!profileNames().includes(selected)) {
			ctx.ui.notify(`Unknown profile "${selected}"`, "error");
			return;
		}
		pi.sendUserMessage(`/profile use ${selected}`, { expandPromptTemplates: true });
	}

	async function editProfile(name: string | undefined, ctx: ExtensionCommandContext) {
		const selected = name || await chooseProfile(ctx, "选择要编辑的 Profile");
		if (!selected) return;
		const source = join(PROFILES_DIR, `${selected}.json`);
		if (!existsSync(source)) {
			ctx.ui.notify(`Unknown profile "${selected}"`, "error");
			return;
		}
		const original = readFileSync(source, "utf8");
		const edited = await ctx.ui.editor(`编辑中立 Profile：${selected}`, original);
		if (edited === undefined || edited === original) return;
		try {
			JSON.parse(edited);
		} catch (error) {
			ctx.ui.notify(`Invalid JSON; nothing changed: ${error instanceof Error ? error.message : error}`, "error");
			return;
		}
		if (!await ctx.ui.confirm("应用 Profile 修改？", `更新 ${source}，重新生成 Pi/Codex adapter 并运行验收。`)) return;

		const backup = join(tmpdir(), `harness-${selected}-${Date.now()}.json`);
		const temporary = `${source}.tmp-${process.pid}`;
		writeFileSync(backup, original);
		writeFileSync(temporary, edited.endsWith("\n") ? edited : `${edited}\n`);
		renameSync(temporary, source);

		const composed = await runHarness(["compose", "--apply"], ctx, 60_000);
		if (composed.code !== 0) {
			writeFileSync(source, original);
			await runHarness(["compose", "--apply"], ctx, 60_000);
			ctx.ui.notify(`Profile rejected and restored. Backup: ${backup}\n${compactOutput(composed.stdout, composed.stderr)}`, "error");
			return;
		}
		const projected = await runHarness(["bootstrap", "--apply"], ctx, 60_000);
		if (projected.code !== 0) {
			ctx.ui.notify(`Profile compiled, but projection failed. Backup: ${backup}\n${compactOutput(projected.stdout, projected.stderr)}`, "error");
			return;
		}
		const verified = await runHarness(["doctor"], ctx);
		ctx.ui.notify(
			`${verified.code === 0 ? `Updated ${selected} across Pi and Codex.` : `Updated ${selected}, but verification failed.`}\nBackup: ${backup}\n${compactOutput(verified.stdout, verified.stderr)}`,
			verified.code === 0 ? "info" : "error",
		);
	}

	async function mutate(action: "apply" | "restore", args: string[], ctx: ExtensionCommandContext) {
		const confirmed = args.includes("--yes") || await ctx.ui.confirm(
			`${action === "apply" ? "应用 Catalog" : "恢复依赖"}？`,
			action === "apply"
				? "Regenerate adapters, repair managed projections, and run verification."
				: "Delegate installation to the pinned official tools, then run verification.",
		);
		if (!confirmed) return;
		if (action === "apply") await notifyRun(["apply"], ctx);
		else if (await notifyRun(["restore", "--apply"], ctx)) await notifyRun(["doctor"], ctx);
	}

	async function handle(raw: string, ctx: ExtensionCommandContext) {
		const words = raw.trim().split(/\s+/).filter(Boolean);
		const action = words[0] ?? "";
		if (action === "help") ctx.ui.notify(HELP, "info");
		else if (action === "status") await notifyRun(["status"], ctx, 30_000);
		else if (action === "profiles") await notifyRun(["profile", "list"], ctx, 30_000);
		else if (action === "switch") await switchProfile(words[1], ctx);
		else if (action === "edit") await editProfile(words[1], ctx);
		else if (action === "apply") await mutate("apply", words.slice(1), ctx);
		else if (action === "doctor") await notifyRun(["doctor"], ctx);
		else if (action === "restore") await mutate("restore", words.slice(1), ctx);
		else if (action) ctx.ui.notify(`Unknown harness action "${action}".\n\n${HELP}`, "error");
		else if (ctx.mode !== "tui") ctx.ui.notify(HELP, "info");
		else {
			const selected = await ctx.ui.select("Harness 管理面", [
				"查看状态",
				"切换工作 Profile",
				"编辑 Profile",
				"应用 Catalog",
				"完整检查",
				"恢复依赖",
			]);
			if (selected === "查看状态") await handle("status", ctx);
			else if (selected === "切换工作 Profile") await handle("switch", ctx);
			else if (selected === "编辑 Profile") await handle("edit", ctx);
			else if (selected === "应用 Catalog") await handle("apply", ctx);
			else if (selected === "完整检查") await handle("doctor", ctx);
			else if (selected === "恢复依赖") await handle("restore", ctx);
		}
	}

	pi.registerCommand("harness", {
		description: "管理跨 harness 的 catalog、Profile、投影与健康状态",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const [action = "", value = ""] = prefix.split(/\s+/, 2);
			if (["switch", "edit"].includes(action)) {
				const items = profileNames().filter((name) => name.startsWith(value)).map((name) => ({ value: `${action} ${name}`, label: name }));
				return items.length ? items : null;
			}
			const items = ACTIONS.filter((name) => name.startsWith(action)).map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		handler: handle,
	});
}
