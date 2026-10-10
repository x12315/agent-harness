import { createResourcePlan, repositoryUrl, resourceOwnership } from "./resource-plans.js";

const state = {
	catalog: null,
	drafts: new Map(),
	globalDraft: null,
	detail: null,
	variant: "standard",
	skillQuery: "",
	skillCategory: "全部",
	modelQuery: "",
	catalogSkillQuery: "",
	piResourceQuery: "",
	piResourceKind: "all",
	healthOutput: "尚未运行完整检查。",
	busy: false,
	pendingSave: null,
	undo: new Map(),
	markdownDraft: null,
	pendingSection: null,
	deletingProfile: null,
	lastDeletion: null,
	resourceRequest: { kind: "skill", operation: "install", sourceMode: "git", source: "", revision: "", destination: "", name: "", effect: "references" },
	resourcePlan: null,
	resourceError: "",
	sync: null,
	syncForm: null,
	syncError: "",
	pendingSync: null,
	syncChecking: false,
};

const app = document.querySelector("#app");
const main = document.querySelector("#main");
const nav = document.querySelector("#primary-nav");
const inspector = document.querySelector("#inspector");
const connectionState = document.querySelector("#connection-state");
const toastRegion = document.querySelector("#toast-region");
const confirmDialog = document.querySelector("#confirm-dialog");
const confirmBody = document.querySelector("#confirm-body");
const instructionEditor = document.querySelector("#instruction-editor");
const instructionText = document.querySelector("#instruction-text");
const createProfileDialog = document.querySelector("#profile-create-dialog");
const deleteProfileDialog = document.querySelector("#profile-delete-dialog");
const syncDialog = document.querySelector("#catalog-sync-dialog");

const draftKey = (name) => `harness-draft:${encodeURIComponent(state.catalog.repo)}:${name}`;
const clone = (value) => structuredClone(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const escapeHtml = (value = "") => String(value)
	.replaceAll("&", "&amp;")
	.replaceAll("<", "&lt;")
	.replaceAll(">", "&gt;")
	.replaceAll('"', "&quot;")
	.replaceAll("'", "&#039;");

function route() {
	const hash = location.hash.replace(/^#\/?/, "");
	if (hash.startsWith("profile/")) {
		const name = hash.slice("profile/".length);
		return state.catalog && !state.catalog.profiles.some((profile) => profile.name === name) ? { page: "compare" } : { page: "profile", name };
	}
	if (["global", "skills", "pi", "manage", "sync", "health"].includes(hash)) return { page: hash };
	return { page: "compare" };
}

async function api(path, options = {}) {
	const response = await fetch(path, {
		...options,
		headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
	});
	const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
	if (!response.ok || payload.ok === false) throw Object.assign(new Error(payload.error ?? `HTTP ${response.status}`), { payload, status: response.status });
	return payload;
}

function saveValidationSummary(result) {
	const scope = Object.entries(result.validation?.runtime ?? {}).filter(([, names]) => names.length)
		.map(([adapter, names]) => `${adapter}: ${names.join(", ")}`).join("；");
	return `${result.validation?.kind === "unchanged" ? "配置未变化" : `增量检查通过（${scope || "配置与投影"}）`} · ${(result.durationMs / 1000).toFixed(2)} 秒`;
}

function saveValidationLog(result) {
	return `${saveValidationSummary(result)}\n未运行完整 doctor。\n\n${(result.logs ?? []).map((entry) => `== ${entry.name} (${entry.code}, ${entry.durationMs}ms)\n${entry.output}`).join("\n\n")}`;
}

function toast(message, type = "info") {
	const element = document.createElement("div");
	element.className = `toast ${type}`;
	element.textContent = message;
	toastRegion.append(element);
	setTimeout(() => element.remove(), 4200);
}

function profileRecord(name) {
	return state.catalog.profiles.find((profile) => profile.name === name);
}

function draftRecord(name) {
	if (state.drafts.has(name)) return state.drafts.get(name);
	const profile = profileRecord(name);
	if (!profile) return null;
	const storageKey = draftKey(name);
	let value = clone(profile.value);
	let restored = false;
	let baseHash = profile.sourceHash;
	try {
		const saved = JSON.parse(localStorage.getItem(storageKey));
		if (saved?.sourceHash && typeof saved.value?.label === "string") {
			value = saved.value;
			baseHash = saved.sourceHash;
			restored = !same(value, profile.value);
		}
	} catch {
		localStorage.removeItem(storageKey);
	}
	const record = { value, restored, storageKey, baseHash, stale: baseHash !== profile.sourceHash };
	state.drafts.set(name, record);
	return record;
}

function globalDraft() {
	if (state.globalDraft) return state.globalDraft;
	const source = state.catalog.globalInstructions;
	const storageKey = `harness-global-draft:${encodeURIComponent(state.catalog.repo)}`;
	let value = clone(source.value);
	let restored = false;
	let baseHash = source.sourceHash;
	try {
		const stored = localStorage.getItem(storageKey);
		const saved = JSON.parse(stored ?? localStorage.getItem(draftKey("global-instructions")));
		if (saved?.sourceHash && Array.isArray(saved.value?.mandatory) && Array.isArray(saved.value?.repository)) {
			if (stored === null) {
				localStorage.setItem(storageKey, JSON.stringify(saved));
				localStorage.removeItem(draftKey("global-instructions"));
			}
			value = saved.value;
			baseHash = saved.sourceHash;
			restored = !same(value, source.value);
		}
	} catch {
		localStorage.removeItem(storageKey);
	}
	state.globalDraft = { value, restored, storageKey, baseHash, stale: baseHash !== source.sourceHash };
	return state.globalDraft;
}

function persistProfile(name) {
	const draft = draftRecord(name);
	localStorage.setItem(draft.storageKey, JSON.stringify({ sourceHash: draft.baseHash, value: draft.value }));
}

function persistGlobal() {
	const draft = globalDraft();
	localStorage.setItem(draft.storageKey, JSON.stringify({ sourceHash: draft.baseHash, value: draft.value }));
}

function selectedSkills(profile) {
	const selected = new Set();
	for (const pattern of profile.skills ?? []) {
		const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
		for (const skill of state.catalog.skills) if (regex.test(skill.name)) selected.add(skill.name);
	}
	return selected;
}

function instructionSelection(profile, id) {
	return profile.instructions.find((entry) => entry.id === id);
}

function dirtyProfiles() {
	return state.catalog.profiles.filter((profile) => {
		const draft = state.drafts.get(profile.name);
		return draft && !same(draft.value, profile.value);
	}).map((profile) => profile.name);
}

function isGlobalDirty() {
	return state.globalDraft && !same(state.globalDraft.value, state.catalog.globalInstructions.value);
}

function renderNav() {
	const current = route();
	const dirty = new Set(dirtyProfiles());
	nav.innerHTML = `
		<button class="nav-link" data-route="compare" aria-current="${current.page === "compare" ? "page" : "false"}">配置方案</button>
		${state.catalog.profiles.map((profile) => `
			<button class="nav-link profile-link" data-route="profile/${escapeHtml(profile.name)}" aria-current="${current.page === "profile" && current.name === profile.name ? "page" : "false"}">
				${escapeHtml(draftRecord(profile.name).value.label || profile.name)}${dirty.has(profile.name) ? '<span class="change-count" aria-label="有未保存修改">●</span>' : ""}
			</button>`).join("")}
		<p class="nav-group-label">共享资源</p>
		<button class="nav-link" data-route="global" aria-current="${current.page === "global" ? "page" : "false"}">全局指令${isGlobalDirty() ? '<span class="change-count" aria-label="有未保存修改">●</span>' : ""}</button>
		<button class="nav-link" data-route="skills" aria-current="${current.page === "skills" ? "page" : "false"}">Skills</button>
		<button class="nav-link" data-route="pi" aria-current="${current.page === "pi" ? "page" : "false"}">Pi 工具与扩展</button>
		<button class="nav-link" data-route="manage" aria-current="${current.page === "manage" ? "page" : "false"}">安装与管理</button>
		<button class="nav-link" data-route="sync" aria-current="${current.page === "sync" ? "page" : "false"}">配置仓同步${state.sync?.hasUpdate ? ' · 有更新' : ""}</button>
		<button class="nav-link" data-route="health" aria-current="${current.page === "health" ? "page" : "false"}">系统检查</button>
	`;
}

function modelText(profile, adapter = "pi") {
	const model = profile.adapters?.[adapter]?.model;
	if (!model) return "继承默认";
	return `${adapter === "pi" ? `${model.provider}/` : ""}${model.id}${model.thinking ? `:${model.thinking}` : ""}`;
}

function profileListActions(name) {
	const draft = draftRecord(name);
	const dirty = !same(profileRecord(name).value, draft.value);
	return `<span class="configuration-status">${draft.stale ? "来源已变更" : dirty ? "未保存" : "已保存"}</span>
		<button class="button compact" data-route="profile/${escapeHtml(name)}">编辑配置</button>
		<button class="button compact" data-action="duplicate-profile" data-profile="${escapeHtml(name)}">复制方案</button>
		<button class="button primary compact" data-action="save-profile" data-profile="${escapeHtml(name)}" ${!dirty || draft.stale || state.busy ? "disabled" : ""}>保存修改</button>
		${dirty ? `<button class="button text" data-action="reset-profile" data-profile="${escapeHtml(name)}" ${state.busy ? "disabled" : ""}>放弃修改</button>` : ""}
		${draft.stale ? `<button class="button text" data-route="profile/${escapeHtml(name)}">处理冲突</button>` : ""}
		<button class="button text danger" data-action="delete-profile" data-profile="${escapeHtml(name)}" ${state.catalog.profiles.length <= 1 ? 'disabled title="至少保留一个方案"' : ""}>删除方案</button>`;
}

function renderCompare() {
	const profiles = state.catalog.profiles.map((profile) => ({ ...profile, value: draftRecord(profile.name).value }));
	main.innerHTML = `
		<header class="page-header"><div class="section-heading"><h2>配置方案</h2><button class="button primary" data-action="create-profile">新建方案</button></div><p>管理各方案的 Pi 模型、工具、扩展、指令和 Skills。保存更新配置；运行中的会话需重新加载或重新选择方案。</p></header>
		${state.lastDeletion ? `<div class="deletion-result" role="status">已删除方案 <strong>${escapeHtml(state.lastDeletion.name)}</strong>。源码快照：<code>${escapeHtml(state.lastDeletion.backup)}</code><p class="helper">快照是临时文件；如需长期保留，请另行备份。</p><button class="button text" data-action="dismiss-deletion">关闭提示</button></div>` : ""}
		<div class="configuration-list" role="region" aria-label="配置方案列表">
			${profiles.map((profile) => `<section class="configuration-row" aria-label="${escapeHtml(profile.name)} 配置方案">
				<div class="configuration-fields">
					<label class="field"><span>方案名称</span><input type="text" data-action="profile-label" data-profile="${escapeHtml(profile.name)}" aria-label="${escapeHtml(profile.name)} 方案名称" value="${escapeHtml(profile.value.label)}"></label>
					<label class="field"><span>说明</span><textarea rows="2" data-action="profile-description" data-profile="${escapeHtml(profile.name)}" aria-label="${escapeHtml(profile.name)} 说明">${escapeHtml(profile.value.description)}</textarea></label>
					<span class="helper">方案 ID：<code>${escapeHtml(profile.name)}</code></span>
				</div>
				<div class="configuration-summary"><dl><dt>Pi 模型</dt><dd>${escapeHtml(modelText(profile.value))}</dd></dl><span class="helper">${profile.value.adapters.pi.tools === undefined ? "Pi 工具继承默认" : `${profile.value.adapters.pi.tools.length} 个 Pi 工具`} · ${profile.value.adapters.pi.extensions.length} 个扩展</span><details class="other-agent-settings"><summary>其他 agent 配置</summary><dl><dt>Codex 模型</dt><dd>${escapeHtml(modelText(profile.value, "codex"))}</dd></dl></details><span class="helper">${profile.value.instructions.length} 条指令 · ${selectedSkills(profile.value).size} 个 Skills</span></div>
				<div class="configuration-actions" data-profile-actions="${escapeHtml(profile.name)}">${profileListActions(profile.name)}</div>
			</section>`).join("")}
		</div>
		<details class="configuration-comparison"><summary>比较方案配置（含未保存修改）</summary>${comparisonTable(profiles)}</details>`;
	renderInspector();
}

function comparisonTable(profiles) {
	const allInstructionIds = new Set(profiles.flatMap((profile) => profile.value.instructions.map((entry) => entry.id)));
	const allSkillNames = new Set(profiles.flatMap((profile) => [...selectedSkills(profile.value)]));
	const instructionCells = profiles.map((profile) => {
		const map = new Map(profile.value.instructions.map((entry) => [entry.id, entry.detail]));
		return [...allInstructionIds].map((id) => map.has(id) ? `<span class="tag">${escapeHtml(id.split("/").at(-1))} · ${escapeHtml(map.get(id))}</span>` : "").join("");
	});
	const skillCells = profiles.map((profile) => {
		const selected = selectedSkills(profile.value);
		return [...allSkillNames].filter((name) => selected.has(name)).map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join("");
	});
	const rows = [
		["Pi 模型", ...profiles.map((profile) => escapeHtml(modelText(profile.value)))],
		["Codex 模型", ...profiles.map((profile) => escapeHtml(modelText(profile.value, "codex")))],
		["指令", ...instructionCells.map((cell) => `<div class="token-cloud">${cell || "—"}</div>`)],
		["Skills", ...skillCells.map((cell) => `<div class="token-cloud">${cell || "—"}</div>`)],
		["Pi 工具", ...profiles.map((profile) => escapeHtml((profile.value.adapters.pi.tools ?? ["继承"]).join(", ")))],
		["Pi 扩展", ...profiles.map((profile) => escapeHtml(profile.value.adapters.pi.extensions.join(", ")))],
	];
	return `<div class="compare-table-wrap"><table class="compare-table"><thead><tr><th scope="col">维度</th>${profiles.map((profile) => `<th scope="col">${escapeHtml(profile.value.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${row[0]}</th>${row.slice(1).map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function modelOptions(provider, selectedId) {
	const query = state.modelQuery.toLowerCase().trim();
	const matches = (value) => {
		let offset = 0;
		for (const character of query) {
			offset = value.toLowerCase().indexOf(character, offset);
			if (offset < 0) return false;
			offset++;
		}
		return true;
	};
	const models = state.catalog.models.filter((model) => model.provider === provider && (model.id === selectedId || matches(model.id)));
	const outsideScope = selectedId && !models.some((model) => model.id === selectedId)
		? `<option value="${escapeHtml(selectedId)}" selected disabled>${escapeHtml(selectedId)} · 当前推荐，目录外</option>` : "";
	return (!selectedId ? '<option value="" selected disabled>选择模型</option>' : "") + outsideScope + models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === selectedId ? "selected" : ""}>${escapeHtml(model.id)}${model.context ? ` · ${escapeHtml(model.context)}` : ""}</option>`).join("");
}

function thinkingOptions(model, selected) {
	const levels = model?.thinkingLevels ?? ["off"];
	const current = selected && !levels.includes(selected) ? `<option value="${escapeHtml(selected)}" selected disabled>${escapeHtml(selected)} · 当前值，能力未验证</option>` : "";
	return current + levels.map((level) => `<option value="${level}" ${level === selected ? "selected" : ""}>${level}</option>`).join("");
}

function instructionRows(profile) {
	const positions = new Map(profile.instructions.map((entry, index) => [entry.id, index]));
	const entries = state.catalog.instructions.filter((entry) => entry.layer === "profile")
		.sort((left, right) => (positions.get(left.id) ?? 999) - (positions.get(right.id) ?? 999));
	return entries.map((entry) => {
		const selection = instructionSelection(profile, entry.id);
		const active = Boolean(selection);
		const index = profile.instructions.findIndex((item) => item.id === entry.id);
		return `<div class="instruction-row ${active ? "" : "is-off"}">
			<div class="row-copy"><strong>${escapeHtml(entry.title)}</strong><p>${escapeHtml(entry.description)}</p></div>
			<div class="row-controls">
				<div class="order-controls" role="group" aria-label="调整指令顺序">
					<button class="icon-button" data-action="move-instruction" data-id="${escapeHtml(entry.id)}" data-direction="up" aria-label="上移 ${escapeHtml(entry.title)}" ${!active || index === 0 ? "disabled" : ""}>↑</button>
					<button class="icon-button" data-action="move-instruction" data-id="${escapeHtml(entry.id)}" data-direction="down" aria-label="下移 ${escapeHtml(entry.title)}" ${!active || index === profile.instructions.length - 1 ? "disabled" : ""}>↓</button>
				</div>
				${["brief", "standard", "detailed"].map((detail) => `<button class="segment" data-action="set-instruction-detail" data-id="${escapeHtml(entry.id)}" data-detail="${detail}" aria-pressed="${active && selection.detail === detail}" ${active ? "" : "disabled"}>${{ brief: "精简", standard: "标准", detailed: "详细" }[detail]}</button>`).join("")}
				<label class="switch-label"><input type="checkbox" aria-label="启用 ${escapeHtml(entry.title)}" data-action="toggle-instruction" data-id="${escapeHtml(entry.id)}" ${active ? "checked" : ""}>${active ? "已启用" : "未启用"}</label>
				<button class="button text" data-action="inspect-instruction" data-id="${escapeHtml(entry.id)}">查看全文</button>
			</div>
		</div>`;
	}).join("");
}

function filteredSkills() {
	const query = state.skillQuery.trim().toLowerCase();
	return state.catalog.skills.filter((skill) => (state.skillCategory === "全部" || skill.category === state.skillCategory) && (!query || `${skill.name} ${skill.description}`.toLowerCase().includes(query)));
}

function skillRows(profile) {
	const selected = selectedSkills(profile);
	return filteredSkills().map((skill) => `<div class="skill-row ${selected.has(skill.name) ? "" : "is-off"}">
		<div class="row-copy"><strong>${escapeHtml(skill.name)}</strong><p>${escapeHtml(skill.description)}</p></div>
		<div class="row-controls">
			<span class="tag">${escapeHtml(skill.category)}</span>
			<label class="switch-label"><input type="checkbox" aria-label="启用 ${escapeHtml(skill.name)}" data-action="toggle-skill" data-name="${escapeHtml(skill.name)}" ${selected.has(skill.name) ? "checked" : ""}>${selected.has(skill.name) ? "已启用" : "未启用"}</label>
			<button class="button text" data-action="inspect-skill" data-name="${escapeHtml(skill.name)}">完整说明</button>
		</div>
	</div>`).join("") || '<p class="empty-copy">没有符合当前筛选条件的 Skill。</p>';
}

function renderProfile(name) {
	const source = profileRecord(name);
	if (!source) {
		location.hash = "#compare";
		return;
	}
	const record = draftRecord(name);
	const profile = record.value;
	const piModel = profile.adapters.pi.model ?? { provider: "", id: "", thinking: "off" };
	const availableProviders = [...new Set(state.catalog.models.map((model) => model.provider))];
	const model = state.catalog.models.find((entry) => entry.provider === piModel.provider && entry.id === piModel.id);
	const categories = ["全部", ...new Set(state.catalog.skills.map((skill) => skill.category))];

	main.innerHTML = `
		<div class="profile-editor">
			<header class="page-header">
				<button class="button text back-link" data-route="compare">← 配置方案</button>
				<div class="profile-title-row"><h2 data-profile-heading>${escapeHtml(profile.label)}</h2><code class="helper">${escapeHtml(name)}</code></div>
				<nav class="section-nav" aria-label="配置分区"><button data-action="go-section" data-section="general">基本信息</button><button data-action="go-section" data-section="models">模型</button><button data-action="go-section" data-section="instructions">指令</button><button data-action="go-section" data-section="skills">Skills</button><button data-action="go-section" data-section="runtime">Pi 工具与扩展</button></nav>
			</header>
			${record.stale ? '<div class="error-summary">来源已被另一个管理器修改，草稿已保留。请对照最新差异后确认。<button class="button" data-action="review-conflict">按最新来源重新审阅草稿</button></div>' : record.restored ? '<div class="restore-banner"><span>已恢复本浏览器中尚未保存的草稿。</span><button class="button ghost compact" data-action="reset-profile">放弃草稿</button></div>' : ""}
			<div class="section-stack">
				<section class="composer-section" id="section-general" tabindex="-1">
					<div class="section-heading"><h3>基本信息</h3></div>
					<div class="field-grid"><label class="field"><span>方案名称</span><input type="text" data-action="profile-label" value="${escapeHtml(profile.label)}"></label><label class="field"><span>说明</span><textarea data-action="profile-description">${escapeHtml(profile.description)}</textarea></label></div>
					<details class="copy-settings"><summary>从其他方案复制配置</summary><p class="helper">替换当前方案的对应配置，不修改来源方案。来源有草稿时使用草稿内容；复制后需保存。</p><div class="toolbar"><label class="field"><span>来源方案</span><select data-action="copy-source"><option value="">选择方案</option>${state.catalog.profiles.filter((item) => item.name !== name).map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(draftRecord(item.name).value.label)}</option>`).join("")}</select></label><button class="button ghost compact" data-action="copy-skills">复制 Skills</button><button class="button ghost compact" data-action="copy-instructions">复制指令</button></div></details>
				</section>
				<section class="composer-section" id="section-models" tabindex="-1">
					<div class="section-heading"><div class="section-heading-copy"><h3>模型</h3><p>设置方案的默认模型。命令行或会话中的显式选择优先；启动仍遵从 Pi 的本机模型范围，范围内不含推荐模型时可能选其他模型。Pi 可选范围：${state.catalog.modelScope === "session" ? "启动控制台时的模型范围" : "已认证模型"}。</p></div></div>
					<div class="field-grid three">
						<label class="field"><span>Pi 提供商</span><select data-action="pi-provider">${!availableProviders.includes(piModel.provider) ? `<option selected disabled value="${escapeHtml(piModel.provider)}">${piModel.provider ? `${escapeHtml(piModel.provider)} · 不在可选范围内` : "继承默认模型"}</option>` : ""}${availableProviders.map((provider) => `<option value="${escapeHtml(provider)}" ${provider === piModel.provider ? "selected" : ""}>${escapeHtml(provider)}</option>`).join("")}</select></label>
						<label class="field"><span>搜索 Pi 模型</span><input type="search" data-action="model-search" value="${escapeHtml(state.modelQuery)}" placeholder="模糊搜索，例如 56t 或 dsf"></label><label class="field"><span>Pi 模型</span><select data-action="pi-model">${modelOptions(piModel.provider, piModel.id)}</select></label>
						<label class="field"><span>Pi 思考级别</span><select data-action="pi-thinking" ${!profile.adapters.pi.model ? "disabled" : ""}>${!profile.adapters.pi.model ? '<option selected>继承默认级别</option>' : thinkingOptions(model, piModel.thinking ?? "off")}</select></label>
					</div>
					<details class="other-agent-settings"><summary>其他 agent 模型（高级）</summary><div class="field-grid three">
						<label class="field"><span>Codex 模型</span><select data-action="codex-model">${!profile.adapters.codex.model?.id ? '<option value="" selected disabled>继承默认模型</option>' : ""}${[...new Set([...state.catalog.codexModels, piModel.id, profile.adapters.codex.model?.id].filter(Boolean))].sort().map((id) => `<option value="${escapeHtml(id)}" ${id === profile.adapters.codex.model?.id ? "selected" : ""}>${escapeHtml(id)}</option>`).join("")}</select><span class="helper">列出已有方案中的模型；其他模型可手动输入。</span></label>
						<label class="field"><span>Codex 思考级别</span><select data-action="codex-thinking" ${!profile.adapters.codex.model?.id ? "disabled" : ""}>${!profile.adapters.codex.model?.thinking ? '<option value="" selected disabled>继承默认级别</option>' : ""}${["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => `<option value="${level}" ${level === profile.adapters.codex.model?.thinking ? "selected" : ""}>${level}</option>`).join("")}</select></label>
						<div class="field"><span class="field-label">复制模型设置</span><button class="button" data-action="sync-codex-model" ${!profile.adapters.pi.model?.id ? "disabled" : ""}>从 Pi 复制</button><span class="helper">仅复制当前模型与思考级别，不会持续同步。保存时检查 Codex 兼容性。</span></div><details><summary>手动输入 Codex 模型</summary><label class="field"><span>Codex 模型标识</span><input data-action="codex-model-manual" value="${escapeHtml(profile.adapters.codex.model?.id ?? "")}" autocomplete="off"></label></details>
					</div></details>
				</section>
				<section class="composer-section" id="section-instructions" tabindex="-1">
					<div class="section-heading"><div class="section-heading-copy"><h3>方案指令</h3><p>已启用的指令按列表顺序追加到全局指令之后。每条选择一个完整文本版本。</p></div><span class="count">已启用 ${profile.instructions.length} 条</span></div>
					<div class="toolbar"><button class="button ghost compact" data-action="inspect-effective">预览合并指令</button></div>
					<div class="instruction-list">${instructionRows(profile)}</div>
				</section>
				<section class="composer-section" id="section-skills" tabindex="-1">
					<div class="section-heading"><h3>Skills</h3><span class="count">已启用 ${selectedSkills(profile).size} / ${state.catalog.skills.length}</span></div>
					<div class="toolbar"><label class="search-wrap"><span class="field-label">搜索 Skills</span><input class="search-input" type="search" data-action="skill-search" value="${escapeHtml(state.skillQuery)}" placeholder="名称或说明"></label><div class="filter-group" role="group" aria-label="Skill 类别">${categories.map((category) => `<button class="filter-chip" data-action="skill-category" data-category="${escapeHtml(category)}" aria-pressed="${category === state.skillCategory}">${escapeHtml(category)}</button>`).join("")}</div></div>
					<div class="toolbar"><button class="button ghost compact" data-action="bulk-skills" data-mode="enable">启用当前结果</button><button class="button ghost compact" data-action="bulk-skills" data-mode="disable">停用当前结果</button></div>
					<div class="skill-list">${skillRows(profile)}</div>
				</section>
				<section class="composer-section" id="section-runtime" tabindex="-1">
					<div class="section-heading"><div class="section-heading-copy"><h3>Pi 工具与扩展</h3><p>工具是模型可调用的能力；扩展还可提供人工命令和事件回调。启用扩展不会自动开放它的工具。管理扩展必须保留。</p></div></div>
					${piResourceToolbar()}
					<div data-pi-resources>${piResourceLists(profile)}</div>
					<details class="other-agent-settings"><summary>其他 agent 权限（高级）</summary><div class="field-grid">
						<label class="field"><span>Codex 沙盒权限</span><select data-action="codex-sandbox">${["read-only", "workspace-write", "danger-full-access"].map((value) => `<option value="${value}" ${value === profile.adapters.codex.sandbox ? "selected" : ""}>${value}</option>`).join("")}</select></label>
						<label class="field"><span>Codex 审批策略</span><select data-action="codex-approval">${["on-request", "never"].map((value) => `<option value="${value}" ${value === profile.adapters.codex.approval ? "selected" : ""}>${value}</option>`).join("")}</select></label>
					</div></details>
				</section>
			</div>
		</div>`;
	renderInspector();
}

function globalSelections(value) {
	return [...value.mandatory, ...value.repository];
}

function renderGlobal() {
	const record = globalDraft();
	const entries = state.catalog.instructions.filter((entry) => entry.layer !== "profile");
	const selections = globalSelections(record.value);
	main.innerHTML = `
		<header class="page-header"><h2>全局指令</h2><p>应用于所有配置方案。必选指令不能关闭；每条指令只使用所选版本的文本。</p></header>
		${record.stale ? '<div class="error-summary">来源已被另一个管理器修改，草稿已保留。<button class="button" data-action="review-conflict">按最新来源重新审阅草稿</button></div>' : record.restored ? '<div class="restore-banner"><span>已恢复全局指令的未保存修改。</span><button class="button ghost compact" data-action="reset-global">放弃草稿</button></div>' : ""}
		<section class="composer-section"><div class="instruction-list">${entries.map((entry) => {
			const selection = selections.find((item) => item.id === entry.id);
			const locked = entry.layer === "mandatory";
			return `<div class="instruction-row ${selection ? "" : "is-off"}"><div class="row-copy"><strong>${escapeHtml(entry.title)}</strong><p>${escapeHtml(entry.description)}</p></div><div class="row-controls"><span class="tag">${locked ? "必选" : "可选"}</span>${["brief", "standard", "detailed"].map((detail) => `<button class="segment" data-action="global-detail" data-id="${escapeHtml(entry.id)}" data-detail="${detail}" aria-pressed="${selection?.detail === detail}" ${selection ? "" : "disabled"}>${{ brief: "精简", standard: "标准", detailed: "详细" }[detail]}</button>`).join("")}<label class="switch-label"><input type="checkbox" aria-label="启用 ${escapeHtml(entry.title)}" data-action="global-toggle" data-id="${escapeHtml(entry.id)}" ${selection ? "checked" : ""} ${locked ? "disabled" : ""}>${selection ? "已启用" : "未启用"}</label><button class="button text" data-action="inspect-instruction" data-id="${escapeHtml(entry.id)}">查看全文</button></div></div>`;
		}).join("")}</div></section>`;
	renderInspector();
}

function renderSkillsCatalog() {
	const query = state.catalogSkillQuery.trim().toLowerCase();
	const skills = state.catalog.skills.filter((skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query));
	main.innerHTML = `
		<header class="page-header"><h2>Skills</h2><p>查看已安装的 Skills。方案开关只控制启用，不安装或卸载。</p><button class="button ghost compact" data-action="open-resource-management" data-kind="skill">添加来源 / 管理安装</button></header>
		<div class="toolbar"><label class="search-wrap"><span class="field-label">搜索 Skills</span><input class="search-input" type="search" data-action="catalog-skill-search" value="${escapeHtml(state.catalogSkillQuery)}" placeholder="名称、类别或触发条件"></label><span class="count">${skills.length}/${state.catalog.skills.length}</span></div>
		<section class="composer-section"><div class="skill-list">${skills.map((skill) => `<div class="skill-row"><div class="row-copy"><strong>${escapeHtml(skill.name)}</strong><p>${escapeHtml(skill.description)}</p></div><div class="row-controls"><span class="tag">${escapeHtml(skill.category)}</span>${state.catalog.profiles.map((profile) => `<button class="button text" data-route="profile/${escapeHtml(profile.name)}" data-section="skills" aria-label="配置 ${escapeHtml(draftRecord(profile.name).value.label)} 的 Skills">${escapeHtml(draftRecord(profile.name).value.label)} · ${selectedSkills(draftRecord(profile.name).value).has(skill.name) ? "已启用" : "未启用"}</button>`).join("")}<button class="button text" data-action="inspect-skill" data-name="${escapeHtml(skill.name)}">完整说明</button></div></div>`).join("") || '<p class="empty-copy">没有匹配结果。</p>'}</div></section>`;
	renderInspector();
}

function piResources(kind) {
	return kind === "tool" ? state.catalog.piTools ?? [] : state.catalog.piExtensionDetails ?? [];
}

function filteredPiResources(kind) {
	const query = state.piResourceQuery.trim().toLowerCase();
	return piResources(kind).filter((entry) => !query || [entry.name, entry.description, entry.category, entry.origin, ...(entry.commands ?? []), ...(entry.tools ?? [])].join(" ").toLowerCase().includes(query));
}

function piResourceOrigin(entry, kind) {
	if (kind === "tool") return entry.source?.source === "builtin" ? "Pi 内置" : "扩展工具";
	return resourceOwnership(entry, kind);
}

function piToolRisk(entry) {
	return { "read-only": "只读", write: "改写文件", high: "可执行或改变状态", unknown: "风险待确认" }[entry.risk] ?? "风险待确认";
}

function piResourceToolbar() {
	return `${state.catalog.piResourceWarning ? `<p class="resource-warning" role="status">${escapeHtml(state.catalog.piResourceWarning)}</p>` : ""}<div class="toolbar"><label class="search-wrap"><span class="field-label">搜索 Pi 资源</span><input class="search-input" type="search" data-action="pi-resource-search" value="${escapeHtml(state.piResourceQuery)}" placeholder="名称、说明、命令或工具"></label><div class="filter-group" role="group" aria-label="Pi 资源类型">${[["all", "全部"], ["tool", "工具"], ["extension", "扩展"]].map(([kind, label]) => `<button class="filter-chip" data-action="pi-resource-kind" data-kind="${kind}" aria-pressed="${state.piResourceKind === kind}">${label}</button>`).join("")}</div></div><p class="helper">这是可配置资源目录，不是当前会话的加载证明。保存会检查目标 Profile；已有会话需重新选择 Profile。</p>`;
}

function piResourceSelection(profile, kind, name) {
	const values = profile.adapters.pi[kind === "tool" ? "tools" : "extensions"];
	return values === undefined ? "继承默认" : values.includes(name) ? "已启用" : "未启用";
}

function piResourceRows(kind, profile) {
	return filteredPiResources(kind).map((entry) => {
		const selection = profile ? piResourceSelection(profile, kind, entry.name) : undefined;
		const active = selection === "已启用";
		const providers = kind === "tool" ? piResources("extension").filter((extension) => extension.tools.includes(entry.name)) : [];
		const missingProviders = profile && providers.length && !providers.some((extension) => profile.adapters.pi.extensions.includes(extension.name));
		const status = !entry.available ? "来源未发现" : entry.required ? "必选" : piResourceOrigin(entry, kind);
		return `<div class="resource-row ${selection === "未启用" ? "is-off" : ""}" data-resource-kind="${kind}" data-resource-name="${escapeHtml(entry.name)}">
			<div class="row-copy"><strong>${escapeHtml(entry.name)}</strong><p>${escapeHtml(entry.description)}</p>${missingProviders ? `<p class="resource-warning">需要扩展 ${escapeHtml(providers.map((extension) => extension.name).join(" 或 "))}，当前方案尚未启用。</p>` : ""}${!entry.available ? '<p class="resource-warning">原有声明会保留；请恢复来源或停用，不能以目录代替运行时验收。</p>' : ""}</div>
			<div class="row-controls"><span class="tag">${escapeHtml(kind === "tool" ? piToolRisk(entry) : status)}</span>
			${profile ? `<label class="switch-label"><input type="checkbox" aria-label="启用 Pi ${kind === "tool" ? "工具" : "扩展"} ${escapeHtml(entry.name)}" data-action="toggle-${kind}" data-name="${escapeHtml(entry.name)}" ${active ? "checked" : ""} ${entry.required || !entry.available && !active ? "disabled" : ""}>${selection}</label>` : state.catalog.profiles.map((source) => `<button class="button text" data-route="profile/${escapeHtml(source.name)}" data-section="runtime" aria-label="配置 ${escapeHtml(draftRecord(source.name).value.label)} 的 Pi 资源">${escapeHtml(draftRecord(source.name).value.label)} · ${piResourceSelection(draftRecord(source.name).value, kind, entry.name)}</button>`).join("")}
			<button class="button text" data-action="inspect-pi-resource" data-kind="${kind}" data-name="${escapeHtml(entry.name)}" aria-label="查看 ${escapeHtml(entry.name)} 的完整说明">完整说明</button></div>
		</div>`;
	}).join("") || '<p class="empty-copy">没有匹配结果。可清空搜索或切换资源类型。</p>';
}

function piResourceLists(profile) {
	return ["tool", "extension"].filter((kind) => state.piResourceKind === "all" || state.piResourceKind === kind).map((kind) => {
		const entries = piResources(kind);
		const selected = profile?.adapters.pi[kind === "tool" ? "tools" : "extensions"];
		return `<section class="resource-group" aria-label="Pi ${kind === "tool" ? "工具" : "扩展"}"><div class="section-heading"><${profile ? "h4" : "h3"}>Pi ${kind === "tool" ? "工具" : "扩展"}</${profile ? "h4" : "h3"}><span class="count">${selected ? `已启用 ${selected.length} · ` : profile && kind === "tool" ? "继承默认 · " : ""}显示 ${filteredPiResources(kind).length} / ${entries.length}</span></div>${piResourceRows(kind, profile)}</section>`;
	}).join("");
}

function renderPiCatalog() {
	main.innerHTML = `<header class="page-header"><h2>Pi 工具与扩展</h2><p>查看 Pi 内置工具、扩展和已安装包。方案开关只控制启用，安装和移除另行审阅。</p><button class="button ghost compact" data-action="open-resource-management" data-kind="extension">添加来源 / 管理安装</button></header>${piResourceToolbar()}<section class="composer-section" data-pi-resources>${piResourceLists()}</section>`;
	renderInspector();
}

function updateResourceRequest(target) {
	const request = state.resourceRequest;
	request[target.dataset.field] = target.value;
	if (target.dataset.field === "kind") {
		request.name = "";
		request.destination = request.kind === "skill" ? state.catalog.managementContext?.skillRoot ?? `${state.catalog.repo}/skills` : "";
		if (request.kind === "skill" && request.sourceMode === "npm") request.sourceMode = "git";
	}
	if (request.operation !== "install" && !request.name) request.name = (request.kind === "skill" ? state.catalog.skills : piResources("extension"))[0]?.name ?? "";
	if (target.dataset.field === "operation") { request.effect = "references"; if (request.operation !== "install") { request.destination = ""; request.revision = ""; } }
	state.resourcePlan = null;
	state.resourceError = "";
}

function renderResourceManagement() {
	const request = state.resourceRequest;
	const entries = request.kind === "skill" ? state.catalog.skills : piResources("extension");
	const select = (field, values) => `<select data-action="resource-plan-field" data-field="${field}">${values.map(([value, label]) => `<option value="${escapeHtml(value)}" ${request[field] === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>`;
	const input = (field, placeholder = "") => `<input data-action="resource-plan-field" data-field="${field}" value="${escapeHtml(request[field])}" placeholder="${escapeHtml(placeholder)}" autocomplete="off">`;
	const plan = state.resourcePlan;
	main.innerHTML = `<header class="page-header"><h2>安装与管理</h2><p>先核验来源与影响，再由你批准 AI agent 使用官方工具实施。此页面不执行安装或卸载，复制任务也不代表批准。</p></header>
		<div class="management-grid"><section class="composer-section"><h3>填写管理请求</h3><form id="resource-management-form" class="section-stack">
			<div class="field-grid"><label class="field"><span>资源类型</span>${select("kind", [["skill", "Skill"], ["extension", "Pi 扩展包"]])}</label><label class="field"><span>管理操作</span>${select("operation", [["install", "添加来源"], ["inspect", "核验现有安装"], ["remove", "审阅移除"]])}</label></div>
			${request.operation === "install" ? `<label class="field"><span>来源类型</span>${select("sourceMode", [["local", "本地文件或目录"], ["git", "远端 Git 仓库"], ...(request.kind === "extension" ? [["npm", "npm 包"]] : [])])}</label><label class="field"><span>${request.sourceMode === "local" ? "本地来源路径" : "远端地址或包名"}</span>${input("source", request.sourceMode === "local" ? "~/Desktop/my-resource" : request.sourceMode === "npm" ? "npm:@example/pi-tools@1.0.0" : "https://github.com/owner/repository")}<span class="helper">本地引用保留原文件；远端来源先核验再固定版本。不要填写 token、密码或带凭据的地址。</span></label><div class="field-grid"><label class="field"><span>固定版本或 commit（待核验）</span>${input("revision", "留空则先解析并展示版本")}</label><label class="field"><span>资源名称（可选）</span>${input("name", "未指定则先列出候选，不自动全选")}</label></div><label class="field"><span>期望安装位置（可选）</span>${input("destination", request.kind === "skill" ? `${state.catalog.repo}/skills` : "官方安装器确定原生位置后，请我确认")}<span class="helper">这是期望，不是已确认的落盘位置。若安装器不支持，agent 必须暂停，不得偷偷使用默认目录。</span></label>` : `<label class="field"><span>已发现资源</span>${select("name", [["", "请选择资源"], ...entries.map((entry) => [entry.name, `${entry.name} — ${resourceOwnership(entry, request.kind)}`])])}</label>${request.operation === "remove" ? `<label class="field"><span>移除范围</span>${select("effect", [["references", "只取消配置引用，保留安装与源码"], ["uninstall", "卸载受管副本并移除声明（先核验归属）"]])}<span class="helper">个人源码、本地引用和 Harness 自带资源不能按安装副本删除。包卸载可能影响同包的技能、提示词、主题及其他方案。</span></label>` : '<p class="helper">只核验声明、磁盘位置、版本、本地改动与使用者，不执行修复。</p>'}`}
			<p id="resource-plan-error" class="resource-warning" role="alert">${escapeHtml(state.resourceError)}</p><button class="button primary" type="submit">生成待核验的 AI 任务</button>
		</form></section><section class="composer-section" aria-labelledby="resource-plan-title"><h3 id="resource-plan-title">影响与执行边界</h3><div id="resource-plan-output">${plan ? `<p class="resource-warning" role="status">尚未执行：${escapeHtml(plan.label)}</p><dl class="resource-parameters"><dt>当前位置</dt><dd>${escapeHtml(plan.data.currentLocation)}</dd><dt>期望位置</dt><dd>${escapeHtml(plan.data.expectedDestination)}</dd><dt>已保存方案引用</dt><dd>${plan.profiles.map((profile) => `<button class="button text" data-route="profile/${escapeHtml(profile.id)}" data-section="${request.kind === "skill" ? "skills" : "runtime"}">${escapeHtml(profile.label)}</button>`).join("") || "未找到；执行前仍需核验包内资源与外部引用"}</dd></dl><ul class="change-list">${plan.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul><label class="field"><span>复制给具有所需工具权限的 AI agent，先让它核验</span><textarea id="resource-task" readonly spellcheck="false">${escapeHtml(plan.prompt)}</textarea></label><button class="button ghost" data-action="copy-resource-plan">复制核验任务（不授权执行）</button>` : '<p class="helper">提交左侧请求后，会显示已知位置、方案引用、移除范围和可复制任务。没有联网或读盘核验前，不显示“安全”“已安装”或“已删除”。</p>'}</div></section></div>
		<section class="composer-section management-guide"><h3>可以请 AI 安装，但不要只说“帮我装一下”</h3><p>把来源、固定版本和期望位置交给 agent，要求它先解释命令、落盘位置、代码执行风险和恢复方案，等你明确确认后再实施。安装不等于启用，启用扩展也不等于开放工具权限。</p><p class="helper">Skill 安装遵循固定版本的官方 skills CLI${state.catalog.managementContext?.skillsCli ? `（${escapeHtml(state.catalog.managementContext.skillsCli)}）` : ""}；Pi 包用官方安装器。AI 引导不是安全沙盒：需要权限、凭据或会话不具备的工具时，交给人处理，不使用 sudo 或扩大权限绕过。认证、会话、私人设置和本地源码始终保留。</p></section>`;
	renderInspector();
}

async function copyManagementText(text, fallback) {
	if (!text) return toast("没有可复制的内容，请先生成任务。", "error");
	try { await navigator.clipboard.writeText(text); toast("已复制；未执行任何操作，仍需人工批准具体计划。"); }
	catch {
		if (fallback) { fallback.focus(); fallback.select(); toast("剪贴板不可用，请从文本框手动复制。", "error"); }
		else window.prompt("剪贴板不可用，请手动复制（不会执行）", text);
	}
}

function renderHealth() {
	main.innerHTML = `
		<header class="page-header"><h2>系统检查</h2><p>检查配置生成结果、依赖、凭据泄漏和运行时兼容性。不修改配置，不调用模型。</p></header>
		<section class="health-panel">
			<div class="health-summary"><div class="health-cell"><strong>${state.catalog.profiles.length}</strong><span>配置方案</span></div><div class="health-cell"><strong>${state.catalog.instructions.length}</strong><span>指令</span></div><div class="health-cell"><strong>${state.catalog.skills.length}</strong><span>Skills</span></div></div>
			<div class="inline-actions"><button class="button primary" data-action="doctor" ${state.busy ? "disabled" : ""}>${state.busy ? "检查中…" : "运行 harness doctor"}</button></div>
			<pre class="health-output" tabindex="0">${escapeHtml(state.healthOutput)}</pre>
		</section>`;
	renderInspector();
}

function describeProfileChanges(original, draft) {
	const changes = [];
	if (original.label !== draft.label) changes.push(`名称：${original.label} → ${draft.label}`);
	if (original.description !== draft.description) changes.push(`说明：${original.description} → ${draft.description}`);
	if (!same(original.adapters.pi.model, draft.adapters.pi.model)) changes.push(`Pi 模型：${modelText(original)} → ${modelText(draft)}`);
	if (!same(original.adapters.codex.model, draft.adapters.codex.model)) changes.push(`Codex 模型：${modelText(original, "codex")} → ${modelText(draft, "codex")}`);
	const originalInstructions = new Map(original.instructions.map((entry) => [entry.id, entry.detail]));
	const draftInstructions = new Map(draft.instructions.map((entry) => [entry.id, entry.detail]));
	for (const id of new Set([...originalInstructions.keys(), ...draftInstructions.keys()])) {
		if (!originalInstructions.has(id)) changes.push(`启用指令：${id}@${draftInstructions.get(id)}`);
		else if (!draftInstructions.has(id)) changes.push(`停用指令：${id}`);
		else if (originalInstructions.get(id) !== draftInstructions.get(id)) changes.push(`指令版本：${id} ${originalInstructions.get(id)} → ${draftInstructions.get(id)}`);
	}
	if (!same(original.instructions.map((entry) => entry.id), draft.instructions.map((entry) => entry.id))) changes.push("指令顺序已调整");
	const originalSkills = selectedSkills(original);
	const draftSkills = selectedSkills(draft);
	const enabled = [...draftSkills].filter((name) => !originalSkills.has(name));
	const disabled = [...originalSkills].filter((name) => !draftSkills.has(name));
	if (enabled.length) changes.push(`启用 Skills：${enabled.join(", ")}`);
	if (disabled.length) changes.push(`关闭 Skills：${disabled.join(", ")}`);
	if (!enabled.length && !disabled.length && !same(original.skills, draft.skills)) changes.push(`Skills 引用：${original.skills.join(", ")} → ${draft.skills.join(", ")}`);
	if (!same(original.adapters.pi.tools, draft.adapters.pi.tools)) changes.push(`Pi tools：${original.adapters.pi.tools?.join(", ") ?? "继承"} → ${draft.adapters.pi.tools?.join(", ") ?? "继承"}`);
	if (!same(original.adapters.pi.extensions, draft.adapters.pi.extensions)) changes.push(`Pi extensions：${original.adapters.pi.extensions?.join(", ") ?? "继承"} → ${draft.adapters.pi.extensions?.join(", ") ?? "继承"}`);
	if (original.adapters.codex.sandbox !== draft.adapters.codex.sandbox) changes.push(`Codex sandbox：${original.adapters.codex.sandbox} → ${draft.adapters.codex.sandbox}`);
	if (original.adapters.codex.approval !== draft.adapters.codex.approval) changes.push(`Codex approval：${original.adapters.codex.approval} → ${draft.adapters.codex.approval}`);
	return changes;
}

function describeGlobalChanges(original, draft) {
	const changes = [];
	for (const layer of ["mandatory", "repository"]) {
		const before = new Map(original[layer].map((entry) => [entry.id, entry.detail]));
		const after = new Map(draft[layer].map((entry) => [entry.id, entry.detail]));
		for (const id of new Set([...before.keys(), ...after.keys()])) {
			if (!before.has(id)) changes.push(`启用 ${id}@${after.get(id)}`);
			else if (!after.has(id)) changes.push(`关闭 ${id}`);
			else if (before.get(id) !== after.get(id)) changes.push(`${id}：${before.get(id)} → ${after.get(id)}`);
		}
	}
	return changes;
}

function renderInspector() {
	const currentRoute = route();
	const hasInspector = ["profile", "global"].includes(currentRoute.page) || Boolean(state.detail);
	inspector.hidden = !hasInspector;
	document.querySelector(".workspace").classList.toggle("without-inspector", !hasInspector);
	const compactTray = document.querySelector("#compact-tray");
	const count = currentRoute.page === "profile"
		? describeProfileChanges(profileRecord(currentRoute.name).value, draftRecord(currentRoute.name).value).length
		: currentRoute.page === "global" ? describeGlobalChanges(state.catalog.globalInstructions.value, globalDraft().value).length : 0;
	compactTray.hidden = !count;
	if (count) {
		const draft = currentRoute.page === "profile" ? draftRecord(currentRoute.name) : globalDraft();
		compactTray.innerHTML = `<span>${count} 项未保存</span><button class="button ghost compact" data-action="scroll-changes">查看差异</button><button class="button primary compact" data-action="${currentRoute.page === "profile" ? "save-profile" : "save-global"}" ${state.busy || draft.stale ? "disabled" : ""}>${state.busy ? "保存中…" : "保存修改"}</button>`;
	}
	const selectedDetail = state.detail;
	if (selectedDetail) {
		state.detail = null;
		renderInspector();
		state.detail = selectedDetail;
		inspector.hidden = false;
		document.querySelector(".workspace").classList.remove("without-inspector");
	}
	const detailBase = selectedDetail ? inspector.innerHTML : "";
	const closeDetail = '<button class="button ghost compact" data-action="close-detail">关闭详情</button>';
	if (state.detail?.type === "skill") {
		const skill = state.catalog.skills.find((entry) => entry.name === state.detail.id);
		if (skill) {
			inspector.innerHTML = `${detailBase}<article class="inspector-card">${closeDetail}<p class="panel-label">Skill 说明</p><h3>${escapeHtml(skill.name)}</h3><span class="tag">${escapeHtml(skill.category)}</span><p>${escapeHtml(skill.description)}</p><p class="helper">${escapeHtml(resourceOwnership(skill, "skill"))}</p><p class="helper">位置：<code>${escapeHtml(skill.management?.path ?? "尚未核验")}</code></p><button class="button ghost" data-action="open-resource-management" data-kind="skill" data-name="${escapeHtml(skill.name)}">审阅安装与移除</button></article>`;
			return;
		}
	}
	if (state.detail?.type === "pi-resource") {
		const kind = state.detail.kind;
		const entry = piResources(kind).find((item) => item.name === state.detail.id);
		if (entry) {
			const source = kind === "tool" ? entry.source?.source : entry.source;
			const path = kind === "tool" ? entry.source?.path : entry.path;
			const parameters = entry.parameters?.properties ?? {};
			const required = entry.parameters?.required ?? [];
			inspector.innerHTML = `${detailBase}<article class="inspector-card">${closeDetail}<p class="panel-label">Pi ${kind === "tool" ? "工具" : "扩展"}说明</p><h3>${escapeHtml(entry.name)}</h3><span class="tag">${escapeHtml(piResourceOrigin(entry, kind))}${entry.version ? ` · ${escapeHtml(entry.version)}` : ""}</span><p>${escapeHtml(entry.description)}</p>
				${kind === "tool" ? `<p class="resource-warning">${escapeHtml(piToolRisk(entry))}。工具开关不是操作系统沙盒，也不会授予 sudo、凭据或远端授权。</p>${Object.keys(parameters).length ? `<h4>输入参数</h4><dl class="resource-parameters">${Object.entries(parameters).map(([name, schema]) => `<dt><code>${escapeHtml(name)}</code> ${required.includes(name) ? "必填" : "可选"}</dt><dd>${escapeHtml(schema.description ?? schema.title ?? "")}${schema.type ? `（${escapeHtml(schema.type)}）` : ""}</dd>`).join("")}</dl><details><summary>完整参数结构</summary><pre tabindex="0">${escapeHtml(JSON.stringify(entry.parameters, null, 2))}</pre></details>` : '<p class="helper">尚未取得参数结构，请查看该工具的原生说明。</p>'}` : `<h4>人工命令</h4><div class="token-cloud">${entry.commands.map((command) => `<code class="tag">/${escapeHtml(command)}</code>`).join("") || '<p class="helper">未发现命令；仅提供事件回调的扩展也可以正常工作。</p>'}</div><h4>模型工具</h4><div class="token-cloud">${entry.tools.map((tool) => `<code class="tag">${escapeHtml(tool)}</code>`).join("") || '<p class="helper">未发现注册工具。</p>'}</div><p class="helper">扩展提供的工具还需在方案工具名单中启用。启用扩展不会自动放开权限。</p>${entry.name.split("/").at(-1) === "pi-codex-fast" ? '<p class="resource-warning">加载扩展不等于开启速度模式。Fast 是本机/项目设置，可在 Pi 使用 /codex-fast 切换；支持的 OpenAI 模型请求才添加 service_tier: priority，DeepSeek 不适用。Profile 会继承本机设置，不能据此宣称服务端已接受优先级。</p>' : ""}`}
				${source ? `<p class="helper">来源：<code>${escapeHtml(source)}</code></p>` : ""}${path ? `<p class="helper">位置：<code>${escapeHtml(path)}</code></p><button class="button text" data-action="copy-resource-location" data-kind="${kind}" data-name="${escapeHtml(entry.name)}">复制位置</button>` : ""}${repositoryUrl(source) ? `<p><a href="${escapeHtml(repositoryUrl(source))}" target="_blank" rel="noopener noreferrer">查看 Git 仓库</a></p>` : ""}${kind === "extension" ? `<button class="button ghost" data-action="open-resource-management" data-kind="extension" data-name="${escapeHtml(entry.name)}">审阅安装与移除</button>` : ""}<p class="helper">目录发现不代表此 Profile 已加载；保存后仍需运行时检查。</p></article>`;
			return;
		}
	}
	if (state.detail?.type === "instruction") {
		const entry = state.catalog.instructions.find((item) => item.id === state.detail.id);
		if (entry) {
			inspector.innerHTML = `${detailBase}<article class="inspector-card">${closeDetail}<p class="panel-label">指令内容</p><h3>${escapeHtml(entry.title)}</h3><p>${escapeHtml(entry.description)}</p><div class="variant-tabs">${["brief", "standard", "detailed"].map((detail) => `<button class="segment" data-action="inspect-variant" data-detail="${detail}" aria-pressed="${state.variant === detail}">${{ brief: "精简", standard: "标准", detailed: "详细" }[detail]}</button>`).join("")}</div><div class="variant-content">${escapeHtml(entry.variants[state.variant])}</div><button class="button ghost" data-action="edit-instruction" data-id="${escapeHtml(entry.id)}">编辑所选版本</button></article>`;
			return;
		}
	}
	const current = route();
	if (current.page === "profile") {
		const source = profileRecord(current.name);
		const draft = draftRecord(current.name);
		const changes = source && draft ? describeProfileChanges(source.value, draft.value) : [];
		inspector.innerHTML = `<article class="inspector-card"><div class="change-heading"><div><p class="panel-label">待保存修改</p><h3>${changes.length ? `${changes.length} 项未保存` : "当前无修改"}</h3></div></div>${changes.length ? `<ul class="change-list">${changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul><div class="change-actions"><button class="button primary" data-action="save-profile" ${state.busy || draftRecord(current.name).stale ? "disabled" : ""}>${state.busy ? "保存中…" : "保存修改"}</button><button class="button ghost" data-action="reset-profile" ${state.busy ? "disabled" : ""}>放弃修改</button><button class="button ghost compact" data-action="undo-profile" ${!state.undo.has(current.name) || state.busy ? "disabled" : ""}>撤销上一步</button></div>` : '<p class="empty-copy">修改后点击保存。保存会更新方案配置并运行检查。</p>'}</article>`;
		return;
	}
	if (current.page === "global") {
		const changes = describeGlobalChanges(state.catalog.globalInstructions.value, globalDraft().value);
		inspector.innerHTML = `<article class="inspector-card"><p class="panel-label">待保存修改</p><h3>${changes.length ? `${changes.length} 项未保存` : "当前无修改"}</h3>${changes.length ? `<ul class="change-list">${changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul><div class="change-actions"><button class="button primary" data-action="save-global" ${state.busy || globalDraft().stale ? "disabled" : ""}>保存修改</button><button class="button ghost" data-action="reset-global">放弃修改</button></div>` : '<p class="empty-copy">全局指令的修改会影响所有方案。</p>'}</article>`;
		return;
	}
	inspector.innerHTML = "";
}

function syncHasDrafts() {
	return dirtyProfiles().length > 0 || isGlobalDirty() || Boolean(state.markdownDraft && instructionText.value !== state.markdownDraft.original);
}

function renderCatalogSync() {
	const value = state.sync, form = state.syncForm ?? {};
	main.innerHTML = `<header class="page-header"><h2>配置仓同步</h2><p>从当前 Catalog 已登记的 Git 来源接收配置。只同步配置仓，不更新 Harness 工具、不安装依赖、不推送本地内容。</p></header>
		<section class="section-stack" aria-label="配置同步登记">
			<p>当前配置仓：<code>${escapeHtml(state.catalog.repo)}</code></p>
			<p class="helper">登记存放在本机，不随 Git 同步。自动检查只在此 Web 页面打开且可见时运行，最多每 15 分钟检查一次；发现更新弹窗审阅，不静默应用。未启用时不自动联网。</p>
			<form id="catalog-sync-form" class="section-stack">
				<label class="field"><span>Git remote</span><select name="remote" required>${(value?.remotes ?? []).map(item => `<option value="${escapeHtml(item.name)}" ${item.name === form.remote ? "selected" : ""} ${item.supported ? "" : "disabled"}>${escapeHtml(item.name)}${item.supported ? "" : "（来源需人工核验）"}</option>`).join("")}</select><span class="helper">仅选择当前配置仓已有的无凭据 HTTPS 或本机绝对 Git 来源。新增 remote、SSH 认证请在终端处理，不在这里贴凭据。</span></label>
				<label class="field"><span>同步分支</span><input name="branch" value="${escapeHtml(form.branch ?? "main")}" required autocomplete="off"><span class="helper">来源分支不必与本地分支同名；只允许当前 HEAD 到候选提交的快进。</span></label>
				<label class="check-row"><input name="automaticCheck" type="checkbox" ${form.automaticCheck ? "checked" : ""}><span>自动检查并提示更新（不会自动应用）</span></label>
				<button class="button primary" type="submit" ${!value?.remotes?.some(item => item.supported) || state.busy ? "disabled" : ""}>保存同步登记</button>
			</form>
		</section>
		<section class="section-stack catalog-sync-status" aria-label="配置同步状态">
			<h3>来源与更新</h3>
			${value ? `<dl class="resource-metadata"><dt>登记来源</dt><dd>${escapeHtml(value.registration ? `${value.registration.remote}/${value.registration.branch}` : "未登记")}${value.registration ? `<br><code>${escapeHtml(value.registration.source)}</code>` : ""}</dd><dt>本地分支</dt><dd>${escapeHtml(value.branch || "detached HEAD")}</dd><dt>当前提交</dt><dd><code>${escapeHtml(value.head)}</code></dd><dt>最近检查</dt><dd>${escapeHtml(value.checkedAt ? new Date(value.checkedAt).toLocaleString() : "尚未检查")}</dd><dt>候选提交</dt><dd><code>${escapeHtml(value.commit ?? "尚未获取")}</code></dd></dl>
			<p role="status">${escapeHtml(value.blocked || (value.hasUpdate ? "发现可快进更新，请审阅后确认同步。" : value.checkedAt ? "最近获取的候选与本地一致；不代表远端此刻没有更新。" : "尚未检查远端。"))}</p>
			<button class="button" data-action="sync-check" ${!value.registration || state.busy || state.syncChecking ? "disabled" : ""}>检查远端更新</button>
			<button class="button primary" data-action="sync-review" ${!value.canSync || syncHasDrafts() || state.busy ? "disabled" : ""}>审阅同步</button>
			${syncHasDrafts() ? '<p class="helper">浏览器有未保存草稿，请先自行保存或放弃；不会用同步覆盖草稿。</p>' : ""}
			${value.files?.length ? `<details><summary>查看 ${value.files.length} 个变更文件</summary><ul>${value.files.map(file => `<li><code>${escapeHtml(file)}</code></li>`).join("")}</ul></details>` : ""}
			${value.lastSyncedAt ? '<p role="status">配置仓源码已同步；尚未生成、投影或加载。已有投影可能直接读取新的 Catalog 内容，运行中的会话不会自动重载，请审阅后再使用。</p>' : ""}
			${value.backup ? `<p class="helper">最近同步前快照：<code>${escapeHtml(value.backup)}</code>。同步不自动 compose/bootstrap 或加载资源；请在终端审阅后运行 harness compose --apply、harness bootstrap --apply、harness doctor。bootstrap 会合并工程设置，请另外确认；缺依赖时先人工核验，不自动安装。</p>` : ""}` : '<p role="status">正在读取本机登记…</p>'}
			<p class="error-summary" role="alert" ${state.syncError ? "" : "hidden"}>${escapeHtml(state.syncError)}</p>
		</section>`;
	renderInspector();
}

function updateSyncIndicator() {
	const indicator = document.querySelector("#catalog-update-indicator");
	indicator.hidden = !state.sync?.hasUpdate;
	if (state.catalog) renderNav();
}

async function loadCatalogSync() {
	try {
		state.sync = await api("/api/catalog-sync");
		state.syncForm ??= { remote: state.sync.registration?.remote ?? state.sync.remotes.find(item => item.supported)?.name ?? "", branch: state.sync.registration?.branch ?? "main", automaticCheck: state.sync.registration?.automaticCheck ?? false };
		state.syncError = "";
	} catch (error) { state.syncError = error.message; }
	updateSyncIndicator();
	if (route().page === "sync") render();
}

function reviewCatalogSync() {
	if (!state.sync?.canSync || state.busy || syncHasDrafts()) return;
	state.pendingSync = clone(state.sync);
	document.querySelector("#catalog-sync-review").innerHTML = `<p>来源：<code>${escapeHtml(state.sync.registration.source)}</code>，分支 <strong>${escapeHtml(state.sync.registration.branch)}</strong></p><p><code>${escapeHtml(state.sync.head)}</code><br>同步到 <code>${escapeHtml(state.sync.commit)}</code></p><details open><summary>${state.sync.files.length} 个变更文件</summary><ul>${state.sync.files.map(file => `<li><code>${escapeHtml(file)}</code></li>`).join("")}</ul></details>`;
	syncDialog.showModal();
}

async function checkCatalogSync(manual = false) {
	if (!state.sync?.registration || state.busy || state.syncChecking || document.visibilityState !== "visible") return;
	if (!manual && !state.sync.registration.automaticCheck) return;
	state.syncChecking = true;
	try {
		state.sync = await api("/api/catalog-sync", { method: "POST", body: JSON.stringify({ operation: "check", force: manual }) });
		state.syncError = "";
		const dismissed = sessionStorage.getItem(`harness-sync-dismissed:${state.catalog.repo}`);
		if (state.sync.canSync && !syncHasDrafts() && !document.querySelector("dialog[open]") && dismissed !== state.sync.commit) reviewCatalogSync();
		if (manual) toast(state.sync.blocked || (state.sync.hasUpdate ? "发现配置仓更新。" : "本地与刚获取的远端候选一致。"));
	} catch (error) {
		state.syncError = error.message;
		if (manual) toast(error.message, "error");
	} finally {
		state.syncChecking = false;
		updateSyncIndicator();
		if (route().page === "sync" && !document.activeElement?.closest("#catalog-sync-form")) render();
	}
}

async function saveCatalogSync(event) {
	event.preventDefault();
	if (state.busy || !state.sync) return;
	const data = new FormData(event.target);
	state.syncForm = { remote: data.get("remote"), branch: data.get("branch"), automaticCheck: data.has("automaticCheck") };
	state.busy = true;
	render();
	try {
		state.sync = await api("/api/catalog-sync", { method: "POST", body: JSON.stringify({ operation: "register", ...state.syncForm, expectedHash: state.sync.registrationHash }) });
		state.syncError = "";
		toast("同步登记已保存；尚未同步配置。" );
	} catch (error) { state.syncError = error.message; toast(error.message, "error"); }
	finally { state.busy = false; updateSyncIndicator(); render(); }
	if (state.syncForm.automaticCheck) await checkCatalogSync();
}

async function applyCatalogSync() {
	if (state.busy || syncHasDrafts() || !state.pendingSync) return;
	const review = state.pendingSync;
	syncDialog.close();
	state.pendingSync = null;
	state.busy = true;
	render();
	try {
		state.sync = await api("/api/catalog-sync", { method: "POST", body: JSON.stringify({ operation: "apply", expectedHash: review.registrationHash, expectedHead: review.head, expectedCommit: review.commit }) });
		state.syncError = "";
		await reloadCatalog();
		toast("配置仓已同步。尚未生成、投影或加载；请审阅后在终端应用。" );
	} catch (error) {
		state.syncError = `${error.message}${error.payload?.backup ? ` 快照：${error.payload.backup}` : ""}`;
		toast(state.syncError, "error");
	} finally { state.busy = false; updateSyncIndicator(); render(); }
}

function render() {
	const focused = document.activeElement;
	const identity = focused?.dataset?.action || focused?.dataset?.route
		? Object.entries(focused.dataset).map(([key, value]) => `[data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${CSS.escape(value)}"]`).join("") : null;
	main.inert = state.busy;
	app.setAttribute("aria-busy", String(state.busy));
	renderNav();
	const current = route();
	if (current.page === "profile") renderProfile(current.name);
	else if (current.page === "global") renderGlobal();
	else if (current.page === "skills") renderSkillsCatalog();
	else if (current.page === "pi") renderPiCatalog();
	else if (current.page === "manage") renderResourceManagement();
	else if (current.page === "sync") renderCatalogSync();
	else if (current.page === "health") renderHealth();
	else renderCompare();
	if (identity && !state.busy) {
		let nextFocus = document.querySelector(identity);
		if (nextFocus?.disabled) nextFocus = nextFocus.closest(".row-controls")?.querySelector("button:not(:disabled), input:not(:disabled)");
		(nextFocus ?? main).focus({ preventScroll: true });
	}
}

function mutateProfile(name, mutation) {
	const draft = draftRecord(name);
	state.undo.set(name, clone(draft.value));
	mutation(draft.value);
	draft.restored = false;
	persistProfile(name);
	render();
}

function mutateGlobal(mutation) {
	const draft = globalDraft();
	mutation(draft.value);
	draft.restored = false;
	persistGlobal();
	render();
}

function openConfirmation(title, changes, onConfirm) {
	document.querySelector("#confirm-title").textContent = title;
	confirmBody.innerHTML = `<p>确认以下修改。保存后生成配置，仅检查受影响项；不会重跑完整 doctor。检查失败时恢复原配置。若检测到并发修改，将保留快照并提示处理冲突。</p><ul class="change-list">${changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>`;
	state.pendingSave = onConfirm;
	confirmDialog.showModal();
}

async function reloadCatalog() {
	const payload = await api("/api/catalog");
	state.catalog = payload;
	state.drafts.clear();
	state.globalDraft = null;
	state.undo.clear();
	for (const profile of state.catalog.profiles) draftRecord(profile.name);
	globalDraft();
	connectionState.className = "status-pill online";
	connectionState.innerHTML = '<span class="status-dot" aria-hidden="true"></span>本地连接';
	app.setAttribute("aria-busy", "false");
	render();
}

function configureNewProfile(sourceName = "") {
	const source = profileRecord(sourceName);
	document.querySelector("#profile-create-label").value = source ? `${source.value.label} 副本` : "新方案";
	document.querySelector("#profile-create-description").value = source?.value.description ?? "自定义配置方案";
	let id = source ? `${source.name}-copy` : "";
	let suffix = 2;
	while (id && state.catalog.profiles.some((profile) => profile.name.toLowerCase() === id.toLowerCase())) id = `${source.name}-copy-${suffix++}`;
	document.querySelector("#profile-create-id").value = id;
	document.querySelector("#profile-create-error").textContent = "";
}

function openCreateProfile(sourceName = "") {
	document.querySelector("#profile-create-form").reset();
	document.querySelector("#profile-create-title").textContent = sourceName ? "复制方案" : "新建方案";
	const base = document.querySelector("#profile-create-base");
	base.innerHTML = `<option value="">空白方案</option>${state.catalog.profiles.map((profile) => `<option value="${escapeHtml(profile.name)}">${escapeHtml(profile.value.label)} (${escapeHtml(profile.name)})</option>`).join("")}`;
	base.value = sourceName;
	configureNewProfile(sourceName);
	createProfileDialog.showModal();
	document.querySelector("#profile-create-id").focus();
}

async function createProfile(event) {
	event.preventDefault();
	if (state.busy) return;
	const name = document.querySelector("#profile-create-id").value.trim();
	const label = document.querySelector("#profile-create-label").value.trim();
	const description = document.querySelector("#profile-create-description").value.trim();
	const errorRegion = document.querySelector("#profile-create-error");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || ["default", "profile.schema"].includes(name.toLowerCase())) {
		errorRegion.textContent = "方案 ID 格式不正确，或使用了 default / profile.schema 保留名称。";
		return;
	}
	if (!label || !description) { errorRegion.textContent = "方案名称和说明不能为空。"; return; }
	if (state.catalog.profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
		errorRegion.textContent = "该方案 ID 已存在，请使用其他 ID。";
		return;
	}
	const source = profileRecord(document.querySelector("#profile-create-base").value);
	const value = source ? clone(source.value) : {
		$schema: "./profile.schema.json", instructions: [], skills: [],
		adapters: {
			pi: { tools: ["read", "grep", "find", "ls"], extensions: ["harness-manager"], mcps: [] },
			codex: { sandbox: "read-only", approval: "on-request" },
		},
	};
	Object.assign(value, { label, description });
	state.busy = true;
	createProfileDialog.inert = true;
	errorRegion.textContent = "正在创建并检查配置…";
	render();
	try {
		const result = await api("/api/create-profile", { method: "POST", body: JSON.stringify({ name, value }) });
		state.healthOutput = saveValidationLog(result);
		createProfileDialog.close();
		await reloadCatalog();
		location.hash = `profile/${name}`;
		toast(`已创建“${label}”。${saveValidationSummary(result)}`);
	} catch (error) {
		errorRegion.textContent = `${error.message}${error.payload?.backup ? ` 备份：${error.payload.backup}` : ""}`;
	} finally {
		createProfileDialog.inert = false;
		state.busy = false;
		render();
		if (!createProfileDialog.open) main.focus({ preventScroll: true });
	}
}

function openDeleteProfile(name) {
	const profile = profileRecord(name);
	if (!profile || state.catalog.profiles.length <= 1) return;
	state.deletingProfile = { name, sourceHash: profile.sourceHash };
	document.querySelector("#profile-delete-summary").textContent = `删除“${profile.value.label}” (${name})？`;
	document.querySelector("#profile-delete-dirty").textContent = !same(draftRecord(name).value, profile.value)
		? "此方案有未保存修改。删除成功后将一并丢弃该方案的浏览器草稿。" : "";
	document.querySelector("#profile-delete-confirm").value = "";
	document.querySelector("#profile-delete-error").textContent = "";
	document.querySelector("#profile-delete-submit").disabled = true;
	deleteProfileDialog.showModal();
	document.querySelector("#profile-delete-confirm").focus();
}

async function deleteProfile(event) {
	event.preventDefault();
	if (state.busy || !state.deletingProfile || document.querySelector("#profile-delete-confirm").value !== state.deletingProfile.name) return;
	const { name, sourceHash } = state.deletingProfile;
	const storageKey = draftRecord(name).storageKey;
	const errorRegion = document.querySelector("#profile-delete-error");
	state.busy = true;
	deleteProfileDialog.inert = true;
	errorRegion.textContent = "正在删除并检查配置…";
	render();
	try {
		const result = await api("/api/delete-profile", { method: "POST", body: JSON.stringify({ name, expectedHash: sourceHash }) });
		state.healthOutput = saveValidationLog(result);
		state.lastDeletion = { name, backup: result.backup };
		localStorage.removeItem(storageKey);
		state.deletingProfile = null;
		state.detail = null;
		deleteProfileDialog.close();
		await reloadCatalog();
		location.hash = "compare";
		toast(`已删除方案 ${name}。${saveValidationSummary(result)}`);
	} catch (error) {
		errorRegion.textContent = `${error.message}${error.payload?.backup ? ` 备份：${error.payload.backup}` : ""}`;
		if (error.status === 409 || error.status === 404) {
			await reloadCatalog();
			document.querySelector("#profile-delete-submit").disabled = true;
			state.deletingProfile = null;
			errorRegion.textContent += " 请取消并重新选择要删除的方案。";
		}
	} finally {
		deleteProfileDialog.inert = false;
		state.busy = false;
		render();
		if (!deleteProfileDialog.open) main.focus({ preventScroll: true });
	}
}

async function saveProfile(name) {
	const source = profileRecord(name);
	const draft = draftRecord(name);
	state.busy = true;
	render();
	try {
		const result = await api("/api/save-profile", { method: "POST", body: JSON.stringify({ name, expectedHash: source.sourceHash, value: draft.value }) });
		localStorage.removeItem(draft.storageKey);
		toast(`已保存 ${name}。${saveValidationSummary(result)}`);
		state.healthOutput = saveValidationLog(result);
		await reloadCatalog();
	} catch (error) {
		state.healthOutput = error.payload?.logs?.map((entry) => `== ${entry.name} (${entry.code})\n${entry.output}`).join("\n\n") ?? error.message;
		toast(error.message, "error");
		if (error.status === 409) await reloadCatalog();
	} finally {
		state.busy = false;
		render();
	}
}

async function saveGlobal() {
	const draft = globalDraft();
	state.busy = true;
	render();
	try {
		const result = await api("/api/save-instructions", { method: "POST", body: JSON.stringify({ expectedHash: state.catalog.globalInstructions.sourceHash, value: draft.value }) });
		localStorage.removeItem(draft.storageKey);
		toast(`全局指令已保存。${saveValidationSummary(result)}`);
		state.healthOutput = saveValidationLog(result);
		await reloadCatalog();
	} catch (error) {
		state.healthOutput = error.payload?.logs?.map((entry) => `== ${entry.name} (${entry.code})\n${entry.output}`).join("\n\n") ?? error.message;
		toast(error.message, "error");
		if (error.status === 409) await reloadCatalog();
	} finally {
		state.busy = false;
		render();
	}
}

async function saveInstructionText() {
	const draft = state.markdownDraft;
	state.busy = true;
	instructionEditor.inert = true;
	render();
	try {
		const result = await api("/api/save-instruction-text", { method: "POST", body: JSON.stringify({ id: draft.id, detail: draft.detail, expectedHash: draft.sourceHash, text: instructionText.value }) });
		state.healthOutput = saveValidationLog(result);
		state.markdownDraft = null;
		instructionEditor.close();
		await reloadCatalog();
		toast(`指令内容已保存。${saveValidationSummary(result)}`);
	} catch (error) {
		document.querySelector("#instruction-error").textContent = error.message;
		document.querySelector("#load-latest-instruction").hidden = error.status !== 409;
		toast(error.message, "error");
	} finally {
		instructionEditor.inert = false;
		state.busy = false;
		render();
	}
}

async function runDoctor() {
	state.busy = true;
	state.healthOutput = "正在运行 harness doctor…";
	render();
	try {
		const result = await api("/api/doctor", { method: "POST", body: "{}" });
		state.healthOutput = result.output || "检查完成，没有输出。";
		toast(result.ok ? "完整检查通过。" : "完整检查未通过。", result.ok ? "info" : "error");
	} catch (error) {
		state.healthOutput = error.payload?.output ?? error.message;
		toast(error.message, "error");
	} finally {
		state.busy = false;
		render();
	}
}

document.addEventListener("click", async (event) => {
	const target = event.target.closest("[data-action], [data-route]");
	if (!target || !state.catalog) return;
	if (target.dataset.route) {
		state.pendingSection = target.dataset.section ?? null;
		location.hash = target.dataset.route;
		return;
	}
	const current = route();
	const action = target.dataset.action;
	if (state.busy) return;
	if (action === "sync-check") return checkCatalogSync(true);
	if (action === "sync-review") return reviewCatalogSync();
	if (action === "sync-apply") return applyCatalogSync();
	if (action === "sync-later") {
		if (state.pendingSync) sessionStorage.setItem(`harness-sync-dismissed:${state.catalog.repo}`, state.pendingSync.commit);
		state.pendingSync = null;
		syncDialog.close();
		return;
	}
	if (action === "open-resource-management") {
		state.resourceRequest = { kind: target.dataset.kind, operation: target.dataset.name ? "inspect" : "install", sourceMode: "git", source: "", revision: "", destination: target.dataset.kind === "skill" ? (state.catalog.managementContext?.skillRoot ?? `${state.catalog.repo}/skills`) : "", name: target.dataset.name ?? "", effect: "references" };
		state.resourcePlan = null;
		state.resourceError = "";
		state.detail = null;
		location.hash = "manage";
		if (current.page === "manage") render();
		return;
	}
	if (action === "copy-resource-plan") return copyManagementText(state.resourcePlan?.prompt, document.querySelector("#resource-task"));
	if (action === "copy-resource-location") {
		const entry = piResources(target.dataset.kind).find((item) => item.name === target.dataset.name);
		return copyManagementText(target.dataset.kind === "tool" ? entry?.source?.path : entry?.path);
	}
	if (action === "dismiss-deletion") { state.lastDeletion = null; render(); main.focus({ preventScroll: true }); return; }
	if (action === "create-profile") return openCreateProfile();
	if (action === "duplicate-profile") return openCreateProfile(target.dataset.profile);
	if (action === "delete-profile") return openDeleteProfile(target.dataset.profile);
	if (action === "cancel-create-profile") { createProfileDialog.close(); return; }
	if (action === "cancel-delete-profile") { deleteProfileDialog.close(); return; }
	if (action === "go-section") {
		focusSection(target.dataset.section);
		return;
	}
	if (action === "reset-profile") {
		const name = target.dataset.profile ?? current.name;
		if (!profileRecord(name) || !confirm("放弃此方案的未保存修改？此操作将恢复已保存的配置。")) return;
		state.undo.delete(name);
		const draft = draftRecord(name);
		draft.value = clone(profileRecord(name).value);
		draft.baseHash = profileRecord(name).sourceHash;
		draft.stale = false;
		draft.restored = false;
		localStorage.removeItem(draft.storageKey);
		state.detail = null;
		render();
		return;
	}
	if (action === "save-profile") {
		const name = target.dataset.profile ?? current.name;
		const draft = draftRecord(name);
		if (!draft || draft.stale) return;
		if (!draft.value.label.trim() || !draft.value.description.trim()) {
			toast("方案名称和说明不能为空。", "error");
			return;
		}
		const changes = describeProfileChanges(profileRecord(name).value, draft.value);
		openConfirmation(`保存“${draft.value.label}”的修改？`, changes, () => saveProfile(name));
		return;
	}
	if (action === "review-conflict") {
		const draft = current.page === "profile" ? draftRecord(current.name) : globalDraft();
		draft.baseHash = current.page === "profile" ? profileRecord(current.name).sourceHash : state.catalog.globalInstructions.sourceHash;
		draft.stale = false;
		if (current.page === "profile") persistProfile(current.name);
		else persistGlobal();
		render();
		return;
	}
	if (action === "doctor") {
		location.hash = "health";
		return runDoctor();
	}
	if (action === "shutdown") {
		if (!confirm("关闭本地 Harness Web 服务？尚未保存的浏览器草稿会保留。")) return;
		await api("/api/shutdown", { method: "POST", body: "{}" });
		main.innerHTML = '<div class="loading-state"><p>Harness Web 已关闭。可以关闭此标签页。</p></div>';
		return;
	}
	if (action === "load-latest-instruction") {
		try {
			const latest = await api("/api/catalog");
			const draft = state.markdownDraft;
			const entry = latest.instructions.find((item) => item.id === draft.id);
			draft.original = entry.variants[draft.detail];
			draft.sourceHash = entry.variantHashes[draft.detail];
			document.querySelector("#instruction-original").textContent = draft.original;
			document.querySelector("#instruction-error").textContent = "已加载最新原文；编辑框保留草稿。请对照原文，再审阅保存。";
			document.querySelector("#load-latest-instruction").hidden = true;
		} catch (error) { toast(error.message, "error"); }
		return;
	}
	if (action === "edit-instruction") {
		const entry = state.catalog.instructions.find((item) => item.id === target.dataset.id);
		state.markdownDraft = { id: entry.id, detail: state.variant, sourceHash: entry.variantHashes[state.variant], original: entry.variants[state.variant] };
		instructionText.value = state.markdownDraft.original;
		document.querySelector("#instruction-original").textContent = state.markdownDraft.original;
		document.querySelector("#editor-title").textContent = `${entry.title} · ${{ brief: "精简", standard: "标准", detailed: "详细" }[state.variant]}`;
		document.querySelector("#instruction-error").textContent = "";
		document.querySelector("#load-latest-instruction").hidden = true;
		instructionEditor.showModal();
		instructionText.focus();
		return;
	}
	if (action === "close-editor") {
		if (instructionText.value !== state.markdownDraft.original && !confirm("放弃未保存的指令内容修改？")) return;
		instructionEditor.close();
		return;
	}
	if (action === "save-instruction-text") {
		if (!instructionText.value.trim()) return toast("指令内容不能为空。", "error");
		openConfirmation("保存共享指令内容？", [`${state.markdownDraft.id}@${state.markdownDraft.detail}：将更新所有引用此版本的方案`], saveInstructionText);
		return;
	}
	if (action === "scroll-changes") {
		inspector.scrollIntoView({ block: "start", behavior: "auto" });
		inspector.setAttribute("tabindex", "-1");
		inspector.focus({ preventScroll: true });
		return;
	}
	if (action === "close-detail") {
		const detail = state.detail;
		state.detail = null;
		renderInspector();
		if (detail?.type === "pi-resource") {
			const trigger = document.querySelector(`[data-action="inspect-pi-resource"][data-kind="${CSS.escape(detail.kind)}"][data-name="${CSS.escape(detail.id)}"]`);
			(trigger ?? main).focus({ preventScroll: true });
		}
		return;
	}
	if (action === "pi-resource-kind") {
		state.piResourceKind = target.dataset.kind;
		render();
		return;
	}
	if (action === "inspect-pi-resource") {
		state.detail = { type: "pi-resource", kind: target.dataset.kind, id: target.dataset.name };
		renderInspector();
		inspector.setAttribute("tabindex", "-1");
		inspector.focus({ preventScroll: true });
		inspector.scrollIntoView({ block: "nearest", behavior: "auto" });
		return;
	}
	if (action === "inspect-skill") {
		state.detail = { type: "skill", id: target.dataset.name };
		renderInspector();
		return;
	}
	if (action === "inspect-instruction") {
		state.detail = { type: "instruction", id: target.dataset.id };
		state.variant = instructionSelection(current.page === "profile" ? draftRecord(current.name).value : { instructions: globalSelections(globalDraft().value) }, target.dataset.id)?.detail ?? "standard";
		renderInspector();
		return;
	}
	if (action === "inspect-variant") {
		state.variant = target.dataset.detail;
		renderInspector();
		return;
	}
	if (current.page === "profile") {
		const name = current.name;
		if (action === "copy-skills" || action === "copy-instructions") {
			const source = document.querySelector('[data-action="copy-source"]').value;
			if (!source) return toast("请选择来源方案。", "error");
			mutateProfile(name, (profile) => {
				if (action === "copy-skills") profile.skills = clone(draftRecord(source).value.skills);
				else profile.instructions = clone(draftRecord(source).value.instructions);
			});
			toast("已复制配置，尚未保存。");
			return;
		}
		if (action === "undo-profile") {
			const previous = state.undo.get(name);
			if (previous) {
				draftRecord(name).value = previous;
				state.undo.delete(name);
				persistProfile(name);
				state.detail = null;
				render();
			}
			return;
		}
		if (action === "inspect-effective") {
			state.detail = null;
			renderInspector();
			const selections = [...globalSelections(globalDraft().value), ...draftRecord(name).value.instructions];
			const text = selections.map((item) => state.catalog.instructions.find((entry) => entry.id === item.id)?.variants[item.detail] ?? "").join("\n\n");
			inspector.insertAdjacentHTML("beforeend", `<article class="inspector-card"><h3>合并指令预览</h3><p class="helper">包含全局与方案指令的未保存选择。</p><pre tabindex="0">${escapeHtml(text)}</pre></article>`);
			return;
		}
		if (action === "set-instruction-detail") return mutateProfile(name, (profile) => { instructionSelection(profile, target.dataset.id).detail = target.dataset.detail; });
		if (action === "move-instruction") return mutateProfile(name, (profile) => {
			const index = profile.instructions.findIndex((entry) => entry.id === target.dataset.id);
			const next = target.dataset.direction === "up" ? index - 1 : index + 1;
			if (index >= 0 && next >= 0 && next < profile.instructions.length) [profile.instructions[index], profile.instructions[next]] = [profile.instructions[next], profile.instructions[index]];
		});
		if (action === "skill-category") {
			state.skillCategory = target.dataset.category;
			render();
			return;
		}
		if (action === "bulk-skills") return mutateProfile(name, (profile) => {
			const selected = selectedSkills(profile);
			for (const skill of filteredSkills()) target.dataset.mode === "enable" ? selected.add(skill.name) : selected.delete(skill.name);
			profile.skills = [...selected].sort();
		});
		if (action === "sync-codex-model") return mutateProfile(name, (profile) => {
			const piModel = profile.adapters.pi.model;
			profile.adapters.codex.model = { id: piModel.id, ...(piModel.thinking && piModel.thinking !== "off" ? { thinking: piModel.thinking } : { thinking: "minimal" }) };
		});
	}
	if (current.page === "global") {
		if (action === "global-detail") return mutateGlobal((value) => {
			const selection = globalSelections(value).find((entry) => entry.id === target.dataset.id);
			selection.detail = target.dataset.detail;
		});
		if (action === "reset-global") {
			if (!confirm("放弃全局指令的未保存修改？")) return;
			const draft = globalDraft();
			draft.value = clone(state.catalog.globalInstructions.value);
			draft.baseHash = state.catalog.globalInstructions.sourceHash;
			draft.stale = false;
			draft.restored = false;
			localStorage.removeItem(draft.storageKey);
			state.detail = null;
			render();
			return;
		}
		if (action === "save-global") {
			const changes = describeGlobalChanges(state.catalog.globalInstructions.value, globalDraft().value);
			openConfirmation("保存全局指令？", changes, saveGlobal);
		}
	}
});

document.addEventListener("submit", (event) => {
	if (event.target.id === "catalog-sync-form") return saveCatalogSync(event);
	if (event.target.id !== "resource-management-form") return;
	event.preventDefault();
	if (state.busy) return;
	try { state.resourcePlan = createResourcePlan(state.catalog, state.resourceRequest); state.resourceError = ""; }
	catch (error) { state.resourcePlan = null; state.resourceError = error.message; }
	render();
	const output = document.querySelector(state.resourcePlan ? "#resource-task" : "#resource-plan-error");
	output.setAttribute("tabindex", "-1");
	output.focus({ preventScroll: true });
});

document.addEventListener("change", (event) => {
	const target = event.target.closest("[data-action]");
	if (!target || !state.catalog) return;
	const current = route();
	const action = target.dataset.action;
	if (action === "resource-plan-field") {
		if (target.tagName === "SELECT") { updateResourceRequest(target); render(); }
		return;
	}
	if (current.page === "profile") {
		const name = current.name;
		if (action === "toggle-instruction") return mutateProfile(name, (profile) => {
			const index = profile.instructions.findIndex((entry) => entry.id === target.dataset.id);
			if (target.checked && index < 0) profile.instructions.push({ id: target.dataset.id, detail: "standard" });
			else if (!target.checked && index >= 0) profile.instructions.splice(index, 1);
		});
		if (action === "toggle-skill") return mutateProfile(name, (profile) => {
			const selected = selectedSkills(profile);
			target.checked ? selected.add(target.dataset.name) : selected.delete(target.dataset.name);
			profile.skills = [...selected].sort();
		});
		if (action === "pi-provider") return mutateProfile(name, (profile) => {
			const first = state.catalog.models.find((model) => model.provider === target.value);
			profile.adapters.pi.model = { provider: target.value, id: first?.id ?? "", thinking: first?.thinkingLevels?.includes(first.scopeThinking) ? first.scopeThinking : "off" };
		});
		if (action === "pi-model") return mutateProfile(name, (profile) => {
			profile.adapters.pi.model ??= { provider: document.querySelector('[data-action="pi-provider"]').value };
			profile.adapters.pi.model.id = target.value;
			const selected = state.catalog.models.find((model) => model.provider === profile.adapters.pi.model.provider && model.id === target.value);
			if (!selected?.thinkingLevels?.includes(profile.adapters.pi.model.thinking)) profile.adapters.pi.model.thinking = selected?.thinkingLevels?.includes(selected.scopeThinking) ? selected.scopeThinking : selected?.thinkingLevels?.[0] ?? "off";
		});
		if (action === "pi-thinking" && draftRecord(name).value.adapters.pi.model) return mutateProfile(name, (profile) => { profile.adapters.pi.model.thinking = target.value; });
		if (action === "codex-model") return mutateProfile(name, (profile) => { profile.adapters.codex.model = { ...profile.adapters.codex.model, id: target.value }; });
		if (action === "codex-thinking") return mutateProfile(name, (profile) => { profile.adapters.codex.model = { ...profile.adapters.codex.model, thinking: target.value }; });
		if (action === "toggle-tool") return mutateProfile(name, (profile) => {
			const values = new Set(profile.adapters.pi.tools ?? []);
			target.checked ? values.add(target.dataset.name) : values.delete(target.dataset.name);
			profile.adapters.pi.tools = [...values].sort();
		});
		if (action === "toggle-extension") return mutateProfile(name, (profile) => {
			const values = new Set(profile.adapters.pi.extensions);
			target.checked ? values.add(target.dataset.name) : values.delete(target.dataset.name);
			values.add("harness-manager");
			profile.adapters.pi.extensions = [...values].sort();
		});
		if (action === "codex-sandbox") return mutateProfile(name, (profile) => { profile.adapters.codex.sandbox = target.value; });
		if (action === "codex-approval") return mutateProfile(name, (profile) => { profile.adapters.codex.approval = target.value; });
	}
	if (current.page === "global" && action === "global-toggle") return mutateGlobal((value) => {
		const index = value.repository.findIndex((entry) => entry.id === target.dataset.id);
		if (target.checked && index < 0) value.repository.push({ id: target.dataset.id, detail: "standard" });
		else if (!target.checked && index >= 0) value.repository.splice(index, 1);
	});
});

document.addEventListener("input", (event) => {
	const target = event.target.closest("[data-action], #catalog-sync-form input, #catalog-sync-form select");
	if (!target || !state.catalog) return;
	if (target.closest("#catalog-sync-form")) {
		const data = new FormData(target.closest("form"));
		state.syncForm = { remote: data.get("remote"), branch: data.get("branch"), automaticCheck: data.has("automaticCheck") };
		return;
	}
	const current = route();
	if (target.dataset.action === "resource-plan-field") {
		if (target.tagName === "SELECT") return;
		updateResourceRequest(target);
		const output = document.querySelector("#resource-plan-output");
		if (output) output.innerHTML = '<p class="helper" role="status">输入已改变，请重新生成任务；旧任务不可复制。</p>';
		const error = document.querySelector("#resource-plan-error");
		if (error) error.textContent = "";
		return;
	}
	if (["profile", "pi"].includes(current.page) && target.dataset.action === "pi-resource-search") {
		state.piResourceQuery = target.value;
		document.querySelector("[data-pi-resources]").innerHTML = piResourceLists(current.page === "profile" ? draftRecord(current.name).value : undefined);
	}
	if (current.page === "profile" && target.dataset.action === "model-search") {
		state.modelQuery = target.value;
		const model = draftRecord(current.name).value.adapters.pi.model ?? { provider: "", id: "" };
		document.querySelector('[data-action="pi-model"]').innerHTML = modelOptions(model.provider, model.id);
	}
	if (current.page === "profile" && target.dataset.action === "codex-model-manual" && target.value.trim()) {
		draftRecord(current.name).value.adapters.codex.model ??= {};
		draftRecord(current.name).value.adapters.codex.model.id = target.value.trim();
		persistProfile(current.name);
		renderInspector();
	}
	if (["profile-label", "profile-description"].includes(target.dataset.action)) {
		const name = target.dataset.profile ?? current.name;
		const draft = draftRecord(name);
		const field = target.dataset.action === "profile-label" ? "label" : "description";
		draft.value[field] = target.value;
		draft.restored = false;
		persistProfile(name);
		renderNav();
		if (current.page === "compare") {
			document.querySelector(`[data-profile-actions="${CSS.escape(name)}"]`).innerHTML = profileListActions(name);
			const comparison = document.querySelector(".configuration-comparison");
			comparison.innerHTML = `<summary>比较方案配置（含未保存修改）</summary>${comparisonTable(state.catalog.profiles.map((profile) => ({ ...profile, value: draftRecord(profile.name).value })))}`;
		} else if (field === "label") document.querySelector("[data-profile-heading]").textContent = target.value || name;
		renderInspector();
	}
	if (current.page === "profile" && target.dataset.action === "skill-search") {
		state.skillQuery = target.value;
		renderProfile(current.name);
		const input = document.querySelector('[data-action="skill-search"]');
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	}
	if (current.page === "skills" && target.dataset.action === "catalog-skill-search") {
		state.catalogSkillQuery = target.value;
		renderSkillsCatalog();
		const input = document.querySelector('[data-action="catalog-skill-search"]');
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	}
});

document.querySelector("#profile-create-base").addEventListener("change", (event) => configureNewProfile(event.target.value));
document.querySelector("#profile-create-form").addEventListener("submit", createProfile);
document.querySelector("#profile-delete-form").addEventListener("submit", deleteProfile);
document.querySelector("#profile-delete-confirm").addEventListener("input", (event) => {
	document.querySelector("#profile-delete-submit").disabled = !state.deletingProfile || event.target.value !== state.deletingProfile.name;
});
for (const dialog of [createProfileDialog, deleteProfileDialog]) dialog.addEventListener("cancel", (event) => {
	if (state.busy) event.preventDefault();
});

instructionEditor.addEventListener("cancel", (event) => {
	if (state.busy || (instructionText.value !== state.markdownDraft?.original && !confirm("放弃未保存的指令内容修改？"))) event.preventDefault();
});

confirmDialog.addEventListener("close", () => {
	if (confirmDialog.returnValue === "confirm" && state.pendingSave) state.pendingSave();
	state.pendingSave = null;
});

document.querySelector(".skip-link").addEventListener("click", (event) => {
	event.preventDefault();
	main.focus({ preventScroll: true });
	main.scrollIntoView({ block: "start", behavior: "auto" });
});

function focusSection(section) {
	const element = document.getElementById(`section-${section}`);
	if (!element) return;
	element.scrollIntoView({ block: "start", behavior: "auto" });
	element.focus({ preventScroll: true });
}

window.addEventListener("hashchange", () => {
	state.detail = null;
	render();
	main.focus({ preventScroll: true });
	window.scrollTo({ top: 0, behavior: "auto" });
	if (state.pendingSection) focusSection(state.pendingSection);
	state.pendingSection = null;
});

window.addEventListener("beforeunload", (event) => {
	if (state.catalog && (dirtyProfiles().length || isGlobalDirty())) event.preventDefault();
});

syncDialog.addEventListener("close", () => {
	if (!state.busy) (document.querySelector('[data-route="sync"]') ?? main).focus({ preventScroll: true });
});
syncDialog.addEventListener("cancel", () => {
	if (state.pendingSync) sessionStorage.setItem(`harness-sync-dismissed:${state.catalog.repo}`, state.pendingSync.commit);
	state.pendingSync = null;
});
setInterval(() => checkCatalogSync(), 15 * 60_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkCatalogSync(); });

reloadCatalog().then(async () => { await loadCatalogSync(); await checkCatalogSync(); }).catch((error) => {
	connectionState.className = "status-pill error";
	connectionState.innerHTML = '<span class="status-dot" aria-hidden="true"></span>连接失败';
	main.innerHTML = `<div class="error-summary" role="alert" tabindex="-1"><strong>无法读取配置。</strong><br>${escapeHtml(error.message)}<br>确认本地 Harness Web 服务仍在运行，然后刷新页面。</div>`;
	main.querySelector("[role=alert]").focus();
});
