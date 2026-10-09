import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

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
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && existsSync(join(root, entry.name, "SKILL.md")))
		.map((entry) => ({
			name: entry.name,
			category: skillCategory(entry.name),
			description: parseSkillDescription(readFileSync(join(root, entry.name, "SKILL.md"), "utf8")),
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

import { ENGINE, assertCatalog } from "./repo.mjs";

/** Read source hashes, full instruction/Skill descriptions, and a scope-filtered model directory. */
export function readCatalog(repo, { modelOutput = "", models: registeredModels, scopeModels = [], engine = ENGINE } = {}) {
	assertCatalog(repo);
	const profiles = readProfiles(repo);
	let models = registeredModels?.length ? registeredModels : parsePiModelList(modelOutput);
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
	const piExtensions = [...new Set([engine, repo].flatMap((root) => {
		const extensionRoot = join(root, "adapters/pi/extensions");
		return existsSync(extensionRoot) ? readdirSync(extensionRoot, { withFileTypes: true }).flatMap((entry) =>
			entry.isFile() && entry.name.endsWith(".ts") ? [basename(entry.name, ".ts")]
				: entry.isDirectory() && existsSync(join(extensionRoot, entry.name, "index.ts")) ? [entry.name] : []) : [];
	}))].sort();
	return {
		profiles,
		instructions: readInstructions(repo),
		skills: readSkills(repo),
		models,
		codexModels,
		piExtensions,
		globalInstructions: { sourceHash: hashText(selectionSource), value: JSON.parse(selectionSource) },
		modelScope: scopeModels.length > 0 ? "session" : "available",
	};
}
