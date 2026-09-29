import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Container,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";

const REPO = join(homedir(), ".agents");
const HARNESS_SCRIPT = join(REPO, "scripts", "harness.mjs");
const PROFILES_DIR = join(REPO, "profiles");
const SKILLS_DIR = join(REPO, "skills");
const ACTIONS = ["status", "profiles", "configure", "switch", "apply", "doctor", "restore", "help"];
const GUIDANCE_MODULES = ["profile/model-weak", "profile/model-standard"];
const GUIDANCE_LABELS = {
	weak: "弱模型 · 强约束、逐步验证",
	standard: "标准模型 · 适度计划与验证",
	strong: "强模型 · 最小额外约束",
} as const;
type Guidance = keyof typeof GUIDANCE_LABELS;

const FULL_EXTENSIONS = ["bookmark", "handoff", "harness-manager", "pi-goal-x", "pi-web-ui", "subagent"];
const EXECUTION_MODES = {
	"只读探索": { piTools: ["read", "grep", "find", "ls"], extensions: ["harness-manager"], codexSandbox: "read-only", approval: "never", behavior: "read-only" },
	"检索调研": { piTools: ["read", "bash", "grep", "find", "ls"], extensions: ["harness-manager"], codexSandbox: "read-only", approval: "never", behavior: "research" },
	"编码实现": { piTools: ["read", "bash", "edit", "write", "grep", "find", "ls"], extensions: ["bookmark", "handoff", "harness-manager"], codexSandbox: "workspace-write", approval: "on-request", behavior: "implementation" },
	"全量能力": { piTools: undefined, extensions: FULL_EXTENSIONS, codexSandbox: "workspace-write", approval: "on-request", behavior: "implementation" },
} as const;
type ExecutionMode = keyof typeof EXECUTION_MODES;

type ProfileSource = {
	label: string;
	description: string;
	instructions: string[];
	skills: string[];
	adapters: {
		pi: {
			tools?: string[];
			extensions: string[];
			mcps?: string[];
			model?: { provider: string; id: string; thinking?: string };
		};
		codex: {
			sandbox?: string;
			approval?: string;
			model?: { id: string; thinking?: string };
		};
	};
};

const HELP = `Harness Control Plane / Harness 管理面

/harness                         打开管理面
/harness status                  查看 catalog 与 runtime 状态
/harness profiles                查看全部 Profile
/harness configure <name>        用开关和表单配置 Profile
/harness switch <name>           切换当前 Pi 工作 Profile
/harness apply                   生成、投影并验收
/harness doctor                  运行只读完整检查
/harness restore                 通过官方工具恢复声明依赖
/harness edit <name>             高级：直接编辑 JSON

这是人类触发的管理命令，不受当前工作 Profile 的 tools 权限约束。`;

function profileNames(): string[] {
	if (!existsSync(PROFILES_DIR)) return [];
	return readdirSync(PROFILES_DIR)
		.filter((name) => name.endsWith(".json") && name !== "profile.schema.json")
		.map((name) => basename(name, ".json"))
		.sort();
}

function catalogSkillNames(): string[] {
	if (!existsSync(SKILLS_DIR)) return [];
	return readdirSync(SKILLS_DIR, { withFileTypes: true })
		.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && existsSync(join(SKILLS_DIR, entry.name, "SKILL.md")))
		.map((entry) => entry.name)
		.sort();
}

function skillCategory(name: string): string {
	if (["git-commit", "make-repo-contribution", "finishing-a-development-branch", "using-git-worktrees"].includes(name)) return "Git";
	if (["ponytail", "self-explanatory-code", "brainstorming", "writing-plans", "executing-plans", "subagent-driven-development"].includes(name)) return "编码规范";
	if (["agent-browser", "lark-doc", "lark-drive", "lark-wiki", "lark-sheets", "lark-base", "lark-meeting"].includes(name)) return "检索";
	if (name.startsWith("lark-")) return "飞书";
	if (["frontend-design", "ui-ux-pro-max", "macos-design", "implementing-drag-drop"].includes(name)) return "设计";
	return "其他";
}

function selectedSkillNames(profile: ProfileSource, catalog: string[]): Set<string> {
	if (profile.skills.includes("*")) return new Set(catalog);
	const selected = new Set<string>();
	for (const pattern of profile.skills) {
		const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
		for (const name of catalog) if (regex.test(name)) selected.add(name);
	}
	return selected;
}

function guidanceOf(profile: ProfileSource): Guidance {
	if (profile.instructions.includes("profile/model-weak")) return "weak";
	if (profile.instructions.includes("profile/model-standard")) return "standard";
	return "strong";
}

function setExecutionBehavior(profile: ProfileSource, behavior: "read-only" | "research" | "implementation") {
	const behaviorModules = ["profile/read-only", "profile/research", "profile/implementation"];
	const instructions = profile.instructions.filter((id) => !behaviorModules.includes(id));
	const selected = behavior === "research"
		? ["profile/read-only", "profile/research"]
		: [`profile/${behavior}`];
	const guidanceIndex = instructions.findIndex((id) => GUIDANCE_MODULES.includes(id) || id === "profile/concise");
	instructions.splice(guidanceIndex < 0 ? instructions.length : guidanceIndex, 0, ...selected);
	profile.instructions = instructions;
}

function setGuidance(profile: ProfileSource, guidance: Guidance) {
	const instructions = profile.instructions.filter((id) => !GUIDANCE_MODULES.includes(id));
	const module = guidance === "strong" ? undefined : `profile/model-${guidance}`;
	if (module) {
		const concise = instructions.indexOf("profile/concise");
		instructions.splice(concise < 0 ? instructions.length : concise, 0, module);
	}
	profile.instructions = instructions;
}

function sameSet(a: string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === undefined && b === undefined;
	return a.length === b.length && a.every((value) => b.includes(value));
}

function executionModeOf(profile: ProfileSource): ExecutionMode | "自定义" {
	for (const [label, mode] of Object.entries(EXECUTION_MODES) as [ExecutionMode, { piTools: readonly string[] | undefined; extensions: readonly string[]; codexSandbox: string; approval: string; behavior: "read-only" | "research" | "implementation" }][]) {
		const has = (id: string) => profile.instructions.includes(id);
		const behaviorMatches = mode.behavior === "research"
			? has("profile/read-only") && has("profile/research") && !has("profile/implementation")
			: mode.behavior === "read-only"
				? has("profile/read-only") && !has("profile/research") && !has("profile/implementation")
				: has("profile/implementation") && !has("profile/read-only") && !has("profile/research");
		if (sameSet(profile.adapters.pi.tools, mode.piTools)
			&& sameSet(profile.adapters.pi.extensions, mode.extensions)
			&& profile.adapters.codex.sandbox === mode.codexSandbox
			&& profile.adapters.codex.approval === mode.approval
			&& behaviorMatches) return label;
	}
	return "自定义";
}

function compactOutput(stdout: string, stderr: string): string {
	const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
	if (!text) return "命令执行完成，没有输出。";
	return text.length > 12_000 ? `${text.slice(0, 12_000)}\n… output truncated` : text;
}

export default function harnessManager(pi: ExtensionAPI) {
	async function runHarness(args: string[], ctx: ExtensionCommandContext, timeout = 600_000) {
		ctx.ui.setStatus("harness-manager", `harness ${args.join(" ")}`);
		try {
			// Status intentionally sees the active profile. Other management commands
			// must escape its frozen runtime dir and inspect the real global harness.
			if (args[0] === "status") return await pi.exec(process.execPath, [HARNESS_SCRIPT, ...args], { timeout });
			return await pi.exec("env", ["-u", "PI_CODING_AGENT_DIR", process.execPath, HARNESS_SCRIPT, ...args], { timeout });
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
			ctx.ui.notify(`没有在 ${PROFILES_DIR} 找到 Profile`, "error");
			return undefined;
		}
		return ctx.ui.select(title, names);
	}

	async function applyProfileSource(
		name: string,
		source: string,
		original: string,
		edited: string,
		ctx: ExtensionCommandContext,
	) {
		const backup = join(tmpdir(), `harness-${name}-${Date.now()}.json`);
		const temporary = `${source}.tmp-${process.pid}`;
		writeFileSync(backup, original);
		writeFileSync(temporary, edited.endsWith("\n") ? edited : `${edited}\n`);
		renameSync(temporary, source);

		const rollback = async (): Promise<{ ok: boolean; detail: string }> => {
			try { writeFileSync(source, original); }
			catch (error) { return { ok: false, detail: `源码恢复失败：${error instanceof Error ? error.message : error}` }; }
			const recomposed = await runHarness(["compose", "--apply"], ctx, 60_000);
			if (recomposed.code !== 0) return { ok: false, detail: `重新生成失败：${compactOutput(recomposed.stdout, recomposed.stderr)}` };
			const reprojected = await runHarness(["bootstrap", "--apply"], ctx, 60_000);
			if (reprojected.code !== 0) return { ok: false, detail: `重新投影失败：${compactOutput(reprojected.stdout, reprojected.stderr)}` };
			const reverified = await runHarness(["doctor"], ctx);
			return {
				ok: reverified.code === 0,
				detail: reverified.code === 0 ? "原配置已恢复并通过完整复验。" : `原配置已写回，但复验失败：${compactOutput(reverified.stdout, reverified.stderr)}`,
			};
		};
		const rejectAndRollback = async (reason: string, failed: { stdout: string; stderr: string }) => {
			const restored = await rollback();
			ctx.ui.notify(
				`${reason}。${restored.ok ? "已安全恢复。" : "恢复未完整确认，请停止继续配置并运行 harness doctor。"}\n备份：${backup}\n${compactOutput(failed.stdout, failed.stderr)}\n\n${restored.detail}`,
				"error",
			);
		};
		const composed = await runHarness(["compose", "--apply"], ctx, 60_000);
		if (composed.code !== 0) {
			await rejectAndRollback("Profile 未通过验证", composed);
			return;
		}
		const projected = await runHarness(["bootstrap", "--apply"], ctx, 60_000);
		if (projected.code !== 0) {
			await rejectAndRollback("Profile 投影失败", projected);
			return;
		}
		const verified = await runHarness(["doctor"], ctx);
		if (verified.code !== 0) {
			await rejectAndRollback("完整检查失败", verified);
			return;
		}
		ctx.ui.notify(`已更新 ${name}，新会话已生效。如果当前正在使用 ${name}，运行 /profile reload 可立即重载；否则在需要时切换到该 Profile。\n备份：${backup}\n${compactOutput(verified.stdout, verified.stderr)}`, "info");
	}

	async function switchProfile(name: string | undefined, ctx: ExtensionCommandContext) {
		const selected = name || await chooseProfile(ctx, "选择工作 Profile");
		if (!selected) return;
		if (!profileNames().includes(selected)) {
			ctx.ui.notify(`未知 Profile：${selected}`, "error");
			return;
		}
		pi.sendUserMessage(`/profile use ${selected}`, { expandPromptTemplates: true });
	}

	async function configureSkills(profile: ProfileSource, ctx: ExtensionCommandContext) {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Skills 开关需要 Pi TUI；请在交互会话中运行 /harness configure。", "error");
			return;
		}
		const catalog = catalogSkillNames();
		const selected = selectedSkillNames(profile, catalog);
		const initialSelection = new Set(selected);
		const ordered = catalog.sort((a, b) => `${skillCategory(a)} ${a}`.localeCompare(`${skillCategory(b)} ${b}`));
		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Skills 开关（可直接输入关键词搜索）")), 1, 0));
			if (profile.skills.some((pattern) => pattern.includes("*") || pattern.includes("?"))) {
				container.addChild(new Text(theme.fg("muted", "当前使用自动匹配；首次切换后会固定为显式清单。"), 1, 0));
			}
			const items: SettingItem[] = ordered.map((name) => ({
				id: name,
				label: `${skillCategory(name)} · ${name}`,
				currentValue: selected.has(name) ? "启用" : "关闭",
				values: ["启用", "关闭"],
			}));
			const settings = new SettingsList(
				items,
				Math.min(items.length + 2, 20),
				getSettingsListTheme(),
				(id, value) => {
					if (value === "启用") selected.add(id);
					else selected.delete(id);
				},
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(settings);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settings.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
		const selectionChanged = selected.size !== initialSelection.size
			|| [...selected].some((name) => !initialSelection.has(name));
		if (selectionChanged) profile.skills = [...selected].sort();
	}

	async function configureModels(profile: ProfileSource, ctx: ExtensionCommandContext) {
		const currentPi = profile.adapters.pi.model;
		const piProvider = await ctx.ui.input(`Pi provider（当前：${currentPi?.provider ?? "继承"}）`, "留空保持当前");
		if (piProvider === undefined) return;
		const piModel = await ctx.ui.input(`Pi model（当前：${currentPi?.id ?? "继承"}）`, "留空保持当前");
		if (piModel === undefined) return;
		const codexModel = await ctx.ui.input(`Codex model（当前：${profile.adapters.codex.model?.id ?? "继承"}）`, "留空保持当前");
		if (codexModel === undefined) return;
		if (piProvider.trim() || piModel.trim()) {
			profile.adapters.pi.model = {
				provider: piProvider.trim() || currentPi?.provider || "openai-codex",
				id: piModel.trim() || currentPi?.id || "gpt-5.5",
				...(currentPi?.thinking ? { thinking: currentPi.thinking } : {}),
			};
		}
		if (codexModel.trim()) {
			profile.adapters.codex.model = {
				id: codexModel.trim(),
				...(profile.adapters.codex.model?.thinking ? { thinking: profile.adapters.codex.model.thinking } : {}),
			};
		}
	}

	async function configureProfile(name: string | undefined, ctx: ExtensionCommandContext) {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("友好配置器需要 Pi TUI。可使用 /harness status 查看状态。", "error");
			return;
		}
		const selected = name || await chooseProfile(ctx, "选择要配置的 Profile");
		if (!selected) return;
		const source = join(PROFILES_DIR, `${selected}.json`);
		if (!existsSync(source)) {
			ctx.ui.notify(`未知 Profile：${selected}`, "error");
			return;
		}
		const original = readFileSync(source, "utf8");
		let draft: ProfileSource;
		try { draft = structuredClone(JSON.parse(original)); }
		catch (error) {
			ctx.ui.notify(`Profile 无法读取：${error instanceof Error ? error.message : error}`, "error");
			return;
		}

		while (true) {
			const skills = selectedSkillNames(draft, catalogSkillNames());
			const guidance = guidanceOf(draft);
			const executionMode = executionModeOf(draft);
			const choice = await ctx.ui.select(`配置 ${selected} · ${draft.description}`, [
				`模型能力指导：${GUIDANCE_LABELS[guidance]}`,
				`Skills 开关：${skills.size}/${catalogSkillNames().length} 已启用`,
				`执行权限：${executionMode}`,
				`推荐模型：Pi ${draft.adapters.pi.model?.provider ?? "inherit"}/${draft.adapters.pi.model?.id ?? "inherit"} · Codex ${draft.adapters.codex.model?.id ?? "inherit"}`,
				"保存并应用",
				"取消",
			]);
			if (!choice || choice === "取消") return;
			if (choice.startsWith("模型能力指导")) {
				const label = await ctx.ui.select("当前模型能力", Object.values(GUIDANCE_LABELS));
				const value = (Object.entries(GUIDANCE_LABELS) as [Guidance, string][]).find(([, text]) => text === label)?.[0];
				if (value) setGuidance(draft, value);
			} else if (choice.startsWith("Skills 开关")) {
				await configureSkills(draft, ctx);
			} else if (choice.startsWith("执行权限")) {
				const mode = await ctx.ui.select("跨 Harness 执行权限", Object.keys(EXECUTION_MODES));
				if (mode && mode in EXECUTION_MODES) {
					const selectedMode = EXECUTION_MODES[mode as ExecutionMode];
					if (selectedMode.piTools) draft.adapters.pi.tools = [...selectedMode.piTools];
					else delete draft.adapters.pi.tools;
					draft.adapters.pi.extensions = [...selectedMode.extensions];
					draft.adapters.codex.sandbox = selectedMode.codexSandbox;
					draft.adapters.codex.approval = selectedMode.approval;
					setExecutionBehavior(draft, selectedMode.behavior);
				}
			} else if (choice.startsWith("推荐模型")) {
				await configureModels(draft, ctx);
			} else if (choice === "保存并应用") {
				const summary = [
					`Profile：${selected}`,
					`模型能力：${GUIDANCE_LABELS[guidanceOf(draft)]}`,
					`Skills：${selectedSkillNames(draft, catalogSkillNames()).size}/${catalogSkillNames().length}`,
					`执行权限：${executionModeOf(draft)}`,
					`Pi 模型：${draft.adapters.pi.model?.provider ?? "inherit"}/${draft.adapters.pi.model?.id ?? "inherit"}`,
					`Codex 模型：${draft.adapters.codex.model?.id ?? "inherit"}`,
				].join("\n");
				if (!await ctx.ui.confirm("保存并应用？", summary)) continue;
				await applyProfileSource(selected, source, original, `${JSON.stringify(draft, null, 2)}\n`, ctx);
				return;
			}
		}
	}

	async function editProfile(name: string | undefined, ctx: ExtensionCommandContext) {
		const selected = name || await chooseProfile(ctx, "高级：选择要直接编辑的 Profile");
		if (!selected) return;
		const source = join(PROFILES_DIR, `${selected}.json`);
		if (!existsSync(source)) {
			ctx.ui.notify(`未知 Profile：${selected}`, "error");
			return;
		}
		const original = readFileSync(source, "utf8");
		const edited = await ctx.ui.editor(`高级 JSON 编辑：${selected}`, original);
		if (edited === undefined || edited === original) return;
		try { JSON.parse(edited); }
		catch (error) {
			ctx.ui.notify(`JSON 无效，未修改：${error instanceof Error ? error.message : error}`, "error");
			return;
		}
		if (!await ctx.ui.confirm("应用高级修改？", `更新 ${source}，重新生成 Pi/Codex adapter 并运行验收。`)) return;
		await applyProfileSource(selected, source, original, edited, ctx);
	}

	async function mutate(action: "apply" | "restore", args: string[], ctx: ExtensionCommandContext) {
		const confirmed = args.includes("--yes") || await ctx.ui.confirm(
			`${action === "apply" ? "应用 Catalog" : "恢复依赖"}？`,
			action === "apply"
				? "重新生成 adapter、修复受管投影并运行验收。"
				: "委托固定版本的官方工具安装声明依赖，然后运行验收。",
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
		else if (action === "configure") await configureProfile(words[1], ctx);
		else if (action === "switch") await switchProfile(words[1], ctx);
		else if (action === "edit") await editProfile(words[1], ctx);
		else if (action === "apply") await mutate("apply", words.slice(1), ctx);
		else if (action === "doctor") await notifyRun(["doctor"], ctx);
		else if (action === "restore") await mutate("restore", words.slice(1), ctx);
		else if (action) ctx.ui.notify(`未知 harness 操作：${action}\n\n${HELP}`, "error");
		else if (ctx.mode !== "tui") ctx.ui.notify(HELP, "info");
		else {
			const selected = await ctx.ui.select("Harness 管理面", [
				"查看状态",
				"配置 Profile",
				"切换工作 Profile",
				"应用 Catalog",
				"完整检查",
				"恢复依赖",
			]);
			if (selected === "查看状态") await handle("status", ctx);
			else if (selected === "配置 Profile") await handle("configure", ctx);
			else if (selected === "切换工作 Profile") await handle("switch", ctx);
			else if (selected === "应用 Catalog") await handle("apply", ctx);
			else if (selected === "完整检查") await handle("doctor", ctx);
			else if (selected === "恢复依赖") await handle("restore", ctx);
		}
	}

	pi.registerCommand("harness", {
		description: "用可视化开关管理跨 harness 的 Profile、投影与健康状态",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const [action = "", value = ""] = prefix.split(/\s+/, 2);
			if (["switch", "configure", "edit"].includes(action)) {
				const items = profileNames().filter((name) => name.startsWith(value)).map((name) => ({ value: `${action} ${name}`, label: name }));
				return items.length ? items : null;
			}
			const items = ACTIONS.filter((name) => name.startsWith(action)).map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		handler: handle,
	});
}
