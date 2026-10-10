import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { redactResourceText, repositoryUrl } from "../../web/resource-plans.js";

export const DETAIL_LEVELS = ["brief", "standard", "detailed"];

/** Profile IDs are filenames and launch identifiers; schema/default names are reserved. */
export function isProfileName(name) {
	return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
		&& !["default", "profile.schema"].includes(name.toLowerCase());
}

export function hashText(text) {
	return createHash("sha256").update(text).digest("hex");
}

function unquote(value) {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		try {
			return trimmed.startsWith('"') ? JSON.parse(trimmed) : trimmed.slice(1, -1).replaceAll("''", "'");
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

/** Read plain, quoted, folded, or literal top-level description without executing YAML tags. */
export function parseSkillDescription(markdown) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	if (!match) return "无说明";
	const lines = match[1].split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const field = /^description:\s*(.*)$/.exec(lines[index]);
		if (!field) continue;
		const value = field[1].trim();
		if (!/^[>|][+-]?$/.test(value)) return unquote(value) || "无说明";
		const block = [];
		for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
			const line = lines[cursor];
			if (/^[A-Za-z0-9_-]+:\s*/.test(line)) break;
			block.push(line.replace(/^\s{1,4}/, ""));
		}
		const text = value.startsWith(">") ? block.join(" ") : block.join("\n");
		return text.replace(/\s+/g, " ").trim() || "无说明";
	}
	return "无说明";
}

function skillCategory(name) {
	if (["git-commit", "make-repo-contribution"].includes(name)) return "Git";
	if (["ponytail", "self-explanatory-code"].includes(name)) return "编码规范";
	if (["agent-browser", "lark-doc", "lark-drive", "lark-wiki", "lark-sheets", "lark-base", "lark-meeting"].includes(name)) return "检索";
	if (name.startsWith("lark-")) return "飞书";
	if (["frontend-design", "ui-ux-pro-max", "macos-design", "implementing-drag-drop"].includes(name)) return "设计";
	return "其他";
}

export function readSkills(repo) {
	const root = join(repo, "skills");
	if (!existsSync(root)) return [];
	const own = existsSync(join(repo, ".gitignore")) ? ownSkills(repo) : new Set();
	const lock = existsSync(join(repo, ".skill-lock.json")) ? lockSkills(repo) : {};
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && existsSync(join(root, entry.name, "SKILL.md")))
		.map((entry) => ({
			name: entry.name,
			category: skillCategory(entry.name),
			description: parseSkillDescription(readFileSync(join(root, entry.name, "SKILL.md"), "utf8")),
			management: {
				ownership: own.has(entry.name) ? "own" : lock[entry.name] ? "installed" : "unknown",
				path: join(root, entry.name),
				...(repositoryUrl(lock[entry.name]?.sourceUrl) ? { source: repositoryUrl(lock[entry.name].sourceUrl) } : {}),
			},
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
}

function instructionPresentation(id, standard) {
	const known = {
		"profile/concise": ["简洁沟通", "先给结论，再报告关键证据、改动、验证和风险"],
		"profile/implementation": ["实施模式", "约束代码修改、接口保持和完成前验证"],
		"profile/model-standard": ["标准模型指导", "要求简短计划、关键假设核验和结果验收"],
		"profile/model-weak": ["弱模型指导", "要求小步执行、逐项检查并在冲突时停下确认"],
		"profile/read-only": ["只读模式", "只允许检查和解释，不改变本地、浏览器或远端状态"],
		"profile/research": ["调研模式", "以证据为中心检索，并保持本地与远端状态不变"],
		"profile/review": ["审查模式", "优先检查正确性、安全、回归和缺失测试"],
		"profile/strategic": ["全局规划与复杂问题", "建立系统边界、比较方案并验证关键假设"],
	};
	if (known[id]) return { title: known[id][0], description: known[id][1] };
	const title = standard.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() ?? id.split("/").at(-1);
	const description = standard
		.replace(/^#{1,6}\s+.+$/m, "")
		.split(/\n\s*\n/)
		.map((part) => part.replace(/\s+/g, " ").trim())
		.find(Boolean) ?? "无说明";
	return { title, description };
}

export function readInstructions(repo) {
	const entries = [];
	for (const layer of ["mandatory", "repository", "profile"]) {
		const root = join(repo, "instructions", layer);
		if (!existsSync(root)) continue;
		for (const file of readdirSync(root).filter((name) => name.endsWith(".md") && !name.endsWith(".brief.md") && !name.endsWith(".detailed.md")).sort()) {
			const name = basename(file, ".md");
			const paths = {
				brief: join(root, `${name}.brief.md`),
				standard: join(root, file),
				detailed: join(root, `${name}.detailed.md`),
			};
			if (!Object.values(paths).every(existsSync)) continue;
			const variants = Object.fromEntries(DETAIL_LEVELS.map((detail) => [detail, readFileSync(paths[detail], "utf8")]));
			const variantHashes = Object.fromEntries(DETAIL_LEVELS.map((detail) => [detail, hashText(variants[detail])]));
			const id = `${layer}/${name}`;
			entries.push({ id, layer, ...instructionPresentation(id, variants.standard), variants, variantHashes });
		}
	}
	return entries;
}

export function readProfiles(repo) {
	const root = join(repo, "profiles");
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((name) => name.endsWith(".json") && name !== "profile.schema.json")
		.sort()
		.map((file) => {
			const source = readFileSync(join(root, file), "utf8");
			return { name: basename(file, ".json"), sourceHash: hashText(source), value: JSON.parse(source) };
		});
}

export function parsePiModelList(output) {
	const models = [];
	for (const line of output.trim().split(/\r?\n/).slice(1)) {
		const [provider, id, context, maxOutput, thinking, images] = line.trim().split(/\s{2,}/);
		if (!provider || !id) continue;
		models.push({
			provider,
			id,
			context: context ?? "",
			maxOutput: maxOutput ?? "",
			reasoning: thinking === "yes",
			images: images === "yes",
			thinkingLevels: thinking === "yes" ? null : ["off"],
		});
	}
	return models;
}

import { ENGINE, assertCatalog, lockSkills, ownSkills, pins } from "./repo.mjs";

const BUILTIN_TOOLS = [
	["read", "读取文件与图片；文本可按行分页。", "读取", "read-only", { path: "文件路径", offset: "起始行（从 1 开始）", limit: "最多读取行数" }],
	["bash", "执行 shell 命令，返回标准输出和错误；可能改变本地或远端状态。", "执行", "high", { command: "要执行的 shell 命令", timeout: "超时秒数（可选）" }],
	["edit", "用精确文本匹配修改文件；每项匹配必须唯一且不重叠。", "文件修改", "write", { path: "文件路径", edits: "精确替换列表（oldText 与 newText）" }],
	["write", "写入文件，覆盖已有内容，必要时创建父目录。", "文件修改", "write", { path: "文件路径", content: "写入内容" }],
	["grep", "按正则或字面量搜索文件内容，返回带行号的匹配。", "检索", "read-only", { pattern: "搜索表达式", path: "搜索文件或目录", glob: "文件过滤模式", ignoreCase: "忽略大小写", literal: "按字面量匹配", context: "上下文行数", limit: "最大匹配数" }],
	["find", "按 glob 搜索文件路径，遵循 .gitignore。", "检索", "read-only", { pattern: "glob 文件模式", path: "搜索目录", limit: "最大结果数" }],
	["ls", "列出目录内容（包括隐藏文件），按名称排序。", "检索", "read-only", { path: "目录路径", limit: "最大条目数" }],
];

/** Parse internal Pi package identities without guessing installation/cache paths.
 * Sources remain exact for matching; readCatalog redacts them at the public boundary.
 * Entries without an absolute installed path remain unresolved; exact duplicates are removed.
 */
export function parsePiPackageList(output) {
	const packages = [];
	let current;
	for (const line of String(output ?? "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
		const source = /^  (\S.*)$/.exec(line);
		if (source && !line.startsWith("    ")) {
			current = { source: source[1].replace(/ \(filtered\)$/, "") };
			packages.push(current);
		} else if (current && /^    \S/.test(line)) {
			const path = line.trim();
			if (isAbsolute(path)) current.path = path;
			current = undefined;
		} else if (line.trim()) current = undefined;
	}
	return [...new Map(packages.map((entry) => [`${entry.source}\0${entry.path ?? ""}`, entry])).values()];
}

/** Keep only public JSON-schema documentation/constraints; defaults, examples and custom data are omitted. */
export function publicToolParameters(schema, depth = 0) {
	if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 12) return undefined;
	const result = {};
	for (const key of ["type", "title", "description", "enum", "required", "minimum", "maximum", "minLength", "maxLength", "pattern", "additionalProperties"]) {
		const value = schema[key];
		if (["string", "number", "boolean"].includes(typeof value) || (Array.isArray(value) && value.every((item) => ["string", "number", "boolean"].includes(typeof item)))) result[key] = value;
	}
	if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
		result.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, value]) => [name, publicToolParameters(value, depth + 1) ?? {}]));
	}
	if (schema.items) result.items = publicToolParameters(schema.items, depth + 1);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		if (Array.isArray(schema[key])) result[key] = schema[key].map((entry) => publicToolParameters(entry, depth + 1) ?? {});
	}
	return result;
}

function publicSource(sourceInfo) {
	if (!sourceInfo || typeof sourceInfo !== "object") return undefined;
	return Object.fromEntries(["path", "source", "origin", "scope"].filter((key) => typeof sourceInfo[key] === "string").map((key) => [key, sourceInfo[key]]));
}

function canonicalPath(path) {
	try { return realpathSync(path); } catch { return path; }
}

function packageName(source) {
	const name = source.replace(/^(npm|git|github):/, "");
	const version = name.indexOf("@", name.startsWith("@") ? name.indexOf("/") + 1 : 0);
	return version < 0 ? name : name.slice(0, version);
}

const ENGINE_EXTENSION_DESCRIPTIONS = {
	bookmark: "为会话回答添加书签，导出可打开的快照链接，并在当前会话跳转。",
	handoff: "生成可移交给另一会话的上下文，供审阅后复制。",
	"harness-manager": "人工管理 Profiles、指令、Skills、Web 工作台与 Harness 检查；不注册模型工具。",
	subagent: "将任务交给独立上下文的 Pi 子 agent，支持单任务、并行和串行链。",
};

function readPiResources(repo, engine, profiles, resources) {
	const warnings = resources?.warning ? [resources.warning === "tools-unavailable"
		? "Pi --no-tools 隐藏了注册工具目录；仅提供内置工具说明和未发现的工具声明占位，不代表当前 Profile 已加载。"
		: "Pi 资源探针失败或不完整；目录只包含已确认资源与声明占位，不代表当前 Profile 已加载。"] : [];
	const extensions = new Map();
	const conflicts = new Set();
	const add = (entry) => {
		const previous = extensions.get(entry.name);
		if (!previous) extensions.set(entry.name, entry);
		else if (previous.path !== entry.path || previous.source !== entry.source) {
			conflicts.add(entry.name);
			previous.available = false;
			previous.commands = [];
			previous.tools = [];
			previous.description = "发现同名资源冲突，无法确认可用来源。";
			warnings.push("Pi 扩展存在同名来源冲突；请检查原生安装与投影。");
		}
	};
	for (const [root, origin] of new Map([[engine, "engine"], [repo, engine === repo ? "engine" : "catalog"]])) {
		const directory = join(root, "adapters/pi/extensions");
		if (!existsSync(directory)) continue;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			let path;
			if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) path = join(directory, entry.name);
			if (entry.isDirectory()) path = ["index.ts", "index.js"].map((file) => join(directory, entry.name, file)).find(existsSync);
			if (!path) continue;
			const name = entry.name.replace(/\.(ts|js)$/, "");
			add({
				name, description: origin === "engine" && Object.hasOwn(ENGINE_EXTENSION_DESCRIPTIONS, name) ? ENGINE_EXTENSION_DESCRIPTIONS[name] : `${origin === "engine" ? "Engine 内置" : "Catalog 个人"}扩展；可用于配置，未确认在当前 Profile 加载。`,
				origin, source: origin, path, commands: [], tools: [], available: true, required: name === "harness-manager",
			});
		}
	}
	for (const entry of resources?.packages ?? []) {
		if (!entry || typeof entry.source !== "string") continue;
		let manifest;
		try {
			if (typeof entry.path === "string" && isAbsolute(entry.path)) manifest = JSON.parse(readFileSync(join(entry.path, "package.json"), "utf8"));
		} catch { /* Uninstalled or unreadable packages are not available. */ }
		const name = typeof manifest?.name === "string" ? manifest.name : packageName(redactResourceText(entry.source));
		if (!name) continue;
		const available = Array.isArray(manifest?.pi?.extensions) && manifest.pi.extensions.some((path) => typeof path === "string" && path.length > 0 && !/^[!-]/.test(path));
		add({
			name, description: typeof manifest?.description === "string" ? manifest.description : "原生 Pi 包；未发现扩展声明。",
			origin: "package", source: entry.source,
			...(typeof entry.path === "string" && isAbsolute(entry.path) ? { path: entry.path } : {}),
			...(typeof manifest?.version === "string" ? { version: manifest.version } : {}),
			commands: [], tools: [], available, required: name === "harness-manager",
		});
	}
	const tools = new Map(BUILTIN_TOOLS.map(([name, description, category, risk, parameters]) => [name, {
		name, description, category, risk, available: true,
		parameters: {
			type: "object", required: { read: ["path"], bash: ["command"], edit: ["path", "edits"], write: ["path", "content"], grep: ["pattern"], find: ["pattern"], ls: [] }[name],
			properties: Object.fromEntries(Object.entries(parameters).map(([key, description]) => [key, {
				type: ["offset", "limit", "timeout", "context"].includes(key) ? "number" : ["ignoreCase", "literal"].includes(key) ? "boolean" : key === "edits" ? "array" : "string", description,
				...(key === "edits" ? { items: { type: "object", required: ["oldText", "newText"], properties: { oldText: { type: "string", description: "唯一且不重叠的原文" }, newText: { type: "string", description: "替换后的文本" } } } } : {}),
			}])),
		},
		source: { source: "builtin", path: `builtin:${name}` },
	}]));
	const associate = (item, kind) => {
		const source = publicSource(item.sourceInfo ?? item.source);
		if (!source?.path || source.source === "builtin" || source.path.startsWith("builtin:")) return;
		const path = canonicalPath(source.path);
		let extension = [...extensions.values()].find((entry) => {
			if (!entry.path) return false;
			const root = canonicalPath(entry.path);
			if (entry.origin !== "package") return root === path;
			const child = relative(root, path);
			return source.origin === "package" && source.source === entry.source && child !== "" && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child);
		});
		if (extension?.origin === "package" && !conflicts.has(extension.name)) extension.available = true;
		if (!extension) {
			const name = basename(/^index\.(ts|js)$/.test(basename(source.path)) ? dirname(source.path) : source.path).replace(/\.(ts|js)$/, "");
			if (name === "pi-web-models") return;
			if (!extensions.has(name)) add({ name, description: "Pi 探针中实际注册的扩展；不代表当前 Profile 已加载。", origin: source.origin ?? "native", source: source.source, path: source.path, commands: [], tools: [], available: true, required: name === "harness-manager" });
			extension = extensions.get(name);
			if (extension && canonicalPath(extension.path) !== path) return;
		}
		if (extension?.available && !extension[kind].includes(item.name)) extension[kind].push(item.name);
	};
	for (const item of resources?.tools ?? []) {
		if (!item || typeof item.name !== "string" || typeof item.description !== "string") continue;
		const source = publicSource(item.sourceInfo ?? item.source);
		const builtin = source?.source === "builtin" && source.path === `builtin:${item.name}` ? tools.get(item.name) : undefined;
		tools.set(item.name, {
			name: item.name, description: item.description, category: builtin?.category ?? (source?.source === "builtin" ? "Pi 内置" : "扩展工具"),
			risk: builtin?.risk ?? (item.annotations?.readOnlyHint === true ? "read-only" : "high"), available: true,
			...(item.parameters ? { parameters: publicToolParameters(item.parameters) } : builtin?.parameters ? { parameters: builtin.parameters } : {}),
			...(source ? { source } : {}),
		});
		associate(item, "tools");
	}
	for (const item of resources?.commands ?? []) {
		if (item && typeof item.name === "string" && item.source === "extension" && item.name !== "harness-web-models") associate(item, "commands");
	}
	for (const name of new Set(["harness-manager", ...profiles.flatMap((profile) => profile.value.adapters?.pi?.extensions ?? [])])) {
		if (!extensions.has(name)) extensions.set(name, { name, description: "Profile 声明的扩展，未在资源目录中发现。", origin: "declared", commands: [], tools: [], available: false, required: name === "harness-manager" });
	}
	for (const name of profiles.flatMap((profile) => profile.value.adapters?.pi?.tools ?? [])) {
		if (!tools.has(name)) tools.set(name, { name, description: "Profile 声明的工具，未在 Pi 注册工具目录中发现。", category: "未发现", risk: "unknown", available: false });
	}
	return JSON.parse(JSON.stringify({
		piTools: [...tools.values()].sort((left, right) => left.name.localeCompare(right.name)),
		piExtensionDetails: [...extensions.values()].map((entry) => ({
			...entry,
			...(entry.source && redactResourceText(entry.source) !== entry.source ? { sourceRedacted: true } : {}),
		})).sort((left, right) => left.name.localeCompare(right.name)),
		piResourceWarning: [...new Set(warnings)].join(" ") || null,
	}, (_key, value) => typeof value === "string" ? redactResourceText(value) : value));
}

/** Read source hashes and configuration resources, not a Profile's loaded/active state.
 * piResources accepts {tools, commands, packages: [{source, path?}], warning?}; URL credentials
 * are redacted from public resource metadata only after exact source/path association.
 * Only package.json's name/description/version/pi.extensions are inspected; no Catalog code runs.
 * piExtensions remains string[]; metadata includes missing Profile declarations with available=false.
 */
export function readCatalog(repo, { modelOutput = "", models: registeredModels, scopeModels = [], engine = ENGINE, piResources } = {}) {
	assertCatalog(repo);
	const profiles = readProfiles(repo);
	let models = registeredModels ?? parsePiModelList(modelOutput);
	if (scopeModels.length > 0) {
		const scope = new Map(scopeModels.map((entry) => [`${entry.provider}\0${entry.id}`, entry]));
		models = models.filter((model) => scope.has(`${model.provider}\0${model.id}`)).map((model) => ({
			...model,
			scopeThinking: scope.get(`${model.provider}\0${model.id}`)?.thinking,
		}));
	}
	const selectionPath = join(repo, "instructions", "selection.json");
	const selectionSource = readFileSync(selectionPath, "utf8");
	const codexModels = [...new Set(profiles.map((profile) => profile.value.adapters?.codex?.model?.id).filter(Boolean))].sort();
	const resources = readPiResources(repo, engine, profiles, piResources);
	return {
		profiles,
		managementContext: { engine, skillRoot: join(repo, "skills"), skillsCli: pins().skillsCli },
		instructions: readInstructions(repo),
		skills: readSkills(repo),
		models,
		codexModels,
		piExtensions: resources.piExtensionDetails.map((entry) => entry.name),
		...resources,
		globalInstructions: { sourceHash: hashText(selectionSource), value: JSON.parse(selectionSource) },
		modelScope: scopeModels.length > 0 ? "session" : "available",
	};
}
