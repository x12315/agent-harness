import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	getSelectListTheme,
	getSettingsListTheme,
	parseFrontmatter,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
	acquireCatalogLock,
	atomicWrite,
	CATALOG,
	ENGINE,
	modelSelectionPool,
	planCatalogValidation,
	scanText,
	releaseCatalogLock,
	setInstructionSelection,
	summarizeSkillDescription,
} from "./harness-manager-state.mjs";
import {
	type AutocompleteItem,
	Container,
	fuzzyFilter,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";

const REPO = CATALOG;
const HARNESS_SCRIPT = process.env.HARNESS_ENGINE_ENTRY || join(ENGINE, "scripts", "harness.mjs");
const PROFILES_DIR = join(REPO, "profiles");
const SKILLS_DIR = join(REPO, "skills");
const INSTRUCTIONS_DIR = join(REPO, "instructions");
const INSTRUCTION_SELECTION = join(INSTRUCTIONS_DIR, "selection.json");
const DETAIL_LABELS = {
	brief: "精简",
	standard: "标准",
	detailed: "详细",
} as const;
const INSTRUCTION_PRESENTATION: Record<string, { title: string; description: string }> = {
	"profile/concise": { title: "简洁沟通", description: "先给结论，再报告关键证据、改动、验证和风险" },
	"profile/implementation": { title: "实施模式", description: "约束代码修改、接口保持和完成前验证" },
	"profile/model-standard": { title: "标准模型指导", description: "要求简短计划、关键假设核验和结果验收" },
	"profile/model-weak": { title: "弱模型指导", description: "要求小步执行、逐项检查并在冲突时停下确认" },
	"profile/read-only": { title: "只读模式", description: "只允许检查和解释，不改变本地、浏览器或远端状态" },
	"profile/research": { title: "调研模式", description: "以证据为中心检索，并保持本地与远端状态不变" },
	"profile/review": { title: "审查模式", description: "优先检查正确性、安全、回归和缺失测试" },
	"profile/strategic": { title: "全局规划与复杂问题", description: "建立系统边界、比较方案并验证关键假设" },
};
type DetailLevel = keyof typeof DETAIL_LABELS;
type InstructionLayer = "mandatory" | "repository" | "profile";
type InstructionSelection = { id: string; detail: DetailLevel };
type InstructionEntry = {
	id: string;
	layer: InstructionLayer;
	title: string;
	description: string;
	variants: Record<DetailLevel, string>;
};
type GlobalInstructionSelection = {
	mandatory: InstructionSelection[];
	repository: InstructionSelection[];
};
type CatalogSkill = { name: string; description: string };

type ProfileSource = {
	label: string;
	description: string;
	instructions: InstructionSelection[];
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

function profileNames(): string[] {
	if (!existsSync(PROFILES_DIR)) return [];
	return readdirSync(PROFILES_DIR)
		.filter((name) => name.endsWith(".json") && name !== "profile.schema.json")
		.map((name) => basename(name, ".json"))
		.sort();
}

function profileChoice(name: string): SelectItem {
	try {
		const profile = JSON.parse(readFileSync(join(PROFILES_DIR, `${name}.json`), "utf8"));
		return { value: name, label: profile.label ?? name, description: `${profile.description ?? ""}  [${name}]` };
	} catch {
		return { value: name, label: name, description: "配置无法读取" };
	}
}

function catalogSkills(): CatalogSkill[] {
	if (!existsSync(SKILLS_DIR)) return [];
	return readdirSync(SKILLS_DIR, { withFileTypes: true })
		.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && existsSync(join(SKILLS_DIR, entry.name, "SKILL.md")))
		.map((entry) => {
			try {
				const parsed = parseFrontmatter<{ description?: unknown }>(readFileSync(join(SKILLS_DIR, entry.name, "SKILL.md"), "utf8"));
				return {
					name: entry.name,
					description: typeof parsed.frontmatter.description === "string"
						? parsed.frontmatter.description.replace(/\s+/g, " ").trim()
						: "无说明",
				};
			} catch {
				return { name: entry.name, description: "说明无法读取" };
			}
		})
		.sort((a, b) => a.name.localeCompare(b.name));
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

function instructionEntries(): InstructionEntry[] {
	const entries: InstructionEntry[] = [];
	for (const layer of ["mandatory", "repository", "profile"] as const) {
		const dir = join(INSTRUCTIONS_DIR, layer);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".md") && !name.endsWith(".brief.md") && !name.endsWith(".detailed.md")).sort()) {
			const base = basename(file, ".md");
			const variants = {
				brief: join(dir, `${base}.brief.md`),
				standard: join(dir, file),
				detailed: join(dir, `${base}.detailed.md`),
			};
			if (!Object.values(variants).every(existsSync)) continue;
			const standard = readFileSync(variants.standard, "utf8").trim();
			const id = `${layer}/${base}`;
			const presentation = INSTRUCTION_PRESENTATION[id];
			const title = presentation?.title ?? standard.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() ?? base;
			const description = presentation?.description ?? standard
				.replace(/^#{1,6}\s+.+$/m, "")
				.split(/\n\s*\n/)
				.map((part) => part.replace(/\s+/g, " ").trim())
				.find(Boolean) ?? "无说明";
			entries.push({ id, layer, title, description, variants });
		}
	}
	return entries;
}

async function selectDetailed(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
	current?: string,
): Promise<string | undefined> {
	if (!items.length) return undefined;
	if (ctx.mode !== "tui") {
		const choices = items.map((item) => ({ item, display: `${item.label}${item.description ? ` — ${item.description}` : ""}` }));
		const selected = await ctx.ui.select(title, choices.map((choice) => choice.display));
		return choices.find((choice) => choice.display === selected)?.item.value;
	}
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		const list = new SelectList(items, Math.min(items.length, 14), getSelectListTheme(), { minPrimaryColumnWidth: 14, maxPrimaryColumnWidth: 30 });
		const selectedIndex = current ? items.findIndex((item) => item.value === current) : -1;
		if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		container.addChild(list);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function selectSearchable(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
	current?: string,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") return selectDetailed(ctx, title, items, current);
	if (!items.length) return undefined;
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const input = new Input();
		input.focused = true;
		let filtered = items;
		let list: SelectList;
		const rebuildList = () => {
			list = new SelectList(filtered, Math.min(filtered.length, 12), getSelectListTheme(), { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 36 });
			const selectedIndex = current ? filtered.findIndex((item) => item.value === current) : -1;
			if (selectedIndex >= 0 && !input.getValue()) list.setSelectedIndex(selectedIndex);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
		};
		rebuildList();
		input.onSubmit = () => {
			const selected = list.getSelectedItem();
			if (selected) done(selected.value);
		};
		input.onEscape = () => done(undefined);
		const titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		const hintText = new Text(theme.fg("muted", "输入关键词搜索 · ↑↓ 选择 · Enter 确认 · Esc 返回"), 1, 0);
		return {
			focused: true,
			render: (width: number) => [
				...titleText.render(width),
				...input.render(width),
				...list.render(width),
				...hintText.render(width),
			],
			invalidate: () => {
				input.invalidate();
				list.invalidate();
			},
			handleInput: (data: string) => {
				if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
				else if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down") || keybindings.matches(data, "tui.select.confirm")) list.handleInput(data);
				else {
					input.handleInput(data);
					filtered = fuzzyFilter(items, input.getValue(), (item) => `${item.label} ${item.description ?? ""}`);
					rebuildList();
				}
				tui.requestRender();
			},
		};
	});
}

function compactOutput(stdout: string, stderr: string): string {
	const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
	if (!text) return "命令执行完成，没有输出。";
	return text.length > 12_000 ? `${text.slice(0, 12_000)}\n… output truncated` : text;
}

/** Register human Catalog management and session switching without exposing model tools. */
export default function harnessManager(pi: ExtensionAPI) {
	function profileRuntimePlan(): { profile: string; source?: string } | undefined {
		const runtimeDir = process.env.PI_CODING_AGENT_DIR;
		if (!runtimeDir || !pi.getCommands().some((command) => command.name === "profile")) return undefined;
		try {
			const plan = JSON.parse(readFileSync(join(runtimeDir, "pi-profile.json"), "utf8"));
			return typeof plan.profile === "string" && typeof plan.agentDir === "string" ? plan : undefined;
		} catch {
			return undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("harness-profile-hint", undefined);
		const plan = profileRuntimePlan();
		if (plan?.profile !== "default" || plan.source !== "builtin") return;
		ctx.ui.setStatus("profile", "普通模式 · 未选择工作方案");
		ctx.ui.setWidget("harness-profile-hint", [
			"Harness 已启用 · 尚未选择工作方案（当前使用普通 Pi 资源）",
			"输入 /harness 打开管理菜单选择工作方案；快捷方式：/harness switch。",
		]);
	});

	async function runHarness(args: string[], ctx: ExtensionCommandContext, timeout = 600_000) {
		ctx.ui.setStatus("harness-manager", `harness ${args.join(" ")}`);
		try {
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
		return selectDetailed(ctx, title, names.map(profileChoice));
	}

	async function applyCatalogSource(
		label: string,
		source: string,
		original: string,
		edited: string,
		ctx: ExtensionCommandContext,
	) {
		let lock: ReturnType<typeof acquireCatalogLock>;
		let catalogLock: ReturnType<typeof acquireCatalogLock> | undefined;
		try {
			catalogLock = acquireCatalogLock(join(REPO, ".catalog"));
			lock = acquireCatalogLock(source);
		}
		catch (error) {
			if (catalogLock) releaseCatalogLock(catalogLock);
			ctx.ui.notify(`保存已停止：另一个 Harness 管理会话正在修改该源码。\n${error instanceof Error ? error.message : error}`, "error");
			return;
		}
		try {
		const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, "-");
		const suffix = source.endsWith(".json") ? ".json" : ".md";
		const backup = join(tmpdir(), `harness-${safeLabel}-${Date.now()}${suffix}`);
		let current: string;
		try { current = readFileSync(source, "utf8"); }
		catch (error) {
			ctx.ui.notify(`保存已停止：源码在配置期间不可读取。未写入任何内容。\n${error instanceof Error ? error.message : error}`, "error");
			return;
		}
		if (current !== original) {
			const concurrent = backup.replace(suffix, `.concurrent${suffix}`);
			writeFileSync(backup, original);
			writeFileSync(concurrent, current);
			ctx.ui.notify(`保存已停止：${source} 在配置期间被其他会话修改。为避免覆盖，未写入任何内容。\n打开时版本：${backup}\n当前版本：${concurrent}`, "error");
			return;
		}
		const written = edited.endsWith("\n") ? edited : `${edited}\n`;
		if (scanText(source, written).length) {
			ctx.ui.notify("保存已停止：内容包含疑似凭据。请使用环境变量或原生凭据存储。", "error");
			return;
		}
		let plan: ReturnType<typeof planCatalogValidation>;
		try { plan = planCatalogValidation({ repo: REPO, source, before: original, after: written }); }
		catch (error) { ctx.ui.notify(`配置格式不正确：${error instanceof Error ? error.message : error}`, "error"); return; }
		const runPlan = async (validation: ReturnType<typeof planCatalogValidation>) => {
			const output: string[] = [];
			for (const step of validation.steps) {
				const started = Date.now();
				const result = await runHarness(step.args, ctx, step.timeout);
				output.push(`${step.name} (${Date.now() - started}ms)\n${compactOutput(result.stdout, result.stderr)}`);
				if (result.code !== 0) return { code: result.code, stdout: output.join("\n\n"), stderr: "" };
			}
			return { code: 0, stdout: output.join("\n\n"), stderr: "" };
		};
		writeFileSync(backup, original, { mode: 0o600, flag: "wx" });
		try { atomicWrite(source, written, `${process.pid}-save`, original); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ECHANGED") throw error;
			const concurrent = backup.replace(suffix, `.concurrent${suffix}`);
			writeFileSync(concurrent, readFileSync(source, "utf8"));
			ctx.ui.notify(`保存已停止：${source} 在原子替换前被其他进程修改。未覆盖其内容。\n打开时版本：${backup}\n当前版本：${concurrent}`, "error");
			return;
		}

		const rollback = async (): Promise<{ ok: boolean; detail: string }> => {
			let rollbackCurrent: string;
			try { rollbackCurrent = readFileSync(source, "utf8"); }
			catch (error) { return { ok: false, detail: `自动回滚停止：源码不可读取；原版本仍在 ${backup}。${error instanceof Error ? error.message : error}` }; }
			if (rollbackCurrent !== written) {
				const concurrent = backup.replace(suffix, `.rollback-conflict${suffix}`);
				writeFileSync(concurrent, rollbackCurrent);
				return { ok: false, detail: `自动回滚停止：验证期间源码被其他会话修改，未覆盖其内容。原版本：${backup}；当前版本快照：${concurrent}` };
			}
			try { atomicWrite(source, original, `${process.pid}-rollback`, written); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ECHANGED") {
					const concurrent = backup.replace(suffix, `.rollback-race${suffix}`);
					writeFileSync(concurrent, readFileSync(source, "utf8"));
					return { ok: false, detail: `自动回滚停止：原子恢复前源码再次变化，未覆盖其内容。当前版本快照：${concurrent}` };
				}
				return { ok: false, detail: `源码恢复失败：${error instanceof Error ? error.message : error}` };
			}
			const recoveryPlan = planCatalogValidation({ repo: REPO, source, before: written, after: original });
			const reverified = await runPlan(recoveryPlan);
			return {
				ok: reverified.code === 0,
				detail: reverified.code === 0 ? "原配置已恢复并通过受影响项复验。" : `原配置已写回，但复验失败：${compactOutput(reverified.stdout, reverified.stderr)}`,
			};
		};
		const rejectAndRollback = async (reason: string, failed: { stdout: string; stderr: string }) => {
			const restored = await rollback();
			ctx.ui.notify(
				`${reason}。${restored.ok ? "已安全恢复。" : "恢复未完整确认，请停止继续配置并运行 harness doctor。"}\n备份：${backup}\n${compactOutput(failed.stdout, failed.stderr)}\n\n${restored.detail}`,
				"error",
			);
		};
		const verified = await runPlan(plan);
		if (verified.code !== 0) return await rejectAndRollback("受影响项检查失败", verified);
		ctx.ui.notify(`已更新 ${label}，受影响项检查通过（未运行完整 doctor）。新会话立即生效；运行中的 Pi 请 /reload 或重选 Profile。\n备份：${backup}\n${compactOutput(verified.stdout, verified.stderr)}`, "info");
		} finally {
			try { releaseCatalogLock(lock); }
			finally { if (catalogLock) releaseCatalogLock(catalogLock); }
		}
	}

	function launchWeb(ctx: ExtensionCommandContext) {
		const logPath = join(tmpdir(), `harness-web-${process.pid}-${Date.now()}.log`);
		const log = openSync(logPath, "wx", 0o600);
		const env = {
			...process.env,
			HARNESS_CATALOG: REPO,
			HARNESS_MODEL_SCOPE: JSON.stringify(ctx.scopedModels.map((entry) => ({
				provider: entry.model.provider,
				id: entry.model.id,
				thinking: entry.thinkingLevel,
			}))),
		};
		delete env.PI_CODING_AGENT_DIR;
		try {
			const child = spawn(process.execPath, [HARNESS_SCRIPT, "web"], {
				cwd: REPO,
				detached: true,
				env,
				stdio: ["ignore", log, log],
			});
			child.once("error", (error) => ctx.ui.notify(`Harness Web 启动失败：${error.message}`, "error"));
			child.unref();
			ctx.ui.notify(`正在启动 Harness Web。浏览器应自动打开；启动日志：${logPath}`, "info");
		} finally {
			closeSync(log);
		}
	}

	async function switchProfile(name: string | undefined, ctx: ExtensionCommandContext): Promise<boolean> {
		const selected = name || await chooseProfile(ctx, "选择当前会话的工作方案");
		if (!selected) return false;
		if (!profileNames().includes(selected)) {
			ctx.ui.notify(`未知 Profile：${selected}`, "error");
			return false;
		}
		if (!profileRuntimePlan()) {
			ctx.ui.notify([
				"当前是普通 Pi 会话，不能在运行中安全替换启动时发现的 Skills、Extensions 与 Instructions。",
				`下次可直接运行 pi-h（或 harness pi），再用 /harness switch ${selected}，无需再次退出。`,
				`也可直接运行：pi-profile ${selected}。这些入口只准备资源，交互仍由原生 Pi 执行。`,
			].join("\n\n"), "warning");
			return false;
		}
		pi.sendUserMessage(`/profile use ${selected}`, { expandPromptTemplates: true });
		return true;
	}

	async function browseSkills(ctx: ExtensionCommandContext) {
		const catalog = catalogSkills();
		while (true) {
			const selected = await selectSearchable(ctx, "Skills 目录（摘要列表）", [
				...catalog.map((skill) => ({
					value: skill.name,
					label: skill.name,
					description: summarizeSkillDescription(skill.description),
				})),
				{ value: "__back", label: "返回上级", description: "返回上一层菜单" },
			]);
			if (!selected || selected === "__back") return;
			const skill = catalog.find((entry) => entry.name === selected);
			if (!skill) continue;
			if (ctx.mode !== "tui") {
				ctx.ui.notify(`${skill.name}\n\n${skill.description}\n\n来源：${join(SKILLS_DIR, skill.name, "SKILL.md")}`, "info");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				const title = new Text(theme.fg("accent", theme.bold(`Skill 详情 · ${skill.name}`)), 1, 0);
				const body = new Text(`${skill.description}\n\n来源：${join(SKILLS_DIR, skill.name, "SKILL.md")}`, 2, 0);
				let scrollTop = 0;
				return {
					render: (width: number) => {
						const titleLines = title.render(width);
						const bodyLines = body.render(width);
						const pageSize = Math.max(3, tui.terminal.rows - titleLines.length - 2);
						const maxScrollTop = Math.max(0, bodyLines.length - pageSize);
						scrollTop = Math.min(scrollTop, maxScrollTop);
						const progress = bodyLines.length > pageSize ? ` · ${scrollTop + 1}-${Math.min(scrollTop + pageSize, bodyLines.length)}/${bodyLines.length}` : "";
						return [...titleLines, ...bodyLines.slice(scrollTop, scrollTop + pageSize), theme.fg("muted", `  ↑↓ 滚动 · Enter/Esc 返回${progress}`)];
					},
					invalidate: () => {
						title.invalidate();
						body.invalidate();
					},
					handleInput: (data: string) => {
						if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) done(undefined);
						else if (keybindings.matches(data, "tui.select.up")) scrollTop = Math.max(0, scrollTop - 1);
						else if (keybindings.matches(data, "tui.select.down")) scrollTop += 1;
						tui.requestRender();
					},
				};
			});
		}
	}

	async function configureSkills(profile: ProfileSource, ctx: ExtensionCommandContext) {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Skills 开关需要 Pi TUI。", "error");
			return;
		}
		const catalog = catalogSkills();
		const selected = selectedSkillNames(profile, catalog.map((skill) => skill.name));
		const initialSelection = new Set(selected);
		const ordered = catalog.sort((a, b) => `${skillCategory(a.name)} ${a.name}`.localeCompare(`${skillCategory(b.name)} ${b.name}`));
		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Skills 开关（输入关键词搜索，Esc 返回上级）")), 1, 0));
			container.addChild(new Text(theme.fg("muted", "摘要上限：112 列；完整说明：/harness skills"), 1, 0));
			if (profile.skills.some((pattern) => pattern.includes("*") || pattern.includes("?"))) {
				container.addChild(new Text(theme.fg("muted", "当前使用自动匹配；首次实际切换后会固定为显式清单。"), 1, 0));
			}
			const items: SettingItem[] = ordered.map((skill) => ({
				id: skill.name,
				label: `${skillCategory(skill.name)} · ${skill.name}`,
				description: summarizeSkillDescription(skill.description),
				currentValue: selected.has(skill.name) ? "启用" : "关闭",
				values: ["启用", "关闭"],
			}));
			const settings = new SettingsList(
				items,
				Math.min(items.length + 2, 20),
				getSettingsListTheme(),
				(id, value) => value === "启用" ? selected.add(id) : selected.delete(id),
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
		const changed = selected.size !== initialSelection.size || [...selected].some((name) => !initialSelection.has(name));
		if (changed) profile.skills = [...selected].sort();
	}

	function piModelPool(ctx: ExtensionCommandContext): Model<Api>[] {
		return modelSelectionPool(ctx.scopedModels, ctx.modelRegistry.getAvailable());
	}

	async function configurePiModel(profile: ProfileSource, ctx: ExtensionCommandContext) {
		const current = profile.adapters.pi.model;
		const models = piModelPool(ctx);
		if (!models.length) {
			ctx.ui.notify("当前 session scope 和已认证 provider 中没有可选模型。请先用 /login 或 /model 配置 Pi。", "warning");
			return;
		}
		const byProvider = new Map<string, Model<Api>[]>();
		for (const model of models) {
			const providerModels = byProvider.get(model.provider) ?? [];
			providerModels.push(model);
			byProvider.set(model.provider, providerModels);
		}
		const scopeLabel = ctx.scopedModels.length > 0 ? "当前 session scope" : "已认证 provider";
		const provider = await selectDetailed(ctx, `选择 Pi provider（${scopeLabel}）`, [...byProvider].map(([id, providerModels]) => ({
			value: id,
			label: id,
			description: `${ctx.modelRegistry.getProviderDisplayName(id)} · ${providerModels.length} 个模型`,
		})), current?.provider);
		if (!provider) return;
		const providerModels = byProvider.get(provider) ?? [];
		const modelId = await selectSearchable(ctx, `选择 Pi model [${provider}]`, providerModels.map((model) => ({
			value: model.id,
			label: model.id,
			description: `${model.name}${model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k context` : ""}${model.reasoning ? " · reasoning" : ""}`,
		})), current?.provider === provider ? current.id : undefined);
		if (!modelId) return;
		const selected = providerModels.find((model) => model.id === modelId);
		if (!selected) return;
		const levels = getSupportedThinkingLevels(selected);
		const currentThinking = levels.find((level) => level === current?.thinking);
		const thinking = await selectDetailed(ctx, `选择 thinking [${provider}/${modelId}]`, levels.map((level) => ({
			value: level,
			label: level,
			description: level === "off" ? "关闭推理" : "模型支持的推理强度",
		})), currentThinking);
		if (!thinking) return;
		profile.adapters.pi.model = { provider, id: modelId, thinking };
	}

	async function configureCodexModel(profile: ProfileSource, ctx: ExtensionCommandContext) {
		const current = profile.adapters.codex.model;
		const action = await selectDetailed(ctx, "配置 Codex 推荐模型", [
			{ value: "pi", label: "跟随 Pi 模型", description: profile.adapters.pi.model ? `${profile.adapters.pi.model.id}:${profile.adapters.pi.model.thinking ?? "off"}；保存时仅检查该方案的 Codex 兼容性` : "Pi 当前继承默认模型" },
			{ value: "manual", label: "高级：手动输入", description: `当前 ${current?.id ?? "继承"}:${current?.thinking ?? "off"}；仅用于 Pi 无法枚举的 Codex 模型` },
			{ value: "back", label: "返回上级", description: "保留当前 Codex 推荐模型" },
		]);
		if (!action || action === "back") return;
		if (action === "pi") {
			const piModel = profile.adapters.pi.model;
			if (!piModel) {
				ctx.ui.notify("Pi Profile 当前继承默认模型，无法生成明确的 Codex 推荐值。", "warning");
				return;
			}
			profile.adapters.codex.model = { id: piModel.id, ...(piModel.thinking ? { thinking: piModel.thinking } : {}) };
			return;
		}
		const id = await ctx.ui.input(`Codex model（当前：${current?.id ?? "继承"}）`, "输入 Codex model id");
		if (id === undefined || !id.trim()) return;
		const thinking = await selectDetailed(ctx, "选择 Codex thinking", ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => ({
			value: level,
			label: level,
			description: "保存时检查该方案的 Codex 模型兼容性",
		})), current?.thinking);
		if (!thinking) return;
		profile.adapters.codex.model = { id: id.trim(), thinking };
	}

	async function configureModels(profile: ProfileSource, ctx: ExtensionCommandContext) {
		while (true) {
			const piModel = profile.adapters.pi.model;
			const codexModel = profile.adapters.codex.model;
			const action = await selectDetailed(ctx, "推荐模型", [
				{ value: "pi", label: "Pi 推荐模型", description: `${piModel?.provider ?? "继承"}/${piModel?.id ?? "继承"}:${piModel?.thinking ?? "off"}；从当前 scope 搜索选择` },
				{ value: "codex", label: "Codex 推荐模型", description: `${codexModel?.id ?? "继承"}:${codexModel?.thinking ?? "off"}；可跟随 Pi 或高级输入` },
				{ value: "back", label: "返回上级", description: "返回 Profile 配置" },
			]);
			if (!action || action === "back") return;
			if (action === "pi") await configurePiModel(profile, ctx);
			else await configureCodexModel(profile, ctx);
		}
	}

	async function editInstruction(entry: InstructionEntry, detail: DetailLevel, ctx: ExtensionCommandContext) {
		const source = entry.variants[detail];
		const original = readFileSync(source, "utf8");
		const edited = await ctx.ui.editor(`编辑 ${entry.title} · ${DETAIL_LABELS[detail]}`, original);
		if (edited === undefined || edited === original) return;
		const impact = entry.layer === "mandatory" || entry.layer === "repository"
			? "这会影响所有 Harness 会话。"
			: "这会影响所有选择该词条与详略档位的 Profile。";
		if (!await ctx.ui.confirm("应用 instruction 源码修改？", `${impact}\n源码：${source}`)) return;
		await applyCatalogSource(`${entry.id}@${detail}`, source, original, edited, ctx);
	}

	async function configureInstructionEntry(
		entry: InstructionEntry,
		selections: InstructionSelection[],
		locked: boolean,
		ctx: ExtensionCommandContext,
	) {
		while (true) {
			const selected = selections.find((selection) => selection.id === entry.id);
			const detail = selected?.detail ?? "standard";
			const action = await selectDetailed(ctx, entry.title, [
				{ value: "toggle", label: "启用状态", description: locked ? "不可关闭的安全底线" : selected ? "已启用；选择可关闭" : "已关闭；选择可启用" },
				{ value: "detail", label: "说明详略", description: `${DETAIL_LABELS[detail]}；选择该词条注入给模型的完整版本` },
				{ value: "preview", label: "预览当前内容", description: `查看 ${entry.id}@${detail} 的实际 Markdown` },
				{ value: "edit", label: "编辑当前内容", description: "编辑 instruction 源码；生成物会自动重建并验收" },
				{ value: "back", label: "返回上级", description: "保留本层尚未保存的选择" },
			]);
			if (!action || action === "back") return;
			if (action === "toggle") {
				if (locked) ctx.ui.notify("mandatory 词条属于不可关闭的安全边界，只能调整详略或编辑源码。", "warning");
				else setInstructionSelection(selections, entry.id, selected ? undefined : detail);
			} else if (action === "detail") {
				const chosen = await selectDetailed(ctx, "选择说明详略", [
					{ value: "brief", label: "精简", description: "只保留改变行为所需的核心约束" },
					{ value: "standard", label: "标准", description: "日常默认，兼顾约束、解释与上下文负担" },
					{ value: "detailed", label: "详细", description: "展开步骤、边界、例外和完成条件" },
				], detail);
				if (chosen) setInstructionSelection(selections, entry.id, chosen as DetailLevel);
			} else if (action === "preview") {
				ctx.ui.notify(`${entry.id}@${detail}\n\n${readFileSync(entry.variants[detail], "utf8").trim()}`, "info");
			} else if (action === "edit") {
				await editInstruction(entry, detail, ctx);
			}
		}
	}

	async function configureInstructionList(
		title: string,
		entries: InstructionEntry[],
		selections: InstructionSelection[],
		lockedIds: Set<string>,
		ctx: ExtensionCommandContext,
	) {
		while (true) {
			const selected = await selectDetailed(ctx, title, [
				...entries.map((entry) => {
					const active = selections.find((selection) => selection.id === entry.id);
					const state = lockedIds.has(entry.id) ? `常驻 · ${DETAIL_LABELS[active?.detail ?? "standard"]}` : active ? `启用 · ${DETAIL_LABELS[active.detail]}` : "关闭";
					return { value: entry.id, label: entry.title, description: `${state}；${entry.description}` };
				}),
				{ value: "__back", label: "返回上级", description: "返回上一层菜单" },
			]);
			if (!selected || selected === "__back") return;
			const entry = entries.find((candidate) => candidate.id === selected);
			if (entry) await configureInstructionEntry(entry, selections, lockedIds.has(entry.id), ctx);
		}
	}

	async function configureGlobalInstructions(ctx: ExtensionCommandContext) {
		const entries = instructionEntries().filter((entry) => entry.layer !== "profile");
		const original = readFileSync(INSTRUCTION_SELECTION, "utf8");
		let draft: GlobalInstructionSelection;
		try { draft = structuredClone(JSON.parse(original)); }
		catch (error) {
			ctx.ui.notify(`instruction selection 无法读取：${error instanceof Error ? error.message : error}`, "error");
			return;
		}
		while (true) {
			const combined = [...draft.mandatory, ...draft.repository];
			const choice = await selectDetailed(ctx, "AGENTS.md 常驻词条", [
				{ value: "entries", label: "逐项管理", description: `${combined.length}/${entries.length} 已启用；每项可选精简、标准或详细说明` },
				{ value: "save", label: "保存并应用", description: "重建 AGENTS.md 并检查受影响项；运行中的会话需重载" },
				{ value: "back", label: "返回上级", description: "放弃本次尚未保存的启停与详略修改" },
			]);
			if (!choice || choice === "back") return;
			if (choice === "entries") {
				await configureInstructionList(
					"AGENTS.md 词条（mandatory 锁定）",
					entries,
					combined,
					new Set(draft.mandatory.map((selection) => selection.id)),
					ctx,
				);
				const mandatoryIds = new Set(draft.mandatory.map((selection) => selection.id));
				draft.mandatory = combined.filter((selection) => mandatoryIds.has(selection.id));
				draft.repository = combined.filter((selection) => !mandatoryIds.has(selection.id));
			} else if (choice === "save") {
				const edited = `${JSON.stringify(draft, null, 2)}\n`;
				if (!await ctx.ui.confirm("保存 AGENTS.md 词条选择？", `常驻 ${draft.mandatory.length + draft.repository.length}/${entries.length}；mandatory ${draft.mandatory.length} 项不可关闭。`)) continue;
				await applyCatalogSource("instruction-selection", INSTRUCTION_SELECTION, original, edited, ctx);
				return;
			}
		}
	}

	async function configureProfileInstructions(profile: ProfileSource, ctx: ExtensionCommandContext) {
		const entries = instructionEntries().filter((entry) => entry.layer === "profile");
		await configureInstructionList("Profile instruction 词条", entries, profile.instructions, new Set(), ctx);
	}

	async function configureProfile(name: string | undefined, ctx: ExtensionCommandContext) {
		const selected = name || await chooseProfile(ctx, "选择要配置的脚手架");
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
			const catalog = catalogSkills();
			const skills = selectedSkillNames(draft, catalog.map((skill) => skill.name));
			const choice = await selectDetailed(ctx, `配置 ${draft.label} [${selected}]`, [
				{ value: "instructions", label: "Profile 词条", description: `${draft.instructions.length} 项；逐项启停、选择详略、预览或编辑` },
				{ value: "skills", label: "Skills 能力", description: `已启用 ${skills.size}/${catalog.length}；控制模型可发现的专业流程` },
				{ value: "models", label: "推荐模型", description: `Pi ${draft.adapters.pi.model?.provider ?? "继承"}/${draft.adapters.pi.model?.id ?? "继承"} · Codex ${draft.adapters.codex.model?.id ?? "继承"}` },
				{ value: "save", label: "保存并应用", description: "重新生成并检查受影响项；当前会话需重选方案；外部改动时停止回滚" },
				{ value: "back", label: "返回上级", description: "放弃本次尚未保存的 Profile 修改" },
			]);
			if (!choice || choice === "back") return;
			if (choice === "instructions") await configureProfileInstructions(draft, ctx);
			else if (choice === "skills") await configureSkills(draft, ctx);
			else if (choice === "models") await configureModels(draft, ctx);
			else if (choice === "save") {
				const summary = [
					`Profile：${draft.label} [${selected}]`,
					`Instructions：${draft.instructions.map((selection) => `${selection.id}@${selection.detail}`).join(", ") || "无"}`,
					`Skills：${selectedSkillNames(draft, catalog.map((skill) => skill.name)).size}/${catalog.length}`,
					`Pi 模型：${draft.adapters.pi.model?.provider ?? "继承"}/${draft.adapters.pi.model?.id ?? "继承"}`,
					`Codex 模型：${draft.adapters.codex.model?.id ?? "继承"}`,
				].join("\n");
				if (!await ctx.ui.confirm("保存并应用？", summary)) continue;
				await applyCatalogSource(selected, source, original, `${JSON.stringify(draft, null, 2)}\n`, ctx);
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
		await applyCatalogSource(selected, source, original, edited, ctx);
	}

	async function mutate(action: "apply" | "restore", args: string[], ctx: ExtensionCommandContext) {
		const confirmed = args.includes("--yes") || await ctx.ui.confirm(
			`${action === "apply" ? "应用 Catalog" : "恢复依赖"}？`,
			action === "apply" ? "重新生成 adapter、修复受管投影并运行验收。" : "委托固定版本的官方工具安装声明依赖，然后运行验收。",
		);
		if (!confirmed) return;
		if (action === "apply") await notifyRun(["apply"], ctx);
		else if (await notifyRun(["restore", "--apply"], ctx)) await notifyRun(["doctor"], ctx);
	}

	const actions: Array<SelectItem & {
		profileArgument?: boolean;
		run: (args: string[], ctx: ExtensionCommandContext) => void | Promise<void | boolean>;
	}> = [
		{ value: "status", label: "查看状态", description: "查看 Catalog、当前工作方案、依赖与投影概况", run: async (_args, ctx) => { await notifyRun(["status"], ctx, 30_000); } },
		{ value: "instructions", label: "AGENTS.md 词条", description: "逐项启停 repository 词条、选择详略、预览和编辑源码", run: (_args, ctx) => configureGlobalInstructions(ctx) },
		{ value: "skills", label: "Skills 目录", description: "搜索摘要并查看完整说明，不改变 Profile", run: (_args, ctx) => browseSkills(ctx) },
		{ value: "configure", label: "配置工作方案（基础）", description: "词条、Skills、推荐模型；保存不切换会话", profileArgument: true, run: (args, ctx) => configureProfile(args[0], ctx) },
		{ value: "web", label: "打开 Web 配置工作台", description: "完整编辑、工具与扩展、方案新建/复制/删除", run: (_args, ctx) => launchWeb(ctx) },
		{ value: "switch", label: "切换当前工作方案", description: "在当前会话生效；发起切换后退出管理面", profileArgument: true, run: (args, ctx) => switchProfile(args[0], ctx) },
		{ value: "apply", label: "应用 Catalog", description: "重新生成 adapter、修复受管投影并运行验收", run: (args, ctx) => mutate("apply", args, ctx) },
		{ value: "doctor", label: "完整检查", description: "只读检查生成物、依赖、密钥、运行时与投影", run: async (_args, ctx) => { await notifyRun(["doctor"], ctx); } },
		{ value: "restore", label: "恢复依赖", description: "委托固定版本的官方工具恢复缺失依赖", run: (args, ctx) => mutate("restore", args, ctx) },
		{ value: "profiles", label: "工作方案列表", description: "查看 Catalog 中已保存的工作方案", run: async (_args, ctx) => { await notifyRun(["profile", "list"], ctx, 30_000); } },
		{ value: "edit", label: "高级 JSON 编辑", description: "直接编辑工作方案源码；保存不切换会话", profileArgument: true, run: (args, ctx) => editProfile(args[0], ctx) },
		{ value: "help", label: "帮助与快捷命令", description: "菜单是主入口；命令是同一操作的快捷方式", run: (_args, ctx) => ctx.ui.notify(helpText(), "info") },
	];

	function helpText(): string {
		return [
			"Harness 管理面 · /harness 是主入口，以下命令仅是菜单操作的快捷方式。",
			"Catalog 是配置来源，当前工作方案以 Pi 运行时为准；保存不切换当前会话。",
			"",
			"/harness                         打开管理菜单",
			...actions.map(action => `${`/harness ${action.value}${action.profileArgument ? " [id]" : ""}`.padEnd(32)} ${action.label} · ${action.description}`),
			"",
			"AGENTS.md 词条是 instruction，不是 Subagent 角色。mandatory 词条不可关闭。",
		].join("\n");
	}

	async function executeAction(name: string, args: string[], ctx: ExtensionCommandContext): Promise<boolean> {
		const action = actions.find(action => action.value === name);
		if (!action) {
			ctx.ui.notify(`未知 harness 操作：${name}\n\n${helpText()}`, "error");
			return false;
		}
		return await action.run(args, ctx) === true;
	}

	async function handle(raw: string, ctx: ExtensionCommandContext) {
		const [name, ...args] = raw.trim().split(/\s+/).filter(Boolean);
		if (name) {
			await executeAction(name, args, ctx);
			return;
		}
		while (true) {
			const plan = profileRuntimePlan();
			const current = plan ? (plan.profile === "default" && plan.source === "builtin" ? "普通模式" : `${profileChoice(plan.profile).label} [${plan.profile}]`) : "原生 Pi";
			const selected = await selectDetailed(ctx, `Harness 管理面 · 当前：${current}`, [
				...actions.map(({ value, label, description }) => ({ value, label, description })),
				{ value: "back", label: "退出管理面", description: "返回 Pi 输入框" },
			]);
			if (!selected || selected === "back") return;
			if (await executeAction(selected, [], ctx)) return;
		}
	}

	pi.registerCommand("harness", {
		description: "打开 Harness 管理菜单；子命令是菜单操作的快捷方式",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const [name = "", value = ""] = prefix.split(/\s+/, 2);
			if (actions.find(action => action.value === name)?.profileArgument) {
				const items = profileNames().filter(profile => profile.startsWith(value)).map(profile => ({ value: `${name} ${profile}`, label: profile }));
				return items.length ? items : null;
			}
			const items = actions.filter(action => action.value.startsWith(name)).map(action => ({ value: action.value, label: `${action.value} · ${action.label}` }));
			return items.length ? items : null;
		},
		handler: handle,
	});
}
